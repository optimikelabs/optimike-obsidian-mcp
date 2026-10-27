import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const {
  listForeignJournals,
  moveJournalCandidates,
  summarizeJournalInventory,
} = await import("../dist/services/operations/journalHygiene.js");

const root = mkdtempSync(path.join(os.tmpdir(), "optimike-journal-hygiene-test-"));
const scanLeftovers = () =>
  readdirSync(os.tmpdir()).filter((name) => name.startsWith("optimike-journal-scan-"));
const leftoversBefore = scanLeftovers().length;

const SCHEMA = `CREATE TABLE IF NOT EXISTS obsidian_note_replace_plans (
  operation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;

function journal(directory, name, statuses, ageDays = 30) {
  const file = path.join(directory, name);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  statuses.forEach((status, index) => {
    db.prepare(
      "INSERT INTO obsidian_note_replace_plans VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`op-${name}-${index}`, `key-${name}-${index}`, status, '{"secret":"note body"}', "2026-01-01", "2026-01-01");
  });
  db.close();
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(file, when, when);
  return file;
}

const hashTree = (directory) =>
  Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [
        name,
        createHash("sha256").update(readFileSync(path.join(directory, name))).digest("hex"),
      ]),
  );

try {
  const state = path.join(root, "state");
  mkdirSync(state);
  const current = journal(state, "obsidian-note-replace-aaaaaaaaaaaaaaaa.sqlite", ["planned"]);
  journal(state, "obsidian-note-replace-bbbbbbbbbbbbbbbb.sqlite", []);
  journal(state, "obsidian-canvas-cccccccccccccccc.sqlite", ["committed", "failed"]);
  journal(state, "obsidian-base-formula-dddddddddddddddd.sqlite", ["committed", "outcome_unknown"]);
  journal(state, "obsidian-note-replace-eeeeeeeeeeeeeeee.sqlite", ["committed"], 1); // recent
  journal(state, "obsidian-note-replace-ffffffffffffffff.sqlite", ["mystery_status"]);
  writeFileSync(path.join(state, "obsidian-note-replace-0000000000000000.sqlite"), "not a database");
  writeFileSync(path.join(state, "external-moves.sqlite"), "ignored: not a note journal");
  // A journal whose latest row only lives in the WAL (never checkpointed).
  const live = path.join(state, "obsidian-note-replace-1111111111111111.sqlite");
  const walDb = new DatabaseSync(live);
  walDb.exec("PRAGMA journal_mode=WAL");
  walDb.exec("PRAGMA wal_autocheckpoint=0");
  walDb.exec(SCHEMA);
  walDb.prepare("INSERT INTO obsidian_note_replace_plans VALUES ('w','wk','applying','{}','x','x')").run();
  const snapshot = path.join(state, "wal-snapshot");
  mkdirSync(snapshot);
  copyFileSync(live, path.join(snapshot, path.basename(live)));
  copyFileSync(`${live}-wal`, path.join(snapshot, `${path.basename(live)}-wal`));
  walDb.close();
  rmSync(live, { force: true });
  rmSync(`${live}-wal`, { force: true });
  rmSync(`${live}-shm`, { force: true });
  copyFileSync(path.join(snapshot, path.basename(live)), live);
  copyFileSync(path.join(snapshot, `${path.basename(live)}-wal`), `${live}-wal`);
  rmSync(snapshot, { recursive: true, force: true });
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(live, old, old);

  const before = hashTree(state);
  const scan = { directory: state, currentJournalPaths: [current] };
  const found = listForeignJournals(scan);
  const by = Object.fromEntries(found.map((item) => [item.fileName, item]));

  assert.equal(by["obsidian-note-replace-aaaaaaaaaaaaaaaa.sqlite"], undefined, "the running journal is never listed");
  assert.equal(by["external-moves.sqlite"], undefined, "only note/base/canvas journals are inventoried");
  assert.equal(by["obsidian-note-replace-bbbbbbbbbbbbbbbb.sqlite"].state, "empty");
  assert.equal(by["obsidian-note-replace-bbbbbbbbbbbbbbbb.sqlite"].moveCandidate, true);
  assert.equal(by["obsidian-canvas-cccccccccccccccc.sqlite"].state, "terminal_only");
  assert.equal(by["obsidian-canvas-cccccccccccccccc.sqlite"].family, "canvas");
  assert.equal(by["obsidian-canvas-cccccccccccccccc.sqlite"].moveCandidate, true);
  const unknown = by["obsidian-base-formula-dddddddddddddddd.sqlite"];
  assert.equal(unknown.state, "has_non_terminal");
  assert.equal(unknown.nonTerminalCount, 1);
  assert.equal(unknown.moveCandidate, false);
  assert.equal(by["obsidian-note-replace-eeeeeeeeeeeeeeee.sqlite"].moveCandidate, false, "recent files are protected");
  assert.equal(by["obsidian-note-replace-ffffffffffffffff.sqlite"].state, "has_non_terminal", "an unrecognised status counts as non-terminal");
  assert.equal(by["obsidian-note-replace-0000000000000000.sqlite"].state, "unreadable");
  assert.equal(by["obsidian-note-replace-0000000000000000.sqlite"].moveCandidate, false);
  assert.equal(by["obsidian-note-replace-1111111111111111.sqlite"].state, "has_non_terminal", "rows that only live in the WAL are seen");

  const summary = summarizeJournalInventory(found);
  assert.equal(summary.total, 7);
  assert.equal(summary.moveCandidates, 2);
  assert.equal(summary.unreadable, 1);

  // Reports counts and names only, never stored content.
  assert.doesNotMatch(JSON.stringify(found), /note body|secret|op-obsidian|key-obsidian/u);

  // Listing changed nothing and left no scratch copy behind.
  assert.deepEqual(hashTree(state), before, "listing must not modify any journal");
  assert.equal(scanLeftovers().length, leftoversBefore, "scratch copies are removed");

  // Moving is reversible, never deletes, and re-checks right before moving.
  const aside = path.join(root, "aside");
  const moved = moveJournalCandidates({ ...scan, destination: aside });
  assert.deepEqual(moved.moved.sort(), [
    "obsidian-canvas-cccccccccccccccc.sqlite",
    "obsidian-note-replace-bbbbbbbbbbbbbbbb.sqlite",
  ]);
  assert.ok(existsSync(path.join(aside, "obsidian-canvas-cccccccccccccccc.sqlite")));
  assert.ok(!existsSync(path.join(state, "obsidian-canvas-cccccccccccccccc.sqlite")));
  assert.ok(existsSync(path.join(state, "obsidian-note-replace-eeeeeeeeeeeeeeee.sqlite")));
  assert.ok(existsSync(path.join(state, "obsidian-base-formula-dddddddddddddddd.sqlite")));

  // CLI: refuses to guess the running profile, lists by default and deletes nothing.
  const cli = path.resolve("scripts/list-foreign-journals.mjs");
  const run = (args, env = {}) =>
    execFileSync(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.throws(
    () => run(["--directory", state]),
    (error) => error.status === 2 && /Cannot tell which journals are in use/u.test(error.stderr),
  );
  const stateBeforeCli = hashTree(state);
  const output = JSON.parse(run(["--directory", state, "--current", current, "--json"]));
  assert.equal(output.summary.total, 5);
  assert.equal(output.moved, undefined);
  assert.deepEqual(hashTree(state), stateBeforeCli, "the CLI is read-only by default");
  assert.throws(() => run(["--apply", "--directory", state, "--current", current]), /--apply only makes sense/u);

  console.log("PASS foreign journal inventory is read-only, protects live and non-terminal journals, and moving is reversible");
} finally {
  rmSync(root, { recursive: true, force: true });
}
