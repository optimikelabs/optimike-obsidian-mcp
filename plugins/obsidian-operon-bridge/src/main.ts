import { Plugin, TFile } from "obsidian";
import {
  OPERON_BRIDGE_CONTRACT_VERSION,
  OPERON_BRIDGE_SUPPORTED_VERSIONS,
  OPERON_BRIDGE_TESTED_VERSION,
  isIndexReady,
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
} from "./contract";

const EXTENSION_ID = "optimike-operon-bridge";
const REST_PREFIX = `/extensions/${EXTENSION_ID}/v1`;
const OPERON_PLUGIN_ID = "operon";
const LOCAL_REST_PLUGIN_ID = "obsidian-local-rest-api";
const MAX_MOUNT_WAIT_MS = 30_000;
const MOUNT_RETRY_MS = 500;

interface OperonRuntime {
  plugin: any;
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
}

interface BridgeCapabilities {
  status: boolean;
  list: boolean;
  get: boolean;
  query: boolean;
  validate: boolean;
  create: false;
  update: false;
  transition: false;
  convert: false;
}

interface StableTaskRead {
  tasks: OperonBridgeTask[];
  generation: number;
  settingsSignature: string;
}

const READ_ONLY_LIMITATIONS = [
  "Bridge contract v1 is intentionally read-only.",
  "Mutations are disabled because the tested Operon releases do not expose a public versioned mutation API that guarantees the full domain orchestration path.",
  "Exact Operon semantics require Obsidian Desktop with Operon loaded; headless clients must treat persisted MCP snapshots as stale fallbacks.",
  "Unmanaged frontmatter properties are returned only for file tasks and only when includeProperties=true.",
];

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
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

function errorPayload(error: unknown, code = "bridge_error"): Record<string, unknown> {
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
    "pipelines",
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
  if (Array.isArray(source.dates)) query.dates = source.dates as OperonTaskQuery["dates"];
  if (source.fieldEquals && typeof source.fieldEquals === "object" && !Array.isArray(source.fieldEquals)) {
    query.fieldEquals = Object.fromEntries(
      Object.entries(source.fieldEquals as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }
  if (source.propertyEquals && typeof source.propertyEquals === "object" && !Array.isArray(source.propertyEquals)) {
    query.propertyEquals = source.propertyEquals as Record<string, unknown>;
  }
  if (Array.isArray(source.sort)) query.sort = source.sort as OperonTaskQuery["sort"];
  if (typeof source.includeProperties === "boolean") query.includeProperties = source.includeProperties;
  if (typeof source.cursor === "string") query.cursor = source.cursor;
  const limit = numberValue(source.limit);
  if (limit !== undefined) query.limit = limit;
  return query;
}

export default class OptimikeOperonBridgePlugin extends Plugin {
  private restCleanup: (() => void) | null = null;
  private mountInterval: number | null = null;
  private mountTimeout: number | null = null;
  private indexValidationInFlight: Promise<void> | null = null;

  async onload(): Promise<void> {
    this.app.workspace.onLayoutReady(() => {
      this.tryMountRestExtension();
      if (this.restCleanup) return;
      this.mountInterval = window.setInterval(() => this.tryMountRestExtension(), MOUNT_RETRY_MS);
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

  private getOperonRuntime(): OperonRuntime | null {
    const plugin = this.getCommunityPlugin(OPERON_PLUGIN_ID);
    if (!plugin) return null;
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
      version,
      compatible: isVersionCompatible(version),
      indexer,
      pipelines: Array.isArray(plugin?.settings?.pipelines) ? plugin.settings.pipelines : [],
      keyMappings: Array.isArray(plugin?.settings?.keyMappings) ? plugin.settings.keyMappings : [],
    };
  }

  private capabilities(runtime: OperonRuntime | null, ready = false): BridgeCapabilities {
    const readable = Boolean(runtime?.compatible && ready);
    return {
      status: true,
      list: readable,
      get: readable,
      query: readable,
      validate: readable,
      create: false,
      update: false,
      transition: false,
      convert: false,
    };
  }

  private async indexState(runtime: OperonRuntime | null): Promise<{
    ready: boolean;
    generation: number | null;
    diagnostics: RuntimeIndexDiagnostics | null;
  }> {
    if (!runtime?.compatible) return { ready: false, generation: null, diagnostics: null };
    const generation = runtime.indexer.getGeneration();
    let diagnostics: RuntimeIndexDiagnostics | null = null;
    try {
      diagnostics = await runtime.indexer.getIndexV8Diagnostics();
    } catch (error) {
      console.warn(`[${EXTENSION_ID}] Operon index diagnostics unavailable.`, error);
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
        console.warn(`[${EXTENSION_ID}] Operon index diagnostics unavailable after validation.`, error);
      }
    }
    return {
      generation,
      diagnostics,
      ready: isIndexReady({ compatible: runtime.compatible, generation, diagnostics }),
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
          console.warn(`[${EXTENSION_ID}] Operon index validation failed.`, error);
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
    return {
      ok: Boolean(runtime?.compatible && ready),
      contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
      bridge: {
        id: this.manifest.id,
        version: this.manifest.version,
        mode: "read-only",
      },
      operon: {
        present: Boolean(runtime),
        version: runtime?.version ?? null,
        compatible: Boolean(runtime?.compatible),
        testedAgainst: OPERON_BRIDGE_TESTED_VERSION,
        supportedRange: OPERON_BRIDGE_SUPPORTED_VERSIONS.join(", "),
      },
      index: {
        ready,
        generation: indexState.generation,
        taskCount,
        duplicateConflictCount: registry?.totalConflictCount ?? 0,
        diagnostics: indexState.diagnostics,
      },
      settingsSignature: runtime
        ? settingsSignature(runtime.pipelines, runtime.keyMappings)
        : null,
      capabilities: this.capabilities(runtime, ready),
      source: "operon-runtime",
      stale: false,
      limitations: READ_ONLY_LIMITATIONS,
    };
  }

  private requireRuntime(): OperonRuntime {
    const runtime = this.getOperonRuntime();
    if (!runtime) {
      throw new Error("Operon is not loaded or its current runtime index surface is unavailable.");
    }
    if (!runtime.compatible) {
      throw new Error(
        `Operon ${runtime.version || "unknown"} is not in the tested Bridge allowlist (${OPERON_BRIDGE_SUPPORTED_VERSIONS.join(", ")}).`,
      );
    }
    return runtime;
  }

  private normalizeRuntimeTask(
    runtime: OperonRuntime,
    task: RuntimeIndexedTask,
    includeProperties: boolean,
  ): OperonBridgeTask {
    const abstract = this.app.vault.getAbstractFileByPath(task.primary.filePath);
    const file = abstract instanceof TFile ? abstract : null;
    const frontmatter =
      includeProperties && task.primary.format === "yaml" && file
        ? (this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined)
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

  private async allTasksSnapshot(includeProperties: boolean): Promise<StableTaskRead> {
    const runtime = this.requireRuntime();
    const before = await this.indexState(runtime);
    if (!before.ready || before.generation === null) {
      throw new Error("Operon index is still initializing or is not in a verified idle state.");
    }
    const beforeSettings = settingsSignature(runtime.pipelines, runtime.keyMappings);
    const tasks = runtime.indexer
      .getAllTasks()
      .map((task) => this.normalizeRuntimeTask(runtime, task, includeProperties));
    const after = await this.indexState(runtime);
    const afterSettings = settingsSignature(runtime.pipelines, runtime.keyMappings);
    if (
      !after.ready ||
      after.generation !== before.generation ||
      afterSettings !== beforeSettings ||
      before.diagnostics?.taskCount !== tasks.length ||
      after.diagnostics?.taskCount !== tasks.length
    ) {
      throw new Error("Operon generation or settings changed during the read; retry after the index settles.");
    }
    return { tasks, generation: before.generation, settingsSignature: beforeSettings };
  }

  private async oneTask(operonId: string, includeProperties: boolean): Promise<{
    task: OperonBridgeTask | null;
    generation: number;
    settingsSignature: string;
  }> {
    const runtime = this.requireRuntime();
    const state = await this.indexState(runtime);
    if (!state.ready || state.generation === null) {
      throw new Error("Operon index is still initializing or is not in a verified idle state.");
    }
    const signature = settingsSignature(runtime.pipelines, runtime.keyMappings);
    const task = runtime.indexer.getTask(operonId);
    const normalized = task ? this.normalizeRuntimeTask(runtime, task, includeProperties) : null;
    const after = await this.indexState(runtime);
    if (
      !after.ready ||
      after.generation !== state.generation ||
      settingsSignature(runtime.pipelines, runtime.keyMappings) !== signature
    ) {
      throw new Error("Operon generation or settings changed during the read; retry after the index settles.");
    }
    return { task: normalized, generation: state.generation, settingsSignature: signature };
  }

  private async validationPayload(includeProperties = false): Promise<Record<string, unknown>> {
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
      limitations: READ_ONLY_LIMITATIONS,
    };
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

    api.addRoute(`${REST_PREFIX}/tasks`).get(async (req: any, res: any) => {
      try {
        const query: OperonTaskQuery = {
          cursor: String(readQueryValue(req, "cursor") ?? "0"),
          limit: numberValue(readQueryValue(req, "limit")),
          includeProperties: boolValue(readQueryValue(req, "includeProperties")),
        };
        const snapshot = await this.allTasksSnapshot(Boolean(query.includeProperties));
        const result = queryTasks(snapshot.tasks, query);
        sendJson(res, 200, {
          ok: true,
          contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
          source: "operon-live",
          stale: false,
          generation: snapshot.generation,
          settingsSignature: snapshot.settingsSignature,
          ...result,
          limitations: READ_ONLY_LIMITATIONS,
        });
      } catch (error) {
        sendJson(res, 503, errorPayload(error, "operon_unavailable"));
      }
    });

    api.addRoute(`${REST_PREFIX}/tasks/:operonId`).get(async (req: any, res: any) => {
      try {
        const operonId = decodeURIComponent(String(req?.params?.operonId ?? "")).trim();
        if (!operonId) {
          sendJson(res, 400, errorPayload(new Error("operonId is required."), "validation_error"));
          return;
        }
        const result = await this.oneTask(operonId, boolValue(readQueryValue(req, "includeProperties")));
        if (!result.task) {
          sendJson(res, 404, errorPayload(new Error(`Operon task not found: ${operonId}`), "not_found"));
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
          limitations: READ_ONLY_LIMITATIONS,
        });
      } catch (error) {
        sendJson(res, 503, errorPayload(error, "operon_unavailable"));
      }
    });

    api.addRoute(`${REST_PREFIX}/tasks/query`).post(async (req: any, res: any) => {
      try {
        const query = sanitizeQuery(req?.body ?? {});
        const snapshot = await this.allTasksSnapshot(Boolean(query.includeProperties));
        const result = queryTasks(snapshot.tasks, query);
        sendJson(res, 200, {
          ok: true,
          contractVersion: OPERON_BRIDGE_CONTRACT_VERSION,
          source: "operon-live",
          stale: false,
          generation: snapshot.generation,
          settingsSignature: snapshot.settingsSignature,
          ...result,
          limitations: READ_ONLY_LIMITATIONS,
        });
      } catch (error) {
        sendJson(res, 400, errorPayload(error, "query_error"));
      }
    });

    api.addRoute(`${REST_PREFIX}/validate`).get(async (req: any, res: any) => {
      try {
        sendJson(
          res,
          200,
          await this.validationPayload(boolValue(readQueryValue(req, "includeProperties"))),
        );
      } catch (error) {
        sendJson(res, 503, errorPayload(error, "operon_unavailable"));
      }
    });

    this.restCleanup = () => {
      try {
        api.unregister?.();
      } catch (error) {
        console.warn(`[${EXTENSION_ID}] Failed to unregister Local REST API routes.`, error);
      }
    };
    this.clearMountTimers();
    console.info(
      `[${EXTENSION_ID}] Read-only REST contract v${OPERON_BRIDGE_CONTRACT_VERSION} mounted at ${REST_PREFIX}.`,
    );
  }
}
