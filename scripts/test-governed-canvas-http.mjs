#!/usr/bin/env node

import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { startHttpTestBackend } from "./test-support/http-backend.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CANVAS_FIXTURE_PATH,
  GovernedCanvasAtomicServer,
} from "./fixtures/governed-canvas-atomic-server.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function session(url, name) {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function parsed(result) {
  return JSON.parse(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  );
}

function assertPublicError(payload, code, forbiddenMarker, label) {
  assert.equal(payload.error.code, code, `${label} error code`);
  assert.equal(payload.error.message, "The request could not be completed. Use the request id to inspect server diagnostics.", `${label} catalog message`);
  const requestId = payload.requestId ?? payload.error.details?.requestId;
  assert.match(requestId ?? "", UUID, `${label} request id`);
  assert.equal(payload.error.details?.requestId, requestId, `${label} request id details`);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(forbiddenMarker, "u"), `${label} leaked marker`);
}

const parent = path.join(process.cwd(), ".tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "governed-canvas-http-"));
const logs = path.join(root, "logs");
mkdirSync(logs);
const fake = new GovernedCanvasAtomicServer();
let backend;
let first;
let second;
try {
  await fake.listen();
  backend = await startHttpTestBackend({
    MCP_WRITE_MODE: "full",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(root, "notes.sqlite"),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(root, "bases.sqlite"),
    MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: path.join(root, "canvas.sqlite"),
    LOGS_DIR: logs,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_BASE_URL: fake.baseUrl,
    OBSIDIAN_API_KEY: "fixture-key",
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    OPERON_MUTATIONS_ENABLED: "false",
  });
  const mcp = `${await backend.ready()}/mcp/authoring`;
  first = await session(mcp, "canvas-http-plan");
  second = await session(mcp, "canvas-http-apply");
  const plannedResult = await first.callTool({
    name: "obsidian_canvas_patch_plan",
    arguments: {
      path: CANVAS_FIXTURE_PATH,
      operations: [{ op: "set_text", id: "a", text: "HTTP" }],
      idempotencyKey: "p3-http-1",
    },
  });
  assert.equal(plannedResult.isError, false);
  const planned = parsed(plannedResult);
  assert.equal(fake.writes, 0);
  const applied = parsed(
    await second.callTool({
      name: "obsidian_canvas_patch_apply",
      arguments: { planRef: planned.planRef, idempotencyKey: "p3-http-1" },
    }),
  );
  assert.equal(applied.outcome, "committed");
  assert.equal(fake.writes, 1);
  const status = parsed(
    await first.callTool({
      name: "obsidian_canvas_patch_status",
      arguments: { planRef: planned.planRef },
    }),
  );
  assert.equal(status.outcome, "committed");
  assert.equal(status.planDigest, applied.planDigest);

  fake.canvasWritesEnabled = false;
  const blocked = await first.callTool({
    name: "obsidian_canvas_patch_plan",
    arguments: {
      path: CANVAS_FIXTURE_PATH,
      operations: [{ op: "set_text", id: "a", text: "Blocked" }],
      idempotencyKey: "p3-http-disabled",
    },
  });
  assert.equal(blocked.isError, true);
  assertPublicError(parsed(blocked), "INTERNAL_ERROR", "Canvas file writes are disabled", "disabled canvas writes");
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\n${backend?.diagnostics() ?? ""}`,
  );
} finally {
  await first?.close().catch(() => undefined);
  await second?.close().catch(() => undefined);
  await backend?.stop();
  await fake.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "PASS: governed Canvas plan and apply share one durable authority across HTTP sessions",
);
