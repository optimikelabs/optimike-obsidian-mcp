import assert from "node:assert/strict";
import {
  TOOL_BUNDLES,
  TOOL_CATALOG,
  TOOL_SURFACE_PROFILES,
  compileToolSurface,
  parseToolSurfaceProfile,
  validateToolBundles,
} from "../dist/mcp-server/toolSurface/catalog.js";
import { resolveProfileFromCli } from "../dist/mcp-server/toolSurface/runtime.js";

const all = [...TOOL_CATALOG.keys()];
assert.equal(TOOL_CATALOG.size, 74);
assert.equal(TOOL_CATALOG.has("smart_search"), false);
assert.equal(TOOL_CATALOG.has("smart-search"), false);
assert.equal(TOOL_CATALOG.has("smart_semantic_search"), true);

const expectedWithoutExternal = {
  standard: 22,
  authoring: 30,
  tasks: 31,
  full: 74,
};
const expectedWithExternal = {
  standard: 22,
  authoring: 36,
  tasks: 31,
  full: 74,
};

for (const profile of TOOL_SURFACE_PROFILES) {
  const withoutExternal = compileToolSurface(profile, all, {
    externalRootsConfigured: false,
  });
  const withExternal = compileToolSurface(profile, all, {
    externalRootsConfigured: true,
  });
  assert.equal(withoutExternal.size, expectedWithoutExternal[profile]);
  assert.equal(withExternal.size, expectedWithExternal[profile]);
  validateToolBundles(withoutExternal);
  validateToolBundles(withExternal);
}

const standard = compileToolSurface("standard", all);
assert.equal(standard.has("smart_semantic_search"), true);
assert.equal(standard.has("operon_status"), false);
assert.equal(standard.has("obsidian_delete_note"), false);
assert.equal(standard.has("bases_upsert_config"), false);

const tasks = compileToolSurface("tasks", all);
for (const name of [
  "operon_create_task",
  "operon_list_pending_recoveries",
  "operon_recover_mutation",
]) {
  assert.equal(tasks.has(name), true, `tasks profile omits ${name}`);
}

const noGovernedFrontmatter = all.filter(
  (name) => !name.startsWith("obsidian_frontmatter_patch_"),
);
const standardFallback = compileToolSurface(
  "standard",
  noGovernedFrontmatter,
);
assert.equal(standardFallback.has("obsidian_manage_frontmatter"), true);

const noGovernedCanvas = all.filter(
  (name) => !name.startsWith("obsidian_canvas_patch_"),
);
const authoringFallback = compileToolSurface(
  "authoring",
  noGovernedCanvas,
);
assert.equal(authoringFallback.has("obsidian_manage_canvas"), true);

for (const [bundleId, bundle] of TOOL_BUNDLES) {
  const partial = new Set([bundle.values().next().value]);
  assert.throws(
    () => validateToolBundles(partial),
    new RegExp(bundleId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
}

assert.equal(parseToolSurfaceProfile(undefined), "standard");
assert.equal(parseToolSurfaceProfile("full"), "full");
assert.throws(() => parseToolSurfaceProfile("standrad"), /Unknown MCP tool profile/u);

assert.deepEqual(
  resolveProfileFromCli(["--tool-profile", "tasks", "--other"], "standard"),
  { profile: "tasks", argv: ["--other"] },
);
assert.deepEqual(
  resolveProfileFromCli(["--tool-profile=authoring"], "tasks"),
  { profile: "authoring", argv: [] },
);
assert.throws(
  () => resolveProfileFromCli(["--tool-profile"], undefined),
  /requires a value/u,
);
assert.throws(
  () =>
    resolveProfileFromCli(
      ["--tool-profile=standard", "--tool-profile=full"],
      undefined,
    ),
  /more than once/u,
);

assert.throws(
  () => compileToolSurface("standard", [...all, "unknown_tool"]),
  /absent from the V3 catalogue/u,
);

console.log("PASS: V3 catalogue, profiles, fallbacks and bundles are coherent");
