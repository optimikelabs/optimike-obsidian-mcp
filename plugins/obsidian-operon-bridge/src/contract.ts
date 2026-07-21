export const OPERON_BRIDGE_CONTRACT_VERSION = "1" as const;
export const OPERON_BRIDGE_TESTED_VERSION = "2.5.0" as const;
export const OPERON_BRIDGE_SUPPORTED_VERSIONS = ["2.4.0", OPERON_BRIDGE_TESTED_VERSION] as const;

export type OperonTaskSource = "inline" | "file";
export type OperonCheckboxState = "open" | "done" | "cancelled";
export type OperonTier = "hot" | "warm" | "cold";
export type SortDirection = "asc" | "desc";

export interface RuntimeTaskLocation {
  filePath: string;
  lineNumber: number;
  format: "inline" | "yaml";
}

export interface RuntimeIndexedTask {
  operonId: string;
  description: string;
  checkbox: OperonCheckboxState;
  fieldValues: Record<string, string>;
  tags: string[];
  primary: RuntimeTaskLocation;
  datetimeModified: string;
  tier: OperonTier;
  plainCheckboxProgress?: {
    total: number;
    completed: number;
  };
}

export interface RuntimeStatusDefinition {
	id?: string;
  label: string;
  isFinished?: boolean;
  isCancelled?: boolean;
	isScheduledTarget?: boolean;
	isTrackingTarget?: boolean;
}

export interface RuntimePipeline {
  id?: string;
  name: string;
  description?: string;
  statuses: RuntimeStatusDefinition[];
}

export interface RuntimePriorityDefinition {
	id?: string;
	label: string;
	color?: string;
	description?: string;
}

export interface RuntimeFileTaskTemplate {
	id: string;
	name: string;
	path: string | null;
	kind: string;
	pipelineId?: string;
	description?: string;
}

export interface OperonWorkflowTaxonomy {
	language: string;
	defaultPipelineName: string | null;
	pipelines: Array<{
		id: string | null;
		name: string;
		description: string | null;
		statuses: Array<{
			id: string | null;
			label: string;
			value: string;
			isFinished: boolean;
			isCancelled: boolean;
			isScheduledTarget: boolean;
			isTrackingTarget: boolean;
		}>;
	}>;
}

export interface OperonSemanticConfiguration {
	language: string;
	workflow: OperonWorkflowTaxonomy;
	priorities: {
		defaultPriority: string | null;
		items: Array<{
			id: string | null;
			label: string;
			color: string | null;
			description: string | null;
		}>;
	};
	keys: Array<{
		canonicalKey: string;
		visiblePropertyName: string;
		type: string | null;
		sync: string | null;
		enabled: boolean;
		isSystem: boolean;
		isInternal: boolean;
	}>;
	creation: {
		fileTasksFolder: string;
		inlineTaskSaveMode: string;
		inlineTaskUseDailyNote: boolean;
		inlineTaskTargetFile: string;
		inlineTaskHeading: string;
		inlineTaskDailyNoteAddStartDate: boolean;
		inlineTaskDailyNoteAddScheduledDate: boolean;
		taskCreatorDefaultToFileTask: boolean;
		taskCreatorDefaultFileTemplateId: string | null;
		fileTaskTemplateFolder: string;
		fileTaskParentInlineTargetMode: string;
		fileTaskParentFileTargetMode: string;
		availableFileTaskTemplates: Array<{
			id: string;
			name: string;
			path: string | null;
			kind: string;
			pipelineId: string | null;
			description: string | null;
		}>;
	};
	automation: {
		autoCompleteParentWhenAllChildrenTerminal: boolean;
		cascadeCancelToDescendants: boolean;
		fileTaskAutoArchiveEnabled: boolean;
		fileTaskArchiveFolder: string;
		fileTaskArchiveDelaySeconds: number;
		fileTaskArchiveOnlyFromFileTasksFolder: boolean;
		fileRepeatDestination: string;
		fileRepeatCustomFolder: string;
	};
	indexing: {
		excludedFolders: string[];
		fullReindexOnStartup: boolean;
		indexEventDebounceMs: number;
	};
	docs: {
		folder: string;
		autoUpdateEnabled: boolean;
	};
	views: {
		filters: Array<{
			id: string;
			name: string;
			icon: string | null;
			definition: Record<string, unknown>;
		}>;
	};
}

export interface OperonBridgeConfiguration {
	ok: true;
	contractVersion: typeof OPERON_BRIDGE_CONTRACT_VERSION;
	source: 'operon-runtime';
	stale: false;
	operonVersion: string;
	bridgeVersion: string;
	settingsSignature: string;
	configuration: OperonSemanticConfiguration;
	limitations: string[];
}

export interface RuntimeKeyMapping {
  canonicalKey: string;
  visiblePropertyName: string;
  type?: string;
  sync?: string;
  enabled?: boolean;
  isSystem?: boolean;
  isInternal?: boolean;
}

export interface OperonTaskDates {
  due: string | null;
  scheduled: string | null;
  started: string | null;
  completed: string | null;
  cancelled: string | null;
  datetimeStart: string | null;
  datetimeEnd: string | null;
  created: string | null;
  modified: string | null;
}

export interface OperonBridgeTask {
  operonId: string;
  source: OperonTaskSource;
  path: string;
  line: number | null;
  sourceMtime: number | null;
  description: string;
  checkbox: OperonCheckboxState;
  status: string | null;
  statusLabel: string | null;
  pipeline: string | null;
  priority: string | null;
  tier: OperonTier;
  tags: string[];
  parentTask: string | null;
  blocking: string[];
  blockedBy: string[];
  dates: OperonTaskDates;
  fields: Record<string, string>;
  properties?: Record<string, unknown>;
  plainCheckboxProgress?: {
    total: number;
    completed: number;
  };
  revision: string;
  sourceKind: "operon-index";
  operonVersion: string;
  bridgeVersion: string;
}

export interface OperonTaskSort {
  field:
    | "description"
    | "status"
    | "pipeline"
    | "priority"
    | "due"
    | "scheduled"
    | "path"
    | "line"
    | "datetimeModified"
    | "tier";
  direction?: SortDirection;
}

export interface OperonDateFilter {
  field:
    | "due"
    | "scheduled"
    | "started"
    | "completed"
    | "cancelled"
    | "datetimeStart"
    | "datetimeEnd"
    | "created"
    | "modified";
  before?: string;
  after?: string;
  on?: string;
}

export interface OperonTaskQuery {
  operonIds?: string[];
  search?: string;
  sources?: OperonTaskSource[];
  checkboxes?: OperonCheckboxState[];
  statuses?: string[];
  pipelines?: string[];
  priorities?: string[];
  tiers?: OperonTier[];
  pathIncludes?: string[];
  pathExcludes?: string[];
  tagsAny?: string[];
  tagsAll?: string[];
  parentTask?: string | null;
  dates?: OperonDateFilter[];
  fieldEquals?: Record<string, string>;
  propertyEquals?: Record<string, unknown>;
  sort?: OperonTaskSort[];
  includeProperties?: boolean;
  cursor?: string;
  limit?: number;
}

export interface OperonTaskPage {
  ok: true;
  contractVersion: typeof OPERON_BRIDGE_CONTRACT_VERSION;
  source: "operon-live";
  stale: false;
  generation: number;
  settingsSignature: string;
  total: number;
  count: number;
  cursor: string;
  nextCursor?: string;
  hasMore: boolean;
  tasks: OperonBridgeTask[];
  limitations: string[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function isVersionCompatible(version: string): boolean {
  return (OPERON_BRIDGE_SUPPORTED_VERSIONS as readonly string[]).includes(version.trim());
}

export interface RuntimeIndexDiagnostics {
  health?: string;
  runtimePhase?: string;
  verifiedThisSession?: boolean;
  taskCount?: number;
  dirtySourceCount?: number;
}

export function shouldAttemptIndexValidation(options: {
  compatible: boolean;
  generation: number | null;
  diagnostics: RuntimeIndexDiagnostics | null;
  hasValidator: boolean;
}): boolean {
  const { compatible, generation, diagnostics, hasValidator } = options;
  return Boolean(
    compatible &&
      hasValidator &&
      Number.isInteger(generation) &&
      (generation ?? 0) > 0 &&
      diagnostics?.health === "healthy" &&
      diagnostics.runtimePhase === "idle" &&
      diagnostics.verifiedThisSession === false &&
      (diagnostics.dirtySourceCount ?? 0) === 0,
  );
}

export function isIndexReady(options: {
  compatible: boolean;
  generation: number | null;
  diagnostics: RuntimeIndexDiagnostics | null;
}): boolean {
  const { compatible, generation, diagnostics } = options;
  return Boolean(
    compatible &&
      Number.isInteger(generation) &&
      (generation ?? 0) > 0 &&
      diagnostics?.health === "healthy" &&
      diagnostics.runtimePhase === "idle" &&
      diagnostics.verifiedThisSession === true &&
      (diagnostics.dirtySourceCount ?? 0) === 0,
  );
}

export function parseListValue(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[;,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveWorkflow(
  statusValue: string | undefined,
  pipelines: RuntimePipeline[],
): { pipeline: string | null; statusLabel: string | null } {
  const value = statusValue?.trim();
  if (!value) return { pipeline: null, statusLabel: null };
  for (const pipeline of pipelines) {
    for (const status of pipeline.statuses ?? []) {
      if (`${pipeline.name}.${status.label}` === value) {
        return { pipeline: pipeline.name, statusLabel: status.label };
      }
    }
  }
  return { pipeline: null, statusLabel: null };
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
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value ?? "");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeProperties(
  frontmatter: Record<string, unknown> | undefined,
  keyMappings: RuntimeKeyMapping[],
): Record<string, unknown> | undefined {
  if (!frontmatter) return undefined;
  const managedNames = new Set<string>(["tags", "cssclasses", "position"]);
  for (const mapping of keyMappings) {
    managedNames.add(mapping.canonicalKey);
    managedNames.add(mapping.visiblePropertyName);
  }
  const entries = Object.entries(frontmatter)
    .filter(([key]) => !managedNames.has(key))
    .filter(([key]) => !key.startsWith("_"))
    .map(([key, value]) => [key, stableValue(value)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeTask(options: {
  task: RuntimeIndexedTask;
  pipelines: RuntimePipeline[];
  keyMappings: RuntimeKeyMapping[];
  frontmatter?: Record<string, unknown>;
  sourceMtime?: number | null;
  operonVersion: string;
  bridgeVersion: string;
  includeProperties: boolean;
}): OperonBridgeTask {
  const { task } = options;
  const fields = { ...task.fieldValues };
  const status = fields.status?.trim() || null;
  const workflow = resolveWorkflow(status ?? undefined, options.pipelines);
  const properties = options.includeProperties
    ? normalizeProperties(options.frontmatter, options.keyMappings)
    : undefined;
  const normalized: Omit<OperonBridgeTask, "revision"> = {
    operonId: task.operonId,
    source: task.primary.format === "yaml" ? "file" : "inline",
    path: task.primary.filePath,
    line: task.primary.format === "inline" ? task.primary.lineNumber + 1 : null,
    sourceMtime: options.sourceMtime ?? null,
    description: task.description,
    checkbox: task.checkbox,
    status,
    statusLabel: workflow.statusLabel,
    pipeline: workflow.pipeline,
    priority: fields.priority?.trim() || null,
    tier: task.tier,
    tags: [...new Set(task.tags.map((tag) => tag.replace(/^#/u, "").trim()).filter(Boolean))].sort(),
    parentTask: fields.parentTask?.trim() || null,
    blocking: parseListValue(fields.blocking),
    blockedBy: parseListValue(fields.blockedBy),
    dates: {
      due: fields.dateDue?.trim() || null,
      scheduled: fields.dateScheduled?.trim() || null,
      started: fields.dateStarted?.trim() || null,
      completed: fields.dateCompleted?.trim() || null,
      cancelled: fields.dateCancelled?.trim() || null,
      datetimeStart: fields.datetimeStart?.trim() || null,
      datetimeEnd: fields.datetimeEnd?.trim() || null,
      created: fields.datetimeCreated?.trim() || null,
      modified: fields.datetimeModified?.trim() || task.datetimeModified?.trim() || null,
    },
    fields,
    ...(properties ? { properties } : {}),
    ...(task.plainCheckboxProgress
      ? { plainCheckboxProgress: { ...task.plainCheckboxProgress } }
      : {}),
    sourceKind: "operon-index",
    operonVersion: options.operonVersion,
    bridgeVersion: options.bridgeVersion,
  };
  const revisionPayload = {
    ...normalized,
    properties: properties ?? null,
  };
  return {
    ...normalized,
    revision: `fnv1a32:${fnv1a32(stableStringify(revisionPayload))}`,
  };
}

function normalizeNeedle(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function includesEvery(haystack: string[], needles: string[]): boolean {
  const normalized = new Set(haystack.map(normalizeNeedle));
  return needles.every((needle) => normalized.has(normalizeNeedle(needle)));
}

function includesAny(haystack: string[], needles: string[]): boolean {
  const normalized = new Set(haystack.map(normalizeNeedle));
  return needles.some((needle) => normalized.has(normalizeNeedle(needle)));
}

function matchesDate(value: string | null, filter: OperonDateFilter): boolean {
  if (!value) return false;
  if (filter.on && value.slice(0, filter.on.length) !== filter.on) return false;
  if (filter.before && !(value < filter.before)) return false;
  if (filter.after && !(value > filter.after)) return false;
  return true;
}

function propertyValue(task: OperonBridgeTask, key: string): unknown {
  return task.properties?.[key];
}

export function filterTasks(
  tasks: OperonBridgeTask[],
  query: OperonTaskQuery,
): OperonBridgeTask[] {
  const search = normalizeNeedle(query.search);
  const operonIds = new Set(query.operonIds ?? []);
  const sources = new Set(query.sources ?? []);
  const checkboxes = new Set(query.checkboxes ?? []);
  const statuses = new Set((query.statuses ?? []).map(normalizeNeedle));
  const pipelines = new Set((query.pipelines ?? []).map(normalizeNeedle));
  const priorities = new Set((query.priorities ?? []).map(normalizeNeedle));
  const tiers = new Set(query.tiers ?? []);

  return tasks.filter((task) => {
    if (operonIds.size > 0 && !operonIds.has(task.operonId)) return false;
    if (sources.size > 0 && !sources.has(task.source)) return false;
    if (checkboxes.size > 0 && !checkboxes.has(task.checkbox)) return false;
    if (statuses.size > 0 && !statuses.has(normalizeNeedle(task.status))) return false;
    if (pipelines.size > 0 && !pipelines.has(normalizeNeedle(task.pipeline))) return false;
    if (priorities.size > 0 && !priorities.has(normalizeNeedle(task.priority))) return false;
    if (tiers.size > 0 && !tiers.has(task.tier)) return false;
    if ((query.pathIncludes ?? []).some((needle) => !normalizeNeedle(task.path).includes(normalizeNeedle(needle)))) {
      return false;
    }
    if ((query.pathExcludes ?? []).some((needle) => normalizeNeedle(task.path).includes(normalizeNeedle(needle)))) {
      return false;
    }
    if ((query.tagsAny?.length ?? 0) > 0 && !includesAny(task.tags, query.tagsAny ?? [])) return false;
    if ((query.tagsAll?.length ?? 0) > 0 && !includesEvery(task.tags, query.tagsAll ?? [])) return false;
    if (query.parentTask !== undefined && task.parentTask !== query.parentTask) return false;
    if ((query.dates ?? []).some((filter) => !matchesDate(task.dates[filter.field], filter))) return false;
    for (const [key, expected] of Object.entries(query.fieldEquals ?? {})) {
      if (normalizeNeedle(task.fields[key]) !== normalizeNeedle(expected)) return false;
    }
    for (const [key, expected] of Object.entries(query.propertyEquals ?? {})) {
      if (stableStringify(propertyValue(task, key)) !== stableStringify(expected)) return false;
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

function sortValue(task: OperonBridgeTask, field: OperonTaskSort["field"]): string | number {
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
  }
}

export function sortTasks(
  tasks: OperonBridgeTask[],
  sort: OperonTaskSort[] | undefined,
): OperonBridgeTask[] {
  const rules: OperonTaskSort[] = sort?.length
    ? sort
    : [
        { field: "path", direction: "asc" as const },
        { field: "line", direction: "asc" as const },
      ];
  return [...tasks].sort((left, right) => {
    for (const rule of rules) {
      const direction = rule.direction === "desc" ? -1 : 1;
      const leftValue = sortValue(left, rule.field);
      const rightValue = sortValue(right, rule.field);
      const comparison =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
      if (comparison !== 0) return comparison * direction;
    }
    return left.operonId.localeCompare(right.operonId);
  });
}

export function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid cursor '${cursor}'.`);
  }
  return value;
}

export function paginateTasks(
  tasks: OperonBridgeTask[],
  query: Pick<OperonTaskQuery, "cursor" | "limit">,
): Omit<
  OperonTaskPage,
  | "contractVersion"
  | "source"
  | "stale"
  | "generation"
  | "settingsSignature"
  | "limitations"
  | "ok"
> {
  const offset = parseCursor(query.cursor);
  const limit = Math.max(1, Math.min(MAX_LIMIT, query.limit ?? DEFAULT_LIMIT));
  const page = tasks.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    total: tasks.length,
    count: page.length,
    cursor: String(offset),
    nextCursor: nextOffset < tasks.length ? String(nextOffset) : undefined,
    hasMore: nextOffset < tasks.length,
    tasks: page,
  };
}

export function queryTasks(
  tasks: OperonBridgeTask[],
  query: OperonTaskQuery,
): Omit<
  OperonTaskPage,
  | "contractVersion"
  | "source"
  | "stale"
  | "generation"
  | "settingsSignature"
  | "limitations"
  | "ok"
> {
  return paginateTasks(sortTasks(filterTasks(tasks, query), query.sort), query);
}

export function settingsSignature(configuration: OperonSemanticConfiguration): string {
  return `fnv1a32:${fnv1a32(stableStringify(configuration))}`;
}
