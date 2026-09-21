import assert from "node:assert/strict";
import {
  OBSIDIAN_NOTE_LINKS_DEFAULT_LIMIT,
  ObsidianNoteLinksInputSchema,
  processObsidianNoteLinks,
} from "../dist/mcp-server/tools/obsidianNoteLinksTool/logic.js";

const parsed = ObsidianNoteLinksInputSchema.parse({
  filePath: "GQM26/Source.md",
});
assert.equal(parsed.limit, OBSIDIAN_NOTE_LINKS_DEFAULT_LIMIT);
assert.throws(() =>
  ObsidianNoteLinksInputSchema.parse({
    filePath: "GQM26/Source.md",
    limit: 1001,
  }),
);

const calls = [];
const response = {
  ok: true,
  contractVersion: 1,
  path: "GQM26/Source.md",
  backend: {
    kind: "obsidian-metadata-cache",
    bindingFingerprint: "a".repeat(64),
  },
  cache: {
    available: true,
    consistency: "best_effort_non_atomic_snapshot",
    freshness: {
      status: "unknown",
      observedAt: "2026-09-20T00:00:00.000Z",
      observedFileMtimeMs: 1,
      reason: "public_metadata_cache_exposes_no_cache_timestamp",
    },
  },
  provenance: {
    sourceMetadata: "metadataCache.getFileCache",
    resolution: "metadataCache.getFirstLinkpathDest",
    subpath: "resolveSubpath",
    backlinks: "metadataCache.resolvedLinks",
    unresolved: "metadataCache.unresolvedLinks",
  },
  outgoing: [],
  unresolved: [],
  backlinks: [],
  coverage: {
    outgoing: {
      available: true,
      total: 0,
      returned: 0,
      truncated: false,
    },
    unresolved: {
      available: true,
      total: 0,
      returned: 0,
      truncated: false,
    },
    backlinks: {
      available: true,
      total: 0,
      returned: 0,
      truncated: false,
    },
  },
};

const fakeService = {
  async readNoteLinks(payload) {
    calls.push(payload);
    return response;
  },
};

const actual = await processObsidianNoteLinks(
  { filePath: "GQM26/Source.md", limit: 17 },
  { requestId: "m2-test" },
  fakeService,
);
assert.deepEqual(calls, [
  { contractVersion: 1, path: "GQM26/Source.md", limit: 17 },
]);
assert.equal(actual, response);
assert.equal(actual.cache.freshness.status, "unknown");
assert.equal(actual.cache.consistency, "best_effort_non_atomic_snapshot");

await assert.rejects(
  () =>
    processObsidianNoteLinks(
      { filePath: "GQM26/Source.md", limit: 17 },
      { requestId: "m2-test" },
      undefined,
    ),
  /requires a live Obsidian Desktop metadata cache/u,
);

console.log(
  "PASS: M2 note-links MCP projection is live-only, bounded and preserves honest cache freshness",
);
