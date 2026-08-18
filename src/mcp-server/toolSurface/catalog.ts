import { createHash } from "node:crypto";

export const TOOL_SURFACE_PROFILE_VERSION = "3.0" as const;
export const TOOL_SURFACE_PROFILES = [
  "standard",
  "authoring",
  "tasks",
  "full",
] as const;

export type ToolSurfaceProfile = (typeof TOOL_SURFACE_PROFILES)[number];
export type ToolRole =
  | "canonical"
  | "direct"
  | "compatibility"
  | "legacy";

export type ToolGroup =
  | "core.read"
  | "runtime.maintenance"
  | "notes.direct"
  | "notes.delete"
  | "notes.governed"
  | "frontmatter.direct"
  | "frontmatter.batch"
  | "frontmatter.governed"
  | "metadata.tags"
  | "bases.read"
  | "bases.write"
  | "bases.compat"
  | "bases.governed"
  | "canvas.direct"
  | "canvas.governed"
  | "tasks.compat"
  | "operon.read"
  | "operon.write"
  | "operon.recovery"
  | "external.read"
  | "external.move"
  | "headless.admin";

export interface ToolCatalogEntry {
  readonly name: string;
  readonly group: ToolGroup;
  readonly family: string;
  readonly role: ToolRole;
  readonly bundleId?: string;
  readonly fallbackForBundle?: string;
}

interface ToolDefinition {
  readonly group: ToolGroup;
  readonly family: string;
  readonly names: readonly string[];
  readonly role?: ToolRole;
  readonly bundleId?: string;
  readonly fallbackForBundle?: string;
}

const DEFINITIONS: readonly ToolDefinition[] = [
  {
    group: "core.read",
    family: "vault",
    names: [
      "obsidian_read_note",
      "obsidian_list_notes",
      "obsidian_global_search",
      "smart_semantic_search",
      "obsidian_validate_format",
      "obsidian_runtime_status",
    ],
  },
  {
    group: "runtime.maintenance",
    family: "runtime",
    names: ["obsidian_runtime_maintenance"],
  },
  {
    group: "notes.direct",
    family: "notes",
    role: "direct",
    names: ["obsidian_update_note", "obsidian_search_replace"],
  },
  {
    group: "notes.delete",
    family: "notes",
    role: "direct",
    names: ["obsidian_delete_note"],
  },
  {
    group: "notes.governed",
    family: "notes",
    bundleId: "notes.replace.governed",
    names: [
      "obsidian_note_replace_plan",
      "obsidian_note_replace_apply",
      "obsidian_note_replace_status",
      "obsidian_note_replace_recover",
    ],
  },
  {
    group: "frontmatter.direct",
    family: "frontmatter",
    role: "direct",
    fallbackForBundle: "frontmatter.patch.governed",
    names: ["obsidian_manage_frontmatter"],
  },
  {
    group: "frontmatter.batch",
    family: "frontmatter",
    role: "direct",
    names: ["obsidian_batch_frontmatter"],
  },
  {
    group: "frontmatter.governed",
    family: "frontmatter",
    bundleId: "frontmatter.patch.governed",
    names: [
      "obsidian_frontmatter_patch_plan",
      "obsidian_frontmatter_patch_apply",
      "obsidian_frontmatter_patch_status",
      "obsidian_frontmatter_patch_recover",
    ],
  },
  {
    group: "metadata.tags",
    family: "metadata",
    role: "direct",
    names: ["obsidian_manage_tags"],
  },
  {
    group: "bases.read",
    family: "bases",
    names: ["bases_list", "bases_get_schema", "bases_query"],
  },
  {
    group: "bases.write",
    family: "bases",
    role: "direct",
    names: ["bases_create", "bases_upsert_rows"],
  },
  {
    group: "bases.compat",
    family: "bases",
    role: "legacy",
    names: ["bases_upsert_config"],
  },
  {
    group: "bases.governed",
    family: "bases",
    bundleId: "bases.formula.governed",
    names: [
      "bases_formula_patch_plan",
      "bases_formula_patch_apply",
      "bases_formula_patch_status",
      "bases_formula_patch_recover",
    ],
  },
  {
    group: "canvas.direct",
    family: "canvas",
    role: "direct",
    fallbackForBundle: "canvas.patch.governed",
    names: ["obsidian_manage_canvas"],
  },
  {
    group: "canvas.governed",
    family: "canvas",
    bundleId: "canvas.patch.governed",
    names: [
      "obsidian_canvas_patch_plan",
      "obsidian_canvas_patch_apply",
      "obsidian_canvas_patch_status",
      "obsidian_canvas_patch_recover",
    ],
  },
  {
    group: "tasks.compat",
    family: "tasks",
    role: "compatibility",
    names: ["list_all_tasks", "query_tasks"],
  },
  {
    group: "operon.read",
    family: "operon",
    names: [
      "operon_status",
      "operon_get_configuration",
      "operon_list_tasks",
      "operon_query_tasks",
      "operon_query_saved_filter",
      "operon_get_task",
      "operon_validate",
      "operon_get_diagnostics",
      "operon_find_tasks",
      "operon_resolve_task",
      "operon_get_relationships",
      "operon_build_context",
      "operon_get_timer_state",
    ],
  },
  {
    group: "operon.write",
    family: "operon",
    role: "direct",
    names: [
      "operon_adopt_task",
      "operon_create_task",
      "operon_update_task",
      "operon_transition_task",
      "operon_convert_task",
      "operon_relocate_task",
      "operon_set_relationships",
      "operon_update_recurrence",
    ],
  },
  {
    group: "operon.recovery",
    family: "operon",
    bundleId: "operon.recovery",
    names: ["operon_list_pending_recoveries", "operon_recover_mutation"],
  },
  {
    group: "external.read",
    family: "external",
    names: [
      "external_runtime_status",
      "external_roots_list",
      "external_list",
      "external_stat",
      "external_read",
      "external_handoff",
    ],
  },
  {
    group: "external.move",
    family: "external",
    bundleId: "external.move.transaction",
    names: [
      "external_references_scan",
      "external_move_plan",
      "external_move_status",
      "external_move_apply",
      "external_move_rollback",
    ],
  },
  {
    group: "headless.admin",
    family: "headless",
    role: "direct",
    names: ["obsidian_admin_filesystem", "obsidian_move_note"],
  },
] as const;

const entries = DEFINITIONS.flatMap((definition) =>
  definition.names.map<ToolCatalogEntry>((name) => ({
    name,
    group: definition.group,
    family: definition.family,
    role: definition.role ?? "canonical",
    bundleId: definition.bundleId,
    fallbackForBundle: definition.fallbackForBundle,
  })),
);

export const TOOL_CATALOG = new Map(
  entries.map((entry) => [entry.name, entry] as const),
);

if (TOOL_CATALOG.size !== entries.length) {
  throw new Error("Optimike tool catalogue contains duplicate names.");
}

// V3 deliberately removes smart_search and smart-search from every public
// runtime surface. The cross-runtime catalogue therefore contains 74 names.
if (TOOL_CATALOG.size !== 74) {
  throw new Error(
    `Optimike V3 tool catalogue must contain 74 names, got ${TOOL_CATALOG.size}.`,
  );
}

export const TOOL_BUNDLES = new Map<string, ReadonlySet<string>>();
for (const entry of entries) {
  if (!entry.bundleId) continue;
  const current = new Set(TOOL_BUNDLES.get(entry.bundleId) ?? []);
  current.add(entry.name);
  TOOL_BUNDLES.set(entry.bundleId, current);
}

const PROFILE_GROUPS: Readonly<Record<ToolSurfaceProfile, ReadonlySet<ToolGroup>>> = {
  standard: new Set<ToolGroup>([
    "core.read",
    "notes.direct",
    "notes.governed",
    "frontmatter.governed",
    "metadata.tags",
    "tasks.compat",
    "bases.read",
  ]),
  authoring: new Set<ToolGroup>([
    "core.read",
    "notes.direct",
    "notes.governed",
    "frontmatter.governed",
    "metadata.tags",
    "bases.read",
    "bases.write",
    "bases.governed",
    "canvas.governed",
    "external.read",
  ]),
  tasks: new Set<ToolGroup>([
    "core.read",
    "tasks.compat",
    "operon.read",
    "operon.write",
    "operon.recovery",
  ]),
  full: new Set<ToolGroup>(DEFINITIONS.map((definition) => definition.group)),
};

export function isToolSurfaceProfile(value: string): value is ToolSurfaceProfile {
  return (TOOL_SURFACE_PROFILES as readonly string[]).includes(value);
}

export function parseToolSurfaceProfile(
  value: string | undefined,
  fallback: ToolSurfaceProfile = "standard",
): ToolSurfaceProfile {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!isToolSurfaceProfile(normalized)) {
    throw new Error(
      `Unknown MCP tool profile ${JSON.stringify(normalized)}. Expected one of: ${TOOL_SURFACE_PROFILES.join(", ")}.`,
    );
  }
  return normalized;
}

export function profileIncludesEntry(
  profile: ToolSurfaceProfile,
  entry: ToolCatalogEntry,
): boolean {
  return PROFILE_GROUPS[profile].has(entry.group);
}

function hasCompleteBundle(
  available: ReadonlySet<string>,
  bundleId: string,
): boolean {
  const bundle = TOOL_BUNDLES.get(bundleId);
  if (!bundle) return false;
  return [...bundle].every((name) => available.has(name));
}

function shouldExposeFallback(
  profile: ToolSurfaceProfile,
  entry: ToolCatalogEntry,
  available: ReadonlySet<string>,
): boolean {
  if (!entry.fallbackForBundle) return false;
  if (profile === "full") return true;
  if (entry.name === "obsidian_manage_frontmatter") {
    return (
      (profile === "standard" || profile === "authoring") &&
      !hasCompleteBundle(available, entry.fallbackForBundle)
    );
  }
  if (entry.name === "obsidian_manage_canvas") {
    return (
      profile === "authoring" &&
      !hasCompleteBundle(available, entry.fallbackForBundle)
    );
  }
  return false;
}

export interface ToolSurfaceCompileOptions {
  readonly externalRootsConfigured?: boolean;
}

function staticallyAvailable(
  profile: ToolSurfaceProfile,
  entry: ToolCatalogEntry,
  options: ToolSurfaceCompileOptions,
): boolean {
  if (profile === "full") return true;
  if (entry.group === "external.read" || entry.group === "external.move") {
    return options.externalRootsConfigured === true;
  }
  return true;
}

export function compileToolSurface(
  profile: ToolSurfaceProfile,
  availableNames: Iterable<string>,
  options: ToolSurfaceCompileOptions = {},
): ReadonlySet<string> {
  const available = new Set(availableNames);
  const unknown = [...available].filter((name) => !TOOL_CATALOG.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime offered tools absent from the V3 catalogue: ${unknown.sort().join(", ")}.`,
    );
  }

  const exposed = new Set<string>();
  for (const name of available) {
    const entry = TOOL_CATALOG.get(name)!;
    if (
      staticallyAvailable(profile, entry, options) &&
      (profile === "full" ||
        profileIncludesEntry(profile, entry) ||
        shouldExposeFallback(profile, entry, available))
    ) {
      exposed.add(name);
    }
  }

  validateToolBundles(exposed);
  return exposed;
}

export function validateToolBundles(exposed: ReadonlySet<string>): void {
  for (const [bundleId, bundle] of TOOL_BUNDLES) {
    const present = [...bundle].filter((name) => exposed.has(name));
    if (present.length !== 0 && present.length !== bundle.size) {
      const missing = [...bundle].filter((name) => !exposed.has(name));
      throw new Error(
        `Tool surface exposes partial bundle ${bundleId}; present=${present.join(",")}; missing=${missing.join(",")}.`,
      );
    }
  }
}

export function toolSurfaceFingerprint(
  profile: ToolSurfaceProfile,
  names: Iterable<string>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: TOOL_SURFACE_PROFILE_VERSION,
        profile,
        tools: [...names].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

export function publicToolCatalog(): readonly ToolCatalogEntry[] {
  return [...TOOL_CATALOG.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
