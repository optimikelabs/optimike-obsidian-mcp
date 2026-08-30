import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const {
  ExternalMoveJournal,
  ExternalMoveJournalConcurrencyError,
  ExternalMoveJournalIdempotencyConflictError,
} = await import("../dist/services/externalReferences/externalMoveJournal.js");

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-move-journal-cas-"),
);
const databasePath = path.join(sandbox, "journal.sqlite");
const journalA = new ExternalMoveJournal(databasePath);
const journalB = new ExternalMoveJournal(databasePath);

function input(idempotencyKey, suffix = "one") {
  return {
    idempotencyKey,
    snapshot: {
      rootId: "test.root",
      sourceRelativePath: `source-${suffix}.txt`,
      targetRelativePath: `archive/source-${suffix}.txt`,
      size: 1,
      modifiedAt: "2026-08-30T00:00:00.000Z",
      sha256: "a".repeat(64),
    },
    bindingIdentity: {
      schemaVersion: 2,
      backendFingerprint: "b".repeat(64),
      vaultFingerprint: "c".repeat(64),
      rootConfigFingerprint: "d".repeat(64),
      bindingFingerprint: "e".repeat(64),
      vaultIdentitySource: "backend_destructive_vault_attestation",
      verifiable: true,
    },
    destructiveSession: {
      generation: 1,
      sessionId: "00000000-0000-4000-8000-000000000001",
      bindingFingerprint: "e".repeat(64),
    },
    sourceToken: `external-ref:test.root::source-${suffix}.txt`,
    targetToken: `external-ref:test.root::archive/source-${suffix}.txt`,
    oldFileUri: `file:///private/source-${suffix}.txt`,
    newFileUri: `file:///private/archive/source-${suffix}.txt`,
    repairs: [],
    manualReview: [],
    inventoryDigest: "f".repeat(64),
    appliedRepairPaths: [],
    restoredRepairPaths: [],
    recoveryErrors: [],
  };
}

function sameRequest(winner, attempted) {
  return (
    winner.snapshot.rootId === attempted.snapshot.rootId &&
    winner.snapshot.sourceRelativePath ===
      attempted.snapshot.sourceRelativePath &&
    winner.snapshot.targetRelativePath === attempted.snapshot.targetRelativePath
  );
}

function create(key, suffix = "one") {
  return journalA.createOrLoad(input(key, suffix), {
    isCompatible: sameRequest,
  }).plan;
}

function observed(journal, planId) {
  const result = journal.observe(planId);
  assert.ok(result, "expected a durable journal observation");
  return result;
}

function transition(journal, planId, expected, next) {
  return journal.transitionObserved(observed(journal, planId), expected, next);
}

function toApplyingRepairs(planId) {
  transition(journalA, planId, ["planned"], "applying_file");
  transition(journalA, planId, ["applying_file"], "file_moved");
  return transition(journalA, planId, ["file_moved"], "applying_repairs");
}

function toRollingBackRepairs(planId) {
  return transition(journalA, planId, ["planned"], "rolling_back_repairs");
}

function expectConcurrent(operation, privateSentinel) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ExternalMoveJournalConcurrencyError);
    assert.equal(error.message.includes(privateSentinel), false);
    assert.equal(error.message.includes("file:///private"), false);
    return true;
  });
}

try {
  // Same key, two handles: compatible callers share the committed winner;
  // incompatible callers get a typed, value-free conflict instead of UNIQUE.
  const first = journalA.createOrLoad(input("same-key"), {
    isCompatible: sameRequest,
  });
  const compatible = journalB.createOrLoad(input("same-key"), {
    isCompatible: sameRequest,
  });
  assert.equal(first.created, true);
  assert.equal(compatible.created, false);
  assert.equal(compatible.plan.planId, first.plan.planId);
  assert.throws(
    () =>
      journalB.createOrLoad(input("same-key", "incompatible"), {
        isCompatible: sameRequest,
      }),
    (error) => {
      assert.ok(error instanceof ExternalMoveJournalIdempotencyConflictError);
      assert.equal(error.message.includes("source-incompatible"), false);
      assert.equal(error.message.includes("file:///private"), false);
      return true;
    },
  );

  // A separately opened SQLite handle can leave a tampered winner whose row
  // identity no longer matches its payload. createOrLoad must not pass that
  // winner to a compatibility callback or expose its private payload.
  const splitWinner = create("split-brain-winner", "split-winner");
  const splitPayload = {
    ...splitWinner,
    planId: "00000000-0000-4000-8000-000000000099",
    oldFileUri: "file:///private/split-brain-sentinel.txt",
  };
  const splitHandle = new DatabaseSync(databasePath);
  splitHandle
    .prepare(
      "UPDATE external_move_plans SET payload_json = ? WHERE idempotency_key = ?",
    )
    .run(JSON.stringify(splitPayload), "split-brain-winner");
  splitHandle.close();
  let compatibilityCalled = false;
  assert.throws(
    () =>
      journalB.createOrLoad(input("split-brain-winner", "split-winner"), {
        isCompatible: () => {
          compatibilityCalled = true;
          return true;
        },
      }),
    (error) => {
      assert.ok(error instanceof ExternalMoveJournalIdempotencyConflictError);
      assert.equal(error.message.includes("split-brain-sentinel"), false);
      assert.equal(error.message.includes("file:///private"), false);
      return true;
    },
  );
  assert.equal(compatibilityCalled, false);

  // A record and a recovery update racing from the same applying-repairs
  // observation cannot overwrite one another, even though the record keeps
  // the same status.
  const appliedRepair = create("record-applied-vs-recovery");
  toApplyingRepairs(appliedRepair.planId);
  const appliedA = observed(journalA, appliedRepair.planId);
  const recoveryB = observed(journalB, appliedRepair.planId);
  const appliedWinner = journalA.recordAppliedRepairObserved(
    appliedA,
    "Efforts/Applied.md",
  );
  expectConcurrent(
    () =>
      journalB.updateObserved(recoveryB, "recovery_required", "safe_code", {
        recoveryErrors: ["safe_code"],
      }),
    "private-applied-sentinel",
  );
  assert.deepEqual(appliedWinner.plan.appliedRepairPaths, [
    "Efforts/Applied.md",
  ]);
  assert.equal(journalB.get(appliedRepair.planId).status, "applying_repairs");

  // The same exact CAS protection applies to rollback repair receipts.
  const restoredRepair = create("record-restored-vs-update", "restored");
  toRollingBackRepairs(restoredRepair.planId);
  const restoredA = observed(journalA, restoredRepair.planId);
  const updateB = observed(journalB, restoredRepair.planId);
  journalA.recordRestoredRepairObserved(restoredA, "Efforts/Restored.md");
  expectConcurrent(
    () => journalB.updateObserved(updateB, "recovery_required", "safe_code"),
    "private-restored-sentinel",
  );
  assert.deepEqual(journalA.get(restoredRepair.planId).restoredRepairPaths, [
    "Efforts/Restored.md",
  ]);

  // Record-vs-record has an explicit loser. Reloading the loser and retrying
  // yields both receipts rather than silently losing either repair.
  const twoRecords = create("record-vs-record", "two-records");
  toApplyingRepairs(twoRecords.planId);
  const firstRecord = observed(journalA, twoRecords.planId);
  const secondRecord = observed(journalB, twoRecords.planId);
  journalA.recordAppliedRepairObserved(firstRecord, "Efforts/First.md");
  expectConcurrent(
    () =>
      journalB.recordAppliedRepairObserved(secondRecord, "Efforts/Second.md"),
    "private-record-sentinel",
  );
  const reloadedSecond = journalB.recordAppliedRepairObserved(
    observed(journalB, twoRecords.planId),
    "Efforts/Second.md",
  );
  assert.deepEqual(reloadedSecond.plan.appliedRepairPaths, [
    "Efforts/First.md",
    "Efforts/Second.md",
  ]);

  // Update-vs-update shares the same failure mode: the stale status update is
  // refused and the winner remains intact.
  const twoUpdates = create("update-vs-update", "updates");
  const updateA = observed(journalA, twoUpdates.planId);
  const updateB2 = observed(journalB, twoUpdates.planId);
  journalA.updateObserved(updateA, "applied");
  expectConcurrent(
    () => journalB.updateObserved(updateB2, "recovery_required", "safe_code"),
    "private-update-sentinel",
  );
  assert.equal(journalA.get(twoUpdates.planId).status, "applied");

  // A same-status payload substitution is the critical regression: a stale
  // record receipt must never re-persist a hostile newer payload it did not
  // observe and validate.
  const substituted = create("same-status-payload-substitution", "substituted");
  toApplyingRepairs(substituted.planId);
  const safeObservation = observed(journalA, substituted.planId);
  const substitutingObservation = observed(journalB, substituted.planId);
  const privateSentinel = "private-payload-sentinel";
  journalB.updateObserved(
    substitutingObservation,
    "applying_repairs",
    privateSentinel,
    { recoveryErrors: ["safe_code"] },
  );
  expectConcurrent(
    () =>
      journalA.recordAppliedRepairObserved(
        safeObservation,
        "Efforts/NeverPersisted.md",
      ),
    privateSentinel,
  );
  const durable = journalB.get(substituted.planId);
  assert.equal(durable.failure, privateSentinel);
  assert.deepEqual(durable.appliedRepairPaths, []);
  assert.equal(
    durable.appliedRepairPaths.includes("Efforts/NeverPersisted.md"),
    false,
  );

  console.log("external move journal concurrency checks passed");
} finally {
  journalA.close();
  journalB.close();
  await rm(sandbox, { recursive: true, force: true });
}
