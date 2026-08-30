#!/usr/bin/env node

import assert from "node:assert/strict";

process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.MCP_WRITE_MODE = "full";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { processBasesUpsertRows } = await import(
  "../dist/mcp-server/tools/basesUpsertRowsTool/logic.js"
);
const { requestContextService } = await import("../dist/utils/index.js");

const requested = ["Private/A.md", "Private/B.md"];
const service = {
  async checkStatus() {
    return { authenticated: true };
  },
  async listBases() {
    return { bases: [{ id: "Test.base" }] };
  },
  async upsertBaseRows() {
    // A hostile Bridge must not be able to replace the already validated
    // vault-relative request path with an absolute/backend-derived path.
    return {
      ok: false,
      results: [
        {
          file: "C:\\private\\bridge-path.md",
          mtime: 0,
          error: { code: "not_found", message: "private bridge detail" },
        },
        {
          file: "/srv/private/bridge-path.md",
          mtime: 7,
          changed: { keys: ["safe"] },
        },
      ],
    };
  },
};

const result = await processBasesUpsertRows(
  {
    base_id: "Test.base",
    operations: requested.map((file) => ({ file, set: { safe: true } })),
    continueOnError: true,
    chunkSize: 2,
    delayMs: 0,
    maxRetries: 0,
    retryBackoffMs: 0,
    requestTimeoutMs: 10_000,
    dryRun: false,
  },
  requestContextService.createRequestContext({
    operation: "testBasesUpsertRowBinding",
  }),
  service,
);

assert.equal(result.ok, false);
assert.equal(result.results.length, requested.length);
assert.deepEqual(
  result.results.map((entry) => entry.file),
  requested,
  "MCP binds every positional bridge result to its request operation",
);
assert.equal(result.results[0].error?.code, "not_found");
assert.equal(
  result.results[0].error?.message,
  "The Bases row operation could not be completed. Inspect the stable error code before retrying.",
);
assert.equal(result.results[1].changed?.keys[0], "safe");
assert.equal(
  JSON.stringify(result).includes("C:\\private\\bridge-path.md"),
  false,
);
assert.equal(
  JSON.stringify(result).includes("/srv/private/bridge-path.md"),
  false,
);
assert.equal(JSON.stringify(result).includes("private bridge detail"), false);

console.log(
  "PASS: Bases legacy 2xx failures preserve cardinality/order while binding result paths to validated MCP request operations.",
);
