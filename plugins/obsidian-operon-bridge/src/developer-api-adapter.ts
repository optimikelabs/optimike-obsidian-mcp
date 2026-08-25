import {
  OPERON_BRIDGE_DEVELOPER_API_CONTRACT,
  type OperonSemanticConfiguration,
  type RuntimeIndexDiagnostics,
  type RuntimeIndexedTask,
  type RuntimeKeyMapping,
  type RuntimePipeline,
  type RuntimePriorityDefinition,
  type OperonFieldValue,
  isCanonicalVaultRelativePath,
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

export interface TaskWorkflowIdentityStore {
  get(key: string): string | undefined;
  set(key: string, operonId: string): void | Promise<void>;
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
    readonly requestedCapabilities?: readonly string[];
    readonly grantedCapabilities?: readonly string[];
    readonly effectiveCapabilities?: readonly string[];
  };
  readonly error?: DeveloperApiError;
  readonly [key: string]: unknown;
}

export interface TaskWorkflowBeforeApplyGateResult {
  readonly ok: boolean;
  readonly message?: string;
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
  readonly recurrence?: {
    readonly repeating: boolean;
    readonly seriesId?: string;
    readonly occurrenceDate?: string;
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
  readonly page?: {
    readonly nextCursor?: string;
    readonly truncated?: boolean;
  };
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
  readonly contractVersion?: number;
  readonly kind?: string;
  readonly requestId?: string;
  readonly status?:
    | "applied"
    | "already-applied"
    | "partial"
    | "failed"
    | "outcome-unknown";
  readonly mutationMayHaveApplied?: boolean;
  readonly retryAllowed?: boolean;
  readonly groupResults?: readonly {
    readonly groupId?: string;
    readonly status?: string;
    readonly resourceRevisions?: readonly {
      readonly resourceKind?: string;
      readonly resourceKey?: string;
      readonly revision?: string;
    }[];
    readonly error?: DeveloperApiError;
  }[];
  readonly receipt?: {
    readonly contractVersion?: number;
    readonly terminalOutcome?: string;
    readonly planDigest?: string;
    readonly mutationKind?: string;
    readonly targetDigest?: string;
    readonly effectiveAt?: string;
    readonly completedAt?: string;
    readonly expiresAt?: string;
    readonly [key: string]: unknown;
  };
  readonly postflight?: {
    readonly status?: string;
    readonly observedAt?: string;
    readonly [key: string]: unknown;
  };
  readonly recovery?: {
    readonly required?: boolean;
    readonly action?: string;
    readonly mutationMayHaveApplied?: boolean;
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
  readonly contractVersion?: number;
  readonly kind?: string;
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
  readonly mutationClass?:
    | "general-update"
    | "semantic-capability"
    | "runtime-owned";
  readonly mutationOwner?: string;
}

interface DeveloperApiCatalog {
  readonly ok: boolean;
  readonly settingsFingerprint?: string;
  readonly taxonomy?: {
    readonly defaultPipeline?: {
      readonly configuredValue?: string;
      readonly id?: string;
    };
    readonly defaultPriority?: {
      readonly configuredValue?: string;
      readonly id?: string;
    };
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
  readonly filters?: readonly {
    readonly id: string;
    readonly name: string;
    readonly icon?: string;
    readonly [key: string]: unknown;
  }[];
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

interface TaskWorkflowFilterResult {
  readonly contractVersion?: number;
  readonly kind?: string;
  readonly requestId?: string;
  readonly ok: boolean;
  readonly tasks?: readonly DeveloperApiTask[];
  readonly page?: {
    readonly actualCount?: number;
    readonly returnedCount?: number;
    readonly truncated?: boolean;
    readonly nextCursor?: string;
    readonly asOf?: string;
  };
  readonly contextRevision?: DeveloperApiContextRevision;
  readonly error?: DeveloperApiError;
}

export type DeveloperApiTaskWorkflowKind =
  | "adopt"
  | "periodic-create"
  | "periodic-update";

interface TaskWorkflowDeveloperMutationPlan {
  readonly contractVersion: 1;
  readonly kind: "task-workflow-developer-mutation-plan";
  readonly recoveryRef: string;
  readonly planDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly riskLevel: "none" | "routine" | "elevated" | "destructive";
  readonly requiresConsent: boolean;
}

interface TaskWorkflowDeveloperMutationPreviewResult {
  readonly contractVersion?: number;
  readonly kind?: string;
  readonly requestId?: string;
  readonly ok: boolean;
  readonly plan?: TaskWorkflowDeveloperMutationPlan;
  readonly warnings?: readonly unknown[];
  readonly error?: DeveloperApiError;
}

interface TaskWorkflowDeveloperMutationExecutionResult {
  readonly contractVersion?: number;
  readonly kind?: string;
  readonly requestId?: string;
  readonly status?:
    | "applied"
    | "already-applied"
    | "partial"
    | "failed"
    | "outcome-unknown";
  readonly mutationMayHaveApplied?: boolean;
  readonly retryAllowed?: boolean;
  readonly groupResults?: readonly {
    readonly groupId?: string;
    readonly status?: string;
    readonly resourceRevisions?: readonly {
      readonly resourceKind?: string;
      readonly resourceKey?: string;
      readonly revision?: string;
    }[];
  }[];
  readonly receipt?: {
    readonly contractVersion?: number;
    readonly planDigest?: string;
    readonly mutationKind?: string;
    readonly targetDigest?: string;
    readonly terminalOutcome?: string;
    readonly effectiveAt?: string;
    readonly completedAt?: string;
    readonly expiresAt?: string;
  };
  readonly postflight?: {
    readonly status?: string;
    readonly observedAt?: string;
  };
  readonly recovery?: {
    readonly required?: boolean;
    readonly action?: string;
    readonly mutationMayHaveApplied?: boolean;
    readonly recoveryRef?: string;
    readonly planDigest?: string;
    readonly plan?: TaskWorkflowDeveloperMutationPlan;
  };
  readonly error?: DeveloperApiError;
}

export interface DeveloperApiTaskWorkflowNativeProof {
  readonly contractVersion: 1;
  readonly kind: "mutation-result";
  readonly status:
    | "applied"
    | "already-applied"
    | "partial"
    | "failed"
    | "outcome-unknown";
  readonly mutationMayHaveApplied: boolean;
  readonly retryAllowed: boolean;
  readonly groupResults: readonly {
    readonly groupId: string;
    readonly status: "committed" | "failed" | "outcome-unknown";
    readonly resourceRevisions?: readonly {
      readonly resourceKind:
        | "timer"
        | "repeat-series"
        | "active-tracker"
        | "pinned"
        | "project-serial"
        | "task-source";
      readonly resourceKey: string;
      readonly revision: string;
    }[];
  }[];
  readonly receipt?: {
    readonly contractVersion: 1;
    readonly planDigest: string;
    readonly mutationKind: string;
    readonly targetDigest: string;
    readonly terminalOutcome: "applied" | "already-applied";
    readonly effectiveAt: string;
    readonly completedAt: string;
    readonly expiresAt: string;
  };
  readonly postflight?: {
    readonly status: "verified" | "receipt-replay";
    readonly observedAt?: string;
  };
}

interface TaskWorkflowDeveloperMutationMethods {
  readonly preview?: (
    input: Record<string, unknown>,
  ) => Promise<TaskWorkflowDeveloperMutationPreviewResult>;
  readonly apply?: (input: {
    readonly plan: TaskWorkflowDeveloperMutationPlan;
  }) => Promise<TaskWorkflowDeveloperMutationExecutionResult>;
  readonly recover?: (input: {
    readonly recoveryRef: string;
  }) => Promise<TaskWorkflowDeveloperMutationExecutionResult>;
  readonly pendingRecoveries?: () => Promise<DeveloperApiPendingRecoveriesResult>;
}

interface TaskWorkflowDeveloperApiV1 {
  readonly contractVersion?: number;
  readonly runtimeApi?: number;
  readonly tasks: {
    readonly filterQuery?: (
      request: Record<string, unknown>,
    ) => Promise<TaskWorkflowFilterResult>;
    readonly adopt?: TaskWorkflowDeveloperMutationMethods;
    readonly createPeriodicNote?: TaskWorkflowDeveloperMutationMethods;
    readonly updatePeriodicNote?: TaskWorkflowDeveloperMutationMethods;
  };
}

interface TaskWorkflowDeveloperApiAccessResult {
  readonly contractVersion?: number;
  readonly kind?: string;
  readonly ok: boolean;
  readonly api?: TaskWorkflowDeveloperApiV1;
  readonly error?: DeveloperApiError;
}

interface TaskWorkflowDeveloperApiAccessor {
  readonly getTaskWorkflowDeveloperApiV1: (
    consumerPlugin: DeveloperApiConsumerPlugin,
    request: {
      readonly contractVersion: 1;
      readonly runtimeApi: { readonly min: 1; readonly max: 1 };
      readonly requestedCapabilities: readonly string[];
    },
  ) => TaskWorkflowDeveloperApiAccessResult;
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
    readonly preview: (
      input: unknown,
    ) => Promise<DeveloperApiMutationPreviewResult>;
    readonly apply: (
      input: unknown,
    ) => Promise<DeveloperApiMutationExecutionResult>;
    readonly recover?: (
      input: unknown,
    ) => Promise<DeveloperApiMutationExecutionResult>;
    readonly pendingRecoveries?: () => Promise<DeveloperApiPendingRecoveriesResult>;
  };
}

export type DeveloperApiMutationCapability =
  | "create"
  | "update"
  | "transition"
  | "relationships"
  | "recurrence"
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
  readonly nativeProof?: DeveloperApiTaskWorkflowNativeProof;
}

export interface DeveloperApiPendingRecoveryResult {
  readonly ok: boolean;
  readonly recoveries: readonly (DeveloperApiPendingRecovery & {
    readonly workflowKind?: DeveloperApiTaskWorkflowKind;
  })[];
  readonly message?: string;
}

export interface DeveloperApiRecurrenceState {
  readonly repeating: boolean;
  readonly seriesId: string | null;
  readonly occurrenceDate: string | null;
}

export interface DeveloperApiRuntimeIndexer {
  readonly getAllTasks: () => RuntimeIndexedTask[];
  readonly getTask: (operonId: string) => RuntimeIndexedTask | undefined;
  readonly getGeneration: () => number;
  readonly getIndexV8Diagnostics: () => Promise<RuntimeIndexDiagnostics>;
  taskCount: number;
}

const BASELINE_CAPABILITIES = ["system.health", "system.capabilities"] as const;

const CORE_READ_CAPABILITIES = [
  ...BASELINE_CAPABILITIES,
  "catalog.read",
  "tasks.read",
  "tasks.query",
] as const;

const OPTIONAL_READ_CAPABILITIES = [
  "system.diagnostics",
  "tasks.finder",
  "entities.resolve",
  "relationships.read",
  "context.build",
  "timers.read",
] as const;

const MAX_TASK_QUERY_PAGES = 10_000;

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
  relationships: ["tasks.relationship.preview", "tasks.relationship.apply"],
  recurrence: ["tasks.recurrence.preview", "tasks.recurrence.apply"],
  convert: ["tasks.convert.preview", "tasks.convert.apply"],
  relocate: ["tasks.inline.relocate.preview", "tasks.inline.relocate.apply"],
};

const GENERAL_FIELD_TYPES: Record<string, string> = {
  description: "text",
  priority: "text",
  taskType: "text",
  taskImage: "text",
  taskGallery: "list",
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
  taskType: "text",
  taskImage: "text",
  taskGallery: "list",
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

const TASK_WORKFLOW_CAPABILITIES: Record<
  DeveloperApiTaskWorkflowKind,
  readonly [string, string]
> = {
  adopt: ["tasks.adopt.preview", "tasks.adopt.apply"],
  "periodic-create": [
    "tasks.create.periodic-note.preview",
    "tasks.create.periodic-note.apply",
  ],
  "periodic-update": [
    "tasks.update.periodic-note.preview",
    "tasks.update.periodic-note.apply",
  ],
};

// The official runtime may settle a graph/project-serial mutation after the
// default local REST/MCP request budget. Returning an uncertain outcome with
// the durable recovery reference is safer than holding the HTTP request open
// until the caller times out and then guessing whether to retry.
const DEVELOPER_API_APPLY_TIMEOUT_MS = 120_000;
const POST_APPLY_IDENTITY_RETRY_DELAYS_MS = [0, 100, 300, 750, 1_500] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const DEVELOPER_RECOVERY_REF = /^dvr1_[0-9a-f]{48}$/u;

function requestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `operon-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(
        new Error(
          `Operon Developer API apply exceeded the ${timeoutMs}ms Bridge budget.`,
        ),
      );
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
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}

function fieldValue(value: unknown): OperonFieldValue | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
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
  return (
    error?.reason ??
    error?.message ??
    error?.code ??
    "Operon Developer API unavailable."
  );
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
    indexing: {
      excludedFolders: [],
      fullReindexOnStartup: false,
      indexEventDebounceMs: 0,
    },
    docs: { folder: "", autoUpdateEnabled: false },
    views: { filters: [] },
  };
}

function toRuntimeTask(task: DeveloperApiTask): RuntimeIndexedTask {
  const fieldValues: Record<string, OperonFieldValue> = {};
  const writeField = (key: string, value: unknown): void => {
    const normalized = fieldValue(value);
    if (
      normalized !== undefined &&
      normalized !== "" &&
      (!Array.isArray(normalized) || normalized.length > 0)
    )
      fieldValues[key] = normalized;
  };

  if (task.workflow) {
    writeField(
      "status",
      `${task.workflow.pipeline.label}.${task.workflow.status.label}`,
    );
  }
  if (task.priority)
    writeField("priority", task.priority.id || task.priority.label);
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

  for (const [key, value] of Object.entries(task.customFields ?? {}))
    writeField(key, value);
  for (const field of task.writableFields ?? []) {
    if (field.present) writeField(field.canonicalKey, field.value);
  }

  const tagsValue =
    task.writableFields?.find((field) => field.canonicalKey === "tags")
      ?.value ?? task.customFields?.tags;
  const tags = Array.isArray(tagsValue) ? tagsValue.map(String) : [];
  const locator = task.locator;
  const isInline =
    task.representation === "inline" && locator.representation === "inline";

  return {
    operonId: task.identity.operonId,
    description: task.description,
    checkbox: task.checkbox,
    fieldValues,
    tags,
    primary: {
      filePath: locator.filePath,
      lineNumber:
        isInline && Number.isInteger(locator.lineNumber)
          ? (locator.lineNumber ?? 0)
          : 0,
      format: isInline ? "inline" : "yaml",
    },
    datetimeModified: task.datetimes?.modified ?? "",
    tier: "warm",
    ...(task.recurrence
      ? {
          recurrence: {
            repeating: task.recurrence.repeating,
            seriesId: task.recurrence.seriesId ?? null,
            occurrenceDate: task.recurrence.occurrenceDate ?? null,
          },
        }
      : {}),
  };
}

function catalogConfiguration(catalog: DeveloperApiCatalog): {
  pipelines: RuntimePipeline[];
  keyMappings: RuntimeKeyMapping[];
  priorities: RuntimePriorityDefinition[];
  configuration: OperonSemanticConfiguration;
} {
  const taxonomy = catalog.taxonomy ?? {};
  const pipelines: RuntimePipeline[] = (taxonomy.pipelines ?? []).map(
    (pipeline) => ({
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
    }),
  );
  const keyMappings: RuntimeKeyMapping[] = (catalog.fields ?? []).map(
    (field) => ({
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
    }),
  );
  const priorities: RuntimePriorityDefinition[] = (
    taxonomy.priorities ?? []
  ).map((priority) => ({
    id: priority.id,
    label: priority.label,
    color: priority.color,
    description: priority.description,
  }));
  const defaultPipeline = taxonomy.defaultPipeline;
  const defaultPipelineName =
    pipelines.find((pipeline) => pipeline.id === defaultPipeline?.id)?.name ??
    defaultPipeline?.configuredValue ??
    null;
  const defaultPriority =
    taxonomy.defaultPriority?.id ??
    taxonomy.defaultPriority?.configuredValue ??
    null;
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
    inlineTaskDailyNoteAddScheduledDate:
      creation?.dailyNoteAddsScheduledDate === true,
    taskCreatorDefaultToFileTask: creation?.defaultToFileTask === true,
    taskCreatorDefaultFileTemplateId: creation?.defaultFileTemplateId ?? null,
    fileTaskTemplateFolder: creation?.fileTaskTemplateFolder ?? "",
    availableFileTaskTemplates: (
      creation?.fileTaskTemplateCandidates ?? []
    ).map((template) => ({
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
    autoCompleteParentWhenAllChildrenTerminal:
      automation?.autoCompleteParentWhenAllChildrenTerminal === true,
    cascadeCancelToDescendants: automation?.cascadeCancelToDescendants === true,
    fileTaskAutoArchiveEnabled: automation?.fileTaskAutoArchiveEnabled === true,
    fileTaskArchiveFolder: automation?.fileTaskArchiveFolder ?? "",
    fileTaskArchiveDelaySeconds: automation?.fileTaskArchiveDelaySeconds ?? 0,
    fileTaskArchiveOnlyFromFileTasksFolder:
      automation?.fileTaskArchiveOnlyFromFileTasksFolder === true,
    fileRepeatDestination: automation?.fileRepeatDestination ?? "",
    fileRepeatCustomFolder: automation?.fileRepeatCustomFolder ?? "",
  };
  configuration.indexing = {
    ...configuration.indexing,
    excludedFolders: [...(catalog.policies?.exclusions?.folders ?? [])],
  };
  configuration.views = {
    filters: (catalog.filters ?? []).map((filter) => ({
      id: filter.id,
      name: filter.name,
      icon: filter.icon ?? null,
      definition: JSON.parse(JSON.stringify(filter)) as Record<string, unknown>,
    })),
  };
  return { pipelines, keyMappings, priorities, configuration };
}

function isDeveloperApiAccessor(value: unknown): value is DeveloperApiAccessor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly getDeveloperApiV1?: unknown };
  return typeof candidate.getDeveloperApiV1 === "function";
}

const STARTUP_REFRESH_RETRY_LIMIT = 2;
const STARTUP_REFRESH_RETRY_MAX_MS = 1_500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDeveloperApiV1(value: unknown): value is DeveloperApiV1 {
  if (!isRecord(value)) return false;
  const channel = isRecord(value.channel) ? value.channel : null;
  const system = isRecord(value.system) ? value.system : null;
  const catalog = isRecord(value.catalog) ? value.catalog : null;
  const tasks = isRecord(value.tasks) ? value.tasks : null;
  return Boolean(
    typeof value.hasCapability === "function" &&
      channel &&
      typeof channel.status === "function" &&
      system &&
      typeof system.health === "function" &&
      typeof system.capabilities === "function" &&
      typeof system.diagnostics === "function" &&
      catalog &&
      typeof catalog.snapshot === "function" &&
      tasks &&
      typeof tasks.query === "function",
  );
}

function isTaskWorkflowDeveloperApiAccessor(
  value: unknown,
): value is TaskWorkflowDeveloperApiAccessor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    readonly getTaskWorkflowDeveloperApiV1?: unknown;
  };
  return typeof candidate.getTaskWorkflowDeveloperApiV1 === "function";
}

function grantedCapabilitiesFromStatus(
  status: DeveloperApiChannelStatus,
): ReadonlySet<string> | null {
  const granted = status.grant?.grantedCapabilities;
  // A baseline-only Developer API session intentionally reports an empty
  // granted list; that means "not disclosed", not "nothing is approved".
  if (Array.isArray(granted) && granted.length > 0) return new Set(granted);
  return null;
}

export class OperonDeveloperApiRuntimeAdapter {
  readonly indexer: DeveloperApiRuntimeIndexer = {
    getAllTasks: () => this.tasks,
    getTask: (operonId: string) =>
      this.tasks.find((task) => task.operonId === operonId),
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
  private readonly taskWorkflowAccessor: TaskWorkflowDeveloperApiAccessor | null;
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
  private readonly optionalReadApis = new Map<
    DeveloperApiReadCapability,
    DeveloperApiV1
  >();
  private readonly mutationApis = new Map<
    DeveloperApiMutationCapability,
    DeveloperApiV1
  >();
  private recoveryApi: DeveloperApiV1 | null = null;
  private filterQueryApi: TaskWorkflowDeveloperApiV1 | null = null;
  private readonly taskWorkflowApis = new Map<
    DeveloperApiTaskWorkflowKind,
    TaskWorkflowDeveloperApiV1
  >();
  private readonly taskWorkflowRecoveryDigests = new Map<string, string>();
  private readonly taskWorkflowIdentityByPlanDigest = new Map<string, string>();
  private grantedCapabilities: ReadonlySet<string> | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private contractState: "unverified" | "valid" | "invalid" = "unverified";

  constructor(
    private readonly consumerPlugin: DeveloperApiConsumerPlugin,
    operonPlugin: unknown,
    private readonly taskWorkflowIdentityStore?: TaskWorkflowIdentityStore,
  ) {
    this.accessor = isDeveloperApiAccessor(operonPlugin) ? operonPlugin : null;
    this.taskWorkflowAccessor = isTaskWorkflowDeveloperApiAccessor(operonPlugin)
      ? operonPlugin
      : null;
  }

  get semanticConfiguration(): OperonSemanticConfiguration {
    return this.configuration;
  }

  get status(): DeveloperApiChannelStatus {
    return this.channelStatus;
  }

  get negotiatedContractState(): "unverified" | "valid" | "invalid" {
    return this.contractState;
  }

  async refresh(
    includeMutationCapabilities = false,
    includeTaskWorkflowCapabilities = includeMutationCapabilities,
    includeFilterQueryCapability = includeTaskWorkflowCapabilities,
  ): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshWithStartupRetry(
      includeMutationCapabilities,
      includeTaskWorkflowCapabilities,
      includeFilterQueryCapability,
    ).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshWithStartupRetry(
    includeMutationCapabilities: boolean,
    includeTaskWorkflowCapabilities: boolean,
    includeFilterQueryCapability: boolean,
  ): Promise<boolean> {
    for (
      let attempt = 0;
      attempt <= STARTUP_REFRESH_RETRY_LIMIT;
      attempt += 1
    ) {
      if (
        await this.refreshInternal(
          includeMutationCapabilities,
          includeTaskWorkflowCapabilities,
          includeFilterQueryCapability,
        )
      )
        return true;
      const retryAfterMs = this.startupRetryDelayMs();
      if (retryAfterMs === null || attempt === STARTUP_REFRESH_RETRY_LIMIT)
        return false;
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, retryAfterMs);
      });
    }
    return false;
  }

  private startupRetryDelayMs(): number | null {
    if (
      this.channelStatus.availability !== "degraded" ||
      this.channelStatus.reason !== "cache-ready" ||
      this.channelStatus.admission?.reads !== true
    ) {
      return null;
    }
    const requestedDelay = Number(this.channelStatus.retryAfterMs ?? 500);
    if (!Number.isFinite(requestedDelay)) return 500;
    return Math.min(
      STARTUP_REFRESH_RETRY_MAX_MS,
      Math.max(0, Math.trunc(requestedDelay)),
    );
  }

  private async refreshInternal(
    includeMutationCapabilities: boolean,
    includeTaskWorkflowCapabilities: boolean,
    includeFilterQueryCapability: boolean,
  ): Promise<boolean> {
    this.readApi = null;
    this.optionalReadApis.clear();
    this.mutationApis.clear();
    if (includeFilterQueryCapability) this.filterQueryApi = null;
    if (!includeMutationCapabilities) {
      this.recoveryApi = null;
      this.taskWorkflowApis.clear();
    }
    this.grantedCapabilities = null;

    // Establish a baseline session first. Operon evaluates a requested set as
    // one grant: asking for an unapproved optional capability must not revoke
    // access to capabilities that were already approved.
    const baselineApi = this.connect(BASELINE_CAPABILITIES);
    if (!baselineApi) {
      this.readApi = null;
      this.setUnavailableDiagnostics();
      return false;
    }
    // Probe the three core read capabilities independently before asking for
    // their composite session. Operon rejects the whole requested set when
    // one capability is still pending, so the probes preserve a usable
    // partial grant and let us fail closed only when the index itself cannot
    // be read completely.
    const coreProbeEntries = CORE_READ_CAPABILITIES.filter(
      (capability) =>
        !BASELINE_CAPABILITIES.includes(
          capability as (typeof BASELINE_CAPABILITIES)[number],
        ),
    ).map(
      (capability) =>
        [
          capability,
          this.connectApproved([...BASELINE_CAPABILITIES, capability], false),
        ] as const,
    );
    if (
      coreProbeEntries.some(
        ([capability, candidate]) =>
          !candidate || !candidate.hasCapability(capability),
      )
    ) {
      this.readApi = null;
      this.setUnavailableDiagnostics();
      return false;
    }
    const api = this.connectApproved(CORE_READ_CAPABILITIES);
    if (!api) {
      this.readApi = null;
      this.setUnavailableDiagnostics();
      return false;
    }
    try {
      const health = await api.system.health();
      if (!health.ok) {
        this.channelStatus = health.error
          ? { error: health.error }
          : this.channelStatus;
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
      this.generation =
        tasks.generation ??
        health.contextRevision?.index?.ramGeneration ??
        this.generation + 1;
      this.pipelines.splice(0, this.pipelines.length, ...snapshot.pipelines);
      this.keyMappings.splice(
        0,
        this.keyMappings.length,
        ...snapshot.keyMappings,
      );
      this.priorities.splice(0, this.priorities.length, ...snapshot.priorities);
      this.configuration = snapshot.configuration;
      this.defaultPipelineName =
        snapshot.configuration.workflow.defaultPipelineName;
      this.diagnostics = {
        health: "healthy",
        runtimePhase: "idle",
        verifiedThisSession: true,
        taskCount: this.tasks.length,
        dirtySourceCount: 0,
      };
      this.readApi = api;
      this.recoveryApi = baselineApi;
      for (const capability of OPTIONAL_READ_CAPABILITIES) {
        const optionalApi = this.connectApproved(
          [...BASELINE_CAPABILITIES, capability],
          false,
        );
        if (optionalApi?.hasCapability(capability)) {
          this.optionalReadApis.set(capability, optionalApi);
          if (!this.recoveryApi && optionalApi.mutations)
            this.recoveryApi = optionalApi;
        }
      }
      if (includeMutationCapabilities) this.connectMutationApis();
      this.requestMissingCapabilities(includeMutationCapabilities);
      // The additive task-workflow accessor may create a new exact-capability
      // consent request. Probe it only after preserving every already-granted
      // core read and mutation session, so a pending filter grant cannot make
      // the established V1 surface appear unavailable during the same refresh.
      if (includeFilterQueryCapability) {
        try {
          this.filterQueryApi = this.connectFilterQuery();
        } catch {
          // Saved-filter execution is an additive Operon 3.2 capability. A
          // broken or temporarily incompatible optional accessor must not tear
          // down the already-verified core Developer API session.
          this.filterQueryApi = null;
        }
      }
      if (includeMutationCapabilities && includeTaskWorkflowCapabilities) {
        this.taskWorkflowApis.clear();
        for (const workflowKind of Object.keys(
          TASK_WORKFLOW_CAPABILITIES,
        ) as DeveloperApiTaskWorkflowKind[]) {
          try {
            const workflowApi = this.connectTaskWorkflow(workflowKind);
            if (workflowApi)
              this.taskWorkflowApis.set(workflowKind, workflowApi);
          } catch {
            // Task-workflow grants are additive and exact. A pending or broken
            // optional workflow must never invalidate established core reads,
            // filter execution, or already-approved mutation sessions.
          }
        }
      }
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
        error: {
          reason: error instanceof Error ? error.message : String(error),
        },
      };
      return false;
    }
  }

  hasMutationCapability(capability: DeveloperApiMutationCapability): boolean {
    const api = this.mutationApis.get(capability);
    if (!api?.mutations?.preview || !api.mutations.apply) return false;
    const [preview, apply] = MUTATION_CAPABILITIES[capability];
    return api.hasCapability(preview) && api.hasCapability(apply);
  }

  hasReadCapability(capability: DeveloperApiReadCapability): boolean {
    return Boolean(
      this.readApi?.hasCapability(capability) ||
        this.optionalReadApis.get(capability)?.hasCapability(capability),
    );
  }

  hasFilterQueryCapability(): boolean {
    return Boolean(this.filterQueryApi?.tasks.filterQuery);
  }

  async refreshFilterQuery(): Promise<boolean> {
    let api: TaskWorkflowDeveloperApiV1 | null = null;
    try {
      api = this.connectFilterQuery();
    } catch {
      // Saved-filter consent is exact and optional. A pending or malformed
      // grant fails closed without invalidating core reads or mutation sessions.
    }
    if (!api) return false;
    this.filterQueryApi = api;
    return true;
  }

  hasTaskWorkflowCapability(kind: DeveloperApiTaskWorkflowKind): boolean {
    const api = this.taskWorkflowApis.get(kind);
    const methods = this.taskWorkflowMethods(api, kind);
    return Boolean(methods?.preview && methods.apply);
  }

  hasTaskWorkflowRecoverySupport(kind: DeveloperApiTaskWorkflowKind): boolean {
    const methods = this.taskWorkflowMethods(
      this.taskWorkflowApis.get(kind),
      kind,
    );
    return Boolean(methods?.recover && methods.pendingRecoveries);
  }

  async refreshTaskWorkflow(
    kind: DeveloperApiTaskWorkflowKind,
  ): Promise<boolean> {
    let api: TaskWorkflowDeveloperApiV1 | null = null;
    try {
      api = this.connectTaskWorkflow(kind);
    } catch {
      // First-use negotiation is exact and additive. A pending or malformed
      // optional grant fails closed without invalidating any established core
      // Developer API session.
    }
    if (!api) return false;
    this.taskWorkflowApis.set(kind, api);
    return true;
  }

  async refreshTaskWorkflowRecovery(
    kind: DeveloperApiTaskWorkflowKind,
  ): Promise<boolean> {
    let api: TaskWorkflowDeveloperApiV1 | null = null;
    try {
      api = this.connectTaskWorkflowRecovery(kind);
    } catch {
      // A failed exact negotiation must fail closed without depending on, or
      // mutating, the live task index. Preserve any already-negotiated session:
      // a concurrent recovery poll must not revoke the API that an active
      // mutation obtained before entering its durable preflight.
    }
    if (!api) return false;
    this.taskWorkflowApis.set(kind, api);
    return true;
  }

  async querySavedFilter(
    request: Record<string, unknown>,
  ): Promise<TaskWorkflowFilterResult> {
    const api = this.filterQueryApi;
    if (!api?.tasks.filterQuery) {
      throw new Error(
        "Operon task-workflow Developer API grant is unavailable: tasks.filter-query.",
      );
    }
    const filterSetId = String(request.filterSetId ?? "").trim();
    if (!filterSetId) throw new Error("filterSetId is required.");
    const rawScopePath = request.scopePath;
    if (
      rawScopePath !== undefined &&
      !isCanonicalVaultRelativePath(rawScopePath)
    ) {
      throw new Error(
        "scopePath must be an exact canonical vault-relative note or folder path.",
      );
    }
    const scopePath = typeof rawScopePath === "string" ? rawScopePath : "";
    const requestedLimit = Number(request.limit ?? 100);
    const limit = Math.min(
      250,
      Math.max(
        1,
        Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100,
      ),
    );
    const filterRequestId = requestId();
    const result = await api.tasks.filterQuery({
      contractVersion: 1,
      requestId: filterRequestId,
      kind: "task-filter-query",
      consistency: "live-verified",
      filterSetId,
      ...(scopePath
        ? {
            scope: {
              kind: scopePath.toLocaleLowerCase().endsWith(".md")
                ? "exact-file"
                : "folder-tree",
              path: scopePath,
            },
          }
        : {}),
      ...(request.includeProperties === true
        ? { include: ["custom-fields"] }
        : {}),
      limit,
      ...(typeof request.cursor === "string" && request.cursor
        ? { cursor: request.cursor }
        : {}),
    });
    if (
      result.contractVersion !== 1 ||
      result.kind !== "task-filter-query-result" ||
      result.requestId !== filterRequestId
    ) {
      throw new Error(
        "Operon returned an invalid task-workflow filter-query discriminator.",
      );
    }
    return result;
  }

  private requireReadApi(
    capability: DeveloperApiReadCapability,
  ): DeveloperApiV1 {
    const api = this.readApi?.hasCapability(capability)
      ? this.readApi
      : this.optionalReadApis.get(capability);
    if (!api || !api.hasCapability(capability)) {
      throw new Error(
        `Operon Developer API V1 read grant is unavailable: ${capability}.`,
      );
    }
    return api;
  }

  async readDiagnostics(): Promise<DeveloperApiReadResult> {
    return this.requireReadApi("system.diagnostics").system.diagnostics();
  }

  async findTasks(
    request: Record<string, unknown>,
  ): Promise<DeveloperApiReadResult> {
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

  async resolveEntity(
    request: Record<string, unknown>,
  ): Promise<DeveloperApiReadResult> {
    const api = this.requireReadApi("entities.resolve");
    if (!api.entities?.resolve)
      throw new Error("Operon entities.resolve is unavailable.");
    return api.entities.resolve({
      contractVersion: 1,
      requestId: requestId(),
      kind: "entity-resolve",
      consistency: "live-verified",
      ...request,
    });
  }

  async readRelationships(
    request: Record<string, unknown>,
  ): Promise<DeveloperApiReadResult> {
    const api = this.requireReadApi("relationships.read");
    if (!api.relationships?.get)
      throw new Error("Operon relationships.read is unavailable.");
    return api.relationships.get({
      contractVersion: 1,
      requestId: requestId(),
      kind: "relationship",
      consistency: "live-verified",
      ...request,
    });
  }

  async buildContext(
    request: Record<string, unknown>,
  ): Promise<DeveloperApiPlacementResult> {
    const api = this.requireReadApi("context.build");
    if (!api.context?.build)
      throw new Error("Operon context.build is unavailable.");
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
    if (!api.timers?.read)
      throw new Error("Operon timers.read is unavailable.");
    return api.timers.read({
      contractVersion: 1,
      requestId: requestId(),
      kind: "timer-read",
      consistency: "live-verified",
    });
  }

  async recurrenceState(
    operonId: string,
  ): Promise<DeveloperApiRecurrenceState | null> {
    const api = this.mutationApis.get("recurrence");
    if (!api) return null;
    const task = await this.getExactTask(api, operonId);
    if (!task) return null;
    return {
      repeating: task.recurrence?.repeating === true,
      seriesId: task.recurrence?.seriesId ?? null,
      occurrenceDate: task.recurrence?.occurrenceDate ?? null,
    };
  }

  hasRecoverySupport(): boolean {
    const mutations = this.recoveryApi?.mutations;
    return Boolean(mutations?.recover && mutations.pendingRecoveries);
  }

  async refreshRecovery(): Promise<boolean> {
    const api = this.connect(BASELINE_CAPABILITIES);
    if (!api?.mutations?.recover || !api.mutations.pendingRecoveries) {
      this.recoveryApi = null;
      return false;
    }
    this.recoveryApi = api;
    return true;
  }

  private connectApproved(
    requestedCapabilities: readonly string[],
    updateStatus = true,
  ): DeveloperApiV1 | null {
    if (
      this.grantedCapabilities &&
      requestedCapabilities.some(
        (capability) =>
          !BASELINE_CAPABILITIES.includes(
            capability as (typeof BASELINE_CAPABILITIES)[number],
          ) && !this.grantedCapabilities?.has(capability),
      )
    ) {
      return null;
    }
    return this.connect(requestedCapabilities, updateStatus);
  }

  private connectMutationApis(): void {
    for (const [capability, pair] of Object.entries(MUTATION_CAPABILITIES) as [
      DeveloperApiMutationCapability,
      readonly [string, string],
    ][]) {
      const api = this.connectApproved(
        [...CORE_READ_CAPABILITIES, ...pair],
        false,
      );
      if (
        api?.mutations?.preview &&
        pair.every((required) => api.hasCapability(required))
      ) {
        this.mutationApis.set(capability, api);
        if (!this.recoveryApi) this.recoveryApi = api;
      }
    }
  }

  private connectFilterQuery(): TaskWorkflowDeveloperApiV1 | null {
    if (!this.taskWorkflowAccessor) return null;
    const access = this.taskWorkflowAccessor.getTaskWorkflowDeveloperApiV1(
      this.consumerPlugin,
      {
        ...OPERON_BRIDGE_DEVELOPER_API_CONTRACT,
        requestedCapabilities: ["tasks.filter-query"],
      },
    );
    const api = this.taskWorkflowAccessApi(access);
    return api?.tasks.filterQuery ? api : null;
  }

  private connectTaskWorkflow(
    kind: DeveloperApiTaskWorkflowKind,
  ): TaskWorkflowDeveloperApiV1 | null {
    if (!this.taskWorkflowAccessor) return null;
    const access = this.taskWorkflowAccessor.getTaskWorkflowDeveloperApiV1(
      this.consumerPlugin,
      {
        ...OPERON_BRIDGE_DEVELOPER_API_CONTRACT,
        requestedCapabilities: TASK_WORKFLOW_CAPABILITIES[kind],
      },
    );
    const api = this.taskWorkflowAccessApi(access);
    if (!api) return null;
    const methods = this.taskWorkflowMethods(api, kind);
    return methods?.preview && methods.apply ? api : null;
  }

  private connectTaskWorkflowRecovery(
    kind: DeveloperApiTaskWorkflowKind,
  ): TaskWorkflowDeveloperApiV1 | null {
    if (!this.taskWorkflowAccessor) return null;
    const access = this.taskWorkflowAccessor.getTaskWorkflowDeveloperApiV1(
      this.consumerPlugin,
      {
        ...OPERON_BRIDGE_DEVELOPER_API_CONTRACT,
        requestedCapabilities: TASK_WORKFLOW_CAPABILITIES[kind],
      },
    );
    const api = this.taskWorkflowAccessApi(access);
    if (!api) return null;
    const methods = this.taskWorkflowMethods(api, kind);
    return methods?.recover && methods.pendingRecoveries ? api : null;
  }

  private taskWorkflowAccessApi(
    access: TaskWorkflowDeveloperApiAccessResult,
  ): TaskWorkflowDeveloperApiV1 | null {
    if (
      access.contractVersion !== 1 ||
      access.kind !== "task-workflow-developer-api-access-result" ||
      !access.ok ||
      !access.api ||
      access.error !== undefined ||
      access.api.contractVersion !== 1 ||
      access.api.runtimeApi !== 1
    ) return null;
    return access.api;
  }

  private taskWorkflowMethods(
    api: TaskWorkflowDeveloperApiV1 | undefined,
    kind: DeveloperApiTaskWorkflowKind,
  ): TaskWorkflowDeveloperMutationMethods | undefined {
    if (kind === "adopt") return api?.tasks.adopt;
    if (kind === "periodic-create") return api?.tasks.createPeriodicNote;
    return api?.tasks.updatePeriodicNote;
  }

  private requestMissingCapabilities(includeMutations: boolean): void {
    if (!this.grantedCapabilities) return;
    const desired = [
      ...OPTIONAL_READ_CAPABILITIES,
      ...(includeMutations ? Object.values(MUTATION_CAPABILITIES).flat() : []),
    ];
    const missing = [...new Set(desired)].filter(
      (capability) => !this.grantedCapabilities?.has(capability),
    );
    if (missing.length > 0) {
      // Establish approved sessions first, then leave one exact expansion
      // request pending for operator review. A later successful probe must
      // not erase that request.
      this.connect([...BASELINE_CAPABILITIES, ...missing], false);
    }
  }

  private connect(
    requestedCapabilities: readonly string[],
    updateStatus = true,
  ): DeveloperApiV1 | null {
    if (!this.accessor) return null;
    let rawAccess: unknown;
    try {
      rawAccess = this.accessor.getDeveloperApiV1(this.consumerPlugin, {
        ...OPERON_BRIDGE_DEVELOPER_API_CONTRACT,
        requestedCapabilities,
      });
    } catch (error) {
      this.contractState = "invalid";
      this.channelStatus = {
        error: {
          reason:
            error instanceof Error
              ? error.message
              : "Operon Developer API V1 negotiation threw an unknown error.",
        },
      };
      return null;
    }
    if (!isRecord(rawAccess)) {
      this.contractState = "invalid";
      this.channelStatus = {
        error: {
          reason:
            "Operon Developer API V1 negotiation returned an invalid result.",
        },
      };
      return null;
    }
    const status = isRecord(rawAccess.status)
      ? (rawAccess.status as DeveloperApiChannelStatus)
      : {};
    if (updateStatus) this.channelStatus = status;
    const grant = grantedCapabilitiesFromStatus(status);
    if (grant) this.grantedCapabilities = grant;
    if (rawAccess.ok !== true) {
      return null;
    }
    if (!isDeveloperApiV1(rawAccess.api)) {
      this.contractState = "invalid";
      this.channelStatus = {
        ...status,
        error: {
          reason:
            "Operon Developer API V1 negotiation returned an incomplete runtime contract.",
        },
      };
      return null;
    }
    const api = rawAccess.api;
    this.contractState = "valid";
    // Keep the channel status aligned with the strongest successful session.
    // Mutation probes intentionally avoid replacing useful read status when a
    // capability is unavailable, but a granted write session must be visible
    // to diagnostics instead of leaving the baseline reads-only admission.
    if (!updateStatus && status.admission?.writes === true) {
      this.channelStatus = status;
    }
    return api;
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
    const seenCursors = new Set<string>();
    for (
      let pageNumber = 0;
      pageNumber < MAX_TASK_QUERY_PAGES;
      pageNumber += 1
    ) {
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
          throw new Error(
            `Task disappeared during the live read: ${task.identity.operonId}.`,
          );
        }
        rawTasks.push(hydrated);
        tasks.push(toRuntimeTask(hydrated));
      }
      const candidateGeneration = result.contextRevision?.index?.ramGeneration;
      if (Number.isInteger(candidateGeneration))
        generation = candidateGeneration ?? null;
      const nextCursor = result.page?.nextCursor;
      if (!nextCursor) {
        if (result.page?.truncated === true) {
          throw new Error(
            `Operon task query reported truncation without a continuation cursor after ${tasks.length} tasks.`,
          );
        }
        break;
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new Error(
          "Operon task query returned a repeated pagination cursor.",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (cursor && seenCursors.size >= MAX_TASK_QUERY_PAGES) {
      throw new Error(
        `Operon task query exceeded the ${MAX_TASK_QUERY_PAGES}-page safety limit while still truncated; the live index is incomplete.`,
      );
    }
    return { tasks, rawTasks, generation };
  }

  async executeMutation(
    capability: DeveloperApiMutationCapability,
    operonId: string | null,
    requested: Record<string, unknown>,
    dryRun: boolean,
  ): Promise<DeveloperApiMutationResult> {
    const api = this.mutationApis.get(capability);
    const mutations = api?.mutations;
    if (
      !api ||
      !mutations?.preview ||
      !mutations.apply ||
      !this.hasMutationCapability(capability)
    ) {
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
        return this.mutationFailure(
          "invalid-input",
          "An operonId is required for this mutation.",
          null,
          false,
        );
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
      if (!task)
        return this.mutationFailure(
          "not-found",
          `Operon task not found: ${operonId}.`,
          operonId,
          false,
        );
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

    const invalidExecution = this.baseMutationResultViolation(
      execution,
      preview.plan,
    );
    if (invalidExecution) {
      return this.mutationFailure(
        "outcome-unknown",
        `Operon returned an invalid Developer API mutation result after dispatch: ${invalidExecution}`,
        operonId,
        false,
        {
          nativeStatus: execution.status ?? "invalid-result",
          recoveryRef:
            execution.recovery?.recoveryRef ?? preview.plan.recoveryRef,
          planDigest: preview.plan.planDigest,
          mutationMayHaveApplied: true,
        },
      );
    }
    const proof = this.baseMutationProof(execution);

    const status = execution.status ?? "failed";
    if (status === "partial" || status === "outcome-unknown") {
      return this.mutationFailure(
        "outcome-unknown",
        developerErrorMessage(execution.error) ||
          "Operon requires recovery of the same mutation plan.",
        operonId,
        false,
        {
          nativeStatus: status,
          recoveryRef:
            execution.recovery?.recoveryRef ?? preview.plan.recoveryRef,
          planDigest: execution.recovery?.planDigest ?? preview.plan.planDigest,
          mutationMayHaveApplied: true,
          nativeProof: proof,
        },
      );
    }
    if (status === "failed") {
      return this.mutationFailure(
        this.mapNativeErrorCode(execution.error),
        developerErrorMessage(execution.error) ||
          "Operon rejected the mutation.",
        operonId,
        false,
        { nativeStatus: status, nativeProof: proof },
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
          {
            nativeStatus: status,
            mutationMayHaveApplied: true,
            nativeProof: proof,
          },
        );
      }
      if (!appliedOperonId) {
        return this.mutationFailure(
          "failed",
          "Operon applied the create plan, but no unique created task was observable.",
          null,
          false,
          {
            nativeStatus: status,
            mutationMayHaveApplied: true,
            nativeProof: proof,
          },
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
      nativeProof: proof,
    };
  }

  async executeTaskWorkflow(
    kind: DeveloperApiTaskWorkflowKind,
    requested: Record<string, unknown>,
    dryRun: boolean,
    beforeApply?: () => Promise<TaskWorkflowBeforeApplyGateResult>,
  ): Promise<DeveloperApiMutationResult> {
    const api = this.taskWorkflowApis.get(kind);
    const methods = this.taskWorkflowMethods(api, kind);
    if (!methods?.preview || !methods.apply) {
      return this.mutationFailure(
        "not-ready",
        `Operon task-workflow Developer API grant is unavailable: ${kind}.`,
        null,
        true,
      );
    }

    let previewInput: Record<string, unknown>;
    let existingOperonId: string | null = null;
    let beforeIds = new Set(
      this.rawTasks.map((task) => task.identity.operonId),
    );
    try {
      if (kind === "adopt") {
        const targetPath = requested.targetPath;
        const line = Number(requested.line);
        const expectedLine = requested.expectedLine;
        if (
          !isCanonicalVaultRelativePath(targetPath) ||
          !targetPath.endsWith(".md")
        ) {
          throw new Error(
            "targetPath must be one canonical vault-relative Markdown path.",
          );
        }
        if (!Number.isInteger(line) || line < 1) {
          throw new Error("line must be a positive one-based line number.");
        }
        if (
          typeof expectedLine !== "string" ||
          expectedLine.length > 65_536 ||
          /[\r\n]/u.test(expectedLine)
        ) {
          throw new Error(
            "expectedLine must be one exact bounded source line.",
          );
        }
        const statusId = String(requested.statusId ?? "").trim();
        const terminalSourcePolicy = requested.terminalSourcePolicy;
        if (
          terminalSourcePolicy !== undefined &&
          terminalSourcePolicy !== "reopen"
        ) {
          throw new Error(
            "terminalSourcePolicy must be 'reopen' when supplied.",
          );
        }
        previewInput = {
          operation: "adopt-inline",
          source: {
            filePath: targetPath,
            lineNumber: line - 1,
            expectedLine,
          },
          ...(statusId ? { statusId } : {}),
          ...(terminalSourcePolicy ? { terminalSourcePolicy } : {}),
        };
      } else if (kind === "periodic-create") {
        if (
          requested.periodicKind !== "daily" &&
          requested.periodicKind !== "weekly"
        ) {
          throw new Error("periodicKind must be daily or weekly.");
        }
        if (
          requested.routeDate !== undefined &&
          !/^\d{4}-\d{2}-\d{2}$/u.test(String(requested.routeDate))
        ) {
          throw new Error("routeDate must be an ISO date key (YYYY-MM-DD).");
        }
        if (
          requested.targetPath !== undefined ||
          requested.parentTask !== undefined
        ) {
          throw new Error(
            "Periodic-note creation owns routing and parentage; targetPath and parentTask are not accepted.",
          );
        }
        const mapped = this.mapCreateInput({ ...requested, source: "inline" });
        const item = (mapped.spec.items as Record<string, unknown>[])[0];
        previewInput = {
          operation: "create",
          items: [
            {
              ...item,
              target: {
                representation: "inline",
                mode: "periodic-note",
                periodicKind: requested.periodicKind,
                ...(requested.routeDate
                  ? { routeDate: String(requested.routeDate) }
                  : {}),
              },
            },
          ],
        };
      } else {
        existingOperonId = String(requested.operonId ?? "").trim();
        if (!existingOperonId) throw new Error("operonId is required.");
        const requestKeys = Object.keys(requested);
        if (requestKeys.some((key) => key !== "operonId" && key !== "fields")) {
          throw new Error(
            "Periodic-note update accepts only operonId and fields.dateScheduled.",
          );
        }
        const fields = requested.fields;
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
          throw new Error(
            "Periodic-note update requires fields.dateScheduled.",
          );
        }
        const fieldEntries = Object.entries(fields as Record<string, unknown>);
        if (
          fieldEntries.length !== 1 ||
          fieldEntries[0]?.[0] !== "dateScheduled"
        ) {
          throw new Error(
            "Periodic-note update accepts exactly fields.dateScheduled.",
          );
        }
        const dateScheduled = fieldEntries[0][1];
        if (
          dateScheduled !== null &&
          (typeof dateScheduled !== "string" || !dateScheduled.trim())
        ) {
          throw new Error(
            "fields.dateScheduled must be a non-empty date string or null.",
          );
        }
        const readApi = this.readApi;
        if (!readApi)
          throw new Error("Operon live read session is unavailable.");
        const task = await this.getExactTask(readApi, existingOperonId);
        if (!task)
          throw new Error(`Operon task not found: ${existingOperonId}.`);
        const mapped = await this.mapMutationInput(
          readApi,
          "update",
          task,
          requested,
        );
        previewInput = {
          operation: "update-periodic-note",
          target: mapped.target,
          changes: mapped.spec.changes,
        };
      }
    } catch (error) {
      return this.mutationFailure(
        "invalid-input",
        error instanceof Error ? error.message : String(error),
        existingOperonId,
        false,
      );
    }

    let preview: TaskWorkflowDeveloperMutationPreviewResult;
    try {
      preview = await methods.preview(previewInput);
    } catch (error) {
      return this.mutationFailure(
        "failed",
        error instanceof Error ? error.message : String(error),
        existingOperonId,
        false,
      );
    }
    const previewViolation = this.taskWorkflowPreviewViolation(preview);
    if (previewViolation) {
      return this.mutationFailure(
        "failed",
        `Operon returned an invalid task-workflow preview result; apply was not dispatched: ${previewViolation}`,
        existingOperonId,
        false,
        { mutationMayHaveApplied: false },
      );
    }
    if (!preview.ok || !preview.plan) {
      return this.mutationFailure(
        this.mapNativeErrorCode(preview.error),
        developerErrorMessage(preview.error),
        existingOperonId,
        false,
      );
    }
    const planViolation = this.taskWorkflowPlanViolation(preview.plan);
    if (planViolation) {
      return this.mutationFailure(
        "failed",
        `Operon returned an invalid task-workflow plan; apply was not dispatched: ${planViolation}`,
        existingOperonId,
        false,
        { mutationMayHaveApplied: false },
      );
    }
    const plan = this.taskWorkflowPlanMetadata(preview.plan, kind);
    if (dryRun) {
      return {
        ok: true,
        operonId: existingOperonId,
        code: "planned",
        nativeStatus: "planned",
        plan,
        planDigest: preview.plan.planDigest,
        recoveryRef: preview.plan.recoveryRef,
        retryable: false,
      };
    }

    if (beforeApply) {
      let gate: TaskWorkflowBeforeApplyGateResult;
      try {
        gate = await beforeApply();
      } catch (error) {
        return this.mutationFailure(
          "failed",
          `The pre-apply revision gate could not be verified: ${error instanceof Error ? error.message : String(error)}`,
          existingOperonId,
          true,
          {
            nativeStatus: "planned-not-applied",
            planDigest: preview.plan.planDigest,
            recoveryRef: preview.plan.recoveryRef,
            mutationMayHaveApplied: false,
          },
        );
      }
      if (!gate.ok) {
        return this.mutationFailure(
          "conflict",
          gate.message ??
            "The task revision changed after preview; the sealed plan was not applied.",
          existingOperonId,
          true,
          {
            nativeStatus: "planned-not-applied",
            planDigest: preview.plan.planDigest,
            recoveryRef: preview.plan.recoveryRef,
            mutationMayHaveApplied: false,
          },
        );
      }
    }

    let execution: TaskWorkflowDeveloperMutationExecutionResult;
    try {
      execution = await withTimeout(
        methods.apply({ plan: preview.plan }),
        DEVELOPER_API_APPLY_TIMEOUT_MS,
      );
    } catch (error) {
      return this.mutationFailure(
        "outcome-unknown",
        `Operon task-workflow apply did not return a terminal result: ${error instanceof Error ? error.message : String(error)}`,
        existingOperonId,
        false,
        {
          nativeStatus: "timeout-or-transport-error",
          recoveryRef: preview.plan.recoveryRef,
          planDigest: preview.plan.planDigest,
          mutationMayHaveApplied: true,
        },
      );
    }
    const terminal = this.projectTaskWorkflowExecution(
      execution,
      plan,
      existingOperonId,
    );
    if (!terminal.ok) return terminal;

    if (kind === "adopt") {
      const targetPath = String(requested.targetPath);
      const lineNumber = Number(requested.line) - 1;
      try {
        const replayedIdentity =
          execution.status === "already-applied"
            ? this.taskWorkflowIdentity(
                kind,
                preview.plan.planDigest,
              )
            : undefined;
        const adopted = await this.findUniqueLiveTaskAfterMutation(
          (task) =>
            (replayedIdentity
              ? task.identity.operonId === replayedIdentity
              : execution.status === "already-applied" ||
                !beforeIds.has(task.identity.operonId)) &&
            task.representation === "inline" &&
            task.locator.representation === "inline" &&
            task.locator.filePath === targetPath &&
            task.locator.lineNumber === lineNumber,
        );
        if (!adopted) {
          throw new Error(
            "no unique adopted task is visible at the sealed source line",
          );
        }
        await this.rememberTaskWorkflowIdentity(
          kind,
          preview.plan.planDigest,
          adopted.identity.operonId,
        );
        return { ...terminal, operonId: adopted.identity.operonId };
      } catch (error) {
        return this.mutationFailure(
          "outcome-unknown",
          `Operon applied adoption, but the adopted identity could not be proven: ${error instanceof Error ? error.message : String(error)}`,
          null,
          false,
          {
            nativeStatus: execution.status,
            planDigest: preview.plan.planDigest,
            recoveryRef: preview.plan.recoveryRef,
            mutationMayHaveApplied: true,
          },
        );
      }
    }
    if (kind === "periodic-create") {
      try {
        const provenResourceKeys = this.taskWorkflowResourceKeys(execution);
        const replayedIdentity =
          execution.status === "already-applied"
            ? this.taskWorkflowIdentity(
                kind,
                preview.plan.planDigest,
              )
            : undefined;
        const created = await this.findUniqueLiveTaskAfterMutation(
          (task) =>
            task.representation === "inline" &&
            this.periodicCreatedTaskMatchesRequest(task, requested) &&
            (execution.status === "already-applied"
              ? replayedIdentity
                ? task.identity.operonId === replayedIdentity
                : beforeIds.has(task.identity.operonId)
              : !beforeIds.has(task.identity.operonId) &&
                provenResourceKeys.has(task.locator.filePath)),
        );
        if (!created) {
          throw new Error(
            "no unique periodic task is linked to the committed native resource evidence",
          );
        }
        await this.rememberTaskWorkflowIdentity(
          kind,
          preview.plan.planDigest,
          created.identity.operonId,
        );
        return { ...terminal, operonId: created.identity.operonId };
      } catch (error) {
        return this.mutationFailure(
          "outcome-unknown",
          `Operon applied periodic-note creation, but the created identity could not be proven uniquely: ${error instanceof Error ? error.message : String(error)}`,
          null,
          false,
          {
            nativeStatus: execution.status,
            planDigest: preview.plan.planDigest,
            recoveryRef: preview.plan.recoveryRef,
            mutationMayHaveApplied: true,
          },
        );
      }
    }
    return terminal;
  }

  async pendingTaskWorkflowRecoveries(
    kind?: DeveloperApiTaskWorkflowKind,
  ): Promise<DeveloperApiPendingRecoveryResult> {
    const kinds = kind
      ? [kind]
      : (
          Object.keys(
            TASK_WORKFLOW_CAPABILITIES,
          ) as DeveloperApiTaskWorkflowKind[]
        ).filter((candidate) => this.hasTaskWorkflowRecoverySupport(candidate));
    if (kinds.length === 0) {
      return {
        ok: false,
        recoveries: [],
        message: "No Operon task-workflow recovery grant is available.",
      };
    }
    const recoveries: (DeveloperApiPendingRecovery & {
      workflowKind: DeveloperApiTaskWorkflowKind;
    })[] = [];
    for (const workflowKind of kinds) {
      const methods = this.taskWorkflowMethods(
        this.taskWorkflowApis.get(workflowKind),
        workflowKind,
      );
      if (!methods?.pendingRecoveries) {
        return {
          ok: false,
          recoveries: [],
          message: `Operon task-workflow recovery grant is unavailable: ${workflowKind}.`,
        };
      }
      try {
        const result = await methods.pendingRecoveries();
        const pendingViolation = this.taskWorkflowPendingViolation(result);
        if (pendingViolation) {
          return {
            ok: false,
            recoveries: [],
            message: `Operon returned invalid task-workflow pending recovery state: ${pendingViolation}`,
          };
        }
        if (!result.ok) {
          return {
            ok: false,
            recoveries: [],
            message: developerErrorMessage(result.error),
          };
        }
        for (const recovery of result.recoveries ?? []) {
          if (recovery.recoveryRef && recovery.planDigest) {
            this.taskWorkflowRecoveryDigests.set(
              `${workflowKind}:${recovery.recoveryRef}`,
              recovery.planDigest,
            );
          }
          recoveries.push({ ...recovery, workflowKind });
        }
      } catch (error) {
        return {
          ok: false,
          recoveries: [],
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, recoveries };
  }

  async recoverTaskWorkflow(
    kind: DeveloperApiTaskWorkflowKind,
    recoveryRef: string,
    expectedPlanDigest?: string,
  ): Promise<DeveloperApiMutationResult> {
    const methods = this.taskWorkflowMethods(
      this.taskWorkflowApis.get(kind),
      kind,
    );
    if (!methods?.recover) {
      return this.mutationFailure(
        "not-ready",
        `Operon task-workflow recovery grant is unavailable: ${kind}.`,
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
    const suppliedPlanDigest = String(expectedPlanDigest ?? "").trim();
    if (suppliedPlanDigest && !SHA256_HEX.test(suppliedPlanDigest)) {
      return this.mutationFailure(
        "invalid-input",
        "planDigest must be exactly 64 lowercase SHA-256 hexadecimal characters; native recovery was not dispatched.",
        null,
        false,
        {
          recoveryRef: normalizedRecoveryRef,
          mutationMayHaveApplied: true,
        },
      );
    }
    let planDigest =
      this.taskWorkflowRecoveryDigests.get(`${kind}:${normalizedRecoveryRef}`) ||
      "";
    if (planDigest && !SHA256_HEX.test(planDigest)) {
      return this.mutationFailure(
        "invalid-input",
        "The stored task-workflow planDigest is not valid lowercase SHA-256; native recovery was not dispatched.",
        null,
        false,
        {
          recoveryRef: normalizedRecoveryRef,
          mutationMayHaveApplied: true,
        },
      );
    }
    if (suppliedPlanDigest) {
      if (!methods.pendingRecoveries) {
        return this.mutationFailure(
          "not-ready",
          "The supplied planDigest cannot be proven because pending recovery state is unavailable; native recovery was not dispatched.",
          null,
          true,
          { recoveryRef: normalizedRecoveryRef, mutationMayHaveApplied: true },
        );
      }
      try {
        const pending = await methods.pendingRecoveries();
        if (this.taskWorkflowPendingViolation(pending) || !pending.ok) {
          throw new Error("invalid task-workflow pending recovery result");
        }
        const match = (pending.recoveries ?? []).find(
          (candidate) => candidate.recoveryRef === normalizedRecoveryRef,
        );
        const pendingPlanDigest = String(match?.planDigest ?? "").trim();
        if (!pendingPlanDigest || !SHA256_HEX.test(pendingPlanDigest)) {
          return this.mutationFailure(
            "not-ready",
            "The recovery reference is not present with a valid digest in pending recovery state; native recovery was not dispatched.",
            null,
            true,
            { recoveryRef: normalizedRecoveryRef, mutationMayHaveApplied: true },
          );
        }
        if (pendingPlanDigest !== suppliedPlanDigest) {
          return this.mutationFailure(
            "invalid-input",
            "planDigest does not match the pending native recovery; native recovery was not dispatched.",
            null,
            false,
            { recoveryRef: normalizedRecoveryRef, mutationMayHaveApplied: true },
          );
        }
        planDigest = pendingPlanDigest;
      } catch {
        return this.mutationFailure(
          "not-ready",
          "The supplied planDigest could not be proven from pending recovery state; native recovery was not dispatched.",
          null,
          true,
          { recoveryRef: normalizedRecoveryRef, mutationMayHaveApplied: true },
        );
      }
    } else if (!planDigest && methods.pendingRecoveries) {
      try {
        const pending = await methods.pendingRecoveries();
        if (this.taskWorkflowPendingViolation(pending) || !pending.ok) {
          throw new Error("invalid task-workflow pending recovery result");
        }
        const match = (pending.recoveries ?? []).find(
          (candidate) => candidate.recoveryRef === normalizedRecoveryRef,
        );
        planDigest = String(match?.planDigest ?? "").trim();
      } catch {
        // Recovery stays fail-closed when the sealed digest cannot be proven.
      }
    }
    if (planDigest && !SHA256_HEX.test(planDigest)) {
      return this.mutationFailure(
        "invalid-input",
        "Operon pending recovery state returned an invalid planDigest; native recovery was not dispatched.",
        null,
        false,
        {
          recoveryRef: normalizedRecoveryRef,
          mutationMayHaveApplied: true,
        },
      );
    }
    if (!planDigest) {
      return this.mutationFailure(
        "not-ready",
        "The recovery plan digest could not be proven from pending recovery state; the native recovery was not dispatched.",
        null,
        true,
        { recoveryRef: normalizedRecoveryRef, mutationMayHaveApplied: true },
      );
    }
    let execution: TaskWorkflowDeveloperMutationExecutionResult;
    try {
      execution = await methods.recover({ recoveryRef: normalizedRecoveryRef });
    } catch (error) {
      return this.mutationFailure(
        "outcome-unknown",
        `Operon task-workflow recovery did not return a terminal result: ${error instanceof Error ? error.message : String(error)}`,
        null,
        false,
        { recoveryRef: normalizedRecoveryRef, mutationMayHaveApplied: true },
      );
    }
    return this.projectTaskWorkflowExecution(
      execution,
      {
        recoveryRef: normalizedRecoveryRef,
        planDigest,
        mutationKind:
          kind === "adopt"
            ? "task.adopt"
            : kind === "periodic-create"
              ? "task.create"
              : "task.update",
      },
      null,
    );
  }

  private projectTaskWorkflowExecution(
    execution: TaskWorkflowDeveloperMutationExecutionResult,
    plan: Pick<
      DeveloperApiMutationPlan,
      "recoveryRef" | "planDigest" | "mutationKind"
    >,
    operonId: string | null,
  ): DeveloperApiMutationResult {
    const status = execution.status ?? "failed";
    const proof = this.taskWorkflowProof(execution);
    const invalid = this.taskWorkflowResultViolation(execution, plan);
    if (invalid) {
      return this.mutationFailure(
        "outcome-unknown",
        `Operon returned an invalid task-workflow result after dispatch: ${invalid}`,
        operonId,
        false,
        {
          nativeStatus: status,
          recoveryRef: execution.recovery?.recoveryRef ?? plan.recoveryRef,
          planDigest: plan.planDigest,
          mutationMayHaveApplied: true,
          nativeProof: proof,
        },
      );
    }
    if (status === "applied" || status === "already-applied") {
      return {
        ok: true,
        operonId,
        code: status,
        nativeStatus: status,
        planDigest: execution.receipt?.planDigest ?? plan.planDigest,
        recoveryRef: plan.recoveryRef,
        retryable: false,
        mutationMayHaveApplied: true,
        nativeProof: proof,
      };
    }
    if (status === "partial" || status === "outcome-unknown") {
      return this.mutationFailure(
        "outcome-unknown",
        developerErrorMessage(execution.error) ||
          "Operon requires recovery of the same task-workflow plan.",
        operonId,
        false,
        {
          nativeStatus: status,
          recoveryRef: execution.recovery?.recoveryRef ?? plan.recoveryRef,
          planDigest: execution.recovery?.planDigest ?? plan.planDigest,
          mutationMayHaveApplied: true,
          nativeProof: proof,
        },
      );
    }
    return this.mutationFailure(
      this.mapNativeErrorCode(execution.error),
      developerErrorMessage(execution.error),
      operonId,
      false,
      { nativeStatus: status, recoveryRef: plan.recoveryRef, nativeProof: proof },
    );
  }

  private taskWorkflowPlanViolation(
    plan: TaskWorkflowDeveloperMutationPlan,
  ): string | null {
    const allowedKeys = new Set([
      "contractVersion",
      "kind",
      "recoveryRef",
      "planDigest",
      "createdAt",
      "expiresAt",
      "riskLevel",
      "requiresConsent",
    ]);
    if (
      Object.keys(plan).length !== allowedKeys.size ||
      Object.keys(plan).some((key) => !allowedKeys.has(key)) ||
      [...allowedKeys].some(
        (key) => !Object.prototype.hasOwnProperty.call(plan, key),
      )
    )
      return "plan contains a non-public field";
    if (
      plan.contractVersion !== 1 ||
      plan.kind !== "task-workflow-developer-mutation-plan"
    )
      return "plan discriminator is invalid";
    if (!DEVELOPER_RECOVERY_REF.test(plan.recoveryRef))
      return "recoveryRef is invalid";
    if (!SHA256_HEX.test(plan.planDigest))
      return "planDigest must be lowercase SHA-256 hex";
    const createdAt = Date.parse(plan.createdAt);
    const expiresAt = Date.parse(plan.expiresAt);
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= createdAt
    ) return "plan timestamps are invalid";
    if (!["none", "routine", "elevated", "destructive"].includes(plan.riskLevel))
      return "riskLevel is invalid";
    if (typeof plan.requiresConsent !== "boolean")
      return "requiresConsent must be boolean";
    return null;
  }

  private taskWorkflowPreviewViolation(
    preview: TaskWorkflowDeveloperMutationPreviewResult,
  ): string | null {
    if (preview.contractVersion !== 1)
      return "contractVersion must equal 1";
    if (preview.kind !== "task-workflow-developer-mutation-preview-result")
      return "kind must be task-workflow-developer-mutation-preview-result";
    if (
      typeof preview.requestId !== "string" ||
      !preview.requestId ||
      preview.requestId.length > 128
    ) return "requestId is invalid";
    if (!Array.isArray(preview.warnings)) return "warnings must be an array";
    if (preview.ok) {
      if (!preview.plan || preview.error !== undefined)
        return "successful preview union is inconsistent";
      return null;
    }
    if (preview.plan !== undefined || !isRecord(preview.error))
      return "failed preview union is inconsistent";
    return null;
  }

  private taskWorkflowPendingViolation(
    pending: DeveloperApiPendingRecoveriesResult,
  ): string | null {
    if (pending.contractVersion !== 1)
      return "contractVersion must equal 1";
    if (
      pending.kind !==
      "task-workflow-developer-pending-recoveries-result"
    )
      return "kind must be task-workflow-developer-pending-recoveries-result";
    if (pending.ok) {
      if (!Array.isArray(pending.recoveries) || pending.error !== undefined)
        return "successful pending recovery union is inconsistent";
      if (
        pending.recoveries.length > 512 ||
        pending.recoveries.some((recovery) => {
          const createdAt = Date.parse(String(recovery.createdAt ?? ""));
          const expiresAt = Date.parse(String(recovery.expiresAt ?? ""));
          return (
            !DEVELOPER_RECOVERY_REF.test(String(recovery.recoveryRef ?? "")) ||
            !SHA256_HEX.test(String(recovery.planDigest ?? "")) ||
            !Number.isFinite(createdAt) ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= createdAt
          );
        })
      ) return "pending recovery entries are invalid or unbounded";
      return null;
    }
    if (pending.recoveries !== undefined || !isRecord(pending.error))
      return "failed pending recovery union is inconsistent";
    return null;
  }

  private baseMutationResultViolation(
    execution: DeveloperApiMutationExecutionResult,
    plan: DeveloperApiMutationPlan,
  ): string | null {
    if (execution.contractVersion !== 1) return "contractVersion must equal 1";
    if (execution.kind !== "developer-mutation-execution-result")
      return "kind must be developer-mutation-execution-result";
    if (
      typeof execution.requestId !== "string" ||
      !execution.requestId ||
      execution.requestId.length > 128
    ) return "requestId is invalid";
    if (
      typeof plan.planDigest !== "string" ||
      !SHA256_HEX.test(plan.planDigest) ||
      typeof plan.mutationKind !== "string" ||
      !plan.mutationKind ||
      plan.mutationKind.length > 128
    ) return "sealed preview plan identity is invalid";
    if (
      !Array.isArray(execution.groupResults) ||
      execution.groupResults.length > 32
    ) return "groupResults must be a bounded array";
    const resourceKinds = new Set([
      "timer",
      "repeat-series",
      "active-tracker",
      "pinned",
      "project-serial",
      "task-source",
    ]);
    for (const group of execution.groupResults) {
      if (
        typeof group.groupId !== "string" ||
        !group.groupId ||
        group.groupId.length > 256 ||
        !["committed", "failed", "outcome-unknown"].includes(
          String(group.status),
        ) ||
        (group.resourceRevisions !== undefined &&
          (!Array.isArray(group.resourceRevisions) ||
            group.resourceRevisions.length > 64))
      ) return "groupResults contain an invalid group";
      for (const revision of group.resourceRevisions ?? []) {
        if (
          !resourceKinds.has(String(revision.resourceKind)) ||
          typeof revision.resourceKey !== "string" ||
          !revision.resourceKey ||
          revision.resourceKey.length > 1024 ||
          typeof revision.revision !== "string" ||
          !revision.revision ||
          revision.revision.length > 256
        ) return "groupResults contain an invalid resource revision";
      }
    }
    const receipt = execution.receipt;
    const receiptMatches =
      receipt?.contractVersion === 1 &&
      receipt.planDigest === plan.planDigest &&
      receipt.mutationKind === plan.mutationKind &&
      typeof receipt.targetDigest === "string" &&
      SHA256_HEX.test(receipt.targetDigest) &&
      typeof receipt.effectiveAt === "string" &&
      Number.isFinite(Date.parse(receipt.effectiveAt)) &&
      typeof receipt.completedAt === "string" &&
      Number.isFinite(Date.parse(receipt.completedAt)) &&
      typeof receipt.expiresAt === "string" &&
      Number.isFinite(Date.parse(receipt.expiresAt));
    if (execution.status === "applied") {
      if (
        execution.mutationMayHaveApplied !== true ||
        execution.retryAllowed !== false ||
        execution.error !== undefined ||
        execution.recovery !== undefined ||
        execution.groupResults.length === 0 ||
        execution.groupResults.some((group) => group.status !== "committed") ||
        !receiptMatches ||
        receipt?.terminalOutcome !== "applied" ||
        execution.postflight?.status !== "verified" ||
        typeof execution.postflight.observedAt !== "string" ||
        !Number.isFinite(Date.parse(execution.postflight.observedAt))
      ) return "applied union is inconsistent with the sealed plan";
      return null;
    }
    if (execution.status === "already-applied") {
      if (
        execution.mutationMayHaveApplied !== true ||
        execution.retryAllowed !== false ||
        execution.error !== undefined ||
        execution.recovery !== undefined ||
        execution.groupResults.length !== 0 ||
        !receiptMatches ||
        receipt?.terminalOutcome !== "already-applied" ||
        execution.postflight?.status !== "receipt-replay"
      ) return "already-applied union is inconsistent with the sealed plan";
      return null;
    }
    if (execution.status === "failed") {
      if (
        execution.mutationMayHaveApplied !== false ||
        execution.retryAllowed !== false ||
        !isRecord(execution.error) ||
        execution.receipt !== undefined ||
        execution.postflight !== undefined ||
        execution.recovery !== undefined ||
        execution.groupResults.some(
          (group) =>
            group.status === "committed" || group.status === "outcome-unknown",
        )
      ) return "failed union contains side-effect evidence";
      return null;
    }
    if (
      execution.status === "partial" ||
      execution.status === "outcome-unknown"
    ) {
      const recovery = execution.recovery;
      if (
        execution.mutationMayHaveApplied !== true ||
        execution.retryAllowed !== false ||
        !isRecord(execution.error) ||
        execution.receipt !== undefined ||
        execution.postflight !== undefined ||
        recovery?.required !== true ||
        recovery.action !== "recover-same-plan" ||
        recovery.mutationMayHaveApplied !== true ||
        recovery.recoveryRef !== plan.recoveryRef ||
        recovery.planDigest !== plan.planDigest ||
        !recovery.plan ||
        recovery.plan.recoveryRef !== plan.recoveryRef ||
        recovery.plan.planDigest !== plan.planDigest ||
        recovery.plan.mutationKind !== plan.mutationKind
      ) return "uncertain union does not preserve the same sealed plan";
      return null;
    }
    return "status is not part of the Developer API mutation result union";
  }

  private baseMutationProof(
    execution: DeveloperApiMutationExecutionResult,
  ): DeveloperApiTaskWorkflowNativeProof {
    type ProofGroup = DeveloperApiTaskWorkflowNativeProof["groupResults"][number];
    type ProofRevision = NonNullable<ProofGroup["resourceRevisions"]>[number];
    const groupResults: ProofGroup[] = (execution.groupResults ?? []).map(
      (group) => {
        const resourceRevisions: ProofRevision[] = (
          group.resourceRevisions ?? []
        ).map((revision) => ({
          resourceKind: revision.resourceKind as ProofRevision["resourceKind"],
          resourceKey: revision.resourceKey as string,
          revision: revision.revision as string,
        }));
        return {
          groupId: group.groupId as string,
          status: group.status as ProofGroup["status"],
          ...(group.resourceRevisions ? { resourceRevisions } : {}),
        };
      },
    );
    const receipt = execution.receipt;
    const postflight = execution.postflight;
    return {
      contractVersion: 1,
      kind: "mutation-result",
      status: execution.status as DeveloperApiTaskWorkflowNativeProof["status"],
      mutationMayHaveApplied: execution.mutationMayHaveApplied as boolean,
      retryAllowed: execution.retryAllowed as boolean,
      groupResults,
      ...(receipt
        ? {
            receipt: {
              contractVersion: 1,
              planDigest: receipt.planDigest as string,
              mutationKind: receipt.mutationKind as string,
              targetDigest: receipt.targetDigest as string,
              terminalOutcome: receipt.terminalOutcome as
                | "applied"
                | "already-applied",
              effectiveAt: receipt.effectiveAt as string,
              completedAt: receipt.completedAt as string,
              expiresAt: receipt.expiresAt as string,
            },
          }
        : {}),
      ...(postflight?.status === "verified" ||
      postflight?.status === "receipt-replay"
        ? {
            postflight: {
              status: postflight.status,
              ...(typeof postflight.observedAt === "string"
                ? { observedAt: postflight.observedAt }
                : {}),
            },
          }
        : {}),
    };
  }

  private taskWorkflowProof(
    execution: TaskWorkflowDeveloperMutationExecutionResult,
  ): DeveloperApiTaskWorkflowNativeProof | undefined {
    const statuses = new Set([
      "applied",
      "already-applied",
      "partial",
      "failed",
      "outcome-unknown",
    ] as const);
    const groupStatuses = new Set([
      "committed",
      "failed",
      "outcome-unknown",
    ] as const);
    const resourceKinds = new Set([
      "timer",
      "repeat-series",
      "active-tracker",
      "pinned",
      "project-serial",
      "task-source",
    ] as const);
    const mutationKinds = new Set([
      "task.adopt",
      "task.create",
      "task.update",
    ] as const);
    if (
      execution.contractVersion !== 1 ||
      execution.kind !==
        "task-workflow-developer-mutation-execution-result" ||
      !statuses.has(execution.status as never) ||
      typeof execution.mutationMayHaveApplied !== "boolean" ||
      typeof execution.retryAllowed !== "boolean" ||
      !Array.isArray(execution.groupResults) ||
      execution.groupResults.length > 32
    ) return undefined;
    type ProofGroup = DeveloperApiTaskWorkflowNativeProof["groupResults"][number];
    type ProofRevision = NonNullable<ProofGroup["resourceRevisions"]>[number];
    const groupResults: ProofGroup[] = [];
    for (const group of execution.groupResults) {
      if (
        typeof group.groupId !== "string" ||
        !group.groupId ||
        group.groupId.length > 256 ||
        !groupStatuses.has(group.status as never) ||
        (group.resourceRevisions !== undefined &&
          (!Array.isArray(group.resourceRevisions) ||
            group.resourceRevisions.length > 64))
      ) return undefined;
      const resourceRevisions: ProofRevision[] = [];
      for (const revision of group.resourceRevisions ?? []) {
        if (
          !resourceKinds.has(revision.resourceKind as never) ||
          typeof revision.resourceKey !== "string" ||
          !revision.resourceKey ||
          revision.resourceKey.length > 1024 ||
          typeof revision.revision !== "string" ||
          !revision.revision ||
          revision.revision.length > 256
        ) return undefined;
        resourceRevisions.push({
          resourceKind: revision.resourceKind as ProofRevision["resourceKind"],
          resourceKey: revision.resourceKey,
          revision: revision.revision,
        });
      }
      groupResults.push({
        groupId: group.groupId,
        status: group.status as ProofGroup["status"],
        ...(group.resourceRevisions ? { resourceRevisions } : {}),
      });
    }
    const receipt = execution.receipt;
    const projectedReceipt: DeveloperApiTaskWorkflowNativeProof["receipt"] =
      receipt?.contractVersion === 1 &&
      typeof receipt.planDigest === "string" &&
      SHA256_HEX.test(receipt.planDigest) &&
      mutationKinds.has(receipt.mutationKind as never) &&
      typeof receipt.targetDigest === "string" &&
      SHA256_HEX.test(receipt.targetDigest) &&
      (receipt.terminalOutcome === "applied" ||
        receipt.terminalOutcome === "already-applied") &&
      typeof receipt.effectiveAt === "string" &&
      Number.isFinite(Date.parse(receipt.effectiveAt)) &&
      typeof receipt.completedAt === "string" &&
      Number.isFinite(Date.parse(receipt.completedAt)) &&
      typeof receipt.expiresAt === "string"
      && Number.isFinite(Date.parse(receipt.expiresAt))
        ? {
            contractVersion: 1 as const,
            planDigest: receipt.planDigest,
            mutationKind: receipt.mutationKind as NonNullable<
              DeveloperApiTaskWorkflowNativeProof["receipt"]
            >["mutationKind"],
            targetDigest: receipt.targetDigest,
            terminalOutcome: receipt.terminalOutcome as NonNullable<
              DeveloperApiTaskWorkflowNativeProof["receipt"]
            >["terminalOutcome"],
            effectiveAt: receipt.effectiveAt.slice(0, 64),
            completedAt: receipt.completedAt.slice(0, 64),
            expiresAt: receipt.expiresAt.slice(0, 64),
          }
        : undefined;
    const postflight = execution.postflight;
    const projectedPostflight:
      | DeveloperApiTaskWorkflowNativeProof["postflight"]
      | undefined =
      postflight?.status === "verified" ||
      postflight?.status === "receipt-replay"
        ? {
            status: postflight.status,
            ...(typeof postflight.observedAt === "string"
              ? {
                  observedAt: Number.isFinite(Date.parse(postflight.observedAt))
                    ? postflight.observedAt.slice(0, 64)
                    : undefined,
                }
              : {}),
          }
        : undefined;
    return {
      contractVersion: 1,
      kind: "mutation-result",
      status: execution.status as DeveloperApiTaskWorkflowNativeProof["status"],
      mutationMayHaveApplied: execution.mutationMayHaveApplied,
      retryAllowed: execution.retryAllowed,
      groupResults,
      ...(projectedReceipt ? { receipt: projectedReceipt } : {}),
      ...(projectedPostflight ? { postflight: projectedPostflight } : {}),
    };
  }

  private taskWorkflowResourceKeys(
    execution: TaskWorkflowDeveloperMutationExecutionResult,
  ): Set<string> {
    const keys = new Set<string>();
    for (const group of execution.groupResults ?? []) {
      for (const revision of group.resourceRevisions ?? []) {
        if (!isRecord(revision)) continue;
        if (
          revision.resourceKind === "task-source" &&
          typeof revision.resourceKey === "string" &&
          revision.resourceKey
        ) keys.add(revision.resourceKey);
      }
    }
    return keys;
  }

  private taskWorkflowIdentity(
    kind: DeveloperApiTaskWorkflowKind,
    planDigest: string,
  ): string | undefined {
    const key = `${kind}:${planDigest}`;
    return (
      this.taskWorkflowIdentityStore?.get(key) ??
      this.taskWorkflowIdentityByPlanDigest.get(key)
    );
  }

  private async rememberTaskWorkflowIdentity(
    kind: DeveloperApiTaskWorkflowKind,
    planDigest: string,
    operonId: string,
  ): Promise<void> {
    const key = `${kind}:${planDigest}`;
    if (this.taskWorkflowIdentityStore) {
      await this.taskWorkflowIdentityStore.set(key, operonId);
      return;
    }
    this.taskWorkflowIdentityByPlanDigest.delete(key);
    this.taskWorkflowIdentityByPlanDigest.set(key, operonId);
    if (this.taskWorkflowIdentityByPlanDigest.size <= 512) return;
    const oldest = this.taskWorkflowIdentityByPlanDigest.keys().next().value;
    if (typeof oldest === "string")
      this.taskWorkflowIdentityByPlanDigest.delete(oldest);
  }

  private periodicCreatedTaskMatchesRequest(
    task: DeveloperApiTask,
    requested: Record<string, unknown>,
  ): boolean {
    if (task.description !== String(requested.description ?? "").trim())
      return false;
    const fields = isRecord(requested.fields) ? requested.fields : {};
    const requestedPriorityId =
      String(requested.priorityId ?? "").trim() ||
      (Object.prototype.hasOwnProperty.call(fields, "priority")
        ? this.resolvePriorityId(fields.priority)
        : null);
    if (requestedPriorityId && task.priority?.id !== requestedPriorityId)
      return false;
    const requestedStatusId =
      String(requested.statusId ?? "").trim() ||
      (Object.prototype.hasOwnProperty.call(fields, "status")
        ? this.resolveStatusId(fields.status)
        : null);
    if (requestedStatusId && task.workflow?.status.id !== requestedStatusId)
      return false;
    const runtime = toRuntimeTask(task);
    if (Array.isArray(requested.tags)) {
      const normalizeTags = (values: readonly unknown[]) =>
        [
          ...new Set(
            values
              .map(String)
              .map((tag) => tag.trim().replace(/^#/u, "").trim())
              .filter(Boolean),
          ),
        ].sort();
      if (
        JSON.stringify(normalizeTags(runtime.tags)) !==
        JSON.stringify(normalizeTags(requested.tags))
      ) return false;
    }
    for (const [field, value] of Object.entries(fields)) {
      if (field === "priority" || field === "status") continue;
      const canonical = this.canonicalField(field);
      const expected = fieldValue(value);
      const actual = runtime.fieldValues[canonical];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    }
    return true;
  }

  private taskWorkflowResultViolation(
    execution: TaskWorkflowDeveloperMutationExecutionResult,
    plan: Pick<
      DeveloperApiMutationPlan,
      "recoveryRef" | "planDigest" | "mutationKind"
    >,
  ): string | null {
    if (execution.contractVersion !== 1) return "contractVersion must equal 1";
    if (
      execution.kind !==
      "task-workflow-developer-mutation-execution-result"
    )
      return "kind must be task-workflow-developer-mutation-execution-result";
    if (
      typeof execution.requestId !== "string" ||
      !execution.requestId ||
      execution.requestId.length > 128
    ) return "requestId is invalid";
    if (!Array.isArray(execution.groupResults)) return "groupResults must be an array";
    const status = execution.status;
    const groups = execution.groupResults;
    const receipt = execution.receipt;
    const digestMatches =
      receipt?.contractVersion === 1 &&
      typeof receipt.planDigest === "string" &&
      SHA256_HEX.test(receipt.planDigest) &&
      receipt.planDigest === plan.planDigest;
    const receiptStructureMatches =
      digestMatches &&
      receipt?.mutationKind === plan.mutationKind &&
      typeof receipt.targetDigest === "string" &&
      SHA256_HEX.test(receipt.targetDigest) &&
      typeof receipt.effectiveAt === "string" &&
      Number.isFinite(Date.parse(receipt.effectiveAt)) &&
      typeof receipt.completedAt === "string" &&
      Number.isFinite(Date.parse(receipt.completedAt)) &&
      typeof receipt.expiresAt === "string" &&
      Number.isFinite(Date.parse(receipt.expiresAt));
    if (status === "applied") {
      if (
        execution.mutationMayHaveApplied !== true ||
        execution.retryAllowed !== false ||
        execution.error !== undefined ||
        execution.recovery !== undefined
      ) return "applied must be terminal and non-retryable";
      if (
        groups.length === 0 ||
        groups.some(
          (group) =>
            !group ||
            typeof group.groupId !== "string" ||
            !group.groupId ||
            group.status !== "committed" ||
            (group.resourceRevisions !== undefined &&
              (!Array.isArray(group.resourceRevisions) ||
                group.resourceRevisions.length > 64 ||
                group.resourceRevisions.some(
                  (revision: {
                    resourceKind?: string;
                    resourceKey?: string;
                    revision?: string;
                  }) =>
                    typeof revision.resourceKind !== "string" ||
                    !revision.resourceKind ||
                    typeof revision.resourceKey !== "string" ||
                    !revision.resourceKey ||
                    typeof revision.revision !== "string" ||
                    !revision.revision,
                ))),
        )
      ) return "applied requires non-empty committed groupResults";
      if (new Set(groups.map((group) => group.groupId)).size !== groups.length)
        return "groupResults contain duplicate group ids";
      if (!receiptStructureMatches || receipt?.terminalOutcome !== "applied")
        return "applied receipt does not match the sealed plan";
      if (
        execution.postflight?.status !== "verified" ||
        typeof execution.postflight.observedAt !== "string" ||
        !Number.isFinite(Date.parse(execution.postflight.observedAt))
      )
        return "applied requires verified postflight";
      return null;
    }
    if (status === "already-applied") {
      if (
        execution.mutationMayHaveApplied !== true ||
        execution.retryAllowed !== false ||
        groups.length !== 0 ||
        execution.error !== undefined ||
        execution.recovery !== undefined
      ) return "already-applied requires no new groups and no retry";
      if (!receiptStructureMatches || receipt?.terminalOutcome !== "already-applied")
        return "already-applied receipt does not match the sealed plan";
      if (execution.postflight?.status !== "receipt-replay")
        return "already-applied requires receipt-replay postflight";
      return null;
    }
    if (status === "failed") {
      if (
        execution.mutationMayHaveApplied !== false ||
        execution.retryAllowed !== false ||
        !execution.error ||
        receipt ||
        execution.postflight ||
        execution.recovery ||
        groups.some((group) => group.status === "committed" || group.status === "outcome-unknown")
      ) return "failed result has inconsistent side-effect evidence";
      return null;
    }
    if (status === "partial" || status === "outcome-unknown") {
      const recovery = execution.recovery;
      if (
        execution.mutationMayHaveApplied !== true ||
        execution.retryAllowed !== false ||
        !execution.error ||
        execution.receipt !== undefined ||
        execution.postflight !== undefined ||
        recovery?.required !== true ||
        recovery.action !== "recover-same-plan" ||
        recovery.mutationMayHaveApplied !== true ||
        recovery.recoveryRef !== plan.recoveryRef ||
        recovery.planDigest !== plan.planDigest ||
        !recovery.plan ||
        this.taskWorkflowPlanViolation(recovery.plan) !== null ||
        recovery.plan.recoveryRef !== recovery.recoveryRef ||
        recovery.plan.planDigest !== recovery.planDigest
      ) return "uncertain result must be non-retryable and may have applied";
      return null;
    }
    return "status is not part of the task-workflow result union";
  }

  private taskWorkflowPlanMetadata(
    plan: TaskWorkflowDeveloperMutationPlan,
    kind: DeveloperApiTaskWorkflowKind,
  ): DeveloperApiMutationPlan {
    return {
      planDigest: plan.planDigest,
      recoveryRef: plan.recoveryRef,
      capability: TASK_WORKFLOW_CAPABILITIES[kind][0],
      mutationKind:
        kind === "adopt"
          ? "task.adopt"
          : kind === "periodic-create"
            ? "task.create"
            : "task.update",
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      riskLevel: plan.riskLevel,
      requiresConsent: plan.requiresConsent,
    };
  }

  private async reloadLiveTasks(): Promise<{
    tasks: RuntimeIndexedTask[];
    rawTasks: DeveloperApiTask[];
  }> {
    if (!this.readApi)
      throw new Error("Operon live read session is unavailable.");
    const live = await this.readAllTasks(this.readApi);
    this.tasks = live.tasks;
    this.rawTasks = live.rawTasks;
    this.indexer.taskCount = live.tasks.length;
    if (live.generation !== null) this.generation = live.generation;
    return live;
  }

  private async findUniqueLiveTaskAfterMutation(
    predicate: (task: DeveloperApiTask) => boolean,
  ): Promise<DeveloperApiTask | null> {
    let lastError: unknown = null;
    for (const delayMs of POST_APPLY_IDENTITY_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, delayMs);
        });
      }
      try {
        const live = await this.reloadLiveTasks();
        const matches = live.rawTasks.filter(predicate);
        if (matches.length === 1) return matches[0]!;
        lastError = new Error(
          `post-apply identity match count remained ${matches.length}`,
        );
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  async refreshLiveTaskSnapshot(): Promise<void> {
    await this.reloadLiveTasks();
  }

  async pendingRecoveries(): Promise<DeveloperApiPendingRecoveryResult> {
    const api = this.recoveryApi;
    const pending = api?.mutations?.pendingRecoveries;
    if (!api || !pending) {
      return {
        ok: false,
        recoveries: [],
        message:
          "Operon Developer API V1 pending-recovery support is unavailable.",
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

  async recoverMutation(
    recoveryRef: string,
  ): Promise<DeveloperApiMutationResult> {
    const api = this.recoveryApi;
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
        planDigest:
          execution.receipt?.planDigest ?? execution.recovery?.planDigest,
        recoveryRef: execution.recovery?.recoveryRef ?? normalizedRecoveryRef,
        retryable: false,
        mutationMayHaveApplied: execution.mutationMayHaveApplied ?? true,
      };
    }
    if (status === "partial" || status === "outcome-unknown") {
      return this.mutationFailure(
        "outcome-unknown",
        developerErrorMessage(execution.error) ||
          "Operon still requires recovery of the same mutation plan.",
        null,
        false,
        {
          nativeStatus: status,
          recoveryRef: execution.recovery?.recoveryRef ?? normalizedRecoveryRef,
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

  private mapNativeErrorCode(
    error: DeveloperApiError | undefined,
  ): DeveloperApiMutationResult["code"] {
    const code = String(error?.code ?? "").toLocaleLowerCase();
    if (
      code === "stale-source" ||
      code.includes("conflict") ||
      code.includes("revision")
    )
      return "conflict";
    if (code.includes("not-found") || code.includes("missing"))
      return "not-found";
    if (code.includes("invalid") || code.includes("validation"))
      return "invalid-input";
    if (
      code.includes("authority") ||
      code.includes("grant") ||
      code.includes("capability")
    )
      return "not-ready";
    return "rejected";
  }

  private async getExactTask(
    api: DeveloperApiV1,
    operonId: string,
  ): Promise<DeveloperApiTask | null> {
    if (!api.tasks.get) {
      return (
        this.rawTasks.find((task) => task.identity.operonId === operonId) ??
        null
      );
    }
    const result = await api.tasks.get({
      contractVersion: 1,
      requestId: requestId(),
      kind: "task-get",
      consistency: "live-verified",
      selector: { kind: "operon-id", operonId },
      include: [
        "notes",
        "links",
        "custom-fields",
        "source-markdown",
        "writable-fields",
      ],
    });
    if (!result.ok) {
      if (this.mapNativeErrorCode(result.error) === "not-found") return null;
      throw new Error(developerErrorMessage(result.error));
    }
    return result.task ?? null;
  }

  private exactTarget(task: DeveloperApiTask): Record<string, unknown> {
    if (
      task.representation === "inline" &&
      task.locator.representation === "inline"
    ) {
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
      (candidate) =>
        candidate.canonicalKey === field ||
        candidate.visiblePropertyName === field,
    );
    return mapping?.canonicalKey ?? field;
  }

  private fieldType(field: string): string | null {
    const canonical = this.canonicalField(field);
    const mapping = this.keyMappings.find(
      (candidate) => candidate.canonicalKey === canonical,
    );
    if (mapping?.mappingStatus && mapping.mappingStatus !== "mapped")
      return null;
    if (mapping?.mutationClass && mapping.mutationClass !== "general-update")
      return null;
    const candidate = String(
      mapping?.type ?? GENERAL_FIELD_TYPES[canonical] ?? "",
    ).toLocaleLowerCase();
    return ["text", "date", "datetime", "number", "list", "checkbox"].includes(
      candidate,
    )
      ? candidate
      : null;
  }

  private isCustomGeneralField(field: string): boolean {
    const canonical = this.canonicalField(field);
    const mapping = this.keyMappings.find(
      (candidate) => candidate.canonicalKey === canonical,
    );
    return (
      mapping?.source === "custom" &&
      mapping.mappingStatus === "mapped" &&
      mapping.mutationClass === "general-update"
    );
  }

  private updateValue(field: string, value: unknown): Record<string, unknown> {
    const canonical = this.canonicalField(field);
    const valueType = this.fieldType(canonical);
    if (!valueType)
      throw new Error(
        `Managed field '${field}' is not writable through the official Developer API.`,
      );
    if (value === null || value === undefined || value === "") {
      return { operation: "clear", field: canonical, valueType };
    }
    if (valueType === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed))
        throw new Error(`Field '${field}' requires a finite number.`);
      return { field: canonical, valueType, value: parsed };
    }
    if (valueType === "list") {
      if (canonical === "taskGallery" && !Array.isArray(value)) {
        throw new Error(
          "Field 'taskGallery' requires an ordered string array; the Bridge never splits media references heuristically.",
        );
      }
      const values = Array.isArray(value)
        ? value
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean)
        : String(value)
            .split(/[;,]/u)
            .map((item) => item.trim())
            .filter(Boolean);
      return { field: canonical, valueType, value: values };
    }
    if (valueType === "checkbox") {
      const normalized = String(value).toLocaleLowerCase();
      if (
        !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(
          normalized,
        )
      ) {
        throw new Error(`Field '${field}' requires a boolean value.`);
      }
      return {
        field: canonical,
        valueType,
        value: ["true", "1", "yes", "on"].includes(normalized),
      };
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
    return unique.length === 1 ? (unique[0] ?? null) : null;
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
        throw new Error(
          "Unmanaged properties are not exposed by Operon Developer API V1; no raw Markdown fallback is used.",
        );
      }
      const changes: Record<string, unknown>[] = [];
      if (Object.prototype.hasOwnProperty.call(requested, "description")) {
        changes.push(this.updateValue("description", requested.description));
      }
      if (Array.isArray(requested.tags))
        changes.push(this.updateValue("tags", requested.tags));
      const fields = requested.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        for (const [field, value] of Object.entries(
          fields as Record<string, unknown>,
        )) {
          if (field === "status")
            throw new Error("Use the transition route for status changes.");
          const canonical = this.canonicalField(field);
          if (canonical === "priority") {
            const priorityId = this.resolvePriorityId(value);
            if (!priorityId)
              throw new Error(
                "fields.priority must resolve to one stable Operon priority id.",
              );
            changes.push(this.updateValue(canonical, priorityId));
          } else {
            changes.push(this.updateValue(canonical, value));
          }
        }
      }
      if (changes.length === 0)
        throw new Error("The update contains no official writable field.");
      return {
        capability: "tasks.update.preview",
        mutationKind: "task.update",
        target,
        spec: { operation: "update", changes },
      };
    }
    if (capability === "transition") {
      const statusId =
        String(requested.statusId ?? "").trim() ||
        this.resolveStatusId(requested.status);
      if (!statusId)
        throw new Error(
          "status or statusId must resolve to one stable Operon status id.",
        );
      return {
        capability: "tasks.transition.preview",
        mutationKind: "task.transition",
        target,
        spec: {
          operation: "transition",
          targetStatusId: statusId,
          ...(task.workflow?.status.id
            ? { expectedStatusId: task.workflow.status.id }
            : {}),
        },
      };
    }
    if (capability === "relationships") {
      const relationshipFields = [
        "parentTask",
        "blocking",
        "blockedBy",
      ] as const;
      const changes: Record<string, unknown>[] = [];
      const desired: Record<string, string[]> = {};
      for (const field of relationshipFields) {
        if (!Object.prototype.hasOwnProperty.call(requested, field)) continue;
        const raw = requested[field];
        if (field === "parentTask" && raw !== null && typeof raw !== "string") {
          throw new Error(
            "parentTask must be one canonical Operon id or null.",
          );
        }
        if (field !== "parentTask" && !Array.isArray(raw)) {
          throw new Error(`${field} must be an array of canonical Operon ids.`);
        }
        const targetOperonIds =
          field === "parentTask"
            ? raw === null
              ? []
              : [String(raw).trim()]
            : Array.isArray(raw)
              ? raw.map((value) => String(value).trim())
              : [];
        if (targetOperonIds.some((value) => !/^[a-z0-9]{7}$/u.test(value))) {
          throw new Error(
            `${field} must contain only canonical seven-character Operon ids.`,
          );
        }
        if (new Set(targetOperonIds).size !== targetOperonIds.length) {
          throw new Error(`${field} contains duplicate Operon ids.`);
        }
        if (targetOperonIds.includes(task.identity.operonId)) {
          throw new Error("A task cannot reference itself.");
        }
        desired[field] = targetOperonIds;
        changes.push({ field, targetOperonIds });
      }
      if (
        (desired.blocking ?? []).some((id) =>
          (desired.blockedBy ?? []).includes(id),
        )
      ) {
        throw new Error("One target cannot be both blocking and blockedBy.");
      }
      if (changes.length === 0)
        throw new Error(
          "The relationship update contains no replacement field.",
        );
      return {
        capability: "tasks.relationship.preview",
        mutationKind: "task.relationship",
        target,
        spec: { operation: "replace-relationships", changes },
      };
    }
    if (capability === "recurrence") {
      const scope = requested.scope;
      if (scope !== "this-task" && scope !== "this-and-following") {
        throw new Error("scope must be this-task or this-and-following.");
      }
      const requestedChanges = requested.changes;
      if (
        !requestedChanges ||
        typeof requestedChanges !== "object" ||
        Array.isArray(requestedChanges)
      ) {
        throw new Error("changes must contain at least one recurrence field.");
      }
      const valueTypes: Record<
        string,
        "text" | "date" | "datetime" | "number"
      > = {
        repeat: "text",
        datetimeRepeatEnd: "datetime",
        dateScheduled: "date",
        dateStarted: "date",
        dateDue: "date",
        datetimeStart: "datetime",
        datetimeEnd: "datetime",
        estimate: "number",
      };
      const changes = Object.entries(
        requestedChanges as Record<string, unknown>,
      ).map(([field, value]) => {
        const valueType = valueTypes[field];
        if (!valueType)
          throw new Error(`Unsupported recurrence field: ${field}.`);
        if (
          value !== null &&
          (valueType === "number"
            ? typeof value !== "number" || !Number.isFinite(value) || value < 0
            : typeof value !== "string" || value.trim().length === 0)
        ) {
          throw new Error(
            `Invalid ${valueType} value for recurrence field '${field}'.`,
          );
        }
        return value === null
          ? { operation: "clear", field, valueType }
          : { field, valueType, value };
      });
      if (changes.length === 0)
        throw new Error("The recurrence update contains no change.");
      return {
        capability: "tasks.recurrence.preview",
        mutationKind: "task.recurrence",
        target,
        spec: { operation: "update-recurrence", scope, changes },
      };
    }
    if (capability === "convert") {
      const targetRepresentation = requested.target;
      if (
        targetRepresentation !== "inline" &&
        targetRepresentation !== "file"
      ) {
        throw new Error("target must be either inline or file.");
      }
      if (requested.targetFolder) {
        throw new Error(
          "targetFolder is not supported by the official Developer API V1 conversion surface; use a configured target or an exact targetPath where supported.",
        );
      }
      if (targetRepresentation === "file") {
        if (task.representation !== "inline")
          throw new Error("The live task is not an inline task.");
        const templateId = String(
          requested.fileTemplateId ??
            this.configuration.creation.taskCreatorDefaultFileTemplateId ??
            "",
        ).trim();
        if (!templateId)
          throw new Error(
            "fileTemplateId or an Operon default file template is required for inline-to-file conversion.",
          );
        return {
          capability: "tasks.convert.preview",
          mutationKind: "task.convert",
          target,
          representation: "file",
          spec: {
            operation: "convert",
            from: "inline",
            to: "file",
            templateId,
          },
        };
      }
      if (task.representation !== "file")
        throw new Error("The live task is not a file task.");
      const targetPath = String(requested.targetPath ?? "").trim();
      if (!targetPath)
        throw new Error(
          "targetPath is required for file-to-inline conversion.",
        );
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
    if (
      task.representation !== "inline" ||
      task.locator.representation !== "inline"
    ) {
      throw new Error(
        "Only inline tasks can be relocated by the official Developer API V1.",
      );
    }
    const targetPath = String(requested.targetPath ?? "").trim();
    if (!targetPath) throw new Error("targetPath is required for relocation.");
    if (!api.context?.build)
      throw new Error(
        "Operon context.build is unavailable; no destination line can be guessed safely.",
      );
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
    if (
      !candidate?.locator ||
      !Number.isInteger(candidate.locator.lineNumber)
    ) {
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
    if (source !== "inline" && source !== "file")
      throw new Error("source must be either inline or file.");
    if (requested.properties && typeof requested.properties === "object") {
      throw new Error(
        "Unmanaged properties are not exposed by Operon Developer API V1; no raw Markdown fallback is used.",
      );
    }
    if (requested.targetFolder) {
      throw new Error(
        "targetFolder is not supported by the official Developer API V1 create surface; use an exact configured target instead.",
      );
    }
    const description = String(requested.description ?? "").trim();
    if (!description) throw new Error("description is required.");
    const targetPath =
      typeof requested.targetPath === "string"
        ? requested.targetPath.trim()
        : "";
    const target: Record<string, unknown> =
      source === "inline"
        ? targetPath
          ? {
              representation: "inline",
              mode: "exact-path",
              filePath: targetPath,
            }
          : { representation: "inline", mode: "configured-default" }
        : {
            representation: "file",
            mode: "configured-default",
            ...(requested.fileTemplateId
              ? { templateId: String(requested.fileTemplateId) }
              : {}),
          };
    const fields: Record<string, unknown>[] = [];
    const rawFields = requested.fields;
    let statusId = String(requested.statusId ?? "").trim() || null;
    let priorityId = String(requested.priorityId ?? "").trim() || null;
    let parent: Record<string, unknown> | undefined;
    const related: Record<string, unknown>[] = [];
    const dependencies: Record<string, unknown>[] = [];
    if (
      rawFields &&
      typeof rawFields === "object" &&
      !Array.isArray(rawFields)
    ) {
      for (const [field, value] of Object.entries(
        rawFields as Record<string, unknown>,
      )) {
        if (field === "status") {
          const resolved = this.resolveStatusId(value);
          if (!resolved)
            throw new Error(
              "fields.status must resolve to one stable Operon status id.",
            );
          statusId = resolved;
          continue;
        }
        if (field === "priority") {
          priorityId = this.resolvePriorityId(value);
          if (!priorityId)
            throw new Error(
              "fields.priority must resolve to one stable Operon priority id.",
            );
          continue;
        }
        if (field === "parentTask") {
          const parentId = String(value ?? "").trim();
          if (parentId) parent = { kind: "existing", operonId: parentId };
          continue;
        }
        if (field === "related") {
          for (const relatedId of this.listInput(value))
            related.push({ kind: "existing", operonId: relatedId });
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
        const valueType =
          CREATE_FIELD_TYPES[canonical] ?? this.fieldType(canonical);
        if (!valueType)
          throw new Error(
            `Create field '${field}' is not supported by the official Developer API.`,
          );
        fields.push(
          this.createField(
            canonical,
            value,
            valueType,
            this.isCustomGeneralField(canonical),
          ),
        );
      }
    }
    if (
      typeof requested.targetDateKey === "string" &&
      requested.targetDateKey.trim()
    ) {
      fields.push({
        kind: "date",
        field: "dateDue",
        value: requested.targetDateKey.trim(),
      });
    }
    if (Array.isArray(requested.tags)) {
      const tags = [
        ...new Set(
          requested.tags
            .map(String)
            .map((tag) => tag.trim().replace(/^#/u, "").trim())
            .filter(Boolean),
        ),
      ];
      return {
        capability: "tasks.create.preview",
        mutationKind: "task.create",
        representation: source,
        targetPath,
        spec: {
          operation: "create",
          items: [
            {
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
            },
          ],
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
        items: [
          {
            itemRef: `bridge-${requestId()}`,
            description,
            target,
            fields,
            ...(statusId ? { statusId } : {}),
            ...(priorityId ? { priorityId } : {}),
            ...(parent ? { parent } : {}),
            ...(related.length ? { related } : {}),
            ...(dependencies.length ? { dependencies } : {}),
          },
        ],
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
      if (!Number.isFinite(parsed))
        throw new Error(`Create field '${field}' requires a finite number.`);
      return custom
        ? { kind: "custom", field, valueType, value: parsed }
        : { kind: "number", field, value: parsed };
    }
    if (valueType === "list") {
      if (field === "taskGallery" && !Array.isArray(value)) {
        throw new Error(
          "Create field 'taskGallery' requires an ordered string array; the Bridge never splits media references heuristically.",
        );
      }
      const list = this.listInput(value);
      return custom
        ? { kind: "custom", field, valueType, value: list }
        : { kind: "list", field, value: list };
    }
    if (valueType === "checkbox") {
      const normalized = String(value).toLocaleLowerCase();
      if (
        !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(
          normalized,
        )
      ) {
        throw new Error(`Create field '${field}' requires a boolean value.`);
      }
      if (!custom)
        throw new Error(
          `Create field '${field}' has unsupported value type '${valueType}'.`,
        );
      return {
        kind: "custom",
        field,
        valueType,
        value: ["true", "1", "yes", "on"].includes(normalized),
      };
    }
    if (!["text", "date", "datetime"].includes(valueType)) {
      throw new Error(
        `Create field '${field}' has unsupported value type '${valueType}'.`,
      );
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
      if (
        beforeIds.has(task.identity.operonId) ||
        task.description !== description
      )
        return false;
      if (
        mapped.representation &&
        task.representation !== mapped.representation
      )
        return false;
      if (mapped.targetPath && task.locator.filePath !== mapped.targetPath)
        return false;
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
