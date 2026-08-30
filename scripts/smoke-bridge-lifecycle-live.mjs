#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const BACKEND_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const EXPECTED_VAULT = path.resolve(
  "C:\\Users\\micka\\.codex\\visualizations\\2026\\07\\20\\019f801c-bc43-72f0-bf34-31552d406cbc\\operon-bridge-pilot-vault-2.5.0",
);
const EXPECTED_VAULT_NAME = "operon-bridge-pilot-vault-2.5.0";
const EXPECTED_BASE_URL = "http://127.0.0.1:27233";
const CONFIRMATION = "I_CONFIRM_PILOT_2_LOCAL_REST_RELOAD";
const EXPECTED_MCP_VERSION =
  process.env.BRIDGE_LIFECYCLE_EXPECTED_MCP_VERSION?.trim() || "3.3.0";
const BRIDGES = [
  {
    id: "optimike-operon-bridge",
    directory: "obsidian-operon-bridge",
    expectedVersion:
      process.env.BRIDGE_LIFECYCLE_EXPECTED_OPERON_BRIDGE_VERSION?.trim() ||
      "0.9.0",
    route: "/extensions/optimike-operon-bridge/v1/status",
    requireStatusOk: false,
    writeProjection(payload) {
      return {
        mode: payload?.bridge?.mode ?? null,
        mutationsEnabled: payload?.bridge?.mutationsEnabled ?? null,
      };
    },
  },
  {
    id: "obsidian-atomic-write-bridge",
    directory: "obsidian-atomic-write-bridge",
    expectedVersion:
      process.env.BRIDGE_LIFECYCLE_EXPECTED_ATOMIC_BRIDGE_VERSION?.trim() ||
      "0.5.0",
    route: "/extensions/obsidian-atomic-write-bridge/status",
    requireStatusOk: true,
    writeProjection(payload) {
      return {
        writeEnabled: payload?.backend?.writeEnabled ?? null,
        canvasWriteEnabled: payload?.backend?.canvasWriteEnabled ?? null,
      };
    },
  },
  {
    id: "obsidian-bases-bridge",
    directory: "obsidian-bases-bridge",
    expectedVersion:
      process.env.BRIDGE_LIFECYCLE_EXPECTED_BASES_BRIDGE_VERSION?.trim() ||
      "1.2.0",
    route: "/extensions/obsidian-bases-bridge/atomic/status",
    requireStatusOk: true,
    writeProjection(payload) {
      return {
        writeEnabled: payload?.backend?.writeEnabled ?? null,
        legacyConfigWritesEnabled:
          payload?.migration?.legacyConfigWritesEnabled ?? null,
      };
    },
  },
];

const sleep = (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseMcpPayload(result, label) {
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned a non-JSON MCP payload.`);
  }
}

async function run(command, args, label, timeoutMs = 120_000) {
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 16_384) stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 16_384) stderr += chunk.toString("utf8");
  });
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      child.unref();
      reject(new Error(`${label} timed out.`));
    }, timeoutMs);
  });
  let exitCode;
  try {
    exitCode = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (exitCode !== 0) {
    throw new Error(
      `${label} exited ${String(exitCode)}: ${stderr.trim().slice(0, 500)}`,
    );
  }
  return stdout.trim();
}

async function runNpm(args, label) {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args], label);
  }
  return run("npm", args, label);
}

async function runGit(args, label) {
  return run("git", args, label, 30_000);
}

async function runObsidianEval(code, label) {
  const command =
    process.env.BRIDGE_LIFECYCLE_OBSIDIAN_CLI?.trim() || "obsidian";
  return run(
    command,
    ["eval", `vault=${EXPECTED_VAULT_NAME}`, `code=${code}`],
    label,
    45_000,
  );
}

async function requestJson(baseUrl, apiKey, route, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`${route} returned HTTP ${response.status}.`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRoutes(baseUrl, apiKey, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const entries = await Promise.all(
        BRIDGES.map(async (bridge) => [
          bridge.id,
          await requestJson(baseUrl, apiKey, bridge.route),
        ]),
      );
      return Object.fromEntries(entries);
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(
    `Bridge routes did not recover: ${lastError?.message ?? "timeout"}`,
  );
}

async function waitForHealthyBaseline(baseUrl, apiKey, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let routes;
  while (Date.now() < deadline) {
    routes = await waitForRoutes(baseUrl, apiKey, 5_000);
    if (routes["optimike-operon-bridge"]?.ok === true) return routes;
    await sleep(500);
  }
  throw new Error("Operon did not reach a healthy pre-reload baseline.");
}

async function waitForLocalRestClosed(baseUrl, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) return;
    }
    await sleep(250);
  }
  throw new Error("Local REST API remained reachable after disablePlugin().");
}

function assertLifecycle(payload, bridge, previous = null) {
  if (bridge.requireStatusOk) {
    assert.equal(payload?.ok, true, `${bridge.id} status is not healthy.`);
  }
  assert.equal(
    payload?.plugin?.version ?? payload?.bridge?.version,
    bridge.expectedVersion,
    `${bridge.id} version mismatch.`,
  );
  assert.equal(payload?.lifecycle?.state, "ready");
  assert.equal(payload?.lifecycle?.running, true);
  assert.equal(Number.isSafeInteger(payload?.lifecycle?.mountGeneration), true);
  assert.equal(
    Number.isSafeInteger(payload?.lifecycle?.unloadGeneration),
    true,
  );
  if (previous) {
    assert.ok(
      payload.lifecycle.mountGeneration > previous.lifecycle.mountGeneration,
      `${bridge.id} did not mount a new Local REST provider generation.`,
    );
    assert.ok(
      payload.lifecycle.unloadGeneration > previous.lifecycle.unloadGeneration,
      `${bridge.id} did not clean up the previous provider generation.`,
    );
    assert.deepEqual(
      bridge.writeProjection(payload),
      bridge.writeProjection(previous),
      `${bridge.id} changed its write authorization during reload.`,
    );
  }
}

async function attestCandidate() {
  await runNpm(["run", "build"], "MCP build");
  await runNpm(["run", "build:bridges"], "Bridge builds");
  const packageJson = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );
  assert.equal(packageJson.version, EXPECTED_MCP_VERSION);
  const gitHead = await runGit(["rev-parse", "HEAD"], "git rev-parse");
  assert.match(gitHead, /^[a-f0-9]{40}$/u);
  assert.equal(
    await runGit(["status", "--porcelain=v1"], "git status"),
    "",
    "The lifecycle canary requires a clean exact-SHA worktree.",
  );

  const hashes = {};
  for (const bridge of BRIDGES) {
    const sourceRoot = path.join(PROJECT_ROOT, "plugins", bridge.directory);
    const installedRoot = path.join(
      EXPECTED_VAULT,
      ".obsidian",
      "plugins",
      bridge.id,
    );
    const sourceManifest = JSON.parse(
      await readFile(path.join(sourceRoot, "build", "manifest.json"), "utf8"),
    );
    const installedManifest = JSON.parse(
      await readFile(path.join(installedRoot, "manifest.json"), "utf8"),
    );
    assert.equal(sourceManifest.id, bridge.id);
    assert.equal(sourceManifest.version, bridge.expectedVersion);
    assert.deepEqual(installedManifest, sourceManifest);
    const sourceBuild = await readFile(
      path.join(sourceRoot, "build", "main.js"),
    );
    const installedBuild = await readFile(path.join(installedRoot, "main.js"));
    assert.equal(sha256(installedBuild), sha256(sourceBuild));
    hashes[bridge.id] = sha256(sourceBuild);
  }
  return {
    gitHead,
    mcpVersion: packageJson.version,
    bridgeBuildSha256: hashes,
  };
}

async function main() {
  assert.equal(
    process.env.BRIDGE_LIFECYCLE_CANARY_CONFIRM,
    CONFIRMATION,
    `Set BRIDGE_LIFECYCLE_CANARY_CONFIRM=${CONFIRMATION}.`,
  );
  const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
  const baseUrl = (process.env.OBSIDIAN_BASE_URL ?? "").replace(/\/$/u, "");
  const vault = path.resolve(process.env.OBSIDIAN_VAULT ?? "");
  assert.ok(apiKey, "OBSIDIAN_API_KEY is required and is never logged.");
  assert.equal(baseUrl, EXPECTED_BASE_URL);
  assert.equal(vault.toLowerCase(), EXPECTED_VAULT.toLowerCase());

  const evidence = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    candidate: null,
    sameMcpClient: false,
    localRestRestored: false,
    bridges: {},
    ok: false,
  };
  let transport;
  let client;
  let localRestDisabled = false;
  let success = false;
  const evidencePath = path.join(
    os.tmpdir(),
    `optimike-bridge-lifecycle-${Date.now()}.json`,
  );

  try {
    evidence.candidate = await attestCandidate();
    const before = await waitForHealthyBaseline(baseUrl, apiKey);
    for (const bridge of BRIDGES) assertLifecycle(before[bridge.id], bridge);
    assert.equal(
      before["optimike-operon-bridge"]?.ok,
      true,
      "Operon must be healthy before the reload canary starts.",
    );

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BACKEND_ENTRY],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        MCP_TRANSPORT_TYPE: "stdio",
        MCP_TOOL_PROFILE: "tasks",
        MCP_WRITE_MODE: "readonly",
        OPERON_MUTATIONS_ENABLED: "false",
        OBSIDIAN_RUNTIME_MODE: "live",
        OBSIDIAN_STARTUP_BLOCKING: "false",
        OBSIDIAN_VAULT: EXPECTED_VAULT,
        OBSIDIAN_BASE_URL: baseUrl,
        OBSIDIAN_API_KEY: apiKey,
        SEMANTIC_SEARCH_PREWARM: "false",
        MCP_LOG_LEVEL: "error",
      },
      stderr: "pipe",
    });
    client = new Client(
      { name: "bridge-lifecycle-live-canary", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const toolsBefore = await client.listTools();
    assert.equal(
      toolsBefore.tools.some((tool) => tool.name === "operon_status"),
      true,
    );

    await runObsidianEval(
      "(async()=>{await app.plugins.disablePlugin('obsidian-local-rest-api');return 'disabled';})()",
      "disable Local REST API",
    );
    localRestDisabled = true;
    await waitForLocalRestClosed(baseUrl);

    const degradedResult = await client.callTool({
      name: "operon_status",
      arguments: {},
    });
    const degraded = parseMcpPayload(degradedResult, "degraded operon_status");
    assert.notEqual(
      degraded?.live?.index?.ready,
      true,
      "Operon unexpectedly remained live while Local REST was disabled.",
    );
    const toolsDuring = await client.listTools();
    assert.equal(toolsDuring.tools.length, toolsBefore.tools.length);
    evidence.sameMcpClient = true;

    await runObsidianEval(
      "(async()=>{await app.plugins.enablePlugin('obsidian-local-rest-api');return 'enabled';})()",
      "enable Local REST API",
    );
    localRestDisabled = false;
    const after = await waitForRoutes(baseUrl, apiKey);
    for (const bridge of BRIDGES) {
      assertLifecycle(after[bridge.id], bridge, before[bridge.id]);
      evidence.bridges[bridge.id] = {
        version: bridge.expectedVersion,
        before: before[bridge.id].lifecycle,
        after: after[bridge.id].lifecycle,
        writeProjection: bridge.writeProjection(after[bridge.id]),
      };
    }

    const deadline = Date.now() + 60_000;
    let live;
    while (Date.now() < deadline) {
      const result = await client.callTool({
        name: "operon_status",
        arguments: {},
      });
      live = parseMcpPayload(result, "recovered operon_status");
      if (
        live?.source === "operon-live" &&
        live?.live?.lifecycle?.state === "ready" &&
        live?.live?.index?.ready === true
      ) {
        break;
      }
      await sleep(1_000);
    }
    assert.equal(live?.source, "operon-live");
    assert.equal(live?.live?.lifecycle?.state, "ready");
    assert.equal(live?.live?.index?.ready, true);
    evidence.localRestRestored = true;
    success = true;
  } finally {
    if (localRestDisabled) {
      await runObsidianEval(
        "(async()=>{await app.plugins.enablePlugin('obsidian-local-rest-api');return 'enabled';})()",
        "restore Local REST API",
      ).catch(() => undefined);
    }
    await client?.close().catch(() => undefined);
    evidence.ok = success && evidence.localRestRestored;
    evidence.completedAt = new Date().toISOString();
    await writeFile(
      evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    console.log(`Evidence: ${evidencePath}`);
  }
  console.log(
    "PASS: all three Bridges remounted after Local REST reload on one MCP client.",
  );
}

main().catch((error) => {
  console.error(
    `FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
