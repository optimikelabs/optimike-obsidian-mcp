import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_CLASSIFICATION_IDS,
  TOOL_REGISTRATION_MODES,
  TOOL_SURFACE_REGISTRY,
} from "../dist/mcp-server/toolSurfaceRegistry.js";
import { buildCatalog } from "./generate-tool-catalog.mjs";
import { TOOL_PROFILE_IDS } from "../dist/mcp-server/toolProfiles.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactPath = path.join(repoRoot, "evals", "tool-catalog.v1.json");
assert.ok(fs.existsSync(artifactPath), "tool catalog artifact is missing");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const regenerated = buildCatalog();

assert.deepEqual(
  artifact,
  regenerated,
  "tool catalog is stale; run node scripts/generate-tool-catalog.mjs",
);
assert.equal(artifact.schemaVersion, "tool-catalog.v1");
assert.equal(artifact.version, 1);
assert.equal(artifact.toolCount, TOOL_SURFACE_REGISTRY.length);
assert.equal(artifact.tools.length, TOOL_SURFACE_REGISTRY.length);

const registryNames = TOOL_SURFACE_REGISTRY.map((entry) => entry.name);
const catalogNames = artifact.tools.map((entry) => entry.name);
assert.equal(new Set(registryNames).size, registryNames.length);
for (const [name, classification] of [
  ["bases_functions", "canonical-unique"],
  ["bases_check", "diagnostic"],
]) {
  const entry = artifact.tools.find((tool) => tool.name === name);
  assert.equal(entry?.classification, classification, `${name} classification`);
  assert.equal(entry.annotationClass, "read-only", `${name} must stay read-only`);
}
assert.deepEqual(
  catalogNames,
  [...registryNames].sort((a, b) => a.localeCompare(b)),
);

for (const entry of artifact.tools) {
  assert.ok(TOOL_CLASSIFICATION_IDS.includes(entry.classification));
  assert.deepEqual(
    entry.registrationModes,
    TOOL_SURFACE_REGISTRY.find((candidate) => candidate.name === entry.name)
      .registrationModes,
  );
  assert.ok(Array.isArray(entry.profiles));
  assert.ok(entry.profileModes && typeof entry.profileModes === "object");
}

assert.equal(artifact.classificationCounts["alias-redundant"], 0);
assert.equal(
  Object.values(artifact.classificationCounts).reduce((sum, count) => sum + count, 0),
  artifact.toolCount,
  "every tool has exactly one classification",
);

const governed = artifact.tools.filter(
  (entry) => entry.classification === "governed-operation",
);
const governedFamilies = new Map();
for (const entry of governed) {
  const roles = governedFamilies.get(entry.family) ?? [];
  roles.push(entry.lifecycleRole);
  governedFamilies.set(entry.family, roles);
}
assert.deepEqual([...governedFamilies.keys()].sort(), [
  "asset-import", "base-config-patch", "base-create", "base-formula-patch", "base-rows",
  "canvas-create", "canvas-patch", "frontmatter-patch", "note-create", "note-delete",
  "note-move", "note-replace", "operation-revert", "text-patch",
]);
for (const [family, roles] of governedFamilies) {
  assert.deepEqual([...roles].sort(), ["note-move", "note-delete", "note-create", "base-create", "canvas-create", "base-rows", "asset-import"].includes(family) ? ["apply", "plan", "status"] : ["apply", "plan", "recover", "status"]);
}

const directAlternatives = [
  "obsidian_update_note",
  "obsidian_search_replace",
  "obsidian_manage_frontmatter",
  "obsidian_manage_canvas",
];
for (const name of directAlternatives) {
  const entry = TOOL_SURFACE_REGISTRY.find(
    (candidate) => candidate.name === name,
  );
  assert.equal(entry.surfaceClass, "direct");
  assert.ok(entry.preferredAlternativeFamily);
  const catalogEntry = artifact.tools.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(catalogEntry.replacement);
  assert.ok(catalogEntry.fallback);
  for (const mode of catalogEntry.fallback.modes) {
    assert.ok(
      artifact.modes[mode].includes(name),
      `${name} cannot be advertised as a fallback when hidden in ${mode}`,
    );
    assert.equal(
      catalogEntry.replacement.tools.some((replacement) =>
        artifact.modes[mode].includes(replacement),
      ),
      false,
      `${name} cannot be advertised as a fallback beside its governed replacement in ${mode}`,
    );
  }
}
assert.equal(
  TOOL_SURFACE_REGISTRY.find((entry) => entry.name === "bases_upsert_config")
    .classification,
  "compatibility-historical",
);
assert.equal(
  TOOL_SURFACE_REGISTRY.filter((entry) => entry.aliasOf).length,
  0,
  "current registry must contain no aliases",
);

assert.deepEqual(Object.keys(artifact.modes), [...TOOL_REGISTRATION_MODES]);
assert.deepEqual(Object.keys(artifact.profiles), [...TOOL_PROFILE_IDS]);
for (const profileId of TOOL_PROFILE_IDS) {
  assert.deepEqual(Object.keys(artifact.profiles[profileId].modes), [
    ...TOOL_REGISTRATION_MODES,
  ]);
}

console.log(
  "PASS: deterministic conditional catalog is exhaustive, alias-free, profile/mode-complete, and classifies all governed/diagnostic/admin surfaces",
);
