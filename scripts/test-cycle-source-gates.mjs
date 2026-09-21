import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-gates-"));
const sources = [
  "scripts/check-cycle-source.mjs", "scripts/generate-tool-catalog.mjs",
  "dist/mcp-server/toolSurfaceRegistry.js", "dist/mcp-server/toolProfiles.js",
  "docs/cycle-20260920/cycle.json", "docs/cycle-20260920/ROADMAP.md",
  "docs/cycle-20260920/CODEX-FINALISATION.md", "package.json", "package-lock.json",
  "evals/tool-catalog.v1.json", "docs/native-note-move-m3.md",
  "docs/durable-note-create-m4.md", "docs/base-row-patch-m5.md",
  ...["durable-note-create.yml", "base-rows-patch.yml", "cycle-close.yml"].map(f => ".github/workflows/" + f),
  ...["obsidian-atomic-write-bridge", "obsidian-bases-bridge", "obsidian-operon-bridge"].flatMap(b =>
    ["manifest.json", "package.json", "package-lock.json"].map(f => `plugins/${b}/${f}`)),
];
const originals = new Map(sources.map(p => [p, fs.readFileSync(path.join(root, p))]));
const write = (p, bytes) => { const dest = path.join(fixture, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); };
const check = () => spawnSync(process.execPath, ["scripts/check-cycle-source.mjs"], { cwd: fixture, encoding: "utf8", timeout: 15000 });
let negative = 0;
try {
  for (const [p, b] of originals) write(p, b);
  const ok = check(); assert.ifError(ok.error); assert.equal(ok.status, 0, ok.stderr);
  const result = JSON.parse(ok.stdout);
  assert.equal(result.releaseAuthorized, false); assert.equal(result.localDesktopTestsExecuted, false);
  for (const mutate of [
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.expectedSurface.crossRuntime++;write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.finalGate.secureRead="PASS";write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));delete v.finalGate.m1InstalledFixPreserved;write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.milestones[2].base="main";write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.milestones[3].tools=[];write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.publishedBaseline.version="3.9.0";write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.securityPrerequisite.includedInStack=false;write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.milestones[0].pr=999;write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));delete v.expectedSurface.liveProfiles.authoring;write(p, JSON.stringify(v)); },
    () => { const p="docs/cycle-20260920/cycle.json", v=JSON.parse(originals.get(p));v.expectedSurface.threeMemberFamilies=[];write(p, JSON.stringify(v)); },
    () => { const p="package.json", v=JSON.parse(originals.get(p));v.files=v.files.filter(f=>f!=="docs/durable-note-create-m4.md");write(p, JSON.stringify(v)); },
    () => fs.unlinkSync(path.join(fixture,"docs/durable-note-create-m4.md")),
    () => write(".github/workflows/prepare-m6-unremoved.yml", "name: temporary\n"),
    () => { const p="plugins/obsidian-bases-bridge/manifest.json",v=JSON.parse(originals.get(p));v.version="999.0.0";write(p,JSON.stringify(v)); },
  ]) {
    for (const [p, b] of originals) write(p, b);
    fs.rmSync(path.join(fixture,".github/workflows/prepare-m6-unremoved.yml"), { force: true });
    mutate(); const r=check(); assert.ifError(r.error); assert.notEqual(r.status,0,"An invalid cycle preparation must fail closed"); negative++;
  }
  console.log(`PASS: M6 source fixture plus ${negative} negative gates; no fabricated local proof, broken stack, stale surface, omitted contract, instrumentation or version drift`);
} finally { fs.rmSync(fixture,{recursive:true,force:true}); }
