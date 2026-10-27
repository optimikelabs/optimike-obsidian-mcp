import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Read-only inventory of durable operation journals that belong to a profile
 * other than the running one.
 *
 * A journal file is created per profile (`sha256({mode, baseUrl, vault})`), so
 * trials and test runs against temporary vaults leave one file each. This module
 * only observes: it never opens an original journal (the database and its WAL are
 * copied to a private temporary directory first, so reading cannot create,
 * checkpoint or modify anything beside it) and it never deletes. Moving
 * candidates away is a separate, explicit, reversible step.
 *
 * It reports counts and file names only. It never returns plan content, paths
 * inside a vault, idempotency keys or note text.
 */

export type JournalFamily = "note-replace" | "base-formula" | "canvas";

/** Statuses after which a journal row needs no further action. */
const TERMINAL_STATUSES = new Set([
  "committed",
  "conflict",
  "rejected",
  "failed",
  "expired",
  "reviewed_unverified",
]);

export type JournalInspectionState =
  /** Readable, no plan row at all. */
  | "empty"
  /** Readable, every plan row is terminal. */
  | "terminal_only"
  /** At least one `planned`, `applying`, `outcome_unknown` or unrecognised row. */
  | "has_non_terminal"
  /** Could not be copied or read; treat as in use. */
  | "unreadable";

export type JournalInspection = {
  family: JournalFamily;
  profileId: string;
  fileName: string;
  /** Size of the database file plus its `-wal` and `-shm` companions. */
  bytes: number;
  modifiedAt: string;
  state: JournalInspectionState;
  planCount: number;
  nonTerminalCount: number;
  /** Row counts by status; status names come from the journal's closed vocabulary. */
  statusCounts: Record<string, number>;
  /** Not the running profile, readable, no non-terminal row, and not modified recently. */
  moveCandidate: boolean;
};

export type ListForeignJournalsOptions = {
  /** Directory holding the journals (the runtime state directory). */
  directory: string;
  /** Absolute paths of the journals the running process uses; never reported as foreign. */
  currentJournalPaths: string[];
  /** Files modified within this window are never move candidates (another profile may be live). */
  minAgeMs?: number;
  now?: () => number;
};

const JOURNAL_FILE = /^obsidian-(note-replace|base-formula|canvas)-([A-Za-z0-9._-]+)\.sqlite$/u;
const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_NAME = /^[a-z_]{1,40}$/u;

function sameFile(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function companionBytes(databasePath: string): number {
  let bytes = 0;
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    if (existsSync(candidate)) bytes += statSync(candidate).size;
  }
  return bytes;
}

function readStatusCounts(databasePath: string): Record<string, number> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "optimike-journal-scan-"));
  try {
    const copy = path.join(scratch, "journal.sqlite");
    copyFileSync(databasePath, copy);
    // The WAL holds committed rows not yet checkpointed; read it from the copy.
    if (existsSync(`${databasePath}-wal`)) {
      copyFileSync(`${databasePath}-wal`, `${copy}-wal`);
    }
    const db = new DatabaseSync(copy);
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'obsidian_note_replace_plans'",
        )
        .get();
      if (!table) return {};
      const counts: Record<string, number> = {};
      for (const row of db
        .prepare(
          "SELECT status, COUNT(*) AS count FROM obsidian_note_replace_plans GROUP BY status",
        )
        .all() as Array<{ status: unknown; count: unknown }>) {
        // An unrecognised status is counted under a fixed label: never echo stored text.
        const status =
          typeof row.status === "string" && STATUS_NAME.test(row.status)
            ? row.status
            : "unrecognized";
        counts[status] = (counts[status] ?? 0) + Number(row.count);
      }
      return counts;
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function listForeignJournals(
  options: ListForeignJournalsOptions,
): JournalInspection[] {
  const now = options.now ?? Date.now;
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  if (!existsSync(options.directory)) return [];
  const inspections: JournalInspection[] = [];
  for (const fileName of readdirSync(options.directory).sort()) {
    const match = JOURNAL_FILE.exec(fileName);
    if (!match) continue;
    const databasePath = path.join(options.directory, fileName);
    if (options.currentJournalPaths.some((current) => sameFile(current, databasePath))) {
      continue;
    }
    const stats = statSync(databasePath);
    let statusCounts: Record<string, number> = {};
    let state: JournalInspectionState = "unreadable";
    let readable = false;
    try {
      statusCounts = readStatusCounts(databasePath);
      readable = true;
    } catch {
      statusCounts = {};
    }
    const planCount = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const nonTerminalCount = Object.entries(statusCounts).reduce(
      (sum, [status, count]) =>
        TERMINAL_STATUSES.has(status) ? sum : sum + count,
      0,
    );
    if (readable) {
      state =
        planCount === 0
          ? "empty"
          : nonTerminalCount === 0
            ? "terminal_only"
            : "has_non_terminal";
    }
    inspections.push({
      family: match[1] as JournalFamily,
      profileId: match[2],
      fileName,
      bytes: companionBytes(databasePath),
      modifiedAt: stats.mtime.toISOString(),
      state,
      planCount,
      nonTerminalCount,
      statusCounts,
      moveCandidate:
        (state === "empty" || state === "terminal_only") &&
        now() - stats.mtimeMs >= minAgeMs,
    });
  }
  return inspections;
}

export type MoveCandidatesResult = {
  moved: string[];
  skipped: string[];
};

/**
 * Moves the candidates (database, `-wal`, `-shm`) into `destination`; nothing is
 * deleted and the move can be undone by moving the files back. The inspection is
 * repeated immediately before each move so a journal that gained a plan since the
 * listing is left in place.
 */
export function moveJournalCandidates(
  options: ListForeignJournalsOptions & { destination: string },
): MoveCandidatesResult {
  const fresh = listForeignJournals(options);
  mkdirSync(options.destination, { recursive: true });
  const result: MoveCandidatesResult = { moved: [], skipped: [] };
  for (const inspection of fresh) {
    if (!inspection.moveCandidate) {
      result.skipped.push(inspection.fileName);
      continue;
    }
    const source = path.join(options.directory, inspection.fileName);
    const target = path.join(options.destination, inspection.fileName);
    if (existsSync(target)) {
      result.skipped.push(inspection.fileName);
      continue;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${source}${suffix}`)) {
        renameSync(`${source}${suffix}`, `${target}${suffix}`);
      }
    }
    result.moved.push(inspection.fileName);
  }
  return result;
}

export type JournalInventorySummary = {
  total: number;
  withNonTerminal: number;
  terminalOnlyOrEmpty: number;
  unreadable: number;
  moveCandidates: number;
  bytes: number;
  moveCandidateBytes: number;
};

export function summarizeJournalInventory(
  inspections: JournalInspection[],
): JournalInventorySummary {
  return {
    total: inspections.length,
    withNonTerminal: inspections.filter((i) => i.state === "has_non_terminal")
      .length,
    terminalOnlyOrEmpty: inspections.filter(
      (i) => i.state === "empty" || i.state === "terminal_only",
    ).length,
    unreadable: inspections.filter((i) => i.state === "unreadable").length,
    moveCandidates: inspections.filter((i) => i.moveCandidate).length,
    bytes: inspections.reduce((sum, i) => sum + i.bytes, 0),
    moveCandidateBytes: inspections
      .filter((i) => i.moveCandidate)
      .reduce((sum, i) => sum + i.bytes, 0),
  };
}
