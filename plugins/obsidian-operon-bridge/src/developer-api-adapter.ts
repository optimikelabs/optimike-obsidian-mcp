import {
  type OperonSemanticConfiguration,
  type RuntimeIndexDiagnostics,
  type RuntimeIndexedTask,
  type RuntimeKeyMapping,
  type RuntimePipeline,
  type RuntimePriorityDefinition,
  resolvePriorityStableId,
} from "./contract";

/**
 * Minimal structural view of the official Operon Developer API V1.
 *
 * The Bridge deliberately does not import Operon's private/runtime modules.
 * This boundary is the only compatibility surface used for Operon 3.x.
 */
export interface DeveloperApiConsumerPlugin {
  readonly manifest: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  };
}

interface DeveloperApiError {
  readonly code?: string;
  readonly reason?: string;
  readonly message?: string;
}

export interface DeveloperApiChannelStatus {
  readonly availability?: string;
  readonly reason?: string;
  readonly authority?: string;
  readonly admission?: {
    readonly reads?: boolean;
    readonly writes?: boolean;
  };
  readonly grant?: {
    readonly state?: string;
    readonly effectiveCapabilities?: readonly string[];
  };
  readonly error?: DeveloperApiError;
  readonly [key: string]: unknown;
}

interface DeveloperApiTaskLocator {
  readonly representation: "inline" | "file";
  readonly filePath: string;
  readonly lineNumber?: number;
}

interface DeveloperApiTask {
  readonly identity: { readonly operonId: string };
  readonly description: string;
  readonly representation: "inline" | "file";
  readonly locator: DeveloperApiTaskLocator;
  readonly checkbox: "open" | "done" | "cancelled";
  readonly workflow?: {
    readonly pipeline: { readonly id: string; readonly label: string };
    readonly status: { readonly id: string; readonly label: string };
  };
  readonly priority?: { readonly id: string; readonly label: string };
  readonly dates?: {
    readonly due?: string;
    readonly scheduled?: string;
    readonly started?: string;
    readonly completed?: string;
    readonly cancelled?: string;
  };
  readonly datetimes?: {
    readonly start?: string;
    readonly end?: string;
    readonly created?: string;
    readonly modified?: string;
  };
  readonly relationships?: {
    readonly parentOperonId?: string;
    readonly childOperonIds?: readonly string[];
    readonly blockingOperonIds?: readonly string[];
    readonly blockedByOperonIds?: readonly string[];
    readonly relatedOperonIds?: readonly string[];
  };
  readonly pinned?: boolean;
  readonly customFields?: Record<string, unknown>;
  readonly sourceRevision?: {
    readonly algorithm?: string;
    readonly contentDigest?: string;
  };
  readonly note?: string;
  readonly links?: readonly string[];
  readonly writableFields?: readonly {
    readonly canonicalKey: string;
    readonly valueType?: string;
    readonly present: boolean;
    readonly value?: string | number | boolean | string[];
    readonly canClear?: boolean;
  }[];
}

interface DeveloperApiContextRevision {
  readonly index?: { readonly ramGeneration?: number };
  readonly settingsFingerprint?: string;
}

interface DeveloperApiTaskQueryResult {
  readonly ok: boolean;
  readonly tasks?: readonly DeveloperApiTask[];
  readonly page?: { readonly nextCursor?: string; readonly truncated?: boolean };
  readonly contextRevision?: DeveloperApiContextRevision;
  readonly error?: DeveloperApiError;
}

interface DeveloperApiTaskGetResult {
  readonly ok: boolean;
  readonly task?: DeveloperApiTask;
  readonly contextRevision?: DeveloperApiContextRevision;
  readonly error?: DeveloperApiError;
}

interface DeveloperApiPlacementResult {
  readonly ok: boolean;
  readonly placement?: {
    readonly mode?: string;
    readonly filePath?: string;
    readonly lines?: readonly {
      readonly locator?: {
        readonly representation?: string;
        readonly filePath?: string;
        readonly lineNumber?: number;
      };
      readonly heading?: string;
      readonly contextLabel?: string;
    }[];
  };
  readonly error?: DeveloperApiError;
  readonly [key: string]: unknown;
}

interface DeveloperApiReadResult {
  readonly ok?: boolean;
  readonly error?: DeveloperApiError;
  readonly [key: string]: unknown;
}

interface DeveloperApiMutationPlan {
  readonly planDigest?: string;
  readonly recoveryRef?: string;
  readonly capability?: string;
  readonly mutationKind?: string;
  readonly predictedEffects?: readonly {
    readonly resourceKind?: string;
    readonly resourceKey?: string;
    readonly action?: string;
    readonly summary?: string;
  }[];
  readonly [key: string]: unknown;
}

interface DeveloperApiMutationPreviewResult {
  readonly ok: boolean;
  readonly plan?: DeveloperApiMutationPlan;
  readonly warnings?: readonly unknown[];
  readonly error?: DeveloperApiError;
}

interface DeveloperApiMutationExecutionResult {
  readonly status?: "applied" | "already-applied" | "partial" | "failed" | "outcome-unknown";
  readonly mutationMayHaveApplied?: boolean;
  readonly retryAllowed?: boolean;
  readonly receipt?: {
    readonly terminalOutcome?: string;
    readonly planDigest?: string;
  };
  readonly recovery?: {
    readonly recoveryRef?: string;
    readonly planDigest?: string;
    readonly plan?: DeveloperApiMutationPlan;
  };
  readonly error?: DeveloperApiError;
}

interface DeveloperApiPendingRecovery {
  readonly recoveryRef?: string;
  readonly planDigest?: string;
  readonly mutationKind?: string;
  readonly capability?: string;
  readonly riskLevel?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

interface DeveloperApiPendingRecoveriesResult {
  readonly ok: boolean;
  readonly recoveries?: readonly DeveloperApiPendingRecovery[];
  readonly error?: DeveloperApiError;
}

interface DeveloperApiHealth {
  readonly ok: boolean;
  readonly lifecyclePhase?: string;
  readonly v8PersistencePhase?: string;
  readonly contextRevision?: DeveloperApiContextRevision;
  readonly error?: DeveloperApiError;
}

interface DeveloperApiField {
  readonly canonicalKey: string;
  readonly displayName: string;
  readonly valueType: string;
  readonly source: string;
  readonly mappingStatus: string;
  readonly readable: boolean;
  readonly mutationClass?: "general-update" | "semantic-capability" | "runtime-owned";
  readonly mutationOwner?: string;
}

interface DeveloperApiCatalog {
  readonly ok: boolean;
  readonly settingsFingerprint?: string;
  readonly taxonomy?: {
    readonly defaultPipeline?: { readonly configuredValue?: string; readonly id?: string };
    readonly defaultPriority?: { readonly configuredValue?: string; readonly id?: string };
    readonly pipelines?: readonly {
      readonly id: string;
      readonly name: string;
      readonly description?: string;
      readonly order?: number;
      readonly statuses?: readonly {
        readonly id: string;
        readonly label: string;
        readonly order?: number;
        readonly isFinished?: boolean;
        readonly isCancelled?: boolean;
        readonly isScheduledTarget?: boolean;
        readonly isTrackingTarget?: boolean;
      }[];
    }[];
    readonly priorities?: readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly order?: number;
      readonly color?: string;
      readonly icon?: string;
      readonly isDefault?: boolean;
    }[];
  };
  readonly fields?: readonly DeveloperApiField[];
  readonly policies?: {
    readonly creation?: {
      readonly defaultEstimateMinutes?: number;
      readonly defaultToFileTask?: boolean;
      readonly fileTaskTargetFolder?: string;
      readonly fileTaskTemplateFolder?: string;
      readonly defaultFileTemplateId?: string;
      readonly inlineTaskSaveMode?: string;
      readonly inlineTaskTargetFile?: string;
      readonly inlineTaskHeading?: string;
      readonly dailyNoteAddsStartDate?: boolean;
      readonly dailyNoteAddsScheduledDate?: boolean;
      readonly fileTaskTemplateCandidates?: readonly {
        readonly id: string;
        readonly name: string;
        readonly kind: string;
        readonly sourcePath?: string;
        readonly pipelineId?: string;
      }[];
    };
    readonly automation?: {
      readonly autoCompleteParentWhenAllChildrenTerminal?: boolean;
      readonly cascadeCancelToDescendants?: boolean;
      readonly fileTaskAutoArchiveEnabled?: boolean;
      readonly fileTaskArchiveFolder?: string;
      readonly fileTaskArchiveDelaySeconds?: number;
      readonly fileTaskArchiveOnlyFromFileTasksFolder?: boolean;
      readonly fileRepeatDestination?: string;
      readonly fileRepeatCustomFolder?: string;
    };
    readonly exclusions?: { readonly folders?: readonly string[] };
  };
  readonly error?: DeveloperApiError;
}

interface DeveloperApiAccessor {
  readonly getDeveloperApiV1: (
    consumerPlugin: DeveloperApiConsumerPlugin,
    request: {
      readonly contractVersion: 1;
      readonly runtimeApi: { readonly min: 1; readonly max: 1 };
      readonly requestedCapabilities: readonly string[];
    },
  ) => DeveloperApiAccessResult;
}

interface DeveloperApiAccessResult {
  readonly ok: boolean;
  readonly status: DeveloperApiChannelStatus;
  readonly api?: DeveloperApiV1;
  readonly error?: DeveloperApiError;
}

interface DeveloperApiV1 {
  readonly sessionId?: string;
  readonly hasCapability: (name: string) => boolean;
  readonly channel: { readonly status: () => DeveloperApiChannelStatus };
  readonly system: {
    readonly health: () => Promise<DeveloperApiHealth>;
    readonly capabilities: () => readonly { readonly id?: string }[];
    readonly diagnostics: () => Promise<DeveloperApiReadResult>;
  };
  readonly catalog: {
    readonly snapshot: (request?: unknown) => Promise<DeveloperApiCatalog>;
  };
  readonly tasks: {
    readonly get?: (request: unknown) => Promise<DeveloperApiTaskGetResult>;
    readonly query: (request: unknown) => Promise<DeveloperApiTaskQueryResult>;
    readonly find?: (request: unknown) => Promise<DeveloperApiReadResult>;
  };
  readonly entities?: {
    readonly resolve: (request: unknown) => Promise<DeveloperApiReadResult>;
  };
  readonly relationships?: {
    readonly get: (request: unknown) => Promise<DeveloperApiReadResult>;
  };
  readonly context?: {
    readonly build: (request: unknown) => Promise<DeveloperApiPlacementResult>;
  };
  readonly timers?: {
    readonly read: (request: unknown) => Promise<DeveloperApiReadResult>;
  };
  readonly mutations?: {
    readonly preview: (input: unknown) => Promise<DeveloperApiMutationPreviewResult>;
    readonly apply: (input: unknown) => Promise<DeveloperApiMutationExecutionResult>;
    readonly recover?: (input: unknown) => Promise<DeveloperApiMutationExecutionResult>;
    readonly pendingRecoveries?: () => Promise<DeveloperApiPendingRecoveriesResult>;
  };
}

export type DeveloperApiMutationCapability =
  | "create"
  | "update"
  | "transition"
  | "convert"
  | "relocate";

export interface DeveloperApiMutationResult {
  readonly ok: boolean;
  readonly operonId: string | null;
  readonly code:
    | "planned"
    | "applied"
    | "already-applied"
    | "not-ready"
    | "not-found"
    | "invalid-input"
    | "conflict"
    | "rejected"
    | "failed"
    | "outcome-unknown";
  readonly message?: string;
  readonly nativeStatus?: string;
  readonly plan?: DeveloperApiMutationPlan;
  readonly planDigest?: string;
  readonly recoveryRef?: string;
  readonly retryable: boolean;
  readonly mutationMayHaveApplied?: boolean;
}

export interface DeveloperApiPendingRecoveryResult {
  readonly ok: boolean;
  readonly recoveries: readonly DeveloperApiPendingRecovery[];
  readonly message?: string;
}

export interface DeveloperApiRuntimeIndexer {
  readonly getAllTasks: () => RuntimeIndexedTask[];
  readonly getTask: (operonId: string) => RuntimeIndexedTask | undefined;
  readonly getGeneration: () => number;
  readonly getIndexV8Diagnostics: () => Promise<RuntimeIndexDiagnostics>;
  taskCount: number;
}

const BASELINE_CAPABILITIES = [
  "system.health",
  "system.capabilities",
] as const;

const READ_CAPABILITIES = [
  ...BASELINE_CAPABILITIES,
  "system.diagnostics",
  "catalog.read",
  "tasks.read",
  "tasks.query",
  "tasks.finder",
  "entities.resolve",
  "relationships.read",
  "context.build",
  "timers.read",
] as const;

export type DeveloperApiReadCapability =
  | "system.diagnostics"
  | "tasks.finder"
  | "entities.resolve"
  | "relationships.read"
  | "context.build"
  | "timers.read";

const MUTATION_CAPABILITIES: Record<
  DeveloperApiMutationCapability,
  readonly [string, string]
> = {
  create: ["tasks.create.preview", "tasks.create.apply"],
  update: ["tasks.update.preview", "tasks.update.apply"],
  transition: ["tasks.transition.preview", "tasks.transition.apply"],
  convert: ["tasks.convert.preview", "tasks.convert.apply"],
  relocate: ["tasks.inline.relocate.preview", "tasks.inline.relocate.apply"],
};

const GENERAL_FIELD_TYPES: Record<string, string> = {
  description: "text",
  priority: "text",
  dateDue: "date",
  dateScheduled: "date",
  dateStarted: "date",
  datetimeStart: "datetime",
  datetimeEnd: "datetime",
  estimate: "number",
  assignees: "list",
  contexts: "list",
  tags: "list",
  taskIcon: "text",
  taskColor: "text",
  note: "text",
  location: "text",
  links: "list",
};

const CREATE_FIELD_TYPES: Record<string, string> = {
  taskIcon: "text",
  taskColor: "text",
  note: "text",
  location: "text",
  dateDue: "date",
  dateScheduled: "date",
  dateStarted: "date",
  datetimeStart: "datetime",
  datetimeEnd: "datetime",
  estimate: "number",
  assignees: "list",
  contexts: "list",
  links: "list",
};

// The official runtime may settle a graph/project-serial mutation after the
// default local REST/MCP request budget. Returning an uncertain outcome with
// the durable recovery reference is safer than holding the HTTP request open
// until the caller times out and then guessing whether to retry.
const DEVELOPER_API_APPLY_TIMEOUT_MS = 120_000;

function requestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `operon-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(`Operon Developer API apply exceeded the ${timeoutMs}ms Bridge budget.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function fieldValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join("; ");
  }
  const scalar = stringValue(value);
  if (scalar !== undefined) return scalar;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function listValue(values: readonly string[] | undefined): string {
  return (values ?? []).filter(Boolean).join("; ");
}

function developerErrorMessage(error: DeveloperApiError | undefined): string {
  return error?.reason ?? error?.message ?? error?.code ?? "Operon Developer API unavailable.";
}

function emptyConfiguration(): OperonSemanticConfiguration {
  return {
    language: "auto",
    workflow: { language: "auto", defaultPipelineName: null, pipelines: [] },
    priorities: { defaultPriority: null, items: [] },
    keys: [],
    creation: {
      fileTasksFolder: "",
      inlineTaskSaveMode: "",
      inlineTaskUseDailyNote: false,
      inlineTaskTargetFile: "",
      inlineTaskHeading: "",
      inlineTaskDailyNoteAddStartDate: false,
      inlineTaskDailyNoteAddScheduledDate: false,
      taskCreatorDefaultToFileTask: false,
      taskCreatorDefaultFileTemplateId: null,
      fileTaskTemplateFolder: "",
      fileTaskParentInlineTargetMode: "",
      fileTaskParentFileTargetMode: "",
      availableFileTaskTemplates: [],
    },
    automation: {
      autoCompleteParentWhenAllChildrenTerminal: false,
      cascadeCancelToDescendants: false,
      fileTaskAutoArchiveEnabled: false,
      fileTaskArchiveFolder: "",
      fileTaskArchiveDelaySeconds: 0,
      fileTaskArchiveOnlyFromFileTasksFolder: false,
      fileRepeatDestination: "",
      fileRepeatCustomFolder: "",
    },
    indexing: { excludedFolders: [], fullReindexOnStartup: false, indexEventDebounceMs: 0 },
    docs: { folder: "", autoUpdateEnabled: false },
    views: { filters: [] },
  };
}

function toRuntimeTask(task: DeveloperApiTask): RuntimeIndexedTask {
  const fieldValues: Record<string, string> = {};
  const writeField = (key: string, value: unknown): void => {
    const normalized = fieldValue(value);
    if (normalized !== undefined && normalized !== "") fieldValues[key] = normalized;
  };

  if (task.workflow) {
    writeField("status", `${task.workflow.pipeline.label}.${task.workflow.status.label}`);
  }
  if (task.priority) writeField("priority", task.priority.id || task.priority.label);
  writeField("dateDue", task.dates?.due);
  writeField("dateScheduled", task.dates?.scheduled);
  writeField("dateStarted", task.dates?.started);
  writeField("dateCompleted", task.dates?.completed);
  writeField("dateCancelled", task.dates?.cancelled);
  writeField("datetimeStart", task.datetimes?.start);
  writeField("datetimeEnd", task.datetimes?.end);
  writeField("datetimeCreated", task.datetimes?.created);
  writeField("datetimeModified", task.datetimes?.modified);

  const relationships = task.relationships;
  writeField("parentTask", relationships?.parentOperonId);
  writeField("blocking", relationships?.blockingOperonIds);
  writeField("blockedBy", relationships?.blockedByOperonIds);
  writeField("related", relationships?.relatedOperonIds);

  for (const [key, value] of Object.entries(task.customFields ?? {})) writeField(key, value);
  for (const field of task.writableFields ?? []) {
    if (field.present) writeField(field.canonicalKey, field.value);
  }

  const tagsValue = task.writableFields?.find((field) => field.canonicalKey === "tags")?.value
    ?? task.customFields?.tags;
  const tags = Array.isArray(tagsValue) ? tagsValue.map(String) : [];
  const locator = task.locator;
  const isInline = task.representation === "inline" && locator.representation === "inline";

  return {
    operonId: task.identity.operonId,
    description: task.description,
    checkbox: task.checkbox,
    fieldValues,
    tags,
    primary: {
      filePath: locator.filePath,
      lineNumber: isInline && Number.isInteger(locator.lineNumber) ? locator.lineNumber ?? 0 : 0,
      format: isInline ? "inline" : "yaml",
    },
    datetimeModified: task.datetimes?.modified ?? "",
    tier: "warm",
  };
}

function catalogConfiguration(catalog: DeveloperApiCatalog): {
  pipelines: RuntimePipeline[];
  keyMappings: RuntimeKeyMapping[];
  priorities: RuntimePriorityDefinition[];
  configuration: OperonSemanticConfiguration;
} {
  const taxonomy = catalog.taxonomy ?? {};
  const pipelines: RuntimePipeline[] = (taxonomy.pipelines ?? []).map((pipeline) => ({
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    statuses: (pipeline.statuses ?? []).map((status) => ({
      id: status.id,
      label: status.label,
      isFinished: status.isFinished,
      isCancelled: status.isCancelled,
      isScheduledTarget: status.isScheduledTarget,
      isTrackingTarget: status.isTrackingTarget,
    })),
  }));
  const keyMappings: RuntimeKeyMapping[] = (catalog.fields ?? []).map((field) => ({
    canonicalKey: field.canonicalKey,
    visiblePropertyName: field.displayName,
    type: field.valueType,
    enabled: field.readable,
    isSystem: field.source === "built-in",
    isInternal: field.mappingStatus === "reserved",
    source: field.source === "custom" ? "custom" : "built-in",
    mappingStatus:
      field.mappingStatus === "unmapped" ||
      field.mappingStatus === "collision" ||
      field.mappingStatus === "reserved"
        ? field.mappingStatus
        : "mapped",
    mutationClass: field.mutationClass,
    mutationOwner: field.mutationOwner,
  }));
  const priorities: RuntimePriorityDefinition[] = (taxonomy.priorities ?? []).map((priority) => ({
    id: priority.id,
    label: priority.label,
    color: priority.color,
    description: priority.description,
  }));
  const defaultPipeline = taxonomy.defaultPipeline;
  const defaultPipelineName = pipelines.find((pipeline) => pipeline.id === defaultPipeline?.id)?.name
    ?? defaultPipeline?.configuredValue
    ?? null;
  const defaultPriority = taxonomy.defaultPriority?.id ?? taxonomy.defaultPriority?.configuredValue ?? null;
  const creation = catalog.policies?.creation;
  const automation = catalog.policies?.automation;
  const configuration = emptyConfiguration();
  configuration.workflow = {
    language: configuration.language,
    defaultPipelineName,
    pipelines: pipelines.map((pipeline) => ({
      id: pipeline.id ?? null,
      name: pipeline.name,
      description: pipeline.description ?? null,
      statuses: pipeline.statuses.map((status) => ({
        id: status.id ?? null,
        label: status.label,
        value: `${pipeline.name}.${status.label}`,
        isFinished: status.isFinished === true,
        isCancelled: status.isCancelled === true,
        isScheduledTarget: status.isScheduledTarget === true,
        isTrackingTarget: status.isTrackingTarget === true,
      })),
    })),
  };
  configuration.priorities = {
    defaultPriority,
    items: priorities.map((priority) => ({
      id: priority.id ?? null,
      label: String(priority.label ?? ""),
      color: priority.color ?? null,
      description: priority.description ?? null,
    })),
  };
  configuration.keys = keyMappings.map((mapping) => ({
    canonicalKey: mapping.canonicalKey,
    visiblePropertyName: mapping.visiblePropertyName,
    type: mapping.type ?? null,
    sync: mapping.sync ?? null,
    enabled: mapping.enabled !== false,
    isSystem: mapping.isSystem === true,
    isInternal: mapping.isInternal === true,
  }));
  configuration.creation = {
    ...configuration.creation,
    fileTasksFolder: creation?.fileTaskTargetFolder ?? "",
    inlineTaskSaveMode: creation?.inlineTaskSaveMode ?? "",
    inlineTaskUseDailyNote: creation?.inlineTaskSaveMode === "daily-notes",
    inlineTaskTargetFile: creation?.inlineTaskTargetFile ?? "",
    inlineTaskHeading: creation?.inlineTaskHeading ?? "",
    inlineTaskDailyNoteAddStartDate: creation?.dailyNoteAddsStartDate === true,
    inlineTaskDailyNoteAddScheduledDate: creation?.dailyNoteAddsScheduledDate === true,
    taskCreatorDefaultToFileTask: creation?.defaultToFileTask === true,
    taskCreatorDefaultFileTemplateId: creation?.defaultFileTemplateId ?? null,
    fileTaskTemplateFolder: creation?.fileTaskTemplateFolder ?? "",
    availableFileTaskTemplates: (creation?.fileTaskTemplateCandidates ?? []).map((template) => ({
      id: template.id,
      name: template.name,
      path: template.sourcePath ?? null,
      kind: template.kind,
      pipelineId: template.pipelineId ?? null,
      description: null,
    })),
  };
  configuration.automation = {
    ...configuration.automation,
    autoCompleteParentWhenAllChildrenTerminal: automation?.autoCompleteParentWhenAllChildrenTerminal === true,
    cascadeCancelToDescendants: automation?.cascadeCancelToDescendants === true,
    fileTaskAutoArchiveEnabled: automation?.fileTaskAutoArchiveEnabled === true,
    fileTaskArchiveFolder: automation?.fileTaskArchiveFolder ?? "",
    fileTaskArchiveDelaySeconds: automation?.fileTaskArchiveDelaySeconds ?? 0,
    fileTaskArchiveOnlyFromFileTasksFolder: automation?.fileTaskArchiveOnlyFromFileTasksFolder === true,
    fileRepeatDestination: automation?.fileRepeatDestination ?? "",
    fileRepeatCustomFolder: automation?.fileRepeatCustomFolder ?? "",
  };
  configuration.indexing = {
    ...configuration.indexing,
    excludedFolders: [...(catalog.policies?.exclusions?.folders ?? [])],
  };
  return { pipelines, keyMappings, priorities, configuration };
}

function isDeveloperApiAccessor(value: unknown): value is DeveloperApiAccessor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly getDeveloperApiV1?: unknown };
  return typeof candidate.getDeveloperApiV1 === "function";
}

export class OperonDeveloperApiRuntimeAdapter {
  readonly indexer: DeveloperApiRuntimeIndexer = {
    getAllTasks: () => this.tasks,
    getTask: (operonId: string) => this.tasks.find((task) => task.operonId === operonId),
    getGeneration: () => this.generation,
    getIndexV8Diagnostics: async () => this.getDiagnostics(),
    taskCount: 0,
  };
  readonly pipelines: RuntimePipeline[] = [];
  readonly keyMappings: RuntimeKeyMapping[] = [];
  readonly priorities: RuntimePriorityDefinition[] = [];
  language = "auto";
  defaultPipelineName: string | null = null;

  private readonly accessor: DeveloperApiAccessor | null;
  private tasks: RuntimeIndexedTask[] = [];
  private rawTasks: DeveloperApiTask[] = [];
  private generation = 0;
  private diagnostics: RuntimeIndexDiagnostics = {
    health: "unavailable",
    runtimePhase: "unavailable",
    verifiedThisSession: false,
    taskCount: 0,
    dirtySourceCount: 1,
  };
  private configuration: OperonSemanticConfiguration = emptyConfiguration();
  private channelStatus: DeveloperApiChannelStatus = {};
  private readApi: DeveloperApiV1 | null = null;
  private mutationApi: DeveloperApiV1 | null = null;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(
    private readonly consumerPlugin: DeveloperApiConsumerPlugin,
    operonPlugin: unknown,
  ) {
    this.accessor = isDeveloperApiAccessor(operonPlugin) ? operonPlugin : null;
  }

  get semanticConfiguration(): OperonSemanticConfiguration {
    return this.configuration;
  }

  get status(): DeveloperApiChannelStatus {
    return this.channelStatus;
  }

  async refresh(includeMutationCapabilities = false): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshInternal(includeMutationCapabilities).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshInternal(includeMutationCapabilities: boolean): Promise<boolean> {
    const api = this.connect(READ_CAPABILITIES);
    if (!api) {
      this.readApi = null;
      this.mutationApi = null;
      this.setUnavailableDiagnostics();
      return false;
    }
    try {
      const health = await api.system.health();
      if (!health.ok) {
        this.channelStatus = health.error ? { error: health.error } : this.channelStatus;
        this.setUnavailableDiagnostics();
        return false;
      }
      const catalog = await api.catalog.snapshot({
        contractVersion: 1,
        requestId: requestId(),
        kind: "catalog",
        consistency: "live-verified",
      });
      if (!catalog.ok) throw new Error(developerErrorMessage(catalog.error));
      const snapshot = catalogConfiguration(catalog);
      const tasks = await this.readAllTasks(api);
      this.tasks = tasks.tasks;
      this.rawTasks = tasks.rawTasks;
      this.indexer.taskCount = this.tasks.length;
      this.generation = tasks.generation
        ?? health.contextRevision?.index?.ramGeneration
        ?? this.generation + 1;
      this.pipelines.splice(0, this.pipelines.length, ...snapshot.pipelines);
      this.keyMappings.splice(0, this.keyMappings.length, ...snapshot.keyMappings);
      this.priorities.splice(0, this.priorities.length, ...snapshot.priorities);
      this.configuration = snapshot.configuration;
      this.defaultPipelineName = snapshot.configuration.workflow.defaultPipelineName;
      this.diagnostics = {
        health: "healthy",
        runtimePhase: "idle",
        verifiedThisSession: true,
        taskCount: this.tasks.length,
        dirtySourceCount: 0,
      };
      this.readApi = api;
      this.mutationApi = includeMutationCapabilities
        ? this.connectMutationApi()
        : null;
      return true;
    } catch (error) {
      this.readApi = null;
      this.diagnostics = {
        health: "degraded",
        runtimePhase: "developer-api-error",
        verifiedThisSession: false,
        taskCount: this.tasks.length,
        dirtySourceCount: 1,
      };
      this.channelStatus = {
        ...this.channelStatus,
        error: { reason: error instanceof Error ? error.message : String(error) },
      };
      return false;
    }
  }

  hasMutationCapability(capability: DeveloperApiMutationCapability): boolean {
    const api = this.mutationApi;
    if (!api?.mutations?.preview || !api.mutations.apply) return false;
    const [preview, apply] = MUTATION_CAPABILITIES[capability];
    return api.hasCapability(preview) && api.hasCapability(apply);
  }

  hasReadCapability(capability: DeveloperApiReadCapability): boolean {
    return Boolean(this.readApi?.hasCapability(capability));
  }

  private requireReadApi(capability: DeveloperApiReadCapability): DeveloperApiV1 {
    const api = this.readApi;
    if (!api || !api.hasCapability(capability)) {
      throw new Error(`Operon Developer API V1 read grant is unavailable: ${capability}.`);
    }
    return api;
  }

  async readDiagnostics(): Promise<DeveloperApiReadResult> {
    return this.requireReadApi("system.diagnostics").system.diagnostics();
  }

  async findTasks(request: Record<string, unknown>): Promise<DeveloperApiReadResult> {
    const api = this.requireReadApi("tasks.finder");
    if (!api.tasks.find) throw new Error("Operon tasks.finder is unavailable.");
    return api.tasks.find({
      contractVersion: 1,
      requestId: requestId(),
      kind: "task-finder",
      consistency: "live-verified",
      ...request,
    });
  }

  async resolveEntity(request: Record<string, unknown>): Promise<DeveloperApiReadResult> {
    const api = this.requireReadApi("entities.resolve");
    if (!api.entities?.resolve) throw new Error("Operon entities.resolve is unavailable.");
    return api.entities.resolve({
      contractVersion: 1,
      requestId: requestId(),
      kind: "entity-resolve",
      consistency: "live-verified",
      ...request,
    });
  }

  async readRelationships(request: Record<string, unknown>): Promise<DeveloperApiReadResult> {
    const api = this.requireReadApi("relationships.read");
    if (!api.relationships?.get) throw new Error("Operon relationships.read is unavailable.");
    return api.relationships.get({
      contractVersion: 1,
      requestId: requestId(),
      kind: "relationship",
      consistency: "live-verified",
      ...request,
    });
  }

  async buildContext(request: Record<string, unknown>): Promise<DeveloperApiPlacementResult> {
    const api = this.requireReadApi("context.build");
    if (!api.context?.build) throw new Error("Operon context.build is unavailable.");
    return api.context.build({
      contractVersion: 1,
      requestId: requestId(),
      kind: "context",
      consistency: "live-verified",
      ...request,
    });
  }

  async readTimers(): Promise<DeveloperApiReadResult> {
    const api = this.requireReadApi("timers.read");
    if (!api.timers?.read) throw new Error("Operon timers.read is unavailable.");
    return api.timers.read({
      contractVersion: 1,
      requestId: requestId(),
      kind: "timer-read",
      consistency: "live-verified",
    });
  }

  hasRecoverySupport(): boolean {
    const mutations = this.mutationApi?.mutations;
    return Boolean(
      mutations?.recover && mutations.pendingRecoveries,
    );
  }

  private connectMutationApi(): DeveloperApiV1 | null {
    const requested = [
      ...READ_CAPABILITIES,
      ...Object.values(MUTATION_CAPABILITIES).flat(),
    ];
    const api = this.connect(requested);
    if (!api?.mutations?.preview || !api.mutations.apply) return null;
    return api;
  }

  private connect(requestedCapabilities: readonly string[]): DeveloperApiV1 | null {
    if (!this.accessor) return null;
    const access = this.accessor.getDeveloperApiV1(this.consumerPlugin, {
      contractVersion: 1,
      runtimeApi: { min: 1, max: 1 },
      requestedCapabilities,
    });
    this.channelStatus = access.status;
    if (!access.ok || !access.api) {
      return null;
    }
    return access.api;
  }

  private async readAllTasks(api: DeveloperApiV1): Promise<{
    tasks: RuntimeIndexedTask[];
    rawTasks: DeveloperApiTask[];
    generation: number | null;
  }> {
    const tasks: RuntimeIndexedTask[] = [];
    const rawTasks: DeveloperApiTask[] = [];
    let cursor: string | undefined;
    let generation: number | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const result = await api.tasks.query({
        contractVersion: 1,
        requestId: requestId(),
        kind: "task-query",
        consistency: "live-verified",
        include: ["custom-fields"],
        limit: 250,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) throw new Error(developerErrorMessage(result.error));
      for (const task of result.tasks ?? []) {
        const hydrated = api.tasks.get
          ? await this.getExactTask(api, task.identity.operonId)
          : task;
        if (!hydrated) {
          throw new Error(`Task disappeared during the live read: ${task.identity.operonId}.`);
        }
        rawTasks.push(hydrated);
        tasks.push(toRuntimeTask(hydrated));
      }
      const candidateGeneration = result.contextRevision?.index?.ramGeneration;
      if (Number.isInteger(candidateGeneration)) generation = candidateGeneration ?? null;
      const nextCursor = result.page?.nextCursor;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return { tasks, rawTasks, generation };
  }

  async executeMutation(
    capability: DeveloperApiMutationCapability,
    operonId: string | null,
    requested: Record<string, unknown>,
    dryRun: boolean,
  ): Promise<DeveloperApiMutationResult> {
    const api = this.mutationApi;
    const mutations = api?.mutations;
    if (!api || !mutations?.preview || !mutations.apply || !this.hasMutationCapability(capability)) {
      return this.mutationFailure(
        "not-ready",
        `Operon Developer API V1 mutation grant is unavailable: ${capability}.`,
        operonId,
        true,
      );
    }

    let task: DeveloperApiTask | null = null;
    if (capability !== "create") {
      if (!operonId) {
        return this.mutationFailure("invalid-input", "An operonId is required for this mutation.", null, false);
      }
      try {
        task = await this.getExactTask(api, operonId);
      } catch (error) {
        return this.mutationFailure(
          "failed",
          error instanceof Error ? error.message : String(error),
          operonId,
          false,
        );
      }
      if (!task) return this.mutationFailure("not-found", `Operon task not found: ${operonId}.`, operonId, false);
    }

    let mapped: {
      capability: string;
      mutationKind: string;
      target?: Record<string, unknown>;
      spec: Record<string, unknown>;
      targetPath?: string;
      representation?: "inline" | "file";
    };
    try {
      mapped = await this.mapMutationInput(api, capability, task, requested);
    } catch (error) {
      return this.mutationFailure(
        "invalid-input",
        error instanceof Error ? error.message : String(error),
        operonId,
        false,
      );
    }

    const previewInput = {
      capability: mapped.capability,
      mutationKind: mapped.mutationKind,
      ...(mapped.target ? { target: mapped.target } : {}),
      spec: mapped.spec,
    };
    let preview: DeveloperApiMutationPreviewResult;
    try {
      preview = await mutations.preview(previewInput);
    } catch (error) {
      return this.mutationFailure(
        "failed",
        error instanceof Error ? error.message : String(error),
        operonId,
        false,
      );
    }
    if (!preview.ok || !preview.plan) {
      return this.mutationFailure(
        this.mapNativeErrorCode(preview.error) === "conflict"
          ? "conflict"
          : this.mapNativeErrorCode(preview.error),
        developerErrorMessage(preview.error),
        operonId,
        false,
      );
    }
    if (dryRun) {
      return {
        ok: true,
        operonId,
        code: "planned",
        nativeStatus: "planned",
        plan: preview.plan,
        planDigest: preview.plan.planDigest,
        retryable: false,
      };
    }

    let execution: DeveloperApiMutationExecutionResult;
    try {
      execution = await withTimeout(
        mutations.apply({ plan: preview.plan }),
        DEVELOPER_API_APPLY_TIMEOUT_MS,
      );
    } catch (error) {
      return this.mutationFailure(
        "outcome-unknown",
        `Operon Developer API apply did not return a terminal result: ${error instanceof Error ? error.message : String(error)}`,
        operonId,
        false,
        {
          nativeStatus: "timeout-or-transport-error",
          recoveryRef: preview.plan.recoveryRef,
          planDigest: preview.plan.planDigest,
          mutationMayHaveApplied: true,
        },
      );
    }

    const status = execution.status ?? "failed";
    if (status === "partial" || status === "outcome-unknown") {
      return this.mutationFailure(
        "outcome-unknown",
        developerErrorMessage(execution.error) || "Operon requires recovery of the same mutation plan.",
        operonId,
        false,
        {
          nativeStatus: status,
          recoveryRef: execution.recovery?.recoveryRef ?? preview.plan.recoveryRef,
          planDigest: execution.recovery?.planDigest ?? preview.plan.planDigest,
          mutationMayHaveApplied: true,
        },
      );
    }
    if (status === "failed") {
      return this.mutationFailure(
        this.mapNativeErrorCode(execution.error),
        developerErrorMessage(execution.error) || "Operon rejected the mutation.",
        operonId,
        false,
        { nativeStatus: status },
      );
    }

    let appliedOperonId = operonId;
    if (capability === "create") {
      try {
        appliedOperonId = await this.identifyCreatedTask(
          api,
          new Set(this.rawTasks.map((item) => item.identity.operonId)),
          requested,
          mapped,
        );
      } catch (error) {
        return this.mutationFailure(
          "failed",
          `Operon applied the create plan, but the created task could not be identified safely: ${error instanceof Error ? error.message : String(error)}`,
          null,
          false,
          { nativeStatus: status, mutationMayHaveApplied: true },
        );
      }
      if (!appliedOperonId) {
        return this.mutationFailure(
          "failed",
          "Operon applied the create plan, but no unique created task was observable.",
          null,
          false,
          { nativeStatus: status, mutationMayHaveApplied: true },
        );
      }
    }
    return {
      ok: true,
      operonId: appliedOperonId,
      code: status === "already-applied" ? "already-applied" : "applied",
      nativeStatus: status,
      planDigest: execution.receipt?.planDigest ?? preview.plan.planDigest,
      recoveryRef: preview.plan.recoveryRef,
      retryable: false,
      mutationMayHaveApplied: execution.mutationMayHaveApplied ?? true,
    };
  }

  async pendingRecoveries(): Promise<DeveloperApiPendingRecoveryResult> {
    const api = this.mutationApi;
    const pending = api?.mutations?.pendingRecoveries;
    if (!api || !pending) {
      return {
        ok: false,
        recoveries: [],
        message: "Operon Developer API V1 pending-recovery support is unavailable.",
      };
    }
    try {
      const result = await pending();
      return {
        ok: result.ok,
        recoveries: result.recoveries ?? [],
        ...(result.ok ? {} : { message: developerErrorMessage(result.error) }),
      };
    } catch (error) {
      return {
        ok: false,
        recoveries: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async recoverMutation(recoveryRef: string): Promise<DeveloperApiMutationResult> {
    const api = this.mutationApi;
    const recover = api?.mutations?.recover;
    if (!api || !recover) {
      return this.mutationFailure(
        "not-ready",
        "Operon Developer API V1 recovery support is unavailable.",
        null,
        true,
        { recoveryRef, mutationMayHaveApplied: true },
      );
    }
    const normalizedRecoveryRef = recoveryRef.trim();
    if (!normalizedRecoveryRef) {
      return this.mutationFailure(
        "invalid-input",
        "recoveryRef is required.",
        null,
        false,
      );
    }
    let execution: DeveloperApiMutationExecutionResult;
    try {
      execution = await recover({ recoveryRef: normalizedRecoveryRef });
    } catch (error) {
      return this.mutationFailure(
        "outcome-unknown",
        `Operon recovery did not return a terminal result: ${error instanceof Error ? error.message : String(error)}`,
        null,
        false,
        { recoveryRef: normalizedRecoveryRef, mutationMayHaveApplied: true },
      );
    }
    const status = execution.status ?? "failed";
    if (status === "applied" || status === "already-applied") {
      return {
        ok: true,
        operonId: null,
        code: status,
        nativeStatus: status,
        planDigest: execution.receipt?.planDigest ?? execution.recovery?.planDigest,
        recoveryRef:
          execution.recovery?.recoveryRef ?? normalizedRecoveryRef,
        retryable: false,
        mutationMayHaveApplied: execution.mutationMayHaveApplied ?? true,
      };
    }
    if (status === "partial" || status === "outcome-unknown") {
      return this.mutationFailure(
        "outcome-unknown",
        developerErrorMessage(execution.error) || "Operon still requires recovery of the same mutation plan.",
        null,
        false,
        {
          nativeStatus: status,
          recoveryRef:
            execution.recovery?.recoveryRef ?? normalizedRecoveryRef,
          planDigest: execution.recovery?.planDigest,
          mutationMayHaveApplied: true,
        },
      );
    }
    return this.mutationFailure(
      this.mapNativeErrorCode(execution.error),
      developerErrorMessage(execution.error) || "Operon rejected the recovery.",
      null,
      false,
      { nativeStatus: status, recoveryRef: normalizedRecoveryRef },
    );
  }

  private mutationFailure(
    code: DeveloperApiMutationResult["code"],
    message: string,
    operonId: string | null,
    retryable: boolean,
    extra: Partial<DeveloperApiMutationResult> = {},
  ): DeveloperApiMutationResult {
    return {
      ok: false,
      operonId,
      code,
      message,
      retryable,
      ...extra,
    };
  }

  private mapNativeErrorCode(error: DeveloperApiError | undefined): DeveloperApiMutationResult["code"] {
    const code = String(error?.code ?? "").toLocaleLowerCase();
    if (code.includes("conflict") || code.includes("revision")) return "conflict";
    if (code.includes("not-found") || code.includes("missing")) return "not-found";
    if (code.includes("invalid") || code.includes("validation")) return "invalid-input";
    if (code.includes("authority") || code.includes("grant") || code.includes("capability")) return "not-ready";
    return "rejected";
  }

  private async getExactTask(api: DeveloperApiV1, operonId: string): Promise<DeveloperApiTask | null> {
    if (!api.tasks.get) {
      return this.rawTasks.find((task) => task.identity.operonId === operonId) ?? null;
    }
    const result = await api.tasks.get({
      contractVersion: 1,
      requestId: requestId(),
      kind: "task-get",
      consistency: "live-verified",
      selector: { kind: "operon-id", operonId },
      include: ["notes", "links", "custom-fields", "source-markdown", "writable-fields"],
    });
    if (!result.ok) {
      if (this.mapNativeErrorCode(result.error) === "not-found") return null;
      throw new Error(developerErrorMessage(result.error));
    }
    return result.task ?? null;
  }

  private exactTarget(task: DeveloperApiTask): Record<string, unknown> {
    if (task.representation === "inline" && task.locator.representation === "inline") {
      if (!Number.isInteger(task.locator.lineNumber)) {
        throw new Error("The live task has no exact inline line locator.");
      }
      return {
        operonId: task.identity.operonId,
        locator: {
          representation: "inline",
          filePath: task.locator.filePath,
          lineNumber: task.locator.lineNumber,
        },
      };
    }
    return {
      operonId: task.identity.operonId,
      locator: { representation: "file", filePath: task.locator.filePath },
    };
  }

  private canonicalField(field: string): string {
    const mapping = this.keyMappings.find(
      (candidate) => candidate.canonicalKey === field || candidate.visiblePropertyName === field,
    );
    return mapping?.canonicalKey ?? field;
  }

  private fieldType(field: string): string | null {
    const canonical = this.canonicalField(field);
    const mapping = this.keyMappings.find((candidate) => candidate.canonicalKey === canonical);
    if (mapping?.mappingStatus && mapping.mappingStatus !== "mapped") return null;
    if (mapping?.mutationClass && mapping.mutationClass !== "general-update") return null;
    const candidate = String(mapping?.type ?? GENERAL_FIELD_TYPES[canonical] ?? "").toLocaleLowerCase();
    return ["text", "date", "datetime", "number", "list", "checkbox"].includes(candidate)
      ? candidate
      : null;
  }

  private isCustomGeneralField(field: string): boolean {
    const canonical = this.canonicalField(field);
    const mapping = this.keyMappings.find((candidate) => candidate.canonicalKey === canonical);
    return mapping?.source === "custom"
      && mapping.mappingStatus === "mapped"
      && mapping.mutationClass === "general-update";
  }

  private updateValue(field: string, value: unknown): Record<string, unknown> {
    const canonical = this.canonicalField(field);
    const valueType = this.fieldType(canonical);
    if (!valueType) throw new Error(`Managed field '${field}' is not writable through the official Developer API.`);
    if (value === null || value === undefined || value === "") {
      return { operation: "clear", field: canonical, valueType };
    }
    if (valueType === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`Field '${field}' requires a finite number.`);
      return { field: canonical, valueType, value: parsed };
    }
    if (valueType === "list") {
      const values = Array.isArray(value)
        ? value.map(String).map((item) => item.trim()).filter(Boolean)
        : String(value).split(/[;,]/u).map((item) => item.trim()).filter(Boolean);
      return { field: canonical, valueType, value: values };
    }
    if (valueType === "checkbox") {
      const normalized = String(value).toLocaleLowerCase();
      if (!["true", "false", "1", "0", "yes", "no", "on", "off"].includes(normalized)) {
        throw new Error(`Field '${field}' requires a boolean value.`);
      }
      return { field: canonical, valueType, value: ["true", "1", "yes", "on"].includes(normalized) };
    }
    return { field: canonical, valueType, value: String(value) };
  }

  private resolveStatusId(value: unknown): string | null {
    const normalized = String(value ?? "").trim();
    if (!normalized) return null;
    const matches = this.pipelines.flatMap((pipeline) =>
      pipeline.statuses
        .filter(
          (status) =>
            status.id === normalized ||
            status.label === normalized ||
            `${pipeline.name}.${status.label}` === normalized,
        )
        .map((status) => status.id),
    );
    const unique = [...new Set(matches.filter(Boolean))];
    return unique.length === 1 ? unique[0] ?? null : null;
  }

  private resolvePriorityId(value: unknown): string | null {
    return resolvePriorityStableId(value, this.priorities);
  }

  private async mapMutationInput(
    api: DeveloperApiV1,
    capability: DeveloperApiMutationCapability,
    task: DeveloperApiTask | null,
    requested: Record<string, unknown>,
  ): Promise<{
    capability: string;
    mutationKind: string;
    target?: Record<string, unknown>;
    spec: Record<string, unknown>;
    targetPath?: string;
    representation?: "inline" | "file";
  }> {
    if (capability === "create") return this.mapCreateInput(requested);
    if (!task) throw new Error("A live task is required for this mutation.");
    const target = this.exactTarget(task);
    if (capability === "update") {
      if (requested.properties && typeof requested.properties === "object") {
        throw new Error("Unmanaged properties are not exposed by Operon Developer API V1; no raw Markdown fallback is used.");
      }
      const changes: Record<string, unknown>[] = [];
      if (Object.prototype.hasOwnProperty.call(requested, "description")) {
        changes.push(this.updateValue("description", requested.description));
      }
      if (Array.isArray(requested.tags)) changes.push(this.updateValue("tags", requested.tags));
      const fields = requested.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
          if (field === "status") throw new Error("Use the transition route for status changes.");
          const canonical = this.canonicalField(field);
          if (canonical === "priority") {
            const priorityId = this.resolvePriorityId(value);
            if (!priorityId) throw new Error("fields.priority must resolve to one stable Operon priority id.");
            changes.push(this.updateValue(canonical, priorityId));
          } else {
            changes.push(this.updateValue(canonical, value));
          }
        }
      }
      if (changes.length === 0) throw new Error("The update contains no official writable field.");
      return {
        capability: "tasks.update.preview",
        mutationKind: "task.update",
        target,
        spec: { operation: "update", changes },
      };
    }
    if (capability === "transition") {
      const statusId = String(requested.statusId ?? "").trim() || this.resolveStatusId(requested.status);
      if (!statusId) throw new Error("status or statusId must resolve to one stable Operon status id.");
      return {
        capability: "tasks.transition.preview",
        mutationKind: "task.transition",
        target,
        spec: {
          operation: "transition",
          targetStatusId: statusId,
          ...(task.workflow?.status.id ? { expectedStatusId: task.workflow.status.id } : {}),
        },
      };
    }
    if (capability === "convert") {
      const targetRepresentation = requested.target;
      if (targetRepresentation !== "inline" && targetRepresentation !== "file") {
        throw new Error("target must be either inline or file.");
      }
      if (requested.targetFolder) {
        throw new Error("targetFolder is not supported by the official Developer API V1 conversion surface; use a configured target or an exact targetPath where supported.");
      }
      if (targetRepresentation === "file") {
        if (task.representation !== "inline") throw new Error("The live task is not an inline task.");
        const templateId = String(
          requested.fileTemplateId ?? this.configuration.creation.taskCreatorDefaultFileTemplateId ?? "",
        ).trim();
        if (!templateId) throw new Error("fileTemplateId or an Operon default file template is required for inline-to-file conversion.");
        return {
          capability: "tasks.convert.preview",
          mutationKind: "task.convert",
          target,
          representation: "file",
          spec: { operation: "convert", from: "inline", to: "file", templateId },
        };
      }
      if (task.representation !== "file") throw new Error("The live task is not a file task.");
      const targetPath = String(requested.targetPath ?? "").trim();
      if (!targetPath) throw new Error("targetPath is required for file-to-inline conversion.");
      return {
        capability: "tasks.convert.preview",
        mutationKind: "task.convert",
        target,
        targetPath,
        representation: "inline",
        spec: {
          operation: "convert",
          from: "file",
          to: "inline",
          target: { mode: "configured-target", filePath: targetPath },
        },
      };
    }
    if (task.representation !== "inline" || task.locator.representation !== "inline") {
      throw new Error("Only inline tasks can be relocated by the official Developer API V1.");
    }
    const targetPath = String(requested.targetPath ?? "").trim();
    if (!targetPath) throw new Error("targetPath is required for relocation.");
    if (!api.context?.build) throw new Error("Operon context.build is unavailable; no destination line can be guessed safely.");
    const context = await api.context.build({
      contractVersion: 1,
      requestId: requestId(),
      kind: "context",
      consistency: "live-verified",
      purpose: "mutation-readiness",
      projection: "placement-candidates",
      placement: { mode: "lines", filePath: targetPath },
      limit: 20,
    });
    const candidate = context.ok
      ? context.placement?.mode === "lines"
        ? context.placement.lines?.find(
            (line) =>
              line.locator?.representation === "inline" &&
              line.locator.filePath === targetPath &&
              Number.isInteger(line.locator.lineNumber),
          )
        : undefined
      : undefined;
    if (!candidate?.locator || !Number.isInteger(candidate.locator.lineNumber)) {
      throw new Error(
        context.ok
          ? `No blank inline placement candidate is available in '${targetPath}'.`
          : developerErrorMessage(context.error),
      );
    }
    return {
      capability: "tasks.inline.relocate.preview",
      mutationKind: "task.inline-relocate",
      target,
      targetPath,
      representation: "inline",
      spec: {
        operation: "relocate-inline",
        destination: {
          locator: {
            representation: "inline",
            filePath: targetPath,
            lineNumber: candidate.locator.lineNumber,
          },
          mustBeBlank: true,
        },
      },
    };
  }

  private mapCreateInput(requested: Record<string, unknown>): {
    capability: string;
    mutationKind: string;
    spec: Record<string, unknown>;
    targetPath?: string;
    representation?: "inline" | "file";
  } {
    const source = requested.source;
    if (source !== "inline" && source !== "file") throw new Error("source must be either inline or file.");
    if (requested.properties && typeof requested.properties === "object") {
      throw new Error("Unmanaged properties are not exposed by Operon Developer API V1; no raw Markdown fallback is used.");
    }
    if (requested.targetFolder) {
      throw new Error("targetFolder is not supported by the official Developer API V1 create surface; use an exact configured target instead.");
    }
    const description = String(requested.description ?? "").trim();
    if (!description) throw new Error("description is required.");
    const targetPath = typeof requested.targetPath === "string" ? requested.targetPath.trim() : "";
    const target: Record<string, unknown> = source === "inline"
      ? targetPath
        ? { representation: "inline", mode: "exact-path", filePath: targetPath }
        : { representation: "inline", mode: "configured-default" }
      : {
          representation: "file",
          mode: "configured-default",
          ...(requested.fileTemplateId ? { templateId: String(requested.fileTemplateId) } : {}),
        };
    const fields: Record<string, unknown>[] = [];
    const rawFields = requested.fields;
    let statusId = String(requested.statusId ?? "").trim() || null;
    let priorityId: string | null = null;
    let parent: Record<string, unknown> | undefined;
    const related: Record<string, unknown>[] = [];
    const dependencies: Record<string, unknown>[] = [];
    if (rawFields && typeof rawFields === "object" && !Array.isArray(rawFields)) {
      for (const [field, value] of Object.entries(rawFields as Record<string, unknown>)) {
        if (field === "status") {
          const resolved = this.resolveStatusId(value);
          if (!resolved) throw new Error("fields.status must resolve to one stable Operon status id.");
          statusId = resolved;
          continue;
        }
        if (field === "priority") {
          priorityId = this.resolvePriorityId(value);
          if (!priorityId) throw new Error("fields.priority must resolve to one stable Operon priority id.");
          continue;
        }
        if (field === "parentTask") {
          const parentId = String(value ?? "").trim();
          if (parentId) parent = { kind: "existing", operonId: parentId };
          continue;
        }
        if (field === "related") {
          for (const relatedId of this.listInput(value)) related.push({ kind: "existing", operonId: relatedId });
          continue;
        }
        if (field === "blockedBy" || field === "blocking") {
          for (const dependencyId of this.listInput(value)) {
            dependencies.push({
              relation: field === "blockedBy" ? "blocked-by" : "blocks",
              target: { kind: "existing", operonId: dependencyId },
            });
          }
          continue;
        }
        const canonical = this.canonicalField(field);
        const valueType = CREATE_FIELD_TYPES[canonical] ?? this.fieldType(canonical);
        if (!valueType) throw new Error(`Create field '${field}' is not supported by the official Developer API.`);
        fields.push(this.createField(canonical, value, valueType, this.isCustomGeneralField(canonical)));
      }
    }
    if (typeof requested.targetDateKey === "string" && requested.targetDateKey.trim()) {
      fields.push({ kind: "date", field: "dateDue", value: requested.targetDateKey.trim() });
    }
    if (Array.isArray(requested.tags)) {
      const tags = requested.tags.map(String).map((tag) => tag.replace(/^#/u, "").trim()).filter(Boolean);
      return {
        capability: "tasks.create.preview",
        mutationKind: "task.create",
        representation: source,
        targetPath,
        spec: {
          operation: "create",
          items: [{
            itemRef: `bridge-${requestId()}`,
            description,
            target,
            fields,
            tags,
            ...(statusId ? { statusId } : {}),
            ...(priorityId ? { priorityId } : {}),
            ...(parent ? { parent } : {}),
            ...(related.length ? { related } : {}),
            ...(dependencies.length ? { dependencies } : {}),
          }],
        },
      };
    }
    return {
      capability: "tasks.create.preview",
      mutationKind: "task.create",
      representation: source,
      targetPath,
      spec: {
        operation: "create",
        items: [{
          itemRef: `bridge-${requestId()}`,
          description,
          target,
          fields,
          ...(statusId ? { statusId } : {}),
          ...(priorityId ? { priorityId } : {}),
          ...(parent ? { parent } : {}),
          ...(related.length ? { related } : {}),
          ...(dependencies.length ? { dependencies } : {}),
        }],
      },
    };
  }

  private listInput(value: unknown): string[] {
    return (Array.isArray(value) ? value : String(value ?? "").split(/[;,]/u))
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private createField(
    field: string,
    value: unknown,
    valueType: string,
    custom = false,
  ): Record<string, unknown> {
    if (valueType === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`Create field '${field}' requires a finite number.`);
      return custom
        ? { kind: "custom", field, valueType, value: parsed }
        : { kind: "number", field, value: parsed };
    }
    if (valueType === "list") {
      const list = this.listInput(value);
      return custom
        ? { kind: "custom", field, valueType, value: list }
        : { kind: "list", field, value: list };
    }
    if (valueType === "checkbox") {
      const normalized = String(value).toLocaleLowerCase();
      if (!["true", "false", "1", "0", "yes", "no", "on", "off"].includes(normalized)) {
        throw new Error(`Create field '${field}' requires a boolean value.`);
      }
      if (!custom) throw new Error(`Create field '${field}' has unsupported value type '${valueType}'.`);
      return {
        kind: "custom",
        field,
        valueType,
        value: ["true", "1", "yes", "on"].includes(normalized),
      };
    }
    if (!["text", "date", "datetime"].includes(valueType)) {
      throw new Error(`Create field '${field}' has unsupported value type '${valueType}'.`);
    }
    return custom
      ? { kind: "custom", field, valueType, value: String(value) }
      : { kind: valueType, field, value: String(value) };
  }

  private async identifyCreatedTask(
    api: DeveloperApiV1,
    beforeIds: Set<string>,
    requested: Record<string, unknown>,
    mapped: { targetPath?: string; representation?: "inline" | "file" },
  ): Promise<string | null> {
    const after = await this.readAllTasks(api);
    this.rawTasks = after.rawTasks;
    const description = String(requested.description ?? "").trim();
    const candidates = after.rawTasks.filter((task) => {
      if (beforeIds.has(task.identity.operonId) || task.description !== description) return false;
      if (mapped.representation && task.representation !== mapped.representation) return false;
      if (mapped.targetPath && task.locator.filePath !== mapped.targetPath) return false;
      return true;
    });
    if (candidates.length !== 1) return null;
    return candidates[0]?.identity.operonId ?? null;
  }

  private setUnavailableDiagnostics(): void {
    this.diagnostics = {
      health: "unavailable",
      runtimePhase: "developer-api-unavailable",
      verifiedThisSession: false,
      taskCount: this.tasks.length,
      dirtySourceCount: 1,
    };
  }

  private getDiagnostics(): RuntimeIndexDiagnostics {
    return { ...this.diagnostics, taskCount: this.tasks.length };
  }

  static canHandle(operonPlugin: unknown): boolean {
    return isDeveloperApiAccessor(operonPlugin);
  }
}
