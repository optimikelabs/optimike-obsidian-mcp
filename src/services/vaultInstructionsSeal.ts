import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Durable seals of the vault instructions that applied when a governed plan
 * was made. The apply or recover of that plan checks the seal again, so a
 * plan made under one version of the rules cannot run after they change.
 *
 * Kept apart from the operation journals: the 13 governed families keep their
 * own journals untouched. A seal is deleted 90 days after it was written; a
 * missing seal makes an enforced apply refuse (fail-closed), never run
 * unchecked.
 */

export interface VaultInstructionsSealRecord {
  planRef: string;
  planTool: string;
  mode: string;
  targets: Array<{ path: string; folder?: boolean }>;
  files: Array<{ path: string; sha256: string }>;
  rulesDigest: string;
  sealedAt: number;
}

export const VAULT_INSTRUCTIONS_SEAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class VaultInstructionsSealJournal {
  private readonly db: DatabaseSync;
  private nextPurgeAt = 0;

  constructor(
    databasePath: string,
    private readonly now: () => number = Date.now,
    private readonly retentionMs = VAULT_INSTRUCTIONS_SEAL_RETENTION_MS,
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec("PRAGMA busy_timeout=5000");
      if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS plan_seals (
        plan_ref TEXT PRIMARY KEY,
        plan_tool TEXT NOT NULL,
        mode TEXT NOT NULL,
        targets TEXT NOT NULL,
        files TEXT NOT NULL,
        rules_digest TEXT NOT NULL,
        sealed_at INTEGER NOT NULL
      )`);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS plan_seals_sealed_at ON plan_seals(sealed_at)",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (databasePath !== ":memory:") {
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
  }

  private purge(): void {
    const now = this.now();
    if (now < this.nextPurgeAt) return;
    this.nextPurgeAt = now + 60 * 60 * 1000;
    this.db
      .prepare("DELETE FROM plan_seals WHERE sealed_at < ?")
      .run(now - this.retentionMs);
  }

  seal(record: Omit<VaultInstructionsSealRecord, "sealedAt">): void {
    this.purge();
    this.db
      .prepare(
        `INSERT INTO plan_seals (plan_ref, plan_tool, mode, targets, files, rules_digest, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_ref) DO UPDATE SET plan_tool = excluded.plan_tool,
           mode = excluded.mode, targets = excluded.targets, files = excluded.files,
           rules_digest = excluded.rules_digest, sealed_at = excluded.sealed_at`,
      )
      .run(
        record.planRef,
        record.planTool,
        record.mode,
        JSON.stringify(record.targets),
        JSON.stringify(record.files),
        record.rulesDigest,
        this.now(),
      );
  }

  get(planRef: string): VaultInstructionsSealRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT plan_ref, plan_tool, mode, targets, files, rules_digest, sealed_at FROM plan_seals WHERE plan_ref = ?",
      )
      .get(planRef) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (Number(row.sealed_at) < this.now() - this.retentionMs) return undefined;
    try {
      return {
        planRef: String(row.plan_ref),
        planTool: String(row.plan_tool),
        mode: String(row.mode),
        targets: JSON.parse(String(row.targets)),
        files: JSON.parse(String(row.files)),
        rulesDigest: String(row.rules_digest),
        sealedAt: Number(row.sealed_at),
      };
    } catch {
      return undefined;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
