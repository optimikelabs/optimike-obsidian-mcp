import test from "node:test";
import assert from "node:assert/strict";
import {
  BaseBindingConflictError,
  BaseHashConflictError,
  assertBaseBinding,
  compareAndReplaceBase,
  parseBaseCasRequest,
  parseBaseReadRequest,
  sha256,
} from "./atomic-contract.mjs";

test("Base Atomic V1 accepts only exact .base read and CAS bodies", () => {
  assert.deepEqual(
    parseBaseReadRequest({ contractVersion: 1, path: "Maps/Work.base" }),
    {
      contractVersion: 1,
      path: "Maps/Work.base",
    },
  );
  const nextYaml = "formulas:\n  score: 1\nviews: []\n";
  assert.deepEqual(
    parseBaseCasRequest({
      bindingFingerprint: "a".repeat(64),
      contractVersion: 1,
      expectedSha256: "b".repeat(64),
      nextYaml,
      path: "Maps/Work.base",
    }),
    {
      bindingFingerprint: "a".repeat(64),
      contractVersion: 1,
      expectedSha256: "b".repeat(64),
      nextYaml,
      path: "Maps/Work.base",
    },
  );
  assert.throws(
    () => parseBaseReadRequest({ contractVersion: 1, path: "Work.md" }),
    /Only Obsidian Base files/u,
  );
  assert.throws(
    () => parseBaseReadRequest({ contractVersion: 1, path: "../Work.base" }),
    /invalid segment/u,
  );
  assert.throws(
    () =>
      parseBaseReadRequest({
        contractVersion: 1,
        path: "Work.base",
        extra: true,
      }),
    /Body keys must be exactly/u,
  );
});

test("Base Atomic V1 fences both content and backend identity", () => {
  const current = "formulas:\n  score: 1\n";
  assert.deepEqual(compareAndReplaceBase(current, sha256(current), "next"), {
    beforeSha256: sha256(current),
    content: "next",
  });
  assert.throws(
    () => compareAndReplaceBase(current, "0".repeat(64), "next"),
    BaseHashConflictError,
  );
  assert.throws(() => assertBaseBinding("a", "b"), BaseBindingConflictError);
});
