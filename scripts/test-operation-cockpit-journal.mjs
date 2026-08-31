import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianNoteReplaceJournal } from "../dist/services/operations/obsidianNoteReplaceJournal.js";

const PRIVATE_SENTINEL = "private-operation-journal-sentinel-7b8c";
const temporaryRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-operation-cockpit-"),
);
const databasePath = path.join(temporaryRoot, "journal.sqlite");
let now = Date.parse("2026-08-31T10:00:00.000Z");
const journal = new ObsidianNoteReplaceJournal(databasePath, {
  now: () => now,
  terminalRetentionMs: 100,
  purgeIntervalMs: 1,
});
const observer = new DatabaseSync(databasePath);

function plan(journalKey, projectionKind, projectionOverride) {
  const hasProjection =
    projectionKind !== undefined || projectionOverride !== undefined;
  return journal.create({
    idempotencyKey: `private-idempotency-${journalKey}-${PRIVATE_SENTINEL}`,
    requestDigest: `private-request-${journalKey}-${PRIVATE_SENTINEL}`,
    ...(!hasProjection
      ? {}
      : {
          projection: projectionOverride ?? {
            contractVersion: 1,
            kind: projectionKind,
            publicIdempotencyKey: `private-projection-key-${PRIVATE_SENTINEL}`,
            intentDigest: `private-intent-${PRIVATE_SENTINEL}`,
            proof: { privateProof: PRIVATE_SENTINEL },
          },
        }),
    path: `Private/${PRIVATE_SENTINEL}/${journalKey}.md`,
    beforeSha256: `private-before-${PRIVATE_SENTINEL}`,
    afterSha256: `private-after-${PRIVATE_SENTINEL}`,
    nextContent: PRIVATE_SENTINEL,
    bindingFingerprint: `private-binding-${PRIVATE_SENTINEL}`,
  });
}

function durableRows() {
  return observer
    .prepare(
      `SELECT operation_id, status, payload_json, created_at, updated_at
       FROM obsidian_note_replace_plans
       ORDER BY operation_id ASC`,
    )
    .all();
}

function dataVersion() {
  return observer.prepare("PRAGMA data_version").get().data_version;
}

try {
  const p1 = plan("p1", "obsidian.frontmatter.patch");
  const p4 = plan("p4", "obsidian.text.patch");
  const base = plan("base", "obsidian.base.formula.patch");
  const canvas = plan("canvas", "obsidian.canvas.patch");
  const unknownKind = plan("unknown-kind", "private.unsupported.operation");
  const missingKind = plan("missing-kind", undefined, {
    contractVersion: 1,
    publicIdempotencyKey: `private-projection-key-${PRIVATE_SENTINEL}`,
    intentDigest: `private-intent-${PRIVATE_SENTINEL}`,
    proof: { privateProof: PRIVATE_SENTINEL },
  });
  const nullKind = plan("null-kind", null);
  const noProjection = plan("no-projection");
  const applying = journal.transition(p4.operationId, ["planned"], "applying");
  const outcomeUnknown = journal.transition(
    base.operationId,
    ["planned"],
    "outcome_unknown",
  );
  const committed = journal.transition(
    plan("committed", "obsidian.frontmatter.patch").operationId,
    ["planned"],
    "committed",
  );
  const conflict = journal.transition(
    plan("conflict", "obsidian.frontmatter.patch").operationId,
    ["planned"],
    "conflict",
  );
  const rejected = journal.transition(
    plan("rejected", "obsidian.frontmatter.patch").operationId,
    ["planned"],
    "rejected",
  );
  const failed = journal.transition(
    plan("failed", "obsidian.frontmatter.patch").operationId,
    ["planned"],
    "failed",
  );

  const fallbackOperationKind = "obsidian.note.replace";
  const admittedProjectionKinds = [
    "obsidian.frontmatter.patch",
    "obsidian.text.patch",
    "obsidian.base.formula.patch",
    "obsidian.canvas.patch",
  ];
  const beforeRows = durableRows();
  const beforeVersion = dataVersion();
  const all = journal.listPendingOperationRows({
    fallbackOperationKind,
    admittedProjectionKinds,
    allowUnprojectedFallback: true,
    limit: 100,
  });
  const afterVersion = dataVersion();
  const afterRows = durableRows();

  assert.equal(
    afterVersion,
    beforeVersion,
    "read projection must not write SQLite",
  );
  assert.deepEqual(
    afterRows,
    beforeRows,
    "read projection must not change persisted payload rows",
  );
  assert.equal(all.hasMore, false);
  assert.deepEqual(
    new Set(all.rows.map((row) => row.operationId)),
    new Set([
      p1.operationId,
      applying.operationId,
      outcomeUnknown.operationId,
      canvas.operationId,
      noProjection.operationId,
    ]),
  );
  assert.equal(
    all.rows.some((row) =>
      [
        committed.operationId,
        conflict.operationId,
        rejected.operationId,
        failed.operationId,
      ].includes(row.operationId),
    ),
    false,
    "terminal states must be excluded",
  );
  assert.equal(
    all.rows.find((row) => row.operationId === p1.operationId).operationKind,
    "obsidian.frontmatter.patch",
  );
  assert.equal(
    all.rows.find((row) => row.operationId === applying.operationId)
      .operationKind,
    "obsidian.text.patch",
  );
  assert.equal(
    all.rows.find((row) => row.operationId === outcomeUnknown.operationId)
      .operationKind,
    "obsidian.base.formula.patch",
  );
  assert.equal(
    all.rows.find((row) => row.operationId === canvas.operationId)
      .operationKind,
    "obsidian.canvas.patch",
  );
  assert.equal(
    all.rows.some((row) => row.operationId === unknownKind.operationId),
    false,
    "an unadmitted explicit projection kind must be excluded rather than relabelled",
  );
  for (const malformed of [missingKind, nullKind]) {
    assert.equal(
      all.rows.some((row) => row.operationId === malformed.operationId),
      false,
      "a present malformed projection envelope must never be relabelled as a native Note operation",
    );
  }
  assert.equal(
    all.rows.find((row) => row.operationId === noProjection.operationId)
      .operationKind,
    fallbackOperationKind,
  );
  const noteScoped = journal.listPendingOperationRows({
    fallbackOperationKind,
    admittedProjectionKinds: [
      "obsidian.frontmatter.patch",
      "obsidian.text.patch",
    ],
    allowUnprojectedFallback: true,
    limit: 100,
  });
  for (const operationId of [outcomeUnknown.operationId, canvas.operationId]) {
    assert.equal(
      noteScoped.rows.some((row) => row.operationId === operationId),
      false,
      "a projection kind from another journal family must be excluded",
    );
  }
  assert.equal(
    noteScoped.rows.some((row) => row.operationId === noProjection.operationId),
    true,
    "the Note journal must retain native rows without a projection envelope",
  );
  const baseScoped = journal.listPendingOperationRows({
    fallbackOperationKind: "obsidian.base.formula.patch",
    admittedProjectionKinds: ["obsidian.base.formula.patch"],
    allowUnprojectedFallback: false,
    limit: 100,
  });
  assert.deepEqual(
    baseScoped.rows.map((row) => row.operationId),
    [outcomeUnknown.operationId],
    "a shared SQLite file must expose a Base row through the Base source only",
  );
  const serialized = JSON.stringify(all);
  assert.equal(serialized.includes(PRIVATE_SENTINEL), false);
  for (const row of all.rows) {
    assert.deepEqual(Object.keys(row).sort(), [
      "createdAt",
      "operationId",
      "operationKind",
      "status",
      "updatedAt",
    ]);
  }

  const expectedOrder = [...all.rows].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.operationKind.localeCompare(right.operationKind) ||
      left.operationId.localeCompare(right.operationId),
  );
  assert.deepEqual(
    all.rows,
    expectedOrder,
    "equal timestamps must use kind and operation id as stable tie-breakers",
  );
  const paged = [];
  let after;
  for (;;) {
    const page = journal.listPendingOperationRows({
      fallbackOperationKind,
      admittedProjectionKinds,
      allowUnprojectedFallback: true,
      limit: 2,
      ...(after ? { after } : {}),
    });
    paged.push(...page.rows);
    if (!page.hasMore) break;
    const last = page.rows.at(-1);
    after = {
      updatedAt: last.updatedAt,
      operationKind: last.operationKind,
      operationId: last.operationId,
    };
  }
  assert.deepEqual(
    paged,
    expectedOrder,
    "keyset pages must enumerate each equal-timestamp row exactly once",
  );
  assert.throws(
    () =>
      journal.listPendingOperationRows({
        fallbackOperationKind,
        admittedProjectionKinds,
        allowUnprojectedFallback: true,
        limit: 101,
      }),
    RangeError,
  );

  // A projection call must not trigger terminal retention. A normal journal
  // create remains the bounded maintenance trigger and removes the expired row.
  now += 200;
  assert.equal(
    durableRows().some((row) => row.operation_id === committed.operationId),
    true,
  );
  journal.listPendingOperationRows({
    fallbackOperationKind,
    admittedProjectionKinds,
    allowUnprojectedFallback: true,
    limit: 10,
  });
  assert.equal(
    durableRows().some((row) => row.operation_id === committed.operationId),
    true,
    "read projection must not extend or trigger retention",
  );
  plan("retention-trigger", "obsidian.frontmatter.patch");
  assert.equal(
    durableRows().some((row) => row.operation_id === committed.operationId),
    false,
    "ordinary write maintenance must still purge expired terminal rows",
  );

  journal.close();
  assert.throws(
    () =>
      journal.listPendingOperationRows({
        fallbackOperationKind,
        admittedProjectionKinds,
        allowUnprojectedFallback: true,
        limit: 1,
      }),
    /journal is closed/u,
  );
  console.log(
    "Operation cockpit journal projection passed: read-only bounded rows, allowlisted kinds, stable keyset pagination, privacy, retention, and closed-journal failure.",
  );
} finally {
  observer.close();
  journal.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
