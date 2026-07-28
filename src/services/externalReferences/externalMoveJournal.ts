import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExternalMoveSnapshot } from "../externalRootsService.js";

export type ExternalNoteRepair = {
  filePath: string;
  expectedSha256: string;
  before: string;
  after: string;
};

export type ExternalMovePlanStatus =
  | "planned"
  | "applying"
  | "applied"
  | "rolling_back"
  | "rolled_back"
  | "failed";

export type ExternalMovePlan = {
  planId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  status: ExternalMovePlanStatus;
  snapshot: ExternalMoveSnapshot;
  sourceToken: string;
  targetToken: string;
  oldFileUri: string;
  newFileUri: string;
  repairs: ExternalNoteRepair[];
  manualReview: Array<{ filePath: string; reason: string }>;
  failure?: string;
};

export class ExternalMoveJournal {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
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

  create(
    input: Omit<
      ExternalMovePlan,
      "planId" | "createdAt" | "updatedAt" | "status"
    >,
  ): ExternalMovePlan {
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    const plan: ExternalMovePlan = {
      ...input,
      planId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "planned",
    };
    this.db
      .prepare(
        `INSERT INTO external_move_plans
         (plan_id, idempotency_key, status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.planId,
        plan.idempotencyKey,
        plan.status,
        JSON.stringify(plan),
        plan.createdAt,
        plan.updatedAt,
      );
    return plan;
  }

  get(planId: string): ExternalMovePlan | undefined {
    const row = this.db
      .prepare("SELECT payload_json FROM external_move_plans WHERE plan_id = ?")
      .get(planId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as ExternalMovePlan) : undefined;
  }

  getByIdempotencyKey(key: string): ExternalMovePlan | undefined {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM external_move_plans WHERE idempotency_key = ?",
      )
      .get(key) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as ExternalMovePlan) : undefined;
  }

  update(
    planId: string,
    status: ExternalMovePlanStatus,
    failure?: string,
  ): ExternalMovePlan {
    const current = this.get(planId);
    if (!current) throw new Error("Unknown external move plan.");
    const updated: ExternalMovePlan = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
      failure,
    };
    this.db
      .prepare(
        `UPDATE external_move_plans
         SET status = ?, payload_json = ?, updated_at = ?
         WHERE plan_id = ?`,
      )
      .run(status, JSON.stringify(updated), updated.updatedAt, planId);
    return updated;
  }

  transition(
    planId: string,
    expectedStatuses: ExternalMovePlanStatus[],
    nextStatus: ExternalMovePlanStatus,
  ): ExternalMovePlan {
    const current = this.get(planId);
    if (!current || !expectedStatuses.includes(current.status)) {
      throw new Error("External move plan state changed concurrently.");
    }
    const updated: ExternalMovePlan = {
      ...current,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
      failure: undefined,
    };
    const placeholders = expectedStatuses.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE external_move_plans
         SET status = ?, payload_json = ?, updated_at = ?
         WHERE plan_id = ? AND status IN (${placeholders})`,
      )
      .run(
        nextStatus,
        JSON.stringify(updated),
        updated.updatedAt,
        planId,
        ...expectedStatuses,
      );
    if (Number(result.changes) !== 1) {
      throw new Error("External move plan state changed concurrently.");
    }
    return updated;
  }
}
