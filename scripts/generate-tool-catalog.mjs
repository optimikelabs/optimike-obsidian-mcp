import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.join(repoRoot, "evals", "tool-catalog.v1.json");

const registry = await import("../dist/mcp-server/toolSurfaceRegistry.js");
const profiles = await import("../dist/mcp-server/toolProfiles.js");

const STATIC_REQUIREMENTS = ["vault-cache"];

// These are compatibility routes, not aliases: the old names remain distinct
// public tools and are retained only so callers can migrate safely.
const COMPATIBILITY_FALLBACKS = Object.freeze({
  list_all_tasks: ["operon_list_tasks"],
  query_tasks: ["operon_query_tasks"],
  bases_upsert_config: ["bases_formula_patch_plan"],
});

function sortedNames(names) {
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function compileProfileMode(profileId, mode) {
  return profiles.compileToolProfileNames({
    profile: profileId,
    registrationMode: mode,
    availableStaticRequirements: STATIC_REQUIREMENTS,
  });
}

function buildCatalog() {
  const entries = [...registry.TOOL_SURFACE_REGISTRY].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const modes = Object.fromEntries(
    registry.TOOL_REGISTRATION_MODES.map((mode) => [
      mode,
      sortedNames(
        registry
          .compileToolSurface({
            registrationMode: mode,
            availableStaticRequirements: STATIC_REQUIREMENTS,
          })
          .map((entry) => entry.name),
      ),
    ]),
  );
  const profileModes = Object.fromEntries(
    profiles.TOOL_PROFILE_IDS.map((profileId) => [
      profileId,
      Object.fromEntries(
        registry.TOOL_REGISTRATION_MODES.map((mode) => [
          mode,
          sortedNames(compileProfileMode(profileId, mode)),
        ]),
      ),
    ]),
  );
  const familyTools = new Map();
  for (const entry of entries) {
    const names = familyTools.get(entry.family) ?? [];
    names.push(entry.name);
    familyTools.set(entry.family, names);
  }

  const tools = entries.map((entry) => {
    const profileIds = profiles.TOOL_PROFILE_IDS.filter((profileId) =>
      Object.values(profileModes[profileId]).some((names) =>
        names.includes(entry.name),
      ),
    );
    const item = {
      name: entry.name,
      canonicalName: entry.canonicalName,
      classification: entry.classification,
      group: entry.group,
      family: entry.family,
      surfaceClass: entry.surfaceClass,
      annotationClass: entry.annotationClass,
      registrationModes: [...entry.registrationModes],
      profiles: profileIds,
      profileModes: Object.fromEntries(
        profileIds.map((profileId) => [
          profileId,
          registry.TOOL_REGISTRATION_MODES.filter((mode) =>
            profileModes[profileId][mode].includes(entry.name),
          ),
        ]),
      ),
    };
    if (entry.lifecycleRole) item.lifecycleRole = entry.lifecycleRole;
    if (entry.aliasOf) item.aliasOf = entry.aliasOf;
    if (entry.preferredAlternativeFamily) {
      item.replacement = {
        family: entry.preferredAlternativeFamily,
        tools: sortedNames(
          familyTools.get(entry.preferredAlternativeFamily) ?? [],
        ),
      };
      item.fallback = {
        tools: [entry.name],
        modes: registry.TOOL_REGISTRATION_MODES.filter(
          (mode) =>
            !item.replacement.tools.some((name) => modes[mode].includes(name)),
        ),
      };
    } else if (COMPATIBILITY_FALLBACKS[entry.name]) {
      item.replacement = {
        tools: [...COMPATIBILITY_FALLBACKS[entry.name]],
      };
    }
    if (entry.availabilityRules) {
      item.availabilityRules = entry.availabilityRules.map((rule) => ({
        modes: [...rule.modes],
        requires: [...rule.requires],
      }));
    }
    return item;
  });

  const classificationCounts = Object.fromEntries(
    registry.TOOL_CLASSIFICATION_IDS.map((classification) => [
      classification,
      tools.filter((entry) => entry.classification === classification).length,
    ]),
  );
  return {
    schemaVersion: "tool-catalog.v1",
    version: 1,
    source: "src/mcp-server/toolSurfaceRegistry.ts",
    toolCount: tools.length,
    classificationCounts,
    modes,
    profiles: Object.fromEntries(
      profiles.TOOL_PROFILE_IDS.map((profileId) => [
        profileId,
        {
          description: profiles.TOOL_PROFILES[profileId].description,
          modes: profileModes[profileId],
        },
      ]),
    ),
    tools,
  };
}

export { buildCatalog };

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(buildCatalog(), null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)}\n`);
}
