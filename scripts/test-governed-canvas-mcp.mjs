#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CANVAS_FIXTURE_PATH,
  GovernedCanvasAtomicServer,
} from "./fixtures/governed-canvas-atomic-server.mjs";

const fixture = new GovernedCanvasAtomicServer();
await fixture.listen();
const testParent = path.join(process.cwd(), ".tmp");
mkdirSync(testParent, { recursive: true });
const root = mkdtempSync(path.join(testParent, "optimike-canvas-mcp-"));
const logs = path.join(root, "logs");
mkdirSync(logs);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_TOOL_PROFILE: "authoring",
    MCP_LOG_LEVEL: "error",
    LOGS_DIR: logs,
    MCP_WRITE_MODE: "full",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(root, "notes.sqlite"),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(root, "bases.sqlite"),
    MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: path.join(root, "canvas.sqlite"),
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: "fixture-key",
    OBSIDIAN_BASE_URL: fixture.baseUrl,
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    OPERON_MUTATIONS_ENABLED: "false",
  },
  stderr: "pipe",
});
let childStderr = "";
transport.stderr?.on("data", (chunk) => {
  childStderr += chunk.toString("utf8");
});
const client = new Client(
  { name: "governed-canvas-p3", version: "1.0.0" },
  { capabilities: {} },
);

function parsed(result) {
  return JSON.parse(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  );
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("obsidian_canvas_patch_"))
      .sort(),
    [
      "obsidian_canvas_patch_apply",
      "obsidian_canvas_patch_plan",
      "obsidian_canvas_patch_recover",
      "obsidian_canvas_patch_status",
    ],
  );
  const paddedPathResult = await client.callTool({
    name: "obsidian_canvas_patch_plan",
    arguments: {
      path: ` ${CANVAS_FIXTURE_PATH} `,
      operations: [{ op: "set_text", id: "a", text: "Never planned" }],
      idempotencyKey: "p3-mcp-padded-path",
    },
  });
  assert.equal(paddedPathResult.isError, true);
  assert.match(JSON.stringify(paddedPathResult.content), /must not be padded/u);
  assert.equal(fixture.writes, 0);

  const plannedResult = await client.callTool({
    name: "obsidian_canvas_patch_plan",
    arguments: {
      path: CANVAS_FIXTURE_PATH,
      operations: [
        { op: "set_text", id: "a", text: "After" },
        {
          op: "add_text_node",
          id: "b",
          text: "Second",
          x: 300,
          y: 0,
          width: 240,
          height: 120,
        },
        { op: "connect_nodes", id: "ab", fromNode: "a", toNode: "b" },
      ],
      idempotencyKey: "p3-mcp-1",
    },
  });
  assert.equal(plannedResult.isError, false);
  const planned = parsed(plannedResult);
  assert.equal(planned.phase, "planned");
  assert.equal(fixture.writes, 0);

  const appliedResult = await client.callTool({
    name: "obsidian_canvas_patch_apply",
    arguments: { planRef: planned.planRef, idempotencyKey: "p3-mcp-1" },
  });
  assert.equal(appliedResult.isError, false);
  assert.equal(parsed(appliedResult).outcome, "committed");
  assert.equal(fixture.writes, 1);
  const graph = JSON.parse(fixture.content);
  assert.equal(graph.nodes.find((node) => node.id === "a").text, "After");
  assert.equal(
    graph.nodes.find((node) => node.id === "a").unknownNodeField.keep,
    true,
  );
  assert.equal(graph.unknownRootField, "keep");

  const status = parsed(
    await client.callTool({
      name: "obsidian_canvas_patch_status",
      arguments: { planRef: planned.planRef },
    }),
  );
  assert.equal(status.outcome, "committed");
  assert.equal(status.idempotencyKey, undefined);
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nMCP stderr:\n${childStderr}`,
  );
} finally {
  await client.close().catch(() => undefined);
  await fixture.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "PASS: governed Canvas tools traverse the live stdio MCP surface and atomic Canvas backend",
);
