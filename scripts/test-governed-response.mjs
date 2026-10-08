import assert from "node:assert/strict";
import {
  governedResponse,
  measureGovernedPhase,
} from "../dist/services/governedResponse.js";
const receipt = {
  contractVersion: 1,
  operationId: "operation",
  operationKind: "obsidian.text.patch",
  planRef: "plan",
  planDigest: "digest",
  phase: "applying",
  outcome: null,
  idempotencyKey: "key",
  beforeProof: {
    kind: "sha256",
    digest: "before",
    details: { source: "secret" },
  },
  postflight: {
    status: "pending",
    reason: "modified_time_settlement",
    checkAfter: "2026-10-08T12:00:00Z",
  },
  applyAllowed: false,
  recoveryAllowed: false,
  projection: {
    kind: "obsidian.text.patch",
    sourcePreservation: "preserved",
    proof: { ranges: "large private fixture" },
  },
};
const compact = await governedResponse(
  "obsidian_text_patch_apply",
  { responseMode: "compact" },
  async () => receipt,
);
assert.deepEqual(compact.postflight, receipt.postflight);
assert.equal(compact.outcome, null);
assert.equal(compact.afterProof, undefined);
assert.equal(compact.applyAllowed, false);
assert.equal(compact.recoveryAllowed, false);
assert.equal(JSON.stringify(compact).includes("secret"), false);
assert.equal(compact.detailedReceipt.tool, "obsidian_text_patch_status");
assert.equal(
  await governedResponse("tool", {}, async () => receipt),
  receipt,
  "default detailed is backwards compatible",
);
const [one, two] = await Promise.all([
  governedResponse("one", { diagnostics: true }, async () => {
    await measureGovernedPhase(
      "atomicCas",
      async () => new Promise((r) => setTimeout(r, 15)),
    );
    return receipt;
  }),
  governedResponse("two", { diagnostics: true }, async () => {
    await measureGovernedPhase(
      "noteRead",
      async () => new Promise((r) => setTimeout(r, 5)),
    );
    return receipt;
  }),
]);
assert.ok(one.diagnostics.phasesMs.atomicCas >= 10);
assert.equal(one.diagnostics.phasesMs.noteRead, undefined);
assert.ok(two.diagnostics.phasesMs.noteRead >= 2);
assert.equal(two.diagnostics.phasesMs.atomicCas, undefined);
assert.equal(
  receipt.diagnostics,
  undefined,
  "diagnostics never mutate the durable receipt",
);
console.log(
  "PASS compact preserves pending safety/proof access; timings isolate concurrent calls.",
);
