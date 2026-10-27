#!/usr/bin/env node
// Read-only inventory of durable operation journals that belong to another
// profile than the running one (see docs/journal-hygiene.md).
//
//   node scripts/list-foreign-journals.mjs [--directory <dir>] [--current <journal.sqlite>]...
//                                          [--min-age-days 7] [--json]
//                                          [--move-candidates-to <dir> --apply]
//
// Default: lists and deletes nothing. Moving candidates (never deleting) requires
// both --move-candidates-to and --apply; moving the files back undoes it.
import path from "node:path";
import process from "node:process";

function parse(argv) {
  const options = { current: [], json: false, apply: false, minAgeDays: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === "--directory") options.directory = path.resolve(value());
    else if (arg === "--current") options.current.push(path.resolve(value()));
    else if (arg === "--min-age-days") options.minAgeDays = Number(value());
    else if (arg === "--move-candidates-to") options.moveTo = path.resolve(value());
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.minAgeDays) || options.minAgeDays < 0) {
    throw new Error("--min-age-days must be a non-negative number.");
  }
  if (options.apply && !options.moveTo) {
    throw new Error("--apply only makes sense with --move-candidates-to.");
  }
  return options;
}

const options = parse(process.argv.slice(2));

if (options.current.length === 0) {
  // The running profile is derived from the same environment as the backend
  // (OBSIDIAN_RUNTIME_MODE, OBSIDIAN_BASE_URL, OBSIDIAN_VAULT, or the explicit
  // journal path variables). Without it the script cannot know which journals
  // are in use, so it refuses instead of guessing.
  if (!process.env.OBSIDIAN_VAULT && !process.env.MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH) {
    console.error(
      "Cannot tell which journals are in use: run with the backend's environment (OBSIDIAN_VAULT, OBSIDIAN_BASE_URL, OBSIDIAN_RUNTIME_MODE) or pass --current <journal.sqlite> for each journal in use.",
    );
    process.exit(2);
  }
  const { config } = await import("../dist/config/index.js");
  options.current = [
    config.obsidianNoteReplaceJournalPath,
    config.obsidianBaseFormulaJournalPath,
    config.obsidianCanvasJournalPath,
  ];
  options.directory ??= path.dirname(config.obsidianNoteReplaceJournalPath);
}
if (!options.directory) {
  options.directory = path.dirname(options.current[0]);
}

const { listForeignJournals, moveJournalCandidates, summarizeJournalInventory } =
  await import("../dist/services/operations/journalHygiene.js");

const scan = {
  directory: options.directory,
  currentJournalPaths: options.current,
  minAgeMs: options.minAgeDays * 24 * 60 * 60 * 1000,
};
const inspections = listForeignJournals(scan);
const summary = summarizeJournalInventory(inspections);
let moved;
if (options.moveTo && options.apply) {
  moved = moveJournalCandidates({ ...scan, destination: options.moveTo });
}

if (options.json) {
  console.log(JSON.stringify({ summary, inspections, moved }, null, 2));
} else {
  console.log(`Foreign-profile journals in ${options.directory}`);
  console.log(
    `${summary.total} found: ${summary.withNonTerminal} with non-terminal operations (kept), ` +
      `${summary.terminalOnlyOrEmpty} empty or terminal-only, ${summary.unreadable} unreadable; ` +
      `${summary.moveCandidates} move candidate(s), ${(summary.moveCandidateBytes / 1024 / 1024).toFixed(1)} MiB ` +
      `of ${(summary.bytes / 1024 / 1024).toFixed(1)} MiB.`,
  );
  for (const inspection of inspections.filter((i) => i.state === "has_non_terminal")) {
    console.log(
      `  KEEP  ${inspection.fileName}  ${inspection.nonTerminalCount} non-terminal of ${inspection.planCount}  modified ${inspection.modifiedAt}`,
    );
  }
  if (moved) {
    console.log(`Moved ${moved.moved.length} journal(s) to ${options.moveTo}; skipped ${moved.skipped.length}. Nothing was deleted.`);
  } else if (summary.moveCandidates > 0) {
    console.log(
      "Dry run: nothing was moved or deleted. To move the candidates aside (reversible), add --move-candidates-to <dir> --apply.",
    );
  }
}
