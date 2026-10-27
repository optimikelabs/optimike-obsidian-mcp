import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(path.join(os.tmpdir(), "optimike-wal-test-"));
process.env.OBSIDIAN_API_KEY = "test-no-network";
process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = path.join(root, "vault");
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = path.join(root, "shared-cache.sqlite");
process.env.MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH = path.join(root, "note-replace.sqlite");
process.env.MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH = path.join(root, "base-formula.sqlite");
process.env.MCP_OBSIDIAN_CANVAS_JOURNAL_PATH = path.join(root, "canvas.sqlite");
process.env.MCP_EXTERNAL_MOVE_JOURNAL_PATH = path.join(root, "external-moves.sqlite");
process.env.MCP_SQLITE_JOURNAL_SIZE_LIMIT_MB = "1";

const MiB = 1024 * 1024;
const { config } = await import("../dist/config/index.js");
const { applyWalSizeLimit, checkpointWal } = await import("../dist/services/sqliteWal.js");
const { projectPublicRuntimeMaintenanceResult, runRuntimeMaintenance } = await import(
  "../dist/services/runtimeState.js"
);

try {
  // The limit is configurable and defaults to 64 MiB.
  assert.equal(config.sqliteJournalSizeLimitBytes, 1 * MiB);

  const walSize = (file) =>
    existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0;
  function grownWal(name, limitBytes) {
    const file = path.join(root, name);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    applyWalSizeLimit(db, limitBytes);
    db.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)");
    // One large transaction: the WAL reaches several MiB before it can restart.
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO blobs (payload) VALUES (?)");
    for (let i = 0; i < 8; i += 1) insert.run(Buffer.alloc(MiB, i));
    db.exec("COMMIT");
    return { db, file };
  }

  // Without a limit the WAL keeps its high-water mark after the log restarts.
  const unlimited = grownWal("unlimited.sqlite", 0);
  assert.ok(walSize(unlimited.file) > 4 * MiB, "the WAL grew");
  unlimited.db.prepare("PRAGMA wal_checkpoint(PASSIVE);").get();
  unlimited.db.prepare("INSERT INTO blobs (payload) VALUES (x'00')").run();
  const unlimitedSize = walSize(unlimited.file);
  assert.ok(unlimitedSize > 4 * MiB, "no limit: the file stays at its high-water mark");

  // With journal_size_limit it is truncated once the log restarts.
  const limited = grownWal("limited.sqlite", MiB);
  limited.db.prepare("PRAGMA wal_checkpoint(PASSIVE);").get();
  limited.db.prepare("INSERT INTO blobs (payload) VALUES (x'00')").run();
  assert.ok(
    walSize(limited.file) <= MiB + 64 * 1024,
    `limit applied: ${walSize(limited.file)} bytes`,
  );
  assert.equal(
    limited.db.prepare("SELECT COUNT(*) AS n FROM blobs").get().n,
    9,
    "no committed row is lost",
  );
  unlimited.db.close();
  limited.db.close();

  // Safe checkpoint: a reader that pins the log makes it report busy, not fail or lose data.
  const target = path.join(root, "pinned.sqlite");
  const writer = new DatabaseSync(target);
  writer.exec("PRAGMA journal_mode = WAL;");
  writer.exec("PRAGMA busy_timeout = 50;");
  writer.exec("PRAGMA wal_autocheckpoint = 0;");
  writer.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)");
  writer.prepare("INSERT INTO blobs (payload) VALUES (?)").run(Buffer.alloc(MiB));
  const reader = new DatabaseSync(target);
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM blobs").get(); // pins the current snapshot
  writer.prepare("INSERT INTO blobs (payload) VALUES (?)").run(Buffer.alloc(MiB));
  const blocked = checkpointWal(writer, target);
  assert.equal(blocked.mode, "passive");
  assert.equal(blocked.busy, true);
  assert.ok(blocked.walBytesBefore > 0);
  reader.exec("COMMIT");
  reader.close();
  const done = checkpointWal(writer, target);
  assert.equal(done.mode, "truncate");
  assert.equal(done.busy, false);
  assert.equal(done.walBytesAfter, 0, "the WAL file is emptied");
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM blobs").get().n, 2);
  writer.close();

  // The maintenance action goes through the public projection: numbers and one fixed label only.
  const maintenance = await runRuntimeMaintenance("checkpoint_wal", {
    runWalCheckpoint: () => ({
      ...done,
      dbPath: "C:/secret/shared-cache.sqlite",
      note: "must not leak",
    }),
  });
  const projected = projectPublicRuntimeMaintenanceResult("checkpoint_wal", maintenance);
  assert.deepEqual(Object.keys(projected), ["action", "sharedCache"]);
  assert.deepEqual(Object.keys(projected.sharedCache).sort(), [
    "busy",
    "checkpointedFrames",
    "freelistPages",
    "logFrames",
    "mode",
    "pageCount",
    "walBytesAfter",
    "walBytesBefore",
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /secret|leak|sqlite/u);

  // Without a vault cache service the action is unavailable, like the other cache actions.
  await assert.rejects(() => runRuntimeMaintenance("checkpoint_wal", undefined));

  console.log("PASS WAL size limit and non-destructive checkpoint maintenance");
} finally {
  rmSync(root, { recursive: true, force: true });
}
