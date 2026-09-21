import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  nativeDigest, nativeGraphDigest, nativeNotePath, sealNativeMove,
  type NativeMoveApply, type NativeSemanticNote,
} from "../../../src/services/nativeNoteMoveContract.js";
import { NativeNoteMoveService, NativeMoveBeforeEffectConflict, type NativeMoveHost } from "./nativeNoteMove.js";

const digest = (value: string) => nativeDigest(value);
function fixture() {
  let now = 0;
  let writes = 0;
  let enabled = true;
  let preference: boolean | null = true;
  let generation = 0;
  let epoch = "first";
  let binding = "a".repeat(64);
  const notes = new Map<string, NativeSemanticNote>();
  notes.set("Old/Source.md", { path: "Old/Source.md", sha256: digest("source"),
    references: [], backlinks: [{ sourcePath: "Back.md", count: 1 }], unresolved: [] });
  notes.set("Back.md", { path: "Back.md", sha256: digest("back"), references: [{
    kind: "link", targetPath: "Old/Source.md", unresolvedPath: null, subpath: "#Heading", anchor: "valid:heading",
  }], backlinks: [], unresolved: [] });
  const host: NativeMoveHost = {
    binding: () => binding, enabled: () => enabled, preference: () => preference,
    clock: () => ({ epoch, resolved: generation }),
    absent: async (path) => !notes.has(path), parentExists: () => true,
    note: async (path) => {
      const note = notes.get(path);
      if (!note) throw new Error("not_found");
      return structuredClone(note);
    },
    rename: async (plan) => {
      if (notes.has(plan.destinationPath) || !notes.has(plan.sourcePath) || preference !== plan.updateLinks) {
        throw new NativeMoveBeforeEffectConflict();
      }
      const barrier = { epoch, resolved: generation };
      const file = notes.get(plan.sourcePath)!;
      notes.delete(plan.sourcePath);
      file.path = plan.destinationPath;
      notes.set(file.path, file);
      for (const note of notes.values()) {
        for (const link of note.references) if (link.targetPath === plan.sourcePath) link.targetPath = plan.destinationPath;
        for (const link of note.backlinks) if (link.sourcePath === plan.sourcePath) link.sourcePath = plan.destinationPath;
      }
      writes++;
      return { afterSha256: file.sha256, barrier };
    },
  };
  const service = new NativeNoteMoveService(host, () => now);
  async function plan(): Promise<NativeMoveApply> {
    const p = await service.preflight("Old/Source.md", "New/Destination.md");
    return { contractVersion: 1, operationId: randomUUID(), sourcePath: p.sourcePath,
      destinationPath: p.destinationPath, bindingFingerprint: p.bindingFingerprint,
      preconditionDigest: p.preconditionDigest };
  }
  return { host, service, notes, plan, writes: () => writes,
    tick: (ms = 101) => { now += ms; }, resolve: () => { generation++; },
    setPreference: (value: boolean | null) => { preference = value; },
    disable: () => { enabled = false; }, rebind: () => { binding = "b".repeat(64); },
    restart: () => { epoch = "second"; generation = 0; } };
}

test("M3 nominal: native completion is not graph completion", async () => {
  const f = fixture(); const p = await f.plan();
  assert.equal((await f.service.apply(p)).outcome, "committed");
  assert.equal((await f.service.status(p.operationId, p.preconditionDigest)).graphPostflight, "pending");
  f.tick(6000);
  assert.equal((await f.service.status(p.operationId, p.preconditionDigest)).graphPostflight, "indeterminate");
  f.resolve();
  assert.equal((await f.service.status(p.operationId, p.preconditionDigest)).graphPostflight, "pending");
  f.tick();
  assert.equal((await f.service.status(p.operationId, p.preconditionDigest)).graphPostflight, "verified");
  assert.equal(f.writes(), 1);
});

test("M3 destination collision and source edit after plan refuse without effect", async () => {
  for (const change of ["collision", "source", "neighbor", "preference", "binding", "gate"]) {
    const f = fixture(); const p = await f.plan();
    if (change === "collision") f.notes.set(p.destinationPath, { ...f.notes.get(p.sourcePath)!, path: p.destinationPath });
    if (change === "source") f.notes.get(p.sourcePath)!.sha256 = digest("source changed");
    if (change === "neighbor") f.notes.get("Back.md")!.sha256 = digest("back changed");
    if (change === "preference") f.setPreference(false);
    if (change === "binding") f.rebind();
    if (change === "gate") f.disable();
    assert.equal((await f.service.apply(p)).outcome, "conflict", change);
    assert.equal(f.writes(), 0, change);
    assert.equal((await f.service.apply(p)).outcome, "conflict", change + " replay");
  }
});

test("M3 OFF rejects linked notes, admits only empty observed neighborhoods", async () => {
  const f = fixture(); f.setPreference(false);
  await assert.rejects(f.plan(), /update_links_disabled/);
  f.notes.get("Old/Source.md")!.backlinks = [];
  const p = await f.plan();
  assert.equal((await f.service.apply(p)).outcome, "committed");
});

test("M3 missing preference never assumes ON", async () => {
  const f = fixture(); f.setPreference(null);
  await assert.rejects(f.plan(), /preference_unavailable/);
  assert.equal(f.writes(), 0);
});

test("M3 lost reply reconciles backend acknowledgement without replay", async () => {
  const f = fixture(); const p = await f.plan();
  await f.service.apply(p); // Deliberately discard the response.
  assert.equal((await f.service.status(p.operationId, p.preconditionDigest)).outcome, "committed");
  assert.equal((await f.service.apply(p)).outcome, "committed");
  assert.equal(f.writes(), 1);
});

test("M3 unknown dispatch is not converted to absence proof or retried", async () => {
  for (const after of [false, true]) {
    const f = fixture(); const p = await f.plan(); const rename = f.host.rename;
    f.host.rename = async (plan) => {
      if (after) await rename(plan);
      throw new Error("unknown transport or native postprocessing error");
    };
    assert.equal((await f.service.apply(p)).outcome, "outcome_unknown");
    assert.equal((await f.service.apply(p)).outcome, "outcome_unknown");
    assert.equal(f.writes(), after ? 1 : 0);
  }
});

test("M3 backend restart cannot manufacture a durable acknowledgement", async () => {
  const f = fixture(); const p = await f.plan(); await f.service.apply(p);
  const restarted = new NativeNoteMoveService(f.host);
  const observed = await restarted.status(p.operationId, p.preconditionDigest);
  assert.equal(observed.outcome, "outcome_unknown");
  assert.equal(observed.replayAllowed, false);
  f.restart();
  assert.equal((await f.service.status(p.operationId, p.preconditionDigest)).graphPostflight, "indeterminate");
});

test("M3 concurrent native calls and identity reuse cannot dispatch twice", async () => {
  const f = fixture(); const p = await f.plan(); const rename = f.host.rename;
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.host.rename = async (plan) => { entered(); await held; return rename(plan); };
  const first = f.service.apply(p); await started;
  assert.equal((await f.service.apply(p)).outcome, "outcome_unknown");
  assert.equal((await f.service.apply({ ...p, operationId: randomUUID() })).outcome, "rejected");
  await assert.rejects(f.service.apply({ ...p, destinationPath: "Elsewhere.md" }), /identity_conflict/);
  release(); assert.equal((await first).outcome, "committed");
  assert.equal(f.writes(), 1);
});

test("M3 homonym and unresolved-to-resolved drift are never verified", async () => {
  for (const mutation of ["homonym", "new-backlink", "unresolved"]) {
    const f = fixture(); const p = await f.plan(); await f.service.apply(p); f.resolve(); f.tick(6000);
    if (mutation === "homonym") f.notes.get("Back.md")!.references[0].targetPath = "Other/Destination.md";
    if (mutation === "new-backlink") f.notes.get(p.destinationPath)!.backlinks.push({ sourcePath: "Formerly unresolved.md", count: 1 });
    if (mutation === "unresolved") f.notes.get(p.destinationPath)!.references.push({ kind: "link", targetPath: "Now found.md", unresolvedPath: null, subpath: "", anchor: "not_requested" });
    const result = await f.service.status(p.operationId, p.preconditionDigest);
    assert.equal(result.outcome, "committed");
    assert.equal(result.graphPostflight, "failed", mutation);
  }
});

test("M3 counts and anchors are in the semantic proof; physical content hashes are not the semantic proof", () => {
  const f = fixture(); const notes = [...f.notes.values()];
  const before = nativeGraphDigest(notes);
  notes[0].sha256 = digest("different physical bytes");
  assert.equal(nativeGraphDigest(notes), before);
  notes[1].references[0].anchor = "invalid";
  assert.notEqual(nativeGraphDigest(notes), before);
});

test("M3 native paths reject traversal, config, devices, ADS and case-only aliases", () => {
  for (const path of ["../X.md", "/X.md", "C:/X.md", "A\\X.md", ".obsidian/X.md", "CON.md", "a/nul.md", "X.md:secret", " a.md", "a. /b.md", "a\0.md"]) {
    assert.throws(() => nativeNotePath(path), /invalid_note_path/, path);
  }
  assert.equal(nativeNotePath("Notes/Énoncé.md"), "Notes/Énoncé.md");
  const f = fixture();
  assert.throws(() => sealNativeMove({ sourcePath: "A.md", destinationPath: "a.md", updateLinks: true,
    bindingFingerprint: "a".repeat(64), notes: [...f.notes.values()] }), /case_only/);
});


test("M3 completed acknowledgements are bounded without permanently exhausting a long-running Bridge", async () => {
  const f = fixture(); f.notes.get("Old/Source.md")!.backlinks = [];
  let source = "Old/Source.md";
  let first: NativeMoveApply | undefined;
  for (let n = 0; n < 140; n++) {
    const destination = `Moved/Note-${n}.md`;
    const plan = await f.service.preflight(source, destination);
    const request: NativeMoveApply = { contractVersion: 1, operationId: randomUUID(), sourcePath: source,
      destinationPath: destination, bindingFingerprint: plan.bindingFingerprint, preconditionDigest: plan.preconditionDigest };
    if (!first) first = request;
    assert.equal((await f.service.apply(request)).outcome, "committed");
    source = destination; f.tick(6000);
  }
  assert.equal(f.writes(), 140);
  assert.equal((await f.service.status(first!.operationId, first!.preconditionDigest)).outcome, "outcome_unknown");
});

test("M3 eviction never discards an uncertain receipt or turns it into a replay", async () => {
  const f = fixture(); const p = await f.plan();
  f.host.rename = async () => { throw new Error("uncertain native effect"); };
  assert.equal((await f.service.apply(p)).outcome, "outcome_unknown");
  f.tick(24 * 60 * 60 * 1000);
  assert.equal((await f.service.apply(p)).outcome, "outcome_unknown");
  assert.equal((await f.service.status(p.operationId, p.preconditionDigest)).outcome, "outcome_unknown");
  assert.equal(f.writes(), 0);
});
