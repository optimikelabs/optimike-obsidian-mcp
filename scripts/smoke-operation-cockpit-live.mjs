#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED";
const canaryPath = process.env.OBSIDIAN_OPERATION_COCKPIT_CANARY_PATH?.trim();
const vaultName = process.env.OBSIDIAN_OPERATION_COCKPIT_CANARY_VAULT?.trim();
const confirmation =
  process.env.OBSIDIAN_OPERATION_COCKPIT_CANARY_CONFIRM?.trim();
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const expectedCommit =
  process.env.OBSIDIAN_OPERATION_COCKPIT_CANARY_EXPECTED_COMMIT?.trim().toLowerCase();
const cliCommand = process.env.OBSIDIAN_CLI_COMMAND?.trim() ?? "obsidian";
const baseUrl = (
  process.env.OBSIDIAN_BASE_URL?.trim() ?? "http://127.0.0.1:27123"
).replace(/\/+$/u, "");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validPath(value) {
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

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function assertCleanCandidate() {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true },
  );
  assert.equal(status, "", "exact-SHA canary requires a clean worktree");
}

function runObsidianCli(command, ...args) {
  try {
    return execFileSync(cliCommand, [`vault=${vaultName}`, command, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(
      `Obsidian CLI ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function pluginEnabled(pluginId) {
  return /enabled\s+true/iu.test(runObsidianCli("plugin", `id=${pluginId}`));
}

function setPluginEnabled(pluginId, enabled) {
  runObsidianCli(
    enabled ? "plugin:enable" : "plugin:disable",
    `id=${pluginId}`,
  );
  assert.equal(pluginEnabled(pluginId), enabled);
}

function discoverModifiedTimePlugin(status) {
  const unsupported =
    status?.protection?.frontmatterDateProperties?.unsupportedIntegrations ??
    [];
  if (unsupported.some((item) => item?.activeRoles?.includes("modified"))) {
    throw new Error(
      "Unsupported active modified-time integration; refusing the P5 mutation.",
    );
  }
  const settlements =
    status?.settlement?.modifiedTimeFrontmatter?.integrations ?? [];
  const protections = (
    status?.protection?.frontmatterDateProperties?.integrations ?? []
  ).filter((item) => item?.modifiedPropertyName);
  if (settlements.length === 0 && protections.length === 0) return undefined;
  if (settlements.length !== 1 || protections.length !== 1) {
    throw new Error(
      "The active modified-time integration is ambiguous; refusing the P5 mutation.",
    );
  }
  const settlement = settlements[0];
  const protection = protections[0];
  if (
    typeof settlement?.pluginId !== "string" ||
    settlement.pluginId !== protection?.pluginId ||
    String(settlement.propertyName ?? "")
      .trim()
      .toLowerCase() !==
      String(protection.modifiedPropertyName ?? "")
        .trim()
        .toLowerCase()
  ) {
    throw new Error(
      "The modified-time settlement role binding is invalid; refusing the P5 mutation.",
    );
  }
  return settlement.pluginId;
}

function resolveNamedVaultRoot() {
  assert.equal(
    runObsidianCli("vault", "info=name").trim(),
    vaultName,
    "Obsidian CLI did not resolve the explicitly named Pilot 2 vault",
  );
  const root = runObsidianCli("vault", "info=path").trim();
  if (!path.isAbsolute(root) || /[\r\n]/u.test(root)) {
    throw new Error("Obsidian CLI returned an invalid Pilot 2 vault path.");
  }
  return path.resolve(root);
}

function validateLiveGuards() {
  if (!validPath(canaryPath)) {
    throw new Error(
      "OBSIDIAN_OPERATION_COCKPIT_CANARY_PATH must be one explicit vault-relative existing disposable .md note.",
    );
  }
  if (!vaultName || /[&|<>\r\n]/u.test(vaultName)) {
    throw new Error(
      "OBSIDIAN_OPERATION_COCKPIT_CANARY_VAULT must name the open disposable vault.",
    );
  }
  if (!apiKey)
    throw new Error("OBSIDIAN_API_KEY is required for the live P5 canary.");
  if (confirmation !== CONFIRMATION) {
    throw new Error(
      `Set OBSIDIAN_OPERATION_COCKPIT_CANARY_CONFIRM=${CONFIRMATION}.`,
    );
  }
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? "")) {
    throw new Error(
      "OBSIDIAN_OPERATION_COCKPIT_CANARY_EXPECTED_COMMIT must be a 40-character Git commit SHA.",
    );
  }
  const rawWriteMode = process.env.MCP_WRITE_MODE?.trim() ?? "";
  if (!new Set(["guarded", "full"]).has(rawWriteMode)) {
    throw new Error(
      "The live P5 canary requires MCP_WRITE_MODE=guarded or full.",
    );
  }
  return rawWriteMode;
}

function assertRedactedCockpit(page) {
  const serialized = JSON.stringify(page);
  for (const forbidden of [
    canaryPath,
    apiKey,
    "bindingFingerprint",
    "sha256",
    "idempotencyKey",
    "nextContent",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `cockpit leaked ${forbidden}`,
    );
  }
}

let shuttingDown = false;
let mutationStarted = false;
function onSignal(signal) {
  shuttingDown = true;
  console.error(
    `P5 canary received ${signal}; no new governed mutation will start, but exact restoration remains enabled.`,
  );
}
const signalHandlers = {
  SIGINT: () => onSignal("SIGINT"),
  SIGTERM: () => onSignal("SIGTERM"),
};
function assertCanaryActive() {
  if (shuttingDown) {
    throw new Error("Canary shutdown requested; refusing a new mutation.");
  }
}

async function offlineContract() {
  assert.equal(validPath("Canary/Disposable.md"), true);
  for (const unsafe of [
    "",
    "../Canary.md",
    "/Canary.md",
    ".obsidian/Canary.md",
    "Canary.txt",
    "Canary\\x.md",
  ]) {
    assert.equal(validPath(unsafe), false, `unsafe path accepted: ${unsafe}`);
  }
  assert.match("a".repeat(40), /^[a-f0-9]{40}$/u);
  assert.throws(() => {
    if ("wrong" !== CONFIRMATION) throw new Error("confirmation required");
  }, /confirmation required/u);
  const publicRow = {
    operationKind: "obsidian.text.patch",
    planRef: "obsidian-text-patch:v1:fixture",
    state: "planned",
    admittedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ageSeconds: 1,
    nextAction: "apply",
  };
  assert.equal(publicRow.nextAction, "apply");
  assertRedactedCockpit({ operations: [publicRow] });
  const contractLogsParent = path.join(
    process.cwd(),
    "logs",
    "operation-cockpit-live",
  );
  assert.ok(
    path
      .resolve(contractLogsParent)
      .startsWith(`${path.resolve(process.cwd())}${path.sep}`),
    "runtime logs must stay inside the project boundary required by config",
  );
  shuttingDown = true;
  assert.throws(
    () => assertCanaryActive(),
    /shutdown requested/u,
    "a signal before the first mutation must close the mutation gate",
  );
  mutationStarted = true;
  assert.throws(
    () => assertCanaryActive(),
    /shutdown requested/u,
    "a signal after the first mutation must prevent a second mutation while leaving restoration available",
  );
  mutationStarted = false;
  shuttingDown = false;
  console.log(
    "PASS: P5 offline contract validates path, confirmation, exact-SHA, public pending row, and redaction assertions; no Obsidian was contacted.",
  );
}

if (process.argv.includes("--offline-contract")) {
  await offlineContract();
  process.exit(0);
}

const writeMode = validateLiveGuards();
assert.equal(
  currentCommit(),
  expectedCommit,
  "candidate commit attestation mismatch",
);
assertCleanCandidate();
const namedVaultRoot = resolveNamedVaultRoot();
const namedCanaryFile = path.resolve(namedVaultRoot, ...canaryPath.split("/"));
const namedVaultPrefix = `${namedVaultRoot}${path.sep}`.toLowerCase();
if (!namedCanaryFile.toLowerCase().startsWith(namedVaultPrefix)) {
  throw new Error("The Pilot 2 canary path escaped the named vault root.");
}

function readNamedVaultNote() {
  return readFileSync(namedCanaryFile, "utf8");
}
process.on("SIGINT", signalHandlers.SIGINT);
process.on("SIGTERM", signalHandlers.SIGTERM);

const privateRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-operation-cockpit-live-"),
);
const noteJournalPath = path.join(privateRoot, "note.sqlite");
const baseJournalPath = path.join(privateRoot, "base.sqlite");
const canvasJournalPath = path.join(privateRoot, "canvas.sqlite");
// Runtime config confines LOGS_DIR to the project boundary. Keep only redacted,
// transient logs under the gitignored logs/ tree; journals and recovery
// material remain outside the repository in the OS temporary directory.
const transientLogsParent = path.join(
  process.cwd(),
  "logs",
  "operation-cockpit-live",
);
mkdirSync(transientLogsParent, { recursive: true });
const logsPath = mkdtempSync(path.join(transientLogsParent, "run-"));
const backupPath = path.join(privateRoot, "original-content.md");
const metadataPath = path.join(privateRoot, "recovery.json");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_TOOL_PROFILE: "full",
    MCP_WRITE_MODE: writeMode,
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: noteJournalPath,
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: baseJournalPath,
    MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: canvasJournalPath,
    LOGS_DIR: logsPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: apiKey,
    SEMANTIC_SEARCH_PREWARM: "false",
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "optimike-operation-cockpit-live-canary", version: "1.0.0" },
  { capabilities: {} },
);

function parse(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const payload = JSON.parse(text || "null");
  if (result.isError)
    throw new Error(payload?.error?.message ?? "MCP tool failed");
  return payload;
}
async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }));
}
async function atomicRequest(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiKey}`, ...(options.headers ?? {}) },
  });
  if (!response.ok)
    throw new Error(
      `Atomic Write request failed with HTTP ${response.status}.`,
    );
  return response.json();
}
async function atomicRead(bindingFingerprint) {
  const value = await atomicRequest(
    "/extensions/obsidian-atomic-write-bridge/notes/read",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractVersion: 1, path: canaryPath }),
    },
  );
  assert.equal(
    value.bindingFingerprint,
    bindingFingerprint,
    "Atomic Write binding changed",
  );
  return value;
}
async function attestNamedVault(bindingFingerprint) {
  assert.equal(
    resolveNamedVaultRoot().toLowerCase(),
    namedVaultRoot.toLowerCase(),
    "The explicitly named Pilot 2 vault changed during the canary",
  );
  const atomic = await atomicRead(bindingFingerprint);
  assert.equal(
    readNamedVaultNote(),
    atomic.content,
    "The named Pilot 2 vault and the Atomic Write backend diverged",
  );
  return atomic;
}
async function readNote() {
  const value = await call("obsidian_read_note", {
    filePath: canaryPath,
    format: "markdown",
    includeStat: false,
  });
  assert.equal(typeof value.content, "string");
  return value.content;
}
async function listPending() {
  const value = await call("obsidian_list_pending_operations", { limit: 100 });
  assert.ok(Array.isArray(value.operations));
  assertRedactedCockpit(value);
  return value.operations;
}

async function planAndApply(operations, idempotencyKey) {
  assertCanaryActive();
  const plan = await call("obsidian_text_patch_plan", {
    path: canaryPath,
    operations,
    idempotencyKey,
  });
  assert.equal(plan.phase, "planned");
  const pending = await listPending();
  const row = pending.find((item) => item.planRef === plan.planRef);
  assert.deepEqual(
    row && {
      planRef: row.planRef,
      operationKind: row.operationKind,
      state: row.state,
      nextAction: row.nextAction,
    },
    {
      planRef: plan.planRef,
      operationKind: "obsidian.text.patch",
      state: "planned",
      nextAction: "apply",
    },
    "cockpit must expose only the actionable public projection",
  );
  await attestNamedVault(bindingFingerprint);
  assertCanaryActive();
  mutationStarted = true;
  const applied = await call("obsidian_text_patch_apply", {
    planRef: plan.planRef,
    idempotencyKey,
  });
  assert.equal(applied.outcome, "committed");
  const status = await call("obsidian_text_patch_status", {
    planRef: plan.planRef,
  });
  assert.equal(status.outcome, "committed");
  assert.equal(
    (await listPending()).some((item) => item.planRef === plan.planRef),
    false,
    "terminal plan must disappear from cockpit",
  );
  return { plan, applied, status };
}

async function restoreExactOriginal() {
  const before = await attestNamedVault(bindingFingerprint);
  if (before.content === originalContent && before.sha256 === originalSha256) {
    return;
  }
  if (
    modifiedTimePluginId &&
    originalModifiedTimePluginEnabled &&
    pluginEnabled(modifiedTimePluginId)
  ) {
    modifiedTimePluginRestored = false;
    setPluginEnabled(modifiedTimePluginId, false);
  }
  const applied = await atomicRequest(
    "/extensions/obsidian-atomic-write-bridge/notes/cas",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractVersion: 1,
        path: canaryPath,
        bindingFingerprint,
        expectedSha256: before.sha256,
        nextContent: originalContent,
      }),
    },
  );
  assert.equal(applied.bindingFingerprint, bindingFingerprint);
  assert.equal(applied.afterSha256, originalSha256);
  const after = await attestNamedVault(bindingFingerprint);
  assert.equal(after.content, originalContent);
  assert.equal(after.sha256, originalSha256);
}

async function reconcileModifiedTimePluginState() {
  if (!modifiedTimePluginId) {
    modifiedTimePluginRestored = true;
    return;
  }
  const before = pluginEnabled(modifiedTimePluginId);
  if (before !== originalModifiedTimePluginEnabled) {
    setPluginEnabled(modifiedTimePluginId, originalModifiedTimePluginEnabled);
  }
  modifiedTimePluginRestored =
    pluginEnabled(modifiedTimePluginId) === originalModifiedTimePluginEnabled;
  assert.equal(
    modifiedTimePluginRestored,
    true,
    "The modified-time plugin state was not restored",
  );
  if (before !== originalModifiedTimePluginEnabled) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

let originalContent;
let originalSha256;
let restored = false;
let backupWritten = false;
let bindingFingerprint;
let runId;
let appendText;
let modifiedTimePluginId;
let originalModifiedTimePluginEnabled = false;
let modifiedTimePluginRestored = true;
try {
  await client.connect(transport);
  const names = new Set(
    (await client.listTools()).tools.map((tool) => tool.name),
  );
  for (const name of [
    "obsidian_read_note",
    "obsidian_list_pending_operations",
    "obsidian_text_patch_plan",
    "obsidian_text_patch_apply",
    "obsidian_text_patch_status",
    "obsidian_text_patch_recover",
  ]) {
    assert.equal(names.has(name), true, `${name} is not registered`);
  }
  const atomicStatus = await atomicRequest(
    "/extensions/obsidian-atomic-write-bridge/status",
  );
  bindingFingerprint = atomicStatus?.backend?.bindingFingerprint;
  assert.match(
    bindingFingerprint ?? "",
    /^[a-f0-9]{64}$/u,
    "Atomic Write must expose a binding fingerprint",
  );
  modifiedTimePluginId = discoverModifiedTimePlugin(atomicStatus);
  if (modifiedTimePluginId) {
    originalModifiedTimePluginEnabled = pluginEnabled(modifiedTimePluginId);
    assert.equal(
      originalModifiedTimePluginEnabled,
      true,
      "The settlement integration advertised by Atomic Write must be enabled in the named Pilot 2 vault.",
    );
  }
  originalContent = await readNote();
  const atomicBefore = await attestNamedVault(bindingFingerprint);
  assert.equal(
    atomicBefore.content,
    originalContent,
    "MCP and Atomic Write disagree on initial content",
  );
  originalSha256 = sha256(originalContent);
  assert.equal(
    atomicBefore.sha256,
    originalSha256,
    "Atomic Write initial hash mismatch",
  );
  runId = randomUUID();
  writeFileSync(backupPath, originalContent, { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    metadataPath,
    `${JSON.stringify({ canaryPath, originalSha256, bindingFingerprint, noteJournalPath, baseJournalPath, canvasJournalPath }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  backupWritten = true;

  const marker = `<!-- p5-operation-cockpit:${runId} -->`;
  appendText = `${originalContent.endsWith("\n") ? "" : "\n"}${marker}\n`;
  const mutation = await planAndApply(
    [{ op: "append_body", text: appendText }],
    `p5:${runId}:append`,
  );
  assert.equal(
    (await readNote()).includes(marker),
    true,
    "governed append did not reach the canary note",
  );
  await restoreExactOriginal();
  await reconcileModifiedTimePluginState();
  const finalContent = await readNote();
  assert.equal(
    finalContent,
    originalContent,
    "governed restoration must be byte-exact",
  );
  const atomicAfter = await attestNamedVault(bindingFingerprint);
  assert.equal(
    atomicAfter.sha256,
    originalSha256,
    "final Atomic Write hash must equal initial hash",
  );
  assert.equal(
    atomicAfter.content,
    originalContent,
    "final Atomic Write content must equal initial content",
  );
  restored = true;
  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        candidateCommit: expectedCommit,
        originalSha256,
        finalSha256: atomicAfter.sha256,
        restored,
        bindingFingerprintAttested: true,
        appendOutcome: mutation.status.outcome,
        restoreOutcome: "atomic-cas",
        modifiedTimePluginRestored,
        journalsTemporary: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (
    originalContent !== undefined &&
    backupWritten &&
    !restored &&
    mutationStarted
  ) {
    try {
      await restoreExactOriginal();
      await reconcileModifiedTimePluginState();
      const atomicAfter = await attestNamedVault(bindingFingerprint);
      restored =
        atomicAfter.content === originalContent &&
        atomicAfter.sha256 === originalSha256 &&
        modifiedTimePluginRestored;
    } catch (error) {
      console.error(
        `P5 exact emergency restoration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (modifiedTimePluginId) {
    try {
      await reconcileModifiedTimePluginState();
      if (originalContent !== undefined) {
        const atomicAfter = await attestNamedVault(bindingFingerprint);
        restored =
          restored &&
          atomicAfter.content === originalContent &&
          atomicAfter.sha256 === originalSha256;
      }
    } catch (error) {
      console.error(
        `P5 modified-time plugin restoration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      modifiedTimePluginRestored = false;
    }
  }
  await client.close().catch(() => undefined);
  process.removeListener("SIGINT", signalHandlers.SIGINT);
  process.removeListener("SIGTERM", signalHandlers.SIGTERM);
  if (!mutationStarted || (restored && modifiedTimePluginRestored)) {
    rmSync(logsPath, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
  } else if (backupWritten) {
    console.error(
      `P5 recovery required; retain and use only this private recovery directory: ${privateRoot}; redacted runtime logs retained separately at ${logsPath}`,
    );
    process.exitCode = 1;
  } else {
    rmSync(logsPath, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
    console.error(
      "P5 canary failed before a governed mutation; no note recovery is required.",
    );
  }
}
