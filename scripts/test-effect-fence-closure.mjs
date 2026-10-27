// Run with: node --experimental-strip-types scripts/test-effect-fence-closure.mjs
// The fake Bridge below uses the real Atomic Write Bridge fence (TypeScript source)
// so this test exercises the same admission/revocation code as Obsidian.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EffectFence,
  EffectFenceRefused,
  LEGACY_QUIESCENCE_MS,
} from "../plugins/obsidian-atomic-write-bridge/src/effectFence.ts";

process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";
const { ObsidianNoteReplaceOperationAdapter } = await import("../dist/services/operations/obsidianNoteReplaceOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { NoteCreateOperationAdapter } = await import("../dist/services/operations/noteCreateOperationAdapter.js");
const { NOTE_CREATE_PREFIX, createPolicyDigest, noteCreateHash } = await import("../dist/services/noteCreateContract.js");
const { OperationCockpit } = await import("../dist/services/operationCockpit.js");
const { BaseErrorCode, McpError } = await import("../dist/types-global/errors.js");

let closureModule;
try {
  closureModule = await import("../dist/services/operations/administrativeClosure.js");
} catch {
  closureModule = undefined;
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const REF = "obsidian-note-replace:v1:";
const LEASE_MS = 120_000;

/** Minimal Atomic Write Bridge: CAS through the real effect fence. */
class FencedBridge {
  bindingFingerprint = sha256("fixture-vault-instance");
  createBinding = sha256("fixture-create-route");
  path = "Fixture/Note.md";
  content = "corps avant\n";
  replaceCalls = 0;
  resolveCalls = 0;
  fenceSupported = true;
  requireFence = false;
  beforeEffect = undefined;
  duringEffect = undefined;
  loseResponseAfterEffect = false;
  afterResolve = undefined;
  realm = { epochs: [] };

  constructor(clock) {
    this.clock = clock;
    this.fence = this.newFence();
  }

  newFence() {
    return new EffectFence({ requireFence: () => this.requireFence, now: () => this.clock.now, registry: this.realm });
  }

  /** Plugin reload in the same realm: old instance closed, new epoch. */
  reloadPlugin() { this.fence.dispose(); this.fence = this.newFence(); }
  /** Obsidian restart: the realm and every pending handler disappear. */
  restartObsidian() { this.realm = { epochs: [] }; this.fence = this.newFence(); }
  setRequireFence(value) { this.requireFence = value; this.fence.requireFenceChanged(); }

  async status() {
    return {
      ok: true, contractVersion: 1, plugin: { id: "obsidian-atomic-write-bridge", version: "0.8.4" },
      frontmatterFormat: { contractVersion: 1, supported: true },
      backend: { kind: "obsidian-vault-process", bindingFingerprint: this.bindingFingerprint, atomicCas: true, writeEnabled: true },
      limits: { markdownOnly: true },
      noteCreate: { supported: true, enabled: true, bindingFingerprint: this.createBinding },
      ...(this.fenceSupported ? { effectFence: this.fence.capability() } : {}),
    };
  }

  async read(payload) {
    assert.equal(payload.path, this.path);
    return { ok: true, contractVersion: 1, path: this.path, content: this.content, sha256: sha256(this.content),
      size: Buffer.byteLength(this.content, "utf8"), bindingFingerprint: this.bindingFingerprint };
  }

  async replace(payload) {
    this.replaceCalls += 1;
    if (!this.fenceSupported && payload.fence) throw new McpError(BaseErrorCode.VALIDATION_ERROR, "old bridge rejects unknown keys");
    if (this.beforeEffect) { const hook = this.beforeEffect; this.beforeEffect = undefined; await hook(); }
    // vault.process callback: CAS then fence, synchronously, then the write.
    if (sha256(this.content) !== payload.expectedSha256) throw new McpError(BaseErrorCode.CONFLICT, "hash conflict");
    let settle;
    try { settle = this.fenceSupported ? this.fence.enter(payload.fence) : () => undefined; }
    catch (error) {
      if (error instanceof EffectFenceRefused) throw new McpError(BaseErrorCode.FORBIDDEN, "fence", { reasonCode: "effect_fence_refused" });
      throw error;
    }
    try {
      if (this.duringEffect) { const hook = this.duringEffect; this.duringEffect = undefined; await hook(); }
      this.content = payload.nextContent;
    } finally { settle(); }
    if (this.loseResponseAfterEffect) throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "response lost");
    return { ok: true, contractVersion: 1, path: this.path, beforeSha256: payload.expectedSha256,
      afterSha256: sha256(this.content), size: Buffer.byteLength(this.content, "utf8"), bindingFingerprint: this.bindingFingerprint };
  }

  async resolveEffectFence(request) {
    this.resolveCalls += 1;
    if (!this.fenceSupported) throw new McpError(BaseErrorCode.NOT_FOUND, "route absent");
    assert.equal(request.bindingFingerprint, this.bindingFingerprint);
    const response = {
      ok: true, contractVersion: 1, bindingFingerprint: this.bindingFingerprint, epoch: this.fence.epoch, mode: request.mode,
      results: request.attempts.map((attempt) => ({ ...attempt, ...this.fence.resolve(attempt, request.mode) })),
      ...(request.includeLegacy ? { legacy: this.fence.legacy() } : {}),
    };
    if (this.afterResolve) { const hook = this.afterResolve; this.afterResolve = undefined; await hook(); }
    return response;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "optimike-effect-fence-"));
const journals = [];

function fixture() {
  const clock = { now: Date.parse("2026-10-27T10:00:00Z") };
  const bridge = new FencedBridge(clock);
  const db = path.join(root, `${randomUUID()}.sqlite`);
  const open = () => {
    const journal = new ObsidianNoteReplaceJournal(db, { now: () => clock.now, executionLeaseMs: LEASE_MS });
    journals.push(journal);
    return journal;
  };
  const f = {
    clock, bridge, db,
    advance(ms) { clock.now += ms; },
    journal: open(),
    build() {
      f.adapter = new ObsidianNoteReplaceOperationAdapter(bridge, f.journal, undefined, { now: () => clock.now });
      if (closureModule) {
        f.closure = new closureModule.AdministrativeClosureService(f.journal, bridge, [{
          operationKind: "obsidian.note.replace", planRefPrefix: REF,
          binding: (status) => status?.backend?.bindingFingerprint,
          reconcile: (id) => f.adapter.status(REF + id),
          observe: async (row) => ({ kind: "note-sha256", sha256: sha256(bridge.content),
            matches: sha256(bridge.content) === row.afterSha256 ? "after" : sha256(bridge.content) === row.beforeSha256 ? "before" : "neither" }),
        }], ["obsidian-canvas-patch:v1:"], () => clock.now);
      }
    },
    restartMcp() { f.journal.close(); f.journal = open(); f.build(); },
    plan(key = "test") { return f.adapter.plan({ path: bridge.path, nextContent: "corps après\n", idempotencyKey: key }); },
    close(planRef, dryRun = false) { return f.closure.closeOperation(planRef, { dryRun, reasonCode: "operator_review" }); },
  };
  f.build();
  return f;
}

/** What a journal-only closure would do (the design refused by lot C). */
function journalOnlyClosure(db, operationId) {
  const sqlite = new DatabaseSync(db);
  try {
    sqlite.prepare("UPDATE obsidian_note_replace_plans SET status = 'reviewed_unverified' WHERE operation_id = ? AND status = 'outcome_unknown'").run(operationId);
  } finally { sqlite.close(); }
}

try {
  // 1. Lot C race: the write is suspended in the Bridge before its effect point,
  // the lease expires, the journal says outcome_unknown, the owner closes, then
  // the request resumes. The closed operation must never change the note.
  {
    const f = fixture();
    const p = await f.plan();
    let closure;
    f.bridge.beforeEffect = async () => {
      f.advance(LEASE_MS + 1);
      assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
      if (closureModule) closure = await f.close(p.planRef);
      else journalOnlyClosure(f.db, p.operationId);
    };
    await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(f.bridge.replaceCalls, 1);
    assert.equal(f.bridge.content, "corps avant\n", "late effect after administrative closure: the race of lot C is open");
    assert.equal(closure.result, "closed");
    assert.equal(closure.evidence.priorEffect, "none");
    assert.equal(closure.evidence.attempts.length, 1);
    assert.equal(closure.evidence.attempts[0].verdict, "revoked_before_effect");
    const row = f.journal.get(p.operationId);
    assert.equal(row.status, "reviewed_unverified");
    assert.equal(row.nextContent, "");
    assert.equal(row.administrativeClosure.guarantee, "no_further_effect");
    assert.equal((await f.adapter.status(p.planRef)).outcome, "reviewed_unverified");
    assert.equal((await f.adapter.recover(p.planRef, "test")).outcome, "reviewed_unverified");
    assert.equal(f.bridge.replaceCalls, 1, "a closed operation is never replayed");
  }

  // 2. Effect point already passed: closure refused while running and while
  // settling, then allowed with an honest "may have occurred".
  {
    const f = fixture();
    const p = await f.plan();
    let refusedInProgress;
    f.bridge.duringEffect = async () => {
      f.advance(LEASE_MS + 1);
      refusedInProgress = await f.close(p.planRef);
    };
    f.bridge.loseResponseAfterEffect = true;
    await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(refusedInProgress.result, "refused");
    assert.equal(refusedInProgress.reasonCode, "closure_effect_in_progress");
    assert.equal(refusedInProgress.retryable, true);
    assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
    assert.equal(f.bridge.content, "corps après\n");
    // A qualified status reconciles the exact effect before any closure.
    const reconciled = await f.close(p.planRef);
    assert.equal(reconciled.result, "not_needed");
    assert.equal(reconciled.outcome, "committed");
  }
  {
    const f = fixture();
    const p = await f.plan();
    f.bridge.loseResponseAfterEffect = true;
    f.bridge.duringEffect = async () => { f.advance(LEASE_MS + 1); };
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.bridge.content = "édition concurrente\n";
    const settling = await f.close(p.planRef);
    assert.equal(settling.reasonCode, "closure_effect_settling");
    assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
    f.advance(60_000);
    const closed = await f.close(p.planRef);
    assert.equal(closed.result, "closed");
    assert.equal(closed.evidence.priorEffect, "may_have_occurred");
    assert.equal(closed.evidence.attempts[0].verdict, "effect_settled");
    assert.deepEqual(closed.evidence.observation, { kind: "note-sha256", sha256: sha256("édition concurrente\n"), matches: "neither" });
    // Idempotent replay: no new Bridge revocation, same evidence.
    const calls = f.bridge.resolveCalls;
    const again = await f.close(p.planRef);
    assert.equal(again.result, "already_closed");
    assert.deepEqual(again.evidence, closed.evidence);
    assert.equal(f.bridge.resolveCalls, calls);
  }

  // 3. Old Bridge without fence capability: unfenced dispatch, closure refused.
  {
    const f = fixture();
    f.bridge.fenceSupported = false;
    const p = await f.plan();
    f.bridge.loseResponseAfterEffect = true;
    f.bridge.duringEffect = async () => { f.advance(LEASE_MS + 1); };
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.bridge.content = "autre\n";
    const row = f.journal.get(p.operationId);
    assert.equal(row.status, "outcome_unknown");
    assert.equal(row.effectTracking.attempts.length, 1);
    assert.equal(row.effectTracking.attempts[0].epoch, undefined, "no token can be sent to an old Bridge");
    const refused = await f.close(p.planRef);
    assert.equal(refused.reasonCode, "closure_fence_capability_missing");
    assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");

    // Upgrade: unfenced (legacy) attempts need the Bridge to refuse unfenced writes.
    f.bridge.fenceSupported = true;
    f.bridge.restartObsidian();
    assert.equal((await f.close(p.planRef)).reasonCode, "closure_legacy_requires_fence_requirement");
    f.bridge.setRequireFence(true);
    assert.equal((await f.close(p.planRef)).reasonCode, "closure_legacy_quiescence_pending");
    // An unfenced write already past its effect point keeps the realm non-quiescent.
    f.bridge.setRequireFence(false);
    const legacySettle = f.bridge.fence.enter(undefined);
    f.bridge.setRequireFence(true);
    f.advance(LEGACY_QUIESCENCE_MS);
    assert.equal((await f.close(p.planRef)).reasonCode, "closure_legacy_quiescence_pending");
    legacySettle();
    const dry = await f.close(p.planRef, true);
    assert.equal(dry.result, "would_close");
    assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
    const closed = await f.close(p.planRef);
    assert.equal(closed.result, "closed");
    assert.equal(closed.evidence.priorEffect, "unknown");
    assert.deepEqual(closed.evidence.legacy, { requireFence: true, strictForMs: LEGACY_QUIESCENCE_MS, unfencedInFlight: 0 });
  }

  // 4. Historical row (no effect tracking at all, as written by 3.14 and older).
  {
    const f = fixture();
    const p = await f.plan();
    f.bridge.beforeEffect = async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "lost"); };
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.advance(LEASE_MS + 1);
    const sqlite = new DatabaseSync(f.db);
    const stored = JSON.parse(sqlite.prepare("SELECT payload_json FROM obsidian_note_replace_plans WHERE operation_id = ?").get(p.operationId).payload_json);
    delete stored.effectTracking;
    sqlite.prepare("UPDATE obsidian_note_replace_plans SET payload_json = ? WHERE operation_id = ?").run(JSON.stringify(stored), p.operationId);
    sqlite.close();
    f.restartMcp();
    f.bridge.content = "dérive\n";
    assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
    assert.equal((await f.close(p.planRef)).reasonCode, "closure_legacy_requires_fence_requirement");
    f.bridge.setRequireFence(true);
    f.advance(LEGACY_QUIESCENCE_MS);
    const closed = await f.close(p.planRef);
    assert.equal(closed.result, "closed");
    assert.deepEqual(closed.evidence.attempts, []);
    assert.equal(closed.evidence.priorEffect, "unknown");
  }

  // 5. Restart of the MCP and of Obsidian between dispatch and closure.
  {
    const f = fixture();
    const p = await f.plan();
    f.bridge.beforeEffect = async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "lost before effect, unknown to MCP"); };
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.advance(LEASE_MS + 1);
    f.restartMcp();
    assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
    const token = f.journal.get(p.operationId).effectTracking.attempts[0];
    f.bridge.reloadPlugin();
    assert.throws(() => f.bridge.fence.enter({ contractVersion: 1, ...token }), (error) => error instanceof EffectFenceRefused);
    const afterReload = await f.close(p.planRef, true);
    assert.equal(afterReload.evidence.attempts[0].verdict, "revoked_before_effect");
    f.bridge.restartObsidian();
    const closed = await f.close(p.planRef);
    assert.equal(closed.result, "closed");
    assert.equal(closed.evidence.attempts[0].verdict, "epoch_unknown");
    assert.equal(closed.evidence.priorEffect, "unknown");
  }

  // 6. Concurrency: a recovery that starts between revocation and closure wins;
  // two simultaneous closures produce one closure and one idempotent replay.
  {
    const f = fixture();
    const p = await f.plan();
    f.bridge.beforeEffect = async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "lost"); };
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.advance(LEASE_MS + 1);
    assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
    f.bridge.afterResolve = async () => { f.journal.transition(p.operationId, ["outcome_unknown"], "applying"); };
    const raced = await f.close(p.planRef);
    assert.equal(raced.result, "refused");
    assert.equal(raced.reasonCode, "closure_state_changed");
    assert.equal(f.journal.get(p.operationId).status, "applying");
    assert.equal(f.bridge.content, "corps avant\n");
  }
  {
    const f = fixture();
    const p = await f.plan();
    f.bridge.beforeEffect = async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "lost"); };
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.advance(LEASE_MS + 1);
    const results = await Promise.all([f.close(p.planRef), f.close(p.planRef)]);
    assert.deepEqual(results.map((item) => item.result).sort(), ["already_closed", "closed"]);
    assert.equal(f.journal.get(p.operationId).status, "reviewed_unverified");
  }

  // 7. A stale executor that lost its lease before recording its token never dispatches.
  {
    const f = fixture();
    const p = await f.plan();
    const status = f.bridge.status.bind(f.bridge);
    let sweptBeforeDispatch = false;
    f.bridge.status = async () => {
      const result = await status();
      if (!sweptBeforeDispatch && f.journal.get(p.operationId)?.status === "applying") {
        sweptBeforeDispatch = true;
        f.advance(LEASE_MS + 1);
        assert.equal(f.journal.get(p.operationId).status, "outcome_unknown");
      }
      return result;
    };
    await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(f.bridge.replaceCalls, 0);
    const closed = await f.close(p.planRef);
    assert.equal(closed.result, "closed");
    assert.equal(closed.evidence.priorEffect, "none");
  }

  // 8. Closure refusals that must leave everything unchanged.
  {
    const f = fixture();
    const planned = await f.plan();
    assert.equal((await f.close(planned.planRef)).reasonCode, "closure_not_applicable");
    assert.equal((await f.close("obsidian-canvas-patch:v1:" + randomUUID())).reasonCode, "closure_operation_kind_unsupported");
    assert.equal((await f.close(REF + "nope")).reasonCode, "closure_plan_ref_invalid");
    assert.equal((await f.close(REF + randomUUID())).reasonCode, "closure_plan_not_found");
    f.bridge.beforeEffect = async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "lost"); };
    await f.adapter.apply(planned.planRef, "test", "deferred");
    f.advance(LEASE_MS + 1);
    const otherBinding = sha256("another-vault");
    const statusBefore = f.bridge.status.bind(f.bridge);
    f.bridge.status = async () => ({ ...(await statusBefore()), backend: { ...(await statusBefore()).backend, bindingFingerprint: otherBinding } });
    assert.equal((await f.close(planned.planRef)).reasonCode, "closure_binding_mismatch");
    f.bridge.status = async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "down"); };
    assert.equal((await f.close(planned.planRef)).reasonCode, "closure_bridge_unavailable");
    assert.equal(f.journal.get(planned.planRef.slice(REF.length)).status, "outcome_unknown");
    const cockpit = new OperationCockpit([{ listPendingOperationRows: (input) => f.journal.listPendingOperationRows({ ...input,
      fallbackOperationKind: "obsidian.note.replace", admittedProjectionKinds: ["obsidian.note.create"], allowUnprojectedFallback: true }) }],
    () => f.clock.now);
    assert.equal(cockpit.list().operations[0].closeAllowed, true);
  }

  // 9. Date preparation lock (lot B): released only through the same fence.
  {
    const f = fixture();
    const key = closureModule.datePreparationLockKey(f.bridge.path, f.bridge.bindingFingerprint);
    const attempt = f.journal.acquireDatePreparationFence(key, f.bridge.fence.epoch);
    const release = (dryRun = false) => f.closure.releaseDatePreparationLock(f.bridge.path, { dryRun, reasonCode: "operator_review" });
    // The preparation reached its effect point and is still running.
    const settle = f.bridge.fence.enter({ contractVersion: 1, epoch: f.bridge.fence.epoch, attemptId: attempt });
    assert.equal((await release()).reasonCode, "closure_effect_in_progress");
    assert.equal(f.journal.hasDatePreparationFence(key), true);
    settle();
    assert.equal((await release()).reasonCode, "closure_effect_settling");
    f.advance(60_000);
    assert.equal((await release(true)).result, "would_close");
    assert.equal(f.journal.hasDatePreparationFence(key), true);
    const released = await release();
    assert.equal(released.result, "closed");
    assert.equal(released.evidence.priorEffect, "may_have_occurred");
    assert.equal(f.journal.hasDatePreparationFence(key), false);
    assert.equal((await release()).result, "already_closed");
    // A queued preparation that never reached its effect point is revoked forever.
    const second = f.journal.acquireDatePreparationFence(key, f.bridge.fence.epoch);
    const revoked = await release();
    assert.equal(revoked.evidence.priorEffect, "none");
    assert.throws(() => f.bridge.fence.enter({ contractVersion: 1, epoch: f.bridge.fence.epoch, attemptId: second }), (error) => error instanceof EffectFenceRefused);
    // A lock without token (Bridge without fence at dispatch time) needs legacy quiescence.
    f.journal.acquireDatePreparationFence(key);
    assert.equal((await release()).reasonCode, "closure_legacy_requires_fence_requirement");
    f.bridge.setRequireFence(true);
    f.advance(LEGACY_QUIESCENCE_MS);
    assert.equal((await release()).result, "closed");
    assert.equal((await f.closure.releaseDatePreparationLock("../escape.md", { dryRun: true, reasonCode: "operator_review" })).reasonCode, "closure_path_invalid");
  }

  // 10. Exclusive note creation: token recorded and sent, closure after settlement.
  {
    const f = fixture();
    const policy = { version: 1, utcOffsetMinutes: 0, fields: [] };
    const createdPath = "Fixture/Nouvelle.md";
    let created;
    let createRequest;
    const createBackend = {
      status: () => f.bridge.status(),
      inspectFrontmatterFormat: async () => { throw new Error("not used"); },
      preflight: async (pathValue) => ({ contractVersion: 1, path: pathValue, bindingFingerprint: f.bridge.createBinding, absent: true, enabled: true, policy, policyDigest: createPolicyDigest(policy) }),
      create: async (request) => {
        createRequest = request;
        const settle = f.bridge.fence.enter(request.fence);
        try { created = request.content; } finally { settle(); }
        throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "response lost");
      },
      inspect: async (pathValue) => created === undefined
        ? { contractVersion: 1, path: pathValue, bindingFingerprint: f.bridge.createBinding, exists: false }
        : { contractVersion: 1, path: pathValue, bindingFingerprint: f.bridge.createBinding, exists: true, content: created + "dérive\n", sha256: noteCreateHash(created + "dérive\n") },
    };
    const creates = new NoteCreateOperationAdapter(createBackend, f.journal, () => f.clock.now, () => undefined);
    const service = new closureModule.AdministrativeClosureService(f.journal, f.bridge, [{
      operationKind: "obsidian.note.create", planRefPrefix: NOTE_CREATE_PREFIX,
      binding: (status) => status?.noteCreate?.bindingFingerprint,
      reconcile: (id) => creates.status(NOTE_CREATE_PREFIX + id),
      observe: async () => ({ kind: "unavailable" }),
    }], [], () => f.clock.now);
    const planned = await creates.plan({ path: createdPath, content: "Bonjour\n", idempotencyKey: "create" });
    const applied = await creates.apply(planned.planRef, "create");
    assert.equal(applied.outcome, "outcome_unknown");
    assert.equal(createRequest.fence.epoch, f.bridge.fence.epoch);
    const id = planned.planRef.slice(NOTE_CREATE_PREFIX.length);
    assert.equal(f.journal.get(id).effectTracking.attempts[0].attemptId, createRequest.fence.attemptId);
    const close = () => service.closeOperation(planned.planRef, { dryRun: false, reasonCode: "historical_cleanup" });
    assert.equal((await close()).reasonCode, "closure_effect_settling");
    f.advance(60_000);
    const closed = await close();
    assert.equal(closed.result, "closed");
    assert.equal(closed.evidence.priorEffect, "may_have_occurred");
    assert.equal(closed.evidence.reasonCode, "historical_cleanup");
    const receipt = await creates.status(planned.planRef);
    assert.equal(receipt.outcome, "reviewed_unverified");
    assert.equal(receipt.nextAction, "none");
  }

  console.log("PASS effect fence closure: lot C race closed, in-progress/settling refusals, old Bridge, legacy quiescence, historical rows, restarts, concurrency, stale executor, refusals, FDM preparation lock, exclusive create");
} finally {
  for (const journal of journals) {
    try { journal.close(); } catch { /* already closed */ }
  }
  rmSync(root, { recursive: true, force: true });
}
