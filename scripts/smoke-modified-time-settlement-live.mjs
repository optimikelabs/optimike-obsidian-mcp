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

const canaryPath = process.env.OBSIDIAN_MODIFIED_TIME_CANARY_PATH?.trim();
const confirmation = process.env.OBSIDIAN_MODIFIED_TIME_CANARY_CONFIRM?.trim();
const vaultName = process.env.OBSIDIAN_MODIFIED_TIME_CANARY_VAULT?.trim();
const propertyName =
  process.env.OBSIDIAN_MODIFIED_TIME_CANARY_PROPERTY?.trim() ?? "modification";
const pluginId =
  process.env.OBSIDIAN_MODIFIED_TIME_CANARY_PLUGIN_ID?.trim() ??
  "frontmatter-date-manager";
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const upstreamBaseUrl = (
  process.env.OBSIDIAN_BASE_URL?.trim() ?? "http://127.0.0.1:27123"
).replace(/\/+$/u, "");
const writeMode = process.env.MCP_WRITE_MODE?.trim() ?? "readonly";
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
if (!/^[\p{L}\p{N}_-]+$/u.test(propertyName)) {
  throw new Error("The modified-time property name is unsafe.");
}
if (!SUPPORTED_PLUGINS.has(pluginId)) {
  throw new Error("The modified-time plugin is not supported by this canary.");
}
if (!apiKey) throw new Error("OBSIDIAN_API_KEY is required.");
if (!new Set(["guarded", "full"]).has(writeMode)) {
  throw new Error("The live canary requires MCP_WRITE_MODE=guarded or full.");
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
  const prefix = `${propertyName}:`;
  const matches = content
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix));
  assert.equal(
    matches.length,
    1,
    `The canary note must contain exactly one top-level ${propertyName} property.`,
  );
  return matches[0].slice(prefix.length).trim();
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

async function atomicStatus() {
  return directRequest("/extensions/obsidian-atomic-write-bridge/status");
}

async function atomicRead() {
  return directRequest("/extensions/obsidian-atomic-write-bridge/notes/read", {
    method: "POST",
    payload: { contractVersion: 1, path: canaryPath },
  });
}

async function atomicReplace(expectedSha256, nextContent, bindingFingerprint) {
  return directRequest("/extensions/obsidian-atomic-write-bridge/notes/cas", {
    method: "POST",
    payload: {
      contractVersion: 1,
      path: canaryPath,
      bindingFingerprint,
      expectedSha256,
      nextContent,
    },
  });
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
      dropNextCasResponse = false;
      dropNextReconciliationRead = true;
      droppedCasResponses += 1;
      request.socket.destroy();
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
  (process.env.MCP_PROTECTED_FRONTMATTER_KEYS ?? "création,modification")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
);
protectedKeys.add(propertyName);
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
  return parse(await client.callTool({ name, arguments: args }));
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
  const result = await call("obsidian_note_replace_apply", {
    planRef: receipt.planRef,
    idempotencyKey,
  });
  assert.equal(result.outcome, "outcome_unknown");
  assert.equal(dropNextCasResponse, false);
  assert.equal(dropNextReconciliationRead, false);
  return result;
}

let originalContent;
let originalSha256;
let restored = false;
let backupWritten = false;
let originalPluginEnabled = false;
let pluginStateRestored = false;
let runId;
let evidenceFile;
let retainedLogsPath;
let backupMetadata;
try {
  originalPluginEnabled = pluginEnabled();
  assert.equal(
    originalPluginEnabled,
    true,
    `${pluginId} must be enabled before the canary starts.`,
  );
  const status = await atomicStatus();
  assert.equal(status.plugin.id, "obsidian-atomic-write-bridge");
  assert.equal(status.plugin.version, "0.2.0");
  assert.equal(status.backend.writeEnabled, true);
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

  const original = await atomicRead();
  originalContent = original.content;
  originalSha256 = original.sha256;
  assert.equal(originalSha256, sha256(originalContent));
  const originalPropertyValue = propertyValue(originalContent);
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
    recoveryInstruction:
      "Disable the configured modified-time plugin, then restore original-content.md only to the explicit canary note and verify SHA-256.",
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

  const positiveMarker = `<!-- modified-time-positive:${runId} -->`;
  const positiveTarget = `${originalContent}${
    originalContent.endsWith("\n") ? "" : "\n"
  }\n${positiveMarker}\n`;
  const positiveKey = `modified-time-live:${runId}:positive`;
  const positivePlan = await plan(positiveTarget, positiveKey);
  const positiveApply = await applyWithLostResponse(positivePlan, positiveKey);
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
    status.backend.bindingFingerprint,
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
    status.backend.bindingFingerprint,
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
    modifiedTimePluginId: pluginId,
    modifiedTimeProperty: propertyName,
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
  await client.close().catch(() => undefined);
  await new Promise((resolve) => proxy.close(resolve));
  if (originalContent !== undefined && !restored) {
    try {
      if (pluginEnabled()) {
        setPluginEnabled(false);
        pluginStateRestored = false;
      }
      const current = await atomicRead();
      const status = await atomicStatus();
      if (current.sha256 !== originalSha256) {
        await atomicReplace(
          current.sha256,
          originalContent,
          status.backend.bindingFingerprint,
        );
      }
      const finalRead = await atomicRead();
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
        const finalRead = await atomicRead();
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
