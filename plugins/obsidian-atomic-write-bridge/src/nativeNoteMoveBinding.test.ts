import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { NativeMoveApply } from "../../../src/services/nativeNoteMoveContract.js";
import { NativeNoteMoveService, type NativeMoveHost } from "./nativeNoteMove.js";

// Regression for Codex review on 42368f7: a safely rejected stale plan must
// remain reconcilable after its apply response is lost, without renaming.
test("M3 stale-generation conflict acknowledges the request, not the new host binding", async () => {
  let reads = 0;
  let writes = 0;
  let binding = "b".repeat(64);
  const host: NativeMoveHost = {
    binding: () => binding,
    enabled: () => true,
    preference: () => true,
    clock: () => ({ epoch: "new", resolved: 0 }),
    absent: async () => { reads++; return true; },
    parentExists: () => true,
    note: async () => { reads++; throw new Error("stale request must not read a note"); },
    rename: async () => { writes++; throw new Error("stale request must not dispatch"); },
  };
  const service = new NativeNoteMoveService(host);
  const request: NativeMoveApply = {
    contractVersion: 1,
    operationId: randomUUID(),
    sourcePath: "Old/Source.md",
    destinationPath: "New/Source.md",
    bindingFingerprint: "a".repeat(64),
    preconditionDigest: "c".repeat(64),
  };
  const first = await service.apply(request);
  assert.equal(first.outcome, "conflict");
  assert.equal(first.bindingFingerprint, request.bindingFingerprint);
  assert.equal(first.preconditionDigest, request.preconditionDigest);
  assert.equal(first.operationId, request.operationId);
  assert.equal(first.graphPostflight, "indeterminate");
  assert.equal(first.replayAllowed, false);
  // Treat the apply response as lost, then change the host generation again.
  binding = "d".repeat(64);
  assert.deepEqual(await service.status(request.operationId, request.preconditionDigest), first);
  assert.deepEqual(await service.apply(request), first);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  await assert.rejects(service.apply({ ...request, bindingFingerprint: binding }), /identity_conflict/);
  assert.equal(writes, 0);
});
