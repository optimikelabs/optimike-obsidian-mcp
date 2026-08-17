import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

async function text(path) {
  return readFile(path, "utf8");
}

function markdownReleaseSection(changelog, heading) {
  const start = changelog.indexOf(heading);
  assert.ok(start >= 0, `changelog omits ${heading}`);
  const afterHeading = changelog.slice(start + heading.length);
  const nextRelease = afterHeading.search(/\n## \[/u);
  return nextRelease >= 0 ? afterHeading.slice(0, nextRelease) : afterHeading;
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
const bridgeReadme = await text(
  "plugins/obsidian-atomic-write-bridge/README.md",
);
const liveCanary = await text("scripts/smoke-atomic-note-mcp-live.mjs");
const modifiedTimeLiveCanary = await text(
  "scripts/smoke-modified-time-settlement-live.mjs",
);
const modifiedTimeCanaryHelpers = await text(
  "scripts/modified-time-canary-helpers.mjs",
);
const operations = await text("OPERATIONS.md");
const operationsFr = await text("OPERATIONS.fr.md");
const security = await text("SECURITY.md");
const securityFr = await text("SECURITY.fr.md");
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
assert.match(contract, /Optimike Obsidian MCP 2\.6\.0 exposes/i);
assert.match(contractFr, /Optimike Obsidian MCP 2\.6\.0 expose/i);
assert.match(
  contract,
  /guarantees are released in Optimike Obsidian MCP\s+2\.6\.0/i,
);
assert.match(
  contractFr,
  /garanties sont\s+publiées dans Optimike Obsidian MCP 2\.6\.0/i,
);
assert.doesNotMatch(contract, /The 2\.6 candidate/i);
assert.doesNotMatch(contractFr, /Le candidat 2\.6/i);
assert.doesNotMatch(contract, /versioning, and release remain/i);
assert.doesNotMatch(contractFr, /Merge, version et\s+release restent/i);
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
  pkg.scripts["smoke:modified-time-settlement-live"],
  "npm run build && node scripts/smoke-modified-time-settlement-live.mjs",
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
const releaseSection = markdownReleaseSection(
  changelog,
  "## [2.6.0] - 2026-08-14",
);
for (const tool of tools) {
  assert.ok(
    releaseSection.includes(`\`${tool}\``),
    `2.6.0 changelog section omits ${tool}`,
  );
}
const unreleasedSection = changelog.slice(
  changelog.indexOf("## [Unreleased]") + "## [Unreleased]".length,
  changelog.indexOf("## [2.6.0] - 2026-08-14"),
);
for (const tool of tools) {
  assert.equal(
    unreleasedSection.includes(`\`${tool}\``),
    false,
    `${tool} must belong to 2.6.0, not Unreleased`,
  );
}
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
assert.match(adr, /loses because it observed stale durable state/);
assert.match(adr, /must never escape as[\s\S]*internal tool error/);
assert.match(
  adr,
  /earlier\s+attempt is uncertain[\s\S]*neither the sealed before nor after/,
);
assert.match(contract, /busy policy is installed before WAL negotiation/);
assert.match(contract, /each recovery gets a new attempt fence/);
assert.match(contract, /terminal receipts remain replayable[\s\S]*read-only/i);
assert.match(contract, /revalidates it again immediately before every/i);
assert.match(contractFr, /politique de contention SQLite est installée avant/);
assert.match(
  contractFr,
  /chaque recovery\s+reçoit un nouveau fence de tentative/,
);
assert.match(contractFr, /reçus terminaux stables restent rejouables/i);
assert.match(contractFr, /juste avant chaque tentative de/i);
assert.match(contract, /loser of the conditional `planned → applying`/i);
assert.match(contractFr, /perdant de la transition conditionnelle/i);
assert.match(contract, /empty Markdown note as valid content/i);
assert.match(contractFr, /note Markdown vide comme[\s\S]*contenu valide/i);
assert.match(contract, /subsequent CAS[\s\S]*remains `outcome_unknown`/i);
assert.match(contractFr, /conflit CAS suivant reste `outcome_unknown`/i);
assert.match(contract, /Bounded modified-time settlement/i);
assert.match(contract, /does\s+not weaken pre-effect CAS/i);
assert.match(contract, /exactly one additional top-level frontmatter line/i);
assert.match(contract, /sealed backend identity and logical target/i);
assert.match(contract, /byte-identical to the sealed after content/i);
assert.match(contract, /at-most-five-minute/i);
assert.match(contractFr, /Settlement borné de la date de modification/i);
assert.match(contractFr, /n.affaiblit pas le CAS/i);
assert.match(contractFr, /une seule ligne\s+top-level du frontmatter/i);
assert.match(
  contractFr,
  /identité backend et de la cible logique[\s\S]*scellées/i,
);
assert.match(contractFr, /byte-identical au contenu after scellé/i);
assert.match(contractFr, /cinq minutes maximum/i);
assert.match(adr, /never weaken the admission or pre-effect CAS/i);
assert.match(adr, /same sealed backend identity and logical target/i);
assert.match(adr, /never\s+ignores a field\s+globally/i);
assert.match(bridgeReadme, /Version 0\.2\.0/i);
assert.match(bridgeReadme, /Frontmatter Date Manager/i);
assert.match(bridgeReadme, /Update Time/i);
assert.match(bridgeReadme, /comma-delimited fail-closed list/i);
assert.match(contract, /never advertises[\s\S]*contains a comma/i);
assert.match(contractFr, /n.annonce[\s\S]*contient une virgule/i);
assert.match(contract, /128 JavaScript string code units/i);
assert.doesNotMatch(contract, /128-byte/i);
assert.match(
  security,
  /Supported modified-time plugins do not weaken that CAS/i,
);
assert.match(
  securityFr,
  /plugins de date de modification[\s\S]*n.affaiblissent pas ce CAS/i,
);
assert.match(operations, /lost-response canary/i);
assert.match(operations, /additional body or frontmatter change/i);
assert.match(operationsFr, /canary à réponse perdue/i);
assert.match(
  operationsFr,
  /dérive supplémentaire du[\s\S]*corps ou du frontmatter/i,
);
assert.match(operations, /smoke:modified-time-settlement-live/);
assert.match(operationsFr, /smoke:modified-time-settlement-live/);
assert.match(modifiedTimeLiveCanary, /os\.tmpdir\(\)/);
assert.match(modifiedTimeLiveCanary, /dropNextCasResponse/);
assert.match(modifiedTimeLiveCanary, /dropNextReconciliationRead/);
assert.match(modifiedTimeLiveCanary, /waitForNextRepresentableTimestamp/);
assert.match(modifiedTimeCanaryHelpers, /\[,\\r\\n:\]/);
assert.doesNotMatch(modifiedTimeCanaryHelpers, /\\p\{L\}.*\\p\{N\}/);
assert.match(modifiedTimeCanaryHelpers, /representableTickMs/);
assert.match(modifiedTimeCanaryHelpers, /60_000/);
assert.match(
  pkg.scripts["check:atomic-write"],
  /test-modified-time-canary-helpers/,
);
assert.match(modifiedTimeLiveCanary, /positiveStatus\.outcome, "committed"/);
assert.match(
  modifiedTimeLiveCanary,
  /negativeStatus\.outcome, "outcome_unknown"/,
);
assert.match(modifiedTimeLiveCanary, /finalRead\.sha256, originalSha256/);
assert.ok(
  modifiedTimeLiveCanary.indexOf("const finalRead = await atomicRead();") <
    modifiedTimeLiveCanary.indexOf("restored = true;"),
  "restoration authority must follow the final post-plugin hash read",
);
assert.doesNotMatch(
  modifiedTimeLiveCanary,
  /path\.join\(process\.cwd\(\), ["']\.tmp["']\)/,
);

await access("scripts/test-governed-note-replace-mcp.mjs");
await access("scripts/test-governed-note-replace-http.mjs");
await access("scripts/smoke-atomic-note-mcp-live.mjs");
await access("scripts/smoke-modified-time-settlement-live.mjs");
await access("scripts/modified-time-canary-helpers.mjs");
await access("scripts/test-modified-time-canary-helpers.mjs");
assert.match(
  liveCanary,
  /transientLogsParent[\s\S]*process\.cwd\(\)[\s\S]*["']logs["'][\s\S]*mkdtempSync/,
);
assert.match(liveCanary, /renameSync\(logsPath, retainedLogsPath\)/);
assert.match(liveCanary, /Canary transient runtime logs:/);
assert.match(liveCanary, /runtimeLogsPath: logsPath/);
assert.match(
  liveCanary,
  /backupMetadata\.runtimeLogsPath = retainedLogsPath[\s\S]*writeFileSync\([\s\S]*backupMetadataPath/,
);
assert.ok(
  liveCanary.indexOf("Canary transient runtime logs:") <
    liveCanary.indexOf("new StdioClientTransport"),
  "the transient log path must be observable before the canary connects",
);
assert.doesNotMatch(
  liveCanary,
  /const logsPath = path\.join\(tempRoot, ["']logs["']\)/,
);

console.log("PASS: governed atomic note replacement documentation is coherent");
