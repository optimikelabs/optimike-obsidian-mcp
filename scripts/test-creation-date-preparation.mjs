import assert from "node:assert/strict";
import { load } from "js-yaml";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeFormatFixture } from "./fixtures/native-frontmatter-format.mjs";
const root = mkdtempSync(path.join(os.tmpdir(), "creation-date-test-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  MCP_WRITE_MODE: "guarded",
  OBSIDIAN_RUNTIME_MODE: "live",
  OBSIDIAN_API_KEY: "test",
  MCP_PROTECTED_FRONTMATTER_KEYS: "création,modification",
  MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(root, "journal.sqlite"),
});
const { createGovernedNoteReplaceRuntime } = await import(
  "../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js"
);
const { GovernedTextPatchRuntime } = await import(
  "../dist/services/textPatchProjectionRuntime.js"
);
const { GovernedFrontmatterRuntime } = await import(
  "../dist/services/frontmatterProjectionRuntime.js"
);
const { governedResponse } = await import(
  "../dist/services/governedResponse.js"
);
const { ErrorHandler, publicMcpToolErrorPayload } = await import(
  "../dist/utils/internal/errorHandler.js"
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const initial = "---\r\nstatut: actif\r\n---\r\nneedle\r\n";
const binding = hash("test-vault");
let createdKey = "création",
  modifiedKey = "modification",
  failPreparation = false;
let managed = true;
let content = initial,
  active = true,
  preparations = 0,
  writes = 0;
const read = () => ({
  ok: true,
  contractVersion: 1,
  path: "Test.md",
  content,
  dateManagement: { managed },
  sha256: hash(content),
  size: Buffer.byteLength(content),
  bindingFingerprint: binding,
});
const fake = {
  async getAtomicWriteStatus() {
    return {
      ok: true,
      contractVersion: 1,
      datePreparation: { contractVersion: 1, supported: true },
      frontmatterFormat: { contractVersion: 1, supported: true },
      plugin: { id: "atomic", version: "test" },
      backend: {
        kind: "obsidian-vault-process",
        bindingFingerprint: binding,
        atomicCas: true,
        writeEnabled: true,
      },
      limits: { markdownOnly: true },
      protection: {
        contractVersion: 1,
        frontmatterDateProperties: {
          integrations: active
            ? [
                {
                  pluginId: "frontmatter-date-manager",
                  createdPropertyName: createdKey,
                  modifiedPropertyName: modifiedKey,
                },
              ]
            : [],
        },
      },
      settlement: {
        contractVersion: 1,
        modifiedTimeFrontmatter: {
          integrations: active
            ? [
                {
                  pluginId: "frontmatter-date-manager",
                  propertyName: modifiedKey,
                  settlementObservationDelayMs: 0,
                },
              ]
            : [],
          utcOffsetMinutes: 0,
        },
      },
    };
  },
  async readAtomicWriteNote() {
    return read();
  },
  async inspectAtomicFrontmatterFormat({ yaml }) { return nativeFormatFixture(binding).inspectFrontmatterFormat(yaml); },
  async prepareAtomicWriteDate(request) {
    preparations++;
    if (!active || failPreparation) throw Error("no manager or failed command");
    assert.equal(request.expectedSha256, hash(content));
    const lineEndingsNormalized = content.includes("\r\n");
    content = content
      .replace(/\r\n/g, "\n")
      .replace(
        "statut: actif",
        `statut: actif\n${createdKey}: 2026-10-23T10:00\n${modifiedKey}: 2026-10-23T10:00`,
      );
    return {
      ...read(),
      datePreparation: {
        kind: "date-manager-before-plan",
        ...(lineEndingsNormalized ? { lineEndingsNormalized: true } : {}),
        message: "Note datée par le gestionnaire de dates avant le plan.",
      },
    };
  },
  async replaceAtomicWriteNote(request) {
    if (request.expectedSha256 !== hash(content)) throw Error("conflict");
    writes++;
    const beforeSha256 = hash(content);
    content = request.nextContent;
    return {
      ok: true,
      contractVersion: 1,
      path: request.path,
      beforeSha256,
      afterSha256: hash(content),
      size: Buffer.byteLength(content),
      bindingFingerprint: binding,
    };
  },
};
const runtime = createGovernedNoteReplaceRuntime(fake);
const text = new GovernedTextPatchRuntime(runtime);
try {
  const planned = await text.plan({
    path: "Test.md",
    operations: [
      { op: "replace_literal", search: "needle", replacement: "accepted" },
    ],
    idempotencyKey: "dated",
  });
  assert.equal(planned.phase, "planned");
  assert.equal(preparations, 1);
  assert.equal(writes, 0);
  assert.match(content, /needle/);
  assert.equal(planned.datePreparation.kind, "date-manager-before-plan");
  assert.equal(planned.datePreparation.lineEndingsNormalized, true);
  assert.match(
    planned.datePreparation.message,
    /fins de ligne normalisées par Obsidian pendant la datation/,
  );
  assert(!content.includes("\r"));
  assert.equal(
    runtime.inspect("obsidian-note-replace:v1:" + planned.operationId)
      .beforeSha256,
    hash(content),
  );
  const compact = await governedResponse(
    "obsidian_text_patch_plan",
    { responseMode: "compact" },
    async () => planned,
  );
  assert.deepEqual(compact.datePreparation, planned.datePreparation);
  const committed = await text.apply(planned.planRef, "dated", "verified");
  assert.equal(committed.outcome, "committed");
  assert.equal(committed.postflight.status, "verified");
  assert.deepEqual(committed.datePreparation, planned.datePreparation);
  assert.deepEqual(
    (await text.status(planned.planRef)).datePreparation,
    planned.datePreparation,
  );
  const after = content;
  await text.apply(planned.planRef, "dated", "verified");
  assert.equal(content, after);
  assert.equal(writes, 1);
  assert.equal(
    (await text.status(planned.planRef)).datePreparation.kind,
    "date-manager-before-plan",
  );
  // G1 conflict remains sealed against the dated state.
  const conflict = await text.plan({
    path: "Test.md",
    operations: [{ op: "append_body", text: "trace" }],
    idempotencyKey: "conflict",
  });
  content += "human edit\n";
  const human = content;
  assert.equal(
    (await text.apply(conflict.planRef, "conflict", "verified")).outcome,
    "conflict",
  );
  assert.equal(content, human);
  assert.equal(preparations, 1);
  // Without a manager a fresh note is refused with a safe public remedy, without a write.
  content = initial;
  active = false;
  await assert.rejects(
    text.plan({
      path: "Test.md",
      operations: [{ op: "append_body", text: "blocked" }],
      idempotencyKey: "no-manager",
    }),
    (error) => {
      const publicError = ErrorHandler.handleError(error, {
        operation: "test",
        input: { path: "Test.md" },
      });
      assert.equal(publicError.code, "FORBIDDEN");
      assert.match(
        publicError.message,
        /Ouvrez-la dans Obsidian et enregistrez-la une fois/,
      );
      assert.equal(
        publicError.details.reasonCode,
        "atomic_write_creation_property_missing",
      );
      const wire = publicMcpToolErrorPayload(error, {
        operation: "test",
        toolName: "obsidian_text_patch_plan",
        params: { path: "Test.md" },
      });
      assert.equal(wire.error.message, publicError.message);
      return true;
    },
  );
  assert.equal(content, initial);
  assert.equal(writes, 1);
  // Whole-note callers also continue while preserving only manager-produced dates.
  active = true;
  const canonicalDirect = initial.replace("statut: actif\r\n", "statut: actif\n").replace("needle", "direct");
  const direct = await runtime.planPublicDirect({
    path: "Test.md",
    nextContent: canonicalDirect,
    idempotencyKey: "direct",
  });
  assert.equal(direct.phase, "planned");
  assert.equal(direct.datePreparation.kind, "date-manager-before-plan");
  assert.equal(
    (await runtime.applyPublicDirectPlan(direct.planRef, "direct", "verified"))
      .outcome,
    "committed",
  );
  const beforeReplay = preparations;
  assert.equal(
    (
      await runtime.planPublicDirect({
        path: "Test.md",
        nextContent: canonicalDirect,
        idempotencyKey: "direct",
      })
    ).operationId,
    direct.operationId,
  );
  assert.equal(preparations, beforeReplay);
  await assert.rejects(
    runtime.planPublicDirect({
      path: "Test.md",
      nextContent: content.replace("2026-10-23T10:00", "2099-01-01T10:00"),
      idempotencyKey: "protected",
    }),
    /protected frontmatter/,
  );
  content = initial;
  failPreparation = true;
  await assert.rejects(
    text.plan({
      path: "Test.md",
      operations: [{ op: "append_body", text: "blocked" }],
      idempotencyKey: "manager-failed",
    }),
    /Ouvrez-la dans Obsidian/,
  );
  assert.equal(content, initial);
  failPreparation = false;
  createdKey = "bornAt";
  modifiedKey = "changedAt";
  const frontmatter = new GovernedFrontmatterRuntime(runtime);
  const custom = await frontmatter.plan({
    path: "Test.md",
    operations: [{ op: "set", key: "statut", value: "maturation" }],
    idempotencyKey: "custom-dates",
  });
  assert.equal(custom.datePreparation.kind, "date-manager-before-plan");
  assert.match(content, /bornAt: 2026/);
  assert(!content.includes("création:"));
  const customCommit = await frontmatter.apply(
    custom.planRef,
    "custom-dates",
    "verified",
  );
  assert.equal(customCommit.outcome, "committed");
  assert.equal(customCommit.postflight.status, "verified");
  assert.equal(load(content.split("---")[1]).statut, "maturation");
  for (const kind of ["template", "excluded-folder"]) {
    content = initial;
    managed = false;
    const callsBefore = preparations;
    const p = await text.plan({
      path: "Test.md",
      operations: [{ op: "append_body", text: "accepted " + kind }],
      idempotencyKey: kind,
    });
    assert.equal(p.datePreparation.kind, "outside-date-management");
    assert.equal(preparations, callsBefore);
    const r = await text.apply(p.planRef, kind, "verified");
    assert.equal(r.outcome, "committed");
    assert.equal(r.postflight.status, "verified");
    assert(!content.includes("bornAt:") && !content.includes("création:"));
    const stale = await text.plan({
      path: "Test.md",
      operations: [{ op: "append_body", text: "stale" }],
      idempotencyKey: kind + "-stale",
    });
    content += "human edit";
    const humanEdit = content;
    assert.equal(
      (await text.apply(stale.planRef, kind + "-stale", "verified")).outcome,
      "conflict",
    );
    assert.equal(content, humanEdit);
  }
  console.log(
    "PASS: FDM preparation, dated source sealing, compact/durable receipt, verified commit, replay, G1 conflict, no-manager public refusal, direct replacement, date protection.",
  );
} finally {
  runtime.close();
  rmSync(root, { recursive: true, force: true });
}
