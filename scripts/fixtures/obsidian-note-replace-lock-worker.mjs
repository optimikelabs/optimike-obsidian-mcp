import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const rawConfig = process.env.OBSIDIAN_NOTE_REPLACE_LOCK_WORKER;
if (!rawConfig) throw new Error("Missing journal lock worker configuration.");

const config = JSON.parse(rawConfig);
const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA busy_timeout=5000");
db.exec("BEGIN IMMEDIATE");
writeFileSync(config.readyPath, "ready", "utf8");

while (!existsSync(config.releasePath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

try {
  db.exec("COMMIT");
  process.stdout.write('{"ok":true}\n');
} finally {
  db.close();
}
