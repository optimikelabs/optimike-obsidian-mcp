#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const fixturePath = "Canary/PROJETS-P2.base";
const bindingFingerprint = sha256("governed-base-mcp-fixture");
let yaml =
  "formulas:\n  score: old\nviews:\n  - type: table\n    name: Préservée\n";
let writes = 0;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      json(res, 200, {
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "fixture", self: "5.0.2" },
      });
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/status"
    ) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        plugin: { id: "obsidian-bases-bridge", version: "1.1.0" },
        backend: {
          kind: "obsidian-vault-process-base",
          bindingFingerprint,
          atomicCas: true,
          writeEnabled: true,
        },
        limits: { baseOnly: true, sourcePreservingCompilerRequired: true },
        migration: { legacyConfigWritesEnabled: false },
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/bases/read"
    ) {
      const request = await body(req);
      if (request.path !== fixturePath)
        return json(res, 404, { error: { code: "base_not_found" } });
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: fixturePath,
        yaml,
        sha256: sha256(yaml),
        size: Buffer.byteLength(yaml),
        bindingFingerprint,
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/bases/cas"
    ) {
      const request = await body(req);
      const actual = sha256(yaml);
      if (
        request.bindingFingerprint !== bindingFingerprint ||
        request.expectedSha256 !== actual
      ) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "hash_conflict",
            message: "Base changed",
            details: { actualSha256: actual },
          },
        });
        return;
      }
      yaml = request.nextYaml;
      writes += 1;
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: fixturePath,
        beforeSha256: actual,
        afterSha256: sha256(yaml),
        size: Buffer.byteLength(yaml),
        bindingFingerprint,
      });
      return;
    }
    json(res, 404, { error: "fixture route not found" });
  })().catch((error) => json(res, 500, { error: String(error) }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const testParent = path.join(process.cwd(), ".tmp");
mkdirSync(testParent, { recursive: true });
const root = mkdtempSync(path.join(testParent, "optimike-base-mcp-"));
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
  },
  stderr: "pipe",
});
let childStderr = "";
transport.stderr?.on("data", (chunk) => {
  childStderr += chunk.toString("utf8");
});
const client = new Client(
  { name: "governed-base-p2", version: "1.0.0" },
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
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("bases_formula_patch_"))
      .sort(),
    [
      "bases_formula_patch_apply",
      "bases_formula_patch_plan",
      "bases_formula_patch_recover",
      "bases_formula_patch_status",
    ],
  );
  assert.equal(
    tools.tools.some(
      (tool) => tool.name === "obsidian_list_pending_operations",
    ),
    true,
  );
  const plannedResult = await client.callTool({
    name: "bases_formula_patch_plan",
    arguments: {
      path: fixturePath,
      operations: [{ op: "set_formula", name: "score", expression: "new" }],
      idempotencyKey: "p2-mcp-1",
    },
  });
  assert.equal(plannedResult.isError, false);
  const planned = parsed(plannedResult);
  assert.equal(planned.phase, "planned");
  assert.equal(writes, 0);
  const pending = parsed(
    await client.callTool({
      name: "obsidian_list_pending_operations",
      arguments: { limit: 100 },
    }),
  );
  const pendingBase = pending.operations.find(
    (item) => item.planRef === planned.planRef,
  );
  assert.deepEqual(
    pendingBase && {
      operationKind: pendingBase.operationKind,
      state: pendingBase.state,
      nextAction: pendingBase.nextAction,
    },
    {
      operationKind: "obsidian.base.formula.patch",
      state: "planned",
      nextAction: "apply",
    },
  );
  const appliedResult = await client.callTool({
    name: "bases_formula_patch_apply",
    arguments: { planRef: planned.planRef, idempotencyKey: "p2-mcp-1" },
  });
  assert.equal(appliedResult.isError, false);
  assert.equal(parsed(appliedResult).outcome, "committed");
  assert.equal(writes, 1);
  assert.match(yaml, /score: "new"/u);
  assert.match(yaml, /name: Préservée/u);
  const status = parsed(
    await client.callTool({
      name: "bases_formula_patch_status",
      arguments: { planRef: planned.planRef },
    }),
  );
  assert.equal(status.outcome, "committed");
  assert.equal(status.idempotencyKey, undefined);
  assert.equal(
    parsed(
      await client.callTool({
        name: "obsidian_list_pending_operations",
        arguments: { limit: 100 },
      }),
    ).operations.some((item) => item.planRef === planned.planRef),
    false,
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nMCP stderr:\n${childStderr}`,
  );
} finally {
  await client.close().catch(() => undefined);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "PASS: governed Base formula tools traverse the live stdio MCP surface and atomic Base backend",
);
