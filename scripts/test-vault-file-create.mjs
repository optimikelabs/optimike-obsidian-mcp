import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";
const { VaultFileCreateOperationAdapter } = await import("../dist/services/operations/vaultFileCreateOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { vaultFileCreateHash } = await import("../dist/services/vaultFileCreateContract.js");
const { publicMcpToolErrorPayload } = await import("../dist/utils/internal/errorHandler.js");

const root = mkdtempSync(path.join(os.tmpdir(), "vault-file-create-"));
const BASE = "filters:\n  and:\n    - file.inFolder(\"Projets\")\nformulas:\n  age: now() - file.ctime\nviews:\n  - type: table\n    name: Projets\n    order:\n      - file.name\n      - formula.age\n";
const CANVAS = JSON.stringify({ nodes: [
  { id: "a1b2c3d4e5f60718", type: "text", text: "Idée", x: 0, y: 0, width: 250, height: 60 },
  { id: "b1b2c3d4e5f60718", type: "file", file: "Projets/Note.md", x: 300, y: 0, width: 400, height: 400 },
], edges: [{ id: "c1b2c3d4e5f60718", fromNode: "a1b2c3d4e5f60718", toNode: "b1b2c3d4e5f60718" }] }, null, "\t");
let cases = 0;

function fixture(name, kind, options = {}) {
  let binding = "a".repeat(64), allowed = true, calls = 0, grant = "grant" in options ? options.grant : { supported: true, enabled: true };
  const files = new Map(), db = path.join(root, name + ".sqlite");
  const journal = new ObsidianNoteReplaceJournal(db);
  const createBinding = () => (kind === "base" ? "b" : "c").repeat(64);
  const backend = {
    kind,
    async status() {
      return { plugin: { id: "obsidian-atomic-write-bridge", version: "0.9.0" }, backend: { bindingFingerprint: binding },
        ...(grant ? { [kind === "base" ? "baseCreate" : "canvasCreate"]: { ...grant, bindingFingerprint: createBinding() } } : {}) };
    },
    async preflight(file) {
      if (!grant) throw Object.assign(new Error("route missing on an older Bridge"), { code: "NOT_FOUND" });
      if (files.has(file)) throw new Error("target exists");
      return { contractVersion: 1, kind, path: file, bindingFingerprint: createBinding(), absent: true, enabled: true };
    },
    async create(request) {
      calls++;
      if (options.loseResponse) { files.set(request.path, request.content); throw new Error("socket hang up"); }
      const conflict = files.has(request.path) || request.bindingFingerprint !== createBinding();
      if (!conflict) files.set(request.path, options.rewrite ? options.rewrite(request.content) : request.content);
      const { content, fence, ...ids } = request;
      return { ...ids, kind, outcome: conflict ? "conflict" : "created", reason: conflict ? "create_precondition_failed" : "exclusive_create_fsynced" };
    },
    async inspect(file) {
      const content = files.get(file);
      return { contractVersion: 1, kind, path: file, bindingFingerprint: createBinding(), exists: content !== undefined,
        ...(content !== undefined ? { content, sha256: vaultFileCreateHash(content) } : {}) };
    },
  };
  const authorize = () => { if (!allowed) throw new Error("readonly"); };
  const adapter = new VaultFileCreateOperationAdapter(backend, journal, Date.now, authorize);
  return { db, files, backend, journal, adapter, calls: () => calls, disable: () => { allowed = false; },
    rebind: () => { binding = "d".repeat(64); }, setGrant: value => { grant = value; } };
}
const reason = code => error => { assert.equal(error.details?.reasonCode, code, error.message); return true; };

try {
  {
    const f = fixture("base-lifecycle", "base");
    const input = { path: "Projets/Vue.base", content: BASE, idempotencyKey: "base-once" };
    const planned = await f.adapter.plan(input);
    assert.equal(planned.phase, "planned");
    assert.equal(planned.operationKind, "obsidian.base.create");
    assert.equal(planned.fileKind, "base");
    assert.match(planned.planRef, /^obsidian-base-create:v1:[0-9a-f-]{36}$/u);
    assert.equal(planned.expectedContentSha256, vaultFileCreateHash(BASE));
    assert.equal(planned.nextAction, "apply");
    assert.equal(f.calls(), 0, "planning never creates the file");
    assert.equal(f.files.size, 0);
    assert.equal((await f.adapter.plan(input)).planRef, planned.planRef, "same key and intent replays the sealed plan");
    await assert.rejects(f.adapter.plan({ ...input, content: BASE + "# changed\n" }), reason("create_idempotency_conflict"));
    await assert.rejects(f.adapter.apply(planned.planRef, "another-key"), reason("create_key_mismatch"));
    const applied = await f.adapter.apply(planned.planRef, input.idempotencyKey);
    assert.equal(applied.outcome, "committed");
    assert.equal(applied.postflight, "verified");
    assert.equal(applied.nextAction, "none");
    assert.equal(f.files.get(input.path), BASE);
    assert.equal((await f.adapter.apply(planned.planRef, input.idempotencyKey)).outcome, "committed");
    assert.equal(f.calls(), 1, "a completed creation is never dispatched twice");
    f.files.set(input.path, BASE + "views: []\n");
    const drifted = await f.adapter.status(planned.planRef);
    assert.equal(drifted.outcome, "committed", "later drift does not revoke the historical receipt");
    assert.equal(drifted.postflight, "unverified");
    f.journal.close();
    const restarted = new VaultFileCreateOperationAdapter(f.backend, new ObsidianNoteReplaceJournal(f.db), Date.now, () => {});
    assert.equal((await restarted.status(planned.planRef)).outcome, "committed", "status survives a process restart");
    cases++;
  }
  {
    const f = fixture("base-format", "base");
    const plan = (content, file = "Vue.base") => f.adapter.plan({ path: file, content, idempotencyKey: "k-" + vaultFileCreateHash(content + file).slice(0, 8) });
    for (const [content, code] of [["views: [unclosed\n", "base-yaml-invalid"], ["- a\n- b\n", "base-not-object"],
      ["# only a comment\n", "base-not-object"], ["views:\n  - type: Not A Type!\n", "base-view-type"]]) {
      await assert.rejects(plan(content), error => {
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.equal(error.details.reasonCode, "create_format_invalid");
        assert.ok(error.details.issues.some(issue => issue.code === code), JSON.stringify(error.details.issues));
        assert.equal(JSON.stringify(error.details).includes("unclosed"), false, "submitted content is never echoed");
        return true;
      });
    }
    await assert.rejects(plan("views: [unclosed\n"), error => {
      // The public boundary keeps the closed reason code and drops issue arrays and messages.
      const payload = JSON.stringify(publicMcpToolErrorPayload(error, { operation: "bases_create_plan", toolName: "bases_create_plan", params: {} }));
      assert.match(payload, /"reasonCode":"create_format_invalid"/u);
      assert.equal(payload.includes("unclosed"), false);
      return true;
    });
    await assert.rejects(plan(""), reason("create_content_invalid"));
    await assert.rejects(plan("﻿views: []\n"), reason("create_content_invalid"));
    await assert.rejects(plan(BASE, "Vue.md"), reason("note_name_extension"));
    await assert.rejects(plan(BASE, "Vue.canvas"), reason("note_name_extension"));
    await assert.rejects(plan(BASE, "Dossier/Vue?.base"), error => error.code === "VALIDATION_ERROR");
    const warned = await plan("filters:\n  and:\n    - file.ext == \"md\"\n");
    assert.deepEqual(warned.formatWarnings.map(item => item.code), ["base-views-missing"]);
    assert.equal(f.calls(), 0);
    f.journal.close(); cases++;
  }
  {
    const f = fixture("canvas-lifecycle", "canvas");
    const plan = (content, key) => f.adapter.plan({ path: "Carte.canvas", content, idempotencyKey: key });
    await assert.rejects(plan("{\"nodes\":[]}", "k1"), error => error.details?.issues?.[0]?.code === "canvas_edges_required");
    const dangling = JSON.stringify({ nodes: [], edges: [{ id: "e", fromNode: "x", toNode: "y" }] });
    await assert.rejects(plan(dangling, "k2"), reason("create_format_invalid"));
    await assert.rejects(plan("{\"nodes\":[],\"edges\":[],}", "k3"), error => error.details?.issues?.[0]?.code === "canvas_json_invalid");
    const planned = await plan(CANVAS, "canvas-once");
    assert.match(planned.planRef, /^obsidian-canvas-create:v1:/u);
    assert.equal(planned.operationKind, "obsidian.canvas.create");
    const done = await f.adapter.apply(planned.planRef, "canvas-once");
    assert.equal(done.outcome, "committed");
    assert.equal(done.postflight, "verified");
    const base = fixture("canvas-cross-kind", "base");
    await assert.rejects(base.adapter.status(planned.planRef), reason("invalid_create_reference"));
    base.journal.close();
    f.journal.close(); cases++;
  }
  {
    const shared = fixture("cross-kind-journal", "base");
    const planned = await shared.adapter.plan({ path: "X.base", content: BASE, idempotencyKey: "same-key" });
    const canvasOnSameJournal = new VaultFileCreateOperationAdapter({ ...shared.backend, kind: "canvas" }, shared.journal, Date.now, () => {});
    const id = planned.planRef.slice("obsidian-base-create:v1:".length);
    await assert.rejects(canvasOnSameJournal.status("obsidian-canvas-create:v1:" + id), reason("create_domain_mismatch"));
    shared.journal.close(); cases++;
  }
  {
    const disabled = fixture("grant-disabled", "base", { grant: { supported: true, enabled: false } });
    await assert.rejects(disabled.adapter.plan({ path: "A.base", content: BASE, idempotencyKey: "g" }), reason("create_preflight_identity_mismatch"));
    disabled.journal.close();
    const old = fixture("bridge-too-old", "canvas", { grant: null });
    await assert.rejects(old.adapter.plan({ path: "A.canvas", content: CANVAS, idempotencyKey: "g" }), reason("create_bridge_unsupported"));
    old.journal.close();
    const readonly = fixture("readonly", "base");
    readonly.disable();
    await assert.rejects(readonly.adapter.plan({ path: "A.base", content: BASE, idempotencyKey: "g" }), /readonly/u);
    readonly.journal.close();
    const revoked = fixture("grant-revoked-before-apply", "base");
    const planned = await revoked.adapter.plan({ path: "A.base", content: BASE, idempotencyKey: "g" });
    revoked.setGrant({ supported: true, enabled: false });
    await assert.rejects(revoked.adapter.apply(planned.planRef, "g"), reason("create_preflight_identity_mismatch"));
    assert.equal(revoked.calls(), 0);
    assert.equal((await revoked.adapter.status(planned.planRef)).phase, "planned");
    revoked.setGrant({ supported: true, enabled: true });
    revoked.rebind();
    await assert.rejects(revoked.adapter.apply(planned.planRef, "g"), reason("create_preflight_identity_mismatch"), "another vault cannot receive the sealed plan");
    assert.equal(revoked.calls(), 0);
    revoked.journal.close(); cases++;
  }
  {
    const lost = fixture("lost-response", "base", { loseResponse: true });
    const planned = await lost.adapter.plan({ path: "A.base", content: BASE, idempotencyKey: "lost" });
    const first = await lost.adapter.apply(planned.planRef, "lost");
    assert.equal(first.outcome, "committed", "status observes the exact bytes after a lost response");
    assert.equal(first.postflight, "verified");
    assert.equal(lost.calls(), 1);
    lost.journal.close();
    const rewritten = fixture("rewritten", "canvas", { rewrite: content => content.replace(/\t/gu, "  ") });
    const p = await rewritten.adapter.plan({ path: "A.canvas", content: CANVAS, idempotencyKey: "rw" });
    const unknown = await rewritten.adapter.apply(p.planRef, "rw");
    assert.equal(unknown.outcome, "outcome_unknown", "no rewrite is excused");
    assert.equal(unknown.nextAction, "status");
    assert.equal(unknown.applyAllowed, false);
    assert.equal(rewritten.files.get("A.canvas").includes("\t"), false, "the observed file is never overwritten");
    assert.equal((await rewritten.adapter.apply(p.planRef, "rw")).outcome, "outcome_unknown");
    assert.equal(rewritten.calls(), 1, "an uncertain creation is never replayed");
    rewritten.journal.close();
    const occupied = fixture("occupied", "base");
    const q = await occupied.adapter.plan({ path: "A.base", content: BASE, idempotencyKey: "occ" });
    occupied.files.set("A.base", "views: []\n");
    const conflict = await occupied.adapter.apply(q.planRef, "occ");
    assert.equal(conflict.outcome, "conflict");
    assert.equal(occupied.files.get("A.base"), "views: []\n");
    occupied.journal.close(); cases++;
  }
  console.log(`vault file create: ${cases} groups passed`);
} finally {
  // An open SQLite handle after a failed assertion must not hide that failure on Windows.
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
