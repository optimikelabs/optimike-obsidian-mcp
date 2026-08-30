#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const sentinel = "P0-CONFIG-PRIVATE-MARKER-4f71";
const baseEnv = {
  ...process.env,
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: process.cwd(),
  OBSIDIAN_CACHE_SOURCE: "filesystem",
  OBSIDIAN_ENABLE_CACHE: "false",
  MCP_WRITE_MODE: "readonly",
  SEMANTIC_SEARCH_PREWARM: "false",
  MCP_TRUST_PROXY: "false",
  MCP_TRUSTED_PROXIES: "",
};

function importWithEnvironment(modulePath, overrides, expectedMessage) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(modulePath)})`,
    ],
    {
      cwd: process.cwd(),
      env: { ...baseEnv, ...overrides },
      encoding: "utf8",
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, `${modulePath} must reject invalid config`);
  assert.match(output, expectedMessage);
  assert.doesNotMatch(output, new RegExp(sentinel, "u"));
}

const protectionModule = "./dist/mcp-server/transports/httpProtection.js";
for (const invalidEnvironment of [
  { MCP_TRUSTED_PROXIES: sentinel },
  { MCP_TRUST_PROXY: sentinel },
  { MCP_HTTP_LOOPBACK_POLICY: sentinel },
  { MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: sentinel },
  { MCP_HTTP_IDENTITY_HASH_KEY: sentinel },
]) {
  importWithEnvironment(
    protectionModule,
    invalidEnvironment,
    /Invalid HTTP protection configuration\./u,
  );
}

importWithEnvironment(
  "./dist/mcp-server/transports/httpObservability.js",
  { MCP_OBSERVABILITY_STALE_AFTER_MS: sentinel },
  /Invalid HTTP observability configuration\./u,
);

console.log("HTTP startup configuration errors are value-free.");
