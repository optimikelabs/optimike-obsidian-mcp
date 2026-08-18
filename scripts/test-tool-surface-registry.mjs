import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_GROUP_IDS,
  TOOL_REGISTRATION_MODES,
  TOOL_SURFACE_REGISTRY,
  compileToolNames,
  compileToolSurface,
  getToolSurfaceEntry,
} from "../dist/mcp-server/toolSurfaceRegistry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_UNION_COUNT = 76;
const EXPECTED_COUNTS_BY_MODE = {
  live: 72,
  "hybrid-live": 72,
  "hybrid-degraded": 45,
  "headless-readonly": 48,
  "headless-guarded": 51,
  "headless-filesystem": 60,
};

assert.equal(
  TOOL_SURFACE_REGISTRY.length,
  EXPECTED_UNION_COUNT,
  "canonical registry must cover the union of all currently registered tool names",
);

const names = TOOL_SURFACE_REGISTRY.map((entry) => entry.name);
assert.equal(new Set(names).size, names.length, "tool names must be unique");

for (const mode of TOOL_REGISTRATION_MODES) {
  const compiled = compileToolNames({ registrationMode: mode });
  assert.equal(
    compiled.length,
    EXPECTED_COUNTS_BY_MODE[mode],
    `unexpected full tool count for ${mode}`,
  );
  assert.deepEqual(
    compiled,
    [...compiled].sort((left, right) => left.localeCompare(right)),
    `${mode} compilation must be deterministic and sorted`,
  );
  assert.equal(
    new Set(compiled).size,
    compiled.length,
    `${mode} compilation must not contain duplicate tools`,
  );
}

assert.equal(
  compileToolNames({ registrationMode: "live" }).length,
  72,
  "72 is the current full live/hybrid surface, not the cross-runtime registry size",
);

for (const entry of TOOL_SURFACE_REGISTRY) {
  assert.ok(TOOL_GROUP_IDS.includes(entry.group), `unknown group for ${entry.name}`);
  assert.ok(
    entry.registrationModes.length > 0,
    `${entry.name} must be registered in at least one mode`,
  );
  if (entry.aliasOf) {
    assert.equal(entry.surfaceClass, "legacy", `${entry.name} alias must be legacy`);
    assert.equal(
      entry.canonicalName,
      entry.aliasOf,
      `${entry.name} canonicalName must resolve to aliasOf`,
    );
    assert.ok(
      getToolSurfaceEntry(entry.aliasOf),
      `${entry.name} points to missing canonical tool ${entry.aliasOf}`,
    );
  } else {
    assert.equal(
      entry.canonicalName,
      entry.name,
      `${entry.name} must be self-canonical when it is not an alias`,
    );
  }
}

assert.equal(getToolSurfaceEntry("smart_search")?.aliasOf, "smart_semantic_search");
assert.equal(getToolSurfaceEntry("smart-search")?.aliasOf, "smart_semantic_search");
assert.equal(
  getToolSurfaceEntry("bases_upsert_config")?.group,
  "bases.compat",
  "whole-Base replacement must have its own compatibility group",
);

const expectedLifecycleRoles = ["apply", "plan", "recover", "status"];
const governedFamilies = new Map();
for (const entry of TOOL_SURFACE_REGISTRY) {
  if (!entry.lifecycleRole) continue;
  const items = governedFamilies.get(entry.family) ?? [];
  items.push(entry);
  governedFamilies.set(entry.family, items);
}
assert.equal(governedFamilies.size, 4, "exactly four governed lifecycle families are expected");

for (const [family, entries] of governedFamilies) {
  assert.deepEqual(
    entries.map((entry) => entry.lifecycleRole).sort(),
    expectedLifecycleRoles,
    `${family} must expose plan/apply/status/recover as one atomic family`,
  );
  assert.equal(
    new Set(entries.map((entry) => entry.group)).size,
    1,
    `${family} lifecycle must stay in one group`,
  );
  assert.equal(
    new Set(entries.map((entry) => entry.registrationModes.join("|"))).size,
    1,
    `${family} lifecycle must share one registration boundary`,
  );
}

const selected = compileToolSurface({
  registrationMode: "live",
  groups: ["semantic.canonical", "validation"],
});
assert.deepEqual(
  selected.map((entry) => entry.name),
  ["obsidian_validate_format", "smart_semantic_search"],
  "group composition must expose only the requested canonical tools",
);

function collectSourceFiles(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectSourceFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      result.push(absolute);
    }
  }
  return result;
}

const registrySource = path.join(
  repoRoot,
  "src",
  "mcp-server",
  "toolSurfaceRegistry.ts",
);
const sourceFiles = collectSourceFiles(path.join(repoRoot, "src", "mcp-server")).filter(
  (file) => path.resolve(file) !== path.resolve(registrySource),
);
const sourceCorpus = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");

for (const entry of TOOL_SURFACE_REGISTRY) {
  assert.ok(
    sourceCorpus.includes(`\"${entry.name}\"`) || sourceCorpus.includes(`'${entry.name}'`),
    `registry entry ${entry.name} is not present outside the registry itself`,
  );
}

const sourceDeclaredTools = new Set();
const literalPatterns = [
  /server\.tool\(\s*["'`]([^"'`]+)["'`]/gu,
  /const\s+toolName\s*=\s*["'`]([^"'`]+)["'`]/gu,
  /register\(\s*["'`](smart(?:_|-)[^"'`]+)["'`]/gu,
  /name:\s*["'`](external_[^"'`]+)["'`]/gu,
];
for (const sourceFile of sourceFiles) {
  const source = fs.readFileSync(sourceFile, "utf8");
  for (const pattern of literalPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      sourceDeclaredTools.add(match[1]);
    }
  }
}

for (const name of sourceDeclaredTools) {
  assert.ok(
    getToolSurfaceEntry(name),
    `MCP source declares ${name} but the canonical registry does not`,
  );
}

console.log(
  `PASS: canonical tool registry covers ${TOOL_SURFACE_REGISTRY.length} cross-runtime names; live=${EXPECTED_COUNTS_BY_MODE.live}, headless-filesystem=${EXPECTED_COUNTS_BY_MODE["headless-filesystem"]}; whole-Base compatibility is isolated`,
);
