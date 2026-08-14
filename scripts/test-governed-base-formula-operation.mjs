#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianNoteReplaceOperationAdapter } from "../dist/services/operations/obsidianNoteReplaceOperationAdapter.js";
import { ObsidianNoteReplaceJournal } from "../dist/services/operations/obsidianNoteReplaceJournal.js";
import { BaseErrorCode, McpError } from "../dist/types-global/errors.js";

const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
process.env.OBSIDIAN_API_KEY ||= "governed-base-test-only";
process.env.MCP_WRITE_MODE ||= "full";
const { BASE_FORMULA_ATOMIC_PROFILE, GovernedBaseFormulaRuntime } =
  await import("../dist/services/baseFormulaProjectionRuntime.js");
const root = mkdtempSync(path.join(os.tmpdir(), "optimike-base-p2-"));
const bindingFingerprint = "b".repeat(64);
let yaml =
  "formulas:\n  score: old\nviews:\n  - type: table\n    name: Keep me\n";

const backend = {
  async status() {
    return {
      ok: true,
      contractVersion: 1,
      plugin: { id: "obsidian-bases-bridge", version: "1.1.0" },
      backend: {
        kind: "obsidian-vault-process",
        bindingFingerprint,
        atomicCas: true,
        writeEnabled: true,
      },
      limits: { markdownOnly: true },
    };
  },
  async read(payload) {
    return {
      ok: true,
      contractVersion: 1,
      path: payload.path,
      content: yaml,
      sha256: digest(yaml),
      size: Buffer.byteLength(yaml, "utf8"),
      bindingFingerprint,
    };
  },
  async replace(payload) {
    if (
      payload.bindingFingerprint !== bindingFingerprint ||
      payload.expectedSha256 !== digest(yaml)
    ) {
      throw new McpError(BaseErrorCode.CONFLICT, "sealed Base CAS conflict");
    }
    const beforeSha256 = digest(yaml);
    yaml = payload.nextContent;
    return {
      ok: true,
      contractVersion: 1,
      path: payload.path,
      beforeSha256,
      afterSha256: digest(yaml),
      size: Buffer.byteLength(yaml, "utf8"),
      bindingFingerprint,
    };
  },
};

const journal = new ObsidianNoteReplaceJournal(
  path.join(root, "journal.sqlite"),
);
const adapter = new ObsidianNoteReplaceOperationAdapter(
  backend,
  journal,
  BASE_FORMULA_ATOMIC_PROFILE,
);
const runtime = new GovernedBaseFormulaRuntime(
  backend,
  journal,
  adapter,
  10_000,
);

try {
  const planned = await runtime.plan({
    path: "Canary/Project.base",
    operations: [{ op: "set_formula", name: "score", expression: "new" }],
    idempotencyKey: "base-p2-contract-1",
  });
  assert.equal(planned.phase, "planned");
  assert.equal(planned.operationKind, "obsidian.base.formula.patch");
  assert.equal(planned.backend.kind, "obsidian-vault-process-base");
  assert.equal(planned.idempotencyKey, "base-p2-contract-1");
  assert.equal(
    planned.projection.sourcePreservation,
    "byte-identical-outside-authorized-base-ranges",
  );
  assert.match(yaml, /score: old/u, "plan must not mutate the Base");

  const replay = await runtime.plan({
    path: "Canary/Project.base",
    operations: [{ op: "set_formula", name: "score", expression: "new" }],
    idempotencyKey: "base-p2-contract-1",
  });
  assert.equal(replay.planRef, planned.planRef);

  const committed = await runtime.apply(planned.planRef, "base-p2-contract-1");
  assert.equal(committed.outcome, "committed");
  assert.match(yaml, /score: "new"/u);
  assert.match(
    yaml,
    /name: Keep me/u,
    "untargeted Base source must survive apply",
  );

  const status = await runtime.status(planned.planRef);
  assert.equal(status.outcome, "committed");
  assert.equal(
    status.idempotencyKey,
    undefined,
    "status must not disclose the internal or public key",
  );

  await assert.rejects(
    runtime.apply(planned.planRef, "wrong-key"),
    (error) =>
      error instanceof McpError && error.code === BaseErrorCode.CONFLICT,
  );
} finally {
  runtime.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "PASS: governed Base formula plan/apply/status seals intent over the shared durable runtime",
);
