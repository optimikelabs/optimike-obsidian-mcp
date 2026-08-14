import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

async function text(path) {
  return readFile(path, "utf8");
}

const tools = [
  "obsidian_note_replace_plan",
  "obsidian_note_replace_apply",
  "obsidian_note_replace_status",
  "obsidian_note_replace_recover",
];

const surface = await text("docs/obsidian_mcp_tools_spec.md");
const matrix = await text("docs/runtime-capability-matrix.md");
const matrixFr = await text("docs/runtime-capability-matrix.fr.md");
const readme = await text("README.md");
const readmeFr = await text("README.fr.md");
const adr = await text("docs/adr/ADR-Common-Operation-Runtime.md");
const contract = await text("docs/governed-note-replacement.md");
const contractFr = await text("docs/governed-note-replacement.fr.md");
const liveCanary = await text("scripts/smoke-atomic-note-mcp-live.mjs");
const operations = await text("OPERATIONS.md");
const operationsFr = await text("OPERATIONS.fr.md");
const pkg = JSON.parse(await text("package.json"));

for (const tool of tools) {
  assert.ok(surface.includes(`\`${tool}\``), `tool surface omits ${tool}`);
  assert.ok(matrix.includes(`\`${tool}\``), `runtime matrix omits ${tool}`);
  assert.ok(matrixFr.includes(`\`${tool}\``), `French matrix omits ${tool}`);
}

assert.match(surface, /Recovery is not undo/i);
assert.match(surface, /No generic public `operation_\*` surface/i);
assert.match(adr, /exact-plan reconciliation(?:\/| or )resumption/i);
assert.match(adr, /outside that boundary/i);
assert.match(contract, /not undo/i);
assert.match(contractFr, /n[’']est pas `?undo`?/i);
assert.match(readme, /test:governed-note-replace-mcp/);
assert.match(readmeFr, /test:governed-note-replace-mcp/);
assert.equal(
  pkg.scripts["test:governed-note-replace-mcp"],
  "npm run build && node scripts/test-governed-note-replace-mcp.mjs",
);
assert.equal(
  pkg.scripts["smoke:atomic-note-mcp-live"],
  "npm run build && node scripts/smoke-atomic-note-mcp-live.mjs",
);
assert.equal(
  pkg.scripts["test:governed-note-replace-http"],
  "npm run build && node scripts/test-governed-note-replace-http.mjs",
);
assert.ok(pkg.files.includes("docs/governed-note-replacement.md"));
assert.ok(pkg.files.includes("docs/governed-note-replacement.fr.md"));
const envExample = await text(".env.server.example");
assert.match(envExample, /MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH=\//);
const changelog = await text("CHANGELOG.md");
assert.match(changelog, /## \[Unreleased\][\s\S]*obsidian_note_replace_plan/);
assert.match(liveCanary, /os\.tmpdir\(\)/);
assert.doesNotMatch(
  liveCanary,
  /path\.join\(process\.cwd\(\), ["']\.tmp["']\)/,
);
assert.match(liveCanary, /Canary recovery directory:/);
assert.match(operations, /printed OS-temporary `evidenceFile`/);
assert.match(operationsFr, /temporaire système `evidenceFile` affiché/);
assert.doesNotMatch(operations, /proof under `\.tmp\/`/);
assert.doesNotMatch(operationsFr, /preuve JSON expurgée sous `\.tmp\/`/);

await access("scripts/test-governed-note-replace-mcp.mjs");
await access("scripts/test-governed-note-replace-http.mjs");
await access("scripts/smoke-atomic-note-mcp-live.mjs");

console.log("PASS: governed atomic note replacement documentation is coherent");
