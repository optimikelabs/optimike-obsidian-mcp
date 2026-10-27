import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";

/**
 * Bounds how large the shared cache's WAL file stays on disk.
 *
 * `journal_size_limit` makes SQLite truncate the WAL back to this size once a
 * checkpoint has completed and the log restarts; it never drops committed data
 * and never forces a checkpoint. It is a per-connection setting, so every
 * connection that opens the shared cache applies it. `0` leaves SQLite's default
 * (the WAL keeps its high-water mark).
 */
export function applyWalSizeLimit(
  db: DatabaseSync,
  limitBytes = config.sqliteJournalSizeLimitBytes,
): void {
  if (limitBytes > 0) {
    db.exec(`PRAGMA journal_size_limit = ${Math.floor(limitBytes)};`);
  }
}

export type WalCheckpointResult = {
  /** `truncate` completed or was refused; `passive` is the fallback when readers or writers held it. */
  mode: "truncate" | "passive";
  /** True when another connection prevented the checkpoint from running to completion. */
  busy: boolean;
  walBytesBefore: number;
  walBytesAfter: number;
  /** Frames in the log and frames written back to the database file by this checkpoint. */
  logFrames: number;
  checkpointedFrames: number;
  /** Pages SQLite could reuse; reclaiming the file space itself needs `run_maintenance` (VACUUM). */
  freelistPages: number;
  pageCount: number;
};

function walBytes(databasePath: string): number {
  const walPath = `${databasePath}-wal`;
  return existsSync(walPath) ? statSync(walPath).size : 0;
}

function pragmaNumber(row: unknown, key: string): number {
  const value = (row as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Safe, non-destructive WAL checkpoint. Tries `TRUNCATE` (waits up to the
 * connection's busy timeout for other connections, then reports `busy`) and, if
 * it could not complete, writes back what it can with `PASSIVE`. No row is
 * deleted, the database is not rewritten and no `VACUUM` runs.
 */
export function checkpointWal(
  db: DatabaseSync,
  databasePath: string,
): WalCheckpointResult {
  const walBytesBefore = walBytes(databasePath);
  let row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
  let mode: WalCheckpointResult["mode"] = "truncate";
  const busy = pragmaNumber(row, "busy") === 1;
  if (busy) {
    row = db.prepare("PRAGMA wal_checkpoint(PASSIVE);").get();
    mode = "passive";
  }
  return {
    mode,
    busy,
    walBytesBefore,
    walBytesAfter: walBytes(databasePath),
    logFrames: pragmaNumber(row, "log"),
    checkpointedFrames: pragmaNumber(row, "checkpointed"),
    freelistPages: pragmaNumber(db.prepare("PRAGMA freelist_count;").get(), "freelist_count"),
    pageCount: pragmaNumber(db.prepare("PRAGMA page_count;").get(), "page_count"),
  };
}
