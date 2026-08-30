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
  OPERON_LEGACY_SNAPSHOT_SCHEMA_VERSION,
  OPERON_SNAPSHOT_SCHEMA_VERSION,
  OperonBridgePageSchema,
  OperonConfigurationSchema,
  OperonQuerySchema,
  OperonStatusSchema,
  OperonRecoveryStatusSchema,
  OperonTaskSchema,
  OperonValidationSchema,
  queryOperonSnapshot,
  OperonCapabilitiesSchema,
  OperonAdoptTaskSchema,
  OperonCreatePeriodicTaskSchema,
  OperonUpdatePeriodicSchedulingSchema,
  OperonConvertTaskSchema,
  OperonCreateTaskSchema,
  OperonFilterQuerySchema,
  OperonTaskFinderSchema,
  OperonResolveTaskSchema,
  OperonRelationshipsSchema,
  OperonContextSchema,
  OperonNativeReadEnvelopeSchema,
  OperonRelocateTaskSchema,
  OperonRecoverMutationSchema,
  OperonPendingRecoveriesSchema,
  OperonPendingRecoveriesInputSchema,
  OperonMutationResultSchema,
  OperonTransitionTaskSchema,
  OperonUpdateTaskSchema,
  OperonSetRelationshipsSchema,
  OperonUpdateRecurrenceSchema,
  isCanonicalOperonVaultRelativePath,
  resolveOperonPriorityStableId,
  resolveOperonWorkflowStatus,
  type OperonBridgePage,
  type OperonConfiguration,
  type OperonQuery,
  type OperonSnapshotEnvelope,
  type OperonStatus,
  type OperonRecoveryStatus,
  type OperonTask,
  type OperonTaskPage,
  type OperonValidation,
  type OperonAdoptTask,
  type OperonCreatePeriodicTask,
  type OperonUpdatePeriodicScheduling,
  type OperonSetRelationships,
  type OperonUpdateRecurrence,
  type OperonConvertTask,
  type OperonCreateTask,
  type OperonFilterQuery,
  type OperonTaskFinder,
  type OperonResolveTask,
  type OperonRelationships,
  type OperonContext,
  type OperonRelocateTask,
  type OperonPendingRecoveriesInput,
  type OperonRecoverMutation,
  type OperonMutationResult,
  type OperonTransitionTask,
  type OperonUpdateTask,
} from "./contract.js";
import type { z } from "zod";

const BRIDGE_PREFIX = "/extensions/optimike-operon-bridge/v1";
const PAGE_SIZE = 500;
const MAX_PAGES = 10_000;
const PRE_DISPATCH_MUTATION_CODES = new Set([
  "task_workflow_capability_unavailable",
  "operon_index_not_settled",
  "operon_mutation_capability_unavailable",
  "mutation_unavailable",
  "recovery_unavailable",
  "task_workflow_recovery_unavailable",
]);
const canonicalVaultRelativePathOrNull = (value: string): string | null => {
  return isCanonicalOperonVaultRelativePath(value) ? value : null;
};
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
  snapshotSchemaVersion: number;
  snapshotAt: number;
  generation: number | null;
  settingsSignature: string | null;
  operonVersion: string;
  bridgeVersion: string;
  contractVersion: string;
  status: OperonStatus | null;
  validation: OperonValidation | null;
  configuration: OperonConfiguration | null;
}

type OperonCapabilities = z.infer<typeof OperonCapabilitiesSchema>;
type OperonMutationAction =
  | "adopt"
  | "periodic-create"
  | "periodic-update"
  | "create"
  | "update"
  | "transition"
  | "relationships"
  | "recurrence"
  | "convert"
  | "relocate";

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
    configuration: true,
    list: true,
    get: true,
    query: true,
    validate: true,
    diagnostics: false,
    finder: false,
    resolve: false,
    relationships: false,
    context: false,
    timers: false,
    adopt: false,
    create: false,
    update: false,
    transition: false,
    relationshipMutation: false,
    recurrenceMutation: false,
    convert: false,
    filterQuery: false,
    relocate: false,
    recovery: false,
    periodicCreate: false,
    periodicUpdate: false,
    taskWorkflowRecovery: false,
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

function matchesMutationJournalOperonId(
  action: string,
  requestedOperonId: string | null,
  persistedOperonId: string | null,
): boolean {
  if (persistedOperonId === requestedOperonId) return true;
  // Older create/adopt journals replaced the null request target with the
  // resulting task id at completion. Keep those terminal replays compatible:
  // these actions have no caller-selected task identity to confuse with a
  // different task mutation.
  return (
    requestedOperonId === null &&
    persistedOperonId !== null &&
    (action === "create" || action === "adopt" || action === "periodic-create")
  );
}

export class OperonService {
  private readonly dbPath = config.obsidianSharedCacheDbPath;
  private client: AxiosInstance | null = null;
  private readonly mutationInFlight = new Map<
    string,
    {
      signature: string;
      promise: Promise<OperonMutationResult>;
    }
  >();

  private requestContext(
    operation: string,
    extra: Record<string, unknown> = {},
  ) {
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
      // Operon 3.1.1 can settle a semantic transition/project-serial graph
      // after roughly 80 seconds. Keep the MCP client alive longer than the
      // Bridge's bounded Developer API apply budget.
      timeout: 180_000,
      httpsAgent: new https.Agent({
        rejectUnauthorized: config.obsidianVerifySsl,
      }),
    });
    return this.client;
  }

  private bridgeHttpError(error: unknown, operation: string): never {
    if (!axios.isAxiosError(error) || !error.response) throw error;
    const status = error.response.status;
    const payload =
      error.response.data && typeof error.response.data === "object"
        ? (error.response.data as Record<string, unknown>)
        : null;
    const nativeError =
      payload?.error && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : null;
    const descriptor =
      status === 400 || status === 422
        ? {
            code: BaseErrorCode.VALIDATION_ERROR,
            reasonCode: "OPERON_BRIDGE_REQUEST_INVALID",
            message: "The Operon Bridge rejected the request.",
          }
        : status === 401
          ? {
              code: BaseErrorCode.UNAUTHORIZED,
              reasonCode: "OPERON_BRIDGE_UNAUTHORIZED",
              message: "Authentication with the Operon Bridge failed.",
            }
          : status === 403
            ? {
                code: BaseErrorCode.FORBIDDEN,
                reasonCode: "OPERON_BRIDGE_FORBIDDEN",
                message: "The Operon Bridge denied the requested capability.",
              }
            : status === 404
              ? {
                  code: BaseErrorCode.NOT_FOUND,
                  reasonCode: "OPERON_BRIDGE_RESOURCE_NOT_FOUND",
                  message:
                    "The requested Operon Bridge resource was not found.",
                }
              : status === 409
                ? {
                    code: BaseErrorCode.CONFLICT,
                    reasonCode: "OPERON_BRIDGE_CONFLICT",
                    message: "The Operon Bridge reported a state conflict.",
                  }
                : status === 429
                  ? {
                      code: BaseErrorCode.RATE_LIMITED,
                      reasonCode: "OPERON_BRIDGE_RATE_LIMITED",
                      message: "The Operon Bridge rate limited the request.",
                    }
                  : status >= 500
                    ? {
                        code: BaseErrorCode.SERVICE_UNAVAILABLE,
                        reasonCode: "OPERON_BRIDGE_UNAVAILABLE",
                        message:
                          "The Operon Bridge is temporarily unavailable.",
                      }
                    : {
                        code: BaseErrorCode.INTERNAL_ERROR,
                        reasonCode: "OPERON_BRIDGE_REQUEST_FAILED",
                        message:
                          "The Operon Bridge request could not be completed.",
                      };
    throw new McpError(
      descriptor.code,
      descriptor.message,
      this.requestContext(operation, {
        httpStatus: status,
        reasonCode: descriptor.reasonCode,
        hasBridgeCode: typeof nativeError?.code === "string",
      }),
    );
  }

  private openDb(): DatabaseSync {
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec(SNAPSHOT_TABLE_SQL);
    return db;
  }

  private readMutationJournal(
    idempotencyKey: string,
  ): MutationJournalEntry | null {
    const db = this.openDb();
    try {
      const row = db
        .prepare(
          `SELECT action, operon_id as operonId, requested_json as requestedJson,
                result_json as resultJson
         FROM operon_mutation_journal WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as
        | {
            action?: string;
            operonId?: string | null;
            requestedJson?: string;
            resultJson?: string;
          }
        | undefined;
      if (!row?.resultJson) return null;
      const parsed = OperonMutationResultSchema.safeParse(
        JSON.parse(row.resultJson),
      );
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

  private reserveMutationJournal(
    action: string,
    operonId: string | null,
    idempotencyKey: string,
    requested: unknown,
  ): MutationJournalEntry | null {
    const requestedJson = stableJson(requested);
    const now = Date.now();
    const db = this.openDb();
    try {
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO operon_mutation_journal (
          operation_id, idempotency_key, operon_id, action, requested_json,
          result_json, status, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `pending:${idempotencyKey}`,
          idempotencyKey,
          operonId,
          action,
          requestedJson,
          "null",
          "in_progress",
          now,
          now,
        ) as { changes: number | bigint };
      if (Number(inserted.changes) === 1) return null;

      const row = db
        .prepare(
          `SELECT action, operon_id as operonId, requested_json as requestedJson,
                result_json as resultJson, status
         FROM operon_mutation_journal WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as
        | {
            action?: string;
            operonId?: string | null;
            requestedJson?: string;
            resultJson?: string;
            status?: string;
          }
        | undefined;
      if (
        !row ||
        row.action !== action ||
        !matchesMutationJournalOperonId(
          action,
          operonId,
          row.operonId ?? null,
        ) ||
        row.requestedJson !== requestedJson
      ) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Idempotency key was already reserved for a different Operon mutation request.",
          this.requestContext(`operon_${action}`, { operonId, idempotencyKey }),
        );
      }
      const parsedResult = safeJsonParse(row.resultJson);
      const parsed = OperonMutationResultSchema.safeParse(parsedResult);
      if (row.status !== "in_progress" && parsed.success) {
        return {
          action,
          operonId: row.operonId ?? null,
          requestedJson,
          result: { ...parsed.data, replayed: true },
        };
      }
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "A previous Operon mutation attempt with this idempotency key has an uncertain outcome; inspect the live task before choosing a new key.",
        this.requestContext(`operon_${action}`, { operonId, idempotencyKey }),
      );
    } finally {
      db.close();
    }
  }

  private releasePreDispatchMutationReservation(
    action: string,
    operonId: string | null,
    idempotencyKey: string,
    requested: unknown,
  ): boolean {
    const db = this.openDb();
    try {
      const deleted = db
        .prepare(
          `DELETE FROM operon_mutation_journal
           WHERE idempotency_key = ? AND operon_id IS ?
             AND action = ? AND requested_json = ?
             AND operation_id = ? AND status = 'in_progress'
             AND result_json = 'null'`,
        )
        .run(
          idempotencyKey,
          operonId,
          action,
          stableJson(requested),
          `pending:${idempotencyKey}`,
        ) as { changes: number | bigint };
      return Number(deleted.changes) === 1;
    } finally {
      db.close();
    }
  }

  /**
   * The sole proof that an HTTP 503 happened before native dispatch. Keep this
   * stricter than the general mutation-result schema: a stale/misrouted 503
   * must never delete an MCP in-progress journal row.
   */
  private preDispatchReasonFromReceipt(
    receipt: unknown,
    idempotencyKey: string,
  ): string | null {
    const parsed = OperonMutationResultSchema.safeParse(receipt);
    if (!parsed.success || parsed.data.ok !== false) return null;
    const result = parsed.data;
    if (
      result.status !== "not-ready" ||
      result.idempotencyKey !== idempotencyKey ||
      result.retryable !== true ||
      result.mutationMayHaveApplied !== false ||
      !PRE_DISPATCH_MUTATION_CODES.has(result.error.code) ||
      result.recoveryRef !== undefined ||
      result.recoveryRequired !== undefined ||
      result.planDigest !== undefined
    ) {
      return null;
    }
    return result.error.code;
  }

  private claimsPreDispatch(receipt: unknown): boolean {
    return Boolean(
      receipt &&
        typeof receipt === "object" &&
        !Array.isArray(receipt) &&
        (receipt as Record<string, unknown>).mutationMayHaveApplied === false,
    );
  }

  private preDispatchUnavailableMessage(reason: string): string {
    return reason === "task_workflow_capability_unavailable"
      ? "The exact Operon task-workflow grant is pending; retry the same idempotency key."
      : reason === "operon_index_not_settled"
        ? "The Operon live index is not settled yet; retry the same idempotency key."
        : reason === "operon_mutation_capability_unavailable"
          ? "The required Operon mutation capability is unavailable; retry the same idempotency key."
          : "The Operon mutation was unavailable before native dispatch; retry the same idempotency key.";
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
      const updated = db
        .prepare(
          `UPDATE operon_mutation_journal
         SET operation_id = ?, result_json = ?, status = ?, completed_at = ?
         WHERE idempotency_key = ? AND operon_id IS ?
           AND action = ? AND requested_json = ?
           AND operation_id = ? AND status = 'in_progress'
           AND result_json = 'null'`,
        )
        .run(
          result.operationId,
          JSON.stringify(result),
          result.status,
          now,
          result.idempotencyKey,
          operonId,
          action,
          stableJson(requested),
          `pending:${result.idempotencyKey}`,
        ) as { changes: number | bigint };
      if (Number(updated.changes) !== 1) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Operon mutation journal reservation was lost before completion.",
          this.requestContext(`operon_${action}`, {
            operonId,
            idempotencyKey: result.idempotencyKey,
          }),
        );
      }
    } finally {
      db.close();
    }
  }

  private async executeMutation(
    action: OperonMutationAction,
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
      if (
        existing.action !== action ||
        !matchesMutationJournalOperonId(action, operonId, existing.operonId) ||
        existing.requestedJson !== requestedJson
      ) {
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
    const promise = this.performMutation(
      action,
      operonId,
      idempotencyKey,
      dryRun,
      path,
      payload,
    );
    this.mutationInFlight.set(idempotencyKey, { signature, promise });
    try {
      return await promise;
    } finally {
      if (this.mutationInFlight.get(idempotencyKey)?.promise === promise) {
        this.mutationInFlight.delete(idempotencyKey);
      }
    }
  }

  private mutationOutcomeMismatch(
    action: OperonMutationAction,
    payload: Record<string, unknown>,
    after: OperonTask,
    priorities: OperonConfiguration["configuration"]["priorities"]["items"],
    workflow: OperonConfiguration["configuration"]["workflow"],
  ): string | null {
    const requested =
      action === "adopt"
        ? payload.adoption
        : action === "periodic-create"
          ? payload.periodic
          : action === "periodic-update"
            ? payload.patch
            : action === "create"
              ? payload.task
              : action === "update"
                ? payload.patch
                : payload;
    const request =
      requested && typeof requested === "object" && !Array.isArray(requested)
        ? (requested as Record<string, unknown>)
        : {};
    if (action === "adopt") {
      if (
        typeof request.targetPath !== "string" ||
        after.path !== request.targetPath
      )
        return "Adopted task path does not match targetPath.";
      if (typeof request.line !== "number" || after.line !== request.line)
        return "Adopted task line does not match the requested line.";
    }
    if (action === "create" || action === "periodic-create") {
      if (
        typeof request.description === "string" &&
        after.description !== request.description.trim()
      )
        return "Created task description does not match the request.";
      if (
        action === "create" &&
        (request.source === "inline" || request.source === "file") &&
        after.source !== request.source
      )
        return "Created task source does not match the request.";
    }
    if (
      action === "update" ||
      action === "create" ||
      action === "periodic-create"
    ) {
      if (
        typeof request.description === "string" &&
        after.description !== request.description.trim()
      )
        return "Task description does not match the request.";
      if (Array.isArray(request.tags)) {
        const expectedTags = request.tags
          .map(String)
          .map((tag) => tag.replace(/^#/u, "").trim())
          .filter(Boolean)
          .sort();
        if (stableJson([...after.tags].sort()) !== stableJson(expectedTags))
          return "Task tags do not match the request.";
      }
      const fields =
        request.fields &&
        typeof request.fields === "object" &&
        !Array.isArray(request.fields)
          ? (request.fields as Record<string, unknown>)
          : {};
      for (const [key, value] of Object.entries(fields)) {
        if (key === "status") continue;
        if (Array.isArray(value)) {
          if (
            !Array.isArray(after.fields[key]) ||
            stableJson(after.fields[key]) !== stableJson(value)
          ) {
            return `Managed list field '${key}' does not match the request in value or order.`;
          }
          continue;
        }
        const expectedValue =
          key === "priority"
            ? (resolveOperonPriorityStableId(value, priorities) ??
              String(value).trim())
            : String(value);
        if (after.fields[key] !== expectedValue)
          return `Managed field '${key}' does not match the request.`;
      }
      const properties =
        request.properties &&
        typeof request.properties === "object" &&
        !Array.isArray(request.properties)
          ? (request.properties as Record<string, unknown>)
          : {};
      for (const [key, value] of Object.entries(properties)) {
        if (stableJson(after.properties?.[key]) !== stableJson(value))
          return `Unmanaged property '${key}' does not match the request.`;
      }
    }
    if (
      action === "transition" ||
      action === "create" ||
      action === "periodic-create"
    ) {
      if (typeof request.status === "string") {
        const requestedStatus = resolveOperonWorkflowStatus(
          request.status,
          workflow,
        );
        const statusMatches = requestedStatus
          ? after.status === requestedStatus.value ||
            after.status ===
              `${requestedStatus.pipeline}.${requestedStatus.label}` ||
            after.statusId === requestedStatus.id ||
            after.statusLabel === requestedStatus.label
          : after.status === request.status.trim();
        if (!statusMatches) return "Task status does not match the request.";
      }
      if (
        typeof request.statusId === "string" &&
        after.statusId !== request.statusId.trim()
      )
        return "Task status id does not match the request.";
    }
    if (action === "periodic-update") {
      const requestedFields =
        request.fields &&
        typeof request.fields === "object" &&
        !Array.isArray(request.fields)
          ? (request.fields as Record<string, unknown>)
          : {};
      const scheduled = requestedFields.dateScheduled;
      if (
        (scheduled === null || typeof scheduled === "string") &&
        after.dates.scheduled !== scheduled
      ) {
        return "Periodic task scheduled date does not match the request.";
      }
    }
    if (action === "relationships") {
      const relationships = payload.relationships;
      const expected =
        relationships &&
        typeof relationships === "object" &&
        !Array.isArray(relationships)
          ? (relationships as Record<string, unknown>)
          : {};
      if (Object.prototype.hasOwnProperty.call(expected, "parentTask")) {
        const expectedParent =
          expected.parentTask === null
            ? null
            : String(expected.parentTask).trim();
        if (after.parentTask !== expectedParent)
          return "Task parent relationship does not match the request.";
      }
      for (const field of ["blocking", "blockedBy"] as const) {
        if (!Object.prototype.hasOwnProperty.call(expected, field)) continue;
        const targets = Array.isArray(expected[field])
          ? expected[field].map(String).sort()
          : [];
        if (stableJson([...after[field]].sort()) !== stableJson(targets)) {
          return `Task ${field} relationships do not match the request.`;
        }
      }
    }
    if (action === "recurrence") {
      const changes = payload.changes;
      const requestedChanges =
        changes && typeof changes === "object" && !Array.isArray(changes)
          ? (changes as Record<string, unknown>)
          : {};
      for (const [field, value] of Object.entries(requestedChanges)) {
        if (field === "repeat" || field === "datetimeRepeatEnd") continue;
        if (value === null) {
          if (after.fields[field] !== undefined && after.fields[field] !== "")
            return `Recurrence field '${field}' was not cleared.`;
        } else if (after.fields[field] !== String(value)) {
          return `Recurrence field '${field}' does not match the request.`;
        }
      }
      if (Object.prototype.hasOwnProperty.call(requestedChanges, "repeat")) {
        const repeat = requestedChanges.repeat;
        if (
          repeat === null &&
          (after.recurrence?.repeating === true ||
            after.recurrence?.seriesId != null ||
            after.recurrence?.occurrenceDate != null)
        ) {
          return "The official recurrence state was not cleared.";
        }
        if (
          typeof repeat === "string" &&
          (!after.recurrence?.repeating ||
            !/^rs[a-z0-9]{5}$/u.test(after.recurrence.seriesId ?? ""))
        ) {
          return "The official recurrence state is not active.";
        }
      }
    }
    if (action === "convert") {
      if (
        (request.target === "inline" || request.target === "file") &&
        after.source !== request.target
      )
        return "Converted task source does not match the request.";
      if (
        request.target === "inline" &&
        typeof request.targetPath === "string" &&
        after.path !== request.targetPath
      )
        return "Converted task path does not match targetPath.";
    }
    if (
      action === "relocate" &&
      (after.source !== "inline" ||
        typeof request.targetPath !== "string" ||
        after.path !== request.targetPath)
    ) {
      return "Relocated task was not found at targetPath.";
    }
    return null;
  }

  private async performMutation(
    action: OperonMutationAction,
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
    if (!dryRun && !config.operonMutationsEnabled) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Operon apply is disabled. Set OPERON_MUTATIONS_ENABLED=true after validating the live Bridge.",
        this.requestContext(`operon_${action}`, { operonId }),
      );
    }
    const status = await this.fetchLiveStatus();
    const capability =
      action === "relationships"
        ? "relationshipMutation"
        : action === "recurrence"
          ? "recurrenceMutation"
          : action === "periodic-create"
            ? "periodicCreate"
            : action === "periodic-update"
              ? "periodicUpdate"
              : action;
    const taskWorkflowAction =
      action === "adopt" ||
      action === "periodic-create" ||
      action === "periodic-update";
    if (
      !status.capabilities[capability] &&
      (!taskWorkflowAction || status.bridge.mutationsEnabled !== true)
    ) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon Bridge capability is unavailable: ${action}.`,
        this.requestContext(`operon_${action}`, {
          operonId,
          capabilities: status.capabilities,
        }),
      );
    }
    await this.assertMutationPathScope(action, operonId, payload, dryRun);
    const operation =
      action === "relationships"
        ? "operon_set_relationships"
        : action === "recurrence"
          ? "operon_update_recurrence"
          : action === "periodic-create"
            ? "operon_create_periodic_task"
            : action === "periodic-update"
              ? "operon_update_periodic_scheduling"
              : (`operon_${action}_task` as const);
    const mutationData =
      action === "create"
        ? payload.task
        : action === "periodic-create"
          ? payload.periodic
          : action === "periodic-update"
            ? payload.patch
            : action === "update"
              ? payload.patch
              : null;
    const mutationRecord =
      mutationData &&
      typeof mutationData === "object" &&
      !Array.isArray(mutationData)
        ? (mutationData as Record<string, unknown>)
        : {};
    const frontmatterKeys = [
      ...Object.keys(
        mutationRecord.fields && typeof mutationRecord.fields === "object"
          ? mutationRecord.fields
          : {},
      ),
      ...Object.keys(
        mutationRecord.properties &&
          typeof mutationRecord.properties === "object"
          ? mutationRecord.properties
          : {},
      ),
    ];
    assertWriteAllowed({
      operation,
      action: dryRun ? "dry_run" : "apply",
      target: operonId ?? "new-task",
      destructive: (action === "convert" || action === "recurrence") && !dryRun,
      allowInReadonly: dryRun,
      allowInGuarded:
        dryRun ||
        (action !== "recurrence" &&
          (action !== "periodic-create" ||
            config.operonMutationAllowedPathPrefixes.length === 0) &&
          (action !== "convert" ||
            config.operonMutationAllowedPathPrefixes.length > 0)),
      frontmatterKeys,
      context: this.requestContext(operation, { operonId, idempotencyKey }),
    });
    const reservedResult = this.reserveMutationJournal(
      action,
      operonId,
      idempotencyKey,
      payload,
    );
    if (reservedResult) return reservedResult.result;
    const response = await this.getClient().post(path, payload, {
      validateStatus: () => true,
    });
    const preDispatchReason =
      response.status === 503
        ? this.preDispatchReasonFromReceipt(response.data, idempotencyKey)
        : null;
    if (preDispatchReason) {
      const released = this.releasePreDispatchMutationReservation(
        action,
        operonId,
        idempotencyKey,
        payload,
      );
      if (!released) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "The pre-dispatch Operon reservation could not be released safely; inspect the journal before retrying.",
          this.requestContext(operation, { operonId, idempotencyKey }),
        );
      }
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        this.preDispatchUnavailableMessage(preDispatchReason),
        this.requestContext(operation, {
          operonId,
          idempotencyKey,
          responseStatus: response.status,
          preDispatch: true,
          preDispatchReason,
          hasBridgeCode: true,
          mutationMayHaveApplied: false,
        }),
      );
    }
    if (response.status === 503 && this.claimsPreDispatch(response.data)) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Invalid pre-dispatch Operon mutation receipt.",
        this.requestContext(operation, {
          operonId,
          responseStatus: response.status,
          responseShapeValid: false,
          preDispatchClaimed: true,
        }),
      );
    }
    const parsed = OperonMutationResultSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        `Invalid Operon mutation response (${response.status}).`,
        this.requestContext(operation, {
          operonId,
          responseStatus: response.status,
          responseShapeValid: false,
          issueCount: parsed.error.issues.length,
        }),
      );
    }
    const result = parsed.data;
    if (result.idempotencyKey !== idempotencyKey) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge mutation receipt did not match the requested idempotency key.",
        this.requestContext(operation, {
          operonId,
          responseStatus: response.status,
          responseShapeValid: true,
          correlationMatched: false,
        }),
      );
    }
    if (result.status === "applied") {
      if (!result.after) {
        throw new McpError(
          BaseErrorCode.PARSING_ERROR,
          "Operon Bridge reported an applied mutation without a final indexed task.",
          this.requestContext(operation, {
            operonId,
            operationId: result.operationId,
          }),
        );
      }
      if (operonId !== null && result.after.operonId !== operonId) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Operon mutation outcome could not be proven: Final task identity does not match the request.",
          this.requestContext(operation, {
            operonId,
            operationId: result.operationId,
          }),
        );
      }
      const configuration = await this.fetchLiveConfiguration();
      const mismatch = this.mutationOutcomeMismatch(
        action,
        payload,
        result.after,
        configuration.configuration.priorities.items,
        configuration.configuration.workflow,
      );
      if (mismatch) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          `Operon mutation outcome could not be proven: ${mismatch}`,
          this.requestContext(operation, {
            operonId,
            operationId: result.operationId,
          }),
        );
      }
      this.assertAllowedMutationPath(result.after.path, `${action} result`);
    }
    this.writeMutationJournal(action, operonId, payload, result);
    if (result.status === "applied") {
      try {
        await this.ensureSnapshot(true);
      } catch (error) {
        logger.warning(
          "Operon mutation succeeded but snapshot refresh failed.",
          {
            ...this.requestContext(operation, {
              operonId,
              operationId: result.operationId,
            }),
            error: errorMessage(error),
          },
        );
      }
    }
    return result;
  }

  private isAllowedMutationPath(candidate: string): boolean {
    const normalized = canonicalVaultRelativePathOrNull(candidate);
    if (!normalized) return false;
    return config.operonMutationAllowedPathPrefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
  }

  private assertAllowedMutationPath(candidate: string, label: string): void {
    if (!canonicalVaultRelativePathOrNull(candidate)) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Operon ${label} must be a canonical vault-relative path without '.' or '..': ${candidate}`,
        this.requestContext("assertOperonMutationPathScope", { candidate }),
      );
    }
    if (config.operonMutationAllowedPathPrefixes.length === 0) return;
    if (!this.isAllowedMutationPath(candidate)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Operon ${label} is outside OPERON_MUTATION_ALLOWED_PATH_PREFIXES: ${candidate}`,
        this.requestContext("assertOperonMutationPathScope", {
          candidate,
          allowedPathPrefixes: config.operonMutationAllowedPathPrefixes,
        }),
      );
    }
  }

  private assertRecoveryPathScope(operation: string): void {
    if (config.operonMutationAllowedPathPrefixes.length === 0) return;
    throw new McpError(
      BaseErrorCode.FORBIDDEN,
      "Operon recovery is blocked while OPERON_MUTATION_ALLOWED_PATH_PREFIXES is configured because pending recovery records do not expose canonical route evidence. Recovery therefore fails closed before listing, replay, or Bridge apply.",
      this.requestContext(operation, {
        allowedPathPrefixes: config.operonMutationAllowedPathPrefixes,
        routeEvidence: "unavailable",
      }),
    );
  }

  private async isConfiguredFileTaskFolderAllowed(): Promise<boolean> {
    try {
      const configuration = await this.fetchLiveConfiguration();
      const folder =
        configuration.configuration.creation.fileTasksFolder.trim();
      return folder.length > 0 && this.isAllowedMutationPath(folder);
    } catch {
      return false;
    }
  }

  private async assertMutationPathScope(
    action: OperonMutationAction,
    operonId: string | null,
    payload: Record<string, unknown>,
    dryRun: boolean,
  ): Promise<void> {
    // Daily/Weekly routing is sealed by Operon and the opaque preview does not
    // provide route evidence MCP can check against configured path prefixes.
    // Preview remains safe, but apply must fail closed before the Bridge POST.
    if (action === "periodic-create") {
      if (dryRun || config.operonMutationAllowedPathPrefixes.length === 0) {
        return;
      }
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Scoped periodic creation requires verifiable route evidence, which the Operon preview does not expose. Clear OPERON_MUTATION_ALLOWED_PATH_PREFIXES or keep this request in dry-run mode.",
        this.requestContext("assertOperonMutationPathScope", {
          action,
          allowedPathPrefixes: config.operonMutationAllowedPathPrefixes,
        }),
      );
    }
    if (config.operonMutationAllowedPathPrefixes.length === 0) return;

    if (action === "adopt") {
      const adoption = payload.adoption as Record<string, unknown> | undefined;
      if (
        typeof adoption?.targetPath === "string" &&
        adoption.targetPath.length > 0
      ) {
        this.assertAllowedMutationPath(adoption.targetPath, "adopt targetPath");
        return;
      }
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Scoped Operon adoption requires an explicit targetPath.",
        this.requestContext("assertOperonMutationPathScope", { action }),
      );
    }

    if (action === "create") {
      const task = payload.task as Record<string, unknown> | undefined;
      if (
        task?.source === "file" &&
        typeof task.targetFolder === "string" &&
        task.targetFolder.length > 0
      ) {
        this.assertAllowedMutationPath(
          task.targetFolder,
          "create targetFolder",
        );
        return;
      }
      if (
        task?.source === "inline" &&
        typeof task.targetPath === "string" &&
        task.targetPath.length > 0
      ) {
        this.assertAllowedMutationPath(task.targetPath, "create targetPath");
        return;
      }
      if (
        task?.source === "file" &&
        (await this.isConfiguredFileTaskFolderAllowed())
      ) {
        return;
      }
      {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          "Scoped Operon mutations require an explicit targetFolder for file tasks or targetPath for inline tasks.",
          this.requestContext("assertOperonMutationPathScope", { action }),
        );
      }
    }

    if (!operonId) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Operon ${action} requires an operonId.`,
        this.requestContext("assertOperonMutationPathScope", { action }),
      );
    }
    const response = await this.getClient().get(
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(operonId)}?includeProperties=false`,
    );
    const task = OperonTaskSchema.parse(
      (response.data as { task?: unknown }).task,
    );
    this.assertAllowedMutationPath(task.path, `${action} source`);

    if (action === "convert") {
      const target = payload.target;
      if (
        target === "file" &&
        typeof payload.targetFolder === "string" &&
        payload.targetFolder.length > 0
      ) {
        this.assertAllowedMutationPath(
          payload.targetFolder,
          "convert targetFolder",
        );
        return;
      }
      if (
        target === "file" &&
        (await this.isConfiguredFileTaskFolderAllowed())
      ) {
        return;
      }
      if (
        target === "inline" &&
        typeof payload.targetPath === "string" &&
        payload.targetPath.length > 0
      ) {
        this.assertAllowedMutationPath(
          payload.targetPath,
          "convert targetPath",
        );
        return;
      }
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Scoped Operon conversion requires targetFolder for inline-to-file or targetPath for file-to-inline.",
        this.requestContext("assertOperonMutationPathScope", {
          action,
          operonId,
          target,
        }),
      );
    }

    if (action === "relocate") {
      if (
        typeof payload.targetPath === "string" &&
        payload.targetPath.length > 0
      ) {
        this.assertAllowedMutationPath(
          payload.targetPath,
          "relocate targetPath",
        );
        return;
      }
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Scoped Operon relocation requires targetPath.",
        this.requestContext("assertOperonMutationPathScope", {
          action,
          operonId,
        }),
      );
    }
  }

  private readMeta(db: DatabaseSync): SnapshotMeta | null {
    const rows = db
      .prepare("SELECT key, value FROM operon_snapshot_meta")
      .all() as unknown as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const snapshotAt = Number(values.get("snapshot_at"));
    if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) return null;
    const snapshotSchemaVersion = Number(
      values.get("snapshot_schema_version") ??
        OPERON_LEGACY_SNAPSHOT_SCHEMA_VERSION,
    );
    const generationRaw = values.get("generation");
    const generation =
      generationRaw === undefined || generationRaw === "null"
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
    const parsedConfiguration = safeJsonParse(values.get("configuration_json"));
    const configurationResult = parsedConfiguration
      ? OperonConfigurationSchema.safeParse(parsedConfiguration)
      : { success: false as const };
    return {
      snapshotSchemaVersion,
      snapshotAt,
      generation: Number.isFinite(generation) ? generation : null,
      settingsSignature: values.get("settings_signature") ?? null,
      operonVersion: values.get("operon_version") ?? "unknown",
      bridgeVersion: values.get("bridge_version") ?? "unknown",
      contractVersion: values.get("contract_version") ?? "unknown",
      status: statusResult.success ? statusResult.data : null,
      validation: validationResult.success ? validationResult.data : null,
      configuration: configurationResult.success
        ? configurationResult.data
        : null,
    };
  }

  private loadSnapshot(
    source: "operon-live" | "operon-cache",
  ): OperonSnapshotEnvelope | null {
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
      if (
        meta.snapshotSchemaVersion !== OPERON_LEGACY_SNAPSHOT_SCHEMA_VERSION &&
        meta.snapshotSchemaVersion !== OPERON_SNAPSHOT_SCHEMA_VERSION
      ) {
        throw new McpError(
          BaseErrorCode.PARSING_ERROR,
          `Operon snapshot schema ${meta.snapshotSchemaVersion} is incompatible with supported schemas ${OPERON_LEGACY_SNAPSHOT_SCHEMA_VERSION} and ${OPERON_SNAPSHOT_SCHEMA_VERSION}.`,
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
              issueCount: parsed.error.issues.length,
            }),
          );
        }
        if (seen.has(parsed.data.operonId)) {
          throw new McpError(
            BaseErrorCode.CONFLICT,
            `Duplicate operonId in MCP snapshot: ${parsed.data.operonId}.`,
            this.requestContext("loadOperonSnapshot", {
              operonId: parsed.data.operonId,
            }),
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
        snapshotSchemaVersion: meta.snapshotSchemaVersion as 1 | 2,
        settingsSignature: meta.settingsSignature,
        generation: meta.generation,
        capabilities: stale
          ? readOnlyCapabilities()
          : (meta.status?.capabilities ?? readOnlyCapabilities()),
        limitations: stale
          ? [
              ...new Set([
                ...(meta.status?.limitations ?? []),
                ...(meta.snapshotSchemaVersion ===
                OPERON_LEGACY_SNAPSHOT_SCHEMA_VERSION
                  ? [
                      "Legacy Operon snapshot schema v1 was read through the safe v2 compatibility path; list-valued fields may remain flattened strings until a live refresh replaces the snapshot.",
                    ]
                  : []),
                ...CACHE_LIMITATIONS,
              ]),
            ]
          : (meta.status?.limitations ?? []),
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
    configuration: OperonConfiguration,
  ): void {
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.operonId)) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          `Live Operon Bridge returned duplicate operonId ${task.operonId}; existing snapshot was preserved.`,
          this.requestContext("saveOperonSnapshot", {
            operonId: task.operonId,
          }),
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
      this.writeMeta(
        db,
        "snapshot_schema_version",
        String(OPERON_SNAPSHOT_SCHEMA_VERSION),
      );
      this.writeMeta(db, "snapshot_at", String(snapshotAt));
      this.writeMeta(db, "generation", String(status.index.generation));
      this.writeMeta(db, "settings_signature", status.settingsSignature ?? "");
      this.writeMeta(db, "operon_version", status.operon.version ?? "unknown");
      this.writeMeta(db, "bridge_version", status.bridge.version);
      this.writeMeta(db, "contract_version", status.contractVersion);
      this.writeMeta(db, "status_json", JSON.stringify(status));
      if (validation)
        this.writeMeta(db, "validation_json", JSON.stringify(validation));
      this.writeMeta(db, "configuration_json", JSON.stringify(configuration));
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

  private async fetchBridgeStatus(operation: string): Promise<OperonStatus> {
    const response = await this.getClient().get(`${BRIDGE_PREFIX}/status`);
    const parsed = OperonStatusSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge /status returned an incompatible payload.",
        this.requestContext(operation, {
          issueCount: parsed.error.issues.length,
        }),
      );
    }
    return parsed.data;
  }

  private async fetchLiveStatus(): Promise<OperonStatus> {
    const status = await this.fetchBridgeStatus("fetchLiveOperonStatus");
    if (!status.ok || !status.operon.compatible || !status.index.ready) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon Bridge is not ready (present=${status.operon.present}, version=${status.operon.version ?? "unknown"}, compatible=${status.operon.compatible}).`,
        this.requestContext("fetchLiveOperonStatus"),
      );
    }
    if (!status.capabilities.list || !status.capabilities.query) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Operon Bridge does not expose the required read capabilities.",
        this.requestContext("fetchLiveOperonStatus"),
      );
    }
    if (status.index.duplicateConflictCount > 0) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        `Operon reports ${status.index.duplicateConflictCount} duplicate operonId conflict(s).`,
        this.requestContext("fetchLiveOperonStatus", {
          duplicateConflictCount: status.index.duplicateConflictCount,
        }),
      );
    }
    return status;
  }

  private async fetchLiveRecoveryStatus(): Promise<OperonRecoveryStatus> {
    const response = await this.getClient().get(
      `${BRIDGE_PREFIX}/recovery-status`,
    );
    const parsed = OperonRecoveryStatusSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge /recovery-status returned an incompatible payload.",
        this.requestContext("fetchLiveOperonRecoveryStatus", {
          issueCount: parsed.error.issues.length,
        }),
      );
    }
    const status = parsed.data;
    if (!status.operon.present || !status.operon.compatible) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon recovery is unavailable (present=${status.operon.present}, version=${status.operon.version ?? "unknown"}, compatible=${status.operon.compatible}).`,
        this.requestContext("fetchLiveOperonRecoveryStatus"),
      );
    }
    return status;
  }

  private async fetchLiveValidation(): Promise<OperonValidation> {
    const response = await this.getClient().get(`${BRIDGE_PREFIX}/validate`);
    const parsed = OperonValidationSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge /validate returned an incompatible payload.",
        this.requestContext("fetchLiveOperonValidation", {
          issueCount: parsed.error.issues.length,
        }),
      );
    }
    return parsed.data;
  }

  private async fetchLiveConfiguration(): Promise<OperonConfiguration> {
    const response = await this.getClient().get(
      `${BRIDGE_PREFIX}/configuration`,
    );
    const parsed = OperonConfigurationSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge /configuration returned an incompatible payload.",
        this.requestContext("fetchLiveOperonConfiguration", {
          issueCount: parsed.error.issues.length,
        }),
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
      const response = (await this.getClient().post(
        `${BRIDGE_PREFIX}/tasks/query`,
        {
          cursor,
          limit: PAGE_SIZE,
          includeProperties: true,
          sort: [
            { field: "path", direction: "asc" },
            { field: "line", direction: "asc" },
          ],
        },
      )) as { data: unknown };
      const parsed = OperonBridgePageSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new McpError(
          BaseErrorCode.PARSING_ERROR,
          "Operon Bridge /tasks/query returned an incompatible payload.",
          this.requestContext("fetchAllLiveOperonTasks", {
            pageIndex,
            issueCount: parsed.error.issues.length,
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
          this.requestContext("fetchAllLiveOperonTasks", {
            pageIndex,
            cursor: page.nextCursor,
          }),
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (expectedTotal === null) {
      const settledStatus = await this.fetchLiveStatus();
      this.assertStableStatus(
        expectedStatus,
        settledStatus,
        "empty snapshot pagination",
      );
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
    this.assertStableStatus(
      expectedStatus,
      settledStatus,
      "snapshot pagination",
    );
    return { tasks, settledStatus };
  }

  private sameLiveGeneration(
    snapshot: OperonSnapshotEnvelope | null,
    status: OperonStatus,
  ): boolean {
    return Boolean(
      snapshot &&
        snapshot.snapshotSchemaVersion === OPERON_SNAPSHOT_SCHEMA_VERSION &&
        snapshot.generation === status.index.generation &&
        snapshot.settingsSignature === status.settingsSignature &&
        snapshot.operonVersion === status.operon.version &&
        snapshot.bridgeVersion === status.bridge.version &&
        snapshot.tasks.length === status.index.taskCount,
    );
  }

  private async refreshLiveSnapshot(
    status?: OperonStatus,
  ): Promise<OperonSnapshotEnvelope> {
    const liveStatus = status ?? (await this.fetchLiveStatus());
    const pageResult = await this.fetchAllLiveTasks(liveStatus);
    const validation = await this.fetchLiveValidation();
    if (
      validation.generation !== pageResult.settledStatus.index.generation ||
      validation.settingsSignature !==
        pageResult.settledStatus.settingsSignature
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
        this.requestContext("refreshLiveOperonSnapshot", {
          summary: validation.summary,
        }),
      );
    }
    const finalStatus = await this.fetchLiveStatus();
    this.assertStableStatus(
      pageResult.settledStatus,
      finalStatus,
      "snapshot validation",
    );
    const configuration = await this.fetchLiveConfiguration();
    if (configuration.settingsSignature !== finalStatus.settingsSignature) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "Operon configuration changed before the snapshot could be committed.",
        this.requestContext("refreshLiveOperonSnapshot", {
          expectedSettingsSignature: finalStatus.settingsSignature,
          observedSettingsSignature: configuration.settingsSignature,
        }),
      );
    }
    this.saveSnapshot(finalStatus, pageResult.tasks, validation, configuration);
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

  private async refreshLiveSnapshotCoalesced(
    status?: OperonStatus,
  ): Promise<OperonSnapshotEnvelope> {
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
          snapshotAgeMs: Math.max(
            0,
            Date.now() - Date.parse(cached!.snapshotAt),
          ),
          capabilities: status.capabilities,
          limitations: status.limitations,
        };
      }
      return await this.refreshLiveSnapshotCoalesced(status);
    } catch (error) {
      logger.warning(
        "Live Operon Bridge unavailable; considering persisted snapshot fallback.",
        {
          ...context,
          error: errorMessage(error),
          cacheAvailable: Boolean(cached),
        },
      );
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
        const live = await this.fetchBridgeStatus("operonStatus");
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
          error: {
            code: "live_bridge_unavailable",
            message: errorMessage(error),
          },
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

  async configuration(forceRefresh = false): Promise<Record<string, unknown>> {
    if (forceRefresh) {
      await this.ensureSnapshot(true);
    }

    if (liveModeConfigured()) {
      try {
        const status = await this.fetchLiveStatus();
        const configuration = await this.fetchLiveConfiguration();
        if (configuration.settingsSignature !== status.settingsSignature) {
          throw new McpError(
            BaseErrorCode.CONFLICT,
            "Operon settings changed while reading the configuration; retry after the plugin settles.",
            this.requestContext("operonConfiguration", {
              expectedSettingsSignature: status.settingsSignature,
              observedSettingsSignature: configuration.settingsSignature,
            }),
          );
        }
        return configuration;
      } catch (error) {
        const cached = this.readCachedConfiguration();
        if (cached) return cached;
        if (error instanceof McpError) throw error;
        throw new McpError(
          BaseErrorCode.SERVICE_UNAVAILABLE,
          `Operon configuration is unavailable and no cached configuration exists: ${errorMessage(error)}`,
          this.requestContext("operonConfiguration"),
        );
      }
    }

    const cached = this.readCachedConfiguration();
    if (cached) return cached;
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "No persisted Operon configuration is available in the current headless runtime.",
      this.requestContext("operonConfiguration"),
    );
  }

  private readCachedConfiguration(): Record<string, unknown> | null {
    const db = this.openDb();
    try {
      const meta = this.readMeta(db);
      if (!meta?.configuration) return null;
      return {
        ok: true,
        contractVersion: OPERON_CONTRACT_VERSION,
        source: "operon-cache",
        stale: true,
        snapshotAt: new Date(meta.snapshotAt).toISOString(),
        snapshotAgeMs: Math.max(0, Date.now() - meta.snapshotAt),
        operonVersion: meta.operonVersion,
        bridgeVersion: meta.bridgeVersion,
        settingsSignature: meta.configuration.settingsSignature,
        configuration: meta.configuration.configuration,
        limitations: [
          ...new Set([...meta.configuration.limitations, ...CACHE_LIMITATIONS]),
        ],
      };
    } finally {
      db.close();
    }
  }

  private snapshotSummary(
    snapshot: OperonSnapshotEnvelope,
  ): Record<string, unknown> {
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

  async querySavedFilter(input: unknown): Promise<Record<string, unknown>> {
    const params: OperonFilterQuery = OperonFilterQuerySchema.parse(input);
    if (!liveModeConfigured()) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Saved Operon filters require the live Obsidian Desktop Bridge.",
        this.requestContext("operonQuerySavedFilter"),
      );
    }
    // The status snapshot may be cold for this optional grant. Dispatch the
    // exact saved-filter request so the Bridge can negotiate only
    // tasks.filter-query and fail closed if consent is absent.
    const status = await this.fetchLiveStatus();
    const response = await this.getClient()
      .post(`${BRIDGE_PREFIX}/tasks/filter`, params)
      .catch((error: unknown) =>
        this.bridgeHttpError(error, "operonQuerySavedFilter"),
      );
    const parsed = OperonBridgePageSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge saved-filter query returned an incompatible payload.",
        this.requestContext("operonQuerySavedFilter", {
          issueCount: parsed.error.issues.length,
        }),
      );
    }
    return {
      ...parsed.data,
      snapshotAt: new Date().toISOString(),
      snapshotAgeMs: 0,
      operonVersion: status.operon.version ?? "unknown",
      bridgeVersion: status.bridge.version,
      capabilities: { ...status.capabilities, filterQuery: true },
    };
  }

  private async nativeRead(
    operation:
      | "diagnostics"
      | "finder"
      | "resolve"
      | "relationships"
      | "context"
      | "timers",
    method: "get" | "post",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!liveModeConfigured()) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon ${operation} requires the live Obsidian Desktop Bridge.`,
        this.requestContext(`operon_${operation}`),
      );
    }
    const status = await this.fetchLiveStatus();
    if (!status.capabilities[operation]) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        `Operon Bridge capability is unavailable: ${operation}.`,
        this.requestContext(`operon_${operation}`, {
          capabilities: status.capabilities,
        }),
      );
    }
    const response =
      method === "get"
        ? await this.getClient().get(path)
        : await this.getClient().post(path, payload ?? {});
    const parsed = OperonNativeReadEnvelopeSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.operation !== operation) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        `Operon Bridge ${operation} returned an incompatible payload.`,
        this.requestContext(`operon_${operation}`, {
          issueCount: parsed.success ? 0 : parsed.error.issues.length,
        }),
      );
    }
    return {
      ...parsed.data,
      operonVersion: status.operon.version ?? "unknown",
      bridgeVersion: status.bridge.version,
      capabilities: status.capabilities,
    };
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    return this.nativeRead(
      "diagnostics",
      "get",
      `${BRIDGE_PREFIX}/diagnostics`,
    );
  }

  async findTasks(input: unknown): Promise<Record<string, unknown>> {
    const params: OperonTaskFinder = OperonTaskFinderSchema.parse(input);
    return this.nativeRead(
      "finder",
      "post",
      `${BRIDGE_PREFIX}/tasks/finder`,
      params,
    );
  }

  async resolveTask(input: unknown): Promise<Record<string, unknown>> {
    const params: OperonResolveTask = OperonResolveTaskSchema.parse(input);
    return this.nativeRead(
      "resolve",
      "post",
      `${BRIDGE_PREFIX}/entities/resolve`,
      params,
    );
  }

  async relationships(input: unknown): Promise<Record<string, unknown>> {
    const params: OperonRelationships = OperonRelationshipsSchema.parse(input);
    return this.nativeRead(
      "relationships",
      "post",
      `${BRIDGE_PREFIX}/relationships`,
      params,
    );
  }

  async context(input: unknown): Promise<Record<string, unknown>> {
    const params: OperonContext = OperonContextSchema.parse(input);
    return this.nativeRead(
      "context",
      "post",
      `${BRIDGE_PREFIX}/context`,
      params,
    );
  }

  async timers(): Promise<Record<string, unknown>> {
    return this.nativeRead("timers", "get", `${BRIDGE_PREFIX}/timers`);
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

  async adoptTask(input: unknown): Promise<OperonMutationResult> {
    const params: OperonAdoptTask = OperonAdoptTaskSchema.parse(input);
    return this.executeMutation(
      "adopt",
      null,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/adopt`,
      params,
    );
  }

  async createPeriodicTask(input: unknown): Promise<OperonMutationResult> {
    const params: OperonCreatePeriodicTask =
      OperonCreatePeriodicTaskSchema.parse(input);
    return this.executeMutation(
      "periodic-create",
      null,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/periodic`,
      params,
    );
  }

  async updatePeriodicScheduling(
    input: unknown,
  ): Promise<OperonMutationResult> {
    const params: OperonUpdatePeriodicScheduling =
      OperonUpdatePeriodicSchedulingSchema.parse(input);
    return this.executeMutation(
      "periodic-update",
      params.operonId,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(params.operonId)}/periodic-update`,
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
    const params: OperonTransitionTask =
      OperonTransitionTaskSchema.parse(input);
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

  async relocateTask(input: unknown): Promise<OperonMutationResult> {
    const params: OperonRelocateTask = OperonRelocateTaskSchema.parse(input);
    return this.executeMutation(
      "relocate",
      params.operonId,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(params.operonId)}/relocate`,
      params,
    );
  }

  async setRelationships(input: unknown): Promise<OperonMutationResult> {
    const params: OperonSetRelationships =
      OperonSetRelationshipsSchema.parse(input);
    return this.executeMutation(
      "relationships",
      params.operonId,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(params.operonId)}/relationships`,
      params,
    );
  }

  async updateRecurrence(input: unknown): Promise<OperonMutationResult> {
    const params: OperonUpdateRecurrence =
      OperonUpdateRecurrenceSchema.parse(input);
    return this.executeMutation(
      "recurrence",
      params.operonId,
      params.idempotencyKey,
      params.dryRun,
      `${BRIDGE_PREFIX}/tasks/${encodeURIComponent(params.operonId)}/recurrence`,
      params,
    );
  }

  async pendingRecoveries(
    input: unknown = {},
  ): Promise<Record<string, unknown>> {
    const params: OperonPendingRecoveriesInput =
      OperonPendingRecoveriesInputSchema.parse(input);
    this.assertRecoveryPathScope("operon_list_pending_recoveries");
    if (!liveModeConfigured()) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Operon recovery requires the live Obsidian Desktop Bridge.",
        this.requestContext("operonPendingRecoveries"),
      );
    }
    const status = await this.fetchLiveRecoveryStatus();
    if (params.kind && !status.capabilities.taskWorkflowRecovery) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Operon Bridge does not expose task-workflow recovery.",
        this.requestContext("operonPendingRecoveries"),
      );
    }
    const requests: Array<{
      family: "developer-api" | "task-workflow";
      path: string;
      query?: Record<string, string>;
    }> = [];
    if (!params.kind && status.capabilities.recovery) {
      requests.push({
        family: "developer-api",
        path: `${BRIDGE_PREFIX}/mutations/pending-recoveries`,
      });
    }
    if (status.capabilities.taskWorkflowRecovery) {
      requests.push({
        family: "task-workflow",
        path: `${BRIDGE_PREFIX}/task-workflows/pending-recoveries`,
        ...(params.kind ? { query: { kind: params.kind } } : {}),
      });
    }
    if (requests.length === 0) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Operon Bridge does not expose official Developer API recovery.",
        this.requestContext("operonPendingRecoveries"),
      );
    }
    const recoveries: Record<string, unknown>[] = [];
    for (const request of requests) {
      const response = await this.getClient().get(
        request.path,
        request.query ? { params: request.query } : undefined,
      );
      const parsed = OperonPendingRecoveriesSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new McpError(
          BaseErrorCode.PARSING_ERROR,
          `Operon Bridge ${request.family} pending-recoveries returned an incompatible payload.`,
          this.requestContext("operonPendingRecoveries", {
            family: request.family,
            issueCount: parsed.error.issues.length,
          }),
        );
      }
      for (const recovery of parsed.data.recoveries) {
        const kind =
          request.family === "developer-api"
            ? "developer-api"
            : (recovery.workflowKind ?? recovery.kind);
        if (!kind) {
          throw new McpError(
            BaseErrorCode.PARSING_ERROR,
            "Operon Bridge task-workflow pending recovery omitted its workflow kind.",
            this.requestContext("operonPendingRecoveries", {
              family: request.family,
            }),
          );
        }
        recoveries.push({
          ...recovery,
          kind,
          recoveryFamily: request.family,
        });
      }
    }
    return {
      ok: true,
      contractVersion: OPERON_CONTRACT_VERSION,
      source: "operon-live",
      stale: false,
      recoveries,
    };
  }

  async recoverMutation(input: unknown): Promise<OperonMutationResult> {
    const params: OperonRecoverMutation =
      OperonRecoverMutationSchema.parse(input);
    // Enforce the current path policy before consulting the durable replay
    // journal. Otherwise a result sealed while the allowlist was empty could
    // bypass a later, stricter configuration after restart.
    this.assertRecoveryPathScope("operon_recover_mutation");
    const requested = {
      recoveryRef: params.recoveryRef,
      recovery: params.recovery,
    };
    const requestedJson = stableJson(requested);
    // 3.1 candidates briefly used the same fields flat. Accept their durable
    // journal binding internally so an upgrade does not strand a terminal
    // replay, while the public MCP input remains nested and unambiguous.
    const flatCandidateRequestedJson = stableJson({
      recoveryRef: params.recoveryRef,
      kind: params.recovery.kind,
      ...(params.recovery.kind !== "developer-api" && params.recovery.planDigest
        ? { planDigest: params.recovery.planDigest }
        : {}),
    });
    const legacyDeveloperApiRequestedJson =
      params.recovery.kind === "developer-api"
        ? stableJson({ recoveryRef: params.recoveryRef })
        : null;
    // Recovery is itself idempotent at the MCP boundary. A completed
    // recovery must replay from the durable journal after an MCP restart,
    // without requiring the Bridge to be reachable a second time.
    const existing = this.readMutationJournal(params.idempotencyKey);
    if (existing) {
      if (
        existing.action !== "recover" ||
        !matchesMutationJournalOperonId("recover", null, existing.operonId) ||
        (existing.requestedJson !== requestedJson &&
          existing.requestedJson !== flatCandidateRequestedJson &&
          existing.requestedJson !== legacyDeveloperApiRequestedJson)
      ) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Idempotency key was already used for a different Operon recovery request.",
          this.requestContext("operon_recover_mutation", {
            recoveryRef: params.recoveryRef,
            idempotencyKey: params.idempotencyKey,
          }),
        );
      }
      return existing.result;
    }
    if (!liveModeConfigured()) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Operon recovery requires the live Obsidian Desktop Bridge.",
        this.requestContext("operon_recover_mutation", {
          recoveryRef: params.recoveryRef,
        }),
      );
    }
    if (!config.operonMutationsEnabled) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Operon recovery is disabled. Set OPERON_MUTATIONS_ENABLED=true only after validating the live Bridge.",
        this.requestContext("operon_recover_mutation", {
          recoveryRef: params.recoveryRef,
        }),
      );
    }
    const status = await this.fetchLiveRecoveryStatus();
    const taskWorkflow = params.recovery.kind !== "developer-api";
    if (
      taskWorkflow
        ? !status.capabilities.taskWorkflowRecovery
        : !status.capabilities.recovery
    ) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        taskWorkflow
          ? "Operon Bridge does not expose task-workflow recovery."
          : "Operon Bridge does not expose official Developer API recovery.",
        this.requestContext("operon_recover_mutation", {
          recoveryRef: params.recoveryRef,
        }),
      );
    }
    assertWriteAllowed({
      operation: "operon_recover_mutation",
      action: "apply",
      target: params.recoveryRef,
      allowInReadonly: false,
      allowInGuarded: false,
      context: this.requestContext("operon_recover_mutation", {
        recoveryRef: params.recoveryRef,
        idempotencyKey: params.idempotencyKey,
      }),
    });
    const reservedResult = this.reserveMutationJournal(
      "recover",
      null,
      params.idempotencyKey,
      requested,
    );
    if (reservedResult) return reservedResult.result;
    const response = await this.getClient().post(
      taskWorkflow
        ? `${BRIDGE_PREFIX}/task-workflows/recover`
        : `${BRIDGE_PREFIX}/mutations/recover`,
      taskWorkflow
        ? {
            idempotencyKey: params.idempotencyKey,
            recoveryRef: params.recoveryRef,
            kind: params.recovery.kind,
            ...(params.recovery.kind !== "developer-api" &&
            params.recovery.planDigest
              ? { planDigest: params.recovery.planDigest }
              : {}),
          }
        : {
            idempotencyKey: params.idempotencyKey,
            recoveryRef: params.recoveryRef,
          },
      { validateStatus: () => true },
    );
    const preDispatchReason =
      response.status === 503
        ? this.preDispatchReasonFromReceipt(
            response.data,
            params.idempotencyKey,
          )
        : null;
    if (preDispatchReason) {
      const released = this.releasePreDispatchMutationReservation(
        "recover",
        null,
        params.idempotencyKey,
        requested,
      );
      if (!released) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "The pre-dispatch Operon recovery reservation could not be released safely; inspect the journal before retrying.",
          this.requestContext("operon_recover_mutation", {
            recoveryRef: params.recoveryRef,
            idempotencyKey: params.idempotencyKey,
          }),
        );
      }
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        this.preDispatchUnavailableMessage(preDispatchReason),
        this.requestContext("operon_recover_mutation", {
          recoveryRef: params.recoveryRef,
          idempotencyKey: params.idempotencyKey,
          responseStatus: response.status,
          preDispatch: true,
          preDispatchReason,
          hasBridgeCode: true,
          mutationMayHaveApplied: false,
        }),
      );
    }
    if (response.status === 503 && this.claimsPreDispatch(response.data)) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Invalid pre-dispatch Operon recovery receipt.",
        this.requestContext("operon_recover_mutation", {
          recoveryRef: params.recoveryRef,
          idempotencyKey: params.idempotencyKey,
          responseStatus: response.status,
          responseShapeValid: false,
          preDispatchClaimed: true,
        }),
      );
    }
    const parsed = OperonMutationResultSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        `Invalid Operon recovery response (${response.status}).`,
        this.requestContext("operon_recover_mutation", {
          recoveryRef: params.recoveryRef,
          issueCount: parsed.error.issues.length,
        }),
      );
    }
    if (parsed.data.idempotencyKey !== params.idempotencyKey) {
      throw new McpError(
        BaseErrorCode.PARSING_ERROR,
        "Operon Bridge recovery receipt did not match the requested idempotency key.",
        this.requestContext("operon_recover_mutation", {
          recoveryRef: params.recoveryRef,
          responseShapeValid: true,
          correlationMatched: false,
        }),
      );
    }
    this.writeMutationJournal("recover", null, requested, parsed.data);
    return parsed.data;
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
        logger.warning(
          "Live Operon validation failed; using snapshot validation.",
          {
            ...this.requestContext("validateOperonSnapshot"),
            error: errorMessage(error),
          },
        );
      }
    }
    return this.validateSnapshot(snapshot);
  }

  private validateSnapshot(
    snapshot: OperonSnapshotEnvelope,
  ): Record<string, unknown> {
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
