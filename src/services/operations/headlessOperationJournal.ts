import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { foldedPath } from "./headlessVaultFiles.js";

export type HeadlessPhase = "planned" | "applying" | "committed" | "conflict" | "rejected";
export type HeadlessRow<T> = {
  id: string; key: string; phase: HeadlessPhase; payload: T; createdAt: string; updatedAt: string;
};

/** Durable admission and per-path reservations shared by local filesystem operations. */
export class HeadlessOperationJournal<T> {
  constructor(private readonly filename: string, private readonly binding: string) {}

  transaction<R>(work: (tx: HeadlessJournalTransaction<T>) => R): R {
    mkdirSync(path.dirname(this.filename), { recursive: true });
    const db = new DatabaseSync(this.filename);
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS headless_file_operations (
          id TEXT PRIMARY KEY, binding TEXT NOT NULL, operation_key TEXT NOT NULL,
          phase TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(binding, operation_key)
        );
        CREATE TABLE IF NOT EXISTS headless_file_reservations (
          binding TEXT NOT NULL, path TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY(binding, path)
        );
        CREATE INDEX IF NOT EXISTS idx_headless_file_phase ON headless_file_operations(binding, phase);
        BEGIN IMMEDIATE;
      `);
      try {
        const result = work(new HeadlessJournalTransaction<T>(db, this.binding));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
}

class HeadlessJournalTransaction<T> {
  constructor(private readonly db: DatabaseSync, private readonly binding: string) {}

  revision(): number {
    return this.db.prepare("SELECT count(*) AS revision FROM headless_file_operations WHERE binding = ? AND phase = 'committed'")
      .get(this.binding)!.revision as number;
  }

  read(value: string, byKey = false): HeadlessRow<T> | undefined {
    const row = this.db.prepare(`
      SELECT id, operation_key, phase, payload, created_at, updated_at FROM headless_file_operations
      WHERE binding = ? AND ${byKey ? "operation_key" : "id"} = ?
    `).get(this.binding, value);
    if (!row) return undefined;
    return {
      id: row.id as string, key: row.operation_key as string, phase: row.phase as HeadlessPhase,
      payload: JSON.parse(row.payload as string) as T, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    };
  }

  insert(row: HeadlessRow<T>): HeadlessRow<T> {
    this.db.prepare("INSERT INTO headless_file_operations VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, this.binding, row.key, row.phase, JSON.stringify(row.payload), row.createdAt, row.updatedAt);
    return row;
  }

  claim(row: HeadlessRow<T>, paths: readonly string[]): HeadlessRow<T> {
    // The index is vault-wide. A partially published operation can change
    // resolution even when two plans have no paths in common.
    if (this.db.prepare("SELECT 1 FROM headless_file_reservations WHERE binding = ? LIMIT 1").get(this.binding)) {
      throw new McpError(BaseErrorCode.CONFLICT, "A headless file operation is pending. Reconcile or recover it before applying another plan.");
    }
    const reserve = this.db.prepare("INSERT INTO headless_file_reservations VALUES (?, ?, ?)");
    for (const target of new Set(paths.map(foldedPath))) reserve.run(this.binding, target, row.id);
    return this.settle(row, "applying");
  }

  settle(row: HeadlessRow<T>, phase: HeadlessPhase): HeadlessRow<T> {
    const updatedAt = new Date().toISOString();
    const { changes } = this.db.prepare(
      "UPDATE headless_file_operations SET phase = ?, updated_at = ? WHERE binding = ? AND id = ? AND phase = ?",
    ).run(phase, updatedAt, this.binding, row.id, row.phase);
    if (changes !== 1) throw new McpError(BaseErrorCode.CONFLICT, "The headless operation changed.");
    if (phase !== "applying") {
      this.db.prepare("DELETE FROM headless_file_reservations WHERE binding = ? AND operation_id = ?").run(this.binding, row.id);
    }
    return { ...row, phase, updatedAt };
  }
}
