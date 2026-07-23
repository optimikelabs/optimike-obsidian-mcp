import { App, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import {
  OPERON_BRIDGE_CONTRACT_VERSION,
  OPERON_BRIDGE_SUPPORTED_VERSIONS,
  OPERON_BRIDGE_TESTED_VERSION,
  isIndexReady,
  isCanonicalVaultMarkdownPath,
  mutationPathValidationError,
  resolveMutationPreflight,
  isVersionCompatible,
  normalizeTask,
  queryTasks,
  settingsSignature,
  shouldAttemptIndexValidation,
  type OperonBridgeTask,
  type OperonTaskQuery,
  type RuntimeIndexedTask,
  type RuntimeIndexDiagnostics,
  type RuntimeKeyMapping,
  type RuntimePipeline,
  type RuntimePriorityDefinition,
  type RuntimeFileTaskTemplate,
  type OperonBridgeConfiguration,
  type OperonSemanticConfiguration,
  type OperonWorkflowTaxonomy,
  type CachedMutation,
} from "./contract";
import { resolveTaskEnginePlugin } from "./task-engine-runtime";

const EXTENSION_ID = "optimike-operon-bridge";
const REST_PREFIX = `/extensions/${EXTENSION_ID}/v1`;
const LOCAL_REST_PLUGIN_ID = "obsidian-local-rest-api";
const MAX_MOUNT_WAIT_MS = 30_000;
const MOUNT_RETRY_MS = 500;

interface OptimikeOperonBridgeSettings {
  mutationsEnabled: boolean;
}

const DEFAULT_BRIDGE_SETTINGS: OptimikeOperonBridgeSettings = {
  mutationsEnabled: false,
};

class OptimikeOperonBridgeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly bridge: OptimikeOperonBridgePlugin,
  ) {
    super(app, bridge);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Mutations agentiques Kairélys / Operon")
      .setDesc(
        "Autorise les routes de création et modification. Désactivé par défaut ; les lectures restent disponibles.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.bridge.settings.mutationsEnabled)
          .onChange(async (value) => this.bridge.setMutationsEnabled(value)),
      );
  }
}

interface OperonRuntime {
  plugin: any;
  pluginId: "kairelys" | "operon";
  pluginName: string;
  api: OperonPublicApiV1 | null;
  version: string;
  compatible: boolean;
  indexer: {
    getAllTasks: () => RuntimeIndexedTask[];
    getTask: (operonId: string) => RuntimeIndexedTask | undefined;
    getGeneration: () => number;
    getIndexV8Diagnostics: () => Promise<RuntimeIndexDiagnostics>;
    validateIndexV8Now?: () => Promise<{ status?: string; code?: string }>;
    getDuplicateRegistry?: () => {
      revision?: number;
      totalConflictCount?: number;
      conflicts?: Array<{ operonId: string; instances?: unknown[] }>;
    };
    taskCount?: number;
  };
  pipelines: RuntimePipeline[];
  keyMappings: RuntimeKeyMapping[];
  priorities: RuntimePriorityDefinition[];
  language: string;
  defaultPipelineName: string | null;
}

interface BridgeCapabilities {
  status: boolean;
  configuration: boolean;
  list: boolean;
  get: boolean;
  query: boolean;
  validate: boolean;
  adopt: boolean;
  create: boolean;
  update: boolean;
  transition: boolean;
  convert: boolean;
  filterQuery: boolean;
  relocate: boolean;
}

interface OperonPublicMutationResult {
  ok: boolean;
  operonId: string | null;
  code:
    | "applied"
    | "not-ready"
    | "not-found"
    | "invalid-input"
    | "conflict"
    | "rejected"
    | "failed";
  message?: string;
}

interface OperonPublicApiV1 {
  version: "1";
  capabilities: () => {
    ready: boolean;
    adopt: boolean;
    create: boolean;
    update: boolean;
    transition: boolean;
    convert: boolean;
    filterQuery: boolean;
    relocate: boolean;
  };
  adoptInlineTask: (
    input: Record<string, unknown>,
  ) => Promise<OperonPublicMutationResult>;
  createTask: (
    input: Record<string, unknown>,
  ) => Promise<OperonPublicMutationResult>;
  updateTask: (
    operonId: string,
    input: Record<string, unknown>,
  ) => Promise<OperonPublicMutationResult>;
  transitionTask: (
    operonId: string,
    input: Record<string, unknown>,
  ) => Promise<OperonPublicMutationResult>;
  convertTask: (
    operonId: string,
    input: Record<string, unknown>,
  ) => Promise<OperonPublicMutationResult>;
  queryFilterSet: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    code: "ok" | "not-ready" | "not-found" | "invalid-input" | "failed";
    operonIds: string[];
    message?: string;
  }>;
  relocateTask: (
    operonId: string,
    input: Record<string, unknown>,
  ) => Promise<OperonPublicMutationResult>;
}

interface StableTaskRead {
  tasks: OperonBridgeTask[];
  generation: number;
  settingsSignature: string;
}

const BASE_LIMITATIONS = [
  "Exact Operon semantics require Obsidian Desktop with Operon loaded; headless clients must treat persisted MCP snapshots as stale fallbacks.",
  "Unmanaged frontmatter properties are returned only for file tasks and only when includeProperties=true.",
];

const READ_ONLY_LIMITATIONS = [
  ...BASE_LIMITATIONS,
  "Mutations require Operon Public API v1 and an explicit opt-in in Optimike Operon Bridge settings.",
];

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readQueryValue(req: any, key: string): unknown {
  const query = req?.query;
  if (typeof query === "function") {
    try {
      return query.call(req, key);
    } catch {
      return undefined;
    }
  }
  if (query && typeof query === "object") return query[key];
  return undefined;
}

function responseStatus(res: any, status: number): any {
  if (typeof res?.status === "function") return res.status(status);
  if (res && "statusCode" in res) res.statusCode = status;
  return res;
}

function sendJson(res: any, status: number, payload: unknown): void {
  const target = responseStatus(res, status);
  if (typeof target?.json === "function") {
    target.json(payload);
    return;
  }
  throw new Error("Local REST API response does not expose json().");
}

function errorPayload(
  error: unknown,
  code = "bridge_error",
): Record<string, unknown> {
  return {
    ok: false,
    contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
    limitations: READ_ONLY_LIMITATIONS,
  };
}

function sanitizeQuery(input: unknown): OperonTaskQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const query: OperonTaskQuery = {};
  const stringArrays = [
    "operonIds",
    "sources",
    "checkboxes",
    "statuses",
    "statusIds",
    "pipelines",
    "pipelineIds",
    "priorities",
    "tiers",
    "pathIncludes",
    "pathExcludes",
    "tagsAny",
    "tagsAll",
  ] as const;
  for (const key of stringArrays) {
    if (Array.isArray(source[key])) {
      (query as Record<string, unknown>)[key] = source[key]
        .map((value) => String(value).trim())
        .filter(Boolean);
    }
  }
  if (typeof source.search === "string") query.search = source.search;
  if (source.parentTask === null || typeof source.parentTask === "string") {
    query.parentTask = source.parentTask;
  }
  if (Array.isArray(source.dates))
    query.dates = source.dates as OperonTaskQuery["dates"];
  if (
    source.fieldEquals &&
    typeof source.fieldEquals === "object" &&
    !Array.isArray(source.fieldEquals)
  ) {
    query.fieldEquals = Object.fromEntries(
      Object.entries(source.fieldEquals as Record<string, unknown>).map(
        ([key, value]) => [key, String(value)],
      ),
    );
  }
  if (
    source.propertyEquals &&
    typeof source.propertyEquals === "object" &&
    !Array.isArray(source.propertyEquals)
  ) {
    query.propertyEquals = source.propertyEquals as Record<string, unknown>;
  }
  if (Array.isArray(source.sort))
    query.sort = source.sort as OperonTaskQuery["sort"];
  if (typeof source.includeProperties === "boolean")
    query.includeProperties = source.includeProperties;
  if (typeof source.cursor === "string") query.cursor = source.cursor;
  const limit = numberValue(source.limit);
  if (limit !== undefined) query.limit = limit;
  return query;
}

export default class OptimikeOperonBridgePlugin extends Plugin {
  settings: OptimikeOperonBridgeSettings = { ...DEFAULT_BRIDGE_SETTINGS };
  private restCleanup: (() => void) | null = null;
  private mountInterval: number | null = null;
  private mountTimeout: number | null = null;
  private indexValidationInFlight: Promise<void> | null = null;
  private mutationResults = new Map<string, CachedMutation>();

  async onload(): Promise<void> {
    const stored =
      (await this.loadData()) as Partial<OptimikeOperonBridgeSettings> | null;
    this.settings = { ...DEFAULT_BRIDGE_SETTINGS, ...(stored ?? {}) };
    this.addSettingTab(new OptimikeOperonBridgeSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.tryMountRestExtension();
      if (this.restCleanup) return;
      this.mountInterval = window.setInterval(
        () => this.tryMountRestExtension(),
        MOUNT_RETRY_MS,
      );
      this.mountTimeout = window.setTimeout(() => {
        if (!this.restCleanup) {
          console.warn(
            `[${EXTENSION_ID}] Local REST API extension surface unavailable after ${MAX_MOUNT_WAIT_MS}ms; routes were not mounted.`,
          );
        }
        this.clearMountTimers();
      }, MAX_MOUNT_WAIT_MS);
    });

    this.register(() => {
      this.clearMountTimers();
      this.restCleanup?.();
      this.restCleanup = null;
    });
  }

  async setMutationsEnabled(value: boolean): Promise<void> {
    this.settings.mutationsEnabled = value;
    this.mutationResults.clear();
    await this.saveData(this.settings);
  }
  private clearMountTimers(): void {
    if (this.mountInterval !== null) window.clearInterval(this.mountInterval);
    if (this.mountTimeout !== null) window.clearTimeout(this.mountTimeout);
    this.mountInterval = null;
    this.mountTimeout = null;
  }

  private getCommunityPlugin(id: string): any {
    const manager = (this.app as any).plugins;
    return manager?.plugins?.[id] ?? manager?.getPlugin?.(id) ?? null;
  }

  private readPublicApi(plugin: any): OperonPublicApiV1 | null {
    const api = plugin?.api;
    if (
      api?.version !== "1" ||
      typeof api.capabilities !== "function" ||
      typeof api.createTask !== "function" ||
      typeof api.adoptInlineTask !== "function" ||
      typeof api.updateTask !== "function" ||
      typeof api.transitionTask !== "function" ||
      typeof api.convertTask !== "function" ||
      typeof api.queryFilterSet !== "function" ||
      typeof api.relocateTask !== "function"
    ) {
      return null;
    }
    return api as OperonPublicApiV1;
  }

  private getOperonRuntime(): OperonRuntime | null {
    const resolved = resolveTaskEnginePlugin((this.app as any).plugins);
    if (!resolved) return null;
    const plugin = resolved.plugin as any;
    const version = String(plugin?.manifest?.version ?? "").trim();
    const indexer = plugin?.indexer;
    if (
      !indexer ||
      typeof indexer.getAllTasks !== "function" ||
      typeof indexer.getTask !== "function" ||
      typeof indexer.getGeneration !== "function" ||
      typeof indexer.getIndexV8Diagnostics !== "function"
    ) {
      return null;
    }
    return {
      plugin,
      pluginId: resolved.id,
      pluginName: resolved.name,
      api: this.readPublicApi(plugin),
      version,
      compatible: isVersionCompatible(resolved.id, version),
      indexer,
      pipelines: Array.isArray(plugin?.settings?.pipelines)
        ? plugin.settings.pipelines
        : [],
      keyMappings: Array.isArray(plugin?.settings?.keyMappings)
        ? plugin.settings.keyMappings
        : [],
      priorities: Array.isArray(plugin?.settings?.priorities)
        ? plugin.settings.priorities
        : [],
      language: String(plugin?.settings?.language ?? "auto").trim() || "auto",
      defaultPipelineName:
        typeof plugin?.settings?.defaultPipelineName === "string"
          ? plugin.settings.defaultPipelineName
          : null,
    };
  }

  private workflowTaxonomy(
    runtime: OperonRuntime | null,
  ): OperonWorkflowTaxonomy | null {
    if (!runtime) return null;
    return {
      language: runtime.language,
      defaultPipelineName: runtime.defaultPipelineName,
      pipelines: runtime.pipelines.map((pipeline) => ({
        id: typeof pipeline.id === "string" ? pipeline.id : null,
        name: pipeline.name,
        description:
          typeof pipeline.description === "string"
            ? pipeline.description
            : null,
        statuses: pipeline.statuses.map((status) => ({
          id: typeof status.id === "string" ? status.id : null,
          label: status.label,
          value: `${pipeline.name}.${status.label}`,
          isFinished: status.isFinished === true,
          isCancelled: status.isCancelled === true,
          isScheduledTarget: status.isScheduledTarget === true,
          isTrackingTarget: status.isTrackingTarget === true,
        })),
      })),
    };
  }

  private semanticConfiguration(
    runtime: OperonRuntime,
  ): OperonSemanticConfiguration {
    const settings = runtime.plugin?.settings ?? {};
    const templates =
      typeof runtime.plugin?.getFileTaskTemplateOptions === "function"
        ? (runtime.plugin.getFileTaskTemplateOptions() as RuntimeFileTaskTemplate[])
        : [];
    const filterSets = Array.isArray(settings.filterSets)
      ? settings.filterSets
      : [];
    return {
      language: runtime.language,
      workflow: this.workflowTaxonomy(runtime)!,
      priorities: {
        defaultPriority:
          typeof settings.defaultPriority === "string"
            ? settings.defaultPriority
            : null,
        items: runtime.priorities.map((priority) => ({
          id: typeof priority.id === "string" ? priority.id : null,
          label: String(priority.label ?? ""),
          color: typeof priority.color === "string" ? priority.color : null,
          description:
            typeof priority.description === "string"
              ? priority.description
              : null,
        })),
      },
      keys: runtime.keyMappings.map((mapping) => ({
        canonicalKey: String(mapping.canonicalKey ?? ""),
        visiblePropertyName: String(mapping.visiblePropertyName ?? ""),
        type: typeof mapping.type === "string" ? mapping.type : null,
        sync: typeof mapping.sync === "string" ? mapping.sync : null,
        enabled: mapping.enabled !== false,
        isSystem: mapping.isSystem === true,
        isInternal: mapping.isInternal === true,
      })),
      creation: {
        fileTasksFolder: String(settings.fileTasksFolder ?? ""),
        inlineTaskSaveMode: String(settings.inlineTaskSaveMode ?? ""),
        inlineTaskUseDailyNote: settings.inlineTaskUseDailyNote === true,
        inlineTaskTargetFile: String(settings.inlineTaskTargetFile ?? ""),
        inlineTaskHeading: String(settings.inlineTaskHeading ?? ""),
        inlineTaskDailyNoteAddStartDate:
          settings.inlineTaskDailyNoteAddStartDate === true,
        inlineTaskDailyNoteAddScheduledDate:
          settings.inlineTaskDailyNoteAddScheduledDate === true,
        taskCreatorDefaultToFileTask:
          settings.taskCreatorDefaultToFileTask === true,
        taskCreatorDefaultFileTemplateId:
          typeof settings.taskCreatorDefaultFileTemplateId === "string"
            ? settings.taskCreatorDefaultFileTemplateId
            : null,
        fileTaskTemplateFolder: String(settings.fileTaskTemplateFolder ?? ""),
        fileTaskParentInlineTargetMode: String(
          settings.fileTaskParentInlineTargetMode ?? "",
        ),
        fileTaskParentFileTargetMode: String(
          settings.fileTaskParentFileTargetMode ?? "",
        ),
        availableFileTaskTemplates: templates.map((template) => ({
          id: String(template.id ?? ""),
          name: String(template.name ?? ""),
          path: typeof template.path === "string" ? template.path : null,
          kind: String(template.kind ?? ""),
          pipelineId:
            typeof template.pipelineId === "string"
              ? template.pipelineId
              : null,
          description:
            typeof template.description === "string"
              ? template.description
              : null,
        })),
      },
      automation: {
        autoCompleteParentWhenAllChildrenTerminal:
          settings.autoCompleteParentWhenAllChildrenTerminal === true,
        cascadeCancelToDescendants:
          settings.cascadeCancelToDescendants === true,
        fileTaskAutoArchiveEnabled:
          settings.fileTaskAutoArchiveEnabled === true,
        fileTaskArchiveFolder: String(settings.fileTaskArchiveFolder ?? ""),
        fileTaskArchiveDelaySeconds:
          numberValue(settings.fileTaskArchiveDelaySeconds) ?? 0,
        fileTaskArchiveOnlyFromFileTasksFolder:
          settings.fileTaskArchiveOnlyFromFileTasksFolder === true,
        fileRepeatDestination: String(settings.fileRepeatDestination ?? ""),
        fileRepeatCustomFolder: String(settings.fileRepeatCustomFolder ?? ""),
      },
      indexing: {
        excludedFolders: Array.isArray(settings.excludedFolders)
          ? settings.excludedFolders
              .map((value: unknown) => String(value))
              .filter(Boolean)
          : [],
        fullReindexOnStartup: settings.fullReindexOnStartup === true,
        indexEventDebounceMs: numberValue(settings.indexEventDebounceMs) ?? 0,
      },
      docs: {
        folder: String(settings.operonDocsFolder ?? ""),
        autoUpdateEnabled: settings.operonDocsAutoUpdateEnabled === true,
      },
      views: {
        filters: filterSets
          .map((filter: Record<string, unknown>) => ({
            id: String(filter.id ?? ""),
            name: String(filter.name ?? ""),
            icon: typeof filter.icon === "string" ? filter.icon : null,
            definition: JSON.parse(JSON.stringify(filter)) as Record<
              string,
              unknown
            >,
          }))
          .filter((filter: { id: string }) => Boolean(filter.id)),
      },
    };
  }

  private currentSettingsSignature(runtime: OperonRuntime): string {
    return settingsSignature(this.semanticConfiguration(runtime));
  }

  private configurationPayload(
    runtime: OperonRuntime,
  ): OperonBridgeConfiguration {
    const configuration = this.semanticConfiguration(runtime);
    return {
      ok: true,
      contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
      source: "operon-runtime",
      stale: false,
      operonVersion: runtime.version,
      bridgeVersion: this.manifest.version,
      settingsSignature: settingsSignature(configuration),
      configuration,
      limitations: this.limitations(runtime, true),
    };
  }

  private capabilities(
    runtime: OperonRuntime | null,
    ready = false,
  ): BridgeCapabilities {
    const readable = Boolean(runtime?.compatible && ready);
    const publicCapabilities =
      readable && runtime?.api ? runtime.api.capabilities() : null;
    const mutation = this.settings.mutationsEnabled ? publicCapabilities : null;
    return {
      status: true,
      configuration: Boolean(runtime?.compatible),
      list: readable,
      get: readable,
      query: readable,
      validate: readable,
      adopt: Boolean(mutation?.ready && mutation.adopt),
      create: Boolean(mutation?.ready && mutation.create),
      update: Boolean(mutation?.ready && mutation.update),
      transition: Boolean(mutation?.ready && mutation.transition),
      filterQuery: Boolean(
        publicCapabilities?.ready && publicCapabilities.filterQuery,
      ),
      relocate: Boolean(mutation?.ready && mutation.relocate),
      convert: Boolean(mutation?.ready && mutation.convert),
    };
  }

  private limitations(runtime: OperonRuntime | null, ready: boolean): string[] {
    return this.capabilities(runtime, ready).update
      ? BASE_LIMITATIONS
      : READ_ONLY_LIMITATIONS;
  }

  private async indexState(runtime: OperonRuntime | null): Promise<{
    ready: boolean;
    generation: number | null;
    diagnostics: RuntimeIndexDiagnostics | null;
  }> {
    if (!runtime?.compatible)
      return { ready: false, generation: null, diagnostics: null };
    const generation = runtime.indexer.getGeneration();
    let diagnostics: RuntimeIndexDiagnostics | null = null;
    try {
      diagnostics = await runtime.indexer.getIndexV8Diagnostics();
    } catch (error) {
      console.warn(
        `[${EXTENSION_ID}] Operon index diagnostics unavailable.`,
        error,
      );
    }
    if (
      shouldAttemptIndexValidation({
        compatible: runtime.compatible,
        generation,
        diagnostics,
        hasValidator: typeof runtime.indexer.validateIndexV8Now === "function",
      })
    ) {
      await this.validateSettledIndex(runtime);
      try {
        diagnostics = await runtime.indexer.getIndexV8Diagnostics();
      } catch (error) {
        console.warn(
          `[${EXTENSION_ID}] Operon index diagnostics unavailable after validation.`,
          error,
        );
      }
    }
    return {
      generation,
      diagnostics,
      ready: isIndexReady({
        compatible: runtime.compatible,
        generation,
        diagnostics,
      }),
    };
  }

  private async validateSettledIndex(runtime: OperonRuntime): Promise<void> {
    if (!runtime.indexer.validateIndexV8Now) return;
    if (!this.indexValidationInFlight) {
      this.indexValidationInFlight = runtime.indexer
        .validateIndexV8Now()
        .then((result) => {
          if (result?.status !== "loaded") {
            console.warn(
              `[${EXTENSION_ID}] Operon index validation did not load the active snapshot (${result?.code ?? result?.status ?? "unknown"}).`,
            );
          }
        })
        .catch((error: unknown) => {
          console.warn(
            `[${EXTENSION_ID}] Operon index validation failed.`,
            error,
          );
        })
        .finally(() => {
          this.indexValidationInFlight = null;
        });
    }
    await this.indexValidationInFlight;
  }

  private async statusPayload(): Promise<Record<string, unknown>> {
    const runtime = this.getOperonRuntime();
    const indexState = await this.indexState(runtime);
    const registry = runtime?.indexer.getDuplicateRegistry?.();
    const taskCount = runtime
      ? typeof runtime.indexer.taskCount === "number"
        ? runtime.indexer.taskCount
        : runtime.indexer.getAllTasks().length
      : 0;
    const ready = Boolean(
      indexState.ready && indexState.diagnostics?.taskCount === taskCount,
    );
    const capabilities = this.capabilities(runtime, ready);
    return {
      ok: Boolean(runtime?.compatible && ready),
      contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
      bridge: {
        id: this.manifest.id,
        version: this.manifest.version,
        mode: capabilities.update ? "read-write" : "read-only",
      },
      operon: {
        present: Boolean(runtime),
        pluginId: runtime?.pluginId ?? null,
        pluginName: runtime?.pluginName ?? null,
        version: runtime?.version ?? null,
        compatible: Boolean(runtime?.compatible),
        testedAgainst: OPERON_BRIDGE_TESTED_VERSION,
        supportedRange: Object.entries(OPERON_BRIDGE_SUPPORTED_VERSIONS)
          .map(([pluginId, versions]) => `${pluginId}: ${versions.join(", ")}`)
          .join("; "),
      },
      index: {
        ready,
        generation: indexState.generation,
        taskCount,
        duplicateConflictCount: registry?.totalConflictCount ?? 0,
        diagnostics: indexState.diagnostics,
      },
      settingsSignature: runtime
        ? this.currentSettingsSignature(runtime)
        : null,
      taxonomy: this.workflowTaxonomy(runtime),
      capabilities,
      source: "operon-runtime",
      stale: false,
      limitations: this.limitations(runtime, ready),
    };
  }

  private requireRuntime(): OperonRuntime {
    const runtime = this.getOperonRuntime();
    if (!runtime) {
      throw new Error(
        "Kairélys or Operon is not loaded, or its current runtime index surface is unavailable.",
      );
    }
    if (!runtime.compatible) {
      throw new Error(
        `${runtime.pluginName} ${runtime.version || "unknown"} is not in the tested Bridge allowlist (${Object.entries(OPERON_BRIDGE_SUPPORTED_VERSIONS).map(([pluginId, versions]) => `${pluginId}: ${versions.join(", ")}`).join("; ")}).`,
      );
    }
    return runtime;
  }

  private normalizeRuntimeTask(
    runtime: OperonRuntime,
    task: RuntimeIndexedTask,
    includeProperties: boolean,
  ): OperonBridgeTask {
    const abstract = this.app.vault.getAbstractFileByPath(
      task.primary.filePath,
    );
    const file = abstract instanceof TFile ? abstract : null;
    const frontmatter =
      includeProperties && task.primary.format === "yaml" && file
        ? (this.app.metadataCache.getFileCache(file)?.frontmatter as
            | Record<string, unknown>
            | undefined)
        : undefined;
    return normalizeTask({
      task,
      pipelines: runtime.pipelines,
      keyMappings: runtime.keyMappings,
      frontmatter,
      sourceMtime: file?.stat.mtime ?? null,
      operonVersion: runtime.version,
      bridgeVersion: this.manifest.version,
      includeProperties,
    });
  }

  private async allTasksSnapshot(
    includeProperties: boolean,
  ): Promise<StableTaskRead> {
    const runtime = this.requireRuntime();
    const before = await this.indexState(runtime);
    if (!before.ready || before.generation === null) {
      throw new Error(
        "Operon index is still initializing or is not in a verified idle state.",
      );
    }
    const beforeSettings = this.currentSettingsSignature(runtime);
    const tasks = runtime.indexer
      .getAllTasks()
      .map((task) =>
        this.normalizeRuntimeTask(runtime, task, includeProperties),
      );
    const after = await this.indexState(runtime);
    const afterSettings = this.currentSettingsSignature(runtime);
    if (
      !after.ready ||
      after.generation !== before.generation ||
      afterSettings !== beforeSettings ||
      before.diagnostics?.taskCount !== tasks.length ||
      after.diagnostics?.taskCount !== tasks.length
    ) {
      throw new Error(
        "Operon generation or settings changed during the read; retry after the index settles.",
      );
    }
    return {
      tasks,
      generation: before.generation,
      settingsSignature: beforeSettings,
    };
  }

  private async oneTask(
    operonId: string,
    includeProperties: boolean,
  ): Promise<{
    task: OperonBridgeTask | null;
    generation: number;
    settingsSignature: string;
  }> {
    const runtime = this.requireRuntime();
    const state = await this.indexState(runtime);
    if (!state.ready || state.generation === null) {
      throw new Error(
        "Operon index is still initializing or is not in a verified idle state.",
      );
    }
    const signature = this.currentSettingsSignature(runtime);
    const task = runtime.indexer.getTask(operonId);
    const normalized = task
      ? this.normalizeRuntimeTask(runtime, task, includeProperties)
      : null;
    const after = await this.indexState(runtime);
    if (
      !after.ready ||
      after.generation !== state.generation ||
      this.currentSettingsSignature(runtime) !== signature
    ) {
      throw new Error(
        "Operon generation or settings changed during the read; retry after the index settles.",
      );
    }
    return {
      task: normalized,
      generation: state.generation,
      settingsSignature: signature,
    };
  }

  private async oneTaskAfterMutation(
    operonId: string,
    includeProperties: boolean,
  ): Promise<{
    task: OperonBridgeTask | null;
    generation: number;
    settingsSignature: string;
  }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        return await this.oneTask(operonId, includeProperties);
      } catch (error) {
        lastError = error;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 125));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Operon did not reach a verified idle state after mutation.");
  }

  private async validationPayload(
    includeProperties = false,
  ): Promise<Record<string, unknown>> {
    const runtime = this.requireRuntime();
    const snapshot = await this.allTasksSnapshot(includeProperties);
    const tasks = snapshot.tasks;
    const ids = new Set(tasks.map((task) => task.operonId));
    const registry = runtime.indexer.getDuplicateRegistry?.();
    const violations: Array<Record<string, unknown>> = [];

    for (const conflict of registry?.conflicts ?? []) {
      violations.push({
        severity: "P0",
        code: "duplicate_operon_id",
        operonId: conflict.operonId,
        instanceCount: conflict.instances?.length ?? 2,
      });
    }

    for (const task of tasks) {
      if (!this.app.vault.getAbstractFileByPath(task.path)) {
        violations.push({
          severity: "P0",
          code: "source_missing",
          operonId: task.operonId,
          path: task.path,
        });
      }
      if (task.status && !task.pipeline) {
        violations.push({
          severity: "P1",
          code: "unknown_workflow_status",
          operonId: task.operonId,
          status: task.status,
        });
      }
      if (task.parentTask && !ids.has(task.parentTask)) {
        violations.push({
          severity: "P1",
          code: "missing_parent_task",
          operonId: task.operonId,
          parentTask: task.parentTask,
        });
      }
      for (const blocker of task.blockedBy) {
        if (!ids.has(blocker)) {
          violations.push({
            severity: "P2",
            code: "missing_blocker_task",
            operonId: task.operonId,
            blockedBy: blocker,
          });
        }
      }
    }

    const countSeverity = (severity: string): number =>
      violations.filter((violation) => violation.severity === severity).length;
    return {
      ok: countSeverity("P0") === 0,
      contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
      source: "operon-runtime",
      stale: false,
      taskCount: tasks.length,
      generation: snapshot.generation,
      settingsSignature: snapshot.settingsSignature,
      summary: {
        P0: countSeverity("P0"),
        P1: countSeverity("P1"),
        P2: countSeverity("P2"),
      },
      violations,
      limitations: this.limitations(runtime, true),
    };
  }

  private bodyRecord(req: any): Record<string, unknown> {
    const body = req?.body;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  }

  private mutationOperationId(): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `operon-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
  }

  private cacheMutation(
    idempotencyKey: string,
    signature: string,
    payload: Record<string, unknown>,
  ): void {
    this.mutationResults.set(idempotencyKey, { signature, payload });
    if (this.mutationResults.size <= 500) return;
    const oldest = this.mutationResults.keys().next().value;
    if (oldest) this.mutationResults.delete(oldest);
  }

  private mutationPreflight(
    idempotencyKey: string,
    signature: string,
    requested: Record<string, unknown>,
    validate: () => string | null,
  ) {
    return resolveMutationPreflight({
      cached: this.mutationResults.get(idempotencyKey),
      idempotencyKey,
      signature,
      requested,
      validate,
      operationId: () => this.mutationOperationId(),
    });
  }

  private requireMutationRuntime(
    capability:
      | "adopt"
      | "create"
      | "update"
      | "transition"
      | "convert"
      | "relocate",
  ): OperonRuntime {
    if (!this.settings.mutationsEnabled) {
      throw new Error(
        "Operon Bridge mutations are disabled in plugin settings.",
      );
    }
    const runtime = this.requireRuntime();
    const available = runtime.api?.capabilities();
    if (!runtime.api || !available?.ready || !available[capability]) {
      throw new Error(
        `Operon Public API v1 capability is unavailable: ${capability}.`,
      );
    }
    return runtime;
  }

  private async executeAdoptMutation(
    body: Record<string, unknown>,
  ): Promise<{ httpStatus: number; payload: Record<string, unknown> }> {
    const idempotencyKey = String(body.idempotencyKey ?? "").trim();
    if (!idempotencyKey) {
      return {
        httpStatus: 400,
        payload: errorPayload(
          new Error("idempotencyKey is required."),
          "validation_error",
        ),
      };
    }
    const requested =
      body.adoption &&
      typeof body.adoption === "object" &&
      !Array.isArray(body.adoption)
        ? (body.adoption as Record<string, unknown>)
        : {};
    const signature = stableJson({
      capability: "adopt",
      dryRun: body.dryRun !== false,
      requested,
    });
    const targetPath = requested.targetPath;
    const line = Number(requested.line);
    const expectedLine = String(requested.expectedLine ?? "");
    const preflight = this.mutationPreflight(
      idempotencyKey,
      signature,
      requested,
      () =>
        !isCanonicalVaultMarkdownPath(targetPath) ||
        !Number.isInteger(line) ||
        line < 1 ||
        !expectedLine ||
        /[\r\n]/u.test(expectedLine)
          ? "adoption requires targetPath, a positive one-based line, and one exact expectedLine."
          : null,
    );
    if (preflight.kind === "response") return preflight.response;
    if (preflight.kind === "validation-error") {
      return {
        httpStatus: 400,
        payload: errorPayload(
          new Error(preflight.message),
          "validation_error",
        ),
      };
    }
    const canonicalTargetPath = targetPath as string;
    const runtime = this.requireMutationRuntime("adopt");
    const file = this.app.vault.getAbstractFileByPath(canonicalTargetPath);
    if (!(file instanceof TFile)) {
      return {
        httpStatus: 404,
        payload: errorPayload(
          new Error(`Markdown source file not found: ${canonicalTargetPath}`),
          "not_found",
        ),
      };
    }
    const content = await this.app.vault.cachedRead(file);
    const currentLine = content.split("\n")[line - 1];
    const normalizedCurrentLine = currentLine?.endsWith("\r")
      ? currentLine.slice(0, -1)
      : currentLine;
    const operationId = this.mutationOperationId();
    if (normalizedCurrentLine !== expectedLine) {
      const payload = {
        ok: false,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: "conflict",
        before: null,
        requested,
        after: null,
        error: {
          code: "source_line_conflict",
          message: "expectedLine does not match the live source line.",
        },
        retryable: true,
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: 409, payload };
    }
    if (body.dryRun !== false) {
      const payload = {
        ok: true,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: "planned",
        before: null,
        requested,
        after: null,
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: 200, payload };
    }

    const result = await runtime.api!.adoptInlineTask(requested);
    if (!result.ok || !result.operonId) {
      const conflict = result.code === "conflict";
      const payload = {
        ok: false,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: conflict ? "conflict" : "rejected",
        before: null,
        requested,
        after: null,
        error: {
          code: result.code,
          message: result.message ?? "Operon rejected checkbox adoption.",
        },
        retryable:
          conflict || result.code === "not-ready" || result.code === "failed",
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: conflict ? 409 : 422, payload };
    }

    let afterRead: Awaited<ReturnType<OptimikeOperonBridgePlugin["oneTask"]>>;
    try {
      afterRead = await this.oneTaskAfterMutation(result.operonId, true);
    } catch (error) {
      const payload = {
        ok: false,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: "failed",
        before: null,
        requested,
        after: null,
        error: {
          code: "outcome_unverified",
          message: `Operon adopted ${result.operonId}, but the final indexed state could not be proven: ${error instanceof Error ? error.message : String(error)}`,
        },
        retryable: false,
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: 500, payload };
    }
    const after = afterRead.task;
    const locationMatches =
      after?.path === canonicalTargetPath && after?.line === line;
    const payload = {
      ok: Boolean(after && locationMatches),
      contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
      operationId,
      idempotencyKey,
      status: after && locationMatches ? "applied" : "failed",
      before: null,
      requested,
      after,
      ...(!after || !locationMatches
        ? {
            error: {
              code: "outcome_mismatch",
              message:
                "The adopted task was not found at the requested source line.",
            },
            retryable: false,
          }
        : {}),
      source: "operon-live",
      stale: false,
    };
    this.cacheMutation(idempotencyKey, signature, payload);
    return { httpStatus: after && locationMatches ? 200 : 500, payload };
  }

  private mutationOutcomeMismatch(
    capability: "create" | "update" | "transition" | "convert" | "relocate",
    after: OperonBridgeTask | null,
    requested: Record<string, unknown>,
  ): string | null {
    if (!after) return "The final indexed task is missing.";
    if (capability === "create") {
      if (
        typeof requested.description === "string" &&
        after.description !== requested.description.trim()
      ) {
        return "Created task description does not match the request.";
      }
      if (
        (requested.source === "inline" || requested.source === "file") &&
        after.source !== requested.source
      ) {
        return "Created task source does not match the request.";
      }
    }
    if (capability === "update" || capability === "create") {
      if (
        typeof requested.description === "string" &&
        after.description !== requested.description.trim()
      ) {
        return "Task description does not match the request.";
      }
      if (Array.isArray(requested.tags)) {
        const expectedTags = requested.tags
          .map(String)
          .map((tag) => tag.replace(/^#/u, "").trim())
          .filter(Boolean)
          .sort();
        const actualTags = [...after.tags].sort();
        if (stableJson(actualTags) !== stableJson(expectedTags))
          return "Task tags do not match the request.";
      }
      const requestedFields =
        requested.fields &&
        typeof requested.fields === "object" &&
        !Array.isArray(requested.fields)
          ? (requested.fields as Record<string, unknown>)
          : {};
      for (const [key, value] of Object.entries(requestedFields)) {
        if (key === "status") continue;
        if (after.fields[key] !== String(value))
          return `Managed field '${key}' does not match the request.`;
      }
      const requestedProperties =
        requested.properties &&
        typeof requested.properties === "object" &&
        !Array.isArray(requested.properties)
          ? (requested.properties as Record<string, unknown>)
          : {};
      for (const [key, value] of Object.entries(requestedProperties)) {
        if (stableJson(after.properties?.[key]) !== stableJson(value)) {
          return `Unmanaged property '${key}' does not match the request.`;
        }
      }
    }
    if (capability === "transition" || capability === "create") {
      if (
        typeof requested.status === "string" &&
        after.status !== requested.status.trim()
      ) {
        return "Task status does not match the requested status value.";
      }
      if (
        typeof requested.statusId === "string" &&
        after.statusId !== requested.statusId.trim()
      ) {
        return "Task status does not match the requested stable status id.";
      }
    }
    if (capability === "convert") {
      if (
        (requested.target === "inline" || requested.target === "file") &&
        after.source !== requested.target
      ) {
        return "Converted task source does not match the request.";
      }
      if (
        requested.target === "inline" &&
        typeof requested.targetPath === "string" &&
        after.path !== requested.targetPath
      ) {
        return "Converted inline task path does not match targetPath.";
      }
    }
    if (capability === "relocate") {
      if (
        after.source !== "inline" ||
        typeof requested.targetPath !== "string" ||
        after.path !== requested.targetPath
      ) {
        return "Relocated task was not found at targetPath.";
      }
    }
    return null;
  }

  private async executeExistingMutation(
    capability: "update" | "transition" | "convert" | "relocate",
    operonId: string,
    body: Record<string, unknown>,
    requested: Record<string, unknown>,
    apply: (api: OperonPublicApiV1) => Promise<OperonPublicMutationResult>,
  ): Promise<{ httpStatus: number; payload: Record<string, unknown> }> {
    const idempotencyKey = String(body.idempotencyKey ?? "").trim();
    if (!idempotencyKey) {
      return {
        httpStatus: 400,
        payload: errorPayload(
          new Error("idempotencyKey is required."),
          "validation_error",
        ),
      };
    }
    const signature = stableJson({
      capability,
      operonId,
      expectedRevision: body.expectedRevision,
      dryRun: body.dryRun !== false,
      requested,
    });
    const preflight = this.mutationPreflight(
      idempotencyKey,
      signature,
      requested,
      () => mutationPathValidationError(capability, requested),
    );
    if (preflight.kind === "response") return preflight.response;
    if (preflight.kind === "validation-error") {
      return {
        httpStatus: 400,
        payload: errorPayload(new Error(preflight.message), "validation_error"),
      };
    }

    const runtime = this.requireMutationRuntime(capability);
    const beforeRead = await this.oneTask(operonId, true);
    if (!beforeRead.task) {
      return {
        httpStatus: 404,
        payload: errorPayload(
          new Error(`Operon task not found: ${operonId}`),
          "not_found",
        ),
      };
    }
    const expectedRevision = String(body.expectedRevision ?? "").trim();
    if (!expectedRevision) {
      return {
        httpStatus: 400,
        payload: errorPayload(
          new Error("expectedRevision is required."),
          "validation_error",
        ),
      };
    }
    const operationId = this.mutationOperationId();
    if (expectedRevision !== beforeRead.task.revision) {
      const payload = {
        ok: false,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: "conflict",
        before: beforeRead.task,
        requested,
        after: beforeRead.task,
        error: {
          code: "revision_conflict",
          message: "expectedRevision does not match the live task revision.",
        },
        retryable: true,
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: 409, payload };
    }
    if (body.dryRun !== false) {
      const payload = {
        ok: true,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: "planned",
        before: beforeRead.task,
        requested,
        after: null,
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: 200, payload };
    }

    const result = await apply(runtime.api!);
    let afterRead: Awaited<ReturnType<OptimikeOperonBridgePlugin["oneTask"]>>;
    try {
      afterRead = await this.oneTaskAfterMutation(operonId, true);
    } catch (error) {
      const payload = {
        ok: false,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: "failed",
        before: beforeRead.task,
        requested,
        after: null,
        error: {
          code: "outcome_unverified",
          message: `Operon returned ${result.code}, but the final indexed state could not be proven: ${error instanceof Error ? error.message : String(error)}`,
        },
        retryable: false,
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: 500, payload };
    }
    const mismatch = result.ok
      ? this.mutationOutcomeMismatch(capability, afterRead.task, requested)
      : null;
    const applied = result.ok && !mismatch;
    const payload = {
      ok: applied,
      contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
      operationId,
      idempotencyKey,
      status: applied ? "applied" : mismatch ? "failed" : "rejected",
      before: beforeRead.task,
      requested,
      after: afterRead.task,
      error: mismatch
        ? { code: "outcome_mismatch", message: mismatch }
        : result.ok
          ? undefined
          : {
              code: result.code,
              message: result.message ?? "Operon rejected the mutation.",
            },
      retryable: result.code === "not-ready" || result.code === "failed",
      source: "operon-live",
      stale: false,
    };
    this.cacheMutation(idempotencyKey, signature, payload);
    return { httpStatus: applied ? 200 : mismatch ? 500 : 422, payload };
  }

  private async executeCreateMutation(
    body: Record<string, unknown>,
  ): Promise<{ httpStatus: number; payload: Record<string, unknown> }> {
    const idempotencyKey = String(body.idempotencyKey ?? "").trim();
    if (!idempotencyKey) {
      return {
        httpStatus: 400,
        payload: errorPayload(
          new Error("idempotencyKey is required."),
          "validation_error",
        ),
      };
    }
    const requested =
      body.task && typeof body.task === "object" && !Array.isArray(body.task)
        ? (body.task as Record<string, unknown>)
        : {};
    const signature = stableJson({
      capability: "create",
      dryRun: body.dryRun !== false,
      requested,
    });
    const preflight = this.mutationPreflight(
      idempotencyKey,
      signature,
      requested,
      () => mutationPathValidationError("create", requested),
    );
    if (preflight.kind === "response") return preflight.response;
    if (preflight.kind === "validation-error") {
      return {
        httpStatus: 400,
        payload: errorPayload(new Error(preflight.message), "validation_error"),
      };
    }
    const runtime = this.requireMutationRuntime("create");
    const operationId = this.mutationOperationId();
    if (body.dryRun !== false) {
      const payload = {
        ok: true,
        contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
        operationId,
        idempotencyKey,
        status: "planned",
        before: null,
        requested,
        after: null,
        source: "operon-live",
        stale: false,
      };
      this.cacheMutation(idempotencyKey, signature, payload);
      return { httpStatus: 200, payload };
    }
    const result = await runtime.api!.createTask(requested);
    let afterRead: Awaited<
      ReturnType<OptimikeOperonBridgePlugin["oneTask"]>
    > | null = null;
    if (result.operonId) {
      try {
        afterRead = await this.oneTaskAfterMutation(result.operonId, true);
      } catch (error) {
        const payload = {
          ok: false,
          contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
          operationId,
          idempotencyKey,
          status: "failed",
          before: null,
          requested,
          after: null,
          error: {
            code: "outcome_unverified",
            message: `Operon returned ${result.code}, but the created task could not be proven in the final index: ${error instanceof Error ? error.message : String(error)}`,
          },
          retryable: false,
          source: "operon-live",
          stale: false,
        };
        this.cacheMutation(idempotencyKey, signature, payload);
        return { httpStatus: 500, payload };
      }
    }
    const mismatch = result.ok
      ? this.mutationOutcomeMismatch(
          "create",
          afterRead?.task ?? null,
          requested,
        )
      : null;
    const applied = result.ok && !mismatch;
    const payload = {
      ok: applied,
      contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
      operationId,
      idempotencyKey,
      status: applied ? "applied" : mismatch ? "failed" : "rejected",
      before: null,
      requested,
      after: afterRead?.task ?? null,
      error: mismatch
        ? { code: "outcome_mismatch", message: mismatch }
        : result.ok
          ? undefined
          : {
              code: result.code,
              message: result.message ?? "Operon rejected task creation.",
            },
      retryable: result.code === "not-ready" || result.code === "failed",
      source: "operon-live",
      stale: false,
    };
    this.cacheMutation(idempotencyKey, signature, payload);
    return { httpStatus: applied ? 200 : mismatch ? 500 : 422, payload };
  }

  private tryMountRestExtension(): void {
    if (this.restCleanup) return;
    const restPlugin = this.getCommunityPlugin(LOCAL_REST_PLUGIN_ID);
    const getPublicApi =
      typeof restPlugin?.getPublicApi === "function"
        ? restPlugin.getPublicApi.bind(restPlugin)
        : null;
    if (!getPublicApi) return;
    const api = getPublicApi(this.manifest);
    if (!api || typeof api.addRoute !== "function") return;

    api.addRoute(`${REST_PREFIX}/status`).get(async (_req: any, res: any) => {
      try {
        sendJson(res, 200, await this.statusPayload());
      } catch (error) {
        sendJson(res, 503, errorPayload(error, "operon_unavailable"));
      }
    });

    api
      .addRoute(`${REST_PREFIX}/configuration`)
      .get(async (_req: any, res: any) => {
        try {
          const runtime = this.requireRuntime();
          sendJson(res, 200, this.configurationPayload(runtime));
        } catch (error) {
          sendJson(
            res,
            503,
            errorPayload(error, "operon_configuration_unavailable"),
          );
        }
      });

    api.addRoute(`${REST_PREFIX}/tasks`).get(async (req: any, res: any) => {
      try {
        const query: OperonTaskQuery = {
          cursor: String(readQueryValue(req, "cursor") ?? "0"),
          limit: numberValue(readQueryValue(req, "limit")),
          includeProperties: boolValue(
            readQueryValue(req, "includeProperties"),
          ),
        };
        const snapshot = await this.allTasksSnapshot(
          Boolean(query.includeProperties),
        );
        const result = queryTasks(snapshot.tasks, query);
        sendJson(res, 200, {
          ok: true,
          contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
          source: "operon-live",
          stale: false,
          generation: snapshot.generation,
          settingsSignature: snapshot.settingsSignature,
          ...result,
          limitations: this.limitations(this.getOperonRuntime(), true),
        });
      } catch (error) {
        sendJson(res, 503, errorPayload(error, "operon_unavailable"));
      }
    });

    api
      .addRoute(`${REST_PREFIX}/tasks/:operonId`)
      .get(async (req: any, res: any) => {
        try {
          const operonId = decodeURIComponent(
            String(req?.params?.operonId ?? ""),
          ).trim();
          if (!operonId) {
            sendJson(
              res,
              400,
              errorPayload(
                new Error("operonId is required."),
                "validation_error",
              ),
            );
            return;
          }
          const result = await this.oneTask(
            operonId,
            boolValue(readQueryValue(req, "includeProperties")),
          );
          if (!result.task) {
            sendJson(
              res,
              404,
              errorPayload(
                new Error(`Operon task not found: ${operonId}`),
                "not_found",
              ),
            );
            return;
          }
          sendJson(res, 200, {
            ok: true,
            contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
            source: "operon-live",
            stale: false,
            generation: result.generation,
            settingsSignature: result.settingsSignature,
            task: result.task,
            limitations: this.limitations(this.getOperonRuntime(), true),
          });
        } catch (error) {
          sendJson(res, 503, errorPayload(error, "operon_unavailable"));
        }
      });

    api
      .addRoute(`${REST_PREFIX}/tasks/query`)
      .post(async (req: any, res: any) => {
        try {
          const query = sanitizeQuery(req?.body ?? {});
          const snapshot = await this.allTasksSnapshot(
            Boolean(query.includeProperties),
          );
          const result = queryTasks(snapshot.tasks, query);
          sendJson(res, 200, {
            ok: true,
            contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
            source: "operon-live",
            stale: false,
            generation: snapshot.generation,
            settingsSignature: snapshot.settingsSignature,
            ...result,
            limitations: this.limitations(this.getOperonRuntime(), true),
          });
        } catch (error) {
          sendJson(res, 400, errorPayload(error, "query_error"));
        }
      });

    api
      .addRoute(`${REST_PREFIX}/tasks/filter`)
      .post(async (req: any, res: any) => {
        try {
          const body = this.bodyRecord(req);
          const filterSetId = String(body.filterSetId ?? "").trim();
          if (!filterSetId) {
            sendJson(
              res,
              400,
              errorPayload(
                new Error("filterSetId is required."),
                "validation_error",
              ),
            );
            return;
          }
          const runtime = this.requireRuntime();
          const publicCapabilities = runtime.api?.capabilities();
          if (
            !runtime.api ||
            !publicCapabilities?.ready ||
            !publicCapabilities.filterQuery
          ) {
            sendJson(
              res,
              503,
              errorPayload(
                new Error(
                  "Operon saved-filter query capability is unavailable.",
                ),
                "mutation_unavailable",
              ),
            );
            return;
          }
          const queryGeneration = runtime.indexer.getGeneration();
          const nativeResult = await runtime.api.queryFilterSet({
            filterSetId,
            ...(typeof body.scopePath === "string" && body.scopePath.trim()
              ? { scopePath: body.scopePath.trim() }
              : {}),
          });
          if (!nativeResult.ok) {
            sendJson(
              res,
              nativeResult.code === "not-found" ? 404 : 422,
              errorPayload(
                new Error(nativeResult.message ?? nativeResult.code),
                nativeResult.code,
              ),
            );
            return;
          }
          const snapshot = await this.allTasksSnapshot(
            boolValue(body.includeProperties),
          );
          if (snapshot.generation !== queryGeneration) {
            throw new Error(
              "Operon generation changed while evaluating the saved filter; retry.",
            );
          }
          const taskById = new Map(
            snapshot.tasks.map((task) => [task.operonId, task]),
          );
          const orderedTasks = nativeResult.operonIds
            .map((operonId) => taskById.get(operonId))
            .filter((task): task is OperonBridgeTask => Boolean(task));
          const cursor = Math.max(0, Math.trunc(numberValue(body.cursor) ?? 0));
          const limit = Math.min(
            500,
            Math.max(1, Math.trunc(numberValue(body.limit) ?? 100)),
          );
          const tasks = orderedTasks.slice(cursor, cursor + limit);
          const nextCursor = cursor + tasks.length;
          sendJson(res, 200, {
            ok: true,
            contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
            source: "operon-live",
            stale: false,
            generation: snapshot.generation,
            settingsSignature: snapshot.settingsSignature,
            total: orderedTasks.length,
            count: tasks.length,
            cursor: String(cursor),
            ...(nextCursor < orderedTasks.length
              ? { nextCursor: String(nextCursor) }
              : {}),
            hasMore: nextCursor < orderedTasks.length,
            tasks,
            limitations: this.limitations(runtime, true),
          });
        } catch (error) {
          sendJson(res, 400, errorPayload(error, "filter_query_error"));
        }
      });

    api.addRoute(`${REST_PREFIX}/tasks`).post(async (req: any, res: any) => {
      try {
        const result = await this.executeCreateMutation(this.bodyRecord(req));
        sendJson(res, result.httpStatus, result.payload);
      } catch (error) {
        sendJson(res, 503, errorPayload(error, "mutation_unavailable"));
      }
    });

    api
      .addRoute(`${REST_PREFIX}/tasks/adopt`)
      .post(async (req: any, res: any) => {
        try {
          const result = await this.executeAdoptMutation(this.bodyRecord(req));
          sendJson(res, result.httpStatus, result.payload);
        } catch (error) {
          sendJson(res, 503, errorPayload(error, "mutation_unavailable"));
        }
      });

    api
      .addRoute(`${REST_PREFIX}/tasks/:operonId/update`)
      .post(async (req: any, res: any) => {
        try {
          const operonId = decodeURIComponent(
            String(req?.params?.operonId ?? ""),
          ).trim();
          const body = this.bodyRecord(req);
          const requested =
            body.patch &&
            typeof body.patch === "object" &&
            !Array.isArray(body.patch)
              ? (body.patch as Record<string, unknown>)
              : {};
          const result = await this.executeExistingMutation(
            "update",
            operonId,
            body,
            requested,
            (operonApi) => operonApi.updateTask(operonId, requested),
          );
          sendJson(res, result.httpStatus, result.payload);
        } catch (error) {
          sendJson(res, 503, errorPayload(error, "mutation_unavailable"));
        }
      });

    api
      .addRoute(`${REST_PREFIX}/tasks/:operonId/transition`)
      .post(async (req: any, res: any) => {
        try {
          const operonId = decodeURIComponent(
            String(req?.params?.operonId ?? ""),
          ).trim();
          const body = this.bodyRecord(req);
          const requested = {
            ...(String(body.status ?? "").trim()
              ? { status: String(body.status).trim() }
              : {}),
            ...(String(body.statusId ?? "").trim()
              ? { statusId: String(body.statusId).trim() }
              : {}),
          };
          const result = await this.executeExistingMutation(
            "transition",
            operonId,
            body,
            requested,
            (operonApi) => operonApi.transitionTask(operonId, requested),
          );
          sendJson(res, result.httpStatus, result.payload);
        } catch (error) {
          sendJson(res, 503, errorPayload(error, "mutation_unavailable"));
        }
      });

    api
      .addRoute(`${REST_PREFIX}/tasks/:operonId/convert`)
      .post(async (req: any, res: any) => {
        try {
          const operonId = decodeURIComponent(
            String(req?.params?.operonId ?? ""),
          ).trim();
          const body = this.bodyRecord(req);
          const requested = {
            target: String(body.target ?? "").trim(),
            ...(body.fileTemplateId
              ? { fileTemplateId: String(body.fileTemplateId) }
              : {}),
            ...(body.targetPath ? { targetPath: String(body.targetPath) } : {}),
            ...(body.targetFolder
              ? { targetFolder: String(body.targetFolder) }
              : {}),
          };
          const result = await this.executeExistingMutation(
            "convert",
            operonId,
            body,
            requested,
            (operonApi) => operonApi.convertTask(operonId, requested),
          );
          sendJson(res, result.httpStatus, result.payload);
        } catch (error) {
          sendJson(res, 503, errorPayload(error, "mutation_unavailable"));
        }
      });

    api
      .addRoute(`${REST_PREFIX}/tasks/:operonId/relocate`)
      .post(async (req: any, res: any) => {
        try {
          const operonId = decodeURIComponent(
            String(req?.params?.operonId ?? ""),
          ).trim();
          const body = this.bodyRecord(req);
          const requested = {
            targetPath: body.targetPath,
          };
          const result = await this.executeExistingMutation(
            "relocate",
            operonId,
            body,
            requested,
            (operonApi) => operonApi.relocateTask(operonId, requested),
          );
          sendJson(res, result.httpStatus, result.payload);
        } catch (error) {
          sendJson(res, 503, errorPayload(error, "mutation_unavailable"));
        }
      });

    api.addRoute(`${REST_PREFIX}/validate`).get(async (req: any, res: any) => {
      try {
        sendJson(
          res,
          200,
          await this.validationPayload(
            boolValue(readQueryValue(req, "includeProperties")),
          ),
        );
      } catch (error) {
        sendJson(res, 503, errorPayload(error, "operon_unavailable"));
      }
    });

    this.restCleanup = () => {
      try {
        api.unregister?.();
      } catch (error) {
        console.warn(
          `[${EXTENSION_ID}] Failed to unregister Local REST API routes.`,
          error,
        );
      }
    };
    this.clearMountTimers();
    console.info(
      `[${EXTENSION_ID}] REST contract v${OPERON_BRIDGE_CONTRACT_VERSION} mounted at ${REST_PREFIX}.`,
    );
  }
}
