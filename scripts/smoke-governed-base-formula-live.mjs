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
import https from "node:https";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compileBaseFormulaPatch } from "../dist/services/baseConfigPatchCompiler.js";

const canaryPath = process.env.OBSIDIAN_BASE_FORMULA_CANARY_PATH?.trim();
const confirmation = process.env.OBSIDIAN_BASE_FORMULA_CANARY_CONFIRM?.trim();
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const baseUrl = (
  process.env.OBSIDIAN_BASE_URL ?? "https://127.0.0.1:27124"
).replace(/\/+$/u, "");
const writeMode = process.env.MCP_WRITE_MODE?.trim() ?? "readonly";
const CONFIRMATION =
  "I_UNDERSTAND_THIS_DISPOSABLE_BASE_WILL_BE_TEMPORARILY_PATCHED";
const FORMULA = "_optimike_p2_canary";

if (!canaryPath?.toLowerCase().endsWith(".base")) {
  throw new Error(
    "OBSIDIAN_BASE_FORMULA_CANARY_PATH must name one existing disposable .base file.",
  );
}
if (confirmation !== CONFIRMATION) {
  throw new Error(`Set OBSIDIAN_BASE_FORMULA_CANARY_CONFIRM=${CONFIRMATION}.`);
}
if (!apiKey)
  throw new Error("OBSIDIAN_API_KEY is required for the live P2 canary.");
if (!new Set(["guarded", "full"]).has(writeMode)) {
  throw new Error(
    "The live P2 canary requires MCP_WRITE_MODE=guarded or full.",
  );
}

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const privateRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-governed-base-live-"),
);
const journalPath = path.join(privateRoot, "base-formula.sqlite");
const backupPath = path.join(privateRoot, "original.base");
const metadataPath = path.join(privateRoot, "original.json");
const transientLogsParent = path.join(
  process.cwd(),
  "logs",
  "governed-base-live",
);
mkdirSync(transientLogsParent, { recursive: true });
const logsPath = mkdtempSync(path.join(transientLogsParent, "run-"));
console.error(`P2 Base canary recovery directory: ${privateRoot}`);

const http = axios.create({
  baseURL: baseUrl,
  headers: { Authorization: `Bearer ${apiKey}` },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 15_000,
});

async function bridgeStatus() {
  return (await http.get("/extensions/obsidian-bases-bridge/atomic/status"))
    .data;
}

async function bridgeRead() {
  return (
    await http.post("/extensions/obsidian-bases-bridge/atomic/bases/read", {
      contractVersion: 1,
      path: canaryPath,
    })
  ).data;
}

async function bridgeCas(current, nextYaml) {
  return (
    await http.post("/extensions/obsidian-bases-bridge/atomic/bases/cas", {
      contractVersion: 1,
      path: canaryPath,
      bindingFingerprint: current.bindingFingerprint,
      expectedSha256: current.sha256,
      nextYaml,
    })
  ).data;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_WRITE_MODE: writeMode,
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: journalPath,
    LOGS_DIR: logsPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: apiKey,
    OBSIDIAN_BASE_URL: baseUrl,
    SEMANTIC_SEARCH_PREWARM: "false",
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "optimike-governed-base-live-canary", version: "1.0.0" },
  { capabilities: {} },
);

function parse(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return {
    payload: JSON.parse(text || "null"),
    isError: Boolean(result.isError),
  };
}

async function call(name, arguments_) {
  return parse(await client.callTool({ name, arguments: arguments_ }));
}

async function committedPlan(operations, idempotencyKey) {
  const planned = await call("bases_formula_patch_plan", {
    path: canaryPath,
    operations,
    idempotencyKey,
  });
  assert.equal(planned.isError, false);
  assert.equal(planned.payload.phase, "planned");
  const applied = await call("bases_formula_patch_apply", {
    planRef: planned.payload.planRef,
    idempotencyKey,
  });
  assert.equal(applied.isError, false);
  assert.equal(applied.payload.outcome, "committed");
  const status = await call("bases_formula_patch_status", {
    planRef: planned.payload.planRef,
  });
  assert.equal(status.isError, false);
  assert.equal(status.payload.outcome, "committed");
  assert.equal(Object.hasOwn(status.payload, "idempotencyKey"), false);
  return {
    planned: planned.payload,
    applied: applied.payload,
    status: status.payload,
  };
}

let original;
let backupWritten = false;
let restored = false;
let retainedLogsPath;
try {
  const status = await bridgeStatus();
  assert.equal(status.contractVersion, 1);
  assert.equal(status.backend.kind, "obsidian-vault-process-base");
  assert.equal(
    status.backend.writeEnabled,
    true,
    "Enable Allow atomic Base CAS in the pilot vault.",
  );
  assert.equal(
    status.migration.legacyConfigWritesEnabled,
    false,
    "Keep legacy config writes disabled during the P2 pilot.",
  );

  original = await bridgeRead();
  assert.equal(original.path, canaryPath);
  assert.equal(original.sha256, sha256(original.yaml));
  compileBaseFormulaPatch(original.yaml, [
    { op: "set_formula", name: FORMULA, expression: "probe" },
  ]);
  if (new RegExp(`^  ${FORMULA}:`, "mu").test(original.yaml)) {
    throw new Error(`The disposable Base already contains ${FORMULA}.`);
  }
  writeFileSync(backupPath, original.yaml, { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        canaryPath,
        createdAt: new Date().toISOString(),
        originalSha256: original.sha256,
        bindingFingerprint: original.bindingFingerprint,
        recoveryInstruction:
          "Restore original.base only to the explicit disposable P2 canary Base, then verify SHA-256.",
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  backupWritten = true;

  await client.connect(transport);
  const names = new Set(
    (await client.listTools()).tools.map((tool) => tool.name),
  );
  for (const name of [
    "bases_formula_patch_plan",
    "bases_formula_patch_apply",
    "bases_formula_patch_status",
    "bases_formula_patch_recover",
  ]) {
    assert.equal(names.has(name), true, `${name} is not registered`);
  }

  const runId = randomUUID();
  const add = await committedPlan(
    [{ op: "set_formula", name: FORMULA, expression: `canary:${runId}` }],
    `p2-live-add:${runId}`,
  );
  const replay = await call("bases_formula_patch_plan", {
    path: canaryPath,
    operations: [
      { op: "set_formula", name: FORMULA, expression: `canary:${runId}` },
    ],
    idempotencyKey: `p2-live-add:${runId}`,
  });
  assert.equal(replay.isError, false);
  assert.equal(replay.payload.planRef, add.planned.planRef);
  assert.match((await bridgeRead()).yaml, new RegExp(`^  ${FORMULA}:`, "mu"));

  await committedPlan(
    [{ op: "delete_formula", name: FORMULA }],
    `p2-live-delete:${runId}`,
  );
  const afterDelete = await bridgeRead();
  assert.equal(
    afterDelete.sha256,
    original.sha256,
    "add then delete must restore the exact fixture bytes",
  );

  const stale = await call("bases_formula_patch_plan", {
    path: canaryPath,
    operations: [
      { op: "set_formula", name: FORMULA, expression: `sealed:${runId}` },
    ],
    idempotencyKey: `p2-live-stale:${runId}`,
  });
  assert.equal(stale.isError, false);
  const externalYaml = compileBaseFormulaPatch(afterDelete.yaml, [
    { op: "set_formula", name: FORMULA, expression: `external:${runId}` },
  ]).nextYaml;
  await bridgeCas(afterDelete, externalYaml);
  const rejected = await call("bases_formula_patch_apply", {
    planRef: stale.payload.planRef,
    idempotencyKey: `p2-live-stale:${runId}`,
  });
  assert.equal(rejected.isError, false);
  assert.equal(rejected.payload.outcome, "conflict");

  const changed = await bridgeRead();
  await bridgeCas(changed, original.yaml);
  const final = await bridgeRead();
  assert.equal(final.sha256, original.sha256);
  assert.equal(final.yaml, original.yaml);
  restored = true;

  const evidenceFile = path.join(
    os.tmpdir(),
    `optimike-governed-base-p2-${runId}.json`,
  );
  writeFileSync(
    evidenceFile,
    `${JSON.stringify(
      {
        ok: true,
        contractVersion: 1,
        canaryPath,
        originalSha256: original.sha256,
        finalSha256: final.sha256,
        bridgeVersion: status.plugin.version,
        mcpVersion: process.env.MCP_SERVER_VERSION ?? "2.8.3",
        checks: [
          "typed_base_binding",
          "plan_without_write",
          "apply",
          "status",
          "idempotent_replay",
          "source_exact_add_delete",
          "stale_plan_conflict",
          "exact_restoration",
        ],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      { ok: true, evidenceFile, finalSha256: final.sha256 },
      null,
      2,
    ),
  );
} catch (error) {
  if (backupWritten && original && !restored) {
    try {
      const current = await bridgeRead();
      if (
        current.bindingFingerprint === original.bindingFingerprint &&
        current.sha256 !== original.sha256
      ) {
        await bridgeCas(current, original.yaml);
      }
      const verified = await bridgeRead();
      restored =
        verified.sha256 === original.sha256 && verified.yaml === original.yaml;
    } catch {
      restored = false;
    }
  }
  if (!restored && backupWritten) {
    retainedLogsPath = path.join(privateRoot, "logs");
    try {
      renameSync(logsPath, retainedLogsPath);
    } catch {}
    console.error(`P2 canary recovery required: ${privateRoot}`);
  }
  throw error;
} finally {
  await client.close().catch(() => undefined);
  if (restored || !backupWritten) {
    rmSync(privateRoot, { recursive: true, force: true });
    rmSync(logsPath, { recursive: true, force: true });
  } else if (!retainedLogsPath) {
    console.error(`Runtime logs retained separately: ${logsPath}`);
  }
}
