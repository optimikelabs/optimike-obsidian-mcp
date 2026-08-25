#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";

const EXPECTED_VAULT = path.resolve(
  "C:\\Users\\micka\\.codex\\visualizations\\2026\\07\\20\\019f801c-bc43-72f0-bf34-31552d406cbc\\operon-bridge-pilot-vault-2.5.0",
);
const EXPECTED_VAULT_NAME = "operon-bridge-pilot-vault-2.5.0";
const EXPECTED_OPERON_VERSION = (
  process.env.OPERON_35_CANARY_EXPECTED_OPERON_VERSION ?? "3.5.3"
).trim();
const EXPECTED_BRIDGE_VERSION = (
  process.env.OPERON_35_CANARY_EXPECTED_BRIDGE_VERSION ?? "0.8.1"
).trim();
const EXPECTED_BASE_URL = "http://127.0.0.1:27233";
const FIXTURE_PATH = "Canary/Operon-3.5-Live-Canary.md";
const PERIODIC_REGISTRY_PATH = path.join(
  EXPECTED_VAULT,
  ".obsidian",
  "plugins",
  "operon",
  "state",
  "periodic-note-containers.json",
);
const ORIGINAL_MODIFICATION = "2000-01-01T00:00:00";
const PROJECT_ROOT = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const BACKEND_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const PROJECT_LOGS_PATH = path.join(PROJECT_ROOT, "logs");
const BRIDGE_PREFIX = "/extensions/optimike-operon-bridge/v1";
const RUN_CONFIRMATION = "I_CONFIRM_PILOT_2_DISPOSABLE_LIVE_MUTATIONS";
const OPEN_CONFIRMATION = "I_CONFIRM_OPENING_ONLY_OPERON_PILOT_2";
const MUTATION_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_MUTATION_TIMEOUT_MS,
  150_000,
  125_000,
  300_000,
);
const READ_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_READ_TIMEOUT_MS,
  30_000,
  5_000,
  120_000,
);
const STARTUP_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_STARTUP_TIMEOUT_MS,
  180_000,
  15_000,
  600_000,
);
const CLI_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_CLI_TIMEOUT_MS,
  30_000,
  5_000,
  120_000,
);

function boundedInteger(raw, fallback, minimum, maximum) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Timeout must be an integer between ${minimum} and ${maximum} ms.`,
    );
  }
  return value;
}

function envTrue(name) {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value) {
  return sha256(String(value)).slice(0, 16);
}

function boundedDiagnosticToken(value) {
  if (typeof value !== "string" || !value) return null;
  return value.length <= 128 && /^[a-z0-9_.:-]+$/iu.test(value)
    ? value
    : `hashed-${shortHash(value)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalRelativeMarkdownPath(value) {
  if (
    typeof value !== "string" ||
    !value.endsWith(".md") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment === segment.trim() &&
        segment !== "." &&
        segment !== "..",
    );
}

function absoluteVaultPath(relativePath) {
  assert.equal(
    canonicalRelativeMarkdownPath(relativePath),
    true,
    `Unsafe vault-relative Markdown path: ${relativePath}`,
  );
  const absolute = path.resolve(EXPECTED_VAULT, ...relativePath.split("/"));
  const vaultPrefix = `${EXPECTED_VAULT}${path.sep}`.toLowerCase();
  assert.equal(
    absolute.toLowerCase().startsWith(vaultPrefix),
    true,
    "Resolved path escaped the Pilot 2 vault.",
  );
  return absolute;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout(promise, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function redactText(value, apiKey) {
  let text = String(value ?? "");
  if (apiKey) text = text.split(apiKey).join("[REDACTED_API_KEY]");
  text = text
    .split(EXPECTED_VAULT)
    .join(`[REDACTED_VAULT]${path.sep}`)
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]");
  return text.slice(0, 2_000);
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

function markdownFrontmatter(content, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  assert.ok(match, `${label} has no YAML frontmatter.`);
  const parsed = parseYaml(match[1]);
  assert.equal(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    true,
    `${label} frontmatter is not a YAML mapping.`,
  );
  return parsed;
}

function frontmatterScalarWhenValid(content, key) {
  try {
    const value = markdownFrontmatter(content, "canary fixture")[key];
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : null;
  } catch {
    return null;
  }
}

function mutationStatus(result, label, expected) {
  const status = result?.status;
  if (status === "outcome-unknown") {
    const recovery = result.recoveryRef
      ? ` recoveryRefHash=${shortHash(result.recoveryRef)}`
      : "";
    throw new Error(`${label} returned outcome-unknown.${recovery}`);
  }
  assert.equal(status, expected, `${label} returned status ${String(status)}.`);
  return result;
}

function assertNativeMutationProof(result, label) {
  assert.match(
    result?.planDigest ?? "",
    /^[a-f0-9]{64}$/u,
    `${label} did not return an exact sealed planDigest.`,
  );
  const proof = result?.nativeProof;
  assert.equal(proof?.contractVersion, 1, `${label} native proof is missing.`);
  assert.equal(proof?.kind, "mutation-result");
  assert.equal(proof?.mutationMayHaveApplied, true);
  assert.equal(proof?.retryAllowed, false);
  assert.equal(proof?.receipt?.planDigest, result.planDigest);
  assert.equal(
    ["verified", "receipt-replay"].includes(proof?.postflight?.status),
    true,
    `${label} native postflight is not verified.`,
  );
  assert.equal(Array.isArray(proof?.groupResults), true);
  assert.ok(proof.groupResults.length > 0, `${label} has no atomic groups.`);
  const revisions = proof.groupResults.flatMap((group) => {
    assert.equal(
      group.status,
      "committed",
      `${label} has an uncommitted group.`,
    );
    assert.equal(Array.isArray(group.resourceRevisions), true);
    return group.resourceRevisions;
  });
  assert.ok(revisions.length > 0, `${label} has no resource revisions.`);
  for (const revision of revisions) {
    assert.equal(typeof revision.resourceKind, "string");
    assert.ok(revision.resourceKey);
    assert.ok(revision.revision);
  }
  return {
    label,
    status: proof.status,
    planDigestHash: shortHash(result.planDigest),
    postflight: proof.postflight.status,
    atomicGroupCount: proof.groupResults.length,
    resourceRevisionCount: revisions.length,
    resourceRevisionHashes: revisions.map((revision) =>
      shortHash(
        `${revision.resourceKind}\0${revision.resourceKey}\0${revision.revision}`,
      ),
    ),
  };
}

function strictDate(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/u);
  return value;
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoWeekMarkers(value) {
  const date = new Date(`${strictDate(value)}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  const monday = addUtcDays(date, 1 - day);
  const thursday = addUtcDays(date, 4 - day);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return [
    isoDate(monday),
    `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
  ];
}

function routeDates(runId) {
  const digest = createHash("sha256").update(runId).digest();
  const offset = digest.readUInt16BE(0) % 5_000;
  const first = addUtcDays(new Date(Date.UTC(2080, 0, 1)), offset);
  const daily = strictDate(isoDate(first));
  return {
    daily,
    scheduled: strictDate(
      isoDate(addUtcDays(new Date(`${daily}T00:00:00Z`), 7)),
    ),
    weekly: strictDate(isoDate(addUtcDays(first, 35))),
    concurrent: strictDate(isoDate(addUtcDays(first, 77))),
  };
}

function assertCollisionFree(snapshot, markers) {
  const collisions = [];
  for (const [relativePath, value] of snapshot) {
    const content = value.content.toString("utf8");
    const matched = markers.filter(
      (marker) => content.includes(marker) || relativePath.includes(marker),
    );
    if (matched.length > 0) {
      collisions.push({
        pathHash: shortHash(relativePath),
        markerHashes: matched.map(shortHash),
      });
    }
  }
  assert.deepEqual(
    collisions,
    [],
    "Canary marker or route-date collision exists before mutation.",
  );
}

async function captureMarkdownSnapshot(backupRoot) {
  const inventory = new Map();
  async function walk(absoluteFolder, relativeFolder) {
    const entries = await readdir(absoluteFolder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".obsidian") continue;
      const absolute = path.join(absoluteFolder, entry.name);
      const relative = relativeFolder
        ? `${relativeFolder}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const content = await readFile(absolute);
        inventory.set(relative, {
          sha256: sha256(content),
          size: content.length,
          content,
        });
        if (backupRoot) {
          const backupPath = path.join(backupRoot, ...relative.split("/"));
          await mkdir(path.dirname(backupPath), { recursive: true });
          await writeFile(backupPath, content, { mode: 0o600 });
        }
      }
    }
  }
  await walk(EXPECTED_VAULT, "");
  return inventory;
}

async function markdownInventory() {
  return await captureMarkdownSnapshot();
}

function inventoryDigest(inventory) {
  return sha256(
    [...inventory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, value]) =>
        JSON.stringify([relativePath, value.sha256, value.size]),
      )
      .join("\n"),
  );
}

function inventoryDiff(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((relativePath) => {
    const oldValue = before.get(relativePath);
    const newValue = after.get(relativePath);
    if (oldValue?.sha256 === newValue?.sha256) return [];
    return [
      {
        path: relativePath,
        change: !oldValue ? "created" : !newValue ? "removed" : "modified",
        beforeSha256: oldValue?.sha256 ?? null,
        afterSha256: newValue?.sha256 ?? null,
      },
    ];
  });
}

function redactedInventoryChanges(changes) {
  return changes.map((change) => ({
    pathHash: shortHash(change.path),
    change: change.change,
    beforeSha256Hash: change.beforeSha256
      ? shortHash(change.beforeSha256)
      : null,
    afterSha256Hash: change.afterSha256 ? shortHash(change.afterSha256) : null,
  }));
}

async function unusedLoopbackUrl() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

async function fetchWithAbortTimeout(url, init, label, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(
        `${label} timed out after ${timeoutMs}ms.`,
      );
      timeoutError.code = "FETCH_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function assertAbortableFetchContract() {
  let observeAbort;
  const abortedRequest = new Promise((resolve) => {
    observeAbort = resolve;
  });
  const server = createHttpServer((request) => {
    request.once("aborted", () => observeAbort(true));
    request.once("close", () => {
      if (request.aborted) observeAbort(true);
    });
    // Deliberately never respond: the client timeout must abort the request.
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  try {
    await assert.rejects(
      fetchWithAbortTimeout(
        `http://127.0.0.1:${address.port}/blocked-mutation`,
        { method: "POST", body: "bounded-offline-test" },
        "offline abortable fetch",
        250,
      ),
      (error) => error?.code === "FETCH_TIMEOUT",
    );
    assert.equal(
      await withTimeout(
        abortedRequest,
        "offline server to observe fetch abort",
        2_000,
      ),
      true,
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function offlineStartupOrderContract() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-startup-order-offline-"),
  );
  assert.equal(await exists(BACKEND_ENTRY), true, "Run npm run build first.");
  const closedBaseUrl = await unusedLoopbackUrl();
  const childEnv = { ...process.env };
  delete childEnv.OBSIDIAN_STARTUP_BLOCKING;
  delete childEnv.OBSIDIAN_STARTUP_MAX_RETRIES;
  delete childEnv.OBSIDIAN_STARTUP_RETRY_DELAY_MS;
  Object.assign(childEnv, {
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_TOOL_PROFILE: "tasks",
    MCP_WRITE_MODE: "readonly",
    OPERON_MUTATIONS_ENABLED: "false",
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_VAULT: tempRoot,
    OBSIDIAN_BASE_URL: closedBaseUrl,
    OBSIDIAN_API_KEY: "offline-contract-placeholder",
    OBSIDIAN_ENABLE_CACHE: "false",
    SEMANTIC_SEARCH_PREWARM: "false",
    // LOGS_DIR is intentionally kept inside the project boundary required by
    // config.ensureDirectory; an OS-temp LOGS_DIR makes the backend exit.
    LOGS_DIR: PROJECT_LOGS_PATH,
    MCP_LOG_LEVEL: "error",
  });

  let client;
  let diagnostic = "";
  try {
    await assertAbortableFetchContract();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BACKEND_ENTRY],
      cwd: tempRoot,
      env: childEnv,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (diagnostic.length < 16_384) diagnostic += chunk.toString("utf8");
    });
    client = new Client(
      { name: "operon-startup-order-offline", version: "1.0.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), "offline MCP connect", 30_000);
    const before = await withTimeout(
      client.listTools(),
      "offline tools/list before status",
      READ_TIMEOUT_MS,
    );
    const result = await withTimeout(
      client.callTool({ name: "operon_status", arguments: {} }),
      "offline operon_status",
      READ_TIMEOUT_MS,
    );
    const payload = parseMcpPayload(result, "offline operon_status");
    assert.equal(result.isError, false);
    assert.equal(payload?.ok, false);
    assert.equal(payload?.source, "unavailable");
    assert.equal(payload?.error?.code, "live_bridge_unavailable");
    const after = await withTimeout(
      client.listTools(),
      "offline tools/list after status",
      READ_TIMEOUT_MS,
    );
    assert.equal(after.tools.length, before.tools.length);
    assert.equal(
      after.tools.some((tool) => tool.name === "operon_status"),
      true,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          runtimeMode: "live",
          startupBlockingExplicit: false,
          degradedStatusObserved: true,
          sameClientAliveAfterStatus: true,
          abortableFetchTimeoutVerified: true,
          diagnosticHash: diagnostic ? shortHash(diagnostic) : null,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const safeDiagnostic = redactText(
      diagnostic.split(tempRoot).join("[OFFLINE_TEMP]"),
      "offline-contract-placeholder",
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; backendDiagnostic=${safeDiagnostic || "[none]"}`,
    );
  } finally {
    await client?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function inspectPendingLive() {
  const apiKey = (process.env.OBSIDIAN_API_KEY ?? "").trim();
  const baseUrl = (process.env.OBSIDIAN_BASE_URL ?? "").replace(/\/$/u, "");
  const requestedVault = path.resolve(process.env.OBSIDIAN_VAULT ?? "");
  assert.equal(
    requestedVault.toLowerCase(),
    EXPECTED_VAULT.toLowerCase(),
    "OBSIDIAN_VAULT must be the exact disposable Pilot 2 path.",
  );
  assert.equal(baseUrl, EXPECTED_BASE_URL);
  assert.ok(apiKey, "OBSIDIAN_API_KEY is required and is never logged.");
  assert.equal(
    envTrue("OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN"),
    true,
    "Confirm that Pilot 2 is already open.",
  );
  assert.equal(await exists(EXPECTED_VAULT), true, "Pilot 2 vault is missing.");

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-pending-live-inspect-"),
  );
  const cachePath = path.join(tempRoot, "shared-cache.sqlite");
  let client;
  try {
    const transport = new StdioClientTransport({
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
        OPERON_MUTATION_ALLOWED_PATH_PREFIXES: "",
        OBSIDIAN_RUNTIME_MODE: "live",
        OBSIDIAN_STARTUP_BLOCKING: "false",
        OBSIDIAN_VAULT: EXPECTED_VAULT,
        OBSIDIAN_BASE_URL: baseUrl,
        OBSIDIAN_API_KEY: apiKey,
        OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
        OBSIDIAN_ENABLE_CACHE: "true",
        SEMANTIC_SEARCH_PREWARM: "false",
        LOGS_DIR: PROJECT_LOGS_PATH,
        MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    client = new Client(
      { name: "operon-pending-live-inspector", version: "1.0.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), "MCP stdio connect", 30_000);

    const statusResult = await withTimeout(
      client.callTool({ name: "operon_status", arguments: {} }),
      "operon_status",
      READ_TIMEOUT_MS,
    );
    assert.equal(statusResult.isError, false, "operon_status failed.");
    const status = parseMcpPayload(statusResult, "operon_status");
    assertLiveStatus(status?.live);

    const pendingResult = await withTimeout(
      client.callTool({
        name: "operon_list_pending_recoveries",
        arguments: {},
      }),
      "operon_list_pending_recoveries",
      READ_TIMEOUT_MS,
    );
    assert.equal(
      pendingResult.isError,
      false,
      "operon_list_pending_recoveries failed.",
    );
    const pending = parseMcpPayload(
      pendingResult,
      "operon_list_pending_recoveries",
    );
    assert.equal(Array.isArray(pending?.recoveries), true);
    const recoveries = pending.recoveries.map((recovery) => ({
      kind: boundedDiagnosticToken(recovery?.kind) ?? "unknown",
      recoveryRefHash:
        typeof recovery?.recoveryRef === "string"
          ? shortHash(recovery.recoveryRef)
          : null,
      planDigestHash:
        typeof recovery?.planDigest === "string"
          ? shortHash(recovery.planDigest)
          : null,
    }));
    console.log(
      JSON.stringify({ count: recoveries.length, recoveries }, null, 2),
    );
  } finally {
    await client?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function waitForFileStable(absolutePath, predicate, label) {
  const deadline = Date.now() + 25_000;
  let previous = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const current = await readFile(absolutePath, "utf8");
    if (predicate(current)) {
      stableCount = current === previous ? stableCount + 1 : 0;
      if (stableCount >= 2) return current;
    }
    previous = current;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function runCli(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  const exitCode = await withTimeout(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    }),
    "Obsidian CLI vault open",
    CLI_TIMEOUT_MS,
  ).catch((error) => {
    // Never terminate an Obsidian process as a timeout side effect. The CLI
    // child is detached from this canary's event-loop ownership instead.
    child.unref();
    throw error;
  });
  if (exitCode !== 0) {
    throw new Error(`Obsidian CLI exited ${String(exitCode)}.`);
  }
  return { exitCode };
}

async function waitForLocalRestClosed() {
  const deadline = Date.now() + CLI_TIMEOUT_MS;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    try {
      await fetchWithAbortTimeout(
        EXPECTED_BASE_URL,
        {},
        "Pilot 2 Local REST close probe",
        1_000,
      );
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) return;
    }
    await sleep(250);
  }
  throw new Error("Pilot 2 Local REST remained available after CLI close.");
}

async function optionalFileState(absolutePath) {
  if (!(await exists(absolutePath))) return { exists: false, content: null };
  return { exists: true, content: await readFile(absolutePath) };
}

function sameOptionalFileState(left, right) {
  return (
    left?.exists === right?.exists &&
    (!left?.exists || left.content.equals(right.content))
  );
}

function assertLiveStatus(status) {
  assert.equal(status?.ok, true, "Operon status is not healthy.");
  assert.equal(status?.source, "operon-runtime");
  assert.equal(status?.stale, false);
  assert.equal(status?.bridge?.version, EXPECTED_BRIDGE_VERSION);
  assert.equal(status?.bridge?.mode, "read-write");
  assert.equal(status?.operon?.present, true);
  assert.equal(status?.operon?.version, EXPECTED_OPERON_VERSION);
  assert.equal(status?.operon?.compatible, true);
  assert.equal(status?.index?.ready, true);
  assert.equal(Number.isInteger(status?.index?.generation), true);
  assert.ok(status.index.generation > 0);
  assert.equal(status?.index?.duplicateConflictCount, 0);
  for (const capability of [
    "status",
    "configuration",
    "list",
    "get",
    "query",
    "validate",
    "adopt",
    "create",
    "update",
    "periodicCreate",
    "periodicUpdate",
    "taskWorkflowRecovery",
  ]) {
    assert.equal(
      status?.capabilities?.[capability],
      true,
      `Required live capability is unavailable: ${capability}.`,
    );
  }
}

function assertRefreshedSnapshotStatus(status) {
  assert.equal(status?.ok, true, "Forced Operon snapshot refresh failed.");
  assert.equal(status?.source, "operon-live");
  assert.equal(status?.stale, false);
  assert.equal(status?.snapshot?.bridgeVersion, EXPECTED_BRIDGE_VERSION);
  assert.equal(status?.snapshot?.operonVersion, EXPECTED_OPERON_VERSION);
  assert.equal(Number.isInteger(status?.snapshot?.generation), true);
  assert.ok(status.snapshot.generation > 0);
}

async function main() {
  const apiKey = (process.env.OBSIDIAN_API_KEY ?? "").trim();
  const baseUrl = (process.env.OBSIDIAN_BASE_URL ?? "").replace(/\/$/u, "");
  const requestedVault = path.resolve(process.env.OBSIDIAN_VAULT ?? "");
  const startupOrder = envTrue("OPERON_35_CANARY_OPEN_VAULT");

  assert.equal(
    process.env.OPERON_35_CANARY_CONFIRM,
    RUN_CONFIRMATION,
    `Refusing live mutations. Set OPERON_35_CANARY_CONFIRM=${RUN_CONFIRMATION}.`,
  );
  assert.equal(
    requestedVault.toLowerCase(),
    EXPECTED_VAULT.toLowerCase(),
    "OBSIDIAN_VAULT must be the exact disposable Pilot 2 path.",
  );
  assert.equal(
    baseUrl,
    EXPECTED_BASE_URL,
    `OBSIDIAN_BASE_URL must be exactly ${EXPECTED_BASE_URL}.`,
  );
  assert.ok(apiKey, "OBSIDIAN_API_KEY is required and is never logged.");
  assert.equal(
    envTrue("OPERON_MUTATIONS_ENABLED"),
    true,
    "OPERON_MUTATIONS_ENABLED=true is required.",
  );
  assert.equal(await exists(EXPECTED_VAULT), true, "Pilot 2 vault is missing.");
  assert.equal(
    path.basename(EXPECTED_VAULT),
    EXPECTED_VAULT_NAME,
    "Pilot 2 vault identity mismatch.",
  );
  if (startupOrder) {
    assert.equal(
      process.env.OPERON_35_CANARY_CONFIRM_OPEN_VAULT,
      OPEN_CONFIRMATION,
      `Refusing to open Obsidian. Set OPERON_35_CANARY_CONFIRM_OPEN_VAULT=${OPEN_CONFIRMATION}.`,
    );
  } else {
    assert.equal(
      envTrue("OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN"),
      true,
      "Confirm the already-open Pilot 2 with OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN=true, or use the guarded startup-order mode.",
    );
  }

  const fixtureAbsolutePath = absoluteVaultPath(FIXTURE_PATH);
  assert.equal(
    await exists(fixtureAbsolutePath),
    false,
    `Dedicated fixture already exists: ${FIXTURE_PATH}. Recover or remove it before rerunning.`,
  );

  const runId = randomUUID();
  const dates = routeDates(runId);
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-35-live-backup-"),
  );
  const backupManifestPath = path.join(tempRoot, "fixture-state.json");
  const evidenceFile = path.join(
    os.tmpdir(),
    `operon-35-live-evidence-${runId}.json`,
  );
  const cachePath = path.join(tempRoot, "shared-cache.sqlite");
  const markdownBackupPath = path.join(tempRoot, "markdown-backup");
  const periodicRegistryBackupPath = path.join(
    tempRoot,
    "periodic-note-containers-before.json",
  );
  await writeFile(
    backupManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        vaultName: EXPECTED_VAULT_NAME,
        fixturePath: FIXTURE_PATH,
        existedBefore: false,
        restoreContract: "all-canary-markdown-byte-exact",
        runIdHash: shortHash(runId),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const evidence = {
    schemaVersion: 1,
    redacted: true,
    ok: false,
    runId,
    startedAt: new Date().toISOString(),
    vaultName: EXPECTED_VAULT_NAME,
    fixturePath: FIXTURE_PATH,
    startupOrder: { enabled: startupOrder, degradedObserved: false },
    routeDates: dates,
    runtime: null,
    validation: {},
    frontmatterDateManager: {},
    adoption: {},
    media: {},
    periodicScheduling: {},
    periodicCreates: [],
    bridgeConcurrency: {},
    pendingRecoveries: {},
    mutationStatuses: [],
    nativeProofs: [],
    preMutationInventory: null,
    artifactRestoration: { restored: false },
    periodicRegistryRestoration: { restored: false },
    fixtureRestoration: { restored: false },
    error: null,
  };

  let transport;
  let client;
  let backendStderr = "";
  let fixtureCreated = false;
  let fixtureRestored = false;
  let baselineSnapshot = null;
  let periodicRegistryBaseline = null;
  let openedVaultCli = null;
  let success = false;
  let shutdownSignal = null;
  const activeRequests = new Set();
  const artifactPaths = new Set([FIXTURE_PATH]);

  const onSignal = (signal) => {
    shutdownSignal ??= signal;
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  function assertActive() {
    if (shutdownSignal) throw new Error(`Interrupted by ${shutdownSignal}.`);
  }

  function track(promise) {
    activeRequests.add(promise);
    promise.then(
      () => activeRequests.delete(promise),
      () => activeRequests.delete(promise),
    );
    return promise;
  }

  async function callRaw(name, args, options = {}) {
    assertActive();
    const underlying = track(client.callTool({ name, arguments: args }));
    const result = await withTimeout(
      underlying,
      name,
      options.timeoutMs ?? READ_TIMEOUT_MS,
    );
    assertActive();
    const payload = parseMcpPayload(result, name);
    if (result.isError && !options.allowError) {
      const code = payload?.error?.code ?? "MCP_TOOL_ERROR";
      throw new Error(`${name} failed with ${String(code)}.`);
    }
    return { payload, isError: result.isError === true };
  }

  async function call(name, args, options = {}) {
    return (await callRaw(name, args, options)).payload;
  }

  function mutationDiagnostic(result, label, options = {}) {
    const error =
      result?.error && typeof result.error === "object" ? result.error : {};
    const details =
      error?.details && typeof error.details === "object" ? error.details : {};
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof options.thrownMessage === "string"
          ? options.thrownMessage
          : null;
    const safeMessage = message
      ? redactText(message, apiKey)
          .split(runId)
          .join("[REDACTED_RUN_ID]")
          .split(FIXTURE_PATH)
          .join("[REDACTED_FIXTURE]")
      : null;
    const recoveryRef = result?.recoveryRef ?? details?.recoveryRef;
    const planDigest = result?.planDigest ?? details?.planDigest;
    const nativeStatus = result?.nativeStatus ?? details?.nativeStatus;
    const mutationMayHaveApplied =
      result?.mutationMayHaveApplied ?? details?.mutationMayHaveApplied;
    const nativeProof =
      result?.nativeProof && typeof result.nativeProof === "object"
        ? result.nativeProof
        : null;
    const nativeGroups = Array.isArray(nativeProof?.groupResults)
      ? nativeProof.groupResults.slice(0, 32)
      : [];
    const diagnosticCode = boundedDiagnosticToken(
      typeof error.code === "string"
        ? error.code
        : typeof options.thrownCode === "string"
          ? options.thrownCode
          : options.transportError
            ? /timed out/iu.test(message ?? "")
              ? "MCP_TIMEOUT"
              : /connection closed/iu.test(message ?? "")
                ? "MCP_CONNECTION_CLOSED"
                : "MCP_TRANSPORT_ERROR"
            : undefined,
    );
    return {
      label,
      status: boundedDiagnosticToken(
        result?.status ??
          (options.transportError
            ? "transport-error"
            : options.mcpToolError
              ? "mcp-tool-error"
              : null),
      ),
      ...(diagnosticCode ? { code: diagnosticCode } : {}),
      ...(boundedDiagnosticToken(nativeStatus)
        ? { nativeStatus: boundedDiagnosticToken(nativeStatus) }
        : {}),
      ...(typeof nativeProof?.status === "string"
        ? { nativeProofStatus: boundedDiagnosticToken(nativeProof.status) }
        : {}),
      ...(nativeGroups.length > 0
        ? {
            nativeGroupStatuses: nativeGroups.map(
              (group) => boundedDiagnosticToken(group?.status) ?? "unknown",
            ),
            nativeGroupErrorCodes: nativeGroups.flatMap((group) => {
              const code = boundedDiagnosticToken(group?.error?.code);
              return code ? [code] : [];
            }),
          }
        : {}),
      ...(typeof mutationMayHaveApplied === "boolean"
        ? { mutationMayHaveApplied }
        : {}),
      ...(typeof result?.retryable === "boolean"
        ? { retryable: result.retryable }
        : {}),
      ...(typeof result?.operationId === "string"
        ? { operationIdHash: shortHash(result.operationId) }
        : {}),
      ...(typeof recoveryRef === "string" && recoveryRef
        ? { recoveryRefHash: shortHash(recoveryRef) }
        : {}),
      ...(typeof planDigest === "string" && planDigest
        ? { planDigestHash: shortHash(planDigest) }
        : {}),
      ...(safeMessage
        ? {
            messageHash: shortHash(safeMessage),
            messageChars: safeMessage.length,
            messageTruncated: message.length > 2_000,
          }
        : {}),
      ...(options.mcpToolError ? { mcpToolError: true } : {}),
      ...(options.transportError ? { transportError: true } : {}),
    };
  }

  async function callMutation(name, args, label) {
    let observed;
    try {
      observed = await callRaw(name, args, {
        allowError: true,
        timeoutMs: MUTATION_TIMEOUT_MS,
      });
    } catch (error) {
      evidence.mutationStatuses.push(
        mutationDiagnostic(null, label, {
          transportError: true,
          thrownMessage: error instanceof Error ? error.message : String(error),
          thrownCode: typeof error?.code === "string" ? error.code : undefined,
        }),
      );
      throw error;
    }
    const result = observed.payload;
    evidence.mutationStatuses.push(
      mutationDiagnostic(result, label, { mcpToolError: observed.isError }),
    );
    if (observed.isError) {
      const code = result?.error?.code ?? "MCP_TOOL_ERROR";
      throw new Error(`${label} failed with ${String(code)}.`);
    }
    if (result?.status === "outcome-unknown") {
      throw new Error(
        `${label} returned outcome-unknown; no recovery or blind retry was attempted.`,
      );
    }
    return result;
  }

  async function waitForLiveStatus() {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const observed = await callRaw(
        "operon_status",
        {},
        { allowError: true, timeoutMs: READ_TIMEOUT_MS },
      );
      if (!observed.isError) {
        try {
          const liveStatus = observed.payload?.live;
          assertLiveStatus(liveStatus);
          return { status: liveStatus, attempts };
        } catch {
          // The same stdio connection remains alive while the live runtime settles.
        }
      }
      await sleep(1_000);
    }
    throw new Error(
      `Pilot 2 did not become live on the same MCP client within ${STARTUP_TIMEOUT_MS}ms.`,
    );
  }

  async function validateZero(label) {
    const result = await call("operon_validate", { forceRefresh: true });
    assert.deepEqual(
      result?.summary,
      { P0: 0, P1: 0, P2: 0 },
      `${label} validation is not P0/P1/P2 = 0/0/0.`,
    );
    evidence.validation[label] = result.summary;
    return result;
  }

  async function pendingRecoveriesZero(label) {
    const result = await call("operon_list_pending_recoveries", {});
    assert.equal(
      Array.isArray(result?.recoveries),
      true,
      `${label} pending recovery response is malformed.`,
    );
    assert.equal(
      result.recoveries.length,
      0,
      `${label} has pending Operon recoveries; the canary will not recover or retry them.`,
    );
    evidence.pendingRecoveries[label] = 0;
  }

  async function stableTask(operonId) {
    const deadline = Date.now() + 30_000;
    let previousRevision = null;
    while (Date.now() < deadline) {
      const result = await call("operon_get_task", {
        operonId,
        includeProperties: true,
        forceRefresh: true,
      });
      const task = result?.task;
      if (task?.revision && task.revision === previousRevision) return task;
      previousRevision = task?.revision ?? null;
      await sleep(750);
    }
    throw new Error(
      `Operon task ${shortHash(operonId)} did not reach a stable revision.`,
    );
  }

  async function periodicCreateViaMcp(kind, routeDate, label) {
    const description = `Operon 3.5 ${kind} canary ${runId}`;
    const before = await markdownInventory();
    const periodic = {
      description,
      periodicKind: kind,
      routeDate,
      fields: { taskType: `canary-${kind}` },
    };
    const preview = mutationStatus(
      await callMutation(
        "operon_create_periodic_task",
        {
          idempotencyKey: `${runId}:${kind}:preview`,
          dryRun: true,
          periodic,
        },
        `${label} preview`,
      ),
      `${label} preview`,
      "planned",
    );
    assert.equal(
      preview.plan?.capability,
      "tasks.create.periodic-note.preview",
    );
    assert.equal(preview.plan?.mutationKind, "task.create");
    assert.equal(preview.plan?.planDigest, preview.planDigest);
    trackPlannedTaskSourceArtifacts(preview.plan, `${label} preview`);
    assert.deepEqual(
      redactedInventoryChanges(
        inventoryDiff(before, await markdownInventory()),
      ),
      [],
      `${label} preview changed the vault inventory.`,
    );
    const result = mutationStatus(
      await callMutation(
        "operon_create_periodic_task",
        {
          idempotencyKey: `${runId}:${kind}:apply`,
          dryRun: false,
          periodic,
        },
        label,
      ),
      label,
      "applied",
    );
    evidence.nativeProofs.push(assertNativeMutationProof(result, label));
    assert.equal(result?.after?.source, "inline");
    assert.equal(
      canonicalRelativeMarkdownPath(result?.after?.path),
      true,
      `${label} returned an unsafe source path.`,
    );
    artifactPaths.add(result.after.path);
    const after = await markdownInventory();
    const changes = inventoryDiff(before, after);
    const sourceBefore = before.get(result.after.path);
    assert.equal(
      sourceBefore,
      undefined,
      `${label} routed into a pre-existing Markdown note; refusing to treat it as a canary artifact.`,
    );
    assert.equal(
      changes.some(
        (change) =>
          change.path === result.after.path && change.change === "created",
      ),
      true,
      `${label} did not create a dedicated periodic note.`,
    );
    const sourceContent = await readFile(
      absoluteVaultPath(result.after.path),
      "utf8",
    );
    assert.equal(
      sourceContent.includes(runId),
      true,
      `${label} source does not contain the run marker.`,
    );
    evidence.periodicCreates.push({
      kind,
      routeDate,
      pathHash: shortHash(result.after.path),
      operationIdHash: shortHash(result.operationId),
      operonIdHash: shortHash(result.after.operonId),
      previewPlanDigestHash: shortHash(preview.planDigest),
      markdownChanges: redactedInventoryChanges(changes),
      restoredOnPass: false,
    });
    return result.after;
  }

  function trackPlannedTaskSourceArtifacts(plan, label) {
    const candidates = [
      plan?.periodicRoute?.notePath,
      plan?.periodicUpdate?.notePath,
      ...(plan?.periodicUpdate?.sourceTransitions ?? []).map(
        (transition) => transition?.filePath,
      ),
    ].filter((value) => typeof value === "string");
    for (const relativePath of new Set(candidates)) {
      assert.equal(
        canonicalRelativeMarkdownPath(relativePath),
        true,
        `${label} returned an unsafe planned task-source path.`,
      );
      artifactPaths.add(relativePath);
    }
  }

  function trackNativeTaskSourceArtifacts(result, label) {
    for (const group of result?.nativeProof?.groupResults ?? []) {
      for (const revision of group.resourceRevisions ?? []) {
        if (revision.resourceKind !== "task-source") continue;
        assert.equal(
          canonicalRelativeMarkdownPath(revision.resourceKey),
          true,
          `${label} returned an unsafe task-source resource key.`,
        );
        artifactPaths.add(revision.resourceKey);
      }
    }
  }

  async function removeEmptyArtifactParents(relativePath) {
    let current = path.dirname(absoluteVaultPath(relativePath));
    const vaultRoot = EXPECTED_VAULT.toLowerCase();
    while (current.toLowerCase() !== vaultRoot) {
      try {
        await rmdir(current);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return;
        throw error;
      }
      current = path.dirname(current);
    }
  }

  async function restoreAllCanaryArtifacts() {
    if (!baselineSnapshot) {
      fixtureRestored = !fixtureCreated;
      evidence.fixtureRestoration = {
        restored: fixtureRestored,
        expectedState: "absent",
      };
      return;
    }

    const current = await captureMarkdownSnapshot();
    const changes = inventoryDiff(baselineSnapshot, current);
    const restorable = [];
    const unexpected = [];
    for (const change of changes) {
      const currentContent = current.get(change.path)?.content;
      const belongsToRun =
        artifactPaths.has(change.path) ||
        change.path === FIXTURE_PATH ||
        currentContent?.includes(Buffer.from(runId, "utf8"));
      (belongsToRun ? restorable : unexpected).push(change);
    }

    for (const change of restorable) {
      const original = baselineSnapshot.get(change.path);
      const absolute = absoluteVaultPath(change.path);
      if (original) {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, original.content, { mode: 0o600 });
      } else {
        await rm(absolute, { force: true });
        await removeEmptyArtifactParents(change.path);
      }
    }

    const after = await captureMarkdownSnapshot();
    const remaining = inventoryDiff(baselineSnapshot, after);
    const restored = remaining.length === 0 && unexpected.length === 0;
    fixtureRestored = !(await exists(fixtureAbsolutePath));
    evidence.fixtureRestoration = {
      restored: fixtureRestored,
      expectedState: "absent",
    };
    evidence.artifactRestoration = {
      restored,
      restoredChangeCount: restorable.length,
      unexpectedChangeCount: unexpected.length,
      remainingChangeCount: remaining.length,
      restoredPathHashes: restorable.map((change) => shortHash(change.path)),
      unexpectedPathHashes: unexpected.map((change) => shortHash(change.path)),
      remainingPathHashes: remaining.map((change) => shortHash(change.path)),
      finalInventoryDigestHash: shortHash(inventoryDigest(after)),
    };
    assert.equal(
      unexpected.length,
      0,
      "Unexpected Markdown changes occurred during the canary; they were not overwritten.",
    );
    assert.deepEqual(
      remaining,
      [],
      "Canary Markdown artifacts were not restored byte-for-byte.",
    );
  }

  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BACKEND_ENTRY],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        MCP_TRANSPORT_TYPE: "stdio",
        MCP_TOOL_PROFILE: "tasks",
        MCP_WRITE_MODE: "full",
        OPERON_MUTATIONS_ENABLED: "true",
        OPERON_MUTATION_ALLOWED_PATH_PREFIXES: "",
        OBSIDIAN_RUNTIME_MODE: "live",
        // The startup-order contract is a live-runtime promise: the MCP must
        // remain connected while Desktop/Local REST is temporarily absent.
        OBSIDIAN_STARTUP_BLOCKING: "false",
        OBSIDIAN_VAULT: EXPECTED_VAULT,
        OBSIDIAN_BASE_URL: baseUrl,
        OBSIDIAN_API_KEY: apiKey,
        OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
        OBSIDIAN_ENABLE_CACHE: "true",
        SEMANTIC_SEARCH_PREWARM: "false",
        LOGS_DIR: PROJECT_LOGS_PATH,
        MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (backendStderr.length < 32_768) {
        backendStderr += chunk.toString("utf8");
      }
    });
    client = new Client(
      { name: "operon-35-live-canary", version: "1.0.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), "MCP stdio connect", 30_000);

    const toolListBefore = await withTimeout(
      client.listTools(),
      "MCP tools/list",
      READ_TIMEOUT_MS,
    );
    const toolNames = new Set(toolListBefore.tools.map((tool) => tool.name));
    for (const required of [
      "operon_status",
      "operon_validate",
      "operon_adopt_task",
      "operon_create_periodic_task",
      "operon_update_periodic_scheduling",
      "operon_update_task",
      "operon_get_task",
      "operon_query_tasks",
      "operon_list_pending_recoveries",
      "operon_recover_mutation",
    ]) {
      assert.equal(
        toolNames.has(required),
        true,
        `Missing MCP tool: ${required}.`,
      );
    }

    if (startupOrder) {
      const degraded = await callRaw("operon_status", {}, { allowError: true });
      const degradedObserved =
        degraded.isError ||
        degraded.payload?.ok !== true ||
        degraded.payload?.live?.index?.ready !== true;
      assert.equal(
        degradedObserved,
        true,
        "Startup-order mode requires Pilot 2 to be closed at the first status call.",
      );
      evidence.startupOrder.degradedObserved = true;
      evidence.startupOrder.connectionAliveAfterDegraded =
        (
          await withTimeout(
            client.listTools(),
            "MCP tools/list after degraded status",
            READ_TIMEOUT_MS,
          )
        ).tools.length === toolListBefore.tools.length;
      assert.equal(
        evidence.startupOrder.connectionAliveAfterDegraded,
        true,
        "MCP connection did not survive the degraded status call.",
      );
      const cliCommand =
        (process.env.OPERON_35_CANARY_OBSIDIAN_CLI ?? "obsidian").trim() ||
        "obsidian";
      openedVaultCli = cliCommand;
      const cli = await runCli(cliCommand, [
        `vault=${EXPECTED_VAULT_NAME}`,
        "version",
      ]);
      evidence.startupOrder.cliExitCode = cli.exitCode;
    }

    const live = await waitForLiveStatus();
    evidence.startupOrder.liveAttempts = live.attempts;
    evidence.startupOrder.sameClientBecameLive = true;
    evidence.runtime = {
      operonVersion: live.status.operon.version,
      bridgeVersion: live.status.bridge.version,
      bridgeMode: live.status.bridge.mode,
      compatibilityState: live.status.operon.compatibilityState ?? null,
      generation: live.status.index.generation,
      taskCount: live.status.index.taskCount,
      capabilities: Object.fromEntries(
        [
          "adopt",
          "create",
          "update",
          "periodicCreate",
          "periodicUpdate",
          "taskWorkflowRecovery",
        ].map((name) => [name, live.status.capabilities[name]]),
      ),
    };

    await validateZero("before");
    await pendingRecoveriesZero("before");

    const collisionMarkers = [
      ...new Set([
        runId,
        dates.daily,
        dates.scheduled,
        dates.weekly,
        ...isoWeekMarkers(dates.weekly),
        dates.concurrent,
      ]),
    ];
    baselineSnapshot = await captureMarkdownSnapshot(markdownBackupPath);
    periodicRegistryBaseline = await optionalFileState(PERIODIC_REGISTRY_PATH);
    if (periodicRegistryBaseline.exists) {
      await writeFile(
        periodicRegistryBackupPath,
        periodicRegistryBaseline.content,
        { mode: 0o600 },
      );
    }
    assertCollisionFree(baselineSnapshot, collisionMarkers);
    await writeFile(
      backupManifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          vaultName: EXPECTED_VAULT_NAME,
          fixturePath: FIXTURE_PATH,
          existedBefore: false,
          restoreContract: "all-canary-markdown-byte-exact",
          runIdHash: shortHash(runId),
          markdownCount: baselineSnapshot.size,
          inventoryDigest: inventoryDigest(baselineSnapshot),
          periodicRegistryExisted: periodicRegistryBaseline.exists,
          periodicRegistryDigest: periodicRegistryBaseline.exists
            ? sha256(periodicRegistryBaseline.content)
            : null,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const preflightQuery = await call("operon_query_tasks", {
      search: runId,
      forceRefresh: true,
      limit: 100,
    });
    assert.equal(
      (preflightQuery?.tasks ?? []).length,
      0,
      "The unique canary run marker already resolves to an Operon task.",
    );
    evidence.preMutationInventory = {
      completed: true,
      markdownCount: baselineSnapshot.size,
      inventoryDigestHash: shortHash(inventoryDigest(baselineSnapshot)),
      collisionMarkerHashes: collisionMarkers.map(shortHash),
      operonCollisionCount: 0,
      backupStoredInPrivateTemp: true,
      periodicRegistryExisted: periodicRegistryBaseline.exists,
      periodicRegistryDigestHash: periodicRegistryBaseline.exists
        ? shortHash(sha256(periodicRegistryBaseline.content))
        : null,
    };

    const communityPlugins = JSON.parse(
      await readFile(
        path.join(EXPECTED_VAULT, ".obsidian", "community-plugins.json"),
        "utf8",
      ),
    );
    const operonSettings = JSON.parse(
      await readFile(
        path.join(
          EXPECTED_VAULT,
          ".obsidian",
          "plugins",
          "operon",
          "data.json",
        ),
        "utf8",
      ),
    );
    const periodicProfile = operonSettings?.ui?.taskCreationProfile;
    assert.equal(
      periodicProfile?.manageDailyNotesWithOperon,
      true,
      "Pilot 2 must use Operon-managed Daily Notes before the canary mutates Markdown.",
    );
    assert.equal(
      periodicProfile?.createDailyNotesAsOperonTask,
      true,
      "Pilot 2 must create Daily Notes as Operon tasks before the canary mutates Markdown.",
    );
    assert.equal(
      periodicProfile?.manageWeeklyNotesWithOperon,
      true,
      "Pilot 2 must use Operon-managed Weekly Notes before the canary mutates Markdown.",
    );
    assert.equal(
      periodicProfile?.createWeeklyNotesAsOperonTask,
      true,
      "Pilot 2 must create Weekly Notes as Operon tasks before the canary mutates Markdown.",
    );
    const dateManagerSettings = JSON.parse(
      await readFile(
        path.join(
          EXPECTED_VAULT,
          ".obsidian",
          "plugins",
          "frontmatter-date-manager",
          "data.json",
        ),
        "utf8",
      ),
    );
    const dateManagerManifest = JSON.parse(
      await readFile(
        path.join(
          EXPECTED_VAULT,
          ".obsidian",
          "plugins",
          "frontmatter-date-manager",
          "manifest.json",
        ),
        "utf8",
      ),
    );
    assert.equal(communityPlugins.includes("frontmatter-date-manager"), true);
    assert.equal(dateManagerManifest.version, "1.2.1");
    assert.equal(dateManagerSettings.enableAutoUpdate, true);
    assert.equal(dateManagerSettings.enableModifiedTime, true);

    await mkdir(path.dirname(fixtureAbsolutePath), { recursive: true });
    const expectedLine = `- [ ] Operon adoption canary ${runId}`;
    const initialFixture = [
      "---",
      "canary: operon-3.5-live",
      `modification: ${ORIGINAL_MODIFICATION}`,
      "---",
      "",
      `Dedicated Pilot 2 fixture ${runId}.`,
      expectedLine,
      "",
    ].join("\n");
    await writeFile(fixtureAbsolutePath, initialFixture, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fixtureCreated = true;
    const fixtureBeforeAdoption = await waitForFileStable(
      fixtureAbsolutePath,
      (content) =>
        content.includes(expectedLine) &&
        frontmatterScalarWhenValid(content, "modification") ===
          ORIGINAL_MODIFICATION,
      "the external fixture to settle before governed adoption",
    );
    const fixtureLines = fixtureBeforeAdoption.split(/\r?\n/u);
    const adoptionIndexes = fixtureLines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line === expectedLine);
    assert.equal(adoptionIndexes.length, 1);
    const adoptionLine = adoptionIndexes[0].index + 1;
    const adoptionArgs = {
      idempotencyKey: `${runId}:adopt:apply`,
      dryRun: false,
      adoption: {
        targetPath: FIXTURE_PATH,
        line: adoptionLine,
        expectedLine,
      },
    };
    const adopted = mutationStatus(
      await callMutation("operon_adopt_task", adoptionArgs, "adoption apply"),
      "adoption apply",
      "applied",
    );
    evidence.nativeProofs.push(
      assertNativeMutationProof(adopted, "adoption apply"),
    );
    assert.equal(adopted.after?.path, FIXTURE_PATH);
    assert.equal(adopted.after?.line, adoptionLine);
    const fixtureAfterGovernedAdoption = await waitForFileStable(
      fixtureAbsolutePath,
      (content) => {
        const modification = frontmatterScalarWhenValid(
          content,
          "modification",
        );
        return (
          content.includes(runId) &&
          modification !== null &&
          modification !== ORIGINAL_MODIFICATION
        );
      },
      "Frontmatter Date Manager after governed Operon adoption",
    );
    const observedModification = markdownFrontmatter(
      fixtureAfterGovernedAdoption,
      "governed adoption fixture",
    ).modification;
    assert.ok(observedModification);
    evidence.frontmatterDateManager = {
      enabled: true,
      version: dateManagerManifest.version,
      autoUpdate: true,
      modifiedTimeObserved: true,
      trigger: "operon_adopt_task",
      externalCreateWasNotTreatedAsTheTrigger: true,
      beforeContentHash: shortHash(fixtureBeforeAdoption),
      afterContentHash: shortHash(fixtureAfterGovernedAdoption),
      observedModificationHash: shortHash(String(observedModification)),
      pluginSettingsHash: shortHash(JSON.stringify(dateManagerSettings)),
    };
    const adoptedId = adopted.after.operonId;
    const replay = await callMutation(
      "operon_adopt_task",
      adoptionArgs,
      "adoption replay",
    );
    assert.equal(
      replay.operationId,
      adopted.operationId,
      "Adoption replay returned a different operationId.",
    );
    assert.equal(replay.replayed, true);
    evidence.nativeProofs.push(
      assertNativeMutationProof(replay, "adoption replay"),
    );
    const staleLine = mutationStatus(
      await callMutation(
        "operon_adopt_task",
        {
          ...adoptionArgs,
          idempotencyKey: `${runId}:adopt:stale-line`,
        },
        "adoption stale line",
      ),
      "adoption stale line",
      "conflict",
    );
    evidence.adoption = {
      applied: true,
      replayed: replay.replayed,
      staleLineConflict: staleLine.status,
      operationIdHash: shortHash(adopted.operationId),
      operonIdHash: shortHash(adoptedId),
      exactLine: adoptionLine,
    };

    const beforeMedia = await stableTask(adoptedId);
    const taskType = `canary-type-${runId.slice(0, 8)}`;
    const taskImage = `Canary\\cover;${runId.slice(0, 8)}.png`;
    const galleryInput = [
      `Canary/gallery;${runId.slice(0, 8)}.png`,
      `Canary\\gallery;${runId.slice(0, 8)}.png`,
      `Canary/gallery;${runId.slice(0, 8)}.png`,
    ];
    const galleryExpected = galleryInput.slice(0, 2);
    const mediaApplied = mutationStatus(
      await callMutation(
        "operon_update_task",
        {
          operonId: adoptedId,
          expectedRevision: beforeMedia.revision,
          idempotencyKey: `${runId}:media:apply`,
          dryRun: false,
          patch: {
            fields: {
              taskType,
              taskImage,
              taskGallery: galleryInput,
            },
          },
        },
        "typed media apply",
      ),
      "typed media apply",
      "applied",
    );
    evidence.nativeProofs.push(
      assertNativeMutationProof(mediaApplied, "typed media apply"),
    );
    assert.equal(typeof mediaApplied.after?.fields?.taskType, "string");
    assert.equal(mediaApplied.after.fields.taskType, taskType);
    assert.equal(typeof mediaApplied.after.fields.taskImage, "string");
    assert.equal(mediaApplied.after.fields.taskImage, taskImage);
    assert.equal(Array.isArray(mediaApplied.after.fields.taskGallery), true);
    assert.deepEqual(mediaApplied.after.fields.taskGallery, galleryExpected);
    // Isolate the stale-revision assertion from normal post-write index churn
    // (including Frontmatter Date Manager's immediate timestamp update). The
    // following mutation must fail because its revision is stale, not because
    // the Operon snapshot was sampled while a live generation was settling.
    await stableTask(adoptedId);
    const staleRevision = mutationStatus(
      await callMutation(
        "operon_update_task",
        {
          operonId: adoptedId,
          expectedRevision: beforeMedia.revision,
          idempotencyKey: `${runId}:media:stale-revision`,
          dryRun: false,
          patch: { fields: { taskType: `${taskType}-stale` } },
        },
        "typed media stale revision",
      ),
      "typed media stale revision",
      "conflict",
    );
    evidence.media = {
      taskTypeScalar: true,
      taskImageScalar: true,
      galleryArray: true,
      galleryOrderPreserved: true,
      galleryFirstOccurrenceDeduplicated: true,
      punctuationPreserved: true,
      staleRevisionConflict: staleRevision.status,
    };

    const daily = await periodicCreateViaMcp(
      "daily",
      dates.daily,
      "Daily periodic create",
    );
    const weekly = await periodicCreateViaMcp(
      "weekly",
      dates.weekly,
      "Weekly periodic create",
    );
    assert.notEqual(daily.path, weekly.path);

    const schedulingCapabilityStatus = await call("operon_status", {
      forceRefresh: true,
    });
    assertRefreshedSnapshotStatus(schedulingCapabilityStatus);
    assert.equal(
      schedulingCapabilityStatus.snapshot.capabilities.periodicUpdate,
      true,
      "The created periodic fixture cannot be scheduled because the live projection does not explicitly expose periodicUpdate: true.",
    );
    const beforeSchedule = await stableTask(daily.operonId);
    assert.deepEqual(
      { path: beforeSchedule.path, line: beforeSchedule.line },
      { path: daily.path, line: daily.line },
      "The created Daily fixture locator changed before periodic scheduling.",
    );
    assert.equal(beforeSchedule.source, "inline");
    assert.equal(
      typeof beforeSchedule.parentTask === "string" &&
        beforeSchedule.parentTask.length > 0,
      true,
      "The created Daily fixture has no projected periodic parent; refusing periodic scheduling.",
    );
    const sourceLocator = {
      path: beforeSchedule.path,
      line: beforeSchedule.line,
    };
    const schedulePreview = mutationStatus(
      await callMutation(
        "operon_update_periodic_scheduling",
        {
          operonId: daily.operonId,
          expectedRevision: beforeSchedule.revision,
          idempotencyKey: `${runId}:periodic-schedule:set-preview`,
          dryRun: true,
          patch: { fields: { dateScheduled: dates.scheduled } },
        },
        "periodic scheduling set preview",
      ),
      "periodic scheduling set preview",
      "planned",
    );
    assert.equal(
      schedulePreview.plan?.capability,
      "tasks.update.periodic-note.preview",
      "Operon did not project the additive periodic-update plan for the created Daily fixture.",
    );
    assert.equal(schedulePreview.plan?.mutationKind, "task.update");
    assert.equal(schedulePreview.plan?.planDigest, schedulePreview.planDigest);
    trackPlannedTaskSourceArtifacts(
      schedulePreview.plan,
      "Periodic scheduling set preview",
    );
    const beforeScheduleApply = await stableTask(daily.operonId);
    assert.equal(
      beforeScheduleApply.revision,
      beforeSchedule.revision,
      "The Daily fixture changed after periodic scheduling preview.",
    );
    const beforeSchedulingMutationInventory = await markdownInventory();
    const scheduledResult = await callMutation(
      "operon_update_periodic_scheduling",
      {
        operonId: daily.operonId,
        expectedRevision: beforeScheduleApply.revision,
        idempotencyKey: `${runId}:periodic-schedule:set`,
        dryRun: false,
        patch: { fields: { dateScheduled: dates.scheduled } },
      },
      "periodic scheduling set",
    );
    const schedulingMutationChanges = inventoryDiff(
      beforeSchedulingMutationInventory,
      await markdownInventory(),
    );
    for (const change of schedulingMutationChanges) {
      if (
        change.change === "created" &&
        path.basename(change.path, ".md") === dates.scheduled
      ) {
        assert.equal(
          canonicalRelativeMarkdownPath(change.path),
          true,
          "Periodic scheduling created an unsafe task-source path.",
        );
        artifactPaths.add(change.path);
      }
    }
    trackNativeTaskSourceArtifacts(scheduledResult, "Periodic scheduling set");
    const scheduled = mutationStatus(
      scheduledResult,
      "periodic scheduling set",
      "applied",
    );
    evidence.nativeProofs.push(
      assertNativeMutationProof(scheduled, "periodic scheduling set"),
    );
    assert.equal(scheduled.after.path, sourceLocator.path);
    assert.equal(scheduled.after.operonId, daily.operonId);
    assert.equal(Number.isInteger(scheduled.after.line), true);
    assert.equal(scheduled.after.dates.scheduled, dates.scheduled);
    assert.equal(
      typeof scheduled.after.parentTask === "string" &&
        scheduled.after.parentTask.length > 0,
      true,
      "Periodic scheduling set did not project a periodic parent.",
    );
    assert.notEqual(scheduled.after.parentTask, beforeSchedule.parentTask);
    const beforeClear = await stableTask(daily.operonId);
    assert.equal(beforeClear.parentTask === beforeSchedule.parentTask, false);
    const clearPreview = mutationStatus(
      await callMutation(
        "operon_update_periodic_scheduling",
        {
          operonId: daily.operonId,
          expectedRevision: beforeClear.revision,
          idempotencyKey: `${runId}:periodic-schedule:clear-preview`,
          dryRun: true,
          patch: { fields: { dateScheduled: null } },
        },
        "periodic scheduling clear preview",
      ),
      "periodic scheduling clear preview",
      "planned",
    );
    assert.equal(
      clearPreview.plan?.capability,
      "tasks.update.periodic-note.preview",
      "Operon did not project the additive periodic-update clear plan for the created Daily fixture.",
    );
    assert.equal(clearPreview.plan?.mutationKind, "task.update");
    assert.equal(clearPreview.plan?.planDigest, clearPreview.planDigest);
    trackPlannedTaskSourceArtifacts(
      clearPreview.plan,
      "Periodic scheduling clear preview",
    );
    const beforeClearApply = await stableTask(daily.operonId);
    assert.equal(
      beforeClearApply.revision,
      beforeClear.revision,
      "The Daily fixture changed after periodic scheduling clear preview.",
    );
    const clearedResult = await callMutation(
      "operon_update_periodic_scheduling",
      {
        operonId: daily.operonId,
        expectedRevision: beforeClearApply.revision,
        idempotencyKey: `${runId}:periodic-schedule:clear`,
        dryRun: false,
        patch: { fields: { dateScheduled: null } },
      },
      "periodic scheduling clear",
    );
    trackNativeTaskSourceArtifacts(clearedResult, "Periodic scheduling clear");
    const cleared = mutationStatus(
      clearedResult,
      "periodic scheduling clear",
      "applied",
    );
    evidence.nativeProofs.push(
      assertNativeMutationProof(cleared, "periodic scheduling clear"),
    );
    assert.equal(cleared.after.path, sourceLocator.path);
    assert.equal(cleared.after.operonId, daily.operonId);
    assert.equal(Number.isInteger(cleared.after.line), true);
    assert.equal(cleared.after.dates.scheduled, null);
    assert.equal(cleared.after.parentTask, null);
    evidence.periodicScheduling = {
      fixtureKind: "daily",
      fixtureOperonIdHash: shortHash(daily.operonId),
      capabilityProjected: true,
      periodicParentProjected: true,
      initialParentTaskHash: shortHash(beforeSchedule.parentTask),
      setPreviewPlanDigestHash: shortHash(schedulePreview.planDigest),
      clearPreviewPlanDigestHash: shortHash(clearPreview.planDigest),
      set: true,
      clear: true,
      sourcePathPreserved: true,
      sourceIdentityPreserved: true,
      sourceLineShiftObserved:
        scheduled.after.line !== sourceLocator.line ||
        cleared.after.line !== sourceLocator.line,
      sourcePathHash: shortHash(sourceLocator.path),
    };

    const concurrentDescription = `Operon 3.5 concurrent periodic canary ${runId}`;
    const concurrentBody = JSON.stringify({
      idempotencyKey: `${runId}:bridge:periodic-concurrent`,
      dryRun: false,
      periodic: {
        description: concurrentDescription,
        periodicKind: "daily",
        routeDate: dates.concurrent,
        fields: { taskType: "canary-concurrent-periodic" },
      },
    });
    const beforeConcurrent = await markdownInventory();
    const bridgeUrl = `${baseUrl}${BRIDGE_PREFIX}/tasks/periodic`;
    const bridgePost = async () => {
      const response = await fetchWithAbortTimeout(
        bridgeUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: concurrentBody,
        },
        "concurrent Bridge periodic POST",
        MUTATION_TIMEOUT_MS,
      );
      const payload = await response.json();
      return { status: response.status, payload };
    };
    const bridgeSettled = await Promise.allSettled([
      track(bridgePost()),
      track(bridgePost()),
    ]);
    for (const [index, settled] of bridgeSettled.entries()) {
      if (settled.status === "rejected") {
        evidence.mutationStatuses.push(
          mutationDiagnostic(
            null,
            `Bridge concurrency ${index === 0 ? "A" : "B"}`,
            {
              transportError: true,
              thrownMessage:
                settled.reason instanceof Error
                  ? settled.reason.message
                  : String(settled.reason),
              thrownCode:
                typeof settled.reason?.code === "string"
                  ? settled.reason.code
                  : undefined,
            },
          ),
        );
      }
    }
    const rejectedBridge = bridgeSettled.find(
      (settled) => settled.status === "rejected",
    );
    if (rejectedBridge) throw rejectedBridge.reason;
    const [bridgeA, bridgeB] = bridgeSettled.map((settled) => settled.value);
    evidence.mutationStatuses.push(
      {
        ...mutationDiagnostic(bridgeA.payload, "Bridge concurrency A"),
        httpStatus: bridgeA.status,
      },
      {
        ...mutationDiagnostic(bridgeB.payload, "Bridge concurrency B"),
        httpStatus: bridgeB.status,
      },
    );
    assert.equal(bridgeA.status, 200);
    assert.equal(bridgeB.status, 200);
    mutationStatus(bridgeA.payload, "Bridge concurrency A", "applied");
    evidence.nativeProofs.push(
      assertNativeMutationProof(bridgeA.payload, "Bridge concurrency A"),
    );
    assert.equal(bridgeB.payload.status, bridgeA.payload.status);
    assert.equal(
      bridgeB.payload.operationId,
      bridgeA.payload.operationId,
      "Concurrent Bridge responses returned different operationIds.",
    );
    const bridgeResultHash = sha256(JSON.stringify(bridgeA.payload));
    assert.equal(
      sha256(JSON.stringify(bridgeB.payload)),
      bridgeResultHash,
      "Concurrent Bridge responses returned different result bodies.",
    );
    const concurrentTask = bridgeA.payload.after;
    assert.equal(concurrentTask?.source, "inline");
    assert.equal(canonicalRelativeMarkdownPath(concurrentTask?.path), true);
    artifactPaths.add(concurrentTask.path);
    const afterConcurrent = await markdownInventory();
    const concurrentChanges = inventoryDiff(beforeConcurrent, afterConcurrent);
    assert.equal(beforeConcurrent.has(concurrentTask.path), false);
    assert.equal(
      concurrentChanges.some(
        (change) =>
          change.path === concurrentTask.path && change.change === "created",
      ),
      true,
    );
    const concurrentQuery = await call("operon_query_tasks", {
      search: concurrentDescription,
      pathIncludes: [concurrentTask.path],
      forceRefresh: true,
      limit: 100,
    });
    const exactConcurrentTasks = (concurrentQuery?.tasks ?? []).filter(
      (task) =>
        task.description === concurrentDescription &&
        task.path === concurrentTask.path,
    );
    assert.equal(
      exactConcurrentTasks.length,
      1,
      "Concurrent Bridge requests created more than one periodic task.",
    );
    assert.equal(
      exactConcurrentTasks[0].operonId,
      concurrentTask.operonId,
      "The single visible concurrent task does not match the Bridge result.",
    );
    evidence.bridgeConcurrency = {
      route: `${BRIDGE_PREFIX}/tasks/periodic`,
      httpStatuses: [bridgeA.status, bridgeB.status],
      sameOperationId: true,
      sameResult: true,
      exactVisibleTaskCount: exactConcurrentTasks.length,
      resultHash: bridgeResultHash,
      operationIdHash: shortHash(bridgeA.payload.operationId),
      operonIdHash: shortHash(concurrentTask.operonId),
      pathHash: shortHash(concurrentTask.path),
      markdownChanges: redactedInventoryChanges(concurrentChanges),
      restoredOnPass: false,
    };

    await validateZero("afterMutations");
    await pendingRecoveriesZero("afterMutations");

    await restoreAllCanaryArtifacts();
    assert.equal(fixtureRestored, true);
    const cleanupDeadline = Date.now() + 45_000;
    while (Date.now() < cleanupDeadline) {
      const query = await call("operon_query_tasks", {
        search: runId,
        forceRefresh: true,
        limit: 100,
      });
      if ((query?.tasks ?? []).length === 0) break;
      await sleep(750);
    }
    const restoredQuery = await call("operon_query_tasks", {
      search: runId,
      forceRefresh: true,
      limit: 100,
    });
    assert.equal((restoredQuery?.tasks ?? []).length, 0);
    await validateZero("afterArtifactRestore");
    await pendingRecoveriesZero("afterArtifactRestore");
    const finalSnapshot = await captureMarkdownSnapshot();
    assert.deepEqual(
      inventoryDiff(baselineSnapshot, finalSnapshot),
      [],
      "Markdown inventory drifted after Operon refreshed the restored artifacts.",
    );
    evidence.artifactRestoration.finalVerifiedAfterIndexRefresh = true;
    evidence.artifactRestoration.finalInventoryDigestHash = shortHash(
      inventoryDigest(finalSnapshot),
    );
    const registryDeadline = Date.now() + 45_000;
    let periodicRegistryAfter = await optionalFileState(PERIODIC_REGISTRY_PATH);
    while (
      !sameOptionalFileState(periodicRegistryBaseline, periodicRegistryAfter) &&
      Date.now() < registryDeadline
    ) {
      await sleep(750);
      periodicRegistryAfter = await optionalFileState(PERIODIC_REGISTRY_PATH);
    }
    assert.equal(
      sameOptionalFileState(periodicRegistryBaseline, periodicRegistryAfter),
      true,
      "Operon periodic container registry drifted after artifact restoration.",
    );
    evidence.periodicRegistryRestoration = {
      restored: true,
      expectedState: periodicRegistryBaseline.exists ? "present" : "absent",
      finalDigestHash: periodicRegistryAfter.exists
        ? shortHash(sha256(periodicRegistryAfter.content))
        : null,
    };
    for (const artifact of evidence.periodicCreates) {
      artifact.restoredOnPass = true;
    }
    evidence.bridgeConcurrency.restoredOnPass = true;

    evidence.ok = true;
    evidence.completedAt = new Date().toISOString();
    success = true;
  } catch (error) {
    evidence.error = {
      name: error instanceof Error ? error.name : "Error",
      message: redactText(
        error instanceof Error ? error.message : error,
        apiKey,
      ),
    };
  } finally {
    const pending = [...activeRequests];
    if (pending.length > 0) {
      await withTimeout(
        Promise.allSettled(pending),
        "active MCP requests to settle before artifact restoration",
        MUTATION_TIMEOUT_MS + 10_000,
      ).catch((error) => {
        evidence.error ??= {
          name: "CleanupError",
          message: redactText(error.message, apiKey),
        };
      });
    }
    if (!evidence.artifactRestoration.restored || evidence.error) {
      await restoreAllCanaryArtifacts().catch((error) => {
        evidence.fixtureRestoration = {
          restored: false,
          expectedState: "absent",
          error: redactText(error.message, apiKey),
        };
        evidence.error ??= {
          name: "CleanupError",
          message: "Canary artifact restoration failed.",
        };
      });
    }
    await client?.close().catch(() => undefined);
    if (startupOrder && openedVaultCli) {
      try {
        const closed = await runCli(openedVaultCli, [
          `vault=${EXPECTED_VAULT_NAME}`,
          "eval",
          "code=window.close();'closing...'",
        ]);
        evidence.startupOrder.closeCliExitCode = closed.exitCode;
        await waitForLocalRestClosed();
        evidence.startupOrder.closedOnExit = true;
      } catch (error) {
        evidence.startupOrder.closedOnExit = false;
        evidence.error ??= {
          name: "CleanupError",
          message: redactText(error.message, apiKey),
        };
      }
    }
    evidence.ok = Boolean(
      success &&
        fixtureRestored &&
        evidence.artifactRestoration.restored &&
        evidence.periodicRegistryRestoration.restored &&
        !evidence.error,
    );
    evidence.completedAt ??= new Date().toISOString();
    evidence.fixtureRestoration.restored = fixtureRestored;
    if (shutdownSignal) evidence.interruptedBy = shutdownSignal;
    if (backendStderr) {
      evidence.backendDiagnosticHash = shortHash(
        redactText(backendStderr, apiKey),
      );
    }
    let backupDeletedOnPass = false;
    if (evidence.ok) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
        backupDeletedOnPass = true;
      } catch (error) {
        evidence.ok = false;
        evidence.error = {
          name: "CleanupError",
          message: "Private canary backup could not be deleted after success.",
        };
      }
    }
    if (evidence.preMutationInventory) {
      evidence.preMutationInventory.backupDeletedOnPass = backupDeletedOnPass;
      evidence.preMutationInventory.backupRetainedOnFailure = !evidence.ok;
    }
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  const summary = {
    ok: evidence.ok,
    evidenceFile,
    fixtureRestored,
    periodicArtifactsRetained: evidence.ok ? 0 : null,
    ...(evidence.ok ? {} : { backupRetainedAt: tempRoot }),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!evidence.ok) process.exitCode = 1;
}

const inspectPendingMode = process.argv.includes("--inspect-pending-live");
const offlineContractMode = process.argv.includes(
  "--offline-startup-order-contract",
);
assert.equal(
  inspectPendingMode && offlineContractMode,
  false,
  "Select only one canary mode.",
);
const selectedMain = inspectPendingMode
  ? inspectPendingLive
  : offlineContractMode
    ? offlineStartupOrderContract
    : main;

selectedMain().catch((error) => {
  if (inspectPendingMode) {
    const apiKey = (process.env.OBSIDIAN_API_KEY ?? "").trim();
    console.error(
      JSON.stringify({
        count: null,
        recoveries: [],
        errorHash: shortHash(
          redactText(
            error instanceof Error ? error.message : String(error),
            apiKey,
          ),
        ),
      }),
    );
    process.exitCode = 1;
    return;
  }
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      note: offlineContractMode
        ? "The deterministic offline startup-order contract failed."
        : "The canary refused before its guarded live workflow started.",
    }),
  );
  process.exitCode = 1;
});
