import { existsSync, writeFileSync } from "node:fs";
import { ObsidianNoteReplaceJournal } from "../../dist/services/operations/obsidianNoteReplaceJournal.js";

const rawConfig = process.env.OBSIDIAN_NOTE_REPLACE_OPEN_WORKER;
if (!rawConfig) throw new Error("Missing journal open worker configuration.");

const config = JSON.parse(rawConfig);
writeFileSync(config.readyPath, "ready", "utf8");
while (!existsSync(config.startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

const journal = new ObsidianNoteReplaceJournal(config.databasePath);
journal.close();
process.stdout.write('{"ok":true}\n');
