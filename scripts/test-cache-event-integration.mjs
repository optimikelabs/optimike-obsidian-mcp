import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { test, after } from "node:test";
import { nativeFormatFixture } from "./fixtures/native-frontmatter-format.mjs";
const root = mkdtempSync(
  path.join(os.tmpdir(), "optimike-cache-events-integration-"),
);
const logs = path.join(process.cwd(), "logs", path.basename(root));
const notes = new Map([["Note.md", "one"]]);
const streams = new Map();
const reads = [];
let searches = 0;
let beforeSearch;
let subscriptions = 0;
let counter = 0;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer FIXTURE_KEY") {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/events/")) {
    for await (const _chunk of req) {
    }
    const event = req.url.split("/")[3];
    const id = "fixture-subscription-" + ++subscriptions;
    res
      .writeHead(201, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          id,
          event,
          emitter: "vault",
          signed: false,
          expiresAt: new Date(Date.now() + 30000).toISOString(),
          url:
            "http://127.0.0.1:" +
            server.address().port +
            "/events/vault/" +
            event +
            "/" +
            id +
            "/",
        }),
      );
    return;
  }
  if (req.url.startsWith("/events/")) {
    const event = req.url.split("/")[3];
    streams.set(event, res);
    res.on("close", () => {
      if (streams.get(event) === res) streams.delete(event);
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n");
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/search/simple/")) {
    searches++;
    await beforeSearch?.();
    const query = new URL(req.url, "http://fixture.invalid").searchParams.get("query");
    const results = [...notes].filter(([, content]) => content.includes(query))
      .map(([filename]) => ({ filename, matches: [], score: 0 }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(results));
    return;
  }
  if (req.url === "/vault/") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ files: [...notes.keys()] }));
    return;
  }
  const filename = decodeURIComponent(req.url.slice("/vault/".length));
  reads.push(filename);
  if (!notes.has(filename)) {
    res.writeHead(404).end("{}");
    return;
  }
  const content = notes.get(filename);
  const size = Buffer.byteLength(content);
  if (req.method === "HEAD") {
    res
      .writeHead(200, {
        "x-obsidian-mtime": "2",
        "x-obsidian-ctime": "1",
        "content-length": String(size),
      })
      .end();
    return;
  }
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(
      JSON.stringify({
        path: filename,
        content,
        stat: { mtime: 2000, ctime: 1000, size },
        tags: [],
        frontmatter: {},
      }),
    );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  NO_PROXY: "*",
  no_proxy: "*",
  OBSIDIAN_RUNTIME_MODE: "live",
  OBSIDIAN_API_KEY: "FIXTURE_KEY",
  OBSIDIAN_BASE_URL: "http://127.0.0.1:" + server.address().port,
  OBSIDIAN_VAULT: root,
  OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "cache.sqlite"),
  OBSIDIAN_CACHE_SOURCE: "rest",
  OBSIDIAN_VAULT_EXCLUDE_PATTERNS: "Private/**",
  OBSIDIAN_CACHE_EVENTS_ENABLED: "true",
  LOGS_DIR: logs,
  MCP_WRITE_MODE: "full",
});
const { ObsidianRestApiService } = await import(
  "../dist/services/obsidianRestAPI/service.js"
);
const { VaultCacheService } = await import(
  "../dist/services/obsidianRestAPI/vaultCache/service.js"
);
const { config } = await import("../dist/config/index.js");
const cache = new VaultCacheService(new ObsidianRestApiService());
const wait = async (condition) => {
  const end = Date.now() + 12000;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("integration condition timeout");
    await pause(10);
  }
};
const emit = (event, filename, extra = {}) =>
  streams
    .get(event)
    ?.write(
      "id: deadbeef-" +
        (counter += 7) +
        "\nevent: " +
        event +
        "\ndata: " +
        JSON.stringify({
          emitter: "vault",
          event,
          path: filename,
          isFolder: false,
          ...extra,
        }) +
        "\n\n",
    );
after(async () => {
  await cache.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(logs, { recursive: true, force: true });
});

test("production adapter and cache observe create/modify/rename/delete and reconnect on real sockets", async () => {
  assert.equal(config.obsidianCacheRefreshIntervalMin, 10);
  await cache.buildVaultCache();
  cache.startPeriodicRefresh();
  cache.startPeriodicRefresh();
  await wait(() => cache.getStats().eventCache.state === "ready");
  assert.equal(subscriptions, 4);
  const first = cache.getStats().eventCache.reconciliations;
  notes.set("Note.md", "two");
  emit("modify", "Note.md");
  await wait(async () => (await cache.getEntry("/Note.md"))?.content === "two");
  assert.equal(
    cache.getStats().eventCache.reconciliations,
    first,
    "numeric counter jumps are not gaps",
  );
  notes.set("Created.md", "created");
  emit("create", "Created.md");
  await wait(
    async () => (await cache.getEntry("/Created.md"))?.content === "created",
  );
  notes.set("Private/hidden.md", "secret");
  emit("create", "Private/hidden.md");
  await pause(80);
  assert.equal(await cache.getEntry("/Private/hidden.md"), undefined);
  assert.ok(!reads.includes("Private/hidden.md"));
  notes.delete("Created.md");
  notes.set("Renamed.md", "renamed");
  emit("rename", "Renamed.md", { oldPath: "Created.md" });
  await wait(
    async () =>
      !(await cache.getEntry("/Created.md")) &&
      (await cache.getEntry("/Renamed.md"))?.content === "renamed",
  );
  notes.delete("Renamed.md");
  emit("delete", "Renamed.md");
  await wait(async () => !(await cache.getEntry("/Renamed.md")));
  // A create occurring without its listener must be recovered by forced reconciliation.
  streams.get("create").end();
  await wait(() => !streams.has("create"));
  notes.set("Missed.md", "created while disconnected");
  await wait(
    async () =>
      (await cache.getEntry("/Missed.md"))?.content ===
      "created while disconnected",
  );
  await wait(() => cache.getStats().eventCache.state === "ready");
  const evidence = cache.getStats().eventCache;
  assert.equal(subscriptions, 4, "a reconnect reuses its still-valid grant");
  assert.equal(evidence.reconnects, 1);
  assert.ok(evidence.reconciliations >= 2);
  assert.ok(evidence.eventToCacheP95Ms >= 0);
  assert.equal(evidence.pendingPaths, 0);
  console.log("FIXTURE_METRICS " + JSON.stringify(evidence));
  await cache.close();
  await wait(() => streams.size === 0);
});

async function withLiveSearch(run) {
  const { processObsidianGlobalSearch } = await import(
    "../dist/mcp-server/tools/obsidianGlobalSearchTool/logic.js"
  );
  notes.set("PageA.md", "pagination fixture");
  notes.set("PageB.md", "pagination fixture");
  const api = new ObsidianRestApiService();
  const searchCache = new VaultCacheService(api);
  const context = { requestId: "search-pages", timestamp: new Date(0).toISOString() };
  const search = (page, options = {}) => processObsidianGlobalSearch({
    query: "pagination fixture", page, pageSize: 1, useRegex: false,
    caseSensitive: false, contextLength: 100, maxMatchesPerFile: 5, responseMode: "compact",
    ...options,
  }, context, api, searchCache);
  try {
    searchCache.startPeriodicRefresh();
    await wait(() => searchCache.getStats().eventCache.state === "ready");
    await run(search, searchCache);
  } finally {
    await searchCache.close();
  }
}

test("live search exposes cache reuse and age only while vault coverage stays current", async () => {
  await withLiveSearch(async (search, searchCache) => {
    const before = searches;
    const first = await search(1);
    assert.deepEqual(first.liveSearchReuse, { reused: false });
    const afterFirstPageReads = reads.length;
    const second = await search(2);
    assert.equal(second.liveSearchReuse.reused, true);
    assert.ok(Number.isInteger(second.liveSearchReuse.ageMs) && second.liveSearchReuse.ageMs >= 0);
    assert.equal(first.totalFilesFound, 2);
    assert.equal(second.totalMatchesFound, first.totalMatchesFound);
    assert.deepEqual([first.results[0].path, second.results[0].path], ["PageA.md", "PageB.md"]);
    assert.equal(searches - before, 1, "the second page must not rescan Local REST");
    assert.equal(reads.length, afterFirstPageReads, "the second page must not reread notes");

    notes.set("PageB.md", "edited");
    emit("modify", "PageB.md");
    await wait(async () => (await searchCache.getEntry("/PageB.md"))?.content === "edited");
    assert.equal((await search(2)).totalFilesFound, 1);
    assert.equal(searches - before, 2, "the previous result must expire on a vault change");

    searchCache.stopPeriodicRefresh();
    assert.equal((await search(1)).totalFilesFound, 1);
    assert.equal(searches - before, 3, "reuse requires active event coverage");
  });
});

test("a governed patch makes the next page fresh before any vault event", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { McpServer, InMemoryTransport } = await import("@modelcontextprotocol/server");
  const { installMcpToolPublicErrorBoundary } = await import("../dist/mcp-server/toolErrorBoundary.js");
  const { registerGovernedTextPatchTools } = await import("../dist/mcp-server/tools/governedTextPatchTools/registration.js");
  const { GovernedNoteReplaceRuntime } = await import("../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js");
  const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
  const { ObsidianNoteReplaceOperationAdapter } = await import("../dist/services/operations/obsidianNoteReplaceOperationAdapter.js");
  const target = "PageB.md";
  const sha256 = text => createHash("sha256").update(text).digest("hex");
  const fingerprint = sha256("live-search-fixture-vault");
  const backend = {
    withContext: (_context, fn) => fn(),
    inspectFrontmatterFormat: nativeFormatFixture(fingerprint).inspectFrontmatterFormat,
    async status() {
      return { ok: true, contractVersion: 1, plugin: { id: "obsidian-atomic-write-bridge", version: "0.10.0" },
        backend: { kind: "obsidian-vault-process", bindingFingerprint: fingerprint, atomicCas: true, writeEnabled: true },
        frontmatterFormat: { contractVersion: 1, supported: true }, limits: { markdownOnly: true },
        protection: { contractVersion: 1, frontmatterDateProperties: { integrations: [] } },
      };
    },
    async read({ path: targetPath }) {
      assert.equal(targetPath, target);
      const content = notes.get(target);
      return { ok: true, contractVersion: 1, path: target, content, sha256: sha256(content),
        size: Buffer.byteLength(content), bindingFingerprint: fingerprint };
    },
    async replace({ expectedSha256, nextContent, bindingFingerprint }) {
      assert.equal(bindingFingerprint, fingerprint);
      assert.equal(sha256(notes.get(target)), expectedSha256);
      notes.set(target, nextContent);
      return { ok: true, contractVersion: 1, path: target, beforeSha256: expectedSha256,
        afterSha256: sha256(nextContent), size: Buffer.byteLength(nextContent), bindingFingerprint: fingerprint };
    },
  };
  await withLiveSearch(async (search, searchCache) => {
    notes.set(target, "---\ncréation: 2026-08-13\n---\npagination fixture\n");
    const journal = new ObsidianNoteReplaceJournal(path.join(root, "search-patch.sqlite"));
    const adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal);
    const runtime = new GovernedNoteReplaceRuntime(backend, journal, adapter);
    const mcp = new McpServer({ name: "search-patch", version: "1" });
    installMcpToolPublicErrorBoundary(mcp, () => searchCache.beginVaultMutation());
    const client = new Client({ name: "search-patch-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await registerGovernedTextPatchTools(mcp, runtime);
      await mcp.connect(st);
      await client.connect(ct);
      const call = async (name, arguments_) => {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.equal(Boolean(result.isError), false, result.content[0].text);
        return JSON.parse(result.content[0].text);
      };
      const idempotencyKey = "search-patch-fixture";
      const plan = await call("obsidian_text_patch_plan", {
        path: target, idempotencyKey,
        operations: [{ op: "replace_literal", search: "pagination fixture", replacement: "patched" }],
      });
      assert.equal((await search(1)).totalFilesFound, 2);
      assert.equal((await search(1)).liveSearchReuse.reused, true);
      const before = searches;
      const receipt = await call("obsidian_text_patch_apply", { planRef: plan.planRef, idempotencyKey });
      assert.equal(receipt.outcome, "committed");
      const second = await search(2);
      assert.equal(second.totalFilesFound, 1);
      assert.deepEqual(second.liveSearchReuse, { reused: false });
      assert.equal(searches - before, 1);
    } finally {
      await client.close();
      await mcp.close();
      await runtime.close();
    }
  });
});

test("compact pages reuse a large result whose detailed snapshot exceeds the memory budget", async () => {
  const query = "bulk search fixture";
  const names = Array.from({ length: 10_000 }, (_, i) => `Bulk${String(i).padStart(5, "0")}.md`);
  await withLiveSearch(async (search) => {
    const content = "a".repeat(140) + query + "b".repeat(140);
    for (const filename of names) notes.set(filename, content);
    try {
      const before = searches;
      const start = performance.now();
      const first = await search(1, { query, pageSize: 500 });
      const secondStarted = performance.now();
      const readsAfterFirst = reads.length;
      const second = await search(2, { query, pageSize: 500 });
      const end = performance.now();
      assert.equal(first.totalFilesFound, names.length);
      assert.equal(second.results[0].path, names[500]);
      assert.equal(second.liveSearchReuse.reused, true);
      assert.equal(searches - before, 1);
      assert.equal(reads.length, readsAfterFirst);
      console.log(`LIVE_SEARCH_FIXTURE files=${names.length} firstMs=${Math.round(secondStarted - start)} secondMs=${Math.round(end - secondStarted)}`);
    } finally {
      for (const filename of names) notes.delete(filename);
    }
  });
});

test("concurrent pages share one in-flight REST search for a vault generation", async () => {
  await withLiveSearch(async (search) => {
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    beforeSearch = () => {
      arrived.resolve();
      return release.promise;
    };
    const before = searches;
    try {
      const first = search(1);
      await arrived.promise;
      const second = search(2);
      release.resolve();
      await Promise.all([first, second]);
      assert.equal(searches - before, 1);
    } finally {
      beforeSearch = undefined;
      release.resolve();
    }
  });
});

test("relative dates bypass reuse and leave a stable search cached", async () => {
  await withLiveSearch(async (search) => {
    await search(1);
    const before = searches;
    for (const date of ["today", "today", "2 weeks ago", "yesterday", "last Friday"]) {
      assert.deepEqual((await search(2, { modified_since: date })).liveSearchReuse, { reused: false });
    }
    assert.equal(searches - before, 5);
    assert.equal((await search(2)).liveSearchReuse.reused, true);
  });
});

test("live search snapshots are bounded in UTF-16, expire by timer, and purge on stop", async (t) => {
  const { LiveSearchMemo } = await import("../dist/services/obsidianRestAPI/vaultCache/liveSearchMemo.js");
  const memo = new LiveSearchMemo();
  assert.equal(memo.save("too large in UTF-16", ["a".repeat(2 * 1024 * 1024)], 1), false);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(memo.save("expiring", ["fixture"], 1), true);
    t.mock.timers.tick(30_000);
    assert.equal(memo.get("expiring"), undefined);
  } finally {
    memo.clear();
    t.mock.timers.reset();
  }
  await withLiveSearch(async (_search, searchCache) => {
    assert.equal(searchCache.liveSearchMemo.save("stop", ["fixture"], 1), true);
    searchCache.stopPeriodicRefresh();
    assert.equal(searchCache.liveSearchMemo.get("stop"), undefined);
  });
});
