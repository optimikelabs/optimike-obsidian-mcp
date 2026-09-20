import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture";
process.env.MCP_WRITE_MODE = "full";
const { config } = await import("../dist/config/index.js");
const { NoteCreateOperationAdapter, noteCreateFrontmatterKeys } = await import("../dist/services/operations/noteCreateOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { noteCreateHash, createPolicyDigest, observeCreateContent } = await import("../dist/services/noteCreateContract.js");
const root = mkdtempSync(path.join(os.tmpdir(), "create-review-"));
const originalKeys = [...config.mcpProtectedFrontmatterKeys];
const input = { path: "A.md", content: "---\ntitle: Test\n---\nBody\n", idempotencyKey: "once" };
function fixture(name, fields = []) {
  let now = Date.parse("2026-09-20T10:00:00Z"), content, calls = 0;
  const policy = { version: 1, utcOffsetMinutes: 0, fields }, bindingFingerprint = "a".repeat(64), policyDigest = createPolicyDigest(policy);
  const db = path.join(root, name + ".sqlite"), clock = () => now;
  const journal = new ObsidianNoteReplaceJournal(db, { now: clock });
  const backend = {
    async preflight(path) { return { contractVersion: 1, path, bindingFingerprint, policy, policyDigest, absent: true, enabled: true }; },
    async create(r) { calls++; content = r.content; const { content: ignored, ...rest } = r; return { ...rest, outcome: "created", reason: "created" }; },
    async inspect(path) { return { contractVersion: 1, path, bindingFingerprint, exists: content !== undefined,
      ...(content === undefined ? {} : { content, sha256: noteCreateHash(content) }) }; },
  };
  const adapter = new NoteCreateOperationAdapter(backend, journal, clock);
  return { journal, adapter, backend, db, clock, calls: () => calls, tick: n => { now += n; }, set: value => { content = value; } };
}
try {
  for (const content of ["---\nsecret: true\n---\nBody\n", '---\n"SeCrEt": true\n---\nBody\n', "---\ndefaults: &d\n  secret: true\n<<: *d\n---\nBody\n"]) {
    config.mcpProtectedFrontmatterKeys = ["secret"];
    const f = fixture("protected-" + noteCreateHash(content).slice(0, 8));
    try { await assert.rejects(f.adapter.plan({ ...input, content })); assert.equal(f.calls(), 0); }
    finally { f.journal.close(); }
  }
  {
    config.mcpProtectedFrontmatterKeys = [];
    const f = fixture("policy-change");
    try {
      const p = await f.adapter.plan(input); config.mcpProtectedFrontmatterKeys = ["title"];
      await assert.rejects(f.adapter.apply(p.planRef, input.idempotencyKey));
      assert.equal(f.calls(), 0); assert.equal((await f.adapter.status(p.planRef)).phase, "planned");
    } finally { f.journal.close(); }
  }
  {
    const autoFields = [{ pluginId: "update-time", propertyName: "updated", role: "modified", delayMs: 0 }];
    config.mcpProtectedFrontmatterKeys = ["updated"];
    const f = fixture("protected-automatic-plan", autoFields);
    try {
      await assert.rejects(f.adapter.plan(input));
      assert.equal(f.calls(), 0);
    } finally { f.journal.close(); }
  }
  {
    const autoFields = [{ pluginId: "update-time", propertyName: "updated", role: "modified", delayMs: 0 }];
    config.mcpProtectedFrontmatterKeys = [];
    const f = fixture("protected-automatic-apply", autoFields);
    try {
      const p = await f.adapter.plan(input);
      config.mcpProtectedFrontmatterKeys = ["updated"];
      await assert.rejects(f.adapter.apply(p.planRef, input.idempotencyKey));
      assert.equal(f.calls(), 0);
      assert.equal((await f.adapter.status(p.planRef)).phase, "planned");
    } finally { f.journal.close(); }
  }
  assert.deepEqual(noteCreateFrontmatterKeys("Body only\n"), []);
  assert.deepEqual(noteCreateFrontmatterKeys("---\n---\nBody\n"), []);
  assert.throws(() => noteCreateFrontmatterKeys("---\n- not-a-map\n---\n"));
  assert.throws(() => noteCreateFrontmatterKeys("---\nsecret: 1\nsecret: 2\n---\n"));
  config.mcpProtectedFrontmatterKeys = originalKeys;
  const fields = [{ pluginId: "update-time", propertyName: "updated", role: "modified", delayMs: 2250 }];
  const policy = { version: 1, utcOffsetMinutes: 0, fields }, start = Date.parse("2026-09-20T10:00:00Z");
  const changed = input.content.replace("title: Test", "title: Test\nupdated: 2026-09-20T10:00:01");
  assert.equal(observeCreateContent(input.content, changed, policy, start, start + 86400000)?.kind, "date-settled");
  assert.equal(observeCreateContent(input.content, changed.replace("10:00:01", "10:10:01"), policy, start, start + 86400000), undefined);
  assert.equal(observeCreateContent(input.content, changed.replace("Body", "Changed body"), policy, start, start + 86400000), undefined);
  {
    const f = fixture("delayed-restart", fields), p = await f.adapter.plan(input), create = f.backend.create, inspect = f.backend.inspect;
    f.backend.create = async r => { await create(r); f.set(changed); throw new Error("lost reply"); };
    f.backend.inspect = async () => { throw new Error("process stopped before first observation"); };
    assert.equal((await f.adapter.apply(p.planRef, input.idempotencyKey)).outcome, "outcome_unknown");
    f.journal.close(); f.tick(86400000); f.backend.inspect = inspect;
    const reopened = new ObsidianNoteReplaceJournal(f.db, { now: f.clock });
    const adapter = new NoteCreateOperationAdapter(f.backend, reopened, f.clock);
    try {
      assert.equal((await adapter.status(p.planRef)).postflight, "pending");
      f.tick(2500);
      assert.equal((await adapter.status(p.planRef)).outcome, "committed");
      assert.equal((await adapter.apply(p.planRef, input.idempotencyKey)).outcome, "committed");
      assert.equal(f.calls(), 1);
    } finally { reopened.close(); }
  }
  console.log("PASS: M4 configured protected keys at plan/apply, parsed/merged YAML keys and delayed restart date reconciliation with a fixed bounded proof window");
} finally { config.mcpProtectedFrontmatterKeys = originalKeys; rmSync(root, { recursive: true, force: true }); }
