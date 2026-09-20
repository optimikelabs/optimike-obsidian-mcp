import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";
const { NoteCreateOperationAdapter } = await import("../dist/services/operations/noteCreateOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { createPolicyDigest, noteCreateHash } = await import("../dist/services/noteCreateContract.js");
const root = mkdtempSync(path.join(os.tmpdir(), "durable-note-create-"));
const input = { path: "Notes/Exact.md", content: "---\ntitle: Test\n---\n# Exact\nPrivate prose.\n", idempotencyKey: "create-once" };
let cases = 0;
function fixture(name, dateFields = []) {
  let now = Date.parse("2026-09-20T10:00:00Z"), allowed = true, binding = "a".repeat(64), calls = 0;
  let policy = { version: 1, utcOffsetMinutes: 0, fields: dateFields };
  const files = new Map(), db = path.join(root, name + ".sqlite"), clock = () => now;
  const journal = new ObsidianNoteReplaceJournal(db, { now: clock });
  const backend = {
    async preflight(path) {
      if (files.has(path)) throw new Error("target exists");
      return { contractVersion: 1, path, bindingFingerprint: binding, absent: true, enabled: true, policy, policyDigest: createPolicyDigest(policy) };
    },
    async create(request) {
      calls++;
      const conflict = files.has(request.path) || request.bindingFingerprint !== binding || request.policyDigest !== createPolicyDigest(policy);
      if (!conflict) files.set(request.path, request.content);
      const { content, ...ids } = request;
      return { ...ids, bindingFingerprint: binding, outcome: conflict ? "conflict" : "created", reason: conflict ? "precondition_failed" : "exclusive_created" };
    },
    async inspect(path) {
      const content = files.get(path);
      return { contractVersion: 1, path, bindingFingerprint: binding, exists: content !== undefined,
        ...(content !== undefined ? { content, sha256: noteCreateHash(content) } : {}) };
    },
  };
  const authorize = () => { if (!allowed) throw new Error("readonly"); };
  const adapter = new NoteCreateOperationAdapter(backend, journal, clock, authorize);
  return { db, files, backend, journal, adapter, authorize, clock, calls: () => calls,
    tick: n => { now += n; }, disable: () => { allowed = false; }, rebind: () => { binding = "b".repeat(64); },
    policy: value => { policy = value; } };
}
try {
  {
    const f = fixture("nominal"); const p = await f.adapter.plan(input);
    assert.equal(f.calls(), 0); assert.equal((await f.adapter.plan(input)).planRef, p.planRef);
    await assert.rejects(f.adapter.plan({ ...input, content: "different" }));
    await assert.rejects(f.adapter.apply(p.planRef, "wrong"));
    await assert.rejects(f.adapter.status(p.planRef.replace("note-create", "note-replace")));
    const result = await f.adapter.apply(p.planRef, input.idempotencyKey);
    assert.equal(result.outcome, "committed"); assert.equal(result.postflight, "verified");
    assert.equal(result.authorAttribution, "not_proven"); assert.equal(result.recoveryAllowed, false);
    assert.equal(result.effectProof.digest, noteCreateHash(input.content));
    assert.equal(f.journal.get(p.operationId).nextContent, "");
    assert.equal(JSON.stringify(result).includes("Private prose"), false);
    assert.equal(JSON.stringify(result).includes(input.idempotencyKey), false);
    f.disable(); await f.adapter.apply(p.planRef, input.idempotencyKey);
    assert.equal((await f.adapter.plan(input)).planRef, p.planRef);
    f.files.set(input.path, "later edit");
    const drift = await f.adapter.status(p.planRef);
    assert.equal(drift.outcome, "committed"); assert.equal(drift.postflight, "unverified");
    assert.equal(f.calls(), 1); f.journal.close(); cases++;
  }
  {
    const f = fixture("exists"); f.files.set(input.path, "keep");
    await assert.rejects(f.adapter.plan(input)); assert.equal(f.calls(), 0); f.journal.close(); cases++;
  }
  {
    const f = fixture("collision"); const p = await f.adapter.plan(input); f.files.set(input.path, "competing");
    assert.equal((await f.adapter.apply(p.planRef, input.idempotencyKey)).outcome, "conflict");
    await f.adapter.apply(p.planRef, input.idempotencyKey);
    assert.equal(f.files.get(input.path), "competing"); assert.equal(f.calls(), 1); f.journal.close(); cases++;
  }
  for (const after of [false, true]) {
    const f = fixture("loss" + after), p = await f.adapter.plan(input), create = f.backend.create;
    f.backend.create = async req => { if (after) await create(req); throw new Error("reply lost"); };
    const first = await f.adapter.apply(p.planRef, input.idempotencyKey);
    assert.equal(first.outcome, after ? "committed" : "outcome_unknown");
    f.journal.close();
    const reopened = new ObsidianNoteReplaceJournal(f.db, { now: f.clock });
    const adapter = new NoteCreateOperationAdapter(f.backend, reopened, f.clock, f.authorize);
    assert.equal((await adapter.status(p.planRef)).outcome, after ? "committed" : "outcome_unknown");
    await adapter.apply(p.planRef, input.idempotencyKey);
    assert.equal(f.calls(), after ? 1 : 0); reopened.close(); cases++;
  }
  {
    const f = fixture("concurrent"), p = await f.adapter.plan(input);
    const secondJournal = new ObsidianNoteReplaceJournal(f.db, { now: f.clock });
    const second = new NoteCreateOperationAdapter(f.backend, secondJournal, f.clock, f.authorize);
    const results = await Promise.all([f.adapter.apply(p.planRef, input.idempotencyKey), second.apply(p.planRef, input.idempotencyKey)]);
    assert.equal(f.calls(), 1); assert.ok(results.some(r => r.outcome === "committed"));
    secondJournal.close(); f.journal.close(); cases++;
  }
  {
    const f = fixture("different-keys"), p = await f.adapter.plan(input), q = await f.adapter.plan({ ...input, idempotencyKey: "other" });
    const results = await Promise.all([f.adapter.apply(p.planRef, input.idempotencyKey), f.adapter.apply(q.planRef, "other")]);
    assert.deepEqual(results.map(r => r.outcome).sort(), ["committed", "conflict"]);
    assert.equal(f.files.size, 1); f.journal.close(); cases++;
  }
  {
    const f = fixture("readonly"), p = await f.adapter.plan(input); f.disable();
    await assert.rejects(f.adapter.apply(p.planRef, input.idempotencyKey), /readonly/);
    assert.equal(f.calls(), 0); assert.equal((await f.adapter.status(p.planRef)).phase, "planned"); f.journal.close(); cases++;
  }
  {
    const f = fixture("rebind"), p = await f.adapter.plan(input); f.rebind();
    assert.notEqual((await f.adapter.apply(p.planRef, input.idempotencyKey)).outcome, "committed");
    assert.equal(f.files.size, 0); f.journal.close(); cases++;
  }
  {
    const f = fixture("dates", [{ pluginId: "update-time", role: "modified", propertyName: "updated", delayMs: 2250 }]);
    const p = await f.adapter.plan(input);
    assert.equal((await f.adapter.apply(p.planRef, input.idempotencyKey)).postflight, "pending");
    f.files.set(input.path, input.content.replace("title: Test", "title: Test\nupdated: 2026-09-20T10:00:01"));
    f.tick(2500);
    const result = await f.adapter.status(p.planRef);
    assert.equal(result.outcome, "committed"); assert.equal(result.effectProof.details.match, "date-settled");
    assert.equal(f.calls(), 1); f.journal.close(); cases++;
  }
  {
    const fields = [{ pluginId: "update-time", role: "modified", propertyName: "updated", delayMs: 2250 }];
    const f = fixture("lost-reply-policy-change", fields), p = await f.adapter.plan(input), create = f.backend.create;
    f.backend.create = async request => { await create(request); throw new Error("reply lost"); };
    assert.equal((await f.adapter.apply(p.planRef, input.idempotencyKey)).outcome, "outcome_unknown");
    // Reconfiguration/DST after dispatch must not poison exact-byte reconciliation.
    f.policy({ version: 1, utcOffsetMinutes: 60, fields: [] });
    f.tick(2500);
    const result = await f.adapter.status(p.planRef);
    assert.equal(result.outcome, "committed");
    assert.equal(result.effectProof.details.match, "exact");
    assert.equal(f.calls(), 1); f.journal.close(); cases++;
  }
  {
    const f = fixture("legacy-inspection-field"), p = await f.adapter.plan(input), create = f.backend.create, inspect = f.backend.inspect;
    f.backend.create = async request => { await create(request); throw new Error("reply lost"); };
    f.backend.inspect = async path => ({ ...(await inspect(path)), policyDigest: "f".repeat(64) });
    assert.equal((await f.adapter.apply(p.planRef, input.idempotencyKey)).outcome, "committed");
    assert.equal(f.calls(), 1); f.journal.close(); cases++;
  }
  {
    const f = fixture("partial-write"), p = await f.adapter.plan(input);
    f.backend.create = async () => { f.files.set(input.path, "partial"); throw new Error("crash"); };
    assert.equal((await f.adapter.apply(p.planRef, input.idempotencyKey)).outcome, "outcome_unknown");
    await f.adapter.apply(p.planRef, input.idempotencyKey);
    assert.equal(f.files.get(input.path), "partial"); f.journal.close(); cases++;
  }
  {
    const f = fixture("pending-owner"), p = await f.adapter.plan(input);
    f.journal.transition(p.operationId, ["planned"], "applying");
    f.journal.close(); f.files.set(input.path, input.content);
    const reopened = new ObsidianNoteReplaceJournal(f.db, { now: f.clock });
    const adapter = new NoteCreateOperationAdapter(f.backend, reopened, f.clock, f.authorize);
    assert.equal((await adapter.status(p.planRef)).outcome, "committed");
    assert.equal(f.calls(), 0); reopened.close(); cases++;
  }
  {
    const f = fixture("slow-network", [{ pluginId: "update-time", role: "modified", propertyName: "updated", delayMs: 2250 }]);
    const p = await f.adapter.plan(input), create = f.backend.create;
    f.backend.create = async r => { f.tick(10000); return create(r); };
    assert.equal((await f.adapter.apply(p.planRef, input.idempotencyKey)).postflight, "pending");
    f.tick(2500);
    assert.equal((await f.adapter.status(p.planRef)).outcome, "committed");
    assert.equal(f.calls(), 1); f.journal.close(); cases++;
  }
  console.log(`PASS: ${cases} durable create scenarios; exclusive intent, shared journal, lost replies/restart, content-free terminal proof and no mutation from status`);
} finally { rmSync(root, { recursive: true, force: true }); }
