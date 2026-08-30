#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compileFrontmatterPatch } from "../dist/services/frontmatterPatchCompiler.js";
import { assertByteExactCanaryDateIsolation } from "./modified-time-canary-helpers.mjs";

const canaryPath = process.env.OBSIDIAN_FRONTMATTER_CANARY_PATH?.trim();
const confirmation = process.env.OBSIDIAN_FRONTMATTER_CANARY_CONFIRM?.trim();
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const writeMode = process.env.MCP_WRITE_MODE?.trim() ?? "readonly";
const CONFIRMATION = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED";
const CANARY_KEY = "_optimike_p1_canary";
const DELETE_KEY = "_optimike_p1_canary_delete";

if (!canaryPath) {
  throw new Error(
    "OBSIDIAN_FRONTMATTER_CANARY_PATH must name one explicit existing disposable Markdown note.",
  );
}
if (!canaryPath.toLowerCase().endsWith(".md")) {
  throw new Error("The P1 canary path must identify an existing .md note.");
}
if (confirmation !== CONFIRMATION) {
  throw new Error(`Set OBSIDIAN_FRONTMATTER_CANARY_CONFIRM=${CONFIRMATION}.`);
}
if (!apiKey) {
  throw new Error("OBSIDIAN_API_KEY is required for the live P1 canary.");
}
if (!new Set(["guarded", "full"]).has(writeMode)) {
  throw new Error(
    "The live P1 canary requires MCP_WRITE_MODE=guarded or full; readonly is refused.",
  );
}

const tempParent = os.tmpdir();
const tempRoot = mkdtempSync(
  path.join(tempParent, "optimike-governed-frontmatter-live-"),
);
const journalPath = path.join(tempRoot, "note-replace.sqlite");
// Runtime logging is intentionally constrained to the project boundary. The
// private backup and journal remain in the OS temporary directory; runtime
// logs are staged under the gitignored logs/ tree and moved beside those
// recovery artifacts only when manual recovery is required.
const transientLogsParent = path.join(
  process.cwd(),
  "logs",
  "governed-frontmatter-live",
);
mkdirSync(transientLogsParent, { recursive: true });
const logsPath = mkdtempSync(path.join(transientLogsParent, "run-"));
const backupPath = path.join(tempRoot, "original-content.md");
const backupMetadataPath = path.join(tempRoot, "original-content.json");
console.error(`P1 canary recovery directory: ${tempRoot}`);

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
  { name: "optimike-governed-frontmatter-live-canary", version: "1.0.0" },
  { capabilities: {} },
);

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function parse(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const payload = JSON.parse(text || "null");
  if (result.isError) {
    const error = new Error(
      payload?.error?.message ?? `MCP tool failed: ${JSON.stringify(payload)}`,
    );
    error.publicCode = payload?.error?.code;
    error.publicReasonCode = payload?.error?.details?.reasonCode;
    error.requestId = payload?.requestId ?? payload?.error?.details?.requestId;
    throw error;
  }
  return payload;
}

async function call(name, args) {
  return parse(await client.callTool({ name, arguments: args }));
}

async function readNote() {
  const result = await call("obsidian_read_note", {
    filePath: canaryPath,
    format: "markdown",
    includeStat: false,
  });
  assert.equal(typeof result.content, "string");
  return result.content;
}

async function assertDateIsolation() {
  const [{ ObsidianRestApiService }, { requestContextService }] =
    await Promise.all([
      import("../dist/services/obsidianRestAPI/index.js"),
      import("../dist/utils/index.js"),
    ]);
  const rest = new ObsidianRestApiService();
  const context = requestContextService.createRequestContext({
    operation: "GovernedFrontmatterLiveCanaryDateIsolation",
    target: canaryPath,
  });
  const status = await rest.getAtomicWriteStatus(context);
  assertByteExactCanaryDateIsolation(
    status,
    "byte-exact governed-frontmatter canary",
  );
}

async function planApplyStatus(operations, key) {
  const planned = await call("obsidian_frontmatter_patch_plan", {
    path: canaryPath,
    operations,
    idempotencyKey: key,
  });
  assert.equal(planned.phase, "planned");
  assert.equal(planned.operationKind, "obsidian.frontmatter.patch");
  const applied = await call("obsidian_frontmatter_patch_apply", {
    planRef: planned.planRef,
    idempotencyKey: key,
  });
  assert.equal(applied.outcome, "committed");
  const status = await call("obsidian_frontmatter_patch_status", {
    planRef: planned.planRef,
  });
  assert.equal(status.outcome, "committed");
  assert.equal(Object.hasOwn(status, "idempotencyKey"), false);
  assert.equal(status.planDigest, applied.planDigest);
  return { planned, applied, status };
}

async function restoreWholeNote(originalContent, key) {
  let cleanupStage = "plan";
  try {
    const planned = await call("obsidian_note_replace_plan", {
      path: canaryPath,
      nextContent: originalContent,
      idempotencyKey: key,
    });
    cleanupStage = "apply";
    const applied = await call("obsidian_note_replace_apply", {
      planRef: planned.planRef,
      idempotencyKey: key,
    });
    assert.equal(applied.outcome, "committed");
    return applied;
  } catch (error) {
    if (error && typeof error === "object") error.cleanupStage = cleanupStage;
    throw error;
  }
}

let originalContent;
let restored = false;
let backupWritten = false;
let evidenceFile;
let runId;
let retainedLogsPath;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "obsidian_frontmatter_patch_plan",
    "obsidian_frontmatter_patch_apply",
    "obsidian_frontmatter_patch_status",
    "obsidian_frontmatter_patch_recover",
    "obsidian_note_replace_plan",
    "obsidian_note_replace_apply",
  ]) {
    assert.equal(names.has(name), true, `${name} is not registered`);
  }

  // This canary promises byte-exact restoration. Modified-time integrations
  // have their own destructive canary, including the legitimate 0 -> 1
  // property-insertion path, and must be disabled before this first mutation.
  await assertDateIsolation();

  originalContent = await readNote();
  // Parsing the candidate before backup/mutation also verifies that the source
  // belongs to the supported P1 subset and that reserved keys are absent.
  const initialProbe = compileFrontmatterPatch(originalContent, [
    { op: "set", key: CANARY_KEY, value: "probe" },
    { op: "set", key: DELETE_KEY, value: true },
  ]);
  assert.equal(initialProbe.nextContent.includes(`${CANARY_KEY}:`), true);
  if (
    originalContent.match(new RegExp(`^(?:${CANARY_KEY}|${DELETE_KEY}):`, "mu"))
  ) {
    throw new Error(
      `The disposable note already contains ${CANARY_KEY} or ${DELETE_KEY}.`,
    );
  }

  runId = randomUUID();
  writeFileSync(backupPath, originalContent, { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    backupMetadataPath,
    `${JSON.stringify(
      {
        canaryPath,
        createdAt: new Date().toISOString(),
        originalSha256: sha256(originalContent),
        backupPath,
        recoveryInstruction:
          "If the canary stops before verified restoration, restore original-content.md only to the explicit disposable canary note.",
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  backupWritten = true;

  const addOperations = [
    { op: "set", key: CANARY_KEY, value: `add:${runId}` },
    { op: "set", key: DELETE_KEY, value: true },
  ];
  const expectedAdded = compileFrontmatterPatch(
    originalContent,
    addOperations,
  ).nextContent;
  const added = await planApplyStatus(addOperations, `p1-live:${runId}:add`);
  assert.equal(await readNote(), expectedAdded);

  const updateOperations = [
    { op: "set", key: CANARY_KEY, value: `set:${runId}` },
    { op: "delete", key: DELETE_KEY },
  ];
  const expectedUpdated = compileFrontmatterPatch(
    expectedAdded,
    updateOperations,
  ).nextContent;
  const updated = await planApplyStatus(
    updateOperations,
    `p1-live:${runId}:update`,
  );
  assert.equal(await readNote(), expectedUpdated);
  const replay = await call("obsidian_frontmatter_patch_apply", {
    planRef: updated.planned.planRef,
    idempotencyKey: `p1-live:${runId}:update`,
  });
  assert.equal(replay.outcome, "committed");
  assert.equal(await readNote(), expectedUpdated);

  const stalePlan = await call("obsidian_frontmatter_patch_plan", {
    path: canaryPath,
    operations: [{ op: "set", key: CANARY_KEY, value: `stale:${runId}` }],
    idempotencyKey: `p1-live:${runId}:stale`,
  });
  const winnerOperations = [
    { op: "set", key: CANARY_KEY, value: `winner:${runId}` },
  ];
  const expectedWinner = compileFrontmatterPatch(
    expectedUpdated,
    winnerOperations,
  ).nextContent;
  const winner = await planApplyStatus(
    winnerOperations,
    `p1-live:${runId}:winner`,
  );
  assert.equal(await readNote(), expectedWinner);
  const stale = await call("obsidian_frontmatter_patch_apply", {
    planRef: stalePlan.planRef,
    idempotencyKey: `p1-live:${runId}:stale`,
  });
  assert.equal(stale.outcome, "conflict");
  assert.equal(await readNote(), expectedWinner);

  const restoredByP1 = await planApplyStatus(
    [{ op: "delete", key: CANARY_KEY }],
    `p1-live:${runId}:restore`,
  );
  assert.equal(await readNote(), originalContent);
  restored = true;

  const evidence = {
    ok: true,
    runId,
    completedAt: new Date().toISOString(),
    canaryPath,
    toolsVerified: 4,
    addedOutcome: added.status.outcome,
    updatedOutcome: updated.status.outcome,
    replayOutcome: replay.outcome,
    winnerOutcome: winner.status.outcome,
    staleOutcome: stale.outcome,
    restoreOutcome: restoredByP1.status.outcome,
    originalSha256: sha256(originalContent),
    addedSha256: sha256(expectedAdded),
    updatedSha256: sha256(expectedUpdated),
    winnerSha256: sha256(expectedWinner),
    finalSha256: sha256(await readNote()),
    restored,
  };
  evidenceFile = path.join(
    tempParent,
    `governed-frontmatter-live-evidence-${runId}.json`,
  );
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...evidence, evidenceFile }, null, 2));
} finally {
  if (originalContent !== undefined && !restored) {
    try {
      const current = await readNote();
      if (current !== originalContent) {
        await restoreWholeNote(
          originalContent,
          `p1-live:${randomUUID()}:emergency-restore`,
        );
      }
      restored = (await readNote()) === originalContent;
    } catch (restoreError) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            canaryPath,
            restored: false,
            recoveryDirectory: tempRoot,
            backupPath,
            backupMetadataPath,
            recoveryRequired: true,
            error:
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError),
            cleanupStage:
              restoreError && typeof restoreError === "object"
                ? restoreError.cleanupStage
                : undefined,
            publicCode:
              restoreError && typeof restoreError === "object"
                ? restoreError.publicCode
                : undefined,
            publicReasonCode:
              restoreError && typeof restoreError === "object"
                ? restoreError.publicReasonCode
                : undefined,
            requestId:
              restoreError && typeof restoreError === "object"
                ? restoreError.requestId
                : undefined,
          },
          null,
          2,
        ),
      );
    }
  }
  await client.close().catch(() => undefined);
  if (restored) {
    rmSync(logsPath, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
    if (evidenceFile)
      console.error(`P1 canary evidence written to ${evidenceFile}`);
  } else if (backupWritten) {
    retainedLogsPath = path.join(tempRoot, "runtime-logs");
    try {
      renameSync(logsPath, retainedLogsPath);
    } catch {
      retainedLogsPath = logsPath;
    }
    console.error(
      `P1 canary recovery evidence retained at ${tempRoot}; runtime logs retained at ${retainedLogsPath}; restore only the explicit canary note from ${backupPath}.`,
    );
  } else {
    rmSync(logsPath, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
    console.error(
      "P1 canary failed before the first mutation; no note recovery is required.",
    );
  }
}
