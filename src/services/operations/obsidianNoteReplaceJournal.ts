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
  private nextPurgeAt = 0;

  constructor(
    databasePath: string,
    options: ObsidianNoteReplaceJournalOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.terminalRetentionMs =
      options.terminalRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.purgeIntervalMs = options.purgeIntervalMs ?? 60 * 60 * 1000;
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
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
    this.db.close();
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
    this.db
      .prepare(
        `INSERT INTO obsidian_note_replace_plans
         (operation_id, idempotency_key, status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.operationId,
        plan.idempotencyKey,
        plan.status,
        JSON.stringify(plan),
        plan.createdAt,
        plan.updatedAt,
      );
    return plan;
  }

  get(operationId: string): ObsidianNoteReplacePlan | undefined {
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
  ): ObsidianNoteReplacePlan {
    this.maybePurgeTerminalPlans();
    const current = this.get(operationId);
    if (!current || !expected.includes(current.status)) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    const updated: ObsidianNoteReplacePlan = {
      ...current,
      status: next,
      updatedAt: new Date(this.now()).toISOString(),
      ...(STABLE_TERMINAL.has(next) ? { nextContent: "" } : {}),
      ...(failure ? { failure } : { failure: undefined }),
    };
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE obsidian_note_replace_plans
         SET status = ?, payload_json = ?, updated_at = ?
         WHERE operation_id = ? AND status IN (${placeholders})`,
      )
      .run(
        next,
        JSON.stringify(updated),
        updated.updatedAt,
        operationId,
        ...expected,
      );
    if (Number(result.changes) !== 1) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    return updated;
  }

  private maybePurgeTerminalPlans(): void {
    const now = this.now();
    if (now < this.nextPurgeAt) return;
    const cutoff = new Date(now - this.terminalRetentionMs).toISOString();
    this.db
      .prepare(
        `DELETE FROM obsidian_note_replace_plans
         WHERE status IN ('committed', 'conflict', 'rejected', 'failed')
           AND updated_at < ?`,
      )
      .run(cutoff);
    this.nextPurgeAt = now + this.purgeIntervalMs;
  }
}
