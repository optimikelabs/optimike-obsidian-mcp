export const TOOL_REGISTRATION_MODES = [
  "live",
  "hybrid-live",
  "hybrid-degraded",
  "headless-readonly",
  "headless-guarded",
  "headless-filesystem",
] as const;

export type ToolRegistrationMode = (typeof TOOL_REGISTRATION_MODES)[number];

export const TOOL_GROUP_IDS = [
  "admin",
  "bases.compat",
  "bases.direct",
  "bases.governed",
  "bases.read",
  "canvas.direct",
  "canvas.governed",
  "external.move",
  "external.read",
  "metadata.direct.batch",
  "metadata.direct.frontmatter",
  "metadata.direct.tags",
  "metadata.governed",
  "notes.direct.admin",
  "notes.direct.common",
  "notes.governed",
  "notes.read",
  "runtime.maintenance",
  "runtime.status",
  "semantic.canonical",
  "tasks.markdown",
  "tasks.operon.read",
  "tasks.operon.write",
  "validation",
] as const;

export type ToolGroupId = (typeof TOOL_GROUP_IDS)[number];

/**
 * Stable LLM-routing classification for every public tool name.
 *
 * This is intentionally separate from `surfaceClass`: a direct tool can be a
 * valid canonical entry while still advertising a safer governed alternative,
 * and a diagnostic tool can be registered on every transport while remaining
 * fail-closed for mutation.
 */
export const TOOL_CLASSIFICATION_IDS = [
  "canonical-unique",
  "alias-redundant",
  "compatibility-historical",
  "governed-operation",
  "diagnostic",
  "administration",
] as const;

export type ToolClassification = (typeof TOOL_CLASSIFICATION_IDS)[number];

export type ToolSurfaceClass = "canonical" | "direct" | "legacy";

export type ToolAnnotationClass =
  | "read-only"
  | "read-only-open-world"
  | "mutation"
  | "destructive"
  | "maintenance"
  | "governed-plan"
  | "governed-mutation";

export type GovernedLifecycleRole = "plan" | "apply" | "status" | "recover";
export type ToolStaticRequirement = "vault-cache";

export interface ToolAvailabilityRule {
  modes: readonly ToolRegistrationMode[];
  requires: readonly ToolStaticRequirement[];
}

export interface ToolSurfaceEntry {
  name: string;
  canonicalName: string;
  classification: ToolClassification;
  group: ToolGroupId;
  family: string;
  registrationModes: readonly ToolRegistrationMode[];
  surfaceClass: ToolSurfaceClass;
  annotationClass: ToolAnnotationClass;
  lifecycleRole?: GovernedLifecycleRole;
  aliasOf?: string;
  preferredAlternativeFamily?: string;
  availabilityRules?: readonly ToolAvailabilityRule[];
}

const CANONICAL_UNIQUE_TOOL_NAMES = [
  "obsidian_read_note",
  "obsidian_list_notes",
  "obsidian_global_search",
  "obsidian_manage_tags",
  "obsidian_batch_frontmatter",
  "list_all_tasks",
  "query_tasks",
  "bases_list",
  "bases_get_schema",
  "bases_query",
  "bases_create",
  "bases_upsert_rows",
  "operon_status",
  "operon_get_configuration",
  "operon_list_tasks",
  "operon_query_tasks",
  "operon_query_saved_filter",
  "operon_get_task",
  "operon_validate",
  "operon_find_tasks",
  "operon_resolve_task",
  "operon_get_relationships",
  "operon_build_context",
  "operon_get_timer_state",
  "operon_list_pending_recoveries",
  "operon_adopt_task",
  "operon_create_periodic_task",
  "operon_update_periodic_scheduling",
  "operon_create_task",
  "operon_update_task",
  "operon_transition_task",
  "operon_relocate_task",
  "operon_set_relationships",
  "operon_update_recurrence",
  "operon_recover_mutation",
  "operon_convert_task",
  "smart_semantic_search",
  "external_roots_list",
  "external_list",
  "external_stat",
  "external_read",
  "external_handoff",
] as const;

const COMPATIBILITY_HISTORICAL_TOOL_NAMES = ["bases_upsert_config"] as const;

const GOVERNED_OPERATION_TOOL_NAMES = [
  "obsidian_note_replace_plan",
  "obsidian_note_replace_apply",
  "obsidian_note_replace_status",
  "obsidian_note_replace_recover",
  "obsidian_text_patch_plan",
  "obsidian_text_patch_apply",
  "obsidian_text_patch_status",
  "obsidian_text_patch_recover",
  "obsidian_frontmatter_patch_plan",
  "obsidian_frontmatter_patch_apply",
  "obsidian_frontmatter_patch_status",
  "obsidian_frontmatter_patch_recover",
  "bases_formula_patch_plan",
  "bases_formula_patch_apply",
  "bases_formula_patch_status",
  "bases_formula_patch_recover",
  "obsidian_canvas_patch_plan",
  "obsidian_canvas_patch_apply",
  "obsidian_canvas_patch_status",
  "obsidian_canvas_patch_recover",
] as const;

const DIAGNOSTIC_TOOL_NAMES = [
  "obsidian_runtime_status",
  "obsidian_list_pending_operations",
  "obsidian_validate_format",
  "operon_get_diagnostics",
  "external_runtime_status",
  "external_references_scan",
  "external_move_plan",
  "external_move_status",
  "external_move_apply",
  "external_move_rollback",
] as const;

const ADMINISTRATION_TOOL_NAMES = [
  "obsidian_admin_filesystem",
  "obsidian_runtime_maintenance",
  "obsidian_delete_note",
  "obsidian_move_note",
] as const;

const DIRECT_WITH_PREFERRED_ALTERNATIVE_TOOL_NAMES = [
  "obsidian_update_note",
  "obsidian_search_replace",
  "obsidian_manage_frontmatter",
  "obsidian_manage_canvas",
] as const;

const TOOL_CLASSIFICATION_GROUPS: Readonly<
  Record<Exclude<ToolClassification, "alias-redundant">, readonly string[]>
> = {
  "canonical-unique": [
    ...CANONICAL_UNIQUE_TOOL_NAMES,
    ...DIRECT_WITH_PREFERRED_ALTERNATIVE_TOOL_NAMES,
  ],
  "compatibility-historical": COMPATIBILITY_HISTORICAL_TOOL_NAMES,
  "governed-operation": GOVERNED_OPERATION_TOOL_NAMES,
  diagnostic: DIAGNOSTIC_TOOL_NAMES,
  administration: ADMINISTRATION_TOOL_NAMES,
};

export const TOOL_CLASSIFICATION_BY_NAME: Readonly<
  Record<string, ToolClassification>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(TOOL_CLASSIFICATION_GROUPS).flatMap(
      ([classification, names]) =>
        names.map((name) => [name, classification] as const),
    ),
  ) as Record<string, ToolClassification>,
);

function classificationForTool(name: string): ToolClassification {
  const classification = TOOL_CLASSIFICATION_BY_NAME[name];
  if (!classification) {
    throw new Error(`Tool ${name} has no authoritative classification.`);
  }
  return classification;
}

const ALL_MODES = TOOL_REGISTRATION_MODES;

const LIVE_MODES = [
  "live",
  "hybrid-live",
] as const satisfies readonly ToolRegistrationMode[];

const BASE_READ_MODES = [
  "live",
  "hybrid-live",
  "headless-readonly",
  "headless-guarded",
  "headless-filesystem",
] as const satisfies readonly ToolRegistrationMode[];

const GUARDED_NOTE_MODES = [
  "live",
  "hybrid-live",
  "headless-guarded",
  "headless-filesystem",
] as const satisfies readonly ToolRegistrationMode[];

const LIVE_OR_FILESYSTEM_MODES = [
  "live",
  "hybrid-live",
  "headless-filesystem",
] as const satisfies readonly ToolRegistrationMode[];

const FILESYSTEM_ONLY = [
  "headless-filesystem",
] as const satisfies readonly ToolRegistrationMode[];

function defineTool(
  name: string,
  group: ToolGroupId,
  family: string,
  registrationModes: readonly ToolRegistrationMode[],
  options: {
    canonicalName?: string;
    surfaceClass?: ToolSurfaceClass;
    annotationClass?: ToolAnnotationClass;
    lifecycleRole?: GovernedLifecycleRole;
    aliasOf?: string;
    preferredAlternativeFamily?: string;
    availabilityRules?: readonly ToolAvailabilityRule[];
  } = {},
): ToolSurfaceEntry {
  return {
    name,
    canonicalName: options.canonicalName ?? options.aliasOf ?? name,
    classification: classificationForTool(name),
    group,
    family,
    registrationModes,
    surfaceClass: options.surfaceClass ?? "canonical",
    annotationClass: options.annotationClass ?? "read-only",
    ...(options.lifecycleRole ? { lifecycleRole: options.lifecycleRole } : {}),
    ...(options.aliasOf ? { aliasOf: options.aliasOf } : {}),
    ...(options.preferredAlternativeFamily
      ? { preferredAlternativeFamily: options.preferredAlternativeFamily }
      : {}),
    ...(options.availabilityRules
      ? { availabilityRules: options.availabilityRules }
      : {}),
  };
}

function governedFamily(
  prefix: string,
  group: ToolGroupId,
  family: string,
): readonly ToolSurfaceEntry[] {
  return [
    defineTool(`${prefix}_plan`, group, family, LIVE_MODES, {
      annotationClass: "governed-plan",
      lifecycleRole: "plan",
    }),
    defineTool(`${prefix}_apply`, group, family, LIVE_MODES, {
      annotationClass: "governed-mutation",
      lifecycleRole: "apply",
    }),
    defineTool(`${prefix}_status`, group, family, LIVE_MODES, {
      lifecycleRole: "status",
    }),
    defineTool(`${prefix}_recover`, group, family, LIVE_MODES, {
      annotationClass: "governed-mutation",
      lifecycleRole: "recover",
    }),
  ];
}

const OPERON_READ_TOOLS = [
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
  "operon_list_pending_recoveries",
] as const;

const OPERON_MUTATION_TOOLS = [
  "operon_adopt_task",
  "operon_create_periodic_task",
  "operon_update_periodic_scheduling",
  "operon_create_task",
  "operon_update_task",
  "operon_transition_task",
  "operon_relocate_task",
  "operon_set_relationships",
  "operon_update_recurrence",
  "operon_recover_mutation",
] as const;

export const TOOL_SURFACE_REGISTRY: readonly ToolSurfaceEntry[] = [
  defineTool("obsidian_read_note", "notes.read", "notes-core", ALL_MODES),
  defineTool("obsidian_list_notes", "notes.read", "notes-core", ALL_MODES),
  defineTool("obsidian_global_search", "notes.read", "notes-core", ALL_MODES, {
    availabilityRules: [
      {
        modes: ALL_MODES,
        requires: ["vault-cache"],
      },
    ],
  }),

  defineTool(
    "obsidian_update_note",
    "notes.direct.common",
    "notes-core",
    GUARDED_NOTE_MODES,
    {
      surfaceClass: "direct",
      annotationClass: "destructive",
      preferredAlternativeFamily: "text-patch",
    },
  ),
  defineTool(
    "obsidian_search_replace",
    "notes.direct.common",
    "notes-core",
    GUARDED_NOTE_MODES,
    {
      surfaceClass: "direct",
      annotationClass: "destructive",
      preferredAlternativeFamily: "text-patch",
    },
  ),
  defineTool(
    "obsidian_delete_note",
    "notes.direct.admin",
    "notes-admin",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "obsidian_move_note",
    "notes.direct.admin",
    "notes-admin",
    FILESYSTEM_ONLY,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),

  ...governedFamily("obsidian_note_replace", "notes.governed", "note-replace"),
  ...governedFamily("obsidian_text_patch", "notes.governed", "text-patch"),

  defineTool(
    "obsidian_manage_frontmatter",
    "metadata.direct.frontmatter",
    "frontmatter-direct",
    GUARDED_NOTE_MODES,
    {
      surfaceClass: "direct",
      annotationClass: "destructive",
      preferredAlternativeFamily: "frontmatter-patch",
    },
  ),
  defineTool(
    "obsidian_manage_tags",
    "metadata.direct.tags",
    "tags",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "obsidian_batch_frontmatter",
    "metadata.direct.batch",
    "frontmatter-batch",
    FILESYSTEM_ONLY,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),

  ...governedFamily(
    "obsidian_frontmatter_patch",
    "metadata.governed",
    "frontmatter-patch",
  ),

  defineTool("bases_list", "bases.read", "bases", BASE_READ_MODES, {
    availabilityRules: [
      {
        modes: ["headless-readonly"],
        requires: ["vault-cache"],
      },
    ],
  }),
  defineTool("bases_get_schema", "bases.read", "bases", BASE_READ_MODES, {
    availabilityRules: [
      {
        modes: ["headless-readonly"],
        requires: ["vault-cache"],
      },
    ],
  }),
  defineTool("bases_query", "bases.read", "bases", BASE_READ_MODES, {
    availabilityRules: [
      {
        modes: ["headless-readonly"],
        requires: ["vault-cache"],
      },
    ],
  }),

  defineTool(
    "bases_create",
    "bases.direct",
    "bases",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "bases_upsert_config",
    "bases.compat",
    "bases",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "bases_upsert_rows",
    "bases.direct",
    "bases",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),

  ...governedFamily(
    "bases_formula_patch",
    "bases.governed",
    "base-formula-patch",
  ),

  defineTool(
    "obsidian_manage_canvas",
    "canvas.direct",
    "canvas",
    FILESYSTEM_ONLY,
    {
      surfaceClass: "direct",
      annotationClass: "destructive",
      preferredAlternativeFamily: "canvas-patch",
    },
  ),

  ...governedFamily("obsidian_canvas_patch", "canvas.governed", "canvas-patch"),

  defineTool("list_all_tasks", "tasks.markdown", "markdown-tasks", ALL_MODES),
  defineTool("query_tasks", "tasks.markdown", "markdown-tasks", ALL_MODES),

  ...OPERON_READ_TOOLS.map((name) =>
    defineTool(name, "tasks.operon.read", "operon", ALL_MODES),
  ),
  ...OPERON_MUTATION_TOOLS.map((name) =>
    defineTool(name, "tasks.operon.write", "operon", ALL_MODES, {
      annotationClass: "mutation",
    }),
  ),
  defineTool("operon_convert_task", "tasks.operon.write", "operon", ALL_MODES, {
    annotationClass: "destructive",
  }),

  defineTool(
    "smart_semantic_search",
    "semantic.canonical",
    "semantic-search",
    ALL_MODES,
    { annotationClass: "read-only-open-world" },
  ),

  defineTool("obsidian_runtime_status", "runtime.status", "runtime", ALL_MODES),
  defineTool(
    "obsidian_list_pending_operations",
    "runtime.status",
    "operation-cockpit",
    LIVE_MODES,
  ),
  defineTool(
    "obsidian_runtime_maintenance",
    "runtime.maintenance",
    "runtime",
    ALL_MODES,
    { annotationClass: "maintenance" },
  ),

  defineTool(
    "obsidian_validate_format",
    "validation",
    "format-validation",
    ALL_MODES,
  ),

  defineTool(
    "obsidian_admin_filesystem",
    "admin",
    "filesystem-admin",
    FILESYSTEM_ONLY,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),

  defineTool(
    "external_runtime_status",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),
  defineTool(
    "external_roots_list",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),
  defineTool("external_list", "external.read", "external-roots", ALL_MODES),
  defineTool("external_stat", "external.read", "external-roots", ALL_MODES),
  defineTool("external_read", "external.read", "external-roots", ALL_MODES),
  defineTool("external_handoff", "external.read", "external-roots", ALL_MODES),
  defineTool(
    "external_references_scan",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),

  defineTool("external_move_plan", "external.move", "external-move", ALL_MODES),
  defineTool(
    "external_move_status",
    "external.move",
    "external-move",
    ALL_MODES,
  ),
  defineTool(
    "external_move_apply",
    "external.move",
    "external-move",
    ALL_MODES,
    // Retained only to return a stable unsupported result until a native
    // primitive is independently audited and admitted.
    { annotationClass: "read-only" },
  ),
  defineTool(
    "external_move_rollback",
    "external.move",
    "external-move",
    ALL_MODES,
    { annotationClass: "read-only" },
  ),
] as const;

function assertToolClassificationCoverage(): void {
  const registryNames = new Set(
    TOOL_SURFACE_REGISTRY.map((entry) => entry.name),
  );
  const classifiedNames = Object.keys(TOOL_CLASSIFICATION_BY_NAME);
  if (registryNames.size !== TOOL_SURFACE_REGISTRY.length) {
    throw new Error("Tool surface registry contains duplicate public names.");
  }
  const missing = [...registryNames].filter(
    (name) => !TOOL_CLASSIFICATION_BY_NAME[name],
  );
  const extra = classifiedNames.filter((name) => !registryNames.has(name));
  if (missing.length || extra.length) {
    throw new Error(
      `Tool classification coverage mismatch (missing=${missing.join(",")}; extra=${extra.join(",")}).`,
    );
  }
}

assertToolClassificationCoverage();

export interface CompileToolSurfaceInput {
  registrationMode: ToolRegistrationMode;
  groups?: readonly ToolGroupId[];
  availableStaticRequirements?: readonly ToolStaticRequirement[];
}

function staticRequirementsSatisfied(
  entry: ToolSurfaceEntry,
  registrationMode: ToolRegistrationMode,
  availableStaticRequirements: readonly ToolStaticRequirement[] | undefined,
): boolean {
  if (!availableStaticRequirements) return true;
  const available = new Set<ToolStaticRequirement>(availableStaticRequirements);
  return (entry.availabilityRules ?? [])
    .filter((rule) => rule.modes.includes(registrationMode))
    .every((rule) =>
      rule.requires.every((requirement) => available.has(requirement)),
    );
}

export function compileToolSurface({
  registrationMode,
  groups = TOOL_GROUP_IDS,
  availableStaticRequirements,
}: CompileToolSurfaceInput): readonly ToolSurfaceEntry[] {
  const selectedGroups = new Set<ToolGroupId>(groups);
  return TOOL_SURFACE_REGISTRY.filter(
    (entry) =>
      selectedGroups.has(entry.group) &&
      entry.registrationModes.includes(registrationMode) &&
      staticRequirementsSatisfied(
        entry,
        registrationMode,
        availableStaticRequirements,
      ),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

export function compileToolNames(
  input: CompileToolSurfaceInput,
): readonly string[] {
  return compileToolSurface(input).map((entry) => entry.name);
}

export function getToolSurfaceEntry(
  name: string,
): ToolSurfaceEntry | undefined {
  return TOOL_SURFACE_REGISTRY.find((entry) => entry.name === name);
}
