import { z } from "zod";

export const OPERON_CONTRACT_VERSION = "1" as const;
export const OPERON_SNAPSHOT_SCHEMA_VERSION = 1;

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

export const OperonTaskSchema = z.object({
  operonId: z.string().min(1),
  source: OperonTaskSourceSchema,
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  sourceMtime: z.number().nullable(),
  description: z.string(),
  checkbox: OperonCheckboxSchema,
  status: z.string().nullable(),
  statusLabel: z.string().nullable(),
  pipeline: z.string().nullable(),
  priority: z.string().nullable(),
  tier: OperonTierSchema,
  tags: z.array(z.string()),
  parentTask: z.string().nullable(),
  blocking: z.array(z.string()),
  blockedBy: z.array(z.string()),
  dates: OperonTaskDatesSchema,
  fields: z.record(z.string()),
  properties: z.record(z.unknown()).optional(),
  plainCheckboxProgress: z
    .object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative() })
    .optional(),
  revision: z.string().min(1),
  sourceKind: z.literal("operon-index"),
  operonVersion: z.string().min(1),
  bridgeVersion: z.string().min(1),
});

export type OperonTask = z.infer<typeof OperonTaskSchema>;

export const OperonCapabilitiesSchema = z.object({
  status: z.boolean(),
  list: z.boolean(),
  get: z.boolean(),
  query: z.boolean(),
  validate: z.boolean(),
  create: z.boolean(),
  update: z.boolean(),
  transition: z.boolean(),
  convert: z.boolean(),
});

export const OperonStatusSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  bridge: z.object({
    id: z.string(),
    version: z.string(),
    mode: z.enum(["read-only", "read-write"]),
  }),
  operon: z.object({
    present: z.boolean(),
    version: z.string().nullable(),
    compatible: z.boolean(),
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
  capabilities: OperonCapabilitiesSchema,
  source: z.literal("operon-runtime"),
  stale: z.literal(false),
  limitations: z.array(z.string()),
});

export type OperonStatus = z.infer<typeof OperonStatusSchema>;

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
  pipelines: z.array(z.string()).optional(),
  priorities: z.array(z.string()).optional(),
  tiers: z.array(OperonTierSchema).optional(),
  pathIncludes: z.array(z.string()).optional(),
  pathExcludes: z.array(z.string()).optional(),
  tagsAny: z.array(z.string()).optional(),
  tagsAll: z.array(z.string()).optional(),
  parentTask: z.string().nullable().optional(),
  dates: z.array(OperonDateFilterSchema).optional(),
  fieldEquals: z.record(z.string()).optional(),
  propertyEquals: z.record(z.unknown()).optional(),
  sort: z.array(OperonSortSchema).optional(),
  includeProperties: z.boolean().optional().default(false),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(500).optional().default(100),
  forceRefresh: z.boolean().optional().default(false),
});

export type OperonQuery = z.infer<typeof OperonQuerySchema>;

export const OperonRawPropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
]);

const MutationControlSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  dryRun: z.boolean().optional().default(true),
});

export const OperonCreateTaskSchema = MutationControlSchema.extend({
  task: z.object({
    source: OperonTaskSourceSchema,
    description: z.string().trim().min(1),
    tags: z.array(z.string()).optional(),
    fields: z.record(z.string()).optional(),
    properties: z.record(OperonRawPropertyValueSchema).optional(),
    fileTemplateId: z.string().optional(),
    targetDateKey: z.string().optional(),
    targetFolder: z.string().optional(),
    targetPath: z.string().optional(),
  }).superRefine((value, context) => {
  if (value.source === "file" && value.targetPath?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetPath"], message: "targetPath is supported only for inline tasks." });
  }
  if (value.source === "inline" && value.targetFolder?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetFolder"], message: "targetFolder is supported only for file tasks." });
  }
  }),
});

export const OperonUpdatePatchSchema = z.object({
  description: z.string().trim().min(1).optional(),
  tags: z.array(z.string()).optional(),
  fields: z.record(z.string()).optional(),
  properties: z.record(OperonRawPropertyValueSchema).optional(),
}).superRefine((value, context) => {
  const groupCount = [
    value.description !== undefined,
    value.tags !== undefined || value.fields !== undefined,
    value.properties !== undefined,
  ].filter(Boolean).length;
  if (groupCount !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one mutation group: description, managed fields/tags, or one unmanaged property.",
    });
  }
  if (value.properties && Object.keys(value.properties).length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Update exactly one unmanaged property per operation.",
    });
  }
});

export const OperonUpdateTaskSchema = MutationControlSchema.extend({
  operonId: z.string().min(1),
  expectedRevision: z.string().min(1),
  patch: OperonUpdatePatchSchema,
});

export const OperonTransitionTaskSchema = MutationControlSchema.extend({
  operonId: z.string().min(1),
  expectedRevision: z.string().min(1),
  status: z.string().trim().min(1),
});

export const OperonConvertTaskInputSchema = MutationControlSchema.extend({
  operonId: z.string().min(1),
  expectedRevision: z.string().min(1),
  target: OperonTaskSourceSchema,
  fileTemplateId: z.string().optional(),
  targetPath: z.string().optional(),
});

export const OperonConvertTaskSchema = OperonConvertTaskInputSchema.superRefine((value, context) => {
  if (value.target === "inline" && !value.targetPath?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetPath"],
      message: "targetPath is required for file-to-inline conversion.",
    });
  }
});

export const OperonMutationResultSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.literal(OPERON_CONTRACT_VERSION),
  operationId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(["planned", "applied", "conflict", "rejected", "failed"]),
  before: OperonTaskSchema.nullable().optional(),
  requested: z.record(z.unknown()),
  after: OperonTaskSchema.nullable().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  retryable: z.boolean().optional(),
  source: z.literal("operon-live"),
  stale: z.literal(false),
  replayed: z.boolean().optional(),
});

export type OperonCreateTask = z.infer<typeof OperonCreateTaskSchema>;
export type OperonUpdateTask = z.infer<typeof OperonUpdateTaskSchema>;
export type OperonTransitionTask = z.infer<typeof OperonTransitionTaskSchema>;
export type OperonConvertTask = z.infer<typeof OperonConvertTaskSchema>;
export type OperonMutationResult = z.infer<typeof OperonMutationResultSchema>;

export interface OperonSnapshotEnvelope {
  source: "operon-live" | "operon-cache";
  stale: boolean;
  snapshotAt: string;
  snapshotAgeMs: number;
  operonVersion: string;
  bridgeVersion: string;
  contractVersion: typeof OPERON_CONTRACT_VERSION;
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
  return String(value ?? "").trim().toLocaleLowerCase();
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

function dateValue(task: OperonTask, field: OperonDateFilter["field"]): string | null {
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

export function filterOperonTasks(tasks: OperonTask[], query: OperonQuery): OperonTask[] {
  const ids = new Set(query.operonIds ?? []);
  const sources = new Set(query.sources ?? []);
  const checkboxes = new Set(query.checkboxes ?? []);
  const statuses = new Set((query.statuses ?? []).map(normalizeNeedle));
  const pipelines = new Set((query.pipelines ?? []).map(normalizeNeedle));
  const priorities = new Set((query.priorities ?? []).map(normalizeNeedle));
  const tiers = new Set(query.tiers ?? []);
  const search = normalizeNeedle(query.search);

  return tasks.filter((task) => {
    if (ids.size > 0 && !ids.has(task.operonId)) return false;
    if (sources.size > 0 && !sources.has(task.source)) return false;
    if (checkboxes.size > 0 && !checkboxes.has(task.checkbox)) return false;
    if (statuses.size > 0 && !statuses.has(normalizeNeedle(task.status))) return false;
    if (pipelines.size > 0 && !pipelines.has(normalizeNeedle(task.pipeline))) return false;
    if (priorities.size > 0 && !priorities.has(normalizeNeedle(task.priority))) return false;
    if (tiers.size > 0 && !tiers.has(task.tier)) return false;
    if ((query.pathIncludes ?? []).some((value: string) => !normalizeNeedle(task.path).includes(normalizeNeedle(value)))) {
      return false;
    }
    if ((query.pathExcludes ?? []).some((value: string) => normalizeNeedle(task.path).includes(normalizeNeedle(value)))) {
      return false;
    }
    const tags = tagSet(task);
    if ((query.tagsAny?.length ?? 0) > 0 && !(query.tagsAny ?? []).some((tag: string) => tags.has(normalizeNeedle(tag)))) {
      return false;
    }
    if ((query.tagsAll?.length ?? 0) > 0 && !(query.tagsAll ?? []).every((tag: string) => tags.has(normalizeNeedle(tag)))) {
      return false;
    }
    if (query.parentTask !== undefined && task.parentTask !== query.parentTask) return false;
    if ((query.dates ?? []).some((filter: OperonDateFilter) => !matchDate(dateValue(task, filter.field), filter))) return false;
    for (const [key, expected] of Object.entries(query.fieldEquals ?? {})) {
      if (normalizeNeedle(task.fields[key]) !== normalizeNeedle(expected)) return false;
    }
    for (const [key, expected] of Object.entries(query.propertyEquals ?? {})) {
      if (stableStringify(task.properties?.[key]) !== stableStringify(expected)) return false;
    }
    if (search) {
      const searchable = [
        task.operonId,
        task.description,
        task.path,
        task.status,
        task.statusLabel,
        task.pipeline,
        task.priority,
        task.parentTask,
        ...task.tags,
        ...Object.values(task.fields),
        ...(task.properties ? [stableStringify(task.properties)] : []),
      ]
        .map(normalizeNeedle)
        .join("\n");
      if (!searchable.includes(search)) return false;
    }
    return true;
  });
}

function sortValue(task: OperonTask, field: OperonSort["field"]): string | number {
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

export function sortOperonTasks(tasks: OperonTask[], query: OperonQuery): OperonTask[] {
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
  const filtered = sortOperonTasks(filterOperonTasks(snapshot.tasks, query), query);
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
