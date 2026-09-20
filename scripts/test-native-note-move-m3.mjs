import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";
const { NativeNoteMoveOperationAdapter } = await import("../dist/services/operations/nativeNoteMoveOperationAdapter.js");
import { ObsidianNoteReplaceJournal } from "../dist/services/operations/obsidianNoteReplaceJournal.js";
import { nativeDigest, sealNativeMove } from "../dist/services/nativeNoteMoveContract.js";

const root = mkdtempSync(path.join(os.tmpdir(), "native-move-m3-"));
let assertions = 0;
function setup(name, clock = Date.now) {
  const db = path.join(root, name + ".sqlite");
  const journal = new ObsidianNoteReplaceJournal(db, { now: clock });
  let calls = 0;
  let reads = 0;
  let allow = true;
  const replies = new Map();
  const plan = sealNativeMove({ sourcePath: "A.md", destinationPath: "B.md", updateLinks: true,
    bindingFingerprint: "a".repeat(64), notes: [{ path: "A.md", sha256: nativeDigest("source"),
      references: [], backlinks: [], unresolved: [] }] });
  const backend = {
    async preflight() { reads++; return plan; },
    async apply(request) {
      calls++;
      const result = { ...request, outcome: "committed", reason: "native_rename_returned", afterSha256: nativeDigest("source"),
        graphPostflight: "pending", scope: "sealed_neighborhood_only", replayAllowed: false };
      delete result.sourcePath; delete result.destinationPath;
      replies.set(request.operationId, result);
      return result;
    },
    async status(operationId, preconditionDigest) {
      return replies.get(operationId) ?? { contractVersion: 1, operationId, preconditionDigest,
        bindingFingerprint: plan.bindingFingerprint, outcome: "outcome_unknown", reason: "backend_receipt_unavailable",
        graphPostflight: "indeterminate", scope: "sealed_neighborhood_only", replayAllowed: false };
    },
  };
  const authorize = () => { if (!allow) throw new Error("writes disabled"); };
  const adapter = new NativeNoteMoveOperationAdapter(backend, journal, authorize);
  return { journal, adapter, backend, plan, db, replies, authorize, calls: () => calls, reads: () => reads,
    disable: () => { allow = false; } };
}
const request = { sourcePath: "A.md", destinationPath: "B.md", idempotencyKey: "move-once" };
try {
  const f = setup("nominal");
  const p = await f.adapter.plan(request);
  assert.equal(f.calls(), 0); assert.equal(p.phase, "planned");
  const repeated = await f.adapter.plan(request);
  assert.equal(repeated.planRef, p.planRef); assert.equal(f.reads(), 1);
  await assert.rejects(f.adapter.plan({ ...request, destinationPath: "C.md" }));
  await assert.rejects(f.adapter.apply(p.planRef, "other-key"));
  await assert.rejects(f.adapter.status(p.planRef.replace("note-move", "note-replace")));
  assert.equal((await f.adapter.apply(p.planRef, request.idempotencyKey)).outcome, "committed");
  assert.equal((await f.adapter.apply(p.planRef, request.idempotencyKey)).outcome, "committed");
  assert.equal(f.calls(), 1);
  f.disable();
  assert.equal((await f.adapter.status(p.planRef)).outcome, "committed");
  assert.equal((await f.adapter.plan(request)).planRef, p.planRef);
  const receipt = await f.adapter.status(p.planRef);
  for (const field of ["nextContent", "idempotencyKey", "bindingFingerprint", "afterSha256"]) assert.equal(Object.hasOwn(receipt, field), false);
  f.journal.close();
  const reopened = new ObsidianNoteReplaceJournal(f.db);
  f.replies.clear();
  const again = new NativeNoteMoveOperationAdapter(f.backend, reopened, f.authorize);
  const afterRestart = await again.status(p.planRef);
  assert.equal(afterRestart.outcome, "committed");
  assert.equal(afterRestart.graph_postflight, "indeterminate");
  assert.equal(afterRestart.recoveryAllowed, false);
  reopened.close(); assertions++;

  for (const after of [false, true]) {
    const f = setup("lost" + after);
    const p = await f.adapter.plan(request);
    const apply = f.backend.apply;
    f.backend.apply = async value => { if (after) await apply(value); throw new Error("lost response"); };
    assert.equal((await f.adapter.apply(p.planRef, request.idempotencyKey)).outcome, "outcome_unknown");
    assert.equal((await f.adapter.status(p.planRef)).outcome, after ? "committed" : "outcome_unknown");
    await f.adapter.apply(p.planRef, request.idempotencyKey);
    assert.equal(f.calls(), after ? 1 : 0);
    f.journal.close(); assertions++;
  }
  for (const defect of ["identity", "graph", "shape", "binding", "sourceHash"]) {
    const f = setup("invalid" + defect);
    const p = await f.adapter.plan(request);
    const apply = f.backend.apply;
    f.backend.apply = async r => {
      const result = await apply(r);
      if (defect === "identity") result.operationId = "00000000-0000-4000-8000-000000000000";
      if (defect === "graph") Object.assign(result, { graphPostflight: "verified", observedGraphDigest: "0".repeat(64) });
      if (defect === "shape") result.nextContent = "private";
      if (defect === "binding") result.bindingFingerprint = "b".repeat(64);
      if (defect === "sourceHash") delete result.afterSha256;
      return result;
    };
    assert.equal((await f.adapter.apply(p.planRef, request.idempotencyKey)).outcome, "outcome_unknown", defect);
    f.journal.close(); assertions++;
  }
  {
    const f = setup("concurrent"); const p = await f.adapter.plan(request);
    const secondJournal = new ObsidianNoteReplaceJournal(f.db);
    const second = new NativeNoteMoveOperationAdapter(f.backend, secondJournal, f.authorize);
    const results = await Promise.all([f.adapter.apply(p.planRef, request.idempotencyKey), second.apply(p.planRef, request.idempotencyKey)]);
    assert.equal(f.calls(), 1); assert.ok(results.some(r => r.outcome === "committed"));
    secondJournal.close(); f.journal.close(); assertions++;
  }
  {
    const f = setup("planrace"); let release; const held = new Promise(r => { release = r; });
    f.backend.preflight = async () => { await held; return f.plan; };
    const a = f.adapter.plan(request), b = f.adapter.plan(request); release();
    assert.equal((await a).planRef, (await b).planRef);
    f.journal.close(); assertions++;
  }
  {
    const f = setup("crash"); const p = await f.adapter.plan(request);
    f.journal.transition(p.operationId, ["planned"], "applying");
    f.journal.close();
    const journal = new ObsidianNoteReplaceJournal(f.db);
    const adapter = new NativeNoteMoveOperationAdapter(f.backend, journal, f.authorize);
    assert.equal((await adapter.apply(p.planRef, request.idempotencyKey)).outcome, "outcome_unknown");
    assert.equal(f.calls(), 0); journal.close(); assertions++;
  }
  {
    const f = setup("policy"); const p = await f.adapter.plan(request); f.disable();
    await assert.rejects(f.adapter.apply(p.planRef, request.idempotencyKey), /writes disabled/);
    assert.equal((await f.adapter.status(p.planRef)).phase, "planned");
    assert.equal(f.calls(), 0); f.journal.close(); assertions++;
  }
  console.log(`PASS: ${assertions} M3 durable move scenarios; no write from status or replay, shared SQLite ownership and restart reconciliation`);
} finally { rmSync(root, { recursive: true, force: true }); }
