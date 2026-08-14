#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  FrontmatterAdmissionModel,
  GovernedSingleResourceModel,
} from "./models/governed-single-resource-model.mjs";

function staleExecutorCannotTerminalizeNewAttempt() {
  const model = new GovernedSingleResourceModel();
  const oldAttempt = model.claim("executor-a");
  model.expire(oldAttempt);
  const recoveryAttempt = model.claim("executor-b", ["outcome_unknown"]);

  assert.throws(
    () => model.terminalize(oldAttempt, "failed", "effect-excluded"),
    /stale or unauthorized attempt/,
  );
  assert.equal(model.status, "applying");
  assert.deepEqual(model.owner, recoveryAttempt);
}

function delayedOldEffectIsReconciledNotMisclassified() {
  const model = new GovernedSingleResourceModel();
  const oldAttempt = model.claim("executor-a");
  model.backendSend(oldAttempt);
  model.expire(oldAttempt);
  const recoveryAttempt = model.claim("executor-b", ["outcome_unknown"]);

  // The old request was already in flight. Fencing prevents its terminal write,
  // not the physical response that the backend may still produce.
  model.backendEffect(oldAttempt);
  assert.throws(
    () => model.terminalize(oldAttempt, "committed", "sealed-after"),
    /stale or unauthorized attempt/,
  );

  // The current executor observes the sealed after state before issuing another
  // effect; protocol reconciliation commits with exactly one physical write.
  assert.equal(model.reconcile(), "committed");
  assert.equal(model.effectCount, 1);
  assert.equal(model.owner, undefined);
  assert.throws(
    () => model.terminalize(recoveryAttempt, "committed", "sealed-after"),
    /no executor owns/,
  );
}

function observerCannotBorrowExecutorAuthority() {
  const model = new GovernedSingleResourceModel();
  const owner = model.claim("executor-a");
  model.observerCannotTerminalize("failed");
  assert.equal(model.status, "applying");
  assert.deepEqual(model.owner, owner);
  assert.equal(model.reconcile(), "applying");
  assert.deepEqual(model.owner, owner);
}

function observerSeeingThirdPartyStateKeepsExecutorAuthority() {
  const model = new GovernedSingleResourceModel();
  const owner = model.claim("executor-a");
  model.backendSend(owner);
  model.thirdPartyEdit();

  assert.equal(model.reconcile(), "applying");
  assert.deepEqual(model.owner, owner);
  assert.equal(model.effectCount, 0);

  // Only an executor transition or lease-expiry protocol may relinquish the
  // owner; the status observer cannot turn this interleaving into unknown.
  model.expire(owner);
  assert.equal(model.reconcile(), "outcome_unknown");
  assert.equal(model.owner, undefined);
}

function unknownStaysUnknownWithoutProof() {
  const model = new GovernedSingleResourceModel();
  const attempt = model.claim("executor-a");
  model.backendSend(attempt);
  model.expire(attempt);
  model.thirdPartyEdit();
  assert.equal(model.reconcile(), "outcome_unknown");
  assert.equal(model.status, "outcome_unknown");
}

function sentRequestCannotBecomeProvenFailure() {
  const model = new GovernedSingleResourceModel();
  const attempt = model.claim("executor-a");
  model.backendSend(attempt);
  assert.throws(
    () => model.terminalize(attempt, "failed", "effect-excluded"),
    /cannot exclude an already-sent backend request/,
  );
  assert.equal(model.status, "applying");
  model.expire(attempt);
  assert.equal(model.reconcile(), "outcome_unknown");
}

function terminalReceiptsAreMonotone() {
  const model = new GovernedSingleResourceModel();
  const attempt = model.claim("executor-a");
  model.backendSend(attempt);
  model.backendEffect(attempt);
  model.terminalize(attempt, "committed", "sealed-after");
  assert.equal(model.reconcile(), "committed");
  assert.throws(() => model.claim("executor-b"), /cannot claim committed/);
  assert.equal(model.effectCount, 1);
}

function negativeTerminalNeedsEffectExclusion() {
  const model = new GovernedSingleResourceModel();
  const attempt = model.claim("executor-a");
  model.backendSend(attempt);
  model.backendEffect(attempt);
  assert.throws(
    () => model.terminalize(attempt, "failed", "effect-excluded"),
    /actual.*expected|Expected values to be strictly equal/,
  );
  assert.equal(model.status, "applying");
  assert.equal(model.reconcile(), "committed");
}

function sameKeySameIntentConverges() {
  const model = new FrontmatterAdmissionModel();
  const first = model.prepare({
    key: "fm:key-a",
    intentDigest: "intent-a",
    compiledSource: "source-a",
    compiledBinding: "binding-a",
    afterDigest: "after-a",
  });
  const second = model.prepare({ ...first });
  const winner = model.commit(first, {
    source: "source-a",
    binding: "binding-a",
  });
  const replay = model.commit(second, {
    source: "source-a",
    binding: "binding-a",
  });
  assert.equal(winner.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(replay.plan.id, winner.plan.id);
}

function sameIntentDifferentSnapshotsReturnsDurableWinner() {
  const model = new FrontmatterAdmissionModel();
  const fromA = model.prepare({
    key: "fm:key-b",
    intentDigest: "intent-b",
    compiledSource: "source-a",
    compiledBinding: "binding-a",
    afterDigest: "after-a",
  });
  const fromB = model.prepare({
    key: "fm:key-b",
    intentDigest: "intent-b",
    compiledSource: "source-b",
    compiledBinding: "binding-a",
    afterDigest: "after-b",
  });

  const winner = model.commit(fromA, {
    source: "source-a",
    binding: "binding-a",
  });
  const loserReplay = model.commit(fromB, {
    // A durable winner is authoritative before another source revalidation.
    source: "source-b",
    binding: "binding-a",
  });
  assert.equal(loserReplay.inserted, false);
  assert.equal(loserReplay.plan.id, winner.plan.id);
  assert.equal(loserReplay.plan.afterDigest, "after-a");
}

function sourceAndBindingDriftPreventAdmission() {
  const sourceModel = new FrontmatterAdmissionModel();
  const candidate = sourceModel.prepare({
    key: "fm:key-c",
    intentDigest: "intent-c",
    compiledSource: "source-a",
    compiledBinding: "binding-a",
    afterDigest: "after-a",
  });
  assert.throws(
    () =>
      sourceModel.commit(candidate, {
        source: "source-b",
        binding: "binding-a",
      }),
    /source drift/,
  );
  assert.equal(sourceModel.get(candidate.key), undefined);

  const bindingModel = new FrontmatterAdmissionModel();
  assert.throws(
    () =>
      bindingModel.commit(candidate, {
        source: "source-a",
        binding: "binding-b",
      }),
    /backend drift/,
  );
  assert.equal(bindingModel.get(candidate.key), undefined);
}

function sameKeyDifferentIntentConflicts() {
  const model = new FrontmatterAdmissionModel();
  const first = model.prepare({
    key: "fm:key-d",
    intentDigest: "intent-d1",
    compiledSource: "source-a",
    compiledBinding: "binding-a",
    afterDigest: "after-a",
  });
  model.commit(first, { source: "source-a", binding: "binding-a" });

  const different = model.prepare({
    ...first,
    intentDigest: "intent-d2",
    afterDigest: "after-b",
  });
  assert.throws(
    () =>
      model.commit(different, {
        source: "source-a",
        binding: "binding-a",
      }),
    /same idempotency key cannot bind a different intent/,
  );
  assert.equal(model.get(first.key).intentDigest, "intent-d1");
}

for (const test of [
  staleExecutorCannotTerminalizeNewAttempt,
  delayedOldEffectIsReconciledNotMisclassified,
  observerCannotBorrowExecutorAuthority,
  observerSeeingThirdPartyStateKeepsExecutorAuthority,
  unknownStaysUnknownWithoutProof,
  sentRequestCannotBecomeProvenFailure,
  terminalReceiptsAreMonotone,
  negativeTerminalNeedsEffectExclusion,
  sameKeySameIntentConverges,
  sameIntentDifferentSnapshotsReturnsDurableWinner,
  sourceAndBindingDriftPreventAdmission,
  sameKeyDifferentIntentConflicts,
]) {
  test();
}

console.log(
  "PASS: executable P1 model proves authority separation, observer non-interference, stale-attempt fencing, send/effect uncertainty, conservative reconciliation, terminal monotonicity, source/binding admission gates, and same-key intent convergence.",
);
