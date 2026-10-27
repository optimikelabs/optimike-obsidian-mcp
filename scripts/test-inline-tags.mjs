import "./lib/isolated-state.mjs";
import assert from "node:assert/strict";

process.env.OBSIDIAN_API_KEY = "test-no-network";
process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT ??= process.cwd();

const { extractInlineTags, normalizeInlineTagCandidate } = await import(
  "../dist/services/markdownTags.js"
);
const { extractMarkdownTags } = await import(
  "../dist/services/vaultFileService.js"
);
const { validateObsidianMarkdown } = await import(
  "../dist/services/obsidianFormatService.js"
);
const { processObsidianReadNote, ObsidianReadNoteInputSchema } = await import(
  "../dist/mcp-server/tools/obsidianReadNoteTool/logic.js"
);

const sorted = (tags) => [...tags].sort();

// Pull-request numbers are not tags: Obsidian needs a non-numerical character.
assert.deepEqual(extractInlineTags("Voir #107/ #113/ #114/ et #1984."), []);
assert.deepEqual(extractInlineTags("PR #1, #2, #3\n#17"), []);
assert.deepEqual(extractInlineTags("(#113)"), []);

// Valid tags stay valid, including nesting, hyphen, underscore and Unicode.
assert.deepEqual(
  sorted(
    extractInlineTags(
      "#seo #digital-prod #Super_Invite #projet/2026 #2026/q1 #y1984 #stratégie-de-contenu #RÔLE #✅",
    ),
  ),
  sorted([
    "seo",
    "digital-prod",
    "Super_Invite",
    "projet/2026",
    "2026/q1",
    "y1984",
    "stratégie-de-contenu",
    "RÔLE",
    "✅",
  ]),
);

// A trailing slash is punctuation; empty nesting segments are refused.
assert.deepEqual(extractInlineTags("#projet/ et #a//b et #/x"), ["projet"]);
assert.equal(normalizeInlineTagCandidate("107/"), undefined);
assert.equal(normalizeInlineTagCandidate("a/"), "a");

// Boundaries: start of line, whitespace, opening bracket; never mid-word or URL.
assert.deepEqual(
  sorted(
    extractInlineTags(
      "#debut\ntexte (#entre) [#crochet] https://exemple.fr/#ancre mot#colle\n## Titre",
    ),
  ),
  sorted(["debut", "entre", "crochet"]),
);

// Code is not prose: fenced blocks, tilde fences and inline spans are ignored.
assert.deepEqual(
  extractInlineTags(
    [
      "#hors-code",
      "```css",
      "a { color: #F5B800; } #dans-bloc",
      "```",
      "~~~",
      "#dans-tilde",
      "~~~",
      "Voir `#dans-span` puis ``#double`` et #apres",
    ].join("\n"),
  ),
  ["hors-code", "apres"],
);
// An unmatched backtick leaves the rest as prose.
assert.deepEqual(extractInlineTags("un ` seul #reste"), ["reste"]);

// Shared extractor: body tags and frontmatter tags are merged, deduplicated.
const note =
  "---\ntags:\n  - seo\n  - projet/x\n---\nTexte #seo #113/ #nouveau `#code`\n";
const extracted = extractMarkdownTags(note);
assert.deepEqual(extracted.inlineTags, ["nouveau", "seo"]);
assert.deepEqual(extracted.allTags, ["nouveau", "projet/x", "seo"]);

// Validator: numeric pull-request references raise no tag warning, accented tags neither.
const validated = validateObsidianMarkdown(
  "Voir #107/ #113/ et #stratégie-de-contenu #RÔLE\n",
);
assert.equal(
  validated.warnings.filter((issue) => issue.code === "tag-syntax").length,
  0,
);

// read_note (json, cache path) returns the same tags.
const content =
  "---\ntags: [seo]\n---\n## Lecture\n\nPR #107/ #113/ #114/ #1984, tags #projet/x #stratégie `#code`\n```\n#bloc\n```\n";
const stat = { ctime: 1700000000000, mtime: 1700000000000, size: content.length };
const cache = {
  isReady: () => true,
  findMatchingPath: (path) => path,
  getEntry: async () => ({ content, ...stat }),
};
const context = {
  requestId: "inline-tags-test",
  timestamp: new Date().toISOString(),
  operation: "test",
};
const out = await processObsidianReadNote(
  ObsidianReadNoteInputSchema.parse({ filePath: "Test.md", format: "json" }),
  context,
  undefined,
  cache,
);
assert.deepEqual(sorted(out.content.tags), sorted(["seo", "projet/x", "stratégie"]));

console.log("PASS inline tags follow Obsidian rules (numeric, nesting, Unicode, code)");
