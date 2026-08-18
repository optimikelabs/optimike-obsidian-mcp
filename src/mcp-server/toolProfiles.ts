import {
  TOOL_GROUP_IDS,
  compileToolSurface,
  getToolSurfaceEntry,
  type ToolGroupId,
  type ToolRegistrationMode,
  type ToolStaticRequirement,
  type ToolSurfaceEntry,
} from "./toolSurfaceRegistry.js";

export const TOOL_PROFILE_IDS = [
  "standard",
  "authoring",
  "tasks",
  "full",
] as const;

export type ToolProfileId = (typeof TOOL_PROFILE_IDS)[number];

export interface ToolProfileDefinition {
  id: ToolProfileId;
  description: string;
  groups: readonly ToolGroupId[];
  preferCanonicalAlternatives: boolean;
}

const STANDARD_GROUPS = [
  "notes.read",
  "notes.direct.common",
  "notes.governed",
  "metadata.direct.frontmatter",
  "metadata.governed",
  "bases.read",
  "semantic.canonical",
  "runtime.status",
  "validation",
] as const satisfies readonly ToolGroupId[];

const AUTHORING_GROUPS = [
  ...STANDARD_GROUPS,
  "metadata.direct.tags",
  "bases.direct",
  "bases.governed",
  "canvas.direct",
  "canvas.governed",
] as const satisfies readonly ToolGroupId[];

const TASK_GROUPS = [
  "notes.read",
  "tasks.markdown",
  "tasks.operon.read",
  "tasks.operon.write",
  "semantic.canonical",
  "runtime.status",
  "validation",
] as const satisfies readonly ToolGroupId[];

const OPERON_LIVE_ONLY_READ_TOOLS = new Set([
  "operon_query_saved_filter",
  "operon_get_diagnostics",
  "operon_find_tasks",
  "operon_resolve_task",
  "operon_get_relationships",
  "operon_build_context",
  "operon_get_timer_state",
  "operon_list_pending_recoveries",
]);

const GOVERNED_LIFECYCLE_ROLES = [
  "plan",
  "apply",
  "status",
  "recover",
] as const;

export const TOOL_PROFILES: Readonly<Record<ToolProfileId, ToolProfileDefinition>> = {
  standard: {
    id: "standard",
    description:
      "General Obsidian work: read/search, canonical semantic search, bounded direct note edits, governed note/frontmatter lifecycles when available, Bases reads, format validation and runtime status.",
    groups: STANDARD_GROUPS,
    preferCanonicalAlternatives: true,
  },
  authoring: {
    id: "authoring",
    description:
      "Content and structure authoring: standard plus tags, Bases writes/formulas and Canvas mutation surfaces appropriate to the active runtime.",
    groups: AUTHORING_GROUPS,
    preferCanonicalAlternatives: true,
  },
  tasks: {
    id: "tasks",
    description:
      "Task-focused work: note context, Markdown Tasks compatibility, the complete Operon MCP contract when the Desktop Bridge is configured, and only the snapshot-safe Operon read subset in non-live runtimes.",
    groups: TASK_GROUPS,
    preferCanonicalAlternatives: true,
  },
  full: {
    id: "full",
    description:
      "Compatibility surface: every tool registered by the active runtime, including legacy aliases, unavailable fail-closed compatibility tools, admin, maintenance and external-root capabilities.",
    groups: TOOL_GROUP_IDS,
    preferCanonicalAlternatives: false,
  },
};

export function isToolProfileId(value: string): value is ToolProfileId {
  return (TOOL_PROFILE_IDS as readonly string[]).includes(value);
}

export function parseToolProfileId(value: string): ToolProfileId {
  if (!isToolProfileId(value)) {
    throw new Error(
      `Unknown MCP tool profile ${JSON.stringify(value)}. Expected one of: ${TOOL_PROFILE_IDS.join(", ")}.`,
    );
  }
  return value;
}

export interface CompileToolProfileInput {
  profile: ToolProfileId;
  registrationMode: ToolRegistrationMode;
  availableStaticRequirements?: readonly ToolStaticRequirement[];
}

function suppressPreferredFallbacks(
  entries: readonly ToolSurfaceEntry[],
): readonly ToolSurfaceEntry[] {
  const availableFamilies = new Set(entries.map((entry) => entry.family));
  return entries.filter(
    (entry) =>
      !entry.preferredAlternativeFamily ||
      !availableFamilies.has(entry.preferredAlternativeFamily),
  );
}

function lifecycleRolesByFamily(
  entries: readonly ToolSurfaceEntry[],
): Map<string, Set<string>> {
  const lifecycleByFamily = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.lifecycleRole) continue;
    const roles = lifecycleByFamily.get(entry.family) ?? new Set<string>();
    roles.add(entry.lifecycleRole);
    lifecycleByFamily.set(entry.family, roles);
  }
  return lifecycleByFamily;
}

function lifecycleIsComplete(roles: ReadonlySet<string>): boolean {
  return (
    roles.size === GOVERNED_LIFECYCLE_ROLES.length &&
    GOVERNED_LIFECYCLE_ROLES.every((role) => roles.has(role))
  );
}

function hideIncompleteGovernedFamilies(
  entries: readonly ToolSurfaceEntry[],
): readonly ToolSurfaceEntry[] {
  const lifecycleByFamily = lifecycleRolesByFamily(entries);
  const completeFamilies = new Set(
    [...lifecycleByFamily]
      .filter(([, roles]) => lifecycleIsComplete(roles))
      .map(([family]) => family),
  );

  return entries.filter(
    (entry) => !entry.lifecycleRole || completeFamilies.has(entry.family),
  );
}

function assertGovernedFamiliesAtomic(entries: readonly ToolSurfaceEntry[]): void {
  for (const [family, roles] of lifecycleRolesByFamily(entries)) {
    if (!lifecycleIsComplete(roles)) {
      throw new Error(
        `Tool profile exposes an incomplete governed lifecycle for ${family}: ${[...roles].sort().join(", ")}.`,
      );
    }
  }
}

function operonLiveForRegistrationMode(
  registrationMode: ToolRegistrationMode,
): boolean {
  return registrationMode === "live" || registrationMode === "hybrid-live";
}

function modernRuntimeAvailable(
  entry: ToolSurfaceEntry,
  operonLive: boolean,
): boolean {
  if (entry.group === "tasks.operon.write") return operonLive;
  if (
    entry.group === "tasks.operon.read" &&
    OPERON_LIVE_ONLY_READ_TOOLS.has(entry.name)
  ) {
    return operonLive;
  }
  return true;
}

interface FinalizeProfileEntriesOptions {
  tolerateIncompleteRegistration?: boolean;
}

function finalizeProfileEntries(
  definition: ToolProfileDefinition,
  entries: readonly ToolSurfaceEntry[],
  operonLive: boolean,
  options: FinalizeProfileEntriesOptions = {},
): readonly ToolSurfaceEntry[] {
  let selected =
    definition.id === "full"
      ? entries
      : entries.filter((entry) => modernRuntimeAvailable(entry, operonLive));

  // A concrete McpServer registers tools one at a time. During that transient
  // construction phase a governed quartet is necessarily incomplete. Keep the
  // whole family disabled until all four members exist, then expose it in one
  // reconciliation. Static profile compilation remains strict and will still
  // fail on an actually incomplete catalogue.
  if (options.tolerateIncompleteRegistration) {
    selected = hideIncompleteGovernedFamilies(selected);
  }

  if (definition.preferCanonicalAlternatives) {
    selected = suppressPreferredFallbacks(selected);
  }
  assertGovernedFamiliesAtomic(selected);
  return [...selected].sort((left, right) => left.name.localeCompare(right.name));
}

export function compileToolProfile({
  profile,
  registrationMode,
  availableStaticRequirements,
}: CompileToolProfileInput): readonly ToolSurfaceEntry[] {
  const definition = TOOL_PROFILES[profile];
  const entries = compileToolSurface({
    registrationMode,
    groups: definition.groups,
    availableStaticRequirements,
  });
  return finalizeProfileEntries(
    definition,
    entries,
    operonLiveForRegistrationMode(registrationMode),
  );
}

export function compileToolProfileNames(
  input: CompileToolProfileInput,
): readonly string[] {
  return compileToolProfile(input).map((entry) => entry.name);
}

export interface SelectAvailableToolProfileInput {
  profile: ToolProfileId;
  availableNames: readonly string[];
}

/**
 * Select a profile from the tools that a concrete server/proxy actually has.
 * This is the runtime authority used by P2/P3: it intersects the portable
 * profile contract with real registration rather than predicting availability.
 *
 * `full` intentionally preserves unknown future names for 2.x compatibility.
 * Modern profiles fail closed on unknown names and hide Operon tools whose
 * service contract is statically live-only. Presence of the governed note
 * family is used as the concrete live/hybrid marker because it is registered
 * before Operon in live-capable server construction and is absent headlessly.
 *
 * Registration is incremental, so a governed quartet may be transiently
 * incomplete while the server factory is still constructing the instance. In
 * that case the entire family remains hidden until all four names are present.
 */
export function selectAvailableToolProfileNames({
  profile,
  availableNames,
}: SelectAvailableToolProfileInput): readonly string[] {
  const uniqueNames = [...new Set(availableNames)];
  if (profile === "full") {
    return uniqueNames.sort((left, right) => left.localeCompare(right));
  }

  const definition = TOOL_PROFILES[profile];
  const groups = new Set<ToolGroupId>(definition.groups);
  const entries = uniqueNames
    .map((name) => getToolSurfaceEntry(name))
    .filter((entry): entry is ToolSurfaceEntry => Boolean(entry))
    .filter((entry) => groups.has(entry.group));
  const operonLive = uniqueNames.includes("obsidian_note_replace_plan");

  return finalizeProfileEntries(definition, entries, operonLive, {
    tolerateIncompleteRegistration: true,
  }).map((entry) => entry.name);
}
