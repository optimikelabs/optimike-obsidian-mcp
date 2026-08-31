import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(file, "utf8");
const readme = read("README.md");
const readmeFr = read("README.fr.md");
const docs = read("docs/operation-cockpit-p5.md");
const docsFr = read("docs/operation-cockpit-p5.fr.md");
const toolSpec = read("docs/obsidian_mcp_tools_spec.md");
const routing = read("src/mcp-server/resources/toolRoutingResource.ts");
const packageJson = JSON.parse(read("package.json"));

for (const source of [readme, readmeFr, docs, docsFr, toolSpec, routing]) {
  assert.match(source, /obsidian_list_pending_operations/u);
}
for (const source of [docs, docsFr]) {
  assert.match(source, /planned/u);
  assert.match(source, /applying/u);
  assert.match(source, /outcome_unknown/u);
  assert.match(source, /Operon/u);
  assert.match(source, /external_move/u);
  assert.match(source, /apply/u);
  assert.match(source, /status/u);
  assert.match(source, /recover/u);
}
assert.match(docs, /never calls a backend/u);
assert.match(docsFr, /n'appelle aucun backend/u);
assert.match(docs, /does not scan other SQLite files/u);
assert.match(docsFr, /ne sonde aucun autre fichier SQLite/u);
assert.match(toolSpec, /81 unique names/u);
assert.match(toolSpec, /77 names/u);
assert.ok(packageJson.files.includes("docs/operation-cockpit-p5.md"));
assert.ok(packageJson.files.includes("docs/operation-cockpit-p5.fr.md"));
assert.equal(
  packageJson.scripts["smoke:operation-cockpit-live"],
  "npm run build && node scripts/smoke-operation-cockpit-live.mjs",
);
for (const fixture of [
  "test-governed-note-replace-mcp.mjs",
  "test-governed-frontmatter-mcp.mjs",
  "test-governed-base-formula-mcp.mjs",
  "test-governed-canvas-mcp.mjs",
]) {
  assert.match(
    packageJson.scripts["test:operation-cockpit"],
    new RegExp(fixture, "u"),
  );
}
for (const source of [docs, docsFr]) {
  assert.match(source, /smoke:operation-cockpit-live/u);
  assert.match(source, /OBSIDIAN_OPERATION_COCKPIT_CANARY_EXPECTED_COMMIT/u);
  assert.match(source, /Pilot 2/u);
  assert.match(source, /Obsidian CLI/u);
  assert.match(source, /modified-time/u);
  assert.match(source, /signal/iu);
}

console.log(
  "PASS: bilingual P5 cockpit docs, routing, package and tool-surface contracts agree",
);
