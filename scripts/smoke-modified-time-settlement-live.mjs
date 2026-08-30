#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  isSafeModifiedTimePropertyName,
  modifiedTimeFrontmatterPropertyValue,
  nextRepresentableTimestampReadyAt,
  optionalModifiedTimeFrontmatterPropertyValue,
  supportsModifiedTimeSettlementBridgeVersion,
} from "./modified-time-canary-helpers.mjs";

const canaryPath = process.env.OBSIDIAN_MODIFIED_TIME_CANARY_PATH?.trim();
const confirmation = process.env.OBSIDIAN_MODIFIED_TIME_CANARY_CONFIRM?.trim();
const vaultName = process.env.OBSIDIAN_MODIFIED_TIME_CANARY_VAULT?.trim();
const propertyName =
  process.env.OBSIDIAN_MODIFIED_TIME_CANARY_PROPERTY ?? "modification";
const pluginId =
  process.env.OBSIDIAN_MODIFIED_TIME_CANARY_PLUGIN_ID?.trim() ??
  "frontmatter-date-manager";
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const upstreamBaseUrl = (
  process.env.OBSIDIAN_BASE_URL?.trim() ?? "http://127.0.0.1:27123"
).replace(/\/+$/u, "");
const writeMode = process.env.MCP_WRITE_MODE?.trim() ?? "readonly";
const selfSignal =
  process.env.OBSIDIAN_MODIFIED_TIME_CANARY_SELF_SIGNAL?.trim() ?? "";
const cliCommand = process.env.OBSIDIAN_CLI_COMMAND?.trim() ?? "obsidian";
const CONFIRMATION =
  "I_UNDERSTAND_THIS_DISPOSABLE_NOTE_WILL_BE_MUTATED_AND_RESTORED";
const SUPPORTED_PLUGINS = new Set([
  "frontmatter-date-manager",
  "update-time",
  "update-time-on-edit",
]);

if (!canaryPath?.toLowerCase().endsWith(".md")) {
  throw new Error(
    "OBSIDIAN_MODIFIED_TIME_CANARY_PATH must name one existing disposable Markdown note.",
  );
}
if (confirmation !== CONFIRMATION) {
  throw new Error(`Set OBSIDIAN_MODIFIED_TIME_CANARY_CONFIRM=${CONFIRMATION}.`);
}
if (!vaultName || /[&|<>\r\n]/u.test(vaultName)) {
  throw new Error(
    "OBSIDIAN_MODIFIED_TIME_CANARY_VAULT must name the open disposable vault.",
  );
}
if (!isSafeModifiedTimePropertyName(propertyName)) {
  throw new Error("The modified-time property name is unsafe.");
}
if (!SUPPORTED_PLUGINS.has(pluginId)) {
  throw new Error("The modified-time plugin is not supported by this canary.");
}
if (!apiKey) throw new Error("OBSIDIAN_API_KEY is required.");
if (!new Set(["guarded", "full"]).has(writeMode)) {
  throw new Error("The live canary requires MCP_WRITE_MODE=guarded or full.");
}
if (
  !new Set([
    "",
    "SIGTERM_AFTER_POSITIVE_APPLY",
    "SIGTERM_DURING_POSITIVE_APPLY",
  ]).has(selfSignal)
) {
  throw new Error(
    "OBSIDIAN_MODIFIED_TIME_CANARY_SELF_SIGNAL must be empty, SIGTERM_AFTER_POSITIVE_APPLY, or SIGTERM_DURING_POSITIVE_APPLY.",
  );
}

const tempParent = os.tmpdir();
const tempRoot = mkdtempSync(
  path.join(tempParent, "optimike-modified-time-live-"),
);
const journalPath = path.join(tempRoot, "note-replace.sqlite");
const backupPath = path.join(tempRoot, "original-content.md");
const backupMetadataPath = path.join(tempRoot, "original-content.json");
const transientLogsParent = path.join(
  process.cwd(),
  "logs",
  "modified-time-live",
);
mkdirSync(transientLogsParent, { recursive: true });
const logsPath = mkdtempSync(path.join(transientLogsParent, "run-"));
console.error(`Modified-time canary recovery directory: ${tempRoot}`);
console.error(`Modified-time canary transient runtime logs: ${logsPath}`);

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function propertyValue(content) {
  return modifiedTimeFrontmatterPropertyValue(content, propertyName);
}

async function waitForNextRepresentableTimestamp(
  currentValue,
  utcOffsetMinutes,
  timeoutMs = 75_000,
) {
  const deadline = Date.now() + timeoutMs;
  const readyAt = nextRepresentableTimestampReadyAt(
    currentValue,
    utcOffsetMinutes,
  );
  while (Date.now() < deadline) {
    if (Date.now() > readyAt) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for the next representable ${propertyName} timestamp tick.`,
  );
}

function runCli(command, ...args) {
  const result = spawnSync(
    cliCommand,
    [`vault=${vaultName}`, command, ...args],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Obsidian CLI ${command} failed: ${
        result.error?.message || result.stderr || result.stdout || result.status
      }`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function pluginEnabled() {
  return /enabled\s+true/iu.test(runCli("plugin", `id=${pluginId}`));
}

function setPluginEnabled(enabled) {
  runCli(enabled ? "plugin:enable" : "plugin:disable", `id=${pluginId}`);
  assert.equal(pluginEnabled(), enabled);
}

async function directRequest(route, { method = "GET", payload } = {}) {
  const response = await fetch(`${upstreamBaseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Live Bridge request failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text);
}

function assertMainFlowActive() {
  if (shutdownRequested) {
    throw new Error("The modified-time canary is shutting down.");
  }
}

async function atomicStatus({ cleanup = false } = {}) {
  if (!cleanup) assertMainFlowActive();
  const response = await directRequest(
    "/extensions/obsidian-atomic-write-bridge/status",
  );
  if (!cleanup) assertMainFlowActive();
  return response;
}

async function atomicRead({ cleanup = false } = {}) {
  if (!cleanup) assertMainFlowActive();
  const response = await directRequest(
    "/extensions/obsidian-atomic-write-bridge/notes/read",
    {
      method: "POST",
      payload: { contractVersion: 1, path: canaryPath },
    },
  );
  if (!cleanup) assertMainFlowActive();
  if (
    originalBindingFingerprint !== undefined &&
    response.bindingFingerprint !== originalBindingFingerprint
  ) {
    throw new Error(
      "The Atomic Write backend binding changed during the canary; refusing cross-vault recovery.",
    );
  }
  return response;
}

async function atomicReplace(
  expectedSha256,
  nextContent,
  bindingFingerprint,
  { cleanup = false } = {},
) {
  if (!cleanup) assertMainFlowActive();
  const response = await trackMutation(
    directRequest("/extensions/obsidian-atomic-write-bridge/notes/cas", {
      method: "POST",
      payload: {
        contractVersion: 1,
        path: canaryPath,
        bindingFingerprint,
        expectedSha256,
        nextContent,
      },
    }),
    { cleanup },
  );
  if (!cleanup) assertMainFlowActive();
  if (response.bindingFingerprint !== bindingFingerprint) {
    throw new Error(
      "The Atomic Write backend binding changed while applying a CAS.",
    );
  }
  return response;
}

async function waitForRead(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await atomicRead();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${label}; last SHA-256 was ${last?.sha256 ?? "unavailable"}.`,
  );
}

let dropNextCasResponse = false;
let dropNextReconciliationRead = false;
let droppedCasResponses = 0;
let droppedReconciliationReads = 0;
const proxy = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const target = new URL(request.url ?? "/", `${upstreamBaseUrl}/`);
    if (
      dropNextReconciliationRead &&
      target.pathname === "/extensions/obsidian-atomic-write-bridge/notes/read"
    ) {
      dropNextReconciliationRead = false;
      droppedReconciliationReads += 1;
      request.socket.destroy();
      return;
    }
    const headers = { ...request.headers };
    delete headers.host;
    delete headers["content-length"];
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(!new Set(["GET", "HEAD"]).has(request.method ?? "GET")
        ? { body }
        : {}),
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    if (
      dropNextCasResponse &&
      target.pathname === "/extensions/obsidian-atomic-write-bridge/notes/cas"
    ) {
      const signalDuringPositiveApply =
        selfSignal === "SIGTERM_DURING_POSITIVE_APPLY" &&
        droppedCasResponses === 0;
      dropNextCasResponse = false;
      dropNextReconciliationRead = true;
      droppedCasResponses += 1;
      request.socket.destroy();
      if (signalDuringPositiveApply) {
        process.emit("SIGTERM", "SIGTERM");
        process.emit("SIGTERM", "SIGTERM");
      }
      return;
    }
    response.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) response.setHeader("content-type", contentType);
    response.end(upstreamBody);
  } catch (error) {
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
    }
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(0, "127.0.0.1", resolve);
});
const proxyAddress = proxy.address();
assert.equal(typeof proxyAddress, "object");
const proxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}`;

const protectedKeys = new Set(
  (
    process.env.MCP_PROTECTED_FRONTMATTER_KEYS ??
    "canary-static-key-not-present"
  )
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_WRITE_MODE: writeMode,
    MCP_PROTECTED_FRONTMATTER_KEYS: [...protectedKeys].join(","),
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
    LOGS_DIR: logsPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: apiKey,
    OBSIDIAN_BASE_URL: proxyBaseUrl,
    SEMANTIC_SEARCH_PREWARM: "false",
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "optimike-modified-time-live-canary", version: "1.0.0" },
  { capabilities: {} },
);

function parse(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const payload = JSON.parse(text || "null");
  if (result.isError) {
    throw new Error(
      payload?.error?.message ?? `MCP tool failed: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function call(name, args) {
  assertMainFlowActive();
  const result = parse(await client.callTool({ name, arguments: args }));
  assertMainFlowActive();
  return result;
}

async function plan(nextContent, idempotencyKey) {
  const receipt = await call("obsidian_note_replace_plan", {
    path: canaryPath,
    nextContent,
    idempotencyKey,
  });
  assert.equal(receipt.phase, "planned");
  return receipt;
}

async function applyWithLostResponse(receipt, idempotencyKey) {
  dropNextCasResponse = true;
  const result = await trackMutation(
    call("obsidian_note_replace_apply", {
      planRef: receipt.planRef,
      idempotencyKey,
    }),
  );
  assert.equal(result.outcome, "outcome_unknown");
  assert.equal(dropNextCasResponse, false);
  assert.equal(dropNextReconciliationRead, false);
  return result;
}

async function applyWithResponse(receipt, idempotencyKey) {
  const result = await trackMutation(
    call("obsidian_note_replace_apply", {
      planRef: receipt.planRef,
      idempotencyKey,
    }),
  );
  assert.equal(result.outcome, "committed");
  return result;
}

let originalContent;
let originalSha256;
let originalBindingFingerprint;
let restored = false;
let backupWritten = false;
let originalPluginEnabled = false;
let pluginStateRestored = false;
let runId;
let evidenceFile;
let retainedLogsPath;
let backupMetadata;
let cleanupPromise;
let signalExitInProgress = false;
let shutdownRequested = false;
let activeMutationPromise;
let mutationQuiesced = true;

async function trackMutation(promise, { cleanup = false } = {}) {
  activeMutationPromise = promise;
  try {
    const result = await promise;
    if (!cleanup) assertMainFlowActive();
    return result;
  } finally {
    if (activeMutationPromise === promise) activeMutationPromise = undefined;
  }
}

async function quiesceActiveMutation(timeoutMs = 20_000) {
  const pending = activeMutationPromise;
  if (!pending) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const settled = () => {
      clearTimeout(timer);
      resolve(true);
    };
    pending.then(settled, settled);
  });
}

async function cleanup() {
  mutationQuiesced = await quiesceActiveMutation();
  await client.close().catch(() => undefined);
  await new Promise((resolve) => proxy.close(resolve));
  if (
    mutationQuiesced &&
    originalContent !== undefined &&
    originalBindingFingerprint !== undefined &&
    !restored
  ) {
    try {
      if (pluginEnabled()) {
        setPluginEnabled(false);
        pluginStateRestored = false;
      }
      const current = await atomicRead({ cleanup: true });
      const status = await atomicStatus({ cleanup: true });
      if (status.backend.bindingFingerprint !== originalBindingFingerprint) {
        throw new Error(
          "The Atomic Write backend binding changed during cleanup; refusing cross-vault recovery.",
        );
      }
      if (current.sha256 !== originalSha256) {
        await atomicReplace(
          current.sha256,
          originalContent,
          originalBindingFingerprint,
          { cleanup: true },
        );
      }
      const finalRead = await atomicRead({ cleanup: true });
      restored =
        finalRead.sha256 === originalSha256 &&
        finalRead.content === originalContent;
    } catch (restoreError) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            canaryPath,
            restored: false,
            evidenceDirectory: tempRoot,
            backupPath,
            backupMetadataPath,
            recoveryRequired: true,
            error:
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError),
          },
          null,
          2,
        ),
      );
    }
  }
  if (originalPluginEnabled && !pluginStateRestored) {
    try {
      if (!pluginEnabled()) setPluginEnabled(true);
      pluginStateRestored = true;
      if (restored && originalContent !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const finalRead = await atomicRead({ cleanup: true });
        restored =
          finalRead.sha256 === originalSha256 &&
          finalRead.content === originalContent;
      }
    } catch (pluginRestoreError) {
      console.error(
        `Failed to restore ${pluginId}: ${
          pluginRestoreError instanceof Error
            ? pluginRestoreError.message
            : String(pluginRestoreError)
        }`,
      );
    }
  }
  if (restored && pluginStateRestored) {
    rmSync(logsPath, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
    if (evidenceFile) {
      console.error(`Modified-time canary evidence written to ${evidenceFile}`);
    }
  } else if (backupWritten) {
    retainedLogsPath = path.join(tempRoot, "runtime-logs");
    try {
      renameSync(logsPath, retainedLogsPath);
    } catch {
      retainedLogsPath = logsPath;
    }
    backupMetadata.runtimeLogsPath = retainedLogsPath;
    backupMetadata.mutationQuiesced = mutationQuiesced;
    writeFileSync(
      backupMetadataPath,
      `${JSON.stringify(backupMetadata, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    console.error(
      `Modified-time canary recovery evidence retained at ${tempRoot}; restore only the explicit canary note from ${backupPath}.`,
    );
  } else {
    rmSync(logsPath, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
    console.error(
      "Modified-time canary failed before backup; no note recovery is required.",
    );
  }
}

function cleanupOnce() {
  cleanupPromise ??= cleanup();
  return cleanupPromise;
}

function handleSignal(signal) {
  if (signalExitInProgress) return;
  signalExitInProgress = true;
  shutdownRequested = true;
  const exitCode = signal === "SIGINT" ? 130 : 143;
  void cleanupOnce()
    .then(() => {
      console.error(
        JSON.stringify({
          ok: restored && pluginStateRestored,
          interruptedBy: signal,
          restored,
          pluginStateRestored,
          mutationQuiesced,
        }),
      );
    })
    .catch((error) => {
      console.error(
        `Modified-time canary cleanup failed after ${signal}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => process.exit(exitCode));
}

const handleSigint = () => handleSignal("SIGINT");
const handleSigterm = () => handleSignal("SIGTERM");
// Keep both listeners installed until cleanup completes so a repeated signal
// cannot fall through to Node's default termination and interrupt restoration.
process.on("SIGINT", handleSigint);
process.on("SIGTERM", handleSigterm);

try {
  originalPluginEnabled = pluginEnabled();
  assert.equal(
    originalPluginEnabled,
    true,
    `${pluginId} must be enabled before the canary starts.`,
  );
  const status = await atomicStatus();
  assert.equal(status.plugin.id, "obsidian-atomic-write-bridge");
  assert.equal(
    supportsModifiedTimeSettlementBridgeVersion(status.plugin.version),
    true,
    `Atomic Write Bridge ${status.plugin.version} does not support bounded modified-time settlement; version 0.3.0 or later is required.`,
  );
  assert.equal(status.backend.writeEnabled, true);
  assert.match(status.backend.bindingFingerprint, /^[a-f0-9]{64}$/u);
  originalBindingFingerprint = status.backend.bindingFingerprint;
  const integrations =
    status.settlement?.modifiedTimeFrontmatter?.integrations ?? [];
  assert.equal(
    integrations.some(
      (integration) =>
        integration.pluginId === pluginId &&
        integration.propertyName === propertyName,
    ),
    true,
    "The Bridge did not advertise the expected modified-time integration.",
  );
  const protectedIntegrations =
    status.protection?.frontmatterDateProperties?.integrations ?? [];
  assert.equal(
    protectedIntegrations.some(
      (integration) =>
        integration.pluginId === pluginId &&
        integration.modifiedPropertyName === propertyName,
    ),
    true,
    "The Bridge did not dynamically protect the expected modified-time property.",
  );
  assert.equal(
    protectedKeys.has(propertyName),
    false,
    "The canary must prove Bridge-derived protection without a duplicate static MCP key.",
  );

  const original = await atomicRead();
  originalContent = original.content;
  originalSha256 = original.sha256;
  assert.equal(originalSha256, sha256(originalContent));
  const originalPropertyValue = optionalModifiedTimeFrontmatterPropertyValue(
    originalContent,
    propertyName,
  );
  runId = randomUUID();
  writeFileSync(backupPath, originalContent, { encoding: "utf8", mode: 0o600 });
  backupMetadata = {
    canaryPath,
    vaultName,
    createdAt: new Date().toISOString(),
    sha256: originalSha256,
    backupPath,
    runtimeLogsPath: logsPath,
    modifiedTimePluginId: pluginId,
    backendBindingFingerprint: originalBindingFingerprint,
    recoveryInstruction:
      "Verify the recorded backend binding, disable the configured modified-time plugin, then restore original-content.md only to the explicit canary note and verify SHA-256.",
  };
  writeFileSync(
    backupMetadataPath,
    `${JSON.stringify(backupMetadata, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  backupWritten = true;

  await client.connect(transport);
  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "obsidian_note_replace_plan",
    "obsidian_note_replace_apply",
    "obsidian_note_replace_status",
    "obsidian_note_replace_recover",
  ]) {
    assert.equal(toolNames.has(name), true, `${name} is not registered`);
  }

  if (originalPropertyValue !== undefined) {
    await waitForNextRepresentableTimestamp(
      originalPropertyValue,
      status.settlement.modifiedTimeFrontmatter.utcOffsetMinutes,
    );
  }

  const positiveMarker = `<!-- modified-time-positive:${runId} -->`;
  const positiveTarget = `${originalContent}${
    originalContent.endsWith("\n") ? "" : "\n"
  }\n${positiveMarker}\n`;
  const positiveKey = `modified-time-live:${runId}:positive`;
  const positivePlan = await plan(positiveTarget, positiveKey);
  const positiveApply = await (selfSignal
    ? applyWithLostResponse(positivePlan, positiveKey)
    : applyWithResponse(positivePlan, positiveKey));
  if (selfSignal === "SIGTERM_AFTER_POSITIVE_APPLY") {
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGTERM", "SIGTERM");
    await new Promise(() => undefined);
  }
  const positiveObserved = await waitForRead(
    (read) =>
      read.content.includes(positiveMarker) &&
      propertyValue(read.content) !== originalPropertyValue,
    "the supported plugin to advance the modified-time property",
  );
  const positiveStatus = await call("obsidian_note_replace_status", {
    planRef: positivePlan.planRef,
  });
  assert.equal(positiveStatus.outcome, "committed");
  assert.equal(
    positiveStatus.afterProof.details.sealedSha256,
    sha256(positiveTarget),
  );
  assert.equal(
    positiveStatus.afterProof.details.sha256,
    positiveObserved.sha256,
  );
  assert.equal(
    positiveStatus.afterProof.details.settlementPropertyName,
    propertyName,
  );
  assert.equal(positiveStatus.afterProof.details.settlementPluginId, pluginId);

  // Frontmatter Date Manager deliberately ignores its own freshly written
  // timestamp for five seconds. Cross that real runtime window before the
  // negative case so it exercises another automatic timestamp update.
  await new Promise((resolve) => setTimeout(resolve, 6_200));
  await waitForNextRepresentableTimestamp(
    propertyValue(positiveObserved.content),
    status.settlement.modifiedTimeFrontmatter.utcOffsetMinutes,
  );
  const negativeMarker = `<!-- modified-time-negative:${runId} -->`;
  const negativeTarget = `${positiveObserved.content}${
    positiveObserved.content.endsWith("\n") ? "" : "\n"
  }\n${negativeMarker}\n`;
  const negativeKey = `modified-time-live:${runId}:negative`;
  const negativePlan = await plan(negativeTarget, negativeKey);
  const negativeApply = await applyWithLostResponse(negativePlan, negativeKey);
  const negativeSettled = await waitForRead(
    (read) =>
      read.content.includes(negativeMarker) &&
      propertyValue(read.content) !== propertyValue(positiveObserved.content),
    "the negative case modified-time settlement",
  );
  const driftMarker = `<!-- unauthorized-body-drift:${runId} -->`;
  const driftedContent = `${negativeSettled.content}${
    negativeSettled.content.endsWith("\n") ? "" : "\n"
  }\n${driftMarker}\n`;
  await atomicReplace(
    negativeSettled.sha256,
    driftedContent,
    originalBindingFingerprint,
  );
  const drifted = await waitForRead(
    (read) => read.content.includes(driftMarker),
    "the deliberate body drift",
  );
  const negativeStatus = await call("obsidian_note_replace_status", {
    planRef: negativePlan.planRef,
  });
  assert.equal(negativeStatus.outcome, "outcome_unknown");
  assert.equal(negativeStatus.afterProof, undefined);
  assert.equal(negativeStatus.recoveryAllowed, true);

  setPluginEnabled(false);
  const beforeRestore = await atomicRead();
  await atomicReplace(
    beforeRestore.sha256,
    originalContent,
    originalBindingFingerprint,
  );
  const restoredRead = await atomicRead();
  assert.equal(restoredRead.sha256, originalSha256);
  assert.equal(restoredRead.content, originalContent);
  setPluginEnabled(true);
  pluginStateRestored = true;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const finalRead = await atomicRead();
  assert.equal(finalRead.sha256, originalSha256);
  assert.equal(finalRead.content, originalContent);
  restored = true;

  const evidence = {
    ok: true,
    runId,
    completedAt: new Date().toISOString(),
    canaryPath,
    bridgeVersion: status.plugin.version,
    backendBindingFingerprint: originalBindingFingerprint,
    modifiedTimePluginId: pluginId,
    modifiedTimeProperty: propertyName,
    originalModifiedTimePropertyPresent: originalPropertyValue !== undefined,
    utcOffsetMinutes:
      status.settlement.modifiedTimeFrontmatter.utcOffsetMinutes,
    droppedCasResponses,
    droppedReconciliationReads,
    positiveApplyOutcome: positiveApply.outcome,
    positiveStatusOutcome: positiveStatus.outcome,
    positiveSealedSha256: sha256(positiveTarget),
    positiveObservedSha256: positiveObserved.sha256,
    negativeApplyOutcome: negativeApply.outcome,
    negativeStatusOutcome: negativeStatus.outcome,
    negativeObservedSha256: drifted.sha256,
    originalSha256,
    finalSha256: finalRead.sha256,
    restored,
    pluginStateRestored,
  };
  evidenceFile = path.join(
    tempParent,
    `modified-time-live-evidence-${runId}.json`,
  );
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...evidence, evidenceFile }, null, 2));
} finally {
  await cleanupOnce();
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}
