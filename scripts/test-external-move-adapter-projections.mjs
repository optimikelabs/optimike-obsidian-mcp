import assert from "node:assert/strict";

const { ExternalMoveOperationAdapter } = await import(
  "../dist/services/operations/externalMoveOperationAdapter.js"
);
const { ExternalRootError } = await import(
  "../dist/services/externalRootsService.js"
);

const PLAN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PLAN_REF = `external-move:v1:${PLAN_ID}`;
const SENSITIVE = "private-external-move-identifier";
const SHA256 = "a".repeat(64);
const AT = "2026-08-30T12:00:00.000Z";

function currentProjection(overrides = {}) {
  return {
    planId: PLAN_ID,
    idempotencyKey: "adapter-projection-idempotency-key",
    createdAt: AT,
    updatedAt: AT,
    status: "planned",
    rootId: "pilot.move",
    sourceRelativePath: "source.md",
    targetRelativePath: "archive/source.md",
    sourceSha256: SHA256,
    sourceSize: 42,
    inventoryDigest: SHA256,
    bindingVerifiable: true,
    legacyBinding: false,
    repairs: [],
    manualReview: [],
    readyToApply: false,
    mutationAvailable: false,
    mutationUnavailableReason: "native_handle_relative_mutation_unavailable",
    recoveryRequired: false,
    recoveryErrors: [],
    appliedRepairCount: 0,
    restoredRepairCount: 0,
    nextAction: "none",
    ...overrides,
  };
}

function adapterFor(projection) {
  return new ExternalMoveOperationAdapter({
    async plan() {
      return projection;
    },
    status(planId) {
      assert.equal(planId, PLAN_ID);
      return projection;
    },
  });
}

function assertSafeIncident(receipt, label) {
  assert.equal(
    receipt.operationId,
    PLAN_ID,
    `${label}: known reference is retained`,
  );
  assert.equal(
    receipt.planRef,
    PLAN_REF,
    `${label}: known reference is retained`,
  );
  assert.equal(
    receipt.idempotencyKey,
    "[redacted]",
    `${label}: idempotency key redacted`,
  );
  assert.equal(
    receipt.target.logicalRef,
    "[redacted]",
    `${label}: target redacted`,
  );
  assert.equal(receipt.phase, "terminal", `${label}: incident is terminal`);
  assert.equal(
    receipt.outcome,
    "outcome_unknown",
    `${label}: incident preserves uncertainty`,
  );
  assert.equal(
    receipt.postflight.status,
    "unverified",
    `${label}: postflight is unverified`,
  );
  assert.equal(
    receipt.applyAllowed,
    false,
    `${label}: apply remains forbidden`,
  );
  assert.equal(
    receipt.recoveryAllowed,
    false,
    `${label}: recovery remains forbidden`,
  );
  assert.equal(
    JSON.stringify(receipt).includes(SENSITIVE),
    false,
    `${label}: sensitive stored value is not reflected`,
  );
}

// A fully current projection keeps the normal, inspectable status path.
const trusted = await adapterFor(currentProjection()).status(PLAN_REF);
assert.equal(trusted.operationId, PLAN_ID);
assert.equal(trusted.idempotencyKey, "adapter-projection-idempotency-key");
assert.equal(trusted.phase, "planned");
assert.equal(trusted.applyAllowed, false);
assert.equal(trusted.recoveryAllowed, false);

const unsafeProjection = {
  planId: "[redacted]",
  idempotencyKey: SENSITIVE,
  status: "recovery_required",
  rootId: SENSITIVE,
  sourceRelativePath: SENSITIVE,
  targetRelativePath: SENSITIVE,
  bindingVerifiable: false,
  legacyBinding: true,
  repairs: [],
  manualReview: [
    {
      filePath: "[redacted]",
      reason: "Stored journal data requires manual review.",
    },
  ],
  readyToApply: false,
  mutationAvailable: false,
  mutationUnavailableReason: "native_handle_relative_mutation_unavailable",
  recoveryRequired: true,
  recoveryErrors: ["external_root_non_verifiable"],
  appliedRepairCount: 0,
  restoredRepairCount: 0,
  nextAction: "none",
  failureCode: "external_root_non_verifiable",
};

// A same-key replay can return this projection from plan(). There is no
// trusted plan reference in it, so fail closed with a stable domain error.
await assert.rejects(
  () =>
    adapterFor(unsafeProjection).plan({
      rootId: SENSITIVE,
      sourceRelativePath: SENSITIVE,
      targetRelativePath: SENSITIVE,
      idempotencyKey: SENSITIVE,
    }),
  (error) => {
    assert.ok(error instanceof ExternalRootError);
    assert.equal(error.code, "non_verifiable");
    assert.equal(
      error.message,
      "The external move plan could not be safely verified.",
    );
    assert.equal(JSON.stringify(error).includes(SENSITIVE), false);
    return true;
  },
);

// Legacy binding is structurally complete but must never become a receipt that
// advertises stored target data or a continuation.
const legacy = await adapterFor(
  currentProjection({
    idempotencyKey: SENSITIVE,
    rootId: SENSITIVE,
    sourceRelativePath: `${SENSITIVE}.md`,
    targetRelativePath: `archive/${SENSITIVE}.md`,
    bindingVerifiable: false,
    legacyBinding: true,
    recoveryRequired: true,
    recoveryErrors: ["external_root_non_verifiable"],
    status: "recovery_required",
  }),
).status(PLAN_REF);
assertSafeIncident(legacy, "legacy binding");

// The coordinator's unsafe projection intentionally omits source proof and
// timestamps. The adapter must turn it into a stable incident rather than
// exposing a ZodError (or reflecting redacted journal fields).
const unsafe = await adapterFor(unsafeProjection).status(PLAN_REF);
assertSafeIncident(unsafe, "unsafe projection");

// Stale and manual-review projections remain structurally current and must
// preserve their receipt identity over plan/status. They are still read-only.
const stale = await adapterFor(
  currentProjection({
    status: "recovery_required",
    recoveryRequired: true,
    recoveryErrors: ["backend_session_changed"],
  }),
).status(PLAN_REF);
assert.equal(stale.operationId, PLAN_ID);
assert.equal(stale.phase, "terminal");
assert.equal(stale.outcome, "outcome_unknown");
assert.equal(stale.applyAllowed, false);
assert.equal(stale.recoveryAllowed, false);

const manualProjection = currentProjection({
  manualReview: [{ filePath: "Manual-review.md", reason: "legacy occurrence" }],
});
const manualAdapter = adapterFor(manualProjection);
const manualPlan = await manualAdapter.plan({
  rootId: "pilot.move",
  sourceRelativePath: "source.md",
  targetRelativePath: "archive/source.md",
  idempotencyKey: "adapter-projection-idempotency-key",
});
const manual = await manualAdapter.status(PLAN_REF);
assert.equal(manual.operationId, PLAN_ID);
assert.equal(manual.planRef, PLAN_REF);
assert.equal(manual.planDigest, manualPlan.planDigest);
assert.equal(manual.phase, "planned");
assert.equal(manual.applyAllowed, false);
assert.equal(manual.recoveryAllowed, false);

console.log("External move operation adapter projection checks passed.");
