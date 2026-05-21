#!/usr/bin/env node

import { createServer } from "node:http";
import { writeSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? "20000");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function createTempVault() {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "optimike-status-vault-"));
  await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
  await writeFile(
    path.join(vaultRoot, "Status.md"),
    "---\ntype: status-smoke\n---\n\nRuntime status smoke.\n",
    "utf8",
  );
  return vaultRoot;
}

async function waitForHealth(healthUrl) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${healthUrl}?integrity=1`);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastError ?? new Error("Timed out waiting for healthz");
}

async function main() {
  const vaultRoot = await createTempVault();
  const port = await findFreePort();
  const cachePath = path.join(vaultRoot, ".obsidian", "optimike-mcp", "shared-cache.sqlite");
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: vaultRoot,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
      OBSIDIAN_ENABLE_CACHE: "true",
      MCP_WRITE_MODE: "readonly",
      MCP_TRANSPORT_TYPE: "http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_AUTH_MODE: "jwt",
      MCP_AUTH_SECRET_KEY: "smoke-status-secret-for-runtime-checks",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const healthUrl = `http://127.0.0.1:${port}/healthz`;
    const body = await waitForHealth(healthUrl);
    if (!body.ok) {
      throw new Error(`healthz ok=false: ${JSON.stringify(body)}`);
    }
    if (body.runtimeMode !== "headless-readonly") {
      throw new Error(`unexpected runtimeMode: ${body.runtimeMode}`);
    }
    if (!body.sharedCache?.dbExists) {
      throw new Error(`shared cache DB was not created: ${JSON.stringify(body.sharedCache)}`);
    }
    if (body.sharedCache?.integrity?.ok !== true) {
      throw new Error(`integrity check failed: ${JSON.stringify(body.sharedCache?.integrity)}`);
    }
    if (body.runtime?.dist?.isNewerThanProcess) {
      throw new Error("backend process is older than dist files");
    }
    writeSync(
      1,
      `${JSON.stringify(
        {
          ok: true,
          healthUrl,
          vaultRoot,
          cachePath,
          runtimeMode: body.runtimeMode,
          pid: body.pid,
          sharedCache: {
            status: body.sharedCache.status,
            dbFileCount: body.sharedCache.dbFileCount,
            integrity: body.sharedCache.integrity,
          },
          writePolicy: body.writePolicy,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]).catch(() => undefined);
    }
    await rm(vaultRoot, { recursive: true, force: true }).catch(() => undefined);
    if (child.exitCode && child.exitCode !== 0 && stderr) {
      console.error(stderr);
    }
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
