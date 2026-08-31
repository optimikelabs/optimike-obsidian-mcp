#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  modifiedTimeFrontmatterPropertyValue,
  nextRepresentableTimestampReadyAt,
  isSafeModifiedTimePropertyName,
} from "./modified-time-canary-helpers.mjs";

const CONFIRMATION = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED";
const canaryPath = process.env.OBSIDIAN_TEXT_PATCH_CANARY_PATH?.trim();
const confirmation = process.env.OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM?.trim();
const vaultName = process.env.OBSIDIAN_TEXT_PATCH_CANARY_VAULT?.trim();
const cliCommand = process.env.OBSIDIAN_CLI_COMMAND?.trim() ?? "obsidian";
const upstreamBaseUrl = (
  process.env.OBSIDIAN_BASE_URL?.trim() ?? "http://127.0.0.1:27123"
).replace(/\/+$/u, "");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function markdownBodyStart(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return 0;
  const match = /\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error("The canary note has unclosed Markdown frontmatter.");
  return match.index + match[0].length;
}

function validatePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.toLowerCase().endsWith(".md") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => !part || part === "." || part === "..") &&
    value.split("/")[0]?.toLowerCase() !== ".obsidian"
  );
}

function requireConfirmation(value) {
  if (value !== CONFIRMATION) {
    throw new Error(`Set OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM=${CONFIRMATION}.`);
  }
}

function validateExpectedCommit(value) {
  if (value !== undefined && !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("Candidate commit attestation must be a 40-character Git commit SHA.");
  }
}

function validateLiveGuards() {
  const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
  const expectedCommit = process.env.OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT
    ?.trim()
    .toLowerCase();
  const rawMode = process.env.MCP_WRITE_MODE?.trim() ?? "full";
  const writeMode = rawMode === "standard" ? "full" : rawMode;
  if (!validatePath(canaryPath)) {
    throw new Error(
      "OBSIDIAN_TEXT_PATCH_CANARY_PATH must be one explicit vault-relative existing .md note.",
    );
  }
  requireConfirmation(confirmation);
  if (!apiKey) throw new Error("OBSIDIAN_API_KEY is required for the live P4 canary.");
  if (!vaultName || /[&|<>\r\n]/u.test(vaultName)) {
    throw new Error("OBSIDIAN_TEXT_PATCH_CANARY_VAULT must name the open disposable vault.");
  }
  if (!new Set(["guarded", "full"]).has(writeMode)) {
    throw new Error("The live P4 canary requires MCP_WRITE_MODE=guarded or full.");
  }
  validateExpectedCommit(expectedCommit);
  if (
    expectedCommit === undefined &&
    process.env.OBSIDIAN_TEXT_PATCH_CANARY_ALLOW_UNATTESTED_COMMIT !== "true"
  ) {
    throw new Error(
      "OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT is required unless the explicit local diagnostic opt-out is enabled.",
    );
  }
  return { apiKey, expectedCommit, writeMode };
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function runObsidianCli(command, ...args) {
  try {
    return execFileSync(
      cliCommand,
      [`vault=${vaultName}`, command, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error(
      `Obsidian CLI ${command} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function pluginEnabled(pluginId) {
  return /enabled\s+true/iu.test(
    runObsidianCli("plugin", `id=${pluginId}`),
  );
}

function setPluginEnabled(pluginId, enabled) {
  runObsidianCli(
    enabled ? "plugin:enable" : "plugin:disable",
    `id=${pluginId}`,
  );
  assert.equal(pluginEnabled(pluginId), enabled);
}

function discoverModifiedIntegration(status, allowMissing = false) {
  const settlement = status?.settlement?.modifiedTimeFrontmatter?.integrations ?? [];
  const protections = status?.protection?.frontmatterDateProperties?.integrations ?? [];
  const unsupported = (status?.protection?.frontmatterDateProperties?.unsupportedIntegrations ?? [])
    .filter((item) => item?.activeRoles?.includes("modified"));
  if (unsupported.length > 0) {
    throw new Error("Unsupported active modified-time integration; refusing mutation.");
  }
  const modifiedProtections = protections.filter((item) => item?.modifiedPropertyName);
  if (settlement.length === 0 && modifiedProtections.length === 0 && allowMissing) return undefined;
  if (settlement.length !== 1 || modifiedProtections.length !== 1) {
    throw new Error("Exactly one supported active modified-time integration is required.");
  }
  const integration = settlement[0];
  const protection = modifiedProtections[0];
  const propertyName = String(integration.propertyName ?? "");
  if (!isSafeModifiedTimePropertyName(propertyName) ||
      integration.pluginId !== protection.pluginId ||
      propertyName.trim().toLowerCase() !== String(protection.modifiedPropertyName).trim().toLowerCase() ||
      !Number.isInteger(integration.settlementObservationDelayMs) ||
      integration.settlementObservationDelayMs < 0 ||
      integration.settlementObservationDelayMs > 4 * 60 * 1000) {
    throw new Error("The active modified-time integration is not a supported unambiguous settlement.");
  }
  return {
    pluginId: String(integration.pluginId),
    propertyName,
    utcOffsetMinutes: status?.settlement?.modifiedTimeFrontmatter?.utcOffsetMinutes,
  };
}

async function offlineContract() {
  assert.equal(validatePath("Fixture/Canary.md"), true);
  for (const bad of ["", "../Canary.md", "/Canary.md", ".obsidian/Canary.md", "Canary.txt", "Canary\\x.md"]) {
    assert.equal(validatePath(bad), false, `unsafe path accepted: ${bad}`);
  }
  const previous = process.env.OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM;
  process.env.OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM = CONFIRMATION;
  assert.doesNotThrow(() => requireConfirmation(process.env.OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM));
  assert.throws(() => requireConfirmation(""), /OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM/u);
  assert.doesNotThrow(() => validateExpectedCommit("a".repeat(40)));
  assert.throws(() => validateExpectedCommit("not-a-commit"), /40-character Git commit/u);
  assert.equal(isSafeModifiedTimePropertyName("last-modified.at"), true);
  assert.equal(isSafeModifiedTimePropertyName(" last-modified"), false);
  const dynamicStatus = {
    settlement: {
      modifiedTimeFrontmatter: {
        integrations: [{ pluginId: "fixture", propertyName: "last-modified.at", settlementObservationDelayMs: 250 }],
        utcOffsetMinutes: 0,
      },
    },
    protection: {
      frontmatterDateProperties: {
        integrations: [{ pluginId: "fixture", modifiedPropertyName: "last-modified.at" }],
        unsupportedIntegrations: [],
      },
    },
  };
  assert.deepEqual(discoverModifiedIntegration(dynamicStatus), {
    pluginId: "fixture",
    propertyName: "last-modified.at",
    utcOffsetMinutes: 0,
  });
  assert.throws(() => discoverModifiedIntegration({
    settlement: { modifiedTimeFrontmatter: { integrations: [
      { pluginId: "fixture-a", propertyName: "a", settlementObservationDelayMs: 0 },
      { pluginId: "fixture-b", propertyName: "b", settlementObservationDelayMs: 0 },
    ] } },
    protection: { frontmatterDateProperties: { integrations: [
      { pluginId: "fixture-a", modifiedPropertyName: "a" },
      { pluginId: "fixture-b", modifiedPropertyName: "b" },
    ] } },
  }), /Exactly one/u);
  assert.throws(() => discoverModifiedIntegration({
    protection: { frontmatterDateProperties: { unsupportedIntegrations: [{ pluginId: "fixture", activeRoles: ["modified"] }] } },
  }), /Unsupported active/u);
  assert.throws(() => discoverModifiedIntegration({ settlement: { modifiedTimeFrontmatter: { integrations: [] } }, protection: { frontmatterDateProperties: { integrations: [] } } }), /Exactly one/u);
  if (previous === undefined) delete process.env.OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM;
  else process.env.OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM = previous;
  console.log("PASS: offline-contract validated disposable-path, confirmation, dynamic-date, SHA, and fail-closed guards; no Obsidian was contacted.");
}

if (process.argv.includes("--offline-contract")) {
  await offlineContract();
  process.exit(0);
}

const { apiKey, expectedCommit, writeMode } = validateLiveGuards();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "optimike-text-patch-live-"));
const journalPath = path.join(tempRoot, "note-replace.sqlite");
const backupPath = path.join(tempRoot, "original-content.md");
const backupMetadataPath = path.join(tempRoot, "original-content.json");
const logsParent = path.join(process.cwd(), "logs", "governed-text-patch-live");
mkdirSync(logsParent, { recursive: true });
const logsPath = mkdtempSync(path.join(logsParent, "run-"));
const evidencePath = path.join(os.tmpdir(), `governed-text-patch-live-evidence-${randomUUID()}.json`);
console.error(`P4 canary recovery directory: ${tempRoot}`);
console.error(`P4 canary note path: ${canaryPath}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_WRITE_MODE: writeMode,
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
    LOGS_DIR: logsPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: apiKey,
    SEMANTIC_SEARCH_PREWARM: "false",
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "optimike-governed-text-patch-live-canary", version: "1.0.0" },
  { capabilities: {} },
);

function parse(result) {
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const payload = JSON.parse(text || "null");
  if (result.isError) throw new Error(payload?.error?.message ?? "MCP tool failed");
  return payload;
}
async function call(name, args, { cleanup = false } = {}) {
  if (!cleanup) assertCanaryActive();
  const result = parse(await client.callTool({ name, arguments: args }));
  if (!cleanup) assertCanaryActive();
  return result;
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
  if (!response.ok) {
    throw new Error(`Live Atomic Write request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function atomicRead() {
  const result = await directRequest(
    "/extensions/obsidian-atomic-write-bridge/notes/read",
    {
      method: "POST",
      payload: { contractVersion: 1, path: canaryPath },
    },
  );
  if (
    atomicBindingFingerprint !== undefined &&
    result.bindingFingerprint !== atomicBindingFingerprint
  ) {
    throw new Error("The Atomic Write backend binding changed during restoration.");
  }
  return result;
}
async function readNote(options = {}) {
  const result = await call(
    "obsidian_read_note",
    { filePath: canaryPath, format: "markdown", includeStat: false },
    options,
  );
  assert.equal(typeof result.content, "string");
  return result.content;
}
async function planApplyStatus(operations, key, settlement) {
  assertCanaryActive();
  const planned = await call("obsidian_text_patch_plan", { path: canaryPath, operations, idempotencyKey: key });
  assert.equal(planned.phase, "planned");
  mutationStarted = true;
  const applied = await call("obsidian_text_patch_apply", { planRef: planned.planRef, idempotencyKey: key });
  assert.equal(applied.outcome, "committed");
  const status = await call("obsidian_text_patch_status", { planRef: planned.planRef });
  assert.equal(status.outcome, "committed");
  assert.equal(Object.hasOwn(status, "idempotencyKey"), false);
  assert.equal(status.planDigest, applied.planDigest);
  if (settlement) {
    assert.equal(applied.afterProof?.details?.settlementPropertyName, settlement.propertyName);
    assert.equal(applied.afterProof?.details?.settlementPluginId, settlement.pluginId);
  }
  return { planned, applied, status };
}
async function restoreExact(original, key, options = {}) {
  void key;
  void options;
  const before = await atomicRead();
  if (before.content === original && before.sha256 === sha256(original)) return;
  if (
    settlementIntegration &&
    pluginEnabled(settlementIntegration.pluginId)
  ) {
    setPluginEnabled(settlementIntegration.pluginId, false);
    datePluginStateRestored = false;
  }
  mutationStarted = true;
  const applied = await directRequest(
    "/extensions/obsidian-atomic-write-bridge/notes/cas",
    {
      method: "POST",
      payload: {
        contractVersion: 1,
        path: canaryPath,
        bindingFingerprint: atomicBindingFingerprint,
        expectedSha256: before.sha256,
        nextContent: original,
      },
    },
  );
  assert.equal(applied.bindingFingerprint, atomicBindingFingerprint);
  assert.equal(applied.afterSha256, sha256(original));
  const after = await atomicRead();
  assert.equal(after.sha256, sha256(original));
  assert.equal(after.content, original);
}

let shuttingDown = false;
function onSignal(signal) {
  shuttingDown = true;
  console.error(`P4 canary received ${signal}; no further mutation will start.`);
}
const signalHandlers = {
  SIGINT: () => onSignal("SIGINT"),
  SIGTERM: () => onSignal("SIGTERM"),
};
process.on("SIGINT", signalHandlers.SIGINT);
process.on("SIGTERM", signalHandlers.SIGTERM);
function assertCanaryActive() {
  if (shuttingDown) throw new Error("Canary shutdown requested; refusing a new mutation.");
}

async function waitForRepresentableTick(currentValue, utcOffsetMinutes) {
  const readyAt = nextRepresentableTimestampReadyAt(currentValue, utcOffsetMinutes);
  const waitMs = Math.max(0, readyAt - Date.now());
  const maxWaitMs = Number(process.env.OBSIDIAN_TEXT_PATCH_CANARY_MAX_WAIT_MS ?? 90_000);
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || waitMs > maxWaitMs) {
    throw new Error(`Modified-time settlement tick is beyond the bounded wait (${Math.ceil(waitMs)}ms).`);
  }
  if (waitMs > 0) {
    console.error(`Waiting ${Math.ceil(waitMs)}ms for the dynamic modified-time property tick.`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  assertCanaryActive();
}
async function readAtomicStatus() {
  return directRequest("/extensions/obsidian-atomic-write-bridge/status");
}

let originalContent;
let restored = false;
let backupWritten = false;
let runId;
let evidence;
let mutationStarted = false;
let settlementIntegration;
let atomicBindingFingerprint;
let originalDatePluginEnabled = false;
let datePluginStateRestored = false;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of ["obsidian_text_patch_plan", "obsidian_text_patch_apply", "obsidian_text_patch_status", "obsidian_text_patch_recover"]) {
    assert.equal(names.has(name), true, `${name} is not registered`);
  }
  const atomicStatus = await readAtomicStatus();
  atomicBindingFingerprint = atomicStatus?.backend?.bindingFingerprint;
  assert.match(
    atomicBindingFingerprint ?? "",
    /^[a-f0-9]{64}$/u,
    "Atomic Write must expose one stable backend binding fingerprint",
  );
  const allowMissingSettlement = process.env.OBSIDIAN_TEXT_PATCH_CANARY_ALLOW_NO_SETTLEMENT === "true";
  const settlement = discoverModifiedIntegration(atomicStatus, allowMissingSettlement);
  settlementIntegration = settlement;
  if (!settlement) {
    console.error("SKIP settlement exercise: explicit local diagnostic opt-out is enabled and no supported modified-time integration is active.");
  } else {
    originalDatePluginEnabled = pluginEnabled(settlement.pluginId);
    assert.equal(
      originalDatePluginEnabled,
      true,
      "The settlement integration advertised by Atomic Write must be enabled in the open Pilot 2 vault.",
    );
    datePluginStateRestored = true;
  }

  originalContent = await readNote();
  const originalSha256 = sha256(originalContent);
  if (expectedCommit !== undefined) assert.equal(currentCommit(), expectedCommit, "candidate commit attestation mismatch");
  writeFileSync(backupPath, originalContent, { encoding: "utf8", mode: 0o600 });
  writeFileSync(backupMetadataPath, `${JSON.stringify({ canaryPathSha256: sha256(canaryPath), sha256: originalSha256 }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  backupWritten = true;
  runId = randomUUID();

  let modifiedBefore;
  if (settlement) {
    modifiedBefore = modifiedTimeFrontmatterPropertyValue(originalContent, settlement.propertyName);
    await waitForRepresentableTick(modifiedBefore, settlement.utcOffsetMinutes);
  }

  const appendMarker = `<!-- p4 append ${runId} -->\n`;
  const prependMarker = `<!-- p4 prepend ${runId} -->\n`;
  const replaceMarker = `p4-replaced-${runId}`;
  const append = await planApplyStatus([{ op: "append_body", text: appendMarker }], `p4:${runId}:append`, settlement);
  const afterAppend = await readNote();
  assert.equal(afterAppend.endsWith(appendMarker), true);
  if (settlement) {
    const modifiedAfter = modifiedTimeFrontmatterPropertyValue(afterAppend, settlement.propertyName);
    assert.notEqual(modifiedAfter, modifiedBefore, "configured modified-time property must settle to a new timestamp");
  }
  const prepend = await planApplyStatus([{ op: "prepend_body", text: prependMarker }], `p4:${runId}:prepend`);
  const afterPrepend = await readNote();
  assert.equal(
    afterPrepend.slice(markdownBodyStart(afterPrepend)).startsWith(prependMarker),
    true,
    "prepend_body must begin at the Markdown body boundary, after frontmatter",
  );
  const replaced = await planApplyStatus([{ op: "replace_literal", search: appendMarker.trim(), replacement: replaceMarker }], `p4:${runId}:replace`);
  assert.equal((await readNote()).includes(replaceMarker), true);

  const stalePlan = await call("obsidian_text_patch_plan", { path: canaryPath, operations: [{ op: "append_body", text: `stale-${runId}\n` }], idempotencyKey: `p4:${runId}:stale` });
  const winner = await planApplyStatus([{ op: "append_body", text: `winner-${runId}\n` }], `p4:${runId}:winner`);
  const stale = await call("obsidian_text_patch_apply", { planRef: stalePlan.planRef, idempotencyKey: `p4:${runId}:stale` });
  assert.equal(stale.outcome, "conflict");
  assert.equal((await readNote()).includes(`winner-${runId}`), true);

  const lostResponseStatus = "SKIPPED: no live Atomic Write response-loss injection is exposed by the stdio canary.";
  console.error(lostResponseStatus);
  await restoreExact(originalContent, `p4:${runId}:restore`);
  if (settlement) {
    setPluginEnabled(settlement.pluginId, true);
    datePluginStateRestored = true;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  restored = (await readNote()) === originalContent;
  assert.equal(restored, true, "restoration must be byte-exact");
  evidence = {
    ok: true,
    runId,
    pathSha256: sha256(canaryPath),
    originalSha256,
    finalSha256: sha256(await readNote()),
    restored,
    toolsVerified: 4,
    modifiedTimeIntegrationCount: settlement ? 1 : 0,
    modifiedTimePluginIds: settlement ? [settlement.pluginId] : [],
    datePluginStateRestored,
    appendOutcome: append.status.outcome,
    prependOutcome: prepend.status.outcome,
    replaceOutcome: replaced.status.outcome,
    staleOutcome: stale.outcome,
    winnerOutcome: winner.status.outcome,
    lostResponseStatus,
  };
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  assert.equal(evidenceText.includes(canaryPath), false, "evidence must not expose the raw canary path");
  assert.equal(evidenceText.includes(appendMarker), false);
  assert.equal(evidenceText.includes(prependMarker), false);
  assert.equal(evidenceText.includes(replaceMarker), false);
  writeFileSync(evidencePath, evidenceText, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
} finally {
  if (originalContent !== undefined && !restored) {
    try {
      if ((await atomicRead()).content !== originalContent) {
        await restoreExact(
          originalContent,
          `p4:${runId ?? randomUUID()}:emergency-restore`,
          { cleanup: true },
        );
      }
      restored = (await atomicRead()).content === originalContent;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, pathSha256: sha256(canaryPath), restored: false, backupPath, backupMetadataPath, recoveryRequired: backupWritten, error: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    }
  }
  if (
    originalDatePluginEnabled &&
    settlementIntegration &&
    !datePluginStateRestored
  ) {
    try {
      setPluginEnabled(settlementIntegration.pluginId, true);
      datePluginStateRestored = true;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (originalContent !== undefined) {
        restored =
          restored &&
          (await atomicRead()).content === originalContent;
      }
    } catch (error) {
      console.error(
        `Failed to restore the modified-time plugin state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      datePluginStateRestored = false;
      process.exitCode = 1;
    }
  }
  await client.close().catch(() => undefined);
  process.removeListener("SIGINT", signalHandlers.SIGINT);
  process.removeListener("SIGTERM", signalHandlers.SIGTERM);
  if (
    !mutationStarted ||
    (restored && (!originalDatePluginEnabled || datePluginStateRestored))
  ) {
    rmSync(logsPath, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`P4 recovery artifacts retained at ${tempRoot}; runtime logs retained at ${logsPath}; restore the explicitly supplied canary from ${backupPath}.`);
    process.exitCode = 1;
  }
}
