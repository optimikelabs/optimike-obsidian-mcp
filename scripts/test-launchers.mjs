#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureLocalBackendRunning } from "../dist/runtime/localBackend.js";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `HTTP launcher exited with ${child.exitCode}\n${output.join("")}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}\n${output.join("")}`);
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), "optimike-launcher-"));
const vaultPath = path.join(sandbox, "vault");
const cachePath = path.join(sandbox, "shared-cache.sqlite");
const port = await unusedPort();
await mkdir(vaultPath, { recursive: true });

const absentBackendPort = await unusedPort();
await assert.rejects(
  ensureLocalBackendRunning({
    serviceName: "optimike-launcher-no-spawn-test",
    url: new URL(`http://127.0.0.1:${absentBackendPort}/healthz`),
    command: process.execPath,
    args: ["-e", "process.exit(97)"],
    cwd: process.cwd(),
    env: process.env,
    startupTimeoutMs: 2_000,
    healthcheckTimeoutMs: 250,
    spawnIfUnavailable: false,
  }),
  /automatic startup is disabled/u,
  "require-existing mode must fail closed without spawning a detached backend",
);

const output = [];
const child = spawn(process.execPath, ["scripts/run-http.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OBSIDIAN_RUNTIME_MODE: "headless-readonly",
    OBSIDIAN_VAULT: vaultPath,
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
    OBSIDIAN_ENABLE_CACHE: "false",
    SEMANTIC_SEARCH_PREWARM: "false",
    MCP_WRITE_MODE: "readonly",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_LOG_LEVEL: "error",
    DANGEROUSLY_OMIT_AUTH: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

try {
  await waitForHealth(`http://127.0.0.1:${port}/healthz`, child, output);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(sandbox, { recursive: true, force: true });
}

console.log("PASS: cross-platform HTTP launcher reached /healthz");
