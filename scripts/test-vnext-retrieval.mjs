import assert from "node:assert/strict";
import { test } from "node:test";
process.env.NODE_ENV = "test";
process.env.MCP_LOG_LEVEL = "error";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";
process.env.OBSIDIAN_API_SEARCH_TIMEOUT_MS = "100";
const { processObsidianListNotes, ObsidianListNotesInputSchema } = await import(
  "../dist/mcp-server/tools/obsidianListNotesTool/logic.js"
);
const { processObsidianGlobalSearch, ObsidianGlobalSearchInputSchemaShape } =
  await import("../dist/mcp-server/tools/obsidianGlobalSearchTool/logic.js");
const { z } = await import("zod");
const schema = z.object(ObsidianGlobalSearchInputSchemaShape);
const context = {
  requestId: "reliability-retrieval",
  timestamp: new Date().toISOString(),
};
const files = new Map([
  ["Parent/Child/VNext.md", "VNext VNext vnext\nLiteral [term]"],
  ["Other/VNext.md", "VNext\n"],
  ["Parent/NoHit.md", "nothing"],
  ["ParentSibling/VNext.md", "VNext"],
]);
const entries = [...files].map(([path, content]) => ({
  path,
  content,
  mtime: 1700000000000,
  ctime: 1700000000000,
}));
const clean = (value) => value.replace(/^\/+|\/+$/g, "");
const live = {
  async listFiles(dir) {
    const prefix = clean(dir) ? clean(dir) + "/" : "";
    return [
      ...new Set(
        [...files.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => {
            const parts = p.slice(prefix.length).split("/");
            return parts.length > 1 ? parts[0] + "/" : parts[0];
          }),
      ),
    ];
  },
  async searchSimple(query) {
    return [...files]
      .filter(([, text]) => text.toLowerCase().includes(query.toLowerCase()))
      .map(([filename]) => ({
        filename,
        matches: [{ context: "API candidate" }],
      }));
  },
  async getFileContent(p) {
    return {
      content: files.get(clean(p)),
      stat: { mtime: 1700000000000, ctime: 1700000000000 },
    };
  },
};
const cache = {
  isReady: () => true,
  getEntriesByPrefix(prefix) {
    const p = clean(prefix);
    return entries.filter(
      (e) => !p || e.path.startsWith(p + "/") || e.path === p,
    );
  },
  async getEntry(p) {
    return entries.find((e) => e.path === clean(p));
  },
};
for (const mode of ["live", "cache"]) {
  test(`${mode}: F1 filtered recursion reaches descendants and respects depth/extensions`, async () => {
    const list = (opts) =>
      processObsidianListNotes(
        ObsidianListNotesInputSchema.parse({
          dirPath: "/",
          responseMode: "compact",
          nameRegexFilter: "VNext",
          ...opts,
        }),
        context,
        mode === "live" ? live : undefined,
        cache,
      );
    assert.deepEqual(
      (await list({})).entries
        .filter((e) => e.type === "file")
        .map((e) => e.path)
        .sort(),
      [...files.keys()].filter((p) => p.endsWith("VNext.md")).sort(),
    );
    assert.equal((await list({ recursionDepth: 0 })).totalEntries, 0);
    assert.equal(
      (await list({ fileExtensionFilter: [".txt"] })).totalEntries,
      0,
    );
    const limited = await list({ dirPath: "Parent", recursionDepth: 1 });
    assert.deepEqual(
      limited.entries.filter((e) => e.type === "file").map((e) => e.path),
      ["Parent/Child/VNext.md"],
    );
  });
  test(`${mode}: F2 regex, literal, case and path semantics`, async () => {
    const search = (opts) =>
      processObsidianGlobalSearch(
        schema.parse({
          query: "V[N]ext",
          useRegex: true,
          searchInPath: "Parent",
          ...opts,
        }),
        context,
        mode === "live" ? live : undefined,
        cache,
      );
    const regex = await search({});
    assert.equal(regex.totalFilesFound, 1);
    assert.equal(regex.totalMatchesFound, 3);
    assert.equal((await search({ caseSensitive: true })).totalMatchesFound, 2);
    assert.equal(
      (await search({ query: "[term]", useRegex: false })).totalMatchesFound,
      1,
    );
    assert.equal(
      (await search({ query: "vnext", useRegex: false, caseSensitive: true }))
        .totalMatchesFound,
      1,
    );
    await assert.rejects(
      search({ query: "[" }),
      (e) => e.code === "VALIDATION_ERROR",
    );
  });
}

for (const mode of ["live", "cache"]) {
  test(`${mode}: F3 compact counts are independent of snippets and off-page payload is bounded`, async () => {
    const search = (opts) =>
      processObsidianGlobalSearch(
        schema.parse({
          query: "VNext",
          pageSize: 1,
          page: 2,
          responseMode: "compact",
          ...opts,
        }),
        context,
        mode === "live" ? live : undefined,
        cache,
      );
    const one = await search({ maxMatchesPerFile: 1 });
    const many = await search({ maxMatchesPerFile: 20 });
    assert.equal(one.results[0].matchCount, 3);
    assert.deepEqual(one.results, many.results);
    assert.equal(one.alsoFoundInFiles, undefined);
    assert.equal(one.hasMore, true);
    assert.equal(one.nextPage, 3);
    const detailed = await search({
      responseMode: "detailed",
      maxMatchesPerFile: 1,
    });
    assert.equal(detailed.results[0].matchCount, 3);
    assert.equal(detailed.results[0].returnedMatchCount, 1);
    assert.ok(detailed.alsoFoundInFiles.every((p) => p.includes("/")));
    assert.equal((await search({ page: 4 })).hasMore, false);
  });
}
