#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const safeId = "Canary/Safe.base";
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    json(res, 200, {
      authenticated: true,
      ok: "OK",
      service: "Obsidian Local REST API",
      versions: { obsidian: "fixture", self: "5.1.0" },
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/bases") {
    json(res, 200, {
      ok: false,
      id: safeId,
      warnings: ["The Base specification must be an object."],
      created: false,
      overwritten: false,
    });
    return;
  }
  if (
    req.method === "PUT" &&
    url.pathname === `/bases/${encodeURIComponent(safeId)}/config`
  ) {
    json(res, 200, {
      ok: false,
      id: safeId,
      warnings: ["A YAML or JSON payload is required."],
    });
    return;
  }
  json(res, 404, { error: { code: "fixture_route_not_found" } });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");

const tempRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-bases-legacy-failure-"),
);
const logsParent = path.join(process.cwd(), "logs");
mkdirSync(logsParent, { recursive: true });
const logs = mkdtempSync(path.join(logsParent, "bases-legacy-failure-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_TOOL_PROFILE: "full",
    MCP_WRITE_MODE: "full",
    MCP_LOG_LEVEL: "error",
    LOGS_DIR: logs,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: "fixture-key",
    OBSIDIAN_BASE_URL: `http://127.0.0.1:${address.port}`,
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    OPERON_MUTATIONS_ENABLED: "false",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(tempRoot, "notes.sqlite"),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(tempRoot, "bases.sqlite"),
    MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: path.join(tempRoot, "canvas.sqlite"),
    MCP_OBSIDIAN_FRONTMATTER_JOURNAL_PATH: path.join(
      tempRoot,
      "frontmatter.sqlite",
    ),
  },
  stderr: "pipe",
});
let childStderr = "";
transport.stderr?.on("data", (chunk) => {
  childStderr += chunk.toString("utf8");
});
const client = new Client(
  { name: "bases-legacy-failure-contract", version: "1.0.0" },
  { capabilities: {} },
);

function parsed(result) {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const created = await client.callTool({
    name: "bases_create",
    arguments: {
      path: safeId,
      spec: { views: [] },
      overwrite: false,
      validateOnly: false,
    },
  });
  assert.equal(created.isError, false);
  assert.deepEqual(parsed(created), {
    ok: false,
    id: safeId,
    warnings: ["The Base specification must be an object."],
    created: false,
    overwritten: false,
  });

  const configured = await client.callTool({
    name: "bases_upsert_config",
    arguments: {
      base_id: safeId,
      yaml: "views: []\n",
      validateOnly: false,
    },
  });
  assert.equal(configured.isError, false);
  assert.deepEqual(parsed(configured), {
    ok: false,
    id: safeId,
    warnings: ["A YAML or JSON payload is required."],
  });
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nMCP stderr:\n${childStderr}`,
  );
} finally {
  await client.close().catch(() => undefined);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(logs, { recursive: true, force: true });
}

console.log(
  "PASS: legacy Base create/config 2xx failures preserve their REST-to-MCP contracts.",
);
