import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { get_encoding } from "tiktoken";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const protocolEra = process.env.MCP_BENCHMARK_PROTOCOL_ERA ?? "legacy";
assert.ok(
  ["legacy", "modern"].includes(protocolEra),
  "Invalid benchmark protocol era",
);
// Keep comparisons to the original v1 build executable with the same harness.
// SDK v1 is a dev-only test dependency, never a production transport dependency.
const baselinePackage = process.env.VNEXT_DIST_ROOT
  ? JSON.parse(
      await readFile(
        path.resolve(process.env.VNEXT_DIST_ROOT, "..", "package.json"),
        "utf8",
      ),
    )
  : undefined;
const legacyBuild =
  baselinePackage &&
  !baselinePackage.dependencies?.["@modelcontextprotocol/server"];
assert.ok(
  !(legacyBuild && protocolEra === "modern"),
  "A v1 baseline cannot serve protocol 2026",
);
const { McpServer, InMemoryTransport } = legacyBuild
  ? {
      ...(await import("@modelcontextprotocol/sdk/server/mcp.js")),
      ...(await import("@modelcontextprotocol/sdk/inMemory.js")),
    }
  : await import("@modelcontextprotocol/server");
const { Client } = await import(
  legacyBuild
    ? "@modelcontextprotocol/sdk/client/index.js"
    : "@modelcontextprotocol/client"
);

Object.assign(process.env, {
  NODE_ENV: "test",
  OBSIDIAN_RUNTIME_MODE: "live",
  OBSIDIAN_API_KEY: "fixture-only",
  OBSIDIAN_BASE_URL: "http://127.0.0.1:1",
  OBSIDIAN_API_SEARCH_TIMEOUT_MS: "100",
  MCP_LOG_LEVEL: "error",
  MCP_WRITE_MODE: "full",
});
const dist = pathToFileURL(
  path.resolve(process.env.VNEXT_DIST_ROOT || "dist") + path.sep,
).href;
const load = (p) => import(dist + p);
const { registerObsidianListNotesTool } = await load(
  "mcp-server/tools/obsidianListNotesTool/registration.js",
);
const { registerObsidianGlobalSearchTool } = await load(
  "mcp-server/tools/obsidianGlobalSearchTool/registration.js",
);
const { registerObsidianReadNoteTool } = await load(
  "mcp-server/tools/obsidianReadNoteTool/registration.js",
);
const { registerNoteCreateTools } = await load(
  "mcp-server/tools/noteCreateTools/index.js",
);
const { NoteCreateOperationAdapter } = await load(
  "services/operations/noteCreateOperationAdapter.js",
);
const { ObsidianNoteReplaceJournal } = await load(
  "services/operations/obsidianNoteReplaceJournal.js",
);
const { createPolicyDigest, noteCreateHash } = await load(
  "services/noteCreateContract.js",
);
const root = await mkdtemp(path.join(os.tmpdir(), "vnext-e2e-"));
const target = "Projects/Alpha/VNext.md";
const files = new Map([
  [target, "---\naliases: [AliasAlpha]\n---\nVNext VNext E2E-KEY\n"],
  ["Projects/Beta/VNext.md", "vnext LowerOnly"],
]);
for (let n = 0; n < 300; n++)
  files.set(
    "Archive/Note-" + String(n).padStart(3, "0") + ".md",
    "VNext VNext archive",
  );
const clean = (p) => p.replace(/^\/+|\/+$/g, "");
let backendReads = 0,
  writes = 0,
  behavior = "exact",
  now = Date.parse("2026-09-22T00:00:00Z");
const live = {
  async listFiles(dir) {
    backendReads++;
    const prefix = clean(dir) ? clean(dir) + "/" : "";
    return [
      ...new Set(
        [...files.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => {
            const a = p.slice(prefix.length).split("/");
            return a[0] + (a.length > 1 ? "/" : "");
          }),
      ),
    ];
  },
  async searchSimple(query) {
    backendReads++;
    return [...files].flatMap(([filename, content]) => {
      const matches = [
        ...content.matchAll(
          new RegExp(query.replace(/[.*+?^{}()|[\]\\$]/g, "\\$&"), "gi"),
        ),
      ].map((m) => ({
        context: content,
        match: { start: m.index, end: m.index + m[0].length },
      }));
      return matches.length ? [{ filename, matches, score: 1 }] : [];
    });
  },
  async getFileContent(p) {
    backendReads++;
    const content = files.get(clean(p));
    assert.notEqual(content, undefined);
    return {
      path: clean(p),
      content,
      tags: [],
      frontmatter: {},
      stat: {
        mtime: 1700000000000,
        ctime: 1700000000000,
        size: Buffer.byteLength(content),
      },
    };
  },
};
const cache = {
  isReady: () => true,
  findMatchingPath: (p) => (files.has(clean(p)) ? clean(p) : undefined),
  getEntriesByPrefix(prefix) {
    const p = clean(prefix);
    return [...files]
      .filter(([f]) => !p || f.startsWith(p + "/"))
      .map(([path, content]) => ({
        path,
        content,
        mtime: 1700000000000,
        ctime: 1700000000000,
      }));
  },
  async getEntry(p) {
    return {
      content: files.get(clean(p)),
      mtime: 1700000000000,
      ctime: 1700000000000,
    };
  },
};
const policy = { version: 1, utcOffsetMinutes: 0, fields: [] },
  bindingFingerprint = "a".repeat(64),
  policyDigest = createPolicyDigest(policy);
const backend = {
  async preflight(path) {
    assert.equal(files.has(path), false);
    return {
      contractVersion: 1,
      path,
      bindingFingerprint,
      policy,
      policyDigest,
      absent: true,
      enabled: true,
    };
  },
  async create(r) {
    writes++;
    assert.equal(files.has(r.path), false);
    files.set(r.path, behavior === "drift" ? "Unqualified drift" : r.content);
    if (behavior === "lost") throw Error("lost response");
    const { content, ...ids } = r;
    return { ...ids, outcome: "created", reason: "created" };
  },
  async inspect(path) {
    const content = files.get(path);
    return {
      contractVersion: 1,
      path,
      bindingFingerprint,
      exists: content !== undefined,
      ...(content !== undefined
        ? { content, sha256: noteCreateHash(content) }
        : {}),
    };
  },
};
let journal = new ObsidianNoteReplaceJournal(
  path.join(root, "journal.sqlite"),
  { now: () => now },
);
let runtime = new NoteCreateOperationAdapter(
  backend,
  journal,
  () => now,
  () => {},
);
const facade = {
  plan: (...a) => runtime.plan(...a),
  apply: (...a) => runtime.apply(...a),
  status: (...a) => runtime.status(...a),
};
let server, modernHandler;
const client = new Client(
  { name: "vnext-benchmark-client", version: "1" },
  protocolEra === "modern"
    ? { versionNegotiation: { mode: "pin", protocolVersion: "2026-07-28" } }
    : {},
);
async function makeServer() {
  const instance = new McpServer({ name: "vnext-benchmark", version: "1" });
  await registerObsidianListNotesTool(instance, live, cache);
  await registerObsidianGlobalSearchTool(instance, live, cache);
  await registerObsidianReadNoteTool(instance, live, cache);
  registerNoteCreateTools(instance, facade);
  return instance;
}
const tokenizer = get_encoding("cl100k_base");
let metrics;
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  metrics.calls++;
  metrics.responseBytes += Buffer.byteLength(text);
  metrics.responseTokens += tokenizer.encode(text).length;
  assert.notEqual(response.isError, true, "MCP error");
  return JSON.parse(text);
}
const read = async (p) => {
  const r = await call("obsidian_read_note", { filePath: p });
  assert.ok(r.content.includes("E2E-KEY"));
};
const search = (opts) =>
  call("obsidian_global_search", {
    query: "VNext",
    searchInPath: "Projects",
    responseMode: "compact",
    ...opts,
  });
let serial = 0;
const flows = [
  [
    "recursive-find-read",
    async () => {
      const r = await call("obsidian_list_notes", {
        dirPath: "/",
        nameRegexFilter: "^VNext\\.md$",
        responseMode: "compact",
      });
      assert.ok(r.entries?.some((e) => e.path === target));
      await read(target);
    },
  ],
  [
    "regex-find-read",
    async () => {
      const r = await search({ query: "E2E-[K]EY", useRegex: true });
      assert.equal(r.totalFilesFound, 1);
      await read(r.results[0].path);
    },
  ],
  [
    "case-find-read",
    async () => {
      const r = await search({ query: "vnext", caseSensitive: true });
      assert.deepEqual(
        r.results.map((r) => r.path),
        ["Projects/Beta/VNext.md"],
      );
      const body = await call("obsidian_read_note", {
        filePath: r.results[0].path,
      });
      assert.ok(body.content.includes("LowerOnly"));
    },
  ],
  [
    "alias-find-read",
    async () => {
      const r = await search({ query: "AliasAlpha" });
      assert.equal(r.totalFilesFound, 1);
      await read(r.results[0].path);
    },
  ],
  [
    "compact-count-read",
    async () => {
      const r = await search({ maxMatchesPerFile: 1 });
      assert.equal(r.results.find((r) => r.path === target).matchCount, 2);
      await read(target);
    },
  ],
  [
    "compact-pagination",
    async () => {
      const seen = new Set();
      for (let page = 1; page <= 2; page++) {
        const r = await search({ page, pageSize: 1 });
        assert.equal(r.hasMore, page === 1);
        seen.add(r.results[0].path);
      }
      assert.equal(seen.size, 2);
    },
  ],
  [
    "bounded-payload",
    async () => {
      const r = await search({
        searchInPath: "",
        pageSize: 1,
        maxMatchesPerFile: 1,
      });
      assert.equal(r.totalFilesFound, 302);
      assert.ok(metrics.responseBytes < 1800, "off-page payload leaked");
    },
  ],
  ...["exact", "drift", "lost"].map((mode) => [
    "find-create-" + mode + "-restart",
    async () => {
      const found = await search({ query: "E2E-KEY" });
      await read(found.results[0].path);
      const destination = "Generated/Created-" + ++serial + ".md",
        key = "bench-" + serial;
      const content =
        "---\ntitle: Fixture\n---\ncreated independently verified\n";
      behavior = mode;
      const before = writes;
      try {
        const p = await call("obsidian_note_create_plan", {
          path: destination,
          content,
          idempotencyKey: key,
        });
        assert.equal(writes, before);
        const r = await call("obsidian_note_create_apply", {
          planRef: p.planRef,
          idempotencyKey: key,
        });
        assert.equal(
          r.outcome,
          mode === "drift" ? "outcome_unknown" : "committed",
        );
        assert.equal(r.applyAllowed, false);
        assert.equal(r.recoveryAllowed, false);
        assert.equal(
          files.get(destination),
          mode === "drift" ? "Unqualified drift" : content,
        );
        journal.close();
        journal = new ObsidianNoteReplaceJournal(
          path.join(root, "journal.sqlite"),
          { now: () => now },
        );
        runtime = new NoteCreateOperationAdapter(
          backend,
          journal,
          () => now,
          () => {},
        );
        const status = await call("obsidian_note_create_status", {
          planRef: p.planRef,
        });
        assert.equal(status.outcome, r.outcome);
        await call("obsidian_note_create_apply", {
          planRef: p.planRef,
          idempotencyKey: key,
        });
        assert.equal(writes, before + 1);
      } finally {
        behavior = "exact";
        files.delete(destination);
      }
    },
  ]),
];
const results = [];
try {
  if (protocolEra === "modern") {
    modernHandler = createMcpHandler(makeServer, { legacy: "reject" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1/mcp"),
      {
        fetch: (url, init) => modernHandler.fetch(new Request(url, init)),
      },
    );
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
  } else {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    server = await makeServer();
    await server.connect(st);
    await client.connect(ct);
  }
  for (const [name, run] of flows) {
    const samples = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      metrics = { calls: 0, responseBytes: 0, responseTokens: 0 };
      const before = backendReads,
        start = performance.now();
      let failure;
      try {
        await run();
      } catch (e) {
        failure =
          e instanceof assert.AssertionError
            ? "postcondition_failed"
            : String(e.message).slice(0, 100);
      }
      samples.push({
        ...metrics,
        backendReads: backendReads - before,
        ms: performance.now() - start,
        success: !failure,
        ...(failure ? { failure } : {}),
      });
    }
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    results.push({
      name,
      successes: samples.filter((s) => s.success).length,
      runs: samples.length,
      p50Ms: sorted[2],
      p95Ms: sorted[4],
      samples,
    });
  }
  const report = {
    schemaVersion: 1,
    baseline: "991d0740158ab1fb5154366f5f08f6c7e719abc5",
    candidate: process.env.VNEXT_DIST_ROOT ? "baseline" : "patched",
    protocolEra,
    surface:
      protocolEra === "modern"
        ? "official MCP 2026 client/server via in-process Web Fetch HTTP; server factory per request; simulated vault backend; real SQLite journal"
        : "real MCP SDK client/server in-memory transport; simulated vault backend; real SQLite journal",
    tokenizer: "cl100k_base proxy, response text only",
    manualCorrections: 0,
    results,
  };
  if (process.argv[2])
    await writeFile(process.argv[2], JSON.stringify(report, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        candidate: report.candidate,
        passed: results.filter((r) => r.successes === r.runs).length,
        total: results.length,
        results: results.map(({ name, successes, runs, p50Ms, p95Ms }) => ({
          name,
          successes,
          runs,
          p50Ms,
          p95Ms,
        })),
      },
      null,
      2,
    ),
  );
  if (
    !process.env.VNEXT_DIST_ROOT &&
    results.some((r) => r.successes !== r.runs)
  )
    process.exitCode = 1;
} finally {
  await client.close();
  await server?.close();
  await modernHandler?.close();
  journal.close();
  tokenizer.free();
  await rm(root, { recursive: true, force: true });
}
