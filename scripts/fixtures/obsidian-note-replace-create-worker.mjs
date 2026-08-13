import { existsSync, writeFileSync } from "node:fs";
import { ObsidianNoteReplaceJournal } from "../../dist/services/operations/obsidianNoteReplaceJournal.js";

const rawConfig = process.env.OBSIDIAN_NOTE_REPLACE_CREATE_WORKER;
if (!rawConfig) throw new Error("Missing journal create worker configuration.");

const config = JSON.parse(rawConfig);
const journal = new ObsidianNoteReplaceJournal(config.databasePath);
const originalLookup = journal.getByIdempotencyKey.bind(journal);
let barrierReached = false;

journal.getByIdempotencyKey = (key) => {
  const existing = originalLookup(key);
  if (existing || barrierReached) return existing;
  barrierReached = true;
  writeFileSync(config.readyPath, "ready", "utf8");
  while (!existsSync(config.startPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return undefined;
};

try {
  const plan = journal.create(config.input);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} finally {
  journal.close();
}
