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
  "bases.direct",
  "bases.governed",
  "bases.read",
  "canvas.direct",
  "canvas.governed",
  "external.move",
  "external.read",
  "metadata.direct",
  "metadata.governed",
  "notes.direct",
  "notes.governed",
  "notes.read",
  "runtime",
  "semantic.canonical",
  "semantic.legacy",
  "tasks.markdown",
  "tasks.operon.read",
  "tasks.operon.write",
  "validation",
] as const;

export type ToolGroupId = (typeof TOOL_GROUP_IDS)[number];

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

export interface ToolSurfaceEntry {
  name: string;
  canonicalName: string;
  group: ToolGroupId;
  family: string;
  registrationModes: readonly ToolRegistrationMode[];
  surfaceClass: ToolSurfaceClass;
  annotationClass: ToolAnnotationClass;
  lifecycleRole?: GovernedLifecycleRole;
  aliasOf?: string;
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
  } = {},
): ToolSurfaceEntry {
  return {
    name,
    canonicalName: options.canonicalName ?? options.aliasOf ?? name,
    group,
    family,
    registrationModes,
    surfaceClass: options.surfaceClass ?? "canonical",
    annotationClass: options.annotationClass ?? "read-only",
    ...(options.lifecycleRole ? { lifecycleRole: options.lifecycleRole } : {}),
    ...(options.aliasOf ? { aliasOf: options.aliasOf } : {}),
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
  defineTool("obsidian_global_search", "notes.read", "notes-core", ALL_MODES),

  defineTool(
    "obsidian_update_note",
    "notes.direct",
    "notes-core",
    GUARDED_NOTE_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "obsidian_search_replace",
    "notes.direct",
    "notes-core",
    GUARDED_NOTE_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "obsidian_delete_note",
    "notes.direct",
    "notes-core",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "obsidian_move_note",
    "notes.direct",
    "notes-core",
    FILESYSTEM_ONLY,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),

  ...governedFamily(
    "obsidian_note_replace",
    "notes.governed",
    "note-replace",
  ),

  defineTool(
    "obsidian_manage_frontmatter",
    "metadata.direct",
    "frontmatter",
    GUARDED_NOTE_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "obsidian_manage_tags",
    "metadata.direct",
    "tags",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "obsidian_batch_frontmatter",
    "metadata.direct",
    "frontmatter",
    FILESYSTEM_ONLY,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),

  ...governedFamily(
    "obsidian_frontmatter_patch",
    "metadata.governed",
    "frontmatter-patch",
  ),

  defineTool("bases_list", "bases.read", "bases", BASE_READ_MODES),
  defineTool("bases_get_schema", "bases.read", "bases", BASE_READ_MODES),
  defineTool("bases_query", "bases.read", "bases", BASE_READ_MODES),

  defineTool(
    "bases_create",
    "bases.direct",
    "bases",
    LIVE_OR_FILESYSTEM_MODES,
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),
  defineTool(
    "bases_upsert_config",
    "bases.direct",
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
    { surfaceClass: "direct", annotationClass: "destructive" },
  ),

  ...governedFamily(
    "obsidian_canvas_patch",
    "canvas.governed",
    "canvas-patch",
  ),

  defineTool(
    "list_all_tasks",
    "tasks.markdown",
    "markdown-tasks",
    ALL_MODES,
  ),
  defineTool(
    "query_tasks",
    "tasks.markdown",
    "markdown-tasks",
    ALL_MODES,
  ),

  ...OPERON_READ_TOOLS.map((name) =>
    defineTool(name, "tasks.operon.read", "operon", ALL_MODES),
  ),
  ...OPERON_MUTATION_TOOLS.map((name) =>
    defineTool(name, "tasks.operon.write", "operon", ALL_MODES, {
      annotationClass: "mutation",
    }),
  ),
  defineTool(
    "operon_convert_task",
    "tasks.operon.write",
    "operon",
    ALL_MODES,
    { annotationClass: "destructive" },
  ),

  defineTool(
    "smart_semantic_search",
    "semantic.canonical",
    "semantic-search",
    ALL_MODES,
    { annotationClass: "read-only-open-world" },
  ),
  defineTool(
    "smart_search",
    "semantic.legacy",
    "semantic-search",
    ALL_MODES,
    {
      aliasOf: "smart_semantic_search",
      surfaceClass: "legacy",
      annotationClass: "read-only-open-world",
    },
  ),
  defineTool(
    "smart-search",
    "semantic.legacy",
    "semantic-search",
    ALL_MODES,
    {
      aliasOf: "smart_semantic_search",
      surfaceClass: "legacy",
      annotationClass: "read-only-open-world",
    },
  ),

  defineTool("obsidian_runtime_status", "runtime", "runtime", ALL_MODES),
  defineTool(
    "obsidian_runtime_maintenance",
    "runtime",
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
  defineTool(
    "external_list",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),
  defineTool(
    "external_stat",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),
  defineTool(
    "external_read",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),
  defineTool(
    "external_handoff",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),
  defineTool(
    "external_references_scan",
    "external.read",
    "external-roots",
    ALL_MODES,
  ),

  defineTool(
    "external_move_plan",
    "external.move",
    "external-move",
    ALL_MODES,
  ),
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
    { annotationClass: "destructive" },
  ),
  defineTool(
    "external_move_rollback",
    "external.move",
    "external-move",
    ALL_MODES,
    { annotationClass: "destructive" },
  ),
] as const;

export interface CompileToolSurfaceInput {
  registrationMode: ToolRegistrationMode;
  groups?: readonly ToolGroupId[];
}

export function compileToolSurface({
  registrationMode,
  groups = TOOL_GROUP_IDS,
}: CompileToolSurfaceInput): readonly ToolSurfaceEntry[] {
  const selectedGroups = new Set<ToolGroupId>(groups);
  return TOOL_SURFACE_REGISTRY.filter(
    (entry) =>
      selectedGroups.has(entry.group) &&
      entry.registrationModes.includes(registrationMode),
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
