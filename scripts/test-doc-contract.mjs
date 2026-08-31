#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const excludedDirectories = new Set([".git", ".tmp", "dist", "node_modules"]);

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolute);
    }
  }
  return files;
}

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

const readme = await text("README.md");
const readmeFr = await text("README.fr.md");
assert.ok(readme.split(/\r?\n/).length <= 220, "README.md must stay concise");
assert.ok(
  readmeFr.split(/\r?\n/).length <= 220,
  "README.fr.md must stay concise",
);

for (const [name, content, forbidden] of [
  ["README.md", readme, [/stdio-only/i, /HTTP handoff is denied/i]],
  ["README.fr.md", readmeFr, [/stdio-only/i, /handoff (est )?refusé en HTTP/i]],
]) {
  assert.match(content, /local_path/);
  assert.match(content, /http_ticket/);
  for (const pattern of forbidden) {
    assert.doesNotMatch(
      content,
      pattern,
      `${name} contains stale handoff text`,
    );
  }
}

const externalAdr = await text("docs/adr/ADR-External-Document-Roots.md");
const externalAdrIntegrity = await text(
  "docs/adr/ADR-External-Reference-Integrity.md",
);
const externalAdrIntegrityFr = await text(
  "docs/adr/ADR-External-Reference-Integrity.fr.md",
);
const httpAdr = await text("docs/adr/ADR-HTTP-External-Artifact-Delivery.md");
assert.match(externalAdr, /handoff transport amended/i);
assert.match(httpAdr, /Status: accepted and implemented on `main`/);
assert.match(httpAdr, /remote HTTP remains pilot-only/i);

const externalMoveDiagnosticDocs = [
  ["README.md", readme],
  ["README.fr.md", readmeFr],
  ["SECURITY.md", await text("SECURITY.md")],
  ["SECURITY.fr.md", await text("SECURITY.fr.md")],
  ["ADR-External-Document-Roots.md", externalAdr],
  ["ADR-External-Reference-Integrity.md", externalAdrIntegrity],
  ["ADR-External-Reference-Integrity.fr.md", externalAdrIntegrityFr],
  ["external-roots-setup.md", await text("docs/external-roots-setup.md")],
  ["external-roots-setup.fr.md", await text("docs/external-roots-setup.fr.md")],
  ["mcp-routing-guide.md", await text("docs/mcp-routing-guide.md")],
  ["mcp-routing-guide.fr.md", await text("docs/mcp-routing-guide.fr.md")],
  ["obsidian_mcp_tools_spec.md", await text("docs/obsidian_mcp_tools_spec.md")],
  [
    "runtime-capability-matrix.md",
    await text("docs/runtime-capability-matrix.md"),
  ],
  [
    "runtime-capability-matrix.fr.md",
    await text("docs/runtime-capability-matrix.fr.md"),
  ],
];
for (const [name, content] of externalMoveDiagnosticDocs) {
  assert.match(
    content,
    /native_handle_relative_mutation_unavailable/u,
    `${name} omits fail-closed runtime reason`,
  );
  assert.match(
    content,
    /external_move_(?:scan|plan|status)|external_references_scan/u,
  );
  assert.match(content, /diagnostic|diagnostique|read-only|lecture seule/iu);
  assert.match(content, /disabled|désactiv|ne peut muter|ne peuvent activer/iu);
}
const externalMoveNoLongerActiveDocs = [
  ["ADR-External-Reference-Integrity.md", externalAdrIntegrity],
  ["ADR-External-Reference-Integrity.fr.md", externalAdrIntegrityFr],
  ["external-roots-setup.md", await text("docs/external-roots-setup.md")],
  ["external-roots-setup.fr.md", await text("docs/external-roots-setup.fr.md")],
  ["mcp-routing-guide.md", await text("docs/mcp-routing-guide.md")],
  ["mcp-routing-guide.fr.md", await text("docs/mcp-routing-guide.fr.md")],
  [
    "runtime-capability-matrix.md",
    await text("docs/runtime-capability-matrix.md"),
  ],
  [
    "runtime-capability-matrix.fr.md",
    await text("docs/runtime-capability-matrix.fr.md"),
  ],
];
for (const [name, content] of [
  ["external-roots-setup.md", await text("docs/external-roots-setup.md")],
  ["external-roots-setup.fr.md", await text("docs/external-roots-setup.fr.md")],
  [
    "runtime-capability-matrix.md",
    await text("docs/runtime-capability-matrix.md"),
  ],
  [
    "runtime-capability-matrix.fr.md",
    await text("docs/runtime-capability-matrix.fr.md"),
  ],
]) {
  assert.match(content, /planningAvailable/u, `${name} omits planning status`);
  assert.match(
    content,
    /planningUnavailableReason/u,
    `${name} omits planning-denial reason`,
  );
  assert.match(content, /stdio_only/u, `${name} omits direct HTTP denial`);
  assert.match(
    content,
    /(?:profile_required|target_unverified|backend_attestation_unavailable)/u,
    `${name} omits redacted stdio planning reasons`,
  );
}
for (const [name, content] of externalMoveNoLongerActiveDocs) {
  assert.doesNotMatch(
    content,
    /(?:Apply (?:revalidates|uses)|External move uses|L[’']apply (?:revérifie|emploie)|Le move externe emploie)/u,
    `${name} still presents retired external-move mutation as active`,
  );
}
for (const [name, content] of [
  ["ADR-External-Reference-Integrity.md", externalAdrIntegrity],
  ["ADR-External-Reference-Integrity.fr.md", externalAdrIntegrityFr],
  ["external-roots-setup.md", await text("docs/external-roots-setup.md")],
  ["external-roots-setup.fr.md", await text("docs/external-roots-setup.fr.md")],
]) {
  assert.match(
    content,
    /redact|redacted|expurg|sans chemin physique/iu,
    `${name} regressed redaction contract`,
  );
  assert.match(
    content,
    /SQLite/iu,
    `${name} regressed private SQLite contract`,
  );
  assert.match(
    content,
    /legacy/iu,
    `${name} regressed legacy binding contract`,
  );
  assert.match(
    content,
    /stale|session.*binding|binding.*session/iu,
    `${name} regressed stale binding contract`,
  );
  assert.match(
    content,
    /CAS|SHA-256/iu,
    `${name} regressed exact CAS contract`,
  );
}

const matrix = await text("docs/runtime-capability-matrix.md");
const matrixFr = await text("docs/runtime-capability-matrix.fr.md");
const operonLocalValidation = await text("docs/operon-local-validation.md");
const operonLiveCanary = await text("scripts/smoke-operon-35-live.mjs");
const taskRuntimeReference = await text(
  "profiles/elysia-tasks/skills/elysia-task-gouverneur/references/runtime-et-mutations.md",
);
for (const content of [
  matrix,
  matrixFr,
  operonLocalValidation,
  taskRuntimeReference,
]) {
  assert.match(content, /3\.5\.3/u);
  assert.match(content, /3\.6\.0/u);
  assert.match(content, /Developer API V1/u);
  assert.match(content, /contract|contrat/iu);
}
assert.match(
  operonLiveCanary,
  /OPERON_35_CANARY_EXPECTED_OPERON_VERSION \?\? "3\.6\.0"/u,
  "the historical canary entry point must default to the current live target",
);
assert.match(
  operonLocalValidation,
  /OPERON_35_CANARY_EXPECTED_OPERON_VERSION = "3\.6\.0"/u,
  "the copied Pilot 2 recipe must pin its expected Operon runtime",
);
assert.match(
  operonLocalValidation,
  /OPERON_35_CANARY_EXPECTED_BRIDGE_VERSION = "0\.8\.3"/u,
  "the copied Pilot 2 recipe must pin its expected Bridge runtime",
);
assert.match(
  operonLocalValidation,
  /OPERON_35_CANARY_EXPECTED_MCP_VERSION = "3\.2\.0"/u,
  "the copied Pilot 2 recipe must pin its expected MCP runtime",
);
assert.match(
  operonLocalValidation,
  /OPERON_35_CANARY_RELEASE_CANDIDATE = "true"/u,
  "the copied Pilot 2 recipe must require the clean exact-SHA release gate",
);
for (const invariant of [
  /rebuilds both MCP and[\s\S]{0,40}Bridge/iu,
  /bundle[\s\S]{0,40}manifest[\s\S]{0,80}installed/iu,
  /rechecked immediately before every native dispatch/iu,
  /symlink, junction or reparse point/iu,
  /single-link regular file/iu,
  /does not expose all task-source[\s\S]{0,20}paths is refused before dispatch/iu,
]) {
  assert.match(
    operonLocalValidation,
    invariant,
    "the Pilot 2 recipe omits a candidate-provenance or physical-path gate",
  );
}
const operonCandidateEvidenceDocs = [
  ["README.md", readme],
  ["README.fr.md", readmeFr],
  ["CHANGELOG.md", await text("CHANGELOG.md")],
  ["ADR-Operon-Bridge.md", await text("docs/adr/ADR-Operon-Bridge.md")],
  ["obsidian_mcp_tools_spec.md", await text("docs/obsidian_mcp_tools_spec.md")],
  ["operon-cli-audit.md", await text("docs/operon-cli-audit.md")],
  ["operon-cli-audit.fr.md", await text("docs/operon-cli-audit.fr.md")],
  ["operon-decision-report.md", await text("docs/operon-decision-report.md")],
  ["operon-local-validation.md", operonLocalValidation],
  ["operon-mcp-contract.md", await text("docs/operon-mcp-contract.md")],
  ["operon-mcp-contract.fr.md", await text("docs/operon-mcp-contract.fr.md")],
  ["operon-rest-contract.md", await text("docs/operon-rest-contract.md")],
  ["runtime-capability-matrix.md", matrix],
  ["runtime-capability-matrix.fr.md", matrixFr],
  [
    "plugins/obsidian-operon-bridge/README.md",
    await text("plugins/obsidian-operon-bridge/README.md"),
  ],
];
const staleCandidateEvidence = [
  /Optimike MCP `3\.2\.0` has been validated/iu,
  /Optimike MCP `3\.2\.0` a été validé/iu,
  /Optimike MCP `3\.2\.0` is validated/iu,
  /Optimike MCP `3\.2\.0` passed Pilot 2/iu,
  /Optimike MCP `3\.2\.0` a passé Pilot 2/iu,
  /Optimike MCP `3\.2\.0` and Bridge `0\.8\.3` passed/iu,
  /Stock Operon `3\.6\.0`[\s\S]{0,80}passed[\s\S]{0,80}Bridge `0\.8\.3`/iu,
];
for (const [name, content] of operonCandidateEvidenceDocs) {
  for (const pattern of staleCandidateEvidence) {
    assert.doesNotMatch(
      content,
      pattern,
      `${name} presents working-tree evidence as exact-candidate acceptance`,
    );
  }
  assert.match(
    content,
    /public_task_source_projection_unavailable/u,
    `${name} must disclose the exact-SHA periodic apply skip`,
  );
  assert.match(
    content,
    /(?:no|not|do not claim)[\s\S]{0,80}periodic[\s\S]{0,30}certification|(?:aucune|pas une|ne pas revendiquer)[\s\S]{0,80}certification[\s\S]{0,30}périodique/iu,
    `${name} must reject a full periodic-certification claim`,
  );
}
const workingTreePeriodicEvidenceDocs = operonCandidateEvidenceDocs.filter(
  ([name]) =>
    ![
      "README.md",
      "README.fr.md",
      "operon-mcp-contract.md",
      "operon-mcp-contract.fr.md",
    ].includes(name),
);
for (const [name, content] of workingTreePeriodicEvidenceDocs) {
  assert.match(
    content,
    /historical\/\s*diagnostic|historique(?:s)?\/\s*diagnostique(?:s)?/iu,
    `${name} must label working-tree periodic applies as historical/diagnostic`,
  );
}
const periodicCertificationClaims = operonCandidateEvidenceDocs
  .map(([, content]) => content)
  .join("\n");
assert.doesNotMatch(
  periodicCertificationClaims,
  /exact-SHA[^\n]{0,160}(?:must|doit)[^\n]{0,80}(?:repeat|répéter)[^\n]{0,80}(?:Scheduled Date|periodic apply)/iu,
  "exact-SHA documentation must not promise to repeat a periodic apply that the gate skips",
);
assert.match(
  periodicCertificationClaims,
  /historical\/diagnostic|historique\/diagnostique/iu,
  "working-tree periodic applies must remain explicitly historical/diagnostic",
);
assert.match(
  periodicCertificationClaims,
  /no full periodic certification|aucune certification périodique complète/iu,
  "the candidate documentation must not claim full periodic certification",
);
assert.match(
  operonCandidateEvidenceDocs.map(([, content]) => content).join("\n"),
  /exact-SHA|SHA exact|clean final SHA|SHA final propre/iu,
  "the Operon 3.6 candidate documentation must preserve the exact-SHA release boundary",
);
assert.match(
  matrix,
  /not forced into read-only mode solely because its product[\s\S]{0,30}version is unknown/iu,
);
assert.match(
  matrixFr,
  /ne bascule pas en lecture seule[\s\S]{0,60}numéro est inconnu/iu,
);
const commonTools = [
  "external_runtime_status",
  "external_roots_list",
  "external_list",
  "external_stat",
  "external_read",
  "external_handoff",
  "operon_status",
  "operon_get_configuration",
  "operon_list_tasks",
  "operon_get_task",
  "operon_query_tasks",
  "operon_query_saved_filter",
  "operon_validate",
  "operon_get_diagnostics",
  "operon_find_tasks",
  "operon_resolve_task",
  "operon_get_relationships",
  "operon_build_context",
  "operon_get_timer_state",
  "operon_adopt_task",
  "operon_create_task",
  "operon_create_periodic_task",
  "operon_update_periodic_scheduling",
  "operon_update_task",
  "operon_transition_task",
  "operon_set_relationships",
  "operon_update_recurrence",
  "operon_convert_task",
  "operon_relocate_task",
  "operon_list_pending_recoveries",
  "operon_recover_mutation",
  "obsidian_note_replace_plan",
  "obsidian_note_replace_apply",
  "obsidian_note_replace_status",
  "obsidian_note_replace_recover",
  "obsidian_list_pending_operations",
  "bases_formula_patch_plan",
  "bases_formula_patch_apply",
  "bases_formula_patch_status",
  "bases_formula_patch_recover",
];
for (const tool of commonTools) {
  assert.ok(matrix.includes(`\`${tool}\``), `Matrix omits ${tool}`);
  assert.ok(matrixFr.includes(`\`${tool}\``), `French matrix omits ${tool}`);
}
assert.match(matrix, /\| Admin filesystem\s+\| No\s+\| No/);
assert.match(matrixFr, /\| Admin filesystem\s+\| Non\s+\| Non/);

const packageJson = JSON.parse(await text("package.json"));
assert.equal(
  packageJson.version,
  "3.7.0",
  "package metadata must match the 3.7.0 pending-operation cockpit candidate",
);
assert.equal(packageJson.scripts["start:http"], "node scripts/run-http.mjs");
assert.equal(packageJson.scripts["start:daemon"], "node scripts/run-http.mjs");
assert.equal(packageJson.scripts.inspect, "node scripts/run-inspector.mjs");
assert.equal(
  packageJson.bin["optimike-obsidian-mcp-proxy"],
  "dist/stdio-proxy.js",
);

const mcpConfig = JSON.parse(await text("mcp.json"));
const httpExample = mcpConfig.mcpServers["optimike-obsidian-mcp-http"].env;
assert.equal(httpExample.DANGEROUSLY_OMIT_AUTH, "true");
assert.equal(httpExample.MCP_HTTP_HANDOFF_ENABLED, "false");
assert.equal("MCP_AUTH_SECRET_KEY" in httpExample, false);

const bilingualPairs = [
  ["README.md", "README.fr.md"],
  ["OPERATIONS.md", "OPERATIONS.fr.md"],
  ["SECURITY.md", "SECURITY.fr.md"],
  ["docs/README.md", "docs/README.fr.md"],
  ["docs/external-roots-setup.md", "docs/external-roots-setup.fr.md"],
  ["docs/runtime-capability-matrix.md", "docs/runtime-capability-matrix.fr.md"],
  ["docs/bridge-lifecycle.md", "docs/bridge-lifecycle.fr.md"],
  ["docs/capability-doctor.md", "docs/capability-doctor.fr.md"],
  ["docs/governed-note-replacement.md", "docs/governed-note-replacement.fr.md"],
  ["docs/mcp-routing-guide.md", "docs/mcp-routing-guide.fr.md"],
  ["docs/headless-server-profile.md", "docs/headless-server-profile.fr.md"],
  ["docs/operon-mcp-contract.md", "docs/operon-mcp-contract.fr.md"],
  ["docs/operon-cli-audit.md", "docs/operon-cli-audit.fr.md"],
  [
    "docs/http-concurrency-backpressure.md",
    "docs/http-concurrency-backpressure.fr.md",
  ],
  [
    "docs/http-observability-contract.md",
    "docs/http-observability-contract.fr.md",
  ],
];
for (const pair of bilingualPairs) {
  for (const file of pair) await access(path.join(root, file));
}

const governedNoteContract = await text("docs/governed-note-replacement.md");
const governedNoteContractFr = await text(
  "docs/governed-note-replacement.fr.md",
);
for (const content of [governedNoteContract, governedNoteContractFr]) {
  for (const tool of commonTools.filter((tool) =>
    tool.startsWith("obsidian_note_replace_"),
  )) {
    assert.ok(content.includes(`\`${tool}\``), `Note contract omits ${tool}`);
  }
  assert.match(content, /planRef/u);
  assert.match(content, /operation_\*/u);
  assert.match(content, /Vault\.process/u);
}
assert.match(governedNoteContract, /not undo/i);
assert.match(governedNoteContractFr, /n’est pas `undo`/iu);
assert.match(governedNoteContract, /`status` first/i);
assert.match(governedNoteContractFr, /appeler d’abord\s+`status`/iu);

const envExample = await text(".env.server.example");
assert.match(envExample, /MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH=\//u);

const operonContract = await text("docs/operon-mcp-contract.md");
const operonContractFr = await text("docs/operon-mcp-contract.fr.md");
const operonRestContract = await text("docs/operon-rest-contract.md");
assert.match(
  operonRestContract,
  /POST \/tasks\/:operonId\/periodic-update/u,
  "Operon REST documentation must use the mounted periodic-update route",
);
assert.doesNotMatch(
  operonRestContract,
  /POST \/tasks\/:operonId\/periodic-scheduling/u,
  "Operon REST documentation must not revive the obsolete periodic-scheduling route",
);
assert.match(
  operonRestContract,
  /direct REST boundary rejects `fields\.dateScheduled` before it creates an idempotency reservation or requests a native preview\/apply/iu,
  "standard task creation must reject scheduled dates before native coordination",
);
assert.match(
  operonRestContract,
  /direct REST boundary rejects `patch\.fields\.dateScheduled` before it creates an idempotency reservation or requests a native preview\/apply/iu,
  "generic updates must reject scheduled dates before native coordination",
);
assert.match(
  operonRestContract,
  /direct REST boundary rejects `changes\.dateScheduled` before it creates an idempotency reservation or requests a native preview\/apply/iu,
  "recurrence updates must reject scheduled dates before native coordination",
);
assert.match(operonRestContract, /POST \/mutations\/recover/u);
assert.match(operonRestContract, /POST \/task-workflows\/recover/u);
assert.match(
  operonRestContract,
  /"recoveryRef": "dvr1_[\s\S]*"kind": "adopt"[\s\S]*"planDigest"/u,
);
assert.doesNotMatch(
  operonRestContract,
  /"recoveryRef": "dvr1_[\s\S]{0,120}"recovery":/u,
);
const operonAudit = await text("docs/operon-cli-audit.md");
const operonAuditFr = await text("docs/operon-cli-audit.fr.md");
for (const content of [operonContract, operonContractFr]) {
  for (const tool of commonTools.filter((tool) => tool.startsWith("operon_"))) {
    assert.ok(content.includes(`\`${tool}\``), `Operon contract omits ${tool}`);
  }
}
assert.doesNotMatch(operonAudit, /acceptance remains pending/i);
assert.doesNotMatch(operonAuditFr, /acceptation (?:live )?reste en attente/i);
assert.match(operonAudit, /no\s+residual relationship\/recurrence state/i);
assert.match(operonAuditFr, /aucun résidu/i);
assert.match(operonAudit, /Task Editor deletion remains `SKIP`/u);
assert.match(operonAuditFr, /suppression Task Editor reste `SKIP`/u);
assert.match(operonAudit, /Parent-date expansion remains `SKIP`/u);
assert.match(operonAuditFr, /dates parent reste `SKIP`/u);
assert.match(
  operonLocalValidation,
  /npm run test:operon-36-behavior-contract/u,
);
assert.match(operonLocalValidation, /npm run smoke:operon-36-behaviors-live/u);
assert.match(operonLocalValidation, /validation P0\/P1\/P2/u);
assert.match(
  operonLocalValidation,
  /working-tree diagnostic run \(not accepted release evidence\)/iu,
);
assert.match(operonLocalValidation, /exact release SHA/iu);
assert.match(operonContract, /generic CLI passthrough/i);
assert.match(operonContractFr, /passthrough CLI générique/i);
assert.match(operonContract, /structured unavailable result/i);
assert.match(operonContractFr, /indisponibilité structurée/i);
assert.match(
  operonContract,
  /only MCP tool that sets or clears `dateScheduled` on an existing task/iu,
  "English Operon contract must route existing-task dateScheduled changes only through the periodic tool",
);
assert.match(
  operonContractFr,
  /seul outil MCP pour modifier ensuite ce champ/iu,
  "French Operon contract must route existing-task dateScheduled changes only through the periodic tool",
);
for (const content of [
  await text("docs/obsidian_mcp_tools_spec.md"),
  await text(
    "profiles/elysia-tasks/skills/elysia-task-gouverneur/references/operations-ponctuelles.md",
  ),
]) {
  assert.match(content, /dateScheduled/u);
  assert.match(content, /operon_update_periodic_scheduling/u);
  assert.match(content, /operon_update_task/u);
}
for (const content of [operonContract, operonAudit]) {
  assert.match(content, /Operon `3\.5\.3`/u);
  assert.match(content, /Operon CLI `1\.2\.0`/u);
  assert.match(content, /Bridge\s+`0\.8\.3`/u);
  assert.match(content, /compatible-provisional/u);
  assert.match(content, /opaque sealed\s+plan/iu);
  assert.match(content, /(?:same-plan|même\s+plan)/iu);
  assert.match(content, /taskGallery/u);
  assert.match(content, /__taskDataType/u);
}
for (const content of [operonContractFr, operonAuditFr]) {
  assert.match(content, /Operon `3\.5\.3`/u);
  assert.match(content, /Operon CLI `1\.2\.0`/u);
  assert.match(content, /Bridge\s+`0\.8\.3`/u);
  assert.match(content, /compatible-provisional/u);
  assert.match(content, /plan opaque\s+scellé/iu);
  assert.match(content, /(?:same-plan|même\s+plan)/iu);
  assert.match(content, /taskGallery/u);
  assert.match(content, /__taskDataType/u);
}
assert.match(operonContract, /tasks\.adopt\.preview/u);
assert.match(operonContract, /Daily\/Weekly/u);
assert.match(operonContract, /scalar strings/u);
assert.match(operonContract, /ordered string array/u);
assert.match(operonContractFr, /tasks\.adopt\.preview/u);
assert.match(operonContractFr, /Daily\/Weekly/u);
assert.match(operonContractFr, /chaînes scalaires/u);
assert.match(operonContractFr, /tableau ordonné/u);
for (const content of [operonContract, operonRestContract]) {
  assert.match(content, /reserv(?:e|es).*atomically/isu);
  assert.match(content, /version[- ]2 journal/iu);
  assert.match(content, /proven-pre-dispatch/u);
  assert.match(content, /version-1.*unknown-or-dispatched/isu);
  assert.match(content, /500 entries/iu);
  assert.match(content, /30 days/iu);
  assert.match(content, /in-progress.*outcome-unknown/isu);
  assert.match(content, /recoveryRequired: true/u);
  assert.match(content, /(?:no promise|promises nothing)/iu);
  assert.match(
    content,
    /Task Workflow results?.*(?:strictly validated|validated as a strict)/isu,
  );
  assert.match(content, /nativeProof/u);
  assert.match(content, /bounded proof projection/iu);
  assert.match(content, /pendingRecoveries/u);
  assert.match(content, /optional.*planDigest/iu);
  assert.match(content, /priorityId.*postflight/isu);
  assert.match(content, /ambiguous creation/iu);
  assert.match(content, /compatible-provisional/u);
}
assert.match(operonContractFr, /réserve.*atomiquement/isu);
assert.match(operonContractFr, /journal version 2/iu);
assert.match(operonContractFr, /provenance de dispatch/iu);
assert.match(operonContractFr, /entrées version 1.*unknown-or-dispatched/isu);
assert.match(operonContractFr, /500 entrées/iu);
assert.match(operonContractFr, /30 jours/iu);
assert.match(operonContractFr, /in-progress.*outcome-unknown/isu);
assert.match(operonContractFr, /recoveryRequired: true/u);
assert.match(operonContractFr, /aucune promesse/iu);
assert.match(
  operonContractFr,
  /résultats Task Workflow.*validés strictement/isu,
);
assert.match(operonContractFr, /nativeProof/u);
assert.match(operonContractFr, /projection de preuve bornée/iu);
assert.match(operonContractFr, /pendingRecoveries/u);
assert.match(operonContractFr, /planDigest.*optionnel/isu);
assert.match(operonContractFr, /priorityId.*postflight/isu);
assert.match(operonContractFr, /création ambiguë/iu);
assert.match(
  operonContract,
  /product version[\s\S]*not a positive mutation allowlist/iu,
);
assert.match(
  operonContractFr,
  /version produit[\s\S]*n’est pas une allowlist positive de mutation/iu,
);
assert.doesNotMatch(operonContract, /stock `3\.5\.3` remains read-only/iu);
assert.doesNotMatch(operonContractFr, /3\.5\.3` stock[\s\S]*lecture seule/iu);

const profilesEn = await text("docs/tool-surface-profiles.md");
const profilesFr = await text("docs/tool-surface-profiles.fr.md");
assert.match(readme, /\| `tasks`\s+\|\s+34\s+\|/u);
assert.match(readme, /\| `full`\s+\|\s+77\s+\|/u);
assert.match(readmeFr, /\| `tasks`\s+\|\s+34\s+\|/u);
assert.match(readmeFr, /\| `full`\s+\|\s+77\s+\|/u);
assert.match(profilesEn, /\| `tasks`\s+\|[^\n]+34 tools/u);
assert.match(profilesEn, /\| `full`\s+\|[^\n]+77 tools/u);
assert.match(profilesEn, /81 unique names/u);
assert.match(profilesFr, /\| `tasks`\s+\|[^\n]+34 outils/u);
assert.match(profilesFr, /\| `full`\s+\|[^\n]+77 outils/u);
assert.match(profilesFr, /81 noms uniques/u);

const backpressureContract = await text(
  "docs/http-concurrency-backpressure.md",
);
const backpressureContractFr = await text(
  "docs/http-concurrency-backpressure.fr.md",
);
for (const content of [backpressureContract, backpressureContractFr]) {
  assert.match(content, /smoke-stdio-backpressure-live\.mjs/u);
  assert.match(content, /identity-queue-full/u);
  assert.match(content, /429/u);
  assert.match(content, /Connection closed/u);
  assert.match(content, /HTTP `504`/u);
  assert.doesNotMatch(content, /HTTP `408`/u);
  assert.match(content, /data\.applicationCode: SERVICE_UNAVAILABLE/u);
}
for (const content of [
  await text("SECURITY.md"),
  await text("SECURITY.fr.md"),
  await text("docs/http-observability-contract.md"),
  await text("docs/http-observability-contract.fr.md"),
]) {
  assert.match(content, /`error\.code`[\s\S]{0,100}(?:integer|entier)/iu);
  assert.match(content, /`error\.data\.applicationCode`/u);
  assert.match(content, /`error\.data\.requestId`/u);
  assert.match(content, /`X-Request-Id`/u);
}
for (const content of [
  await text("OPERATIONS.md"),
  await text("OPERATIONS.fr.md"),
]) {
  assert.match(content, /smoke-stdio-backpressure-live\.mjs/u);
  assert.match(content, /429/u);
  assert.match(content, /Connection closed/u);
}

const brokenLinks = [];
for (const file of await markdownFiles(root)) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (!target || /^(?:https?:|mailto:|file:|#)/i.test(target)) {
      continue;
    }
    target = target.replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target) continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // The filesystem check below will report the malformed target.
    }
    const resolved = path.resolve(path.dirname(file), decoded);
    try {
      await access(resolved);
    } catch {
      brokenLinks.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}
assert.deepEqual(
  brokenLinks,
  [],
  `Broken documentation links:\n${brokenLinks.join("\n")}`,
);

console.log(
  `PASS: documentation contract, bilingual entrypoints, runtime registry and relative links are coherent`,
);
