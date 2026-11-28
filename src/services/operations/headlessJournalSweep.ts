import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeNotePath } from "../nativeNoteMoveContract.js";
import { isHeadlessVaultLockBusy, operationDigest } from "./contract.js";
import {
  exchangeProbeName, filesystemJournalPath, filesystemLockDirectory, filesystemOperationId, filesystemPathLock, filesystemProbeLock,
  PathLocks, vaultIdentity,
} from "./filesystemNoteBackend.js";
import { NOTE_REPLACE_TERMINAL_RETENTION_MS, type ObsidianNoteReplacePlan } from "./obsidianNoteReplaceJournal.js";

const terminalRows = `status IN ('committed', 'conflict', 'rejected', 'failed', 'expired')
  AND updated_at < ? AND json_type(payload_json, '$.filesystem') = 'object'
  AND json_extract(payload_json, '$.bindingFingerprint') = ?`;
const operationIdPattern = new RegExp(`^${filesystemOperationId}$`, "u");
const probeMinAgeMs = 24 * 60 * 60 * 1000;
const maxWitnessSize = 5 * 1024 * 1024;

type Row = { operation_id: string; payload_json: string };
type Artifact = { area: "vault" | "state"; name: string; stamp: string };
type Candidate = { kind: "exchange-probe" | "terminal-operation"; path: string; id?: string; rowStamp?: string; files: Artifact[] };
type SweepTarget = { root: string; journal: string; binding: string; cutoff: string; probeCutoff: number };

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function stat(filename: string) {
  try { return lstatSync(filename, { bigint: true }); }
  catch (error) { if (absent(error)) return undefined; throw error; }
}

/** Exact paths only. Do not follow a link in the file or any ancestor. */
function ordinaryDirectory(directory: string) {
  return stat(directory)?.isDirectory() === true && !path.relative(directory, realpathSync.native(directory));
}

function artifactProof(filename: string) {
  const info = stat(filename);
  if (!info?.isFile() || info.nlink !== 1n || info.size > BigInt(maxWitnessSize) ||
      path.relative(filename, realpathSync.native(filename))) return undefined;
  return { info, stamp: [info.dev, info.ino, info.birthtimeNs, info.mtimeNs, info.ctimeNs, info.size].join(":") };
}

function keptHashes(plan: ObsidianNoteReplacePlan) {
  const proof = plan.filesystem!;
  const hashes = [proof.beforeContent, proof.stagedContent].flatMap(bytes => bytes === undefined ? [] : [sha256(bytes)]);
  for (const observed of [proof.displacedObservation, proof.divergentObservation, proof.exchangeRollback]) {
    if (observed && sha256(Buffer.from(observed.bytesBase64, "base64")) === observed.sha256) hashes.push(observed.sha256);
  }
  return new Set(hashes);
}

function terminalCandidate(target: SweepTarget, row: Row): Candidate | undefined {
  const plan = JSON.parse(row.payload_json) as ObsidianNoteReplacePlan;
  const id = row.operation_id;
  if (id !== plan.operationId || !operationIdPattern.test(id) || !plan.filesystem) return;
  const proof = plan.filesystem;
  if (proof.localStage && proof.divergentObservation !== undefined && !proof.witnessesCleaned) return;
  let relative: string;
  try { relative = nativeNotePath(plan.path); } catch { return; }
  const parent = path.dirname(relative);
  const noteDir = path.join(target.root, parent);
  const removedDir = target.journal + ".removed";
  const artifacts: Array<Pick<Artifact, "area" | "name">> = [
    { area: "vault", name: path.join(parent, `.mcp-write-${id}.tmp`) },
    { area: "vault", name: path.join(parent, `.mcp-write-${id}.bak`) },
    { area: "state", name: `${id}.md` },
  ];
  const files: Artifact[] = [];
  const hashes = keptHashes(plan);
  for (const artifact of artifacts) {
    const dir = artifact.area === "vault" ? noteDir : removedDir;
    if (!stat(dir)) continue;
    if (!ordinaryDirectory(dir)) return;
    const filename = artifactPath(target, artifact);
    if (!stat(filename)) continue;
    if (artifact.area === "state" && (plan.projection?.kind !== "obsidian.operation.revert" ||
        plan.projection.proof.restoreAbsence !== true)) return;
    const checked = artifactProof(filename);
    // A terminal row can still own the only surviving copy of an edit. Keep
    // both its files and the row unless every extant witness is duplicated.
    if (!checked || !hashes.has(sha256(readFileSync(filename)))) return;
    files.push({ ...artifact, stamp: checked.stamp });
  }
  return { kind: "terminal-operation", path: relative, id, rowStamp: sha256(row.payload_json), files };
}

function artifactPath(target: SweepTarget, file: Pick<Artifact, "area" | "name">) {
  return path.join(file.area === "vault" ? target.root : target.journal + ".removed", file.name);
}

function probeCandidate(target: SweepTarget, relative: string): Candidate | undefined {
  const filename = path.join(target.root, relative);
  if (!exchangeProbeName.test(path.basename(filename)) || !ordinaryDirectory(path.dirname(filename))) return;
  const checked = artifactProof(filename);
  if (!checked || checked.info.size !== 0n || Number(checked.info.mtimeMs) >= target.probeCutoff) return;
  return { kind: "exchange-probe", path: relative, files: [{ area: "vault", name: relative, stamp: checked.stamp }] };
}

function list(target: SweepTarget, db: DatabaseSync) {
  const candidates: Candidate[] = [];
  const rows = db.prepare(`SELECT operation_id, payload_json FROM obsidian_note_replace_plans
    WHERE ${terminalRows} ORDER BY operation_id`).iterate(target.cutoff, target.binding);
  for (const row of rows) {
    const candidate = terminalCandidate(target, row as Row);
    if (candidate) candidates.push(candidate);
  }
  const directories = [""];
  for (const relative of directories) {
    const directory = path.join(target.root, relative);
    if (!ordinaryDirectory(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) directories.push(name);
      if (entry.isFile() && exchangeProbeName.test(entry.name)) {
        const candidate = probeCandidate(target, name);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path) || (left.id ?? "").localeCompare(right.id ?? ""));
}

function unlinkArtifact(target: SweepTarget, file: Artifact) {
  const filename = artifactPath(target, file);
  const directory = path.dirname(filename);
  if (!ordinaryDirectory(directory) || artifactProof(filename)?.stamp !== file.stamp) {
    throw new Error("The sweep witness changed.");
  }
  unlinkSync(filename);
  if (process.platform !== "win32") {
    const descriptor = openSync(directory, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
}

/** Local operator entry point. An interrupted apply can be previewed again. */
export async function sweepHeadlessJournal(vault: string, journal: string, planDigest?: string, afterUnlink?: () => void) {
  const root = realpathSync.native(vault);
  const journalInfo = stat(journal);
  if (!journalInfo?.isFile() || journalInfo.nlink !== 1n ||
      path.relative(journal, filesystemJournalPath(root, journal))) {
    throw new Error("Expected an existing private headless journal.");
  }
  const now = Date.now();
  const target: SweepTarget = { root, journal, binding: vaultIdentity(root),
    cutoff: new Date(now - NOTE_REPLACE_TERMINAL_RETENTION_MS).toISOString(), probeCutoff: now - probeMinAgeMs };
  const reader = new DatabaseSync(journal, { readOnly: true });
  let candidates: Candidate[];
  try { candidates = list(target, reader); } finally { reader.close(); }
  const digest = operationDigest({ binding: target.binding, journal, candidates });
  if (planDigest === undefined) return {
    mode: "dry-run", planDigest: digest,
    entries: candidates.map(({ kind, path, id, files }) => ({ kind, path, id, files: files.map(({ area, name }) => ({ area, name })) })),
  };
  if (planDigest !== digest) throw new Error("The sweep preview changed. Run --dry-run again.");
  if (!candidates.length) return { mode: "apply", removed: 0, skipped: 0 };
  const locks = new PathLocks(filesystemLockDirectory(root, target.binding));
  const db = new DatabaseSync(journal);
  let removed = 0;
  let skipped = 0;
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL");
    for (const candidate of candidates) {
      const key = candidate.kind === "exchange-probe"
        ? filesystemProbeLock(root, path.dirname(path.join(root, candidate.path)))
        : filesystemPathLock(candidate.path);
      try {
        await locks.run(key, async () => {
          if (vaultIdentity(root) !== target.binding) throw new Error("The vault identity changed.");
          db.exec("BEGIN IMMEDIATE");
          try {
            const row = candidate.id ? db.prepare(`SELECT operation_id, payload_json FROM obsidian_note_replace_plans
              WHERE operation_id = ? AND ${terminalRows}`).get(candidate.id, target.cutoff, target.binding) as Row | undefined : undefined;
            const current = candidate.kind === "exchange-probe" ? probeCandidate(target, candidate.path)
              : row && terminalCandidate(target, row);
            if (!current || operationDigest(current) !== operationDigest(candidate)) {
              skipped += 1;
            } else {
              for (const file of current.files) {
                unlinkArtifact(target, file);
                afterUnlink?.();
              }
              // The row keeps duplicate evidence until every unlink completes.
              if (row) db.prepare("DELETE FROM obsidian_note_replace_plans WHERE operation_id = ?").run(row.operation_id);
              removed += 1;
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }, 0);
      } catch (error) {
        if (!isHeadlessVaultLockBusy(error)) throw error;
        skipped += 1;
      }
    }
    if (removed) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  return { mode: "apply", removed, skipped };
}
