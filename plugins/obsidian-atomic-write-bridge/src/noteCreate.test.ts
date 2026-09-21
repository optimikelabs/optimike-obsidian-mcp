import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExclusiveNoteCreateFiles, NoteCreateExists } from "./exclusiveNoteCreate.js";
import { noteCreateDatePolicy } from "./noteCreatePolicy.js";
import { observeCreateContent, noteCreateHash, validateNoteCreate, createPolicyDigest, type NoteCreatePolicy } from "../../../src/services/noteCreateContract.js";

const empty: NoteCreatePolicy = { version: 1, utcOffsetMinutes: 0, fields: [] };
const started = Date.parse("2026-09-20T10:00:00Z");
const dates: NoteCreatePolicy = { version: 1, utcOffsetMinutes: 0, fields: [
  { pluginId: "update-time", role: "created", propertyName: "created", delayMs: 2250 },
  { pluginId: "update-time", role: "modified", propertyName: "updated", delayMs: 2250 },
] };

test("exclusive create preserves existing bytes and never creates suffixes or missing parents", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "note-create-"));
  try {
    const files = new ExclusiveNoteCreateFiles(root);
    assert.deepEqual(files.inspect("A.md"), { exists: false });
    assert.equal(files.create("A.md", "école\n").sha256, noteCreateHash("école\n"));
    assert.throws(() => files.create("A.md", "overwrite"), NoteCreateExists);
    assert.equal(readFileSync(path.join(root, "A.md"), "utf8"), "école\n");
    assert.deepEqual(readdirSync(root), ["A.md"]);
    assert.throws(() => files.create("absent/B.md", ""));
    assert.throws(() => files.inspect("../outside.md"));
    assert.throws(() => files.create(".obsidian/secret.md", ""));
    assert.equal(files.inspect("A.md").exists, true);
    assert.equal(files.create("Empty.md", "").sha256, noteCreateHash(""));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("physical creation rejects symlink parents and symlink leaves", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "note-create-links-"));
  try {
    mkdirSync(path.join(root, "real"));
    try { symlinkSync(path.join(root, "real"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlink creation not permitted"); return; } throw error; }
    const files = new ExclusiveNoteCreateFiles(root);
    assert.throws(() => files.create("alias/A.md", ""));
    assert.deepEqual(readdirSync(path.join(root, "real")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create settlement reuses strict timestamp evidence for created and modified fields", () => {
  const expected = "---\ntitle: Example\n---\nBody\n";
  const observed = "---\ntitle: Example\ncreated: 2026-09-20T10:00:01\nupdated: 2026-09-20T10:00:02\n---\nBody\n";
  assert.equal(observeCreateContent(expected, observed, dates, started, started + 2500)?.kind, "date-settled");
  assert.equal(observeCreateContent(expected, expected, dates, started, started + 100), undefined);
  assert.equal(observeCreateContent(expected, observed.replace("Body", "Other"), dates, started, started + 2500), undefined);
  assert.equal(observeCreateContent(expected, observed.replace("10:00:01", "11:00:01"), dates, started, started + 2500), undefined);
  assert.equal(observeCreateContent(expected, observed, empty, started, started + 2500), undefined);
  assert.equal(observeCreateContent("x", "x", empty, started, started)?.kind, "exact");
  const preset = expected.replace("title: Example", "title: Example\ncreated: 2020-01-01T00:00:00");
  assert.equal(observeCreateContent(preset, observed, dates, started, started + 2500), undefined);
  assert.throws(() => validateNoteCreate("A.md", "Body only", dates));
  assert.throws(() => validateNoteCreate("A.md", "\uD800", empty));
  assert.throws(() => createPolicyDigest({ ...dates, fields: [dates.fields[0], dates.fields[0]] }));
});

test("date policy reads the existing Bridge contract and rejects unsupported/viewed configurations", () => {
  assert.deepEqual(noteCreateDatePolicy({}, 0), empty);
  const app = { plugins: { plugins: { "update-time": { settings: { saveDelayInSeconds: 2 } } } } };
  assert.equal(noteCreateDatePolicy(app, 0).fields.length, 2);
  const fdm = { plugins: { plugins: { "frontmatter-date-manager": { settings: {
    enableAutoUpdate: true, enableCreateTime: true, enableModifiedTime: true, enableLastViewed: true,
    headerCreated: "created", headerUpdated: "updated", dateFormat: "yyyy-MM-dd'T'HH:mm",
  } } } } };
  assert.throws(() => noteCreateDatePolicy(fdm, 0), /viewed/);
});
