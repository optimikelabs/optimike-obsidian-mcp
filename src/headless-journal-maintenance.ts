import { config } from "./config/index.js";
import { defaultFilesystemJournal, filesystemJournalPath } from "./services/operations/filesystemNoteBackend.js";
import { sweepHeadlessJournal } from "./services/operations/headlessJournalSweep.js";

async function main() {
  const [action, digest, ...extra] = process.argv.slice(2);
  if (extra.length || !(action === "--dry-run" && digest === undefined ||
    action === "--apply" && digest !== undefined && /^[a-f0-9]{64}$/u.test(digest))) {
    throw new Error("Use --dry-run first, then --apply with the returned planDigest.");
  }
  const vault = config.obsidianVaultPath;
  if (!vault || !["headless-guarded", "headless-filesystem"].includes(config.obsidianRuntimeMode)) {
    throw new Error("The sweep requires a configured writable headless runtime.");
  }
  const journal = config.headlessGovernedJournalPath
    ? filesystemJournalPath(vault, config.headlessGovernedJournalPath)
    : defaultFilesystemJournal(vault);
  console.log(JSON.stringify(await sweepHeadlessJournal(vault, journal, digest), null, 2));
}

main().catch(error => {
  // OS and SQLite errors can contain absolute paths.
  console.error(error instanceof Error && error.message === "The sweep preview changed. Run --dry-run again."
    ? error.message
    : "Headless journal sweep failed. Check the local configuration and run --dry-run again before applying.");
  process.exitCode = 1;
});
