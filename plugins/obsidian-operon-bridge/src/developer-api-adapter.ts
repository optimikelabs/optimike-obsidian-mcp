import {
  type OperonSemanticConfiguration,
  type RuntimeIndexDiagnostics,
  type RuntimeIndexedTask,
  type RuntimeKeyMapping,
  type RuntimePipeline,
  type RuntimePriorityDefinition,
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
  readonly writableFields?: readonly {
    readonly canonicalKey: string;
    readonly present: boolean;
    readonly value?: string | number | boolean | string[];
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
  readonly hasCapability: (name: string) => boolean;
  readonly channel: { readonly status: () => DeveloperApiChannelStatus };
  readonly system: {
    readonly health: () => Promise<DeveloperApiHealth>;
    readonly capabilities: () => readonly { readonly id?: string }[];
    readonly diagnostics: () => Promise<unknown>;
  };
  readonly catalog: {
    readonly snapshot: (request?: unknown) => Promise<DeveloperApiCatalog>;
  };
  readonly tasks: {
    readonly query: (request: unknown) => Promise<DeveloperApiTaskQueryResult>;
  };
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
] as const;

function requestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `operon-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
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

  async refresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshInternal().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshInternal(): Promise<boolean> {
    const api = this.connect(READ_CAPABILITIES);
    if (!api) {
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
      return true;
    } catch (error) {
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
    generation: number | null;
  }> {
    const tasks: RuntimeIndexedTask[] = [];
    let cursor: string | undefined;
    let generation: number | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const result = await api.tasks.query({
        contractVersion: 1,
        requestId: requestId(),
        kind: "task-query",
        consistency: "live-verified",
        include: ["custom-fields"],
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) throw new Error(developerErrorMessage(result.error));
      for (const task of result.tasks ?? []) tasks.push(toRuntimeTask(task));
      const candidateGeneration = result.contextRevision?.index?.ramGeneration;
      if (Number.isInteger(candidateGeneration)) generation = candidateGeneration ?? null;
      const nextCursor = result.page?.nextCursor;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return { tasks, generation };
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
