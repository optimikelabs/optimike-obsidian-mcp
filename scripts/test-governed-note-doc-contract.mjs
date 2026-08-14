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
assert.match(operations, /operating system temporary root/);
assert.match(operations, /deletes the private run directory/);
assert.match(operations, /abrupt interruption or an unverified\s+restoration/i);
assert.match(operationsFr, /racine temporaire du système/);
assert.match(operationsFr, /supprime le dossier privé/);
assert.match(
  operationsFr,
  /interruption brutale ou une\s+restauration non vérifiée/i,
);
assert.doesNotMatch(operations, /proof under `\.tmp\/`/);
assert.doesNotMatch(operationsFr, /preuve JSON expurgée sous `\.tmp\/`/);

const recoveryAnnouncement = liveCanary.indexOf("Canary recovery directory:");
const backupWrite = liveCanary.indexOf("writeFileSync(backupPath");
const directCas = liveCanary.indexOf("await proveDirectBridgeCasConflict()");
const firstMutation = liveCanary.indexOf(
  "const nominal = await planApplyStatus",
);
const restorationVerified = liveCanary.indexOf("restored = true;");
const evidenceWrite = liveCanary.indexOf("writeFileSync(evidenceFile");
assert.ok(recoveryAnnouncement >= 0 && recoveryAnnouncement < backupWrite);
assert.ok(backupWrite >= 0 && backupWrite < directCas);
assert.ok(directCas >= 0 && directCas < firstMutation);
assert.ok(restorationVerified >= 0 && restorationVerified < evidenceWrite);
assert.match(liveCanary, /if \(restored\) \{[\s\S]*rmSync\(tempRoot/);
assert.match(liveCanary, /else if \(backupWritten\) \{[\s\S]*retained at/);
assert.match(
  liveCanary,
  /failed before the first mutation; no note recovery is required/,
);
assert.match(
  adr,
  /Every connection that negotiates WAL must install its busy policy/,
);
assert.match(adr, /fresh per-attempt identifier/);
assert.match(contract, /busy policy is installed before WAL negotiation/);
assert.match(contract, /each recovery gets a new attempt fence/);
assert.match(contractFr, /politique de contention SQLite est installée avant/);
assert.match(
  contractFr,
  /chaque recovery\s+reçoit un nouveau fence de tentative/,
);

await access("scripts/test-governed-note-replace-mcp.mjs");
await access("scripts/test-governed-note-replace-http.mjs");
await access("scripts/smoke-atomic-note-mcp-live.mjs");

console.log("PASS: governed atomic note replacement documentation is coherent");
