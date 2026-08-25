import { z } from "zod";

export const OPERON_CONTRACT_VERSION = "1" as const;
export const OPERON_SNAPSHOT_SCHEMA_VERSION = 2;
export const OPERON_LEGACY_SNAPSHOT_SCHEMA_VERSION = 1;

export const OperonTaskSourceSchema = z.enum(["inline", "file"]);
export const OperonCheckboxSchema = z.enum(["open", "done", "cancelled"]);
export const OperonTierSchema = z.enum(["hot", "warm", "cold"]);

export const OperonTaskDatesSchema = z.object({
  due: z.string().nullable(),
  scheduled: z.string().nullable(),
  started: z.string().nullable(),
  completed: z.string().nullable(),
  cancelled: z.string().nullable(),
  datetimeStart: z.string().nullable(),
  datetimeEnd: z.string().nullable(),
  created: z.string().nullable(),
  modified: z.string().nullable(),
});

export const OperonFieldValueSchema = z.union([
  z.string(),
  z.array(z.string()),
]);

export type OperonFieldValue = z.infer<typeof OperonFieldValueSchema>;

export const OperonTaskSchema = z.object({
  operonId: z.string().min(1),
  source: OperonTaskSourceSchema,
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  sourceMtime: z.number().nullable(),
  description: z.string(),
  checkbox: OperonCheckboxSchema,
  status: z.string().nullable(),
  statusId: z.string().nullable().optional().default(null),
  statusLabel: z.string().nullable(),
  pipeline: z.string().nullable(),
  pipelineId: z.string().nullable().optional().default(null),
  priority: z.string().nullable(),
  tier: OperonTierSchema,
  tags: z.array(z.string()),
  parentTask: z.string().nullable(),
  blocking: z.array(z.string()),
  blockedBy: z.array(z.string()),
  dates: OperonTaskDatesSchema,
  fields: z.record(OperonFieldValueSchema),
  properties: z.record(z.unknown()).optional(),
  plainCheckboxProgress: z
    .object({
      total: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
    })
    .optional(),
  recurrence: z
    .object({
      repeating: z.boolean(),
      seriesId: z.string().nullable(),
      occurrenceDate: z.string().nullable(),
    })
    .optional(),
  revision: z.string().min(1),
  sourceKind: z.literal("operon-index"),
  operonVersion: z.string().min(1),
  bridgeVersion: z.string().min(1),
});

export type OperonTask = z.infer<typeof OperonTaskSchema>;

export const OperonCapabilitiesSchema = z.object({
  status: z.boolean(),
  configuration: z.boolean(),
  list: z.boolean(),
  get: z.boolean(),
  query: z.boolean(),
  validate: z.boolean(),
  diagnostics: z.boolean().optional().default(false),
  finder: z.boolean().optional().default(false),
  resolve: z.boolean().optional().default(false),
  relationships: z.boolean().optional().default(false),
  context: z.boolean().optional().default(false),
  timers: z.boolean().optional().default(false),
  adopt: z.boolean().optional().default(false),
  create: z.boolean(),
  update: z.boolean(),
  transition: z.boolean(),
  relationshipMutation: z.boolean().optional().default(false),
  recurrenceMutation: z.boolean().optional().default(false),
  convert: z.boolean(),
  filterQuery: z.boolean().optional().default(false),
  relocate: z.boolean().optional().default(false),
  recovery: z.boolean().optional().default(false),
  periodicCreate: z.boolean().optional().default(false),
  periodicUpdate: z.boolean().optional().default(false),
  taskWorkflowRecovery: z.boolean().optional().default(false),
});

export const OperonWorkflowTaxonomySchema = z.object({
  language: z.string(),
  defaultPipelineName: z.string().nullable(),
  pipelines: z.array(
    z.object({
      id: z.string().nullable(),
      name: z.string(),
      description: z.string().nullable(),
      statuses: z.array(
        z.object({
          id: z.string().nullable(),
          label: z.string(),
          value: z.string(),
          isFinished: z.boolean(),
          isCancelled: z.boolean(),
          isScheduledTarget: z.boolean(),
          isTrackingTarget: z.boolean(),
        }),
      ),
    }),
  ),
});

export const OperonSemanticConfigurationSchema = z.object({
  language: z.string(),
  workflow: OperonWorkflowTaxonomySchema,
  priorities: z.object({
    defaultPriority: z.string().nullable(),
    items: z.array(
      z.object({
        id: z.string().nullable(),
        label: z.string(),
        color: z.string().nullable(),
        description: z.string().nullable(),
      }),
    ),
  }),
  keys: z.array(
    z.object({
      canonicalKey: z.string(),
      visiblePropertyName: z.string(),
      type: z.string().nullable(),
      sync: z.string().nullable(),
      enabled: z.boolean(),
      isSystem: z.boolean(),
      isInternal: z.boolean(),
    }),
  ),
  creation: z.object({
    fileTasksFolder: z.string(),
    inlineTaskSaveMode: z.string(),
    inlineTaskUseDailyNote: z.boolean(),
    inlineTaskTargetFile: z.string(),
    inlineTaskHeading: z.string(),
    inlineTaskDailyNoteAddStartDate: z.boolean(),
    inlineTaskDailyNoteAddScheduledDate: z.boolean(),
    taskCreatorDefaultToFileTask: z.boolean(),
    taskCreatorDefaultFileTemplateId: z.string().nullable(),
    fileTaskTemplateFolder: z.string(),
    fileTaskParentInlineTargetMode: z.string(),
    fileTaskParentFileTargetMode: z.string(),
    availableFileTaskTemplates: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        path: z.string().nullable(),
        kind: z.string(),
        pipelineId: z.string().nullable(),
        description: z.string().nullable(),
      }),
    ),
  }),
  automation: z.object({
    autoCompleteParentWhenAllChildrenTerminal: z.boolean(),
    cascadeCancelToDescendants: z.boolean(),
    fileTaskAutoArchiveEnabled: z.boolean(),
    fileTaskArchiveFolder: z.string(),
    fileTaskArchiveDelaySeconds: z.number().nonnegative(),
    fileTaskArchiveOnlyFromFileTasksFolder: z.boolean(),
    fileRepeatDestination: z.string(),
    fileRepeatCustomFolder: z.string(),
  }),
  indexing: z.object({
    excludedFolders: z.array(z.string()),
    fullReindexOnStartup: z.boolean(),
    indexEventDebounceMs: z.number().nonnegative(),
  }),
  docs: z.object({
    folder: z.string(),
    autoUpdateEnabled: z.boolean(),
  }),
  views: z.object({
    filters: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        icon: z.string().nullable(),
        definition: z.record(z.unknown()),
      }),
    ),
  }),
});

export const OperonConfigurationSchema = z.object({
  ok: z.literal(true),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  source: z.literal("operon-runtime"),
  stale: z.literal(false),
  operonVersion: z.string(),
  bridgeVersion: z.string(),
  settingsSignature: z.string().min(1),
  configuration: OperonSemanticConfigurationSchema,
  limitations: z.array(z.string()),
});

export type OperonConfiguration = z.infer<typeof OperonConfigurationSchema>;

export function resolveOperonWorkflowStatus(
  value: unknown,
  workflow: OperonConfiguration["configuration"]["workflow"],
): {
  pipeline: string;
  label: string;
  id: string | null;
  value: string;
} | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const matches = workflow.pipelines.flatMap((pipeline) =>
    pipeline.statuses
      .filter(
        (status) =>
          status.id === normalized ||
          status.value === normalized ||
          `${pipeline.name}.${status.label}` === normalized ||
          status.label === normalized,
      )
      .map((status) => ({
        pipeline: pipeline.name,
        label: status.label,
        id: status.id,
        value: status.value,
      })),
  );
  const unique = new Map(
    matches.map((match) => [
      `${match.pipeline}\0${match.id ?? match.value}`,
      match,
    ]),
  );
  return unique.size === 1 ? ([...unique.values()][0] ?? null) : null;
}

export function resolveOperonPriorityStableId(
  value: unknown,
  priorities: readonly { id: string | null; label: string }[],
): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const matches = priorities
    .filter(
      (priority) => priority.id === normalized || priority.label === normalized,
    )
    .map((priority) => priority.id)
    .filter((id): id is string => Boolean(id));
  const unique = [...new Set(matches)];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

export const OperonStatusSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  bridge: z.object({
    id: z.string(),
    version: z.string(),
    mode: z.enum(["read-only", "read-write"]),
    mutationsEnabled: z.boolean().optional(),
  }),
  operon: z.object({
    present: z.boolean(),
    pluginId: z.enum(["kairelys", "operon"]).nullable().optional(),
    pluginName: z.string().nullable().optional(),
    version: z.string().nullable(),
    compatible: z.boolean(),
    compatibilityState: z
      .enum(["certified", "compatible-provisional", "incompatible"])
      .optional(),
    compatibilityAdmission: z
      .enum(["developer-api-v1", "legacy-version", "none"])
      .optional(),
    compatibilityReason: z.string().min(1).optional(),
    testedAgainst: z.string(),
    supportedRange: z.string(),
  }),
  index: z.object({
    ready: z.boolean(),
    generation: z.number().nullable(),
    taskCount: z.number().int().nonnegative(),
    duplicateConflictCount: z.number().int().nonnegative(),
    diagnostics: z.record(z.unknown()).nullable().optional(),
  }),
  settingsSignature: z.string().nullable(),
  taxonomy: OperonWorkflowTaxonomySchema.nullable().optional(),
  capabilities: OperonCapabilitiesSchema,
  source: z.literal("operon-runtime"),
  stale: z.literal(false),
  limitations: z.array(z.string()),
});

export type OperonStatus = z.infer<typeof OperonStatusSchema>;

export const OperonRecoveryStatusSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  bridge: z.object({
    id: z.string(),
    version: z.string(),
  }),
  operon: z.object({
    present: z.boolean(),
    version: z.string().nullable(),
    compatible: z.boolean(),
  }),
  capabilities: z.object({
    recovery: z.boolean(),
    taskWorkflowRecovery: z.boolean(),
  }),
  source: z.literal("operon-runtime"),
  stale: z.literal(false),
});

export type OperonRecoveryStatus = z.infer<
  typeof OperonRecoveryStatusSchema
>;

export const OperonBridgePageSchema = z.object({
  ok: z.literal(true),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  source: z.literal("operon-live"),
  stale: z.literal(false),
  generation: z.number().int().positive(),
  settingsSignature: z.string().min(1),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  cursor: z.string(),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  tasks: z.array(OperonTaskSchema),
  limitations: z.array(z.string()),
});

export type OperonBridgePage = z.infer<typeof OperonBridgePageSchema>;

export const OperonValidationSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  source: z.literal("operon-runtime"),
  stale: z.literal(false),
  taskCount: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  settingsSignature: z.string().min(1),
  summary: z.object({
    P0: z.number().int().nonnegative(),
    P1: z.number().int().nonnegative(),
    P2: z.number().int().nonnegative(),
  }),
  violations: z.array(z.record(z.unknown())),
  limitations: z.array(z.string()),
});

export type OperonValidation = z.infer<typeof OperonValidationSchema>;

export const OperonDateFilterSchema = z.object({
  field: z.enum([
    "due",
    "scheduled",
    "started",
    "completed",
    "cancelled",
    "datetimeStart",
    "datetimeEnd",
    "created",
    "modified",
  ]),
  before: z.string().optional(),
  after: z.string().optional(),
  on: z.string().optional(),
});

export const OperonSortSchema = z.object({
  field: z.enum([
    "description",
    "status",
    "pipeline",
    "priority",
    "due",
    "scheduled",
    "path",
    "line",
    "datetimeModified",
    "tier",
  ]),
  direction: z.enum(["asc", "desc"]).optional().default("asc"),
});

export type OperonDateFilter = z.infer<typeof OperonDateFilterSchema>;
export type OperonSort = z.infer<typeof OperonSortSchema>;

export const OperonQuerySchema = z.object({
  operonIds: z.array(z.string().min(1)).optional(),
  search: z.string().optional(),
  sources: z.array(OperonTaskSourceSchema).optional(),
  checkboxes: z.array(OperonCheckboxSchema).optional(),
  statuses: z.array(z.string()).optional(),
  statusIds: z.array(z.string()).optional(),
  pipelines: z.array(z.string()).optional(),
  pipelineIds: z.array(z.string()).optional(),
  priorities: z.array(z.string()).optional(),
  tiers: z.array(OperonTierSchema).optional(),
  pathIncludes: z.array(z.string()).optional(),
  pathExcludes: z.array(z.string()).optional(),
  tagsAny: z.array(z.string()).optional(),
  tagsAll: z.array(z.string()).optional(),
  parentTask: z.string().nullable().optional(),
  dates: z.array(OperonDateFilterSchema).optional(),
  fieldEquals: z.record(OperonFieldValueSchema).optional(),
  propertyEquals: z.record(z.unknown()).optional(),
  sort: z.array(OperonSortSchema).optional(),
  includeProperties: z.boolean().optional().default(false),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(500).optional().default(100),
  forceRefresh: z.boolean().optional().default(false),
});

export type OperonQuery = z.infer<typeof OperonQuerySchema>;

const OperonNativeTaskFiltersSchema = z.object({
  checkbox: z.array(OperonCheckboxSchema).max(3).optional(),
  pipelineIds: z.array(z.string().trim().min(1)).max(50).optional(),
  statusIds: z.array(z.string().trim().min(1)).max(100).optional(),
  priorityIds: z.array(z.string().trim().min(1)).max(50).optional(),
  tiers: z.array(z.string().trim().min(1)).max(20).optional(),
  filePath: z.string().trim().min(1).max(1_024).optional(),
  parentOperonId: z.string().trim().min(1).max(256).optional(),
  due: z
    .object({
      from: z.string().trim().min(1).optional(),
      to: z.string().trim().min(1).optional(),
    })
    .optional(),
  text: z.string().trim().min(1).max(500).optional(),
});

export const OperonTaskFinderSchema = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  filters: OperonNativeTaskFiltersSchema.omit({
    text: true,
    parentOperonId: true,
    filePath: true,
  }).optional(),
  representations: z
    .array(z.enum(["inline", "file"]))
    .max(2)
    .optional(),
  scope: z.enum(["normal", "overdue", "happens-today", "recent"]).optional(),
  project: z
    .object({
      mode: z.enum(["direct", "tree"]),
      rootOperonId: z.string().trim().min(1).max(256).optional(),
    })
    .optional(),
  limit: z.number().int().positive().max(50).optional().default(20),
  cursor: z.string().trim().min(1).max(1_024).optional(),
});

const OperonTaskLocatorSchema = z.discriminatedUnion("representation", [
  z.object({
    representation: z.literal("inline"),
    filePath: z.string().trim().min(1).max(1_024),
    lineNumber: z.number().int().nonnegative(),
  }),
  z.object({
    representation: z.literal("file"),
    filePath: z.string().trim().min(1).max(1_024),
  }),
]);

export const OperonTaskSelectorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("operon-id"),
    operonId: z.string().trim().min(1).max(256),
  }),
  z.object({
    kind: z.literal("exact-locator"),
    locator: OperonTaskLocatorSchema,
    expectedOperonId: z.string().trim().min(1).max(256).optional(),
  }),
  z.object({
    kind: z.literal("exact-path"),
    filePath: z.string().trim().min(1).max(1_024),
    expectedOperonId: z.string().trim().min(1).max(256).optional(),
  }),
  z.object({
    kind: z.literal("exact-name"),
    noteName: z.string().trim().min(1).max(512),
    expectedOperonId: z.string().trim().min(1).max(256).optional(),
  }),
  z.object({
    kind: z.literal("search"),
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().positive().max(20).optional().default(10),
  }),
]);

export const OperonResolveTaskSchema = z.object({
  selector: OperonTaskSelectorSchema,
  limit: z.number().int().positive().max(20).optional().default(10),
});

export const OperonRelationshipsSchema = z.object({
  operonId: z.string().trim().min(1).max(256),
  kinds: z
    .array(
      z.enum([
        "parent",
        "child",
        "blocking",
        "blocked-by",
        "related",
        "ancestor",
        "project-member",
      ]),
    )
    .max(7)
    .optional(),
  limit: z.number().int().positive().max(100).optional().default(50),
  depth: z.number().int().nonnegative().max(3).optional().default(1),
});

export const OperonContextInputSchema = z.object({
  purpose: z.enum(["read", "analysis", "planning", "creation"]),
  projection: z.enum([
    "exact-task",
    "task-neighborhood",
    "project-analysis",
    "planning-workload",
    "creation-context",
  ]),
  operonId: z.string().trim().min(1).max(256).optional(),
  filters: OperonNativeTaskFiltersSchema.optional(),
  include: z
    .array(z.enum(["notes", "links", "custom-fields"]))
    .max(3)
    .optional(),
  // Projection-specific defaults belong to Operon's native context contract:
  // exact-task is 1/0, while neighborhood and the other projections have
  // different bounds. Do not inject neighborhood defaults here.
  limit: z.number().int().positive().max(100).optional(),
  depth: z.number().int().nonnegative().max(3).optional(),
  cursor: z.string().trim().min(1).max(1_024).optional(),
});

export const OperonContextSchema = OperonContextInputSchema.superRefine(
  (value, context) => {
    if (
      ["exact-task", "task-neighborhood", "project-analysis"].includes(
        value.projection,
      ) &&
      !value.operonId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operonId"],
        message: `${value.projection} requires an exact operonId.`,
      });
    }
  },
);

export const OperonNativeReadEnvelopeSchema = z.object({
  ok: z.literal(true),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  source: z.literal("operon-live"),
  stale: z.literal(false),
  operation: z.enum([
    "diagnostics",
    "finder",
    "resolve",
    "relationships",
    "context",
    "timers",
  ]),
  result: z.record(z.unknown()),
  limitations: z.array(z.string()),
});

export const OperonRawPropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
]);

const OPERON_TEXT_MAX_LENGTH = 65_536;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const OperonMutationTextSchema = z
  .string()
  .max(OPERON_TEXT_MAX_LENGTH)
  .refine((value) => utf8Length(value) <= OPERON_TEXT_MAX_LENGTH, {
    message: `Value must not exceed ${OPERON_TEXT_MAX_LENGTH} UTF-8 bytes.`,
  });

const OperonMutationListItemSchema = z
  .string()
  .trim()
  .min(1)
  .max(OPERON_TEXT_MAX_LENGTH)
  .refine((value) => utf8Length(value) <= OPERON_TEXT_MAX_LENGTH, {
    message: `Value must not exceed ${OPERON_TEXT_MAX_LENGTH} UTF-8 bytes.`,
  });

const OperonMutationFieldValueSchema = z.union([
  OperonMutationTextSchema,
  z.array(OperonMutationListItemSchema).max(512),
]);

const OperonMutationFieldsSchema = z.record(OperonMutationFieldValueSchema);

const OPERON_SCALAR_MUTATION_FIELDS = new Set([
  "status",
  "priority",
  "parentTask",
  "taskType",
  "taskImage",
  "taskIcon",
  "taskColor",
  "note",
  "location",
  "dateDue",
  "dateScheduled",
  "dateStarted",
  "datetimeStart",
  "datetimeEnd",
  "estimate",
]);

const OPERON_LIST_MUTATION_FIELDS = new Set([
  "taskGallery",
  "assignees",
  "contexts",
  "links",
  "related",
  "blocking",
  "blockedBy",
]);

function validateKnownMutationFieldTypes(
  fields:
    | Record<string, z.infer<typeof OperonMutationFieldValueSchema>>
    | undefined,
  context: z.RefinementCtx,
): void {
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (OPERON_SCALAR_MUTATION_FIELDS.has(field) && Array.isArray(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", field],
        message: `Managed field '${field}' requires one scalar string value.`,
      });
    }
    if (OPERON_LIST_MUTATION_FIELDS.has(field) && !Array.isArray(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", field],
        message: `Managed field '${field}' requires an ordered string array.`,
      });
    }
  }
}

function validateTaskGallery(
  fields:
    | Record<string, z.infer<typeof OperonMutationFieldValueSchema>>
    | undefined,
  maximumItems: number,
  context: z.RefinementCtx,
): void {
  if (!fields || !("taskGallery" in fields)) return;
  const gallery = fields.taskGallery;
  if (!Array.isArray(gallery)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fields", "taskGallery"],
      message:
        "taskGallery must be an ordered string array; delimiter-based strings are not accepted.",
    });
    return;
  }
  if (gallery.length > maximumItems) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: maximumItems,
      inclusive: true,
      type: "array",
      path: ["fields", "taskGallery"],
      message: `taskGallery must contain at most ${maximumItems} items.`,
    });
  }
}

function normalizeTaskGalleryFields<
  T extends Record<string, z.infer<typeof OperonMutationFieldValueSchema>>,
>(fields: T | undefined): T | undefined {
  if (!fields || !Array.isArray(fields.taskGallery)) return fields;
  const seen = new Set<string>();
  const taskGallery = fields.taskGallery.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
  return { ...fields, taskGallery } as T;
}

const MutationControlSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  dryRun: z.boolean().optional().default(true),
});

export function isCanonicalOperonVaultRelativePath(
  value: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\\\r\n\0]/u.test(value) ||
    /^(?:\/|[a-z]:\/)/iu.test(value) ||
    value.endsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment === segment.trim() &&
      segment !== "." &&
      segment !== "..",
  );
}

export function isCanonicalOperonVaultMarkdownPath(
  value: unknown,
): value is string {
  return (
    isCanonicalOperonVaultRelativePath(value) &&
    value.toLocaleLowerCase().endsWith(".md")
  );
}

export const OperonVaultRelativePathSchema = z
  .string()
  .min(1)
  .refine(isCanonicalOperonVaultRelativePath, {
    message:
      "Path must be an exact canonical vault-relative path without whitespace normalization, backslashes, empty, '.' or '..' segments.",
  });

const OperonVaultRelativeReadPathSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    const normalized = value.replace(/\\/gu, "/");
    if (
      /^(?:\/|[a-z]:\/)/iu.test(normalized) ||
      normalized
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path must be vault-relative without '.' or '..' segments.",
      });
    }
  });

export const OperonVaultMarkdownPathSchema =
  OperonVaultRelativePathSchema.refine(isCanonicalOperonVaultMarkdownPath, {
    message: "Path must identify a canonical vault-relative Markdown file.",
  });
export const OperonFilterQuerySchema = z.object({
  filterSetId: z.string().trim().min(1),
  scopePath: OperonVaultRelativeReadPathSchema.optional(),
  includeProperties: z.boolean().optional().default(false),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(500).optional().default(100),
});

const OperonIdSchema = z.string().regex(/^[a-z0-9]{7}$/u, {
  message: "Operon ids must contain exactly seven lowercase letters or digits.",
});

const OperonDateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, {
  message: "Date keys must use the YYYY-MM-DD format.",
});

const OperonNormalizedTagsSchema = z.array(z.string()).transform((tags) => [
  ...new Set(
    tags
      .map((tag) => tag.trim().replace(/^#/u, "").trim())
      .filter(Boolean),
  ),
]);

export const OperonAdoptTaskSchema = MutationControlSchema.extend({
  adoption: z.object({
    targetPath: OperonVaultMarkdownPathSchema,
    line: z.number().int().positive(),
    expectedLine: z
      .string()
      .min(1)
      .max(20_000)
      .refine(
        (value) => !/[\r\n]/u.test(value),
        "expectedLine must contain exactly one source line.",
      ),
    statusId: z.string().trim().min(1).optional(),
    terminalSourcePolicy: z.literal("reopen").optional(),
  }),
});

export const OperonCreatePeriodicTaskSchema = MutationControlSchema.extend({
  periodic: z
    .object({
      description: z.string().trim().min(1).max(20_000),
      periodicKind: z.enum(["daily", "weekly"]),
      routeDate: OperonDateKeySchema.optional(),
      statusId: z.string().trim().min(1).optional(),
      priorityId: z.string().trim().min(1).optional(),
      tags: OperonNormalizedTagsSchema.optional(),
      fields: OperonMutationFieldsSchema.optional(),
    })
    .superRefine((value, context) => {
      validateKnownMutationFieldTypes(value.fields, context);
      validateTaskGallery(value.fields, 256, context);
      if (value.fields?.parentTask !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", "parentTask"],
          message:
            "Periodic-note creation owns parentage; parentTask is not accepted.",
        });
      }
      if (value.statusId && value.fields?.status !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["statusId"],
          message: "Provide at most one of fields.status or statusId.",
        });
      }
      if (value.priorityId && value.fields?.priority !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["priorityId"],
          message: "Provide at most one of fields.priority or priorityId.",
        });
      }
    })
    .transform((value) => {
      const fields = normalizeTaskGalleryFields(value.fields);
      return fields === undefined ? value : { ...value, fields };
    }),
});

export const OperonUpdatePeriodicSchedulingSchema =
  MutationControlSchema.extend({
    operonId: OperonIdSchema,
    expectedRevision: z.string().min(1),
    patch: z
      .object({
        fields: z
          .object({
            dateScheduled: z.string().trim().min(1).nullable(),
          })
          .strict(),
      })
      .strict(),
  });

export const OperonCreateTaskSchema = MutationControlSchema.extend({
  task: z
    .object({
      source: OperonTaskSourceSchema,
      description: z.string().trim().min(1),
      statusId: z.string().trim().min(1).optional(),
      tags: z.array(z.string()).optional(),
      fields: OperonMutationFieldsSchema.optional(),
      properties: z.record(OperonRawPropertyValueSchema).optional(),
      fileTemplateId: z.string().optional(),
      targetDateKey: z.string().optional(),
      targetFolder: OperonVaultRelativePathSchema.optional(),
      targetPath: OperonVaultMarkdownPathSchema.optional(),
    })
    .superRefine((value, context) => {
      validateKnownMutationFieldTypes(value.fields, context);
      validateTaskGallery(value.fields, 256, context);
      if (value.source === "file" && value.targetPath) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetPath"],
          message: "targetPath is supported only for inline tasks.",
        });
      }
      if (value.source === "inline" && value.targetFolder) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetFolder"],
          message: "targetFolder is supported only for file tasks.",
        });
      }
      if (
        value.statusId &&
        typeof value.fields?.status === "string" &&
        value.fields.status.trim()
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["statusId"],
          message: "Provide at most one of fields.status or statusId.",
        });
      }
    })
    .transform((value) => {
      const fields = normalizeTaskGalleryFields(value.fields);
      return fields === undefined ? value : { ...value, fields };
    }),
});

export const OperonUpdatePatchSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    tags: z.array(z.string()).optional(),
    fields: OperonMutationFieldsSchema.optional(),
    properties: z.record(OperonRawPropertyValueSchema).optional(),
  })
  .superRefine((value, context) => {
    validateKnownMutationFieldTypes(value.fields, context);
    validateTaskGallery(value.fields, 512, context);
    const dedicatedFields = new Set([
      "parentTask",
      "blocking",
      "blockedBy",
      "repeat",
      "datetimeRepeatEnd",
    ]);
    for (const field of Object.keys(value.fields ?? {})) {
      if (dedicatedFields.has(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", field],
          message: `Managed field '${field}' must use the dedicated relationship or recurrence mutation tool.`,
        });
      }
    }
    const groupCount = [
      value.description !== undefined,
      value.tags !== undefined || value.fields !== undefined,
      value.properties !== undefined,
    ].filter(Boolean).length;
    if (groupCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one mutation group: description, managed fields/tags, or one unmanaged property.",
      });
    }
    if (value.properties && Object.keys(value.properties).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Update exactly one unmanaged property per operation.",
      });
    }
  })
  .transform((value) => {
    const fields = normalizeTaskGalleryFields(value.fields);
    return fields === undefined ? value : { ...value, fields };
  });

export const OperonUpdateTaskSchema = MutationControlSchema.extend({
  operonId: z.string().min(1),
  expectedRevision: z.string().min(1),
  patch: OperonUpdatePatchSchema,
});

export const OperonTransitionTaskInputSchema = MutationControlSchema.extend({
  operonId: z.string().min(1),
  expectedRevision: z.string().min(1),
  status: z.string().trim().min(1).optional(),
  statusId: z.string().trim().min(1).optional(),
});

export const OperonTransitionTaskSchema =
  OperonTransitionTaskInputSchema.superRefine((value, ctx) => {
    if (Boolean(value.status) === Boolean(value.statusId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of status or statusId.",
      });
    }
  });

export const OperonConvertTaskInputSchema = MutationControlSchema.extend({
  operonId: z.string().min(1),
  expectedRevision: z.string().min(1),
  target: OperonTaskSourceSchema,
  fileTemplateId: z.string().optional(),
  targetPath: OperonVaultMarkdownPathSchema.optional(),
  targetFolder: OperonVaultRelativePathSchema.optional(),
});

export const OperonConvertTaskSchema = OperonConvertTaskInputSchema.superRefine(
  (value, context) => {
    if (value.target === "inline" && !value.targetPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetPath"],
        message: "targetPath is required for file-to-inline conversion.",
      });
    }
    if (value.target === "inline" && value.targetFolder) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetFolder"],
        message:
          "targetFolder is supported only for inline-to-file conversion.",
      });
    }
    if (value.target === "file" && value.targetPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetPath"],
        message: "targetPath is supported only for file-to-inline conversion.",
      });
    }
  },
);

export const OperonRelocateTaskSchema = MutationControlSchema.extend({
  operonId: z.string().min(1),
  expectedRevision: z.string().min(1),
  targetPath: OperonVaultMarkdownPathSchema,
});

const UniqueOperonIdsSchema = z
  .array(OperonIdSchema)
  .max(100)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Relationship target ids must be unique.",
      });
    }
  });

const OperonRelationshipReplacementSchema = z
  .object({
    parentTask: OperonIdSchema.nullable().optional(),
    blocking: UniqueOperonIdsSchema.optional(),
    blockedBy: UniqueOperonIdsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.keys(value).length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one relationship field to replace or clear.",
      });
    }
    const overlap = new Set(value.blocking ?? []);
    for (const id of value.blockedBy ?? []) {
      if (overlap.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Task '${id}' cannot be both blocking and blockedBy.`,
        });
      }
    }
  });

export const OperonSetRelationshipsInputSchema = MutationControlSchema.extend({
  operonId: OperonIdSchema,
  expectedRevision: z.string().min(1),
  relationships: OperonRelationshipReplacementSchema,
});

export const OperonSetRelationshipsSchema =
  OperonSetRelationshipsInputSchema.superRefine((value, context) => {
    const targets = [
      ...(value.relationships.parentTask
        ? [value.relationships.parentTask]
        : []),
      ...(value.relationships.blocking ?? []),
      ...(value.relationships.blockedBy ?? []),
    ];
    if (targets.includes(value.operonId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A task cannot reference itself.",
      });
    }
  });

const OperonRecurrenceChangesSchema = z
  .object({
    repeat: z.string().trim().min(1).nullable().optional(),
    datetimeRepeatEnd: z.string().trim().min(1).nullable().optional(),
    dateScheduled: z.string().trim().min(1).nullable().optional(),
    dateStarted: z.string().trim().min(1).nullable().optional(),
    dateDue: z.string().trim().min(1).nullable().optional(),
    datetimeStart: z.string().trim().min(1).nullable().optional(),
    datetimeEnd: z.string().trim().min(1).nullable().optional(),
    estimate: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.keys(value).length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one recurrence field to set or clear.",
      });
    }
  });

export const OperonUpdateRecurrenceSchema = MutationControlSchema.extend({
  operonId: OperonIdSchema,
  expectedRevision: z.string().min(1),
  scope: z.enum(["this-task", "this-and-following"]),
  changes: OperonRecurrenceChangesSchema,
});

export const OperonTaskWorkflowRecoveryKindSchema = z.enum([
  "adopt",
  "periodic-create",
  "periodic-update",
]);

export const OperonPlanDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 hex digest.")
  .describe(
    "Exact lowercase 64-hex planDigest returned by Operon pending recovery state; never synthesize or alter it.",
  );

export const OperonPendingRecoveriesInputSchema = z.object({
  kind: OperonTaskWorkflowRecoveryKindSchema.optional(),
});

const OperonDeveloperApiRecoverySchema = z
  .object({
    kind: z.literal("developer-api"),
  })
  .strict();

const OperonTaskWorkflowRecoverySchema = z
  .object({
    kind: OperonTaskWorkflowRecoveryKindSchema,
    planDigest: OperonPlanDigestSchema.optional(),
  })
  .strict();

export const OperonRecoveryBindingSchema = z.discriminatedUnion("kind", [
  OperonDeveloperApiRecoverySchema,
  OperonTaskWorkflowRecoverySchema,
]);

export const OperonRecoverMutationInputSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(200),
    recoveryRef: z.string().trim().min(1).max(512),
    // The nested discriminated union keeps the MCP root an object while
    // publishing the planDigest => task-workflow-kind implication in
    // tools/list. The developer-api branch has no planDigest property.
    recovery: OperonRecoveryBindingSchema,
  })
  .strict();

export const OperonRecoverMutationSchema = OperonRecoverMutationInputSchema;

const OperonPendingRecoverySchema = z
  .object({
    recoveryRef: z.string().trim().min(1).max(512).optional(),
    planDigest: OperonPlanDigestSchema.optional(),
    mutationKind: z.string().trim().min(1).max(256).optional(),
    capability: z.string().trim().min(1).max(256).optional(),
    riskLevel: z.string().trim().min(1).max(128).optional(),
    createdAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    workflowKind: OperonTaskWorkflowRecoveryKindSchema.optional(),
    // Accepted for the bounded MCP test fixture and older additive Bridge
    // projections. The current Bridge uses workflowKind.
    kind: OperonTaskWorkflowRecoveryKindSchema.optional(),
  })
  .strip();

export const OperonPendingRecoveriesSchema = z.object({
  ok: z.literal(true),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  source: z.literal("operon-live"),
  stale: z.literal(false),
  recoveries: z.array(OperonPendingRecoverySchema).max(512),
});

const OperonNativeResourceRevisionSchema = z
  .object({
    resourceKind: z.enum([
      "timer",
      "repeat-series",
      "active-tracker",
      "pinned",
      "project-serial",
      "task-source",
    ]),
    resourceKey: z.string().min(1).max(4096),
    revision: z.string().min(1).max(4096),
  })
  .strict();

const OperonNativeAtomicGroupResultSchema = z
  .object({
    groupId: z.string().min(1).max(4096),
    status: z.enum(["committed", "failed", "outcome-unknown"]),
    resourceRevisions: z
      .array(OperonNativeResourceRevisionSchema)
      .max(1024)
      .optional(),
  })
  .strict();

const OperonNativeReceiptSchema = z
  .object({
    contractVersion: z.literal(1),
    planDigest: OperonPlanDigestSchema,
    mutationKind: z.enum([
      "task.adopt",
      "task.create",
      "task.update",
      "task.transition",
      "task.relationship",
      "task.recurrence",
      "task.convert",
      "task.inline-relocate",
    ]),
    targetDigest: OperonPlanDigestSchema,
    terminalOutcome: z.enum(["applied", "already-applied"]),
    effectiveAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const OperonNativePostflightSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("verified"),
      observedAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("receipt-replay"),
      observedAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
]);

export const OperonNativeMutationProofSchema = z
  .object({
    contractVersion: z.literal(1),
    kind: z.literal("mutation-result"),
    status: z.enum([
      "applied",
      "already-applied",
      "partial",
      "failed",
      "outcome-unknown",
    ]),
    mutationMayHaveApplied: z.boolean(),
    retryAllowed: z.boolean(),
    groupResults: z.array(OperonNativeAtomicGroupResultSchema).max(512),
    receipt: OperonNativeReceiptSchema.optional(),
    postflight: OperonNativePostflightSchema.optional(),
  })
  .strict();

export const OperonMutationResultSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  operationId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum([
    "planned",
    "applied",
    "already-applied",
    "outcome-unknown",
    "conflict",
    "not-ready",
    "not-found",
    "invalid-input",
    "rejected",
    "failed",
  ]),
  before: OperonTaskSchema.nullable().optional(),
  requested: z.record(z.unknown()),
  after: OperonTaskSchema.nullable().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  retryable: z.boolean().optional(),
  planDigest: OperonPlanDigestSchema.optional(),
  plan: z.record(z.unknown()).optional(),
  recoveryRef: z.string().optional(),
  mutationMayHaveApplied: z.boolean().optional(),
  nativeStatus: z.string().optional(),
  nativeProof: OperonNativeMutationProofSchema.optional(),
  source: z.literal("operon-live"),
  stale: z.literal(false),
  replayed: z.boolean().optional(),
});

export type OperonCreateTask = z.infer<typeof OperonCreateTaskSchema>;
export type OperonTaskFinder = z.infer<typeof OperonTaskFinderSchema>;
export type OperonResolveTask = z.infer<typeof OperonResolveTaskSchema>;
export type OperonRelationships = z.infer<typeof OperonRelationshipsSchema>;
export type OperonContext = z.infer<typeof OperonContextSchema>;
export type OperonAdoptTask = z.infer<typeof OperonAdoptTaskSchema>;
export type OperonCreatePeriodicTask = z.infer<
  typeof OperonCreatePeriodicTaskSchema
>;
export type OperonUpdatePeriodicScheduling = z.infer<
  typeof OperonUpdatePeriodicSchedulingSchema
>;
export type OperonUpdateTask = z.infer<typeof OperonUpdateTaskSchema>;
export type OperonSetRelationships = z.infer<
  typeof OperonSetRelationshipsSchema
>;
export type OperonUpdateRecurrence = z.infer<
  typeof OperonUpdateRecurrenceSchema
>;
export type OperonTransitionTask = z.infer<typeof OperonTransitionTaskSchema>;
export type OperonConvertTask = z.infer<typeof OperonConvertTaskSchema>;
export type OperonFilterQuery = z.infer<typeof OperonFilterQuerySchema>;
export type OperonRelocateTask = z.infer<typeof OperonRelocateTaskSchema>;
export type OperonPendingRecoveriesInput = z.infer<
  typeof OperonPendingRecoveriesInputSchema
>;
export type OperonRecoverMutation = z.infer<typeof OperonRecoverMutationSchema>;
export type OperonMutationResult = z.infer<typeof OperonMutationResultSchema>;

export interface OperonSnapshotEnvelope {
  source: "operon-live" | "operon-cache";
  stale: boolean;
  snapshotAt: string;
  snapshotAgeMs: number;
  operonVersion: string;
  bridgeVersion: string;
  contractVersion: typeof OPERON_CONTRACT_VERSION;
  snapshotSchemaVersion: 1 | typeof OPERON_SNAPSHOT_SCHEMA_VERSION;
  settingsSignature: string | null;
  generation: number | null;
  capabilities: z.infer<typeof OperonCapabilitiesSchema>;
  limitations: string[];
  tasks: OperonTask[];
}

export interface OperonTaskPage {
  source: OperonSnapshotEnvelope["source"];
  stale: boolean;
  snapshotAt: string;
  snapshotAgeMs: number;
  operonVersion: string;
  bridgeVersion: string;
  contractVersion: typeof OPERON_CONTRACT_VERSION;
  snapshotSchemaVersion: OperonSnapshotEnvelope["snapshotSchemaVersion"];
  capabilities: OperonSnapshotEnvelope["capabilities"];
  limitations: string[];
  total: number;
  count: number;
  cursor: string;
  nextCursor?: string;
  hasMore: boolean;
  tasks: OperonTask[];
}

function normalizeNeedle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase();
}

function fieldValueEquals(
  actual: OperonFieldValue | undefined,
  expected: OperonFieldValue,
): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    return (
      actual.length === expected.length &&
      actual.every(
        (value, index) =>
          normalizeNeedle(value) === normalizeNeedle(expected[index]),
      )
    );
  }
  return normalizeNeedle(actual) === normalizeNeedle(expected);
}

function searchableFieldValues(
  fields: Record<string, OperonFieldValue>,
): string[] {
  return Object.values(fields).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function dateValue(
  task: OperonTask,
  field: OperonDateFilter["field"],
): string | null {
  return task.dates[field];
}

function matchDate(value: string | null, filter: OperonDateFilter): boolean {
  if (!value) return false;
  if (filter.on && value.slice(0, filter.on.length) !== filter.on) return false;
  if (filter.before && !(value < filter.before)) return false;
  if (filter.after && !(value > filter.after)) return false;
  return true;
}

function tagSet(task: OperonTask): Set<string> {
  return new Set(task.tags.map(normalizeNeedle));
}

export function filterOperonTasks(
  tasks: OperonTask[],
  query: OperonQuery,
): OperonTask[] {
  const ids = new Set(query.operonIds ?? []);
  const sources = new Set(query.sources ?? []);
  const checkboxes = new Set(query.checkboxes ?? []);
  const statuses = new Set((query.statuses ?? []).map(normalizeNeedle));
  const statusIds = new Set((query.statusIds ?? []).map(normalizeNeedle));
  const pipelines = new Set((query.pipelines ?? []).map(normalizeNeedle));
  const pipelineIds = new Set((query.pipelineIds ?? []).map(normalizeNeedle));
  const priorities = new Set((query.priorities ?? []).map(normalizeNeedle));
  const tiers = new Set(query.tiers ?? []);
  const search = normalizeNeedle(query.search);

  return tasks.filter((task) => {
    if (ids.size > 0 && !ids.has(task.operonId)) return false;
    if (sources.size > 0 && !sources.has(task.source)) return false;
    if (checkboxes.size > 0 && !checkboxes.has(task.checkbox)) return false;
    if (statuses.size > 0 && !statuses.has(normalizeNeedle(task.status)))
      return false;
    if (statusIds.size > 0 && !statusIds.has(normalizeNeedle(task.statusId)))
      return false;
    if (pipelines.size > 0 && !pipelines.has(normalizeNeedle(task.pipeline)))
      return false;
    if (
      pipelineIds.size > 0 &&
      !pipelineIds.has(normalizeNeedle(task.pipelineId))
    )
      return false;
    if (priorities.size > 0 && !priorities.has(normalizeNeedle(task.priority)))
      return false;
    if (tiers.size > 0 && !tiers.has(task.tier)) return false;
    if (
      (query.pathIncludes ?? []).some(
        (value: string) =>
          !normalizeNeedle(task.path).includes(normalizeNeedle(value)),
      )
    ) {
      return false;
    }
    if (
      (query.pathExcludes ?? []).some((value: string) =>
        normalizeNeedle(task.path).includes(normalizeNeedle(value)),
      )
    ) {
      return false;
    }
    const tags = tagSet(task);
    if (
      (query.tagsAny?.length ?? 0) > 0 &&
      !(query.tagsAny ?? []).some((tag: string) =>
        tags.has(normalizeNeedle(tag)),
      )
    ) {
      return false;
    }
    if (
      (query.tagsAll?.length ?? 0) > 0 &&
      !(query.tagsAll ?? []).every((tag: string) =>
        tags.has(normalizeNeedle(tag)),
      )
    ) {
      return false;
    }
    if (query.parentTask !== undefined && task.parentTask !== query.parentTask)
      return false;
    if (
      (query.dates ?? []).some(
        (filter: OperonDateFilter) =>
          !matchDate(dateValue(task, filter.field), filter),
      )
    )
      return false;
    for (const [key, expected] of Object.entries(query.fieldEquals ?? {})) {
      if (!fieldValueEquals(task.fields[key], expected)) return false;
    }
    for (const [key, expected] of Object.entries(query.propertyEquals ?? {})) {
      if (stableStringify(task.properties?.[key]) !== stableStringify(expected))
        return false;
    }
    if (search) {
      const searchable = [
        task.operonId,
        task.description,
        task.path,
        task.status,
        task.statusId,
        task.statusLabel,
        task.pipeline,
        task.pipelineId,
        task.priority,
        task.parentTask,
        ...task.tags,
        ...searchableFieldValues(task.fields),
        ...(task.properties ? [stableStringify(task.properties)] : []),
      ]
        .map(normalizeNeedle)
        .join("\n");
      if (!searchable.includes(search)) return false;
    }
    return true;
  });
}

function sortValue(
  task: OperonTask,
  field: OperonSort["field"],
): string | number {
  switch (field) {
    case "description":
      return task.description;
    case "status":
      return task.status ?? "";
    case "pipeline":
      return task.pipeline ?? "";
    case "priority":
      return task.priority ?? "";
    case "due":
      return task.dates.due ?? "";
    case "scheduled":
      return task.dates.scheduled ?? "";
    case "path":
      return task.path;
    case "line":
      return task.line ?? 0;
    case "datetimeModified":
      return task.dates.modified ?? "";
    case "tier":
      return task.tier;
    default:
      return "";
  }
}

export function sortOperonTasks(
  tasks: OperonTask[],
  query: OperonQuery,
): OperonTask[] {
  const rules = query.sort?.length
    ? query.sort
    : [
        { field: "path" as const, direction: "asc" as const },
        { field: "line" as const, direction: "asc" as const },
      ];
  return [...tasks].sort((left, right) => {
    for (const rule of rules) {
      const direction = rule.direction === "desc" ? -1 : 1;
      const leftValue = sortValue(left, rule.field);
      const rightValue = sortValue(right, rule.field);
      const compared =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
      if (compared !== 0) return compared * direction;
    }
    return left.operonId.localeCompare(right.operonId);
  });
}

export function parseOperonCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid Operon cursor '${cursor}'.`);
  }
  return value;
}

function stripProperties(task: OperonTask): OperonTask {
  if (!("properties" in task)) return task;
  const { properties: _properties, ...rest } = task;
  return rest;
}

export function queryOperonSnapshot(
  snapshot: OperonSnapshotEnvelope,
  queryInput: unknown,
): OperonTaskPage {
  const query = OperonQuerySchema.parse(queryInput);
  const filtered = sortOperonTasks(
    filterOperonTasks(snapshot.tasks, query),
    query,
  );
  const offset = parseOperonCursor(query.cursor);
  const page = filtered.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    source: snapshot.source,
    stale: snapshot.stale,
    snapshotAt: snapshot.snapshotAt,
    snapshotAgeMs: snapshot.snapshotAgeMs,
    operonVersion: snapshot.operonVersion,
    bridgeVersion: snapshot.bridgeVersion,
    contractVersion: snapshot.contractVersion,
    snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
    capabilities: snapshot.capabilities,
    limitations: snapshot.limitations,
    total: filtered.length,
    count: page.length,
    cursor: String(offset),
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
    hasMore: nextOffset < filtered.length,
    tasks: query.includeProperties ? page : page.map(stripProperties),
  };
}
