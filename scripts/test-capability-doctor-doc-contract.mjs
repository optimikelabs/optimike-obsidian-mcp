#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  english,
  french,
  readme,
  readmeFrench,
  operations,
  operationsFrench,
  registration,
  manifestSource,
  canarySource,
  packageSource,
] = await Promise.all(
  [
    "docs/capability-doctor.md",
    "docs/capability-doctor.fr.md",
    "README.md",
    "README.fr.md",
    "OPERATIONS.md",
    "OPERATIONS.fr.md",
    "src/mcp-server/tools/runtimeTools/registration.ts",
    "src/services/capabilityManifest.ts",
    "scripts/smoke-capability-doctor-live.mjs",
    "package.json",
  ].map((file) => readFile(file, "utf8")),
);

for (const [label, document] of [
  ["English", english],
  ["French", french],
]) {
  for (const contractToken of [
    "obsidian_runtime_status",
    "capabilityManifest",
    "contractVersion: 1",
    "discoverable",
    "available",
    "authorized",
    "profile_hidden",
    "runtime_mode_unavailable",
    "runtime_not_initialized",
    "operon_snapshot_fallback",
    "operon_capability_not_advertised",
    "operon_partial_capabilities",
    "mcp_operon_mutations_disabled",
    "write_policy_blocked",
    "semantic_query_embedding_disabled",
    "semantic_index_unavailable",
    "refresh_semantic_index",
    "semantic_embedder_unavailable",
    "configure_query_embedder",
    "ENABLE_QUERY_EMBEDDING",
    "operon_duplicate_conflicts",
    "npm run test:capability-doctor",
    "npm run smoke:capability-doctor-live",
    "vaultMutations: 0",
  ]) {
    assert.ok(
      document.includes(contractToken),
      `${label} doctor contract lost ${contractToken}`,
    );
  }
}
assert.ok(english.includes("2.5"), "English probe timeout drifted");
assert.ok(french.includes("2,5"), "French probe timeout drifted");

assert.ok(readme.includes("docs/capability-doctor.md"));
assert.ok(readmeFrench.includes("docs/capability-doctor.fr.md"));
assert.ok(operations.includes("docs/capability-doctor.md"));
assert.ok(operationsFrench.includes("docs/capability-doctor.fr.md"));
assert.equal(
  (registration.match(/"obsidian_runtime_status"/gu) ?? []).length,
  1,
  "the doctor must evolve the canonical runtime status registration",
);
assert.doesNotMatch(
  registration,
  /server\.tool\(\s*["'](?:obsidian_)?capability_doctor/gu,
  "P2 must not add a second diagnostic tool",
);
assert.match(manifestSource, /CAPABILITY_PROBE_TIMEOUT_MS\s*=\s*2_500/u);
assert.match(
  canarySource,
  /mkdtempSync\(\s*path\.join\(os\.tmpdir\(\)/u,
  "the canary journals and cache must remain outside the repository",
);
assert.doesNotMatch(
  canarySource,
  /path\.join\(process\.cwd\(\),\s*["']\.tmp["']/u,
  "the live canary must not retain private recovery artifacts in the repo",
);

const packageJson = JSON.parse(packageSource);
for (const file of [
  "docs/capability-doctor.md",
  "docs/capability-doctor.fr.md",
]) {
  assert.ok(packageJson.files.includes(file), `package lost ${file}`);
}
assert.ok(packageJson.scripts["test:capability-doctor"]);

console.log("Capability doctor documentation contract passed.");
