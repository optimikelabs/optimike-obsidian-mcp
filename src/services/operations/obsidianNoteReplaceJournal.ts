import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ObsidianNoteReplaceStatus =
  | "planned"
  | "applying"
  | "committed"
  | "conflict"
  | "rejected"
  | "failed"
  | "outcome_unknown";

export type ObsidianNoteReplacePlan = {
  operationId: string;
  idempotencyKey: string;
  requestDigest: string;
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
  };
};

export class ObsidianNoteReplaceConcurrencyError extends Error {
  constructor() {
    super("The note replacement state changed concurrently.");
  }
}

export type ObsidianNoteReplaceJournalOptions = {
  now?: () => number;
  terminalRetentionMs?: number;
  purgeIntervalMs?: number;
  executionLeaseMs?: number;
  executionSweepIntervalMs?: number;
};

const STABLE_TERMINAL = new Set<ObsidianNoteReplaceStatus>([
  "committed",
  "conflict",
  "rejected",
  "failed",
]);

export class ObsidianNoteReplaceJournal {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly terminalRetentionMs: number;
  private readonly purgeIntervalMs: number;
  private readonly executionLeaseMs: number;
  private readonly executionSweepIntervalMs: number;
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
    this.purgeIntervalMs = options.purgeIntervalMs ?? 60 * 60 * 1000;
    this.executionLeaseMs = options.executionLeaseMs ?? 30_000;
    this.executionSweepIntervalMs = options.executionSweepIntervalMs ?? 1_000;
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA secure_delete=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
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
    this.ensureExecutionLeaseExpiryColumn();
    this.renewExecutionLease();
    this.markInterruptedPlans();
    this.maybePurgeTerminalPlans();
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

  create(
    input: Omit<
      ObsidianNoteReplacePlan,
      "operationId" | "status" | "createdAt" | "updatedAt"
    >,
  ): ObsidianNoteReplacePlan {
    this.maybePurgeTerminalPlans();
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new Error(
          "The idempotency key is already bound to a different note replacement.",
        );
      }
      return existing;
    }
    const now = new Date(this.now()).toISOString();
    const plan: ObsidianNoteReplacePlan = {
      ...input,
      operationId: randomUUID(),
      status: "planned",
      createdAt: now,
      updatedAt: now,
    };
    const inserted = this.db
      .prepare(
        `INSERT INTO obsidian_note_replace_plans
         (operation_id, idempotency_key, status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        plan.operationId,
        plan.idempotencyKey,
        plan.status,
        JSON.stringify(plan),
        plan.createdAt,
        plan.updatedAt,
      );
    if (inserted.changes === 1) return plan;

    // Another process won the same-key race after our optimistic lookup.
    // SQLite serializes the conflicting insert; reload its durable winner
    // instead of surfacing a UNIQUE constraint as an MCP INTERNAL_ERROR.
    const winner = this.getByIdempotencyKey(input.idempotencyKey);
    if (!winner) throw new ObsidianNoteReplaceConcurrencyError();
    if (winner.requestDigest !== input.requestDigest) {
      throw new Error(
        "The idempotency key is already bound to a different note replacement.",
      );
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

  transition(
    operationId: string,
    expected: ObsidianNoteReplaceStatus[],
    next: ObsidianNoteReplaceStatus,
    failure?: string,
    expectedExecutionOwnerId?: string,
  ): ObsidianNoteReplacePlan {
    this.maybePurgeTerminalPlans();
    const current = this.get(operationId);
    if (!current || !expected.includes(current.status)) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    if (
      current.status === "applying" &&
      (!expectedExecutionOwnerId ||
        current.executionOwner?.instanceId !== expectedExecutionOwnerId)
    ) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    const updated: ObsidianNoteReplacePlan = {
      ...current,
      status: next,
      updatedAt: new Date(this.now()).toISOString(),
      ...(next === "applying"
        ? { executionOwner: this.executionOwner }
        : { executionOwner: undefined }),
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

  private maybePurgeTerminalPlans(): void {
    if (this.walCheckpointRequired) this.checkpointSensitiveFrames();
    const now = this.now();
    if (now < this.nextPurgeAt) return;
    const cutoff = new Date(now - this.terminalRetentionMs).toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM obsidian_note_replace_plans
         WHERE status IN ('committed', 'conflict', 'rejected', 'failed')
           AND updated_at < ?`,
      )
      .run(cutoff);
    if (Number(result.changes) > 0) {
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
        if (this.executionOwnerHasFreshLease(current.executionOwner)) continue;
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

  private checkpointSensitiveFrames(): void {
    const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy?: number;
    };
    this.walCheckpointRequired = Number(result.busy ?? 0) !== 0;
  }
}
