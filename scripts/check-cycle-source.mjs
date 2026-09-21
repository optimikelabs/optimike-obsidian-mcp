import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_SURFACE_REGISTRY, compileToolNames, governedLifecycleRoles } from "../dist/mcp-server/toolSurfaceRegistry.js";
import { compileToolProfileNames } from "../dist/mcp-server/toolProfiles.js";
import { buildCatalog } from "./generate-tool-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const json = name => JSON.parse(read(name));
const cycle = json("docs/cycle-20260920/cycle.json");
const pkg = json("package.json"), lock = json("package-lock.json");
assert.equal(cycle.schemaVersion, 1);
assert.equal(cycle.repository, "optimikelabs/optimike-obsidian-mcp");
assert.equal(cycle.state, "candidate_preparation");
assert.equal(cycle.publishedBaseline.version, "3.8.2");
assert.match(cycle.publishedBaseline.sha, /^[a-f0-9]{40}$/u);
assert.deepEqual(cycle.securityPrerequisite, {
  pr: 93,
  branch: "chore/security-audit-20260920",
  knownCandidateSha: "708d169d92ab1a5749ce7b8b6ac209157aef1963",
  includedInStack: true,
});
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
assert.deepEqual(cycle.milestones.map(m => m.id), ["M2", "M3", "M4", "M5", "M6"]);
assert.equal(new Set(cycle.milestones.map(m => m.branch)).size, 5);
assert.equal(new Set(cycle.milestones.map(m => m.pr)).size, 5);
const expectedMilestoneTools = {
  M2: ["obsidian_note_links"],
  M3: ["obsidian_note_move_plan", "obsidian_note_move_apply", "obsidian_note_move_status"],
  M4: ["obsidian_note_create_plan", "obsidian_note_create_apply", "obsidian_note_create_status"],
  M5: ["bases_rows_patch_plan", "bases_rows_patch_apply", "bases_rows_patch_status"],
  M6: [],
};
const expectedMilestones = {
  M2: { pr: 92, branch: "feat/m2-note-links" },
  M3: { pr: 94, branch: "feat/m3-native-note-move" },
  M4: { pr: 95, branch: "feat/m4-durable-note-create" },
  M5: { pr: 96, branch: "feat/m5-p7-base-rows" },
  M6: { pr: 97, branch: "chore/m6-optimike-cycle-close" },
};
for (let i = 0; i < cycle.milestones.length; i++) {
  const m = cycle.milestones[i];
  assert.equal(m.base, i === 0 ? "main" : cycle.milestones[i - 1].branch);
  assert.ok(Number.isSafeInteger(m.pr) && m.pr > 0);
  assert.equal(m.pr, expectedMilestones[m.id].pr);
  assert.equal(m.branch, expectedMilestones[m.id].branch);
  assert.equal(m.localGate, "NOT_RUN", "This preparation manifest must not fabricate local completion");
  if (m.id === "M6") assert.equal(m.knownCandidateSha, null, "Do not embed a self-referential commit SHA");
  else assert.match(m.knownCandidateSha, /^[a-f0-9]{40}$/u);
  assert.deepEqual(
    m.tools,
    expectedMilestoneTools[m.id],
    `Milestone ${m.id} must retain its exact public tool inventory`,
  );
  for (const name of m.tools) assert.ok(TOOL_SURFACE_REGISTRY.some(t => t.name === name), `Missing ${name}`);
}
const requiredFinalGateKeys = [
  "orderedLocalQualification",
  "m1InstalledFixPreserved",
  "installedExactSha",
  "secureRead",
  "mainTagReleaseAlignment",
];
assert.deepEqual(
  Object.keys(cycle.finalGate).sort(),
  [...requiredFinalGateKeys].sort(),
  "Final gate manifest must retain every mandatory gate and no unknown substitute",
);
for (const key of requiredFinalGateKeys) assert.equal(cycle.finalGate[key], "NOT_RUN");
assert.equal(cycle.expectedSurface.crossRuntime, TOOL_SURFACE_REGISTRY.length);
const requiredLiveProfiles = ["standard", "authoring", "tasks", "full"];
assert.deepEqual(Object.keys(cycle.expectedSurface.liveProfiles).sort(), [...requiredLiveProfiles].sort());
for (const [profile, count] of Object.entries(cycle.expectedSurface.liveProfiles)) {
  assert.equal(compileToolProfileNames({ profile, registrationMode: "live", availableStaticRequirements: ["vault-cache"] }).length, count);
}
const requiredLifecycleFamilies = ["note-move", "note-create", "base-rows"];
assert.deepEqual([...cycle.expectedSurface.threeMemberFamilies].sort(), [...requiredLifecycleFamilies].sort());
for (const family of cycle.expectedSurface.threeMemberFamilies) {
  assert.deepEqual(governedLifecycleRoles(family), ["plan", "apply", "status"]);
}
const nonLiveModes = ["hybrid-degraded", "headless-readonly", "headless-guarded", "headless-filesystem"];
for (const registrationMode of nonLiveModes) {
  const nonLive = compileToolNames({ registrationMode, availableStaticRequirements: ["vault-cache"] });
  for (const m of cycle.milestones) {
    for (const name of m.tools) assert.ok(!nonLive.includes(name), `${name} must remain live-only; leaked into ${registrationMode}`);
  }
}
assert.deepEqual(json("evals/tool-catalog.v1.json"), buildCatalog(), "Regenerate stale tool catalogue");
const requiredContracts = [
  "docs/native-note-move-m3.md",
  "docs/durable-note-create-m4.md",
  "docs/base-row-patch-m5.md",
];
assert.deepEqual(cycle.contracts, requiredContracts, "Cycle manifest must retain the exact M3-M5 contract inventory");
const requiredDocs = [...requiredContracts, "docs/cycle-20260920/CODEX-FINALISATION.md", "docs/cycle-20260920/ROADMAP.md", "docs/cycle-20260920/cycle.json"];
for (const name of requiredDocs) {
  assert.ok(fs.statSync(path.join(root, name)).isFile(), `Missing ${name}`);
  assert.ok(pkg.files.includes(name), `npm package must include ${name}`);
}
for (const bridge of ["obsidian-atomic-write-bridge", "obsidian-bases-bridge", "obsidian-operon-bridge"]) {
  const dir = `plugins/${bridge}`;
  const source = json(`${dir}/manifest.json`), p = json(`${dir}/package.json`), l = json(`${dir}/package-lock.json`);
  assert.equal(source.version, p.version, `${bridge} manifest drift`);
  assert.equal(l.version, p.version); assert.equal(l.packages[""].version, p.version);
  assert.equal(source.isDesktopOnly, true);
}
const forbidden = /(?:offline-workbench|export-cycle-source|audit-lock-probe|(?:apply|prepare|recover)-m[2-6]|m[2-6]-(?:part\d|surface-part|.*integration|review-fixes))/iu;
for (const dir of [".github/workflows", "docs/cycle-20260920"]) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    assert.ok(!forbidden.test(name), `Remove temporary cycle instrumentation: ${dir}/${name}`);
  }
}
for (const name of ["durable-note-create.yml", "base-rows-patch.yml", "cycle-close.yml"]) {
  const workflow = read(`.github/workflows/${name}`);
  assert.match(workflow, /ubuntu-latest/u); assert.match(workflow, /windows-latest/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /contents: write|git\.updateRef|git\.createCommit/u);
}
assert.match(read(".github/workflows/durable-note-create.yml"), /standalone-bridge/u);
assert.match(read("docs/cycle-20260920/ROADMAP.md"), /deferred-trigger/u);
assert.match(read("docs/cycle-20260920/ROADMAP.md"), /abandoned/u);
assert.match(read("docs/cycle-20260920/CODEX-FINALISATION.md"), /M1/u);
assert.match(read("docs/cycle-20260920/CODEX-FINALISATION.md"), /NOT_RUN/u);
console.log(JSON.stringify({
  result: "SOURCE_CHECKS_PASS", packageVersion: pkg.version,
  toolCount: TOOL_SURFACE_REGISTRY.length, profiles: cycle.expectedSurface.liveProfiles,
  localDesktopTestsExecuted: false, releaseAuthorized: false,
  nextGate: "ordered_local_Codex_Pilot2_qualification",
}, null, 2));
