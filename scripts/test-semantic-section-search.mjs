import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

// Synthetic vault and Smart Connections v3 index with block (section) vectors.
const root = await mkdtemp(path.join(os.tmpdir(), "semantic-sections-"));
const source = path.join(root, ".smart-env");
const dbPath = path.join(root, "cache.sqlite");
let embedRequests = 0;
let beforeEmbedReply;
let queryVector = [1, 0, 0, 0];
const http = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  embedRequests += 1;
  await beforeEmbedReply?.();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ embeddings: [queryVector] }));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  NODE_ENV: "test",
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: root,
  SMART_ENV_DIR: source,
  SMART_ENV_GENERATION_POINTER: path.join(root, "CURRENT"),
  OBSIDIAN_SHARED_CACHE_DB_PATH: dbPath,
  SMART_ENV_CACHE_TTL_MS: "0",
  SEMANTIC_SEARCH_PREWARM: "false",
  ENABLE_QUERY_EMBEDDING: "true",
  MCP_LOG_LEVEL: "error",
  QUERY_EMBEDDER: "auto",
});
delete process.env.QUERY_EMBEDDER_MODEL;
delete process.env.OLLAMA_BASE_URL;
const pointer = process.env.SMART_ENV_GENERATION_POINTER;
delete process.env.SMART_ENV_GENERATION_POINTER;

const { smartTextHash } = await import("../dist/services/smartEnvV3.js");
const { SemanticCacheService, getSemanticCacheService } = await import(
  "../dist/services/semanticCache.js"
);
const { registerSemanticSearchTool } = await import(
  "../dist/mcp-server/tools/semanticSearchTool/registration.js"
);
const { registerRuntimeTools } = await import(
  "../dist/mcp-server/tools/runtimeTools/registration.js"
);

const model = { provider_key: "ollama", model_key: "fixture-embed", dims: 4 };
const fingerprint = `mf_${smartTextHash(
  JSON.stringify({ provider_key: "ollama", model_key: "fixture-embed", dimensions: 4, max_tokens: 0 }),
)}`;
const publishPointer = async (contents) => {
  await writeFile(pointer + ".next", contents, "utf8");
  await rename(pointer + ".next", pointer);
};
const publish = (id) => publishPointer(id + "\n");
const generationRoot = path.join(root, "generations");
async function writeGeneration(id, records, notes, sections) {
  const directory = path.join(generationRoot, id);
  await cp(source, directory, { recursive: true });
  await writeFile(path.join(directory, "smart_sources", "smart_sources.ajson"), records.join(",\n"));
  const writeVectors = async (folder, rows) => {
    const bytes = floats(rows);
    await writeFile(path.join(directory, folder, fingerprint), bytes);
    return { count: rows.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  await writeFile(path.join(directory, "generation.json"), JSON.stringify({
    generation: id, model: { ...model, dimensions: model.dims }, fingerprint,
    vectors: {
      encoding: "float32le",
      notes: await writeVectors("smart_sources", notes),
      sections: await writeVectors("smart_blocks", sections),
    },
  }));
  return directory;
}
const alpha = [
  "---",
  "tags: [keep]",
  "---",
  "# Alpha",
  "Intro paragraph.",
  "",
  "## Target",
  "The answer is in this paragraph.",
  "It spans two lines.",
].join("\n");
const beta = ["# Beta", "Close, in another folder."].join("\n");
const span = (text, start, end) => text.split("\n").slice(start - 1, end).join("\n");
const block = (text, start, end, fileIndex) => ({
  lines: [start, end],
  last_read: { hash: smartTextHash(span(text, start, end)) },
  embedding: {
    default: {
      [fingerprint]: {
        file: fingerprint,
        file_i: fileIndex,
        read_hash: smartTextHash(span(text, start, end)),
      },
    },
  },
});
const record = (notePath, text, fileIndex, tags, blocks_data) =>
  `"smart_sources:${notePath}": ` +
  JSON.stringify({
    path: notePath,
    last_read: { hash: smartTextHash(text) },
    metadata: tags ? { tags } : {},
    embedding: { default: { [fingerprint]: { file: fingerprint, file_i: fileIndex, read_hash: smartTextHash(text) } } },
    blocks_data,
  });
const floats = (rows) => {
  const buffer = Buffer.alloc(rows.length * 16);
  rows.flat().forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
};

await mkdir(path.join(root, "Notes"), { recursive: true });
await mkdir(path.join(root, "Other"));
await mkdir(path.join(source, "embedding_models"), { recursive: true });
await mkdir(path.join(source, "smart_sources"));
await mkdir(path.join(source, "smart_blocks"));
await writeFile(path.join(root, "Notes", "Alpha.md"), alpha, "utf8");
await writeFile(path.join(root, "Other", "Beta.md"), beta, "utf8");
await writeFile(
  path.join(source, "smart_env.json"),
  JSON.stringify({ embedding_models: { default_model_key: "ollama#fixture" } }),
  "utf8",
);
await writeFile(
  path.join(source, "embedding_models", "embedding_models.ajson"),
  '"embedding_models:ollama#fixture": ' +
    JSON.stringify({ ...model, host: `http://127.0.0.1:${http.address().port}` }),
  "utf8",
);
await writeFile(
  path.join(source, "smart_sources", "smart_sources.ajson"),
  [
    record("Notes/Alpha.md", alpha, 0, ["#keep"], {
      "#---frontmatter---": block(alpha, 1, 3, 0),
      "#Alpha": block(alpha, 4, 6, 1),
      "#Alpha##Target": block(alpha, 7, 9, 2),
    }),
    record("Other/Beta.md", beta, 1, undefined, { "#Beta": block(beta, 1, 2, 3) }),
  ].join(",\n"),
  "utf8",
);
await writeFile(
  path.join(source, "smart_sources", fingerprint),
  floats([[0.6, 0.8, 0, 0], [0, 0, 1, 0]]),
);
const blockFile = path.join(source, "smart_blocks", fingerprint);
await writeFile(
  blockFile,
  floats([[1, 1, 1, 1], [0, 1, 0, 0], [1, 0, 0, 0], [0.8, 0.6, 0, 0]]),
);

const server = new McpServer({ name: "sections", version: "1" });
const client = new Client({ name: "sections-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const search = async (args) => {
  const response = await client.callTool({
    name: "smart_semantic_search",
    arguments: { query: "where is the answer", top_k: 5, ...args },
  });
  return { isError: response.isError, value: JSON.parse(response.content[0].text) };
};
const runtimeStatus = async () => {
  const response = await client.callTool({ name: "obsidian_runtime_status", arguments: {} });
  assert.equal(response.isError, false);
  const status = JSON.parse(response.content[0].text);
  return {
    cache: status.semanticCache,
    capability: status.capabilityManifest.capabilities.find(({ id }) => id === "semantic-search"),
  };
};

try {
  // One cold read publishes both caches: sections first, then notes.
  const fresh = new SemanticCacheService(source, dbPath, 0);
  const firstSections = await fresh.getSectionSnapshot();
  assert.equal(firstSections.refs.length, 3, "frontmatter blocks are not searchable sections");
  assert.equal(
    fresh.getStats().manifest?.vectorCount,
    2,
    "the section read also published the note snapshot of the same files",
  );
  const reopened = new SemanticCacheService(source, dbPath, 0);
  const cachedSections = await reopened.getSectionSnapshot();
  assert.equal(
    cachedSections.refreshedAt,
    firstSections.refreshedAt,
    "a new process reuses the persisted section references",
  );
  assert.deepEqual([...cachedSections.vectors], [...firstSections.vectors]);
  fresh.db.close();
  reopened.db.close();

  await registerSemanticSearchTool(server);
  await registerRuntimeTools(server, undefined, undefined, undefined, undefined, undefined, {
    operon: async () => { throw new Error("No Operon in the semantic fixture"); },
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const notes = await search({});
  assert.equal(notes.isError, false);
  assert.equal(notes.value.generation_id, undefined, "the unset pointer preserves the legacy response");
  assert.deepEqual(
    Object.keys(notes.value.results[0]).sort(),
    ["path", "score", "snippet", "title"],
    "the default granularity keeps the note result shape",
  );
  assert.equal(notes.value.section_count, undefined);

  const sections = await search({ granularity: "sections" });
  assert.equal(sections.isError, false);
  const [top, second] = sections.value.results;
  assert.deepEqual(
    {
      kind: top.kind,
      path: top.path,
      score: top.score,
      block_key: top.block_key,
      headings: top.headings,
      lines: top.lines,
      lines_verified: top.lines_verified,
      snippet: top.snippet,
    },
    {
      kind: "section",
      path: "Notes/Alpha.md",
      score: 1,
      block_key: "#Alpha##Target",
      headings: ["Alpha", "Target"],
      lines: [7, 9],
      lines_verified: true,
      snippet: span(alpha, 7, 9),
    },
  );
  assert.equal(second.path, "Other/Beta.md");
  assert.equal(sections.value.section_count, 3);
  assert.ok(sections.value.results.every((result) => result.kind === "section"));

  const inFolder = await search({ granularity: "sections", folders: ["Notes/"] });
  assert.deepEqual(
    inFolder.value.results.map((result) => result.block_key),
    ["#Alpha##Target", "#Alpha"],
    "the folder filter applies to sections",
  );
  const tagged = await search({ granularity: "sections", tags: ["#keep"] });
  assert.ok(
    tagged.value.results.every((result) => result.path === "Notes/Alpha.md"),
    "the tag filter applies to sections",
  );

  const both = await search({ granularity: "both" });
  assert.deepEqual(
    both.value.results.map((result) => [result.kind, result.score]),
    [...both.value.results]
      .sort((left, right) => right.score - left.score)
      .map((result) => [result.kind, result.score]),
  );
  assert.ok(new Set(both.value.results.map((result) => result.kind)).size === 2);

  await writeGeneration("a", [
    record("Notes/Alpha.md", alpha, 0, ["#keep"], { "#Alpha": block(alpha, 4, 6, 0) }),
    record("Other/Beta.md", beta, 1, undefined, { "#Beta": block(beta, 1, 2, 1) }),
  ], [[0, 1, 0, 0], [1, 0, 0, 0]], [[0, 1, 0, 0], [1, 0, 0, 0]]);
  const generationB = await writeGeneration("b", [
    record("Notes/Alpha.md", alpha, 0, ["#keep"], { "#Alpha##Target": block(alpha, 7, 9, 0) }),
  ], [[1, 0, 0, 0]], [[1, 0, 0, 0]]);
  await publishPointer("\uFEFFa\r\n");
  Object.assign(process.env, {
    SMART_ENV_GENERATION_POINTER: pointer,
    SMART_ENV_QUERY_FINGERPRINT: fingerprint,
    OLLAMA_BASE_URL: `http://127.0.0.1:${http.address().port}`,
  });
  const warmA = await search({ granularity: "both" });
  assert.equal(warmA.value.generation_id, "a", "the pointer takes precedence over a warm legacy cache");
  assert.equal(warmA.value.results[0].path, "Other/Beta.md");
  assert.equal((await runtimeStatus()).cache.generationId, "a");

  beforeEmbedReply = async () => {
    beforeEmbedReply = undefined;
    await publish("b");
  };
  const inFlightA = await search({ granularity: "both" });
  assert.deepEqual(inFlightA.value.results, warmA.value.results, "a swap during the request cannot change its results");
  const beforeB = await runtimeStatus();
  assert.equal(beforeB.cache.source, "external");
  assert.equal(beforeB.cache.generationId, "b");
  assert.equal(beforeB.cache.manifest, null, "status cannot project A's persisted manifest under B");
  assert.equal(beforeB.capability.reasonCode, "semantic_query_unverified",
    "B cannot reuse A's successful live encoder observation");
  const b = await search({ granularity: "both" });
  assert.equal(b.value.generation_id, "b");
  assert.deepEqual(
    b.value.results.map(({ path, kind, score }) => [path, kind, score]),
    [["Notes/Alpha.md", "note", 1], ["Notes/Alpha.md", "section", 1]],
    "B replaces A's note scores and section references, including the deleted note",
  );
  assert.equal((await runtimeStatus()).capability.reasonCode, "ready");
  queryVector = [1, 0];
  const wrongDimension = await search({});
  assert.equal(wrongDimension.isError, true);
  assert.equal(wrongDimension.value.error.details.reasonCode, "semantic_query_vector_invalid");
  queryVector = [1, 0, 0, 0];
  const requestsBeforeRefusals = embedRequests;
  process.env.QUERY_EMBEDDER_MODEL = "different-model";
  assert.equal((await search({})).isError, true, "equal dimensions cannot make a different query model compatible");
  delete process.env.QUERY_EMBEDDER_MODEL;
  process.env.SMART_ENV_QUERY_FINGERPRINT = "mf_wrong";
  assert.equal((await search({})).isError, true, "the registry must match the operator-pinned fingerprint");
  process.env.SMART_ENV_QUERY_FINGERPRINT = fingerprint;
  await publishPointer("a");
  assert.equal((await search({})).isError, true,
    "a torn pointer cannot select an existing generation through an unterminated prefix");
  const invalidPointerStatus = await runtimeStatus();
  assert.equal(invalidPointerStatus.capability.reasonCode, "semantic_index_unavailable");
  assert.equal(invalidPointerStatus.capability.nextAction, "check_semantic_publication",
    "an invalid external pointer calls for checking publication, since refreshing cannot repair it");
  await publishPointer("a\n\n");
  assert.equal((await search({})).isError, true, "the pointer must contain exactly one line");
  await publish("../a");
  assert.equal((await search({})).isError, true, "an invalid pointer cannot fall back to the last generation or legacy index");
  await publish("missing");
  assert.equal((await search({})).isError, true, "a missing generation cannot reuse cached results");
  await publish("b");
  await truncate(path.join(generationB, "smart_blocks", fingerprint), 4);
  assert.equal((await search({})).isError, true, "a truncated block file invalidates a warm generation even during a note search");
  const unavailableStatus = await runtimeStatus();
  assert.equal(unavailableStatus.cache.reasonCode, "semantic_index_unavailable");
  assert.equal(unavailableStatus.capability.reasonCode, "semantic_index_unavailable");
  await rm(pointer);
  assert.equal((await search({})).isError, true, "a configured but missing pointer fails closed");
  assert.equal(embedRequests, requestsBeforeRefusals, "invalid generations are refused before query encoding");
  delete process.env.SMART_ENV_GENERATION_POINTER;
  delete process.env.SMART_ENV_QUERY_FINGERPRINT;
  delete process.env.OLLAMA_BASE_URL;

  // Edited after indexing: a shifted section is found again; a rewritten one
  // keeps its indexed lines but is reported unverified, without a snippet.
  await writeFile(
    path.join(root, "Notes", "Alpha.md"),
    alpha.replace("# Alpha\nIntro paragraph.", "# Alpha\nAdded.\nLines.\nIntro rewritten."),
    "utf8",
  );
  const edited = await search({ granularity: "sections", folders: ["Notes/"] });
  const moved = edited.value.results.find((result) => result.block_key === "#Alpha##Target");
  assert.deepEqual([moved.lines, moved.lines_verified], [[9, 11], true]);
  assert.equal(moved.snippet, span(alpha, 7, 9));
  const rewritten = edited.value.results.find((result) => result.block_key === "#Alpha");
  assert.deepEqual(
    [rewritten.lines, rewritten.lines_verified, rewritten.snippet],
    [[4, 6], false, undefined],
  );
  const withoutSnippets = await search({ granularity: "sections", with_snippets: false });
  assert.deepEqual(
    [withoutSnippets.value.results[0].lines, withoutSnippets.value.results[0].snippet],
    [[9, 11], undefined],
    "lines are verified even without snippets",
  );

  // Once the TTL has elapsed, a block vector file rewritten without any source
  // record change (other size) is not served from the in-memory snapshot.
  const timed = new SemanticCacheService(source, dbPath, 60_000);
  const before = await timed.getSectionSnapshot();
  await writeFile(
    blockFile,
    floats([[1, 1, 1, 1], [1, 0, 0, 0], [0, 1, 0, 0], [0.8, 0.6, 0, 0], [0, 0, 0, 1]]),
  );
  timed.sectionSnapshotLoadedAt = 0; // the TTL elapsed
  const after = await timed.getSectionSnapshot();
  assert.notEqual(after.sourceSignature, before.sourceSignature);
  assert.deepEqual(
    [...after.vectors.subarray(0, 4)],
    [1, 0, 0, 0],
    "the rewritten block vectors are read",
  );
  timed.db.close();

  // A section read that started before a newer note snapshot was published
  // never replaces it with its older notes.
  const racing = new SemanticCacheService(source, dbPath, 60_000);
  racing.db.prepare("DELETE FROM semantic_section_manifest").run();
  const readSections = racing.loadSectionSource.bind(racing);
  let readDone;
  let release;
  const sectionRead = new Promise((resolve) => (readDone = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  racing.loadSectionSource = async (...args) => {
    const index = await readSections(...args);
    readDone();
    await gate;
    return index;
  };
  const pendingSections = racing.getSectionSnapshot();
  await sectionRead;
  await appendFile(
    path.join(source, "smart_sources", "smart_sources.ajson"),
    ',\n"smart_sources:Other/Beta.md": null',
    "utf8",
  );
  const newer = await racing.getSnapshot();
  assert.deepEqual(newer.items.map((item) => item.notePath), ["Notes/Alpha.md"]);
  release();
  await pendingSections;
  assert.deepEqual(
    (await racing.getSnapshot()).items.map((item) => item.notePath),
    ["Notes/Alpha.md"],
    "an older section read does not overwrite a newer note snapshot",
  );
  racing.db.close();

  // A section indexed far past the end of its note is reported unverified
  // without walking every line number up to it (it used to block the process).
  const gamma = ["# Gamma", "Short note."].join("\n");
  const far = 1_000_000_000_000;
  await writeFile(path.join(root, "Notes", "Gamma.md"), gamma, "utf8");
  await appendFile(
    path.join(source, "smart_sources", "smart_sources.ajson"),
    ",\n" +
      record("Notes/Gamma.md", gamma, 1, undefined, {
        "#Far": { ...block("Text no longer\nin the note.", 1, 2, 4), lines: [far, far + 1] },
      }),
    "utf8",
  );
  // The old loop was synchronous, so an in-process timer could never fire:
  // run this search in a child process bounded by a watchdog.
  const child = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { McpServer, InMemoryTransport } = await import("@modelcontextprotocol/server");
       const { Client } = await import("@modelcontextprotocol/client");
       const { registerSemanticSearchTool } = await import(${JSON.stringify(
         pathToFileURL(path.resolve("dist/mcp-server/tools/semanticSearchTool/registration.js")).href,
       )});
       const server = new McpServer({ name: "far", version: "1" });
       const client = new Client({ name: "far", version: "1" });
       const [c, s] = InMemoryTransport.createLinkedPair();
       await registerSemanticSearchTool(server);
       await server.connect(s);
       await client.connect(c);
       const r = await client.callTool({ name: "smart_semantic_search", arguments: { query: "far", granularity: "sections", folders: ["Notes/Gamma"], top_k: 5 } });
       console.log(r.content[0].text.replace(/\\s+/g, " "));
       await client.close();`,
    ],
    { cwd: process.cwd(), env: { ...process.env, OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "far.sqlite") }, encoding: "utf8", timeout: 60_000 },
  ).catch((error) => assert.fail(`the relocation search did not finish within the watchdog: ${error.killed ? "killed" : error.code}`));
  const farResult = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.deepEqual(
    farResult.results.map((result) => [result.block_key, result.lines, result.lines_verified]),
    [["#Far", [far, far + 1], false]],
  );

  // Without block vectors for the active model, sections are refused before
  // the query is embedded; notes still work.
  await rm(blockFile);
  getSemanticCacheService().forceRefresh();
  const requestsBefore = embedRequests;
  const unavailable = await search({ granularity: "sections" });
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.value.error.details.reasonCode, "semantic_sections_unavailable");
  assert.equal(embedRequests, requestsBefore, "the query is not embedded for a refused section search");
  assert.equal((await search({})).isError, false);

  console.log(
    "PASS semantic section search: block selection, one cold read for both caches, persisted references, filters, merged ranking, line verification and relocation, relocation bounded by the note length, refresh on block file change, refusal without block vectors",
  );
} finally {
  await client.close().catch(() => undefined);
  http.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
