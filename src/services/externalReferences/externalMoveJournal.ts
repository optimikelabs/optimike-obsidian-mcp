import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExternalMoveSnapshot } from "../externalRootsService.js";
import type {
  BackendVaultDestructiveSession,
  ExternalMoveBindingIdentity,
} from "./backendVaultAdapter.js";

export type ExternalNoteRepair = {
  filePath: string;
  expectedSha256: string;
  before: string;
  after: string;
};

export type ExternalMovePlanStatus =
  | "planned"
  | "applying_file"
  | "file_moved"
  | "applying_repairs"
  | "applied"
  | "rolling_back_repairs"
  | "rolling_back_file"
  | "rolled_back"
  | "failed_compensated"
  | "recovery_required"
  // Legacy states are retained so an existing private journal can be
  // recovered instead of becoming unreadable after an upgrade.
  | "applying"
  | "rolling_back"
  | "failed";

export type ExternalMovePlan = {
  planId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  status: ExternalMovePlanStatus;
  snapshot: ExternalMoveSnapshot;
  bindingIdentity: ExternalMoveBindingIdentity;
  /** Private, process-local fence; never projected through move status. */
  destructiveSession: BackendVaultDestructiveSession;
  sourceToken: string;
  targetToken: string;
  oldFileUri: string;
  newFileUri: string;
  repairs: ExternalNoteRepair[];
  manualReview: Array<{ filePath: string; reason: string }>;
  inventoryDigest: string;
  appliedRepairPaths: string[];
  restoredRepairPaths: string[];
  /** Stable value-free failure codes only; raw backend text is never durable. */
  recoveryErrors: string[];
  /** Stable value-free failure code only; legacy free text is redacted on read. */
  failure?: string;
};

type ExternalMovePlanPatch = Partial<
  Pick<
    ExternalMovePlan,
    "failure" | "appliedRepairPaths" | "restoredRepairPaths" | "recoveryErrors"
  >
>;

export type ExternalMovePlanCreateInput = Omit<
  ExternalMovePlan,
  "planId" | "createdAt" | "updatedAt" | "status"
>;

/**
 * Private read receipt. Pass this to an `*Observed` mutation after validating
 * `plan`; never replace it with a later `get()` result before the mutation.
 */
export type ExternalMoveJournalObservation = Readonly<{
  plan: ExternalMovePlan;
  planId: string;
  idempotencyKey: string;
  rawPayload: string;
  status: ExternalMovePlanStatus;
  updatedAt: string;
}>;

/** Reject a row/payload split-brain before a stored plan drives an action. */
export function isExternalMoveJournalObservationConsistent(
  observed: ExternalMoveJournalObservation,
): boolean {
  return (
    observed.plan.planId === observed.planId &&
    observed.plan.idempotencyKey === observed.idempotencyKey &&
    observed.plan.status === observed.status &&
    observed.plan.updatedAt === observed.updatedAt
  );
}

export type ExternalMoveJournalCreateResult = {
  plan: ExternalMovePlan;
  created: boolean;
};

export type ExternalMoveJournalCreateOptions = {
  /** The caller owns request semantics and compares winner with attempted. */
  isCompatible?: (
    winner: ExternalMovePlan,
    attempted: ExternalMovePlan,
  ) => boolean;
};

export class ExternalMoveJournalConcurrencyError extends Error {
  constructor() {
    super("External move plan state changed concurrently.");
  }
}

export class ExternalMoveJournalIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key is already bound to another external move.");
  }
}

export class ExternalMoveJournalInvalidReceiptError extends Error {
  constructor() {
    super("Stored external move journal data is invalid.");
  }
}

type ExternalMovePlanRow = {
  plan_id: string;
  idempotency_key: string;
  status: ExternalMovePlanStatus;
  payload_json: string;
  updated_at: string;
};

export class ExternalMoveJournal {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS external_move_plans (
        plan_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    for (const privatePath of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      if (existsSync(privatePath)) {
        try {
          chmodSync(privatePath, 0o600);
        } catch {
          // Windows ACLs remain authoritative when POSIX modes are unavailable.
        }
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Atomically insert a new receipt or load the same-key durable winner. */
  createOrLoad(
    input: ExternalMovePlanCreateInput,
    options: ExternalMoveJournalCreateOptions = {},
  ): ExternalMoveJournalCreateResult {
    const now = new Date().toISOString();
    const attempted: ExternalMovePlan = {
      ...input,
      appliedRepairPaths: [...input.appliedRepairPaths],
      restoredRepairPaths: [...input.restoredRepairPaths],
      recoveryErrors: [...input.recoveryErrors],
      planId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "planned",
    };
    let transactionOpen = false;
    try {
      // A same-key caller either writes its plan or reads the committed winner;
      // it cannot surface a UNIQUE constraint or a transient missing receipt.
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const existing = this.observeByIdempotencyKeyInternal(
        input.idempotencyKey,
      );
      if (existing) {
        this.db.exec("COMMIT");
        transactionOpen = false;
        if (
          !isExternalMoveJournalObservationConsistent(existing) ||
          options.isCompatible?.(existing.plan, attempted) === false
        ) {
          throw new ExternalMoveJournalIdempotencyConflictError();
        }
        return { plan: existing.plan, created: false };
      }
      this.db
        .prepare(
          `INSERT INTO external_move_plans
           (plan_id, idempotency_key, status, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempted.planId,
          attempted.idempotencyKey,
          attempted.status,
          JSON.stringify(attempted),
          attempted.createdAt,
          attempted.updatedAt,
        );
      this.db.exec("COMMIT");
      transactionOpen = false;
      return { plan: attempted, created: true };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Legacy convenience wrapper. Destructive paths should retain an observation. */
  create(
    input: ExternalMovePlanCreateInput,
    options: ExternalMoveJournalCreateOptions = {},
  ): ExternalMovePlan {
    return this.createOrLoad(input, options).plan;
  }

  observe(planId: string): ExternalMoveJournalObservation | undefined {
    const row = this.db
      .prepare(
        `SELECT plan_id, idempotency_key, status, payload_json, updated_at
         FROM external_move_plans WHERE plan_id = ?`,
      )
      .get(planId) as ExternalMovePlanRow | undefined;
    return row ? this.toObservation(row) : undefined;
  }

  observeByIdempotencyKey(
    key: string,
  ): ExternalMoveJournalObservation | undefined {
    return this.observeByIdempotencyKeyInternal(key);
  }

  get(planId: string): ExternalMovePlan | undefined {
    return this.observe(planId)?.plan;
  }

  getByIdempotencyKey(key: string): ExternalMovePlan | undefined {
    return this.observeByIdempotencyKey(key)?.plan;
  }

  /** CAS from exactly the private receipt already validated by the caller. */
  transitionObserved(
    observed: ExternalMoveJournalObservation,
    expectedStatuses: ExternalMovePlanStatus[],
    nextStatus: ExternalMovePlanStatus,
    patch: ExternalMovePlanPatch = {},
  ): ExternalMoveJournalObservation {
    if (!expectedStatuses.includes(observed.status)) {
      throw new ExternalMoveJournalConcurrencyError();
    }
    return this.persistObserved(observed, nextStatus, {
      recoveryErrors: [],
      failure: undefined,
      ...patch,
    });
  }

  updateObserved(
    observed: ExternalMoveJournalObservation,
    status: ExternalMovePlanStatus,
    failure?: string,
    patch: ExternalMovePlanPatch = {},
  ): ExternalMoveJournalObservation {
    return this.persistObserved(observed, status, { ...patch, failure });
  }

  recordAppliedRepairObserved(
    observed: ExternalMoveJournalObservation,
    filePath: string,
  ): ExternalMoveJournalObservation {
    if (observed.status !== "applying_repairs") {
      throw new ExternalMoveJournalConcurrencyError();
    }
    const appliedRepairPaths = [
      ...new Set([...(observed.plan.appliedRepairPaths ?? []), filePath]),
    ].sort((left, right) => left.localeCompare(right));
    return this.persistObserved(observed, "applying_repairs", {
      appliedRepairPaths,
    });
  }

  recordRestoredRepairObserved(
    observed: ExternalMoveJournalObservation,
    filePath: string,
  ): ExternalMoveJournalObservation {
    if (observed.status !== "rolling_back_repairs") {
      throw new ExternalMoveJournalConcurrencyError();
    }
    const restoredRepairPaths = [
      ...new Set([...(observed.plan.restoredRepairPaths ?? []), filePath]),
    ].sort((left, right) => left.localeCompare(right));
    return this.persistObserved(observed, "rolling_back_repairs", {
      restoredRepairPaths,
    });
  }

  /** Legacy convenience wrapper. Destructive paths should use `updateObserved`. */
  update(
    planId: string,
    status: ExternalMovePlanStatus,
    failure?: string,
    patch: ExternalMovePlanPatch = {},
  ): ExternalMovePlan {
    const observed = this.observe(planId);
    if (!observed) throw new Error("Unknown external move plan.");
    return this.updateObserved(observed, status, failure, patch).plan;
  }

  /** Legacy convenience wrapper. Destructive paths should use `transitionObserved`. */
  transition(
    planId: string,
    expectedStatuses: ExternalMovePlanStatus[],
    nextStatus: ExternalMovePlanStatus,
    patch: ExternalMovePlanPatch = {},
  ): ExternalMovePlan {
    const observed = this.observe(planId);
    if (!observed) throw new ExternalMoveJournalConcurrencyError();
    return this.transitionObserved(
      observed,
      expectedStatuses,
      nextStatus,
      patch,
    ).plan;
  }

  /** Legacy convenience wrapper. Destructive paths should use `recordAppliedRepairObserved`. */
  recordAppliedRepair(planId: string, filePath: string): ExternalMovePlan {
    const observed = this.observe(planId);
    if (!observed) throw new Error("Unknown external move plan.");
    return this.recordAppliedRepairObserved(observed, filePath).plan;
  }

  /** Legacy convenience wrapper. Destructive paths should use `recordRestoredRepairObserved`. */
  recordRestoredRepair(planId: string, filePath: string): ExternalMovePlan {
    const observed = this.observe(planId);
    if (!observed) throw new Error("Unknown external move plan.");
    return this.recordRestoredRepairObserved(observed, filePath).plan;
  }

  private observeByIdempotencyKeyInternal(
    key: string,
  ): ExternalMoveJournalObservation | undefined {
    const row = this.db
      .prepare(
        `SELECT plan_id, idempotency_key, status, payload_json, updated_at
         FROM external_move_plans WHERE idempotency_key = ?`,
      )
      .get(key) as ExternalMovePlanRow | undefined;
    return row ? this.toObservation(row) : undefined;
  }

  private toObservation(
    row: ExternalMovePlanRow,
  ): ExternalMoveJournalObservation {
    let plan: ExternalMovePlan;
    try {
      plan = JSON.parse(row.payload_json) as ExternalMovePlan;
    } catch {
      throw new ExternalMoveJournalInvalidReceiptError();
    }
    return {
      plan,
      planId: row.plan_id,
      idempotencyKey: row.idempotency_key,
      rawPayload: row.payload_json,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  private persistObserved(
    observed: ExternalMoveJournalObservation,
    nextStatus: ExternalMovePlanStatus,
    patch: ExternalMovePlanPatch,
  ): ExternalMoveJournalObservation {
    if (!isExternalMoveJournalObservationConsistent(observed)) {
      throw new ExternalMoveJournalConcurrencyError();
    }
    const updated: ExternalMovePlan = {
      ...observed.plan,
      appliedRepairPaths: observed.plan.appliedRepairPaths ?? [],
      restoredRepairPaths: observed.plan.restoredRepairPaths ?? [],
      recoveryErrors: observed.plan.recoveryErrors ?? [],
      ...patch,
      status: nextStatus,
      updatedAt: this.nextUpdatedAt(observed.updatedAt),
    };
    const rawPayload = JSON.stringify(updated);
    const result = this.db
      .prepare(
        `UPDATE external_move_plans
         SET status = ?, payload_json = ?, updated_at = ?
         WHERE plan_id = ?
           AND status = ?
           AND payload_json = ?
           AND updated_at = ?`,
      )
      .run(
        nextStatus,
        rawPayload,
        updated.updatedAt,
        observed.planId,
        observed.status,
        observed.rawPayload,
        observed.updatedAt,
      );
    if (Number(result.changes) !== 1) {
      throw new ExternalMoveJournalConcurrencyError();
    }
    return {
      plan: updated,
      planId: observed.planId,
      idempotencyKey: observed.idempotencyKey,
      rawPayload,
      status: nextStatus,
      updatedAt: updated.updatedAt,
    };
  }

  private nextUpdatedAt(observedUpdatedAt: string): string {
    const observedEpoch = Date.parse(observedUpdatedAt);
    const floor = Number.isFinite(observedEpoch) ? observedEpoch + 1 : 0;
    return new Date(Math.max(Date.now(), floor)).toISOString();
  }
}
