#!/usr/bin/env node

import { createServer } from "node:http";
import { writeSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";

const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? "60000");

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
  const vaultRoot = await mkdtemp(
    path.join(os.tmpdir(), "optimike-status-vault-"),
  );
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
      const response = await fetch(healthUrl);
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

function jsonOf(result) {
  return JSON.parse(
    result.content?.map((item) => item.text ?? "").join("\n") ?? "{}",
  );
}

async function main() {
  const vaultRoot = await createTempVault();
  const port = await findFreePort();
  const cachePath = path.join(
    vaultRoot,
    ".obsidian",
    "optimike-mcp",
    "shared-cache.sqlite",
  );
  const authSecret = "smoke-status-secret-for-runtime-checks";
  const privateBaseUrl =
    "https://p0-runtime-base.private.example.test/obsidian";
  const privateOpenAiBaseUrl =
    "https://p0-runtime-openai.private.example.test/embeddings";
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: vaultRoot,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
      OBSIDIAN_ENABLE_CACHE: "true",
      OBSIDIAN_BASE_URL: privateBaseUrl,
      OPENAI_BASE_URL: privateOpenAiBaseUrl,
      MCP_WRITE_MODE: "readonly",
      MCP_TRANSPORT_TYPE: "http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_AUTH_MODE: "jwt",
      MCP_AUTH_SECRET_KEY: authSecret,
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  let client;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const healthUrl = `http://127.0.0.1:${port}/healthz`;
    const body = await waitForHealth(healthUrl);
    if (!body.ok) {
      throw new Error(`healthz ok=false: ${JSON.stringify(body)}`);
    }
    if (
      JSON.stringify(body).includes(vaultRoot) ||
      JSON.stringify(body).includes(cachePath) ||
      "runtime" in body ||
      "sharedCache" in body
    ) {
      throw new Error(
        `public healthz disclosed runtime state: ${JSON.stringify(body)}`,
      );
    }

    const token = await new SignJWT({
      cid: "runtime-status-smoke",
      scp: ["runtime:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("runtime-status-smoke")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(authSecret));
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client({
      name: "optimike-runtime-status-smoke",
      version: "0",
    });
    await client.connect(transport);
    const runtimeStatus = jsonOf(
      await client.callTool({
        name: "obsidian_runtime_status",
        arguments: {},
      }),
    );
    if (runtimeStatus.runtimeMode !== "headless-readonly") {
      throw new Error(`unexpected runtimeMode: ${runtimeStatus.runtimeMode}`);
    }
    if (!runtimeStatus.sharedCache?.dbExists) {
      throw new Error(
        `shared cache DB was not created: ${JSON.stringify(runtimeStatus.sharedCache)}`,
      );
    }
    if (runtimeStatus.runtime?.dist?.isNewerThanProcess) {
      throw new Error("backend process is older than dist files");
    }
    if (runtimeStatus.capabilityManifest?.contractVersion !== 1) {
      throw new Error("runtime status lost capability manifest contract v1");
    }
    if (
      runtimeStatus.capabilityManifest.profile !== "standard" ||
      runtimeStatus.capabilityManifest.registrationMode !== "headless-readonly"
    ) {
      throw new Error(
        `unexpected capability doctor binding: ${JSON.stringify(runtimeStatus.capabilityManifest)}`,
      );
    }
    const governedNote = runtimeStatus.capabilityManifest.capabilities.find(
      (capability) => capability.id === "governed-note-write",
    );
    if (governedNote?.reasonCode !== "runtime_mode_unavailable") {
      throw new Error(
        `headless doctor misclassified governed note writes: ${JSON.stringify(governedNote)}`,
      );
    }
    const serializedRuntimeStatus = JSON.stringify(runtimeStatus);
    for (const privateValue of [
      vaultRoot,
      cachePath,
      privateBaseUrl,
      privateOpenAiBaseUrl,
      process.cwd(),
    ]) {
      if (serializedRuntimeStatus.includes(privateValue)) {
        throw new Error(
          `runtime status disclosed private runtime detail: ${privateValue}`,
        );
      }
    }
    writeSync(
      1,
      `${JSON.stringify(
        {
          ok: true,
          healthUrl,
          vaultRoot,
          cachePath,
          publicHealth: body,
          runtimeMode: runtimeStatus.runtimeMode,
          pid: runtimeStatus.pid,
          sharedCache: {
            status: runtimeStatus.sharedCache.status,
            dbFileCount: runtimeStatus.sharedCache.dbFileCount,
          },
          writePolicy: runtimeStatus.writePolicy,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client?.close().catch(() => undefined);
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]).catch(() => undefined);
    }
    await rm(vaultRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
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
