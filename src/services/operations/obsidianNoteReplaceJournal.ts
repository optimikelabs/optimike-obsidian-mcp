import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import type { OperationProof } from "./contract.js";
import type {
  ModifiedTimeSettlementEvidence,
  ModifiedTimeSettlementPolicy,
} from "./modifiedTimeSettlement.js";

export type ObsidianNoteReplaceStatus =
  | "planned"
  | "applying"
  | "committed"
  | "conflict"
  | "rejected"
  | "failed"
  | "expired"
  | "outcome_unknown"
  /** Administrative closure after review: no further effect can occur, success is not claimed. */
  | "reviewed_unverified";

/**
 * Write attempts whose effect-fence token was durably recorded before dispatch.
 * `untracked` is sticky: an execution started by a build without this record
 * (or before it) may have dispatched without any token.
 */
export type EffectTracking = {
  contractVersion: 1;
  untracked: boolean;
  lastExecutionStartedAtEpochMs?: number;
  attempts: Array<{ attemptId: string; epoch?: string; recordedAt: string }>;
};

export const MAX_RECORDED_EFFECT_ATTEMPTS = 32;

export type AdministrativeClosureEvidence = {
  contractVersion: 1;
  closedAt: string;
  reasonCode: "operator_review" | "historical_cleanup";
  previousOutcome: "outcome_unknown";
  guarantee: "no_further_effect";
  priorEffect: "none" | "may_have_occurred" | "unknown";
  bridge: { pluginVersion: string; bindingFingerprint: string; epoch: string };
  attempts: Array<{ attemptId: string; epoch: string; verdict: string; settledAgoMs?: number }>;
  legacy?: { requireFence: true; strictForMs: number; unfencedInFlight: 0 };
  observation:
    | { kind: "note-sha256"; sha256: string; matches?: "before" | "after" | "neither" }
    | { kind: "note-absent" }
    | { kind: "unavailable" };
};

export type ObsidianNoteReplaceProjection = {
  contractVersion: 1;
  kind: string;
  publicIdempotencyKey: string;
  intentDigest: string;
  proof: Record<string, unknown>;
  normalizationProtectedFrontmatterKeys?: string[];
};

export type ObsidianNoteReplacePlan = {
  operationId: string;
  idempotencyKey: string;
  requestDigest: string;
  datePreparation?: import("./contract.js").OperationReceipt["datePreparation"];
  frontmatterFormat?: import("./contract.js").OperationReceipt["frontmatterFormat"];
  idempotencyIdentity?: string;
  projection?: ObsidianNoteReplaceProjection;
  path: string;
  beforeSha256: string;
  afterSha256: string;
  nextContent: string;
  bindingFingerprint: string;
  status: ObsidianNoteReplaceStatus;
  createdAt: string;
  updatedAt: string;
  failure?: string;
  executionOwner?: {
    instanceId: string;
    attemptId: string;
  };
  modifiedTimeSettlementPolicy?: ModifiedTimeSettlementPolicy;
  executionStartedAtEpochMs?: number;
  settlementObservationStartedAtEpochMs?: number;
  // Persisted only after the CAS attempt has returned; no live executor remains.
  settlementDeferred?: {
    kind: "postflight" | "cas_conflict";
    recoveredFromUnknown: boolean;
    completionToken?: string;
  };
  modifiedTimeSettlementEvidence?: ModifiedTimeSettlementEvidence;
  effectProof?: OperationProof;
  effectTracking?: EffectTracking;
  administrativeClosure?: AdministrativeClosureEvidence;
};

export class ObsidianNoteReplaceConcurrencyError extends Error {
  constructor() {
    super("The note replacement state changed concurrently.");
  }
}

export function noteReplaceIdempotencyConflict(): McpError {
  return new McpError(
    BaseErrorCode.CONFLICT,
    "The idempotency key is already bound to a different note replacement.",
    { reason: "note_replace_idempotency_conflict" },
  );
}

export type ObsidianNoteReplaceJournalOptions = {
  now?: () => number;
  terminalRetentionMs?: number;
  plannedRetentionMs?: number;
  purgeIntervalMs?: number;
  executionLeaseMs?: number;
  executionSweepIntervalMs?: number;
  sqliteBusyTimeoutMs?: number;
  startupRetryWindowMs?: number;
  startupRetryDelayMs?: number;
};

export type PendingOperationKind =
  | "obsidian.note.replace"
  | "obsidian.frontmatter.patch"
  | "obsidian.base.formula.patch"
  | "obsidian.canvas.patch"
  | "obsidian.text.patch"
  | "obsidian.note.move"
  | "obsidian.note.delete"
  | "obsidian.note.create"
  | "obsidian.base.rows.patch"
  | "obsidian.asset.import";

export type PendingOperationRow = {
  operationId: string;
  status: "planned" | "applying" | "outcome_unknown";
  createdAt: string;
  updatedAt: string;
  operationKind: PendingOperationKind;
};

export type PendingOperationRowsInput = {
  /**
   * The operation kind assigned by the owning journal when its private row has
   * no admitted projection kind.
   */
  fallbackOperationKind: PendingOperationKind;
  /** Projection kinds that are valid for this specific owning journal. */
  admittedProjectionKinds: readonly PendingOperationKind[];
  /** Only the Note journal owns native rows without a projection envelope. */
  allowUnprojectedFallback: boolean;
  limit: number;
  operationKind?: PendingOperationKind;
  status?: PendingOperationRow["status"];
  createdBefore?: string;
  after?: Pick<
    PendingOperationRow,
    "updatedAt" | "operationKind" | "operationId"
  >;
};

export type PendingOperationRowsPage = {
  rows: PendingOperationRow[];
  hasMore: boolean;
};

const STABLE_TERMINAL = new Set<ObsidianNoteReplaceStatus>([
  "committed",
  "conflict",
  "rejected",
  "failed",
  "expired",
]);

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_STARTUP_RETRY_WINDOW_MS = 15_000;
const SQLITE_STARTUP_RETRY_DELAY_MS = 50;
const MAX_PENDING_OPERATION_ROWS_LIMIT = 100;
function isTransientSqliteContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & {
    code?: string;
    errcode?: number;
  };
  return (
    sqliteError.errcode === 5 ||
    sqliteError.errcode === 6 ||
    /SQLITE_(?:BUSY|LOCKED)|database(?: table| schema)? is locked/iu.test(
      `${sqliteError.code ?? ""} ${sqliteError.message}`,
    )
  );
}

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

function sameRequestInput(
  existing: ObsidianNoteReplacePlan,
  input: Pick<
    ObsidianNoteReplacePlan,
    "path" | "afterSha256" | "idempotencyIdentity"
  >,
): boolean {
  if (
    existing.idempotencyIdentity !== undefined ||
    input.idempotencyIdentity !== undefined
  ) {
    return (
      existing.path === input.path &&
      existing.idempotencyIdentity !== undefined &&
      existing.idempotencyIdentity === input.idempotencyIdentity
    );
  }
  return (
    existing.path === input.path && existing.afterSha256 === input.afterSha256
  );
}

export class ObsidianNoteReplaceJournal {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly terminalRetentionMs: number;
  private readonly plannedRetentionMs: number;
  private readonly purgeIntervalMs: number;
  private readonly executionLeaseMs: number;
  private readonly executionSweepIntervalMs: number;
  private readonly sqliteBusyTimeoutMs: number;
  private readonly startupRetryWindowMs: number;
  private readonly startupRetryDelayMs: number;
  private readonly executionOwner = { instanceId: randomUUID() };
  private nextPurgeAt = 0;
  private nextExecutionSweepAt = 0;
  private walCheckpointRequired = false;
  private closed = false;

  constructor(
    databasePath: string,
    options: ObsidianNoteReplaceJournalOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.terminalRetentionMs =
      options.terminalRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.plannedRetentionMs = options.plannedRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.purgeIntervalMs = options.purgeIntervalMs ?? 60 * 60 * 1000;
    this.executionLeaseMs = options.executionLeaseMs ?? 30_000;
    this.executionSweepIntervalMs = options.executionSweepIntervalMs ?? 1_000;
    this.sqliteBusyTimeoutMs = Math.max(
      1,
      Math.floor(options.sqliteBusyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS),
    );
    this.startupRetryWindowMs = Math.max(
      this.sqliteBusyTimeoutMs,
      Math.floor(
        options.startupRetryWindowMs ?? SQLITE_STARTUP_RETRY_WINDOW_MS,
      ),
    );
    this.startupRetryDelayMs = Math.max(
      1,
      Math.floor(options.startupRetryDelayMs ?? SQLITE_STARTUP_RETRY_DELAY_MS),
    );
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try {
      // This policy must exist before WAL negotiation, schema creation, lease
      // writes, or any other statement that can encounter another MCP process.
      this.db.exec(`PRAGMA busy_timeout=${this.sqliteBusyTimeoutMs}`);
      this.initializeWithContentionRetry();
    } catch (error) {
      this.db.close();
      throw error;
    }
    for (const privatePath of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      if (!existsSync(privatePath)) continue;
      try {
        chmodSync(privatePath, 0o600);
      } catch {
        // Windows ACLs remain authoritative when POSIX modes are unavailable.
      }
    }
  }

  private initializeWithContentionRetry(): void {
    const deadline = Date.now() + this.startupRetryWindowMs;
    for (;;) {
      try {
        this.db.exec("PRAGMA journal_mode=WAL");
        this.db.exec("PRAGMA synchronous=FULL");
        this.db.exec("PRAGMA secure_delete=ON");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS obsidian_note_replace_plans (
            operation_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS obsidian_note_replace_runtime_leases (
            instance_id TEXT PRIMARY KEY,
            heartbeat_at TEXT NOT NULL,
            expires_at TEXT
          )
        `);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS obsidian_date_preparation_fences (
            target_digest TEXT PRIMARY KEY,
            attempt_id TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `);
        // Released preparation locks keep their review evidence (no note content).
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS obsidian_date_preparation_fence_reviews (
            target_digest TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reviewed_at TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            PRIMARY KEY (target_digest, attempt_id)
          )
        `);
        this.ensureExecutionLeaseExpiryColumn();
        this.ensureDatePreparationFenceEpochColumn();
        this.renewExecutionLease();
        this.markInterruptedPlans();
        this.maybePurgeTerminalPlans();
        return;
      } catch (error) {
        if (!isTransientSqliteContention(error) || Date.now() >= deadline) {
          throw error;
        }
        waitSynchronously(
          Math.min(
            this.startupRetryDelayMs,
            Math.max(1, deadline - Date.now()),
          ),
        );
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.markOwnedPlansInterrupted();
    this.db
      .prepare(
        "DELETE FROM obsidian_note_replace_runtime_leases WHERE instance_id = ?",
      )
      .run(this.executionOwner.instanceId);
    this.db.close();
  }

  renewExecutionLease(): void {
    if (this.closed) return;
    const now = this.now();
    const heartbeatAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.executionLeaseMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO obsidian_note_replace_runtime_leases
           (instance_id, heartbeat_at, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at`,
      )
      .run(this.executionOwner.instanceId, heartbeatAt, expiresAt);
  }

  /** A dispatched FDM preparation is never automatically replayed after an
   * uncertain response, including after restart. The target is stored hashed. */
  hasDatePreparationFence(targetDigest: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM obsidian_date_preparation_fences WHERE target_digest = ?").get(targetDigest);
  }

  /** The attempt id doubles as the Bridge effect-fence token when an epoch is known. */
  acquireDatePreparationFence(targetDigest: string, fenceEpoch?: string): string | undefined {
    const attempt = randomUUID();
    const result = this.db.prepare("INSERT OR IGNORE INTO obsidian_date_preparation_fences (target_digest, attempt_id, created_at, fence_epoch) VALUES (?, ?, ?, ?)")
      .run(targetDigest, attempt, new Date(this.now()).toISOString(), fenceEpoch ?? null);
    return Number(result.changes) === 1 ? attempt : undefined;
  }

  getDatePreparationFence(targetDigest: string): { attemptId: string; createdAt: string; fenceEpoch?: string } | undefined {
    const row = this.db.prepare("SELECT attempt_id, created_at, fence_epoch FROM obsidian_date_preparation_fences WHERE target_digest = ?")
      .get(targetDigest) as { attempt_id: string; created_at: string; fence_epoch: string | null } | undefined;
    return row ? { attemptId: row.attempt_id, createdAt: row.created_at, ...(row.fence_epoch ? { fenceEpoch: row.fence_epoch } : {}) } : undefined;
  }

  getDatePreparationFenceReview(targetDigest: string): { attemptId: string; reviewedAt: string; evidence: unknown } | undefined {
    const row = this.db.prepare("SELECT attempt_id, reviewed_at, evidence_json FROM obsidian_date_preparation_fence_reviews WHERE target_digest = ? ORDER BY reviewed_at DESC LIMIT 1")
      .get(targetDigest) as { attempt_id: string; reviewed_at: string; evidence_json: string } | undefined;
    return row ? { attemptId: row.attempt_id, reviewedAt: row.reviewed_at, evidence: JSON.parse(row.evidence_json) } : undefined;
  }

  /** Atomically release one exact preparation lock and keep its review evidence. */
  resolveDatePreparationFence(targetDigest: string, attempt: string, evidence: unknown): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT created_at FROM obsidian_date_preparation_fences WHERE target_digest = ? AND attempt_id = ?")
        .get(targetDigest, attempt) as { created_at: string } | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("INSERT INTO obsidian_date_preparation_fence_reviews (target_digest, attempt_id, created_at, reviewed_at, evidence_json) VALUES (?, ?, ?, ?, ?)")
        .run(targetDigest, attempt, row.created_at, new Date(this.now()).toISOString(), JSON.stringify(evidence));
      this.db.prepare("DELETE FROM obsidian_date_preparation_fences WHERE target_digest = ? AND attempt_id = ?").run(targetDigest, attempt);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseVerifiedDatePreparationFence(targetDigest: string, attempt: string): boolean {
    return Number(this.db.prepare("DELETE FROM obsidian_date_preparation_fences WHERE target_digest = ? AND attempt_id = ?").run(targetDigest, attempt).changes) === 1;
  }

  create(
    input: Omit<
      ObsidianNoteReplacePlan,
      "operationId" | "status" | "createdAt" | "updatedAt"
    >,
    maximumActiveProjectionRows?: number,
  ): ObsidianNoteReplacePlan {
    this.maybePurgeTerminalPlans();
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (!sameRequestInput(existing, input)) {
        throw noteReplaceIdempotencyConflict();
      }
      return existing;
    }
    if (
      maximumActiveProjectionRows !== undefined &&
      (!Number.isInteger(maximumActiveProjectionRows) ||
        maximumActiveProjectionRows < 1 ||
        maximumActiveProjectionRows > 100 ||
        !input.projection?.kind)
    ) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Invalid operation capacity policy.",
      );
    }
    const now = new Date(this.now()).toISOString();
    const plan: ObsidianNoteReplacePlan = {
      ...input,
      operationId: randomUUID(),
      status: "planned",
      createdAt: now,
      updatedAt: now,
      effectTracking: { contractVersion: 1, untracked: false, attempts: [] },
    };
    const insertValues = maximumActiveProjectionRows === undefined
      ? "VALUES (?, ?, ?, ?, ?, ?)"
      : "SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM obsidian_note_replace_plans WHERE status IN ('planned','applying','outcome_unknown') AND json_extract(payload_json, '$.projection.kind') = ?) < ?";
    const inserted = this.db
      .prepare(
        `INSERT INTO obsidian_note_replace_plans
         (operation_id, idempotency_key, status, payload_json, created_at, updated_at)
         ${insertValues}
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        plan.operationId,
        plan.idempotencyKey,
        plan.status,
        JSON.stringify(plan),
        plan.createdAt,
        plan.updatedAt,
        ...(maximumActiveProjectionRows === undefined ? [] : [input.projection!.kind, maximumActiveProjectionRows]),
      );
    if (inserted.changes === 1) return plan;

    // Another process won the same-key race after our optimistic lookup.
    // SQLite serializes the conflicting insert; reload its durable winner
    // instead of surfacing a UNIQUE constraint as an MCP INTERNAL_ERROR.
    const winner = this.getByIdempotencyKey(input.idempotencyKey);
    if (!winner) {
      if (maximumActiveProjectionRows !== undefined) {
        throw new McpError(
          BaseErrorCode.SERVICE_UNAVAILABLE,
          "Private operation capacity reached.",
          { reason: "operation_capacity_reached" },
        );
      }
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    if (!sameRequestInput(winner, input)) {
      throw noteReplaceIdempotencyConflict();
    }
    return winner;
  }

  get(operationId: string): ObsidianNoteReplacePlan | undefined {
    this.maybeMarkInterruptedPlans();
    this.maybePurgeTerminalPlans();
    const row = this.db
      .prepare(
        "SELECT payload_json FROM obsidian_note_replace_plans WHERE operation_id = ?",
      )
      .get(operationId) as { payload_json: string } | undefined;
    return row
      ? (JSON.parse(row.payload_json) as ObsidianNoteReplacePlan)
      : undefined;
  }

  getByIdempotencyKey(key: string): ObsidianNoteReplacePlan | undefined {
    this.maybeMarkInterruptedPlans();
    this.maybePurgeTerminalPlans();
    const row = this.db
      .prepare(
        "SELECT payload_json FROM obsidian_note_replace_plans WHERE idempotency_key = ?",
      )
      .get(key) as { payload_json: string } | undefined;
    return row
      ? (JSON.parse(row.payload_json) as ObsidianNoteReplacePlan)
      : undefined;
  }

  /**
   * Read the bounded operation-cockpit projection without parsing a private
   * plan in JavaScript. This intentionally does not renew leases, sweep
   * interrupted work, purge retention, or checkpoint the journal.
   */
  listPendingOperationRows(
    input: PendingOperationRowsInput,
  ): PendingOperationRowsPage {
    this.assertOpen();
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_PENDING_OPERATION_ROWS_LIMIT
    ) {
      throw new RangeError(
        `Pending operation row limit must be an integer from 1 to ${MAX_PENDING_OPERATION_ROWS_LIMIT}.`,
      );
    }

    if (
      input.admittedProjectionKinds.length < 1 ||
      input.admittedProjectionKinds.length > 8 ||
      new Set(input.admittedProjectionKinds).size !==
        input.admittedProjectionKinds.length
    ) {
      throw new RangeError(
        "Pending operation projection kinds must be a non-empty unique bounded set.",
      );
    }

    const projectionKind = "json_extract(payload_json, '$.projection.kind')";
    const admittedPlaceholders = input.admittedProjectionKinds
      .map(() => "?")
      .join(", ");
    const operationKind = `COALESCE(${projectionKind}, ?)`;
    const parameters: Array<string | number> = [
      input.fallbackOperationKind,
      ...input.admittedProjectionKinds,
    ];
    const filters: string[] = [];
    if (input.operationKind) { filters.push("operation_kind = ?"); parameters.push(input.operationKind); }
    if (input.status) { filters.push("status = ?"); parameters.push(input.status); }
    if (input.createdBefore) { filters.push("created_at <= ?"); parameters.push(input.createdBefore); }
    let afterClause = "";
    if (input.after) {
      filters.push(`(updated_at < ?
          OR (updated_at = ? AND operation_kind > ?)
          OR (updated_at = ? AND operation_kind = ? AND operation_id > ?))`);
      parameters.push(
        input.after.updatedAt,
        input.after.updatedAt,
        input.after.operationKind,
        input.after.updatedAt,
        input.after.operationKind,
        input.after.operationId,
      );
    }
    if (filters.length) afterClause = `WHERE ${filters.join(" AND ")}`;
    parameters.push(input.limit + 1);
    const rows = this.db
      .prepare(
        `WITH pending_operations AS (
           SELECT operation_id, status, created_at, updated_at,
                  ${operationKind} AS operation_kind
           FROM obsidian_note_replace_plans
           WHERE status IN ('planned', 'applying', 'outcome_unknown')
             AND (
               ${projectionKind} IN (${admittedPlaceholders})
               ${input.allowUnprojectedFallback ? "OR json_type(payload_json, '$.projection') IS NULL" : ""}
             )
         )
         SELECT operation_id, status, created_at, updated_at, operation_kind
         FROM pending_operations
         ${afterClause}
         ORDER BY updated_at DESC, operation_kind ASC, operation_id ASC
         LIMIT ?`,
      )
      .all(...parameters) as Array<{
      operation_id: string;
      status: PendingOperationRow["status"];
      created_at: string;
      updated_at: string;
      operation_kind: PendingOperationKind;
    }>;
    const hasMore = rows.length > input.limit;
    return {
      rows: rows.slice(0, input.limit).map((row) => ({
        operationId: row.operation_id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        operationKind: row.operation_kind,
      })),
      hasMore,
    };
  }

  transition(
    operationId: string,
    expected: ObsidianNoteReplaceStatus[],
    next: ObsidianNoteReplaceStatus,
    failure?: string,
    expectedExecutionAttemptId?: string,
  ): ObsidianNoteReplacePlan {
    return this.transitionInternal(
      operationId,
      expected,
      next,
      failure,
      expectedExecutionAttemptId,
      false,
      undefined,
    );
  }

  beginModifiedTimeSettlementObservation(
    operationId: string,
    expected: Array<"applying" | "outcome_unknown">,
    expectedExecutionAttemptId?: string,
  ): ObsidianNoteReplacePlan {
    this.maybePurgeTerminalPlans();
    const current = this.get(operationId);
    if (!current || !expected.some((status) => status === current.status)) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    if (
      current.status === "applying" &&
      (!expectedExecutionAttemptId ||
        current.executionOwner?.attemptId !== expectedExecutionAttemptId)
    ) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    if (current.settlementObservationStartedAtEpochMs !== undefined) {
      return current;
    }
    const updated: ObsidianNoteReplacePlan = {
      ...current,
      settlementObservationStartedAtEpochMs: this.now(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE obsidian_note_replace_plans
         SET payload_json = ?, updated_at = ?
         WHERE operation_id = ? AND status IN (${placeholders})
           AND payload_json = ?`,
      )
      .run(
        JSON.stringify(updated),
        updated.updatedAt,
        operationId,
        ...expected,
        JSON.stringify(current),
      );
    if (Number(result.changes) !== 1) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    return updated;
  }

  deferSettlement(
    operationId: string,
    expectedExecutionAttemptId: string,
    deferred: NonNullable<ObsidianNoteReplacePlan["settlementDeferred"]>,
  ): ObsidianNoteReplacePlan {
    const current = this.get(operationId);
    if (
      !current ||
      current.status !== "applying" ||
      current.executionOwner?.attemptId !== expectedExecutionAttemptId ||
      current.settlementObservationStartedAtEpochMs === undefined
    ) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    const updated: ObsidianNoteReplacePlan = {
      ...current,
      settlementDeferred: deferred,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const result = this.db
      .prepare(
        `UPDATE obsidian_note_replace_plans SET payload_json = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'applying' AND payload_json = ?`,
      )
      .run(
        JSON.stringify(updated),
        updated.updatedAt,
        operationId,
        JSON.stringify(current),
      );
    if (Number(result.changes) !== 1)
      throw new ObsidianNoteReplaceConcurrencyError();
    return updated;
  }

  commitWithModifiedTimeSettlement(
    operationId: string,
    expected: Array<"applying" | "outcome_unknown">,
    evidence: ModifiedTimeSettlementEvidence,
    expectedExecutionAttemptId?: string,
  ): ObsidianNoteReplacePlan {
    return this.transitionInternal(
      operationId,
      expected,
      "committed",
      undefined,
      expectedExecutionAttemptId,
      expectedExecutionAttemptId === undefined,
      evidence,
    );
  }

  commitWithCompletionProof(
    operationId: string,
    expectedExecutionAttemptId: string,
    effectProof: OperationProof,
    settlementEvidence?: ModifiedTimeSettlementEvidence,
  ): ObsidianNoteReplacePlan {
    return this.transitionInternal(operationId, ['applying'], 'committed', undefined,
      expectedExecutionAttemptId, false, settlementEvidence, effectProof);
  }

  commitAfterVerifiedProof(
    operationId: string,
    expected: Array<"applying" | "outcome_unknown">,
    effectProof?: OperationProof,
  ): ObsidianNoteReplacePlan {
    return this.transitionInternal(
      operationId,
      expected,
      "committed",
      undefined,
      undefined,
      true,
      undefined,
      effectProof,
    );
  }

  /**
   * Record the effect-fence token of the live attempt BEFORE its dispatch. The
   * compare-and-set fails once the attempt no longer owns an applying plan, so
   * a stale executor never dispatches after an interruption sweep.
   */
  recordEffectAttempt(
    operationId: string,
    expectedExecutionAttemptId: string,
    fenceEpoch: string | undefined,
  ): ObsidianNoteReplacePlan {
    const current = this.get(operationId);
    if (
      !current ||
      current.status !== "applying" ||
      current.executionOwner?.attemptId !== expectedExecutionAttemptId
    ) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    const tracking: EffectTracking = current.effectTracking ?? {
      contractVersion: 1,
      // A historical plan may already have unrecorded dispatches.
      untracked: true,
      lastExecutionStartedAtEpochMs: current.executionStartedAtEpochMs,
      attempts: [],
    };
    if (tracking.attempts.some((item) => item.attemptId === expectedExecutionAttemptId)) {
      return current;
    }
    if (tracking.attempts.length >= MAX_RECORDED_EFFECT_ATTEMPTS) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "The operation reached its bounded number of write attempts.",
        { reason: "effect_attempt_limit_reached" },
      );
    }
    const updated: ObsidianNoteReplacePlan = {
      ...current,
      effectTracking: {
        ...tracking,
        attempts: [
          ...tracking.attempts,
          {
            attemptId: expectedExecutionAttemptId,
            ...(fenceEpoch ? { epoch: fenceEpoch } : {}),
            recordedAt: new Date(this.now()).toISOString(),
          },
        ],
      },
      updatedAt: new Date(this.now()).toISOString(),
    };
    const result = this.db
      .prepare(
        `UPDATE obsidian_note_replace_plans SET payload_json = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'applying' AND payload_json = ?`,
      )
      .run(
        JSON.stringify(updated),
        updated.updatedAt,
        operationId,
        JSON.stringify(current),
      );
    if (Number(result.changes) !== 1) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    return updated;
  }

  /**
   * Administrative closure. The caller must have proven, through the Bridge
   * effect fence, that no recorded or legacy attempt can still produce an
   * effect. The compare-and-set on the exact observed payload fails if any
   * new attempt, recovery or reconciliation happened in between.
   */
  closeAdministratively(
    observed: ObsidianNoteReplacePlan,
    evidence: AdministrativeClosureEvidence,
  ): ObsidianNoteReplacePlan {
    this.assertOpen();
    if (observed.status !== "outcome_unknown") {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    const updated: ObsidianNoteReplacePlan = {
      ...observed,
      status: "reviewed_unverified",
      updatedAt: new Date(this.now()).toISOString(),
      executionOwner: undefined,
      nextContent: "",
      administrativeClosure: evidence,
    };
    const result = this.db
      .prepare(
        `UPDATE obsidian_note_replace_plans
         SET status = 'reviewed_unverified', payload_json = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'outcome_unknown' AND payload_json = ?`,
      )
      .run(
        JSON.stringify(updated),
        updated.updatedAt,
        observed.operationId,
        JSON.stringify(observed),
      );
    if (Number(result.changes) !== 1) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    this.walCheckpointRequired = true;
    this.checkpointSensitiveFrames();
    return updated;
  }

  private transitionInternal(
    operationId: string,
    expected: ObsidianNoteReplaceStatus[],
    next: ObsidianNoteReplaceStatus,
    failure: string | undefined,
    expectedExecutionAttemptId: string | undefined,
    verifiedCommitWithoutOwner: boolean,
    settlementEvidence: ModifiedTimeSettlementEvidence | undefined,
    effectProof?: OperationProof,
  ): ObsidianNoteReplacePlan {
    this.maybePurgeTerminalPlans();
    const current = this.get(operationId);
    if (!current || !expected.includes(current.status)) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    if (
      current.status === "applying" &&
      !verifiedCommitWithoutOwner &&
      (!expectedExecutionAttemptId ||
        current.executionOwner?.attemptId !== expectedExecutionAttemptId)
    ) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    const nowMs = this.now();
    const updated: ObsidianNoteReplacePlan = {
      ...current,
      status: next,
      updatedAt: new Date(nowMs).toISOString(),
      ...(next === "applying"
        ? {
            executionOwner: {
              ...this.executionOwner,
              attemptId: randomUUID(),
            },
            executionStartedAtEpochMs: nowMs,
            settlementObservationStartedAtEpochMs: undefined,
            settlementDeferred: undefined,
            ...(current.effectTracking ||
            current.executionStartedAtEpochMs === undefined
              ? {
                  effectTracking: {
                    // A plan never executed before has no unrecorded dispatch.
                    ...(current.effectTracking ?? {
                      contractVersion: 1 as const,
                      untracked: false,
                      attempts: [],
                    }),
                    // A start this tracker did not see may have dispatched without a token.
                    untracked:
                      (current.effectTracking?.untracked ?? false) ||
                      current.executionStartedAtEpochMs !==
                        current.effectTracking?.lastExecutionStartedAtEpochMs,
                    lastExecutionStartedAtEpochMs: nowMs,
                  },
                }
              : {}),
          }
        : { executionOwner: undefined }),
      ...(settlementEvidence
        ? { modifiedTimeSettlementEvidence: settlementEvidence }
        : {}),
      ...(effectProof ? { effectProof } : {}),
      ...(STABLE_TERMINAL.has(next) ? { nextContent: "" } : {}),
      ...(failure ? { failure } : { failure: undefined }),
    };
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE obsidian_note_replace_plans
         SET status = ?, payload_json = ?, updated_at = ?
         WHERE operation_id = ? AND status IN (${placeholders})
           AND payload_json = ?`,
      )
      .run(
        next,
        JSON.stringify(updated),
        updated.updatedAt,
        operationId,
        ...expected,
        JSON.stringify(current),
      );
    if (Number(result.changes) !== 1) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    if (STABLE_TERMINAL.has(next)) {
      this.walCheckpointRequired = true;
      this.checkpointSensitiveFrames();
    }
    return updated;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("The note replacement journal is closed.");
    }
  }

  private maybePurgeTerminalPlans(): void {
    if (this.walCheckpointRequired) this.checkpointSensitiveFrames();
    const now = this.now();
    if (now < this.nextPurgeAt) return;
    const cutoff = new Date(now - this.terminalRetentionMs).toISOString();
    const plannedCutoff = new Date(now - this.plannedRetentionMs).toISOString();
    const expiredAt = new Date(now).toISOString();
    // This atomic update fences an apply's planned -> applying transition.
    // Never expire an already dispatched or uncertain operation.
    const expired = this.db.prepare(`UPDATE obsidian_note_replace_plans
      SET status = 'expired', updated_at = ?,
          payload_json = json_set(payload_json, '$.status', 'expired', '$.updatedAt', ?, '$.nextContent', '')
      WHERE status = 'planned' AND created_at < ?`).run(expiredAt, expiredAt, plannedCutoff);
    this.db.prepare(`DELETE FROM obsidian_note_replace_runtime_leases
      WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(expiredAt);
    const result = this.db
      .prepare(
        `DELETE FROM obsidian_note_replace_plans
         WHERE status IN ('committed', 'conflict', 'rejected', 'failed', 'expired')
           AND updated_at < ?`,
      )
      .run(cutoff);
    if (Number(result.changes) > 0 || Number(expired.changes) > 0) {
      this.walCheckpointRequired = true;
      this.checkpointSensitiveFrames();
    }
    this.nextPurgeAt = now + this.purgeIntervalMs;
  }

  private markInterruptedPlans(): void {
    const updatedAt = new Date(this.now()).toISOString();
    const update = this.db.prepare(
      `UPDATE obsidian_note_replace_plans
       SET status = 'outcome_unknown', payload_json = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'applying' AND payload_json = ?`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          "SELECT operation_id, payload_json FROM obsidian_note_replace_plans WHERE status = 'applying'",
        )
        .all() as Array<{ operation_id: string; payload_json: string }>;
      for (const row of rows) {
        const current = JSON.parse(row.payload_json) as ObsidianNoteReplacePlan;
        // A deferred observer needs no lease. Its attempt fence still prevents replay.
        if (
          current.settlementDeferred ||
          this.executionOwnerHasFreshLease(current.executionOwner)
        )
          continue;
        const interrupted: ObsidianNoteReplacePlan = {
          ...current,
          status: "outcome_unknown",
          updatedAt,
          executionOwner: undefined,
          failure:
            "The process restarted while apply was in progress; exact-plan recovery is required.",
        };
        update.run(
          JSON.stringify(interrupted),
          updatedAt,
          row.operation_id,
          row.payload_json,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private maybeMarkInterruptedPlans(): void {
    const now = this.now();
    if (now < this.nextExecutionSweepAt) return;
    this.markInterruptedPlans();
    this.nextExecutionSweepAt = now + this.executionSweepIntervalMs;
  }

  private markOwnedPlansInterrupted(): void {
    const updatedAt = new Date(this.now()).toISOString();
    const update = this.db.prepare(
      `UPDATE obsidian_note_replace_plans
       SET status = 'outcome_unknown', payload_json = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'applying' AND payload_json = ?`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          "SELECT operation_id, payload_json FROM obsidian_note_replace_plans WHERE status = 'applying'",
        )
        .all() as Array<{ operation_id: string; payload_json: string }>;
      const owned = rows.filter((row) => {
        const plan = JSON.parse(row.payload_json) as ObsidianNoteReplacePlan;
        return (
          !plan.settlementDeferred &&
          plan.executionOwner?.instanceId === this.executionOwner.instanceId
        );
      });
      for (const row of owned) {
        const current = JSON.parse(row.payload_json) as ObsidianNoteReplacePlan;
        const interrupted: ObsidianNoteReplacePlan = {
          ...current,
          status: "outcome_unknown",
          updatedAt,
          executionOwner: undefined,
          failure:
            "The owning runtime closed while apply was in progress; exact-plan recovery is required.",
        };
        update.run(
          JSON.stringify(interrupted),
          updatedAt,
          row.operation_id,
          row.payload_json,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private executionOwnerHasFreshLease(
    owner: ObsidianNoteReplacePlan["executionOwner"],
  ): boolean {
    if (!owner?.instanceId) return false;
    const row = this.db
      .prepare(
        "SELECT expires_at FROM obsidian_note_replace_runtime_leases WHERE instance_id = ?",
      )
      .get(owner.instanceId) as { expires_at: string | null } | undefined;
    if (!row) return false;
    const expiresAt = Date.parse(row.expires_at ?? "");
    return Number.isFinite(expiresAt) && expiresAt > this.now();
  }

  private ensureExecutionLeaseExpiryColumn(): void {
    const hasExpiry = () =>
      (
        this.db
          .prepare("PRAGMA table_info(obsidian_note_replace_runtime_leases)")
          .all() as Array<{ name: string }>
      ).some((column) => column.name === "expires_at");
    if (hasExpiry()) return;
    try {
      this.db.exec(
        "ALTER TABLE obsidian_note_replace_runtime_leases ADD COLUMN expires_at TEXT",
      );
    } catch (error) {
      // Another process may have completed the same additive migration after
      // our schema read. Only suppress that race when the column now exists.
      if (!hasExpiry()) throw error;
    }
  }

  private ensureDatePreparationFenceEpochColumn(): void {
    const hasEpoch = () =>
      (
        this.db
          .prepare("PRAGMA table_info(obsidian_date_preparation_fences)")
          .all() as Array<{ name: string }>
      ).some((column) => column.name === "fence_epoch");
    if (hasEpoch()) return;
    try {
      this.db.exec(
        "ALTER TABLE obsidian_date_preparation_fences ADD COLUMN fence_epoch TEXT",
      );
    } catch (error) {
      // Another process may have completed the same additive migration.
      if (!hasEpoch()) throw error;
    }
  }

  private checkpointSensitiveFrames(): void {
    const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy?: number;
    };
    this.walCheckpointRequired = Number(result.busy ?? 0) !== 0;
  }
}
