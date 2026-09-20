import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture";
const { BaseRowSelectionReader, baseRowTarget } = await import("../dist/services/baseRowSelection.js");
const { createHash } = await import("node:crypto");
const hash = s => createHash("sha256").update(s).digest("hex");
const target = { baseId: "Views/Work.base", view: "Open", path: "Notes/A.md" };
function fixture() {
  let yaml = "views:\n  - name: Open\n    type: table\n", binding = "a".repeat(64), reads = 0;
  let query = { total: 1, page: 1, rows: [{ file: { path: target.path, name: "A" }, props: {} }], source: "fallback", warnings: [], evaluate: false };
  const transport = {
    async read(baseId) { reads++; return { ok: true, contractVersion: 1, path: baseId, yaml, sha256: hash(yaml), size: Buffer.byteLength(yaml), bindingFingerprint: binding }; },
    async query(baseId, view) { assert.equal(baseId, target.baseId); assert.equal(view, target.view); return structuredClone(query); },
  };
  return { transport, reader: new BaseRowSelectionReader(transport), query: q => { query = q; }, yaml: s => { yaml = s; }, binding: s => { binding = s; }, reads: () => reads };
}
let cases = 0;
{
  const f = fixture(); const p = await f.reader.select(target);
  assert.equal(p.baseId, target.baseId); assert.equal(p.path, target.path);
  assert.equal(p.source, "bases-bridge-supported-filter-snapshot");
  assert.equal(p.freshness, "unknown"); assert.equal(f.reads(), 2);
  assert.equal(JSON.stringify(p).includes("views:"), false); cases++;
}
for (const mutate of [
  q => ({ ...q, total: 501 }),
  q => ({ ...q, total: 2 }),
  q => ({ ...q, warnings: ["unsupported filter"] }),
  q => ({ ...q, source: "engine" }),
  q => ({ ...q, evaluate: true }),
  q => ({ ...q, page: 2 }),
  q => ({ ...q, total: 0, rows: [] }),
  q => ({ ...q, rows: [{ file: { path: "Other/A.md" }, props: {} }] }),
  q => ({ ...q, total: 2, rows: [q.rows[0], q.rows[0]] }),
]) {
  const f = fixture(); const q = await f.transport.query(target.baseId, target.view); f.query(mutate(q));
  await assert.rejects(f.reader.select(target)); cases++;
}
{
  const f = fixture(), query = f.transport.query;
  f.transport.query = async (...args) => { const q = await query(...args); f.yaml("views:\n  - name: Open\n    type: cards\n"); return q; };
  await assert.rejects(f.reader.select(target), /changed/); cases++;
}
{
  const f = fixture(), read = f.transport.read;
  f.transport.read = async (...args) => ({ ...await read(...args), sha256: "b".repeat(64) });
  await assert.rejects(f.reader.select(target)); cases++;
}
for (const yaml of ["views: []\n", "views:\n - name: Open\n - name: Open\n", "views: wrong\n"]) {
  const f = fixture(); f.yaml(yaml); await assert.rejects(f.reader.select(target)); cases++;
}
for (const bad of ["../Work.base", "C:/Work.base", ".obsidian/Work.base", "Views/CON.base", "X.md"]) {
  assert.throws(() => baseRowTarget({ ...target, baseId: bad })); cases++;
}
console.log(`PASS: ${cases} M5 selection fixtures; complete warning-free fallback selection, exact paths, sealed Base/binding and honest freshness`);
