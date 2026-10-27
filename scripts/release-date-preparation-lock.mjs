#!/usr/bin/env node
// Manual release of a date_preparation_unverified lock, for when
// obsidian_operation_close cannot be used (Bridge without effect fence, or
// unreachable for good). Safe only while Obsidian AND every MCP process are
// stopped: no Bridge handler and no executor can then act on the note.
//
//   node scripts/release-date-preparation-lock.mjs --journal <journal.sqlite> --list [--path <note.md>]
//   node scripts/release-date-preparation-lock.mjs --journal <journal.sqlite> --release <targetDigest> --confirm
//        [--rest-port 27123] [--backend-port 3012]
//
// The script refuses while either local port answers, records a manual review
// row and deletes the exact lock in one transaction. It never reads a note.
import { existsSync } from "node:fs";
import net from "node:net";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function option(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b)).map((key) => [key, canonical(value[key])]));
  }
  return value;
}
// Same digest as operationDigest() in src/services/operations/contract.ts.
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
const portAnswers = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port, timeout: 1_000 });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

const journal = option("--journal");
if (!journal || !existsSync(journal)) {
  console.error("Usage: --journal <existing journal.sqlite> (--list [--path note.md] | --release <targetDigest> --confirm)");
  process.exit(2);
}

if (process.argv.includes("--list")) {
  const db = new DatabaseSync(journal, { readOnly: true });
  try {
    const locks = db.prepare("SELECT target_digest AS targetDigest, attempt_id AS attemptId, created_at AS createdAt FROM obsidian_date_preparation_fences ORDER BY created_at").all();
    const notePath = option("--path");
    let matches = [];
    if (notePath) {
      // The lock stores only a digest of (path, Bridge binding). Try every binding the journal saw.
      const bindings = db.prepare("SELECT DISTINCT json_extract(payload_json, '$.bindingFingerprint') AS binding FROM obsidian_note_replace_plans").all()
        .map((row) => row.binding).filter((value) => typeof value === "string");
      const candidates = new Set(bindings.map((bindingFingerprint) => digest({ domain: "obsidian-date-preparation-v1", path: notePath, bindingFingerprint })));
      matches = locks.filter((lock) => candidates.has(lock.targetDigest)).map((lock) => lock.targetDigest);
    }
    console.log(JSON.stringify({ locks, ...(notePath ? { matchingPath: matches } : {}) }, null, 2));
  } finally { db.close(); }
  process.exit(0);
}

const target = option("--release");
if (!target || !/^[a-f0-9]{64}$/u.test(target) || !process.argv.includes("--confirm")) {
  console.error("Refused: --release <64-hex targetDigest> and --confirm are required.");
  process.exit(2);
}
const ports = [Number(option("--rest-port") ?? 27123), Number(option("--backend-port") ?? 3012)];
for (const port of ports) {
  if (await portAnswers(port)) {
    console.error(`Refused: 127.0.0.1:${port} answers. Quit Obsidian completely and stop the MCP backend and clients first.`);
    process.exit(3);
  }
}
const db = new DatabaseSync(journal);
try {
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("BEGIN IMMEDIATE");
  const lock = db.prepare("SELECT attempt_id, created_at FROM obsidian_date_preparation_fences WHERE target_digest = ?").get(target);
  if (!lock) {
    db.exec("ROLLBACK");
    console.log(JSON.stringify({ result: "not_locked", targetDigest: target }));
    process.exit(0);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS obsidian_date_preparation_fence_reviews (
    target_digest TEXT NOT NULL, attempt_id TEXT NOT NULL, created_at TEXT NOT NULL,
    reviewed_at TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY (target_digest, attempt_id))`);
  const evidence = { contractVersion: 1, closedAt: new Date().toISOString(), reasonCode: "manual_offline_review",
    previousState: "date_preparation_unverified", guarantee: "no_further_effect", priorEffect: "unknown",
    proof: { obsidianStopped: true, backendStopped: true, checkedPorts: ports } };
  db.prepare("INSERT INTO obsidian_date_preparation_fence_reviews (target_digest, attempt_id, created_at, reviewed_at, evidence_json) VALUES (?, ?, ?, ?, ?)")
    .run(target, lock.attempt_id, lock.created_at, evidence.closedAt, JSON.stringify(evidence));
  db.prepare("DELETE FROM obsidian_date_preparation_fences WHERE target_digest = ? AND attempt_id = ?").run(target, lock.attempt_id);
  db.exec("COMMIT");
  console.log(JSON.stringify({ result: "released", targetDigest: target, evidence }, null, 2));
} catch (error) {
  try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
  throw error;
} finally { db.close(); }
