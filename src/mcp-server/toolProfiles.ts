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
      "Task-focused work: note context, Markdown Tasks compatibility, the complete Operon MCP contract, canonical semantic search, validation and runtime status.",
    groups: TASK_GROUPS,
    preferCanonicalAlternatives: true,
  },
  full: {
    id: "full",
    description:
      "Compatibility surface: every tool registered by the active runtime, including legacy aliases, admin, maintenance and external-root capabilities.",
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

function assertGovernedFamiliesAtomic(entries: readonly ToolSurfaceEntry[]): void {
  const lifecycleByFamily = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!entry.lifecycleRole) continue;
    const roles = lifecycleByFamily.get(entry.family) ?? new Set<string>();
    roles.add(entry.lifecycleRole);
    lifecycleByFamily.set(entry.family, roles);
  }

  const complete = new Set(["plan", "apply", "status", "recover"]);
  for (const [family, roles] of lifecycleByFamily) {
    if (
      roles.size !== complete.size ||
      [...complete].some((role) => !roles.has(role))
    ) {
      throw new Error(
        `Tool profile exposes an incomplete governed lifecycle for ${family}: ${[...roles].sort().join(", ")}.`,
      );
    }
  }
}

function finalizeProfileEntries(
  definition: ToolProfileDefinition,
  entries: readonly ToolSurfaceEntry[],
): readonly ToolSurfaceEntry[] {
  const selected = definition.preferCanonicalAlternatives
    ? suppressPreferredFallbacks(entries)
    : entries;
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
  return finalizeProfileEntries(definition, entries);
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
 * Modern profiles fail closed on unknown names by omitting them until the
 * canonical registry classifies them.
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

  return finalizeProfileEntries(definition, entries).map((entry) => entry.name);
}
