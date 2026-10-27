import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  noteDeleteDigest, verifyNoteDeletePreflight,
  type NoteDeleteApply, type NoteDeleteBacklink, type NoteDeleteTrashOption,
} from "../../../src/services/noteDeleteContract.js";
import { NoteDeleteBeforeEffectConflict, NoteDeleteService, type NoteDeleteHost } from "./noteDelete.js";

const hash = (value: string) => noteDeleteDigest(value);
const BINDING = "a".repeat(64);

function fixture(options: { backlinks?: NoteDeleteBacklink[]; trash?: NoteDeleteTrashOption | "permanent" | null } = {}) {
  let now = 0;
  let enabled = true;
  let trashOption: NoteDeleteTrashOption | "permanent" | null = "trash" in options ? options.trash! : "local";
  let binding = BINDING;
  let trashCalls = 0;
  let content = "note body";
  let backlinks = options.backlinks ?? [];
  let present = true;
  let trashObservable = true;
  let reoccupy = false;
  let failTrashAfterEffect = false;
  let refuseFence = false;
  const fences: Array<unknown> = [];
  const trashed: Array<{ name: string; sha256: string }> = [{ name: ".trash/Old.md", sha256: hash("older identical-name note") }];
  const host: NoteDeleteHost = {
    binding: () => binding, enabled: () => enabled, trashOption: () => trashOption,
    observe: async (path) => {
      if (!present || path !== "Dir/Old.md") throw new Error("metadata_snapshot_unavailable");
      return { sha256: hash(content), byteLength: Buffer.byteLength(content), backlinks: structuredClone(backlinks) };
    },
    absent: async () => !present && !reoccupy,
    trashCopies: async (_path, sha) =>
      trashObservable ? trashed.filter((entry) => entry.sha256 === sha).map((entry) => entry.name) : [],
    trash: async (plan, fence) => {
      fences.push(fence);
      if (refuseFence) throw new NoteDeleteBeforeEffectConflict();
      const fresh = await host.observe(plan.path).catch(() => { throw new NoteDeleteBeforeEffectConflict(); });
      if (fresh.sha256 !== plan.sha256) throw new NoteDeleteBeforeEffectConflict();
      trashCalls++;
      present = false;
      trashed.push({ name: `.trash/Old ${trashed.length}.md`, sha256: fresh.sha256 });
      if (failTrashAfterEffect) throw new Error("reply_lost");
    },
  };
  const service = new NoteDeleteService(host, () => now);
  async function plan(acknowledge = backlinks.length > 0): Promise<NoteDeleteApply> {
    const p = await service.preflight("Dir/Old.md", acknowledge);
    return { contractVersion: 1, operationId: randomUUID(), path: p.path,
      bindingFingerprint: p.bindingFingerprint, preconditionDigest: p.preconditionDigest };
  }
  return {
    service, plan, host,
    trashCalls: () => trashCalls, tick: (ms: number) => { now += ms; },
    edit: (value: string) => { content = value; },
    link: (value: NoteDeleteBacklink[]) => { backlinks = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    setTrash: (value: NoteDeleteTrashOption | "permanent" | null) => { trashOption = value; },
    setBinding: (value: string) => { binding = value; },
    setReoccupied: () => { reoccupy = true; },
    setTrashObservable: (value: boolean) => { trashObservable = value; },
    failAfterEffect: () => { failTrashAfterEffect = true; },
    refuseFence: () => { refuseFence = true; },
    fences,
    removeBehindOurBack: () => { present = false; },
  };
}

test("preflight seals the exact hash, size, links and trash preference", async () => {
  const f = fixture();
  const p = verifyNoteDeletePreflight(await f.service.preflight("Dir/Old.md", false));
  assert.equal(p.sha256, hash("note body"));
  assert.equal(p.byteLength, 9);
  assert.equal(p.trashOption, "local");
  assert.deepEqual(p.backlinks, []);
});

test("a note with backlinks is refused unless the caller acknowledges them, and the seal covers them", async () => {
  const f = fixture({ backlinks: [{ sourcePath: "Other.md", count: 2 }] });
  await assert.rejects(() => f.service.preflight("Dir/Old.md", false), /note_has_backlinks/u);
  const acknowledged = await f.service.preflight("Dir/Old.md", true);
  assert.deepEqual(acknowledged.backlinks, [{ sourcePath: "Other.md", count: 2 }]);
  const request = await f.plan(true);
  // A new link after the plan changes the sealed neighborhood: refused before any effect.
  f.link([{ sourcePath: "Other.md", count: 2 }, { sourcePath: "New.md", count: 1 }]);
  const observed = await f.service.apply(request);
  assert.equal(observed.outcome, "conflict");
  assert.equal(f.trashCalls(), 0);
});

test("a missing note cannot be planned", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.preflight("Dir/Missing.md", false), /metadata_snapshot_unavailable/u);
  await assert.rejects(() => f.service.preflight("Dir/not-markdown.txt", false), /invalid_note_path/u);
});

test("permanent or unreadable trash preferences and a disabled grant are refused closed", async () => {
  const permanent = fixture({ trash: "permanent" });
  await assert.rejects(() => permanent.service.preflight("Dir/Old.md", false), /trash_preference_permanent/u);
  const unreadable = fixture({ trash: null });
  await assert.rejects(() => unreadable.service.preflight("Dir/Old.md", false), /trash_preference_unavailable/u);
  const disabled = fixture();
  disabled.setEnabled(false);
  await assert.rejects(() => disabled.service.preflight("Dir/Old.md", false), /note_delete_disabled/u);
  // A preference switched to permanent between plan and apply never reaches the effect.
  const switched = fixture();
  const request = await switched.plan();
  switched.setTrash("permanent");
  const observed = await switched.service.apply(request);
  assert.equal(observed.outcome, "conflict");
  assert.equal(switched.trashCalls(), 0);
});

test("a content change after the plan is a conflict before any effect (CAS at effect time)", async () => {
  const f = fixture();
  const request = await f.plan();
  f.edit("note body edited by someone else");
  const observed = await f.service.apply(request);
  assert.equal(observed.outcome, "conflict");
  assert.equal(observed.reason, "precondition_failed_replan_required");
  assert.equal(f.trashCalls(), 0);
});

test("a stale binding is refused before any effect", async () => {
  const f = fixture();
  const request = await f.plan();
  f.setBinding("b".repeat(64));
  assert.equal((await f.service.apply(request)).outcome, "conflict");
  assert.equal(f.trashCalls(), 0);
});

test("apply commits once, a replay never dispatches again, and verification needs a NEW exact copy in the trash", async () => {
  const f = fixture();
  const request = await f.plan();
  const first = await f.service.apply(request);
  assert.equal(first.outcome, "committed");
  assert.equal(first.replayAllowed, false);
  const replay = await f.service.apply(request);
  assert.equal(replay.outcome, "committed");
  assert.equal(f.trashCalls(), 1);
  const status = await f.service.status(request.operationId, request.preconditionDigest);
  assert.equal(status.trashPostflight, "verified");
  assert.equal(status.reason, "absent_and_exact_copy_in_trash");
  // The same operation id with a different request body is an identity conflict, not a second delete.
  await assert.rejects(() => f.service.apply({ ...request, path: "Dir/Other.md" }), /delete_operation_identity_conflict/u);
  assert.equal(f.trashCalls(), 1);
});

test("an older identical copy already in the trash does not verify a delete", async () => {
  const f = fixture();
  const request = await f.plan();
  // Same bytes were already trashed earlier under the same file name.
  (f.host as NoteDeleteHost).trashCopies = async () => [".trash/Old.md"];
  await f.service.apply(request);
  f.tick(6000);
  const status = await f.service.status(request.operationId, request.preconditionDigest);
  assert.notEqual(status.trashPostflight, "verified");
});

test("system trash is reported as path-absent only, never as verified presence in the trash", async () => {
  const f = fixture({ trash: "system" });
  const request = await f.plan();
  f.setTrashObservable(false);
  const first = await f.service.apply(request);
  assert.equal(first.outcome, "committed");
  assert.equal(first.trashOption, "system");
  const status = await f.service.status(request.operationId, request.preconditionDigest);
  assert.equal(status.trashPostflight, "path_absent_only");
});

test("a local trash copy that is not observed stays pending, then indeterminate", async () => {
  const f = fixture();
  const request = await f.plan();
  f.setTrashObservable(false);
  await f.service.apply(request);
  assert.equal((await f.service.status(request.operationId, request.preconditionDigest)).trashPostflight, "pending");
  f.tick(6000);
  assert.equal((await f.service.status(request.operationId, request.preconditionDigest)).trashPostflight, "indeterminate");
});

test("a path reoccupied after the delete fails the postflight", async () => {
  const f = fixture();
  const request = await f.plan();
  await f.service.apply(request);
  f.setReoccupied();
  assert.equal((await f.service.status(request.operationId, request.preconditionDigest)).trashPostflight, "failed");
});

test("an effect whose reply is lost is outcome_unknown and is never replayed", async () => {
  const f = fixture();
  const request = await f.plan();
  f.failAfterEffect();
  const first = await f.service.apply(request);
  assert.equal(first.outcome, "outcome_unknown");
  assert.equal(first.reason, "native_effect_uncertain");
  const replay = await f.service.apply(request);
  assert.equal(replay.outcome, "outcome_unknown");
  assert.equal(f.trashCalls(), 1);
});

test("concurrent applies of two operations never run the effect twice", async () => {
  const f = fixture();
  const a = await f.plan();
  const b = await f.plan();
  const [first, second] = await Promise.all([f.service.apply(a), f.service.apply(b)]);
  const outcomes = [first.outcome, second.outcome].sort();
  assert.equal(f.trashCalls(), 1);
  // One commits; the other is rejected for capacity or conflicts on the already-trashed note.
  assert.ok(outcomes.includes("committed"));
  assert.ok(outcomes.some((value) => value === "rejected" || value === "conflict"));
});

test("a note removed behind our back conflicts instead of reporting a deletion", async () => {
  const f = fixture();
  const request = await f.plan();
  f.removeBehindOurBack();
  assert.equal((await f.service.apply(request)).outcome, "conflict");
  assert.equal(f.trashCalls(), 0);
});

test("status without a backend receipt is honestly unknown", async () => {
  const f = fixture();
  const status = await f.service.status(randomUUID(), "c".repeat(64));
  assert.equal(status.outcome, "outcome_unknown");
  assert.equal(status.reason, "backend_receipt_unavailable");
});

test("the effect fence token reaches the effect point, and a refusing fence leaves the note untouched", async () => {
  const fence = { contractVersion: 1 as const, epoch: randomUUID(), attemptId: randomUUID() };
  const f = fixture();
  const request = { ...(await f.plan()), fence };
  assert.equal((await f.service.apply(request)).outcome, "committed");
  assert.deepEqual(f.fences, [fence]);
  const refused = fixture();
  const refusedRequest = { ...(await refused.plan()), fence };
  refused.refuseFence();
  const observed = await refused.service.apply(refusedRequest);
  assert.equal(observed.outcome, "conflict");
  assert.equal(refused.trashCalls(), 0);
});
