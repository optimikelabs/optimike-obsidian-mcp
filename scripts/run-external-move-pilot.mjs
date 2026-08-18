#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const required = [
  "PILOT_VAULT",
  "PILOT_ROOTS_FILE",
  "PILOT_ROOT_ID",
  "PILOT_SOURCE",
  "PILOT_TARGET",
  "PILOT_NOTE",
  "PILOT_JOURNAL",
  "PILOT_PROFILE_ID",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required ${name}.`);
}
const runtimeMode = process.env.PILOT_RUNTIME_MODE ?? "headless-filesystem";
if (runtimeMode !== "headless-filesystem") {
  throw new Error(
    "The external-move pilot requires headless-filesystem on a copied or dedicated vault.",
  );
}

function jsonOf(result) {
  const text =
    result.content?.map((item) => item.text ?? "").join("\n") ?? "{}";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHealth(url, child, processText) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `HTTP backend exited with code ${child.exitCode}: ${processText()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const vault = path.resolve(process.env.PILOT_VAULT);
const rootsFile = path.resolve(process.env.PILOT_ROOTS_FILE);
const notePath = process.env.PILOT_NOTE.replaceAll("\\", "/");
const rootConfig = JSON.parse(await readFile(rootsFile, "utf8"));
const root = rootConfig.roots.find(
  (candidate) => candidate.id === process.env.PILOT_ROOT_ID,
);
if (!root) throw new Error("Pilot rootId is absent from the roots file.");
const rootPath = path.resolve(root.path);
const sourcePath = path.join(rootPath, process.env.PILOT_SOURCE);
const targetPath = path.join(rootPath, process.env.PILOT_TARGET);
assert.equal(await exists(sourcePath), true, "Pilot source must exist.");
assert.equal(await exists(targetPath), false, "Pilot target must be absent.");

const port = await unusedPort();
const commonEnv = {
  ...process.env,
  OBSIDIAN_RUNTIME_MODE: runtimeMode,
  OBSIDIAN_VAULT: vault,
  OBSIDIAN_API_KEY: "",
  OBSIDIAN_CACHE_SOURCE: "filesystem",
  OBSIDIAN_ENABLE_CACHE: "true",
  OBSIDIAN_SHARED_CACHE_DB_PATH:
    process.env.PILOT_CACHE ??
    `${path.resolve(process.env.PILOT_JOURNAL)}.cache.sqlite`,
  OBSIDIAN_STARTUP_BLOCKING: "false",
  MCP_WRITE_MODE: "full",
  MCP_TOOL_PROFILE: "full",
  MCP_EXTERNAL_MOVE_ENABLED: "true",
  MCP_EXTERNAL_ROOTS_FILE: rootsFile,
  MCP_EXTERNAL_MOVE_JOURNAL_PATH: path.resolve(process.env.PILOT_JOURNAL),
  MCP_EXTERNAL_MOVE_PROFILE_ID: process.env.PILOT_PROFILE_ID,
  MCP_TRANSPORT_TYPE: "http",
  MCP_HTTP_HOST: "127.0.0.1",
  MCP_HTTP_PORT: String(port),
  MCP_LOG_LEVEL: "error",
  LOGS_DIR: path.join(process.cwd(), "logs", "pilot-runtime"),
  SEMANTIC_SEARCH_PREWARM: "false",
};
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: commonEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let backendOutput = "";
backend.stdout?.on("data", (chunk) => {
  backendOutput += String(chunk);
});
backend.stderr?.on("data", (chunk) => {
  backendOutput += String(chunk);
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio-proxy.js"],
  cwd: process.cwd(),
  env: { ...commonEnv, MCP_PROXY_START_TIMEOUT_MS: "20000" },
});
const client = new Client({
  name: "optimike-external-move-real-pilot",
  version: "1",
});

try {
  await waitForHealth(
    `http://127.0.0.1:${port}/healthz`,
    backend,
    () => backendOutput,
  );
  await client.connect(transport);
  const key = `pilot-${Date.now()}`;
  const scan = jsonOf(
    await client.callTool({
      name: "external_references_scan",
      arguments: {
        rootId: process.env.PILOT_ROOT_ID,
        relativePath: process.env.PILOT_SOURCE,
      },
    }),
  );
  const plan = jsonOf(
    await client.callTool({
      name: "external_move_plan",
      arguments: {
        rootId: process.env.PILOT_ROOT_ID,
        sourceRelativePath: process.env.PILOT_SOURCE,
        targetRelativePath: process.env.PILOT_TARGET,
        idempotencyKey: key,
      },
    }),
  );
  assert.equal(
    plan.readyToApply,
    true,
    `Pilot plan was not ready: ${JSON.stringify(plan)}`,
  );
  assert.equal(
    plan.manualReview.length,
    0,
    `Pilot plan requires manual review: ${JSON.stringify(plan.manualReview)}`,
  );
  assert.ok(
    plan.repairs.some(
      (repair) => repair.filePath.replace(/^\/+/u, "") === notePath,
    ),
  );

  const applied = jsonOf(
    await client.callTool({
      name: "external_move_apply",
      arguments: { planId: plan.planId, idempotencyKey: key },
    }),
  );
  assert.equal(applied.status, "applied");
  assert.equal(await exists(sourcePath), false);
  assert.equal(await exists(targetPath), true);

  const rolledBack = jsonOf(
    await client.callTool({
      name: "external_move_rollback",
      arguments: { planId: plan.planId, idempotencyKey: key },
    }),
  );
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(await exists(sourcePath), true);
  assert.equal(await exists(targetPath), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        planId: plan.planId,
        sourceSha256: plan.sourceSha256,
        inventoryDigest: plan.inventoryDigest,
        bindingFingerprint: plan.bindingFingerprint,
        scanReparable: scan.reparable?.length ?? 0,
        repairedNotes: plan.repairs.length,
        finalStatus: rolledBack.status,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
  backend.kill();
}
