import axios, { type AxiosInstance } from "axios";
import { mkdirSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { logger, requestContextService } from "../../utils/index.js";
import { assertWriteAllowed } from "../writePolicy.js";
import {
  OPERON_CONTRACT_VERSION,
  OPERON_SNAPSHOT_SCHEMA_VERSION,
  OperonBridgePageSchema,
  OperonQuerySchema,
  OperonStatusSchema,
  OperonTaskSchema,
  OperonValidationSchema,
  queryOperonSnapshot,
  OperonCapabilitiesSchema,
  OperonConvertTaskSchema,
  OperonCreateTaskSchema,
  OperonMutationResultSchema,
  OperonTransitionTaskSchema,
  OperonUpdateTaskSchema,
  type OperonBridgePage,
  type OperonQuery,
  type OperonSnapshotEnvelope,
  type OperonStatus,
  type OperonTask,
  type OperonTaskPage,
  type OperonValidation,
  type OperonConvertTask,
  type OperonCreateTask,
  type OperonMutationResult,
  type OperonTransitionTask,
  type OperonUpdateTask,
} from "./contract.js";
import type { z } from "zod";

const BRIDGE_PREFIX = "/extensions/optimike-operon-bridge/v1";
const PAGE_SIZE = 500;
const MAX_PAGES = 10_000;
const SNAPSHOT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS operon_task_snapshot (
  operon_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_mtime INTEGER,
  payload_json TEXT NOT NULL,
  operon_version TEXT NOT NULL,
  bridge_version TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operon_snapshot_path
  ON operon_task_snapshot (source_path);
CREATE INDEX IF NOT EXISTS idx_operon_snapshot_mtime
  ON operon_task_snapshot (source_mtime DESC);
CREATE TABLE IF NOT EXISTS operon_snapshot_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operon_mutation_journal (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  operon_id TEXT,
  action TEXT NOT NULL,
  requested_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operon_mutation_created
  ON operon_mutation_journal (created_at DESC);
`;

const CACHE_LIMITATIONS = [
  "Operon is not loaded in headless modes; cached results are a last known snapshot, not live plugin semantics.",
  "Cached results must not be used as proof that a mutation was applied.",
  "Mutation tools require the live Bridge and cannot apply or dry-run against a stale/headless snapshot.",
];

interface SnapshotRow {
  operonId: string;
  payloadJson: string;
}

interface SnapshotMeta {
  snapshotAt: number;
  generation: number | null;
  settingsSignature: string | null;
  operonVersion: string;
  bridgeVersion: string;
  contractVersion: string;
  status: OperonStatus | null;
  validation: OperonValidation | null;
}

type OperonCapabilities = z.infer<typeof OperonCapabilitiesSchema>;

let sharedRefreshPromise: Promise<OperonSnapshotEnvelope> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function liveModeConfigured(): boolean {
  return (
    config.obsidianRuntimeMode === "live" ||
    (config.obsidianRuntimeMode === "hybrid" && Boolean(config.obsidianApiKey))
  );
}

function readOnlyCapabilities(): OperonCapabilities {
  return {
    status: true,
    list: true,
    get: true,
    query: true,
    validate: true,
    create: false,
    update: false,
    transition: false,
    convert: false,
  };
}

function safeJsonParse(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
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

interface MutationJournalEntry {
  action: string;
  operonId: string | null;
  requestedJson: string;
  result: OperonMutationResult;
}

export class OperonService {
  private readonly dbPath = config.obsidianSharedCacheDbPath;
  private client: AxiosInstance | null = null;
  private readonly mutationInFlight = new Map<string, {
    signature: string;
    promise: Promise<OperonMutationResult>;
  }>();

  private requestContext(operation: string, extra: Record<string, unknown> = {}) {
    return requestContextService.createRequestContext({
      operation,
      component: "OperonService",
      ...extra,
    });
  }

  private getClient(): AxiosInstance {
    if (this.client) return this.client;
    if (!config.obsidianApiKey) {
      throw new McpError(
        BaseErrorCode.CONFIGURATION_ERROR,
        "OBSIDIAN_API_KEY is required to query the live Operon Bridge.",
        this.requestContext("operonClientInit"),
      );
    }
    this.client = axios.create({
      baseURL: config.obsidianBaseUrl.replace(/\/$/u, ""),
      headers: {
        Authorization: `Bearer ${config.obsidianApiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 60_000,
      httpsAgent: new https.Agent({ rejectUnauthorized: config.obsidianVerifySsl }),
    });
    return this.client;
  }

  private openDb(): DatabaseSync {
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SNAPSHOT_TABLE_SQL);
    return db;
  }

  private readMutationJournal(idempotencyKey: string): MutationJournalEntry | null {
    const db = this.openDb();
    try {
      const row = db.prepare(
        `SELECT action, operon_id as operonId, requested_json as requestedJson,
                result_json as resultJson
         FROM operon_mutation_journal WHERE idempotency_key = ?`,
      ).get(idempotencyKey) as {
        action?: string;
        operonId?: string | null;
        requestedJson?: string;
        resultJson?: string;
      } | undefined;
      if (!row?.resultJson) return null;
      const parsed = OperonMutationResultSchema.safeParse(JSON.parse(row.resultJson));
      if (!parsed.success || !row.action || !row.requestedJson) return null;
      return {
        action: row.action,
        operonId: row.operonId ?? null,
        requestedJson: row.requestedJson,
        result: { ...parsed.data, replayed: true },
      };
    } finally {
      db.close();
    }
  }

  private writeMutationJournal(
    action: string,
    operonId: string | null,
    requested: unknown,
    result: OperonMutationResult,
  ): void {
    const now = Date.now();
    const db = this.openDb();
    try {
      db.prepare(
        `INSERT INTO operon_mutation_journal (
          operation_id, idempotency_key, operon_id, action, requested_json,
          result_json, status, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run(
        result.operationId,
        result.idempotencyKey,
        operonId,
        action,
        stableJson(requested),
        JSON.stringify(result),
        result.status,
        now,
        now,
      );
    } finally {
      db.close();
    }
  }

  private async executeMutation(
    action: "create" | "update" | "transition" | "convert",
    operonId: string | null,
    idempotencyKey: string,
    dryRun: boolean,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<OperonMutationResult> {
    const requestedJson = stableJson(payload);
    const signature = stableJson({ action, operonId, payload });
    const existing = this.readMutationJournal(idempotencyKey);
    if (existing) {
      if (existing.action !== action || existing.requestedJson !== requestedJson) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Idempotency key was already used for a different Operon mutation request.",
          this.requestContext(`operon_${action}`, { operonId, idempotencyKey }),
        );
      }
      return existing.result;
    }
    const inFlight = this.mutationInFlight.get(idempotencyKey);
    if (inFlight) {
      if (inFlight.signature !== signature) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Idempotency key is currently executing a different Operon mutation request.",
          this.requestContext(`operon_${action}`, { operonId, idempotencyKey }),
        );
      }
      return inFlight.promise;
    }
    const promise = this.performMutation(action, operonId, idempotencyKey, dryRun, path, payload);
    this.mutationInFlight.set(idempotencyKey, { signature, promise });
    try {
      return await promise;
    } finally {
      if (this.mutationInFlight.get(idempotencyKey)?.promise === promise) {
        this.mutationInFlight.delete(idempotencyKey);
      }
    }
  }

  private async performMutation(
    action: "create" | "update" | "transition" | "convert",
    operonId: string | null,
    idempotencyKey: string,
    dryRun: boolean,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<OperonMutationResult> {
    if (!liveModeConfigured()) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Operon mutations require the live Obsidian Desktop Bridge.",
        this.requestContext(`operon_${action}`, { operonId }),
      );
    }
    const status = await this.fetchLiveStatus();
    if (!status.capabilities[action]) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon Bridge capability is unavailable: ${action}.`,
        this.requestContext(`operon_${action}`, { operonId, capabilities: status.capabilities }),
      );
    }
    const operation = `operon_${action}_task` as const;
    assertWriteAllowed({
      operation,
      action: dryRun ? "dry_run" : "apply",
      target: operonId ?? "new-task",
      destructive: action === "convert" && !dryRun,
      allowInReadonly: dryRun,
      allowInGuarded: dryRun || action !== "convert",
      context: this.requestContext(operation, { operonId, idempotencyKey }),
    });
    const response = await this.getClient().post(path, payload, {
      validateStatus: () => true,
    });
    const parsed = OperonMutationResultSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        `Invalid Operon mutation response (${response.status}).`,
        this.requestContext(operation, { operonId, issues: parsed.error.issues, response: response.data }),
      );
    }
    const result = parsed.data;
    this.writeMutationJournal(action, operonId ?? result.after?.operonId ?? null, payload, result);
    if (result.status === "applied") {
      try {
        await this.ensureSnapshot(true);
      } catch (error) {
        logger.warning("Operon mutation succeeded but snapshot refresh failed.", {
          ...this.requestContext(operation, { operonId, operationId: result.operationId }),
          error: errorMessage(error),
        });
      }
    }
    return result;
  }

  private readMeta(db: DatabaseSync): SnapshotMeta | null {
    const rows = db
      .prepare("SELECT key, value FROM operon_snapshot_meta")
      .all() as unknown as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const snapshotAt = Number(values.get("snapshot_at"));
    if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) return null;
    const generationRaw = values.get("generation");
    const generation = generationRaw === undefined || generationRaw === "null"
      ? null
      : Number(generationRaw);
    const parsedStatus = safeJsonParse(values.get("status_json"));
    const statusResult = parsedStatus
      ? OperonStatusSchema.safeParse(parsedStatus)
      : { success: false as const };
    const parsedValidation = safeJsonParse(values.get("validation_json"));
    const validationResult = parsedValidation
      ? OperonValidationSchema.safeParse(parsedValidation)
      : { success: false as const };
    return {
      snapshotAt,
      generation: Number.isFinite(generation) ? generation : null,
      settingsSignature: values.get("settings_signature") ?? null,
      operonVersion: values.get("operon_version") ?? "unknown",
      bridgeVersion: values.get("bridge_version") ?? "unknown",
      contractVersion: values.get("contract_version") ?? "unknown",
      status: statusResult.success ? statusResult.data : null,
      validation: validationResult.success ? validationResult.data : null,
    };
  }

  private loadSnapshot(source: "operon-live" | "operon-cache"): OperonSnapshotEnvelope | null {
    const db = this.openDb();
    try {
      const meta = this.readMeta(db);
      if (!meta) return null;
      if (meta.contractVersion !== OPERON_CONTRACT_VERSION) {
        throw new McpError(
          BaseErrorCode.PARSING_ERROR,
          `Operon snapshot contract ${meta.contractVersion} is incompatible with MCP contract ${OPERON_CONTRACT_VERSION}.`,
          this.requestContext("loadOperonSnapshot", { dbPath: this.dbPath }),
        );
      }
      const rows = db
        .prepare(
          `SELECT operon_id as operonId, payload_json as payloadJson
           FROM operon_task_snapshot
           ORDER BY source_path ASC, operon_id ASC`,
        )
        .all() as unknown as SnapshotRow[];
      const tasks: OperonTask[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const parsed = OperonTaskSchema.safeParse(JSON.parse(row.payloadJson));
        if (!parsed.success) {
          throw new McpError(
            BaseErrorCode.PARSING_ERROR,
            `Invalid Operon task snapshot payload for ${row.operonId}.`,
            this.requestContext("loadOperonSnapshot", {
              operonId: row.operonId,
              issues: parsed.error.issues,
            }),
          );
        }
        if (seen.has(parsed.data.operonId)) {
          throw new McpError(
            BaseErrorCode.CONFLICT,
            `Duplicate operonId in MCP snapshot: ${parsed.data.operonId}.`,
            this.requestContext("loadOperonSnapshot", { operonId: parsed.data.operonId }),
          );
        }
        seen.add(parsed.data.operonId);
        tasks.push(parsed.data);
      }
      const now = Date.now();
      const stale = source === "operon-cache";
      return {
        source,
        stale,
        snapshotAt: new Date(meta.snapshotAt).toISOString(),
        snapshotAgeMs: Math.max(0, now - meta.snapshotAt),
        operonVersion: meta.operonVersion,
        bridgeVersion: meta.bridgeVersion,
        contractVersion: OPERON_CONTRACT_VERSION,
        settingsSignature: meta.settingsSignature,
        generation: meta.generation,
        capabilities: meta.status?.capabilities ?? readOnlyCapabilities(),
        limitations: stale
          ? [...new Set([...(meta.status?.limitations ?? []), ...CACHE_LIMITATIONS])]
          : meta.status?.limitations ?? [],
        tasks,
      };
    } finally {
      db.close();
    }
  }

  private writeMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare(
      `INSERT INTO operon_snapshot_meta (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  private saveSnapshot(
    status: OperonStatus,
    tasks: OperonTask[],
    validation: OperonValidation | null,
  ): void {
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.operonId)) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          `Live Operon Bridge returned duplicate operonId ${task.operonId}; existing snapshot was preserved.`,
          this.requestContext("saveOperonSnapshot", { operonId: task.operonId }),
        );
      }
      seen.add(task.operonId);
    }
    if (status.index.duplicateConflictCount > 0) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        `Operon reports ${status.index.duplicateConflictCount} duplicate operonId conflict(s); snapshot refresh was refused.`,
        this.requestContext("saveOperonSnapshot", {
          duplicateConflictCount: status.index.duplicateConflictCount,
        }),
      );
    }

    const db = this.openDb();
    const snapshotAt = Date.now();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("DELETE FROM operon_task_snapshot");
      const insert = db.prepare(
        `INSERT INTO operon_task_snapshot (
           operon_id, revision, source_path, source_mtime, payload_json,
           operon_version, bridge_version, snapshot_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const task of tasks) {
        insert.run(
          task.operonId,
          task.revision,
          task.path,
          task.sourceMtime,
          JSON.stringify(task),
          status.operon.version ?? "unknown",
          status.bridge.version,
          snapshotAt,
        );
      }
      this.writeMeta(db, "snapshot_schema_version", String(OPERON_SNAPSHOT_SCHEMA_VERSION));
      this.writeMeta(db, "snapshot_at", String(snapshotAt));
      this.writeMeta(db, "generation", String(status.index.generation));
      this.writeMeta(db, "settings_signature", status.settingsSignature ?? "");
      this.writeMeta(db, "operon_version", status.operon.version ?? "unknown");
      this.writeMeta(db, "bridge_version", status.bridge.version);
      this.writeMeta(db, "contract_version", status.contractVersion);
      this.writeMeta(db, "status_json", JSON.stringify(status));
      if (validation) this.writeMeta(db, "validation_json", JSON.stringify(validation));
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Keep the original failure.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  private async fetchLiveStatus(): Promise<OperonStatus> {
    const response = await this.getClient().get(`${BRIDGE_PREFIX}/status`);
    const parsed = OperonStatusSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge /status returned an incompatible payload.",
        this.requestContext("fetchLiveOperonStatus", { issues: parsed.error.issues }),
      );
    }
    if (!parsed.data.ok || !parsed.data.operon.compatible || !parsed.data.index.ready) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon Bridge is not ready (present=${parsed.data.operon.present}, version=${parsed.data.operon.version ?? "unknown"}, compatible=${parsed.data.operon.compatible}).`,
        this.requestContext("fetchLiveOperonStatus"),
      );
    }
    if (!parsed.data.capabilities.list || !parsed.data.capabilities.query) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Operon Bridge does not expose the required read capabilities.",
        this.requestContext("fetchLiveOperonStatus"),
      );
    }
    if (parsed.data.index.duplicateConflictCount > 0) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        `Operon reports ${parsed.data.index.duplicateConflictCount} duplicate operonId conflict(s).`,
        this.requestContext("fetchLiveOperonStatus", {
          duplicateConflictCount: parsed.data.index.duplicateConflictCount,
        }),
      );
    }
    return parsed.data;
  }

  private async fetchLiveValidation(): Promise<OperonValidation> {
    const response = await this.getClient().get(`${BRIDGE_PREFIX}/validate`);
    const parsed = OperonValidationSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge /validate returned an incompatible payload.",
        this.requestContext("fetchLiveOperonValidation", { issues: parsed.error.issues }),
      );
    }
    return parsed.data;
  }

  private assertStableStatus(
    expected: OperonStatus,
    observed: OperonStatus,
    phase: string,
  ): void {
    const changed =
      observed.index.generation !== expected.index.generation ||
      observed.index.taskCount !== expected.index.taskCount ||
      observed.settingsSignature !== expected.settingsSignature ||
      observed.operon.version !== expected.operon.version ||
      observed.bridge.version !== expected.bridge.version;
    if (changed) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        `Operon index or settings changed during ${phase}; retry after the index settles.`,
        this.requestContext("assertStableOperonStatus", {
          phase,
          expectedGeneration: expected.index.generation,
          observedGeneration: observed.index.generation,
          expectedTaskCount: expected.index.taskCount,
          observedTaskCount: observed.index.taskCount,
          expectedSettingsSignature: expected.settingsSignature,
          observedSettingsSignature: observed.settingsSignature,
        }),
      );
    }
  }

  private async fetchAllLiveTasks(
    expectedStatus: OperonStatus,
  ): Promise<{ tasks: OperonTask[]; settledStatus: OperonStatus }> {
    const tasks: OperonTask[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined = undefined;
    let expectedTotal: number | null = null;

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const response = (await this.getClient().post(`${BRIDGE_PREFIX}/tasks/query`, {
        cursor,
        limit: PAGE_SIZE,
        includeProperties: true,
        sort: [
          { field: "path", direction: "asc" },
          { field: "line", direction: "asc" },
        ],
      })) as { data: unknown };
      const parsed = OperonBridgePageSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new McpError(
          BaseErrorCode.PARSING_ERROR,
          "Operon Bridge /tasks/query returned an incompatible payload.",
          this.requestContext("fetchAllLiveOperonTasks", {
            pageIndex,
            issues: parsed.error.issues,
          }),
        );
      }
      const page: OperonBridgePage = parsed.data;
      if (
        page.generation !== expectedStatus.index.generation ||
        page.settingsSignature !== expectedStatus.settingsSignature
      ) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Operon generation or settings changed between snapshot pages.",
          this.requestContext("fetchAllLiveOperonTasks", {
            pageIndex,
            expectedGeneration: expectedStatus.index.generation,
            observedGeneration: page.generation,
            expectedSettingsSignature: expectedStatus.settingsSignature,
            observedSettingsSignature: page.settingsSignature,
          }),
        );
      }
      expectedTotal ??= page.total;
      if (page.total !== expectedTotal) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Operon task count changed while the snapshot was being paged; retry after the index settles.",
          this.requestContext("fetchAllLiveOperonTasks", {
            expectedTotal,
            observedTotal: page.total,
            pageIndex,
          }),
        );
      }
      tasks.push(...page.tasks);
      if (!page.hasMore) break;
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new McpError(
          BaseErrorCode.PARSING_ERROR,
          "Operon Bridge returned an invalid or repeated pagination cursor.",
          this.requestContext("fetchAllLiveOperonTasks", { pageIndex, cursor: page.nextCursor }),
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (expectedTotal === null) {
      const settledStatus = await this.fetchLiveStatus();
      this.assertStableStatus(expectedStatus, settledStatus, "empty snapshot pagination");
      return { tasks: [], settledStatus };
    }
    if (tasks.length !== expectedTotal) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        `Operon snapshot pagination ended with ${tasks.length}/${expectedTotal} tasks.`,
        this.requestContext("fetchAllLiveOperonTasks"),
      );
    }
    const settledStatus = await this.fetchLiveStatus();
    this.assertStableStatus(expectedStatus, settledStatus, "snapshot pagination");
    return { tasks, settledStatus };
  }

  private sameLiveGeneration(snapshot: OperonSnapshotEnvelope | null, status: OperonStatus): boolean {
    return Boolean(
      snapshot &&
        snapshot.generation === status.index.generation &&
        snapshot.settingsSignature === status.settingsSignature &&
        snapshot.operonVersion === status.operon.version &&
        snapshot.bridgeVersion === status.bridge.version &&
        snapshot.tasks.length === status.index.taskCount,
    );
  }

  private async refreshLiveSnapshot(status?: OperonStatus): Promise<OperonSnapshotEnvelope> {
    const liveStatus = status ?? (await this.fetchLiveStatus());
    const pageResult = await this.fetchAllLiveTasks(liveStatus);
    const validation = await this.fetchLiveValidation();
    if (
      validation.generation !== pageResult.settledStatus.index.generation ||
      validation.settingsSignature !== pageResult.settledStatus.settingsSignature
    ) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "Operon generation or settings changed before validation completed.",
        this.requestContext("refreshLiveOperonSnapshot", {
          expectedGeneration: pageResult.settledStatus.index.generation,
          observedGeneration: validation.generation,
          expectedSettingsSignature: pageResult.settledStatus.settingsSignature,
          observedSettingsSignature: validation.settingsSignature,
        }),
      );
    }
    if (!validation.ok || validation.summary.P0 > 0) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        `Operon validation reported ${validation.summary.P0} P0 violation(s); snapshot refresh was refused.`,
        this.requestContext("refreshLiveOperonSnapshot", { summary: validation.summary }),
      );
    }
    const finalStatus = await this.fetchLiveStatus();
    this.assertStableStatus(pageResult.settledStatus, finalStatus, "snapshot validation");
    this.saveSnapshot(finalStatus, pageResult.tasks, validation);
    const snapshot = this.loadSnapshot("operon-live");
    if (!snapshot) {
      throw new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        "Operon snapshot was written but could not be reloaded.",
        this.requestContext("refreshLiveOperonSnapshot"),
      );
    }
    return snapshot;
  }

  private async refreshLiveSnapshotCoalesced(status?: OperonStatus): Promise<OperonSnapshotEnvelope> {
    if (!sharedRefreshPromise) {
      sharedRefreshPromise = this.refreshLiveSnapshot(status).finally(() => {
        sharedRefreshPromise = null;
      });
    }
    return await sharedRefreshPromise;
  }

  async ensureSnapshot(forceRefresh = false): Promise<OperonSnapshotEnvelope> {
    const context = this.requestContext("ensureOperonSnapshot", {
      forceRefresh,
      runtimeMode: config.obsidianRuntimeMode,
    });
    const cached = this.loadSnapshot("operon-cache");

    if (!liveModeConfigured()) {
      if (cached) return cached;
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "No live Operon Bridge is configured and no persisted Operon snapshot exists.",
        context,
      );
    }

    try {
      const status = await this.fetchLiveStatus();
      if (!forceRefresh && this.sameLiveGeneration(cached, status)) {
        return {
          ...cached!,
          source: "operon-live",
          stale: false,
          snapshotAgeMs: Math.max(0, Date.now() - Date.parse(cached!.snapshotAt)),
          capabilities: status.capabilities,
          limitations: status.limitations,
        };
      }
      return await this.refreshLiveSnapshotCoalesced(status);
    } catch (error) {
      logger.warning("Live Operon Bridge unavailable; considering persisted snapshot fallback.", {
        ...context,
        error: errorMessage(error),
        cacheAvailable: Boolean(cached),
      });
      if (cached) return cached;
      if (error instanceof McpError) throw error;
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon Bridge unavailable and no cache exists: ${errorMessage(error)}`,
        context,
      );
    }
  }

  async status(forceRefresh = false): Promise<Record<string, unknown>> {
    if (forceRefresh) {
      const snapshot = await this.ensureSnapshot(true);
      return {
        ok: true,
        source: snapshot.source,
        stale: snapshot.stale,
        snapshot: this.snapshotSummary(snapshot),
      };
    }

    const cached = this.loadSnapshot("operon-cache");
    if (liveModeConfigured()) {
      try {
        const live = await this.fetchLiveStatus();
        return {
          ok: live.ok,
          source: "operon-live",
          stale: false,
          live,
          snapshot: cached ? this.snapshotSummary(cached) : null,
        };
      } catch (error) {
        return {
          ok: Boolean(cached),
          source: cached ? "operon-cache" : "unavailable",
          stale: Boolean(cached),
          error: { code: "live_bridge_unavailable", message: errorMessage(error) },
          snapshot: cached ? this.snapshotSummary(cached) : null,
          limitations: CACHE_LIMITATIONS,
        };
      }
    }

    return {
      ok: Boolean(cached),
      source: cached ? "operon-cache" : "unavailable",
      stale: Boolean(cached),
      snapshot: cached ? this.snapshotSummary(cached) : null,
      limitations: CACHE_LIMITATIONS,
    };
  }

  private snapshotSummary(snapshot: OperonSnapshotEnvelope): Record<string, unknown> {
    return {
      taskCount: snapshot.tasks.length,
      snapshotAt: snapshot.snapshotAt,
      snapshotAgeMs: snapshot.snapshotAgeMs,
      operonVersion: snapshot.operonVersion,
      bridgeVersion: snapshot.bridgeVersion,
      contractVersion: snapshot.contractVersion,
      settingsSignature: snapshot.settingsSignature,
      generation: snapshot.generation,
      capabilities: snapshot.capabilities,
    };
  }

  async query(queryInput: unknown): Promise<OperonTaskPage> {
    const query = OperonQuerySchema.parse(queryInput);
    const snapshot = await this.ensureSnapshot(query.forceRefresh);
    return queryOperonSnapshot(snapshot, query);
  }

  async createTask(input: unknown): Promise<OperonMutationResult> {
    const params: OperonCreateTask = OperonCreateTaskSchema.parse(input);
    return this.executeMutation(
      "create",
      null,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks`,
      params,
    );
  }

  async updateTask(input: unknown): Promise<OperonMutationResult> {
    const params: OperonUpdateTask = OperonUpdateTaskSchema.parse(input);
    return this.executeMutation(
      "update",
      params.operonId,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(params.operonId)}/update`,
      params,
    );
  }

  async transitionTask(input: unknown): Promise<OperonMutationResult> {
    const params: OperonTransitionTask = OperonTransitionTaskSchema.parse(input);
    return this.executeMutation(
      "transition",
      params.operonId,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(params.operonId)}/transition`,
      params,
    );
  }

  async convertTask(input: unknown): Promise<OperonMutationResult> {
    const params: OperonConvertTask = OperonConvertTaskSchema.parse(input);
    return this.executeMutation(
      "convert",
      params.operonId,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(params.operonId)}/convert`,
      params,
    );
  }

  async getTask(options: {
    operonId: string;
    includeProperties?: boolean;
    forceRefresh?: boolean;
  }): Promise<Record<string, unknown>> {
    const result = await this.query({
      operonIds: [options.operonId],
      includeProperties: options.includeProperties ?? false,
      forceRefresh: options.forceRefresh ?? false,
      limit: 1,
    });
    if (result.tasks.length === 0) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        `Operon task not found: ${options.operonId}`,
        this.requestContext("getOperonTask", { operonId: options.operonId }),
      );
    }
    return {
      source: result.source,
      stale: result.stale,
      snapshotAt: result.snapshotAt,
      snapshotAgeMs: result.snapshotAgeMs,
      operonVersion: result.operonVersion,
      bridgeVersion: result.bridgeVersion,
      contractVersion: result.contractVersion,
      capabilities: result.capabilities,
      limitations: result.limitations,
      task: result.tasks[0],
    };
  }

  async validate(forceRefresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.ensureSnapshot(forceRefresh);
    if (snapshot.source === "operon-live") {
      try {
        const live = await this.fetchLiveValidation();
        return {
          ...live,
          snapshotAt: snapshot.snapshotAt,
          snapshotAgeMs: snapshot.snapshotAgeMs,
          operonVersion: snapshot.operonVersion,
          bridgeVersion: snapshot.bridgeVersion,
          capabilities: snapshot.capabilities,
        };
      } catch (error) {
        logger.warning("Live Operon validation failed; using snapshot validation.", {
          ...this.requestContext("validateOperonSnapshot"),
          error: errorMessage(error),
        });
      }
    }
    return this.validateSnapshot(snapshot);
  }

  private validateSnapshot(snapshot: OperonSnapshotEnvelope): Record<string, unknown> {
    const ids = new Set(snapshot.tasks.map((task) => task.operonId));
    const violations: Array<Record<string, unknown>> = [];
    for (const task of snapshot.tasks) {
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
    const count = (severity: string): number =>
      violations.filter((violation) => violation.severity === severity).length;
    return {
      ok: count("P0") === 0,
      contractVersion: snapshot.contractVersion,
      source: snapshot.source,
      stale: snapshot.stale,
      snapshotAt: snapshot.snapshotAt,
      snapshotAgeMs: snapshot.snapshotAgeMs,
      taskCount: snapshot.tasks.length,
      operonVersion: snapshot.operonVersion,
      bridgeVersion: snapshot.bridgeVersion,
      capabilities: snapshot.capabilities,
      summary: { P0: count("P0"), P1: count("P1"), P2: count("P2") },
      violations,
      limitations: [
        ...snapshot.limitations,
        "Snapshot validation cannot prove that source files still exist or that the live Operon duplicate registry is clear.",
      ],
    };
  }
}
