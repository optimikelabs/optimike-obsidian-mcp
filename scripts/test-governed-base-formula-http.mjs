#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BASE_FIXTURE_PATH,
  GovernedBaseAtomicServer,
} from "./fixtures/governed-base-atomic-server.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`HTTP MCP exited: ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for HTTP MCP health.");
}

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
  assert.equal(payload.error.message, "This request is not authorized.", `${label} catalog message`);
  const requestId = payload.requestId ?? payload.error.details?.requestId;
  assert.match(requestId ?? "", UUID, `${label} request id`);
  assert.equal(payload.error.details?.requestId, requestId, `${label} request id details`);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(forbiddenMarker, "u"), `${label} leaked marker`);
}

const parent = path.join(process.cwd(), ".tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "governed-base-http-"));
const logs = path.join(root, "logs");
mkdirSync(logs);
const fake = new GovernedBaseAtomicServer();
await fake.listen();
const port = await unusedPort();
let stdout = "";
let stderr = "";
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "http",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_LOG_LEVEL: "error",
    MCP_WRITE_MODE: "full",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(root, "notes.sqlite"),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(root, "bases.sqlite"),
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
  },
  stdio: ["ignore", "pipe", "pipe"],
});
backend.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
backend.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});
let first;
let second;
try {
  await waitForHealth(`http://127.0.0.1:${port}/healthz`, backend);
  const mcp = `http://127.0.0.1:${port}/mcp/authoring`;
  first = await session(mcp, "base-http-plan");
  second = await session(mcp, "base-http-apply");
  const plannedResult = await first.callTool({
    name: "bases_formula_patch_plan",
    arguments: {
      path: BASE_FIXTURE_PATH,
      operations: [{ op: "set_formula", name: "score", expression: "http" }],
      idempotencyKey: "p2-http-1",
    },
  });
  assert.equal(plannedResult.isError, false);
  const planned = parsed(plannedResult);
  assert.equal(fake.writes, 0);
  const applied = parsed(
    await second.callTool({
      name: "bases_formula_patch_apply",
      arguments: { planRef: planned.planRef, idempotencyKey: "p2-http-1" },
    }),
  );
  assert.equal(applied.outcome, "committed");
  assert.equal(fake.writes, 1);
  const status = parsed(
    await first.callTool({
      name: "bases_formula_patch_status",
      arguments: { planRef: planned.planRef },
    }),
  );
  assert.equal(status.outcome, "committed");
  assert.equal(status.planDigest, applied.planDigest);
  fake.legacyConfigWritesEnabled = true;
  const blocked = await first.callTool({
    name: "bases_formula_patch_plan",
    arguments: {
      path: BASE_FIXTURE_PATH,
      operations: [{ op: "set_formula", name: "score", expression: "blocked" }],
      idempotencyKey: "p2-http-legacy-block",
    },
  });
  assert.equal(blocked.isError, true);
  assertPublicError(parsed(blocked), "FORBIDDEN", "legacy_base_config_writes_enabled", "legacy write policy");
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
} finally {
  await first?.close().catch(() => undefined);
  await second?.close().catch(() => undefined);
  backend.kill("SIGTERM");
  await new Promise((resolve) => backend.once("exit", resolve));
  await fake.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "PASS: governed Base formula plan and apply share one durable authority across HTTP sessions",
);
