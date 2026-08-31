#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const scriptPath = path.join(
  projectRoot,
  "scripts",
  "smoke-operon-36-behaviors-live.mjs",
);

function runOfflineContract(mode = "--offline-contract") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, mode], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Offline Operon 3.6 behavior contract failed (${code}): ${stderr}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

const result = await runOfflineContract();
assert.equal(result.ok, true);
assert.deepEqual(result.deletion, {
  status: "SKIP",
  reason: "public_delete_surface_unavailable",
});
assert.deepEqual(result.parentDateMissing, {
  status: "SKIP",
  reason: "public_configuration_not_announced",
});
assert.deepEqual(result.periodicScheduling, {
  status: "SKIP",
  reason: "public_task_source_projection_unavailable",
});
assert.equal(result.periodicApplyDispatched, false);
const physicalSafety = await runOfflineContract(
  "--offline-path-safety-contract",
);
assert.equal(physicalSafety.ok, true);
assert.equal(physicalSafety.periodicCreateJunctionSwapRefused, true);
assert.equal(physicalSafety.periodicUpdateHardlinkSwapRefused, true);
assert.equal(physicalSafety.outsideFilePreserved, true);
assert.equal(physicalSafety.rootReplacementRefused, true);
assert.equal(physicalSafety.bridgeBuildManifestMatchesNormalizedSource, true);

const source = await readFile(scriptPath, "utf8");
const sourceFile = ts.createSourceFile(
  scriptPath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

function containsSamePathIdentityCall(node) {
  let found = false;
  function visit(candidate) {
    if (found) return;
    if (
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === "samePathIdentity"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

function auditPathIdentityAssertions(root) {
  let count = 0;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "assert" &&
      node.expression.name.text === "equal" &&
      node.arguments[0] &&
      containsSamePathIdentityCall(node.arguments[0])
    ) {
      count += 1;
      assert.equal(
        node.arguments[1]?.kind,
        ts.SyntaxKind.TrueKeyword,
        "Path-identity assertions must compare against true before their diagnostic message.",
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return count;
}
const pathIdentityAssertionCount = auditPathIdentityAssertions(sourceFile);
assert.ok(
  pathIdentityAssertionCount >= 7,
  "The live behavior canary must retain every path-identity assertion.",
);
const nestedOmissionFixture = ts.createSourceFile(
  "nested-path-identity-omission.mjs",
  'assert.equal(samePathIdentity(await realpath(candidate), expected), "diagnostic");',
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
assert.throws(
  () => auditPathIdentityAssertions(nestedOmissionFixture),
  /Path-identity assertions must compare against true/u,
  "The contract must reject an omitted boolean expectation even when path arguments contain nested calls.",
);
for (const requiredTool of [
  "operon_status",
  "operon_get_configuration",
  "operon_create_task",
  "operon_update_periodic_scheduling",
  "operon_update_task",
  "operon_set_relationships",
  "operon_get_task",
  "operon_query_tasks",
  "operon_validate",
  "operon_list_pending_recoveries",
]) {
  assert.equal(
    source.includes(`\"${requiredTool}\"`),
    true,
    `Live gate is missing public tool ${requiredTool}.`,
  );
}
for (const invariant of [
  'const EXPECTED_OPERON_VERSION = "3.6.1"',
  'const EXPECTED_MCP_VERSION = "3.8.1"',
  'const EXPECTED_BRIDGE_VERSION = "0.9.2"',
  "I_CONFIRM_PILOT_2_OPERON_36_BEHAVIOR_MUTATIONS",
  "public_delete_surface_unavailable",
  "public_configuration_not_announced",
  "public_task_source_projection_unavailable",
  "function periodicSchedulingProjectedTaskSourcePaths(plan)",
  "function periodicSchedulingDispatchDecision(plan)",
  "function routeAcceptsOpaquePlanMetadata(name)",
  "periodicApplyDispatched: false",
  "dispatchAttempted: false",
  "autoExpandParentTaskDateRange",
  "Unexpected Markdown drift was detected and was deliberately not overwritten.",
  "Canary tasks remained indexed after restoration.",
  "Scheduled Date update changed blocker relationships.",
  "Created periodic artifact is not bound to the projected parent identity.",
  "Markdown inventory was not restored byte-exactly.",
  "must not be hardlinked.",
  "Pilot vault root must resolve to its requested path (no junction).",
  "Pilot vault root stable filesystem identity is unavailable or ambiguous.",
  "Pilot vault root physical identity changed after preflight.",
  "Fixture hardlink count changed after preflight.",
  "Refusing to delete an unmarked created artifact.",
  "The existing fixture may never be deleted.",
  "Synced restore temp differs from the private fixture backup.",
  "Atomic fixture replacement did not preserve the original bytes.",
  "Restore temp does not carry the exact canary marker.",
  "byte-exact Operon 3.6 behavior canary",
  "errorCode: safePublicCode(result?.error?.code)",
  "mutationMayHaveApplied",
  "safelyRetryablePreDispatch",
  "await waitForLiveStatus(requiredCapability)",
  "MUTATION_RETRY_LIMIT = 3",
  "diagnoseUpdatePreDispatch",
  "preDispatchDiagnostics",
  'operon_update_periodic_scheduling: "periodicUpdate"',
  "blocked task Scheduled Date via periodic scheduling route",
  "async function attestLiveCandidate(vaultRoot)",
  "package.json MCP version differs from the expected live candidate.",
  "Local Operon Bridge package version differs from the expected live candidate.",
  "Local Operon Bridge manifest version differs from the expected live candidate.",
  'runProjectCommand(["rev-parse", "HEAD"], "git HEAD")',
  '["status", "--porcelain=v1"]',
  "Live canary requires a clean worktree so its evidence names one exact candidate.",
  "Installed Operon Bridge build does not match the local candidate build.",
  'path.join(bridgeRoot, "build", "main.js")',
  "bridgeBuildMatchesInstalled: true",
  "candidate,",
  "--offline-path-safety-contract",
  "Offline behavior periodic create junction swap before apply",
  "Offline behavior periodic update hardlink swap before apply",
  "Offline hostile root replacement",
  "did not seal every periodic source path; refusing a physically unbounded mutation.",
  "async function assertPhysicalPreDispatch",
  "async function assertPhysicalPostDispatch",
  "await assertCandidateStillExact(candidate)",
  'await runNpmCommand(["run", "build"], "MCP candidate rebuild")',
  "Operon Bridge candidate rebuild",
  "Installed Operon Bridge manifest does not match the local candidate manifest.",
  "bridgeManifestMatchesInstalled: true",
  "Installed Bridge manifest changed after candidate attestation.",
  "Generated Bridge manifest changed after candidate attestation.",
  "assertBuiltBridgeManifest",
  "Offline Bridge manifest rebuild",
  "normalized source manifest plus main.js",
]) {
  assert.equal(
    source.includes(invariant),
    true,
    `Missing contract: ${invariant}`,
  );
}
const candidateAttestationIndex = source.indexOf(
  "const candidate = await attestLiveCandidate(vaultReal);",
);
const callMutationIndex = source.indexOf("async function callMutation");
const mutationRootFenceIndex = source.indexOf(
  "await assertVaultRootStillSame(`${label} native apply`);",
  callMutationIndex,
);
const mutationDispatchIndex = source.indexOf(
  "const observed = await callRaw(name, args",
  callMutationIndex,
);
const periodicProjectionSkipIndex = source.indexOf(
  "if (physicalPreflight?.skipReason)",
  callMutationIndex,
);
assert.ok(
  mutationRootFenceIndex > callMutationIndex &&
    mutationRootFenceIndex < mutationDispatchIndex,
  "Every native apply must revalidate the sealed physical vault root immediately before dispatch.",
);
assert.ok(
  periodicProjectionSkipIndex > callMutationIndex &&
    periodicProjectionSkipIndex < mutationDispatchIndex,
  "A missing periodic task-source projection must return SKIP before native dispatch.",
);
const periodicProjectionHelperIndex = source.indexOf(
  "function periodicSchedulingProjectedTaskSourcePaths(plan)",
);
const periodicDecisionIndex = source.indexOf(
  "function periodicSchedulingDispatchDecision(plan)",
);
const periodicDecisionSource = source.slice(
  periodicDecisionIndex,
  source.indexOf(
    "function routeAcceptsOpaquePlanMetadata(name)",
    periodicDecisionIndex,
  ),
);
assert.ok(
  periodicProjectionHelperIndex > 0 &&
    periodicDecisionSource.includes(
      "periodicSchedulingProjectedTaskSourcePaths(plan)",
    ),
  "Periodic scheduling must use only its explicit task-source projection helper.",
);
assert.equal(
  periodicDecisionSource.includes("plannedTaskSourcePaths(plan)"),
  false,
  "Periodic scheduling must not accept generic plan metadata as a task-source projection.",
);
const mcpRebuildIndex = source.indexOf(
  'await runNpmCommand(["run", "build"], "MCP candidate rebuild")',
);
const gitHeadIndex = source.indexOf(
  'runProjectCommand(["rev-parse", "HEAD"], "git HEAD")',
);
assert.ok(mcpRebuildIndex > 0, "MCP candidate rebuild is missing.");
assert.ok(
  mcpRebuildIndex < gitHeadIndex,
  "Generated candidate artifacts must be rebuilt before Git identity is read.",
);
const privateBackupIndex = source.indexOf(
  'const fixtureBackupPath = path.join(tempRoot, "fixture-original.md")',
);
assert.ok(candidateAttestationIndex > 0, "Candidate attestation is missing.");
assert.ok(
  candidateAttestationIndex < privateBackupIndex,
  "Candidate identity must be attested before private backup creation and any mutation.",
);
for (const destructiveRootFence of [
  'assertVaultRootStillSame("Behavior canary restoration")',
  'assertVaultRootStillSame("Restore temp deletion")',
  'assertVaultRootStillSame("Fixture atomic restoration")',
  'assertVaultRootStillSame("Created artifact deletion")',
]) {
  assert.equal(
    source.includes(destructiveRootFence),
    true,
    `Missing destructive root fence: ${destructiveRootFence}`,
  );
}
const scheduledDatePatch =
  "patch: { fields: { dateScheduled: dates.scheduled } }";
const scheduledDateIndex = source.indexOf(scheduledDatePatch);
assert.ok(scheduledDateIndex > 0, "Scheduled Date mutation is missing.");
const scheduledDateRoute = source.slice(
  Math.max(0, scheduledDateIndex - 700),
  scheduledDateIndex + scheduledDatePatch.length + 300,
);
assert.equal(
  scheduledDateRoute.includes('"operon_update_periodic_scheduling"'),
  true,
  "Scheduled Date must use the public periodic scheduling route.",
);
assert.equal(
  scheduledDateRoute.includes('"operon_update_task"'),
  false,
  "Scheduled Date must not use the generic task update route.",
);
const dateIsolationIndex = source.indexOf("await assertDateIsolation();");
const inventoryBackupIndex = source.indexOf(
  "baseline = await captureMarkdownInventory();",
);
assert.ok(
  dateIsolationIndex > 0,
  "Modified-time isolation preflight is missing.",
);
assert.ok(
  dateIsolationIndex < inventoryBackupIndex,
  "Modified-time isolation must be proven before the private backup and first mutation.",
);
assert.equal(
  source.includes('path.join(tempRoot, "markdown-backup")'),
  false,
  "The canary must not retain the bodies of unrelated Markdown notes.",
);
assert.equal(
  source.includes(
    'const fixtureBackupPath = path.join(tempRoot, "fixture-original.md")',
  ),
  true,
  "Only the targeted fixture should receive a private content backup.",
);
assert.equal(
  source.includes('.obsidian", "plugins", "operon", "data.json'),
  false,
  "The parent-date gate must not inspect Operon private settings.",
);

const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
assert.equal(
  packageJson.scripts["smoke:operon-36-behaviors-live"],
  "node scripts/smoke-operon-36-behaviors-live.mjs",
);
assert.equal(
  packageJson.scripts["test:operon-36-behavior-contract"],
  "node scripts/test-operon-36-behavior-contract.mjs",
);
assert.match(
  packageJson.scripts["check:operon"],
  /test:operon-36-behavior-contract/u,
  "The aggregate Operon gate must include the 3.6 behavior contract.",
);
assert.match(
  packageJson.scripts["check:operon"],
  /test:operon-canary-path-safety/u,
  "The aggregate Operon gate must include the destructive canary path-safety contract.",
);
const workflow = await readFile(
  path.join(projectRoot, ".github", "workflows", "operon-bridge.yml"),
  "utf8",
);
for (const required of [
  "scripts/smoke-operon-36-behaviors-live.mjs",
  "scripts/test-operon-36-behavior-contract.mjs",
  "npm --prefix plugins/obsidian-operon-bridge ci",
  "npm run test:operon-canary-path-safety",
  "npm run test:operon-36-behavior-contract",
]) {
  assert.equal(
    workflow.includes(required),
    true,
    `Operon CI is missing ${required}.`,
  );
}
const bridgeInstallIndex = workflow.indexOf(
  "npm --prefix plugins/obsidian-operon-bridge ci",
);
const pathSafetyIndex = workflow.indexOf(
  "npm run test:operon-canary-path-safety",
);
assert.equal(
  bridgeInstallIndex < pathSafetyIndex,
  true,
  "Operon CI must install Bridge dependencies before the manifest rebuild gate.",
);

for (const canarySource of [
  await readFile(
    path.join(projectRoot, "scripts", "smoke-operon-35-live.mjs"),
    "utf8",
  ),
  source,
]) {
  assert.match(
    canarySource,
    /process\.env\.npm_execpath\?\.trim\(\)/u,
    "Canary Bridge rebuilds must use npm's cross-platform executable path.",
  );
  assert.match(
    canarySource,
    /process\.platform === "win32"/u,
    "Direct canary invocation must retain an OS-aware npm CLI fallback.",
  );
}

const frenchReadme = await readFile(
  path.join(projectRoot, "README.fr.md"),
  "utf8",
);
assert.match(
  frenchReadme,
  /Optimike MCP `3\.8\.1` cible Operon officiel `3\.6\.1`/u,
  "The French entrypoint must name the current MCP and Operon targets.",
);

const validationRunbook = await readFile(
  path.join(projectRoot, "docs", "operon-local-validation.md"),
  "utf8",
);
for (const required of [
  "official Operon `3.6.1` reports",
  "official Operon `3.6.1` exposes mutations",
  "target, Operon `3.6.1`",
  "Operon 3.6.1 grant reapproval gate (mandatory)",
  "temporary `1.0.0`",
  "`0.9.2` grant became active",
  "stale source revisions",
  "revoked authority",
  "binding drift",
]) {
  assert.ok(
    validationRunbook.includes(required),
    `The Operon 3.6.1 runbook is missing ${required}.`,
  );
}

const decisionReport = await readFile(
  path.join(projectRoot, "docs", "operon-decision-report.md"),
  "utf8",
);
assert.match(
  decisionReport,
  /Current authority: Optimike MCP `3\.8\.1` targets Operon `3\.6\.1`/u,
);
assert.match(decisionReport, /Historical 3\.2\.0 candidate admission/u);
assert.match(decisionReport, /Bridge 0\.8\.3 was the historical 3\.2\.0 candidate/u);

console.log("Operon 3.6 behavior canary contract tests passed.");
