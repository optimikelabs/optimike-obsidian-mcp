import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test, after } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
const root = mkdtempSync(path.join(os.tmpdir(), "optimike-cache-freshness-"));
Object.assign(process.env, {
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: root,
  OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "cache.sqlite"),
  OBSIDIAN_CACHE_SOURCE: "rest",
  OBSIDIAN_VAULT_EXCLUDE_PATTERNS: "Private/**",
  MCP_WRITE_MODE: "readonly",
});
const { VaultCacheService } = await import(
  "../dist/services/obsidianRestAPI/vaultCache/service.js"
);
const { config } = await import("../dist/config/index.js");
const { heartbeatFileSource, observeUpstreamSync } = await import("../dist/services/upstreamSyncEvidence.js");
const { registerObsidianReadNoteTool } = await import(
  "../dist/mcp-server/tools/obsidianReadNoteTool/index.js"
);
const { collectRuntimeStatus, projectPublicRuntimeStatus } = await import(
  "../dist/services/runtimeState.js"
);
const context = {
  requestId: "cache-freshness-test",
  timestamp: new Date(0).toISOString(),
  operation: "test",
};
let fetches = 0;
let fail = false;
let content = "old";

test("upstream Sync requires ordered, recent heartbeat evidence", async () => {
  const file = path.join(root, "sync-heartbeat.json");
  const now = Date.parse("2026-01-01T00:10:00.000Z");
  const at = seconds => new Date(now - seconds * 1000).toISOString();
  const read = () => observeUpstreamSync(heartbeatFileSource(file), { currentSeconds: 60, stallSeconds: 120 }, () => now);
  const put = (state, heartbeat, started, completed) => fs.writeFile(file, JSON.stringify({
    version: 1, state, heartbeatAt: at(heartbeat),
    lastSuccessfulPull: started === null ? null : { startedAt: at(started), completedAt: at(completed) },
  }));
  assert.equal((await read()).upstreamSync, "unknown");
  await fs.writeFile(file, "{invalid-json");
  assert.equal((await read()).upstreamSync, "unknown");
  await put("ok", 5, 30, 5);
  assert.deepEqual(await read(), {
    upstreamSync: "current", lastSuccessfulPullAt: at(5), lagSecondsUpperBound: 30, evidenceSource: "heartbeat-file",
  });
  await put("running", 5, 90, 80);
  assert.equal((await read()).upstreamSync, "lagging");
  await put("running", 121, 140, 130);
  assert.equal((await read()).upstreamSync, "stalled");
  await put("error", 5, 30, 20);
  assert.equal((await read()).upstreamSync, "error");
  await put("running", 5, null);
  assert.equal((await read()).upstreamSync, "unknown");
  await put("ok", -1, 30, 10);
  assert.equal((await read()).upstreamSync, "unknown");
  await put("ok", 5, 10, 20);
  assert.equal((await read()).upstreamSync, "unknown");
});

test("one-shot Sync wrapper preserves the last receipt when the next CLI pass fails", async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "optimike-sync-wrapper-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const vault = path.join(sandbox, "vault");
  const heartbeat = path.join(sandbox, "heartbeat.json");
  const cli = path.join(sandbox, "obsidian-cli-fixture.mjs");
  await fs.mkdir(vault);
  const resolvedVault = await fs.realpath(vault);
  const run = (output = heartbeat) => promisify(execFile)(process.execPath, [
    "scripts/obsidian-sync-heartbeat.mjs", "--ob-cli", cli, "--vault", vault, "--heartbeat", output,
  ], { env: { ...process.env, EXPECTED_VAULT: resolvedVault }, timeout: 10_000 });
  await fs.writeFile(cli, `const args = process.argv.slice(2);
    process.exitCode = JSON.stringify(args) === JSON.stringify(["sync", "--path", process.env.EXPECTED_VAULT]) ? 0 : 2;`);
  await assert.rejects(run(path.join(vault, "heartbeat.json")), /heartbeat must be outside the vault/u);
  await run();
  const first = JSON.parse(await fs.readFile(heartbeat, "utf8"));
  assert.equal(first.state, "ok");
  assert.ok(first.lastSuccessfulPull.startedAt <= first.lastSuccessfulPull.completedAt);
  await fs.writeFile(cli, "process.exitCode = 1;");
  await assert.rejects(run(), /did not complete successfully/u);
  const next = JSON.parse(await fs.readFile(heartbeat, "utf8"));
  assert.equal(next.state, "error");
  assert.deepEqual(next.lastSuccessfulPull, first.lastSuccessfulPull);
  assert.deepEqual(await fs.readdir(vault), []);
});
const rest = {
  getFileContent: async (file) => {
    fetches++;
    if (fail) throw new Error("private upstream failure");
    return {
      path: file,
      content,
      stat: { ctime: 1, mtime: 2, size: content.length },
      frontmatter: {},
      tags: [],
    };
  },
  listFiles: async () => ["Note.md"],
  getFileMetadata: async () => ({ ctime: 1, mtime: 2, size: content.length }),
};
const cache = new VaultCacheService(rest);
after(async () => {
  if (typeof cache.close === "function") await cache.close();
  else cache.db.close();
  rmSync(root, { recursive: true, force: true });
});

async function connectReadNote(t, obsidianService, vaultCacheService) {
  const server = new McpServer({ name: "cache-read-test", version: "0" });
  const client = new Client({ name: "cache-read-client", version: "0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await registerObsidianReadNoteTool(server, obsidianService, vaultCacheService);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("headless read reports the start of a cold scan that missed a concurrent edit", async (t) => {
  const previousSource = config.obsidianCacheSource;
  const previousDb = config.obsidianSharedCacheDbPath;
  const previousConcurrency = config.obsidianCacheConcurrency;
  config.obsidianCacheSource = "filesystem";
  config.obsidianSharedCacheDbPath = path.join(root, "first-read.sqlite");
  config.obsidianCacheConcurrency = 1;
  const instance = new VaultCacheService(undefined);
  const note = "FirstRead.md";
  const notePath = path.join(root, note);
  const lastPath = path.join(root, "ZLastRead.md");
  writeFileSync(notePath, "filesystem fixture");
  writeFileSync(lastPath, "last file");
  const scanStartedAt = 1_800_000_000_000;
  const editedAt = scanStartedAt + 1000;
  const scanFinishedAt = editedAt + 1000;
  let now = scanStartedAt;
  t.mock.method(Date, "now", () => now);
  const scanning = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stat = fs.stat;
  t.mock.method(fs, "stat", async (filePath, options) => {
    if (filePath === lastPath) {
      scanning.resolve();
      await release.promise;
    }
    return stat(filePath, options);
  });

  const status = async () => projectPublicRuntimeStatus(await collectRuntimeStatus(instance));
  let read;
  try {
    const client = await connectReadNote(t, undefined, instance);
    const cold = await status();
    assert.equal(cold.sharedCache.lastRefreshAt, undefined);
    assert.equal(cold.headlessRead.refreshing, false);
    assert.equal(cold.headlessRead.newestFileMtimeMs, null);

    read = client.callTool({ name: "obsidian_read_note", arguments: { filePath: note } });
    await Promise.race([scanning.promise, read]);
    const duringScan = await status();
    assert.equal(duringScan.headlessRead.refreshing, true);
    assert.equal(duringScan.sharedCache.lastRefreshAt, undefined);
    assert.equal(duringScan.headlessRead.lastSuccessfulRefreshStartedAt, null);

    now = editedAt;
    writeFileSync(notePath, "edited during the scan");
    utimesSync(notePath, editedAt / 1000, editedAt / 1000);
    now = scanFinishedAt;
    release.resolve();
    const result = await read;
    assert.equal(result.isError, false);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.content, "filesystem fixture");
    const completed = await status();
    assert.equal(completed.sharedCache.lastRefreshAt, scanFinishedAt);
    assert.equal(completed.headlessRead.lastSuccessfulRefreshStartedAt, scanStartedAt);
    assert.deepEqual(payload.provenance, {
      source: "filesystem",
      upstreamSync: "unknown",
      lastSuccessfulPullAt: null,
      lagSecondsUpperBound: null,
      evidenceSource: null,
      lastRefreshAt: scanFinishedAt,
      lastSuccessfulRefreshStartedAt: scanStartedAt,
      refreshOrigin: "process-refresh",
      refreshing: true,
      partial: true,
    });
    await instance.close();
    const restarted = new VaultCacheService(undefined);
    try {
      const evidence = restarted.getRefreshEvidence();
      assert.equal(evidence.refreshOrigin, "startup-snapshot");
      assert.equal(evidence.lastRefreshAt, scanFinishedAt);
      assert.equal(evidence.lastSuccessfulRefreshStartedAt, scanStartedAt);
    } finally {
      await restarted.close();
    }
  } finally {
    release.resolve();
    await read?.catch(() => undefined);
    await instance.close();
    config.obsidianCacheSource = previousSource;
    config.obsidianSharedCacheDbPath = previousDb;
    config.obsidianCacheConcurrency = previousConcurrency;
  }
});

test("live note reads preserve the existing response body", async (t) => {
  const previousMode = config.obsidianRuntimeMode;
  config.obsidianRuntimeMode = "live";
  try {
    const client = await connectReadNote(t, rest, cache);
    const result = await client.callTool({
      name: "obsidian_read_note",
      arguments: { filePath: "Note.md" },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), { content });
    const status = projectPublicRuntimeStatus(await collectRuntimeStatus(cache));
    assert.equal("headlessRead" in status, false);
  } finally {
    config.obsidianRuntimeMode = previousMode;
  }
});

test("another server's scan cannot advance the checkpoint of this process's index", async (t) => {
  const previous = {
    obsidianCacheSource: config.obsidianCacheSource,
    obsidianSharedCacheDbPath: config.obsidianSharedCacheDbPath,
    obsidianVaultPath: config.obsidianVaultPath,
  };
  const vault = mkdtempSync(path.join(root, "shared-index-"));
  Object.assign(config, {
    obsidianCacheSource: "filesystem",
    obsidianSharedCacheDbPath: path.join(root, "shared-index.sqlite"),
    obsidianVaultPath: vault,
  });
  const note = path.join(vault, "Note.md");
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  function changeReplica(seconds) {
    writeFileSync(note, "filesystem fixture");
    utimesSync(note, seconds, seconds);
    now += 1000;
  }
  function assertCheckpoint(cache, lastRefreshAt, mtime, refreshOrigin) {
    assert.equal(cache.getRefreshEvidence().lastRefreshAt, lastRefreshAt);
    assert.equal(cache.getRefreshEvidence().lastSuccessfulRefreshStartedAt, lastRefreshAt);
    assert.equal(cache.getRefreshEvidence().refreshOrigin, refreshOrigin);
    assert.equal(cache.getStats().lastRefreshAt, lastRefreshAt);
    assert.equal(cache.getNewestFileMtimeMs(), mtime * 1000);
  }

  const writer = new VaultCacheService(undefined);
  let reader;
  try {
    changeReplica(1_700_000_001);
    await writer.refreshCache(true);
    const startupRefresh = now;
    reader = new VaultCacheService(undefined);
    changeReplica(1_700_000_002);
    await writer.refreshCache(true);
    assertCheckpoint(reader, startupRefresh, 1_700_000_001, "startup-snapshot");

    await reader.refreshCache(true);
    const localRefresh = now;
    changeReplica(1_700_000_003);
    await writer.refreshCache(true);
    assertCheckpoint(reader, localRefresh, 1_700_000_002, "process-refresh");
  } finally {
    await reader?.close();
    await writer.close();
    Object.assign(config, previous);
  }
});

test("REST incremental updates cannot read excluded notes", async () => {
  const before = fetches;
  await cache.updateCacheForFile("Private/secret.md", context);
  assert.equal(fetches, before);
  assert.equal(await cache.getEntry("/Private/secret.md"), undefined);
});
test("incremental refresh returns a verifiable failure instead of resolving void as success", async () => {
  assert.equal(typeof cache.updateFileVerified, "function");
  fail = true;
  try {
    const result = await cache.updateFileVerified("Note.md", context);
    assert.equal(result.ok, false);
    assert.equal(
      JSON.stringify(result).includes("private upstream failure"),
      false,
    );
  } finally {
    fail = false;
  }
});
test("invalid traversal and binary event paths never reach the backend", async () => {
  assert.equal(typeof cache.updateFileVerified, "function");
  const before = fetches;
  for (const p of [
    "../Note.md",
    "Dir/../../Note.md",
    "image.png",
    "C:/Note.md",
  ])
    assert.equal((await cache.updateFileVerified(p, context)).ok, false);
  assert.equal(fetches, before);
});
test("auto incremental reads select the same filesystem source as a full scan", async () => {
  assert.equal(typeof cache.updateFileVerified, "function");
  const before = fetches;
  config.obsidianCacheSource = "auto";
  writeFileSync(path.join(root, "Local.md"), "local");
  try {
    assert.equal(
      (await cache.updateFileVerified("Local.md", context)).ok,
      true,
    );
    assert.equal((await cache.getEntry("/Local.md")).content, "local");
    assert.equal(fetches, before);
  } finally {
    config.obsidianCacheSource = "rest";
  }
});
test("reconciliation really re-reads same-size same-mtime files", async () => {
  content = "old";
  await cache.refreshCache(true);
  content = "new";
  await cache.refreshCache(true);
  assert.equal((await cache.getEntry("/Note.md")).content, "new");
});
test("failed per-file refresh never reports a fully fresh inventory", async () => {
  fail = true;
  try {
    await cache.refreshCache(true);
    assert.notEqual(cache.getStats().lastRefreshError, null);
  } finally {
    fail = false;
  }
});

test("a slower inventory read cannot overwrite a later incremental refresh", async () => {
  const original = rest.getFileContent;
  let entered;
  const reading = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  content = "old value from scan";
  rest.getFileContent = async (p) => {
    const result = await original(p);
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return result;
  };
  try {
    const scan = cache.refreshCache(true);
    await reading;
    content = "newer value from incremental";
    const update = cache.updateCacheForFile("Note.md", context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([scan, update]);
    assert.equal(
      (await cache.getEntry("/Note.md")).content,
      "newer value from incremental",
    );
  } finally {
    release();
    rest.getFileContent = original;
  }
});
test("a refresh requested during a scan is serviced, not dropped", async () => {
  const original = rest.listFiles;
  let entered;
  const reading = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  rest.listFiles = async () => {
    calls++;
    if (calls === 1) {
      entered();
      await gate;
    }
    return original();
  };
  try {
    const first = cache.refreshCache(true);
    await reading;
    const second = cache.refreshCache(true);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
  } finally {
    release();
    rest.listFiles = original;
  }
});
test("an incomplete REST inventory cannot purge a previously observed note", async () => {
  await cache.refreshCache(true);
  const original = rest.listFiles;
  const { McpError, BaseErrorCode } = await import(
    "../dist/types-global/errors.js"
  );
  rest.listFiles = async () => {
    throw new McpError(BaseErrorCode.NOT_FOUND, "missing subtree");
  };
  try {
    await cache.refreshCache(true);
    assert.ok(await cache.getEntry("/Note.md"));
    assert.equal(cache.getStats().lastRefreshError, "cache_refresh_failed");
  } finally {
    rest.listFiles = original;
  }
});
test("a backend response for another note cannot populate the requested identity", async () => {
  const original = rest.getFileContent;
  rest.getFileContent = async () => ({
    path: "Other.md",
    content: "wrong",
    stat: { mtime: 1, ctime: 1, size: 5 },
  });
  try {
    assert.equal(
      (await cache.updateFileVerified("Target.md", context)).ok,
      false,
    );
    assert.equal(await cache.getEntry("/Target.md"), undefined);
  } finally {
    rest.getFileContent = original;
  }
});

// Review regressions: exercise durable rows and a new service instance, not
// merely the in-memory projection of the writer that noticed the failure.
test("startup removes excluded persisted rows from direct SQL consumers", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const previous = config.obsidianSharedCacheDbPath;
  const dbPath = path.join(root, "excluded-restart.sqlite");
  config.obsidianSharedCacheDbPath = dbPath;
  let instance = new VaultCacheService(rest);
  try {
    instance.db.prepare("INSERT INTO file_cache VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("/Private/secret.md", 1, 2, 6, "fixture", "- [ ] private sentinel", 1);
    await instance.close();
    instance = new VaultCacheService(rest);
    const observer = new DatabaseSync(dbPath);
    try {
      assert.equal(observer.prepare("SELECT count(*) AS n FROM file_cache WHERE path = ?")
        .get("/Private/secret.md").n, 0);
    } finally { observer.close(); }
  } finally { await instance.close(); config.obsidianSharedCacheDbPath = previous; }
});

test("legacy post-write update retries transient REST absence before removing a row", async () => {
  const { McpError, BaseErrorCode } = await import("../dist/types-global/errors.js");
  const original = rest.getFileContent;
  let attempts = 0;
  rest.getFileContent = async p => {
    attempts++;
    if (attempts < 3) throw new McpError(BaseErrorCode.NOT_FOUND, "not indexed yet");
    return original(p);
  };
  try {
    await cache.updateCacheForFile("Note.md", context);
    assert.equal(attempts, 3);
    assert.equal((await cache.getEntry("/Note.md")).content, content);
  } finally { rest.getFileContent = original; }
});

test("transient REST unavailability retries but arbitrary failures do not", async () => {
  const { McpError, BaseErrorCode } = await import("../dist/types-global/errors.js");
  const original = rest.getFileContent;
  let attempts = 0;
  rest.getFileContent = async p => {
    if (++attempts === 1) throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "warming");
    return original(p);
  };
  try {
    assert.equal((await cache.updateFileVerified("Note.md", context)).ok, true);
    assert.equal(attempts, 2);
    attempts = 0;
    rest.getFileContent = async () => { attempts++; throw new Error("permanent"); };
    assert.equal((await cache.updateFileVerified("Note.md", context)).ok, false);
    assert.equal(attempts, 1);
  } finally { rest.getFileContent = original; }
});

test("incomplete refresh survives restart and cannot advance successful-refresh evidence", async () => {
  const previous = config.obsidianSharedCacheDbPath;
  config.obsidianSharedCacheDbPath = path.join(root, "incomplete-restart.sqlite");
  let instance = new VaultCacheService(rest);
  try {
    await instance.refreshCache(true);
    const successfulAt = instance.getStats().lastRefreshAt;
    const { lastSuccessfulRefreshStartedAt: startedAt } = instance.getRefreshEvidence();
    fail = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.refreshCache(true);
    assert.equal(instance.getStats().lastRefreshAt, successfulAt);
    assert.equal(instance.getRefreshEvidence().lastSuccessfulRefreshStartedAt, startedAt);
    await instance.close();
    instance = new VaultCacheService(rest);
    assert.equal(instance.getRefreshEvidence().lastSuccessfulRefreshStartedAt, startedAt);
    assert.equal(instance.isReady(), false);
    assert.equal(instance.getStats().freshness, "uncertain");
    assert.equal(instance.getStats().lastRefreshFailedFiles, 1);
    fail = false;
    await instance.refreshCache(true);
    await instance.close();
    instance = new VaultCacheService(rest);
    assert.equal(instance.isReady(), true);
    assert.equal(instance.getStats().lastRefreshFailedFiles, 0);
  } finally { fail = false; await instance.close(); config.obsidianSharedCacheDbPath = previous; }
});

test("interrupted refresh and explicit uncertainty remain uncertain after restart", async () => {
  const previous = config.obsidianSharedCacheDbPath;
  config.obsidianSharedCacheDbPath = path.join(root, "uncertain-restart.sqlite");
  let instance = new VaultCacheService(rest);
  try {
    await instance.refreshCache(true);
    instance.markFreshnessUncertain();
    await instance.close();
    instance = new VaultCacheService(rest);
    assert.equal(instance.getStats().freshness, "uncertain");
    await instance.refreshCache(true);
    instance.db.prepare("INSERT OR REPLACE INTO shared_cache_metadata VALUES (?, ?, ?)")
      .run("refresh_state", "building", Date.now());
    await instance.close();
    instance = new VaultCacheService(rest);
    assert.equal(instance.isReady(), false);
    assert.equal(instance.getStats().freshness, "uncertain");
  } finally { await instance.close(); config.obsidianSharedCacheDbPath = previous; }
});


test("buildVaultCache reproofs an uncertain ready inventory instead of short-circuiting", async () => {
  const previous=config.obsidianSharedCacheDbPath;
  config.obsidianSharedCacheDbPath=path.join(root,"uncertain-build-reproof.sqlite");
  const instance=new VaultCacheService(rest);
  try {
    content="old";
    await instance.refreshCache(true);
    const before=fetches;
    content="new";
    instance.markFreshnessUncertain();
    assert.equal(instance.isReady(),false);
    await instance.buildVaultCache();
    assert.ok(fetches>before);
    assert.equal((await instance.getEntry("/Note.md")).content,"new");
    assert.equal(instance.isReady(),true);
  } finally {
    await instance.close();
    config.obsidianSharedCacheDbPath=previous;
  }
});

test("public readiness drops immediately for pending events and explicit uncertainty", async () => {
  const previous=config.obsidianSharedCacheDbPath;
  config.obsidianSharedCacheDbPath=path.join(root,"public-readiness.sqlite");
  const instance=new VaultCacheService(rest);
  try {
    await instance.refreshCache(true);
    assert.equal(instance.isReady(),true);
    assert.equal(instance.getStats().ready,true);
    instance.markEventWorkPending();
    assert.equal(instance.isReady(),false);
    assert.equal(instance.getReadinessStatus(),"building");
    assert.equal(instance.getStats().ready,false);
    instance.settleEventWork();
    assert.equal(instance.isReady(),true);
    instance.markFreshnessUncertain();
    assert.equal(instance.isReady(),false);
    assert.equal(instance.getReadinessStatus(),"error");
    assert.equal(instance.getStats().ready,false);
  } finally {
    await instance.close();
    config.obsidianSharedCacheDbPath=previous;
  }
});

test("queued refresh keeps public readiness false until serialized execution settles", async () => {
  const previous=config.obsidianSharedCacheDbPath;
  config.obsidianSharedCacheDbPath=path.join(root,"queued-refresh-readiness.sqlite");
  const instance=new VaultCacheService(rest);
  const original=rest.getFileContent;
  let entered;
  const blocked=new Promise(resolve=>{entered=resolve;});
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let blockOnce=false;
  rest.getFileContent=async file=>{
    if(blockOnce){
      blockOnce=false;
      entered();
      await gate;
    }
    return original(file);
  };
  try {
    await instance.refreshCache(true);
    assert.equal(instance.isReady(),true);

    blockOnce=true;
    const update=instance.updateFileVerified("Note.md",context);
    await blocked;

    const refresh=instance.refreshCache(true);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(instance.isReady(),false);
    assert.equal(instance.getReadinessStatus(),"building");
    assert.equal(instance.getStats().ready,false);
    assert.equal(instance.getStats().freshness,"uncertain");

    let settled=false;
    const wait=instance.waitUntilReady(2000).finally(()=>{settled=true;});
    wait.catch(()=>undefined);
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(settled,false);

    release();
    await update;
    await refresh;
    assert.equal(await wait,true);
    assert.equal(instance.isReady(),true);
    assert.equal(instance.getStats().freshness,"observed");
  } finally {
    rest.getFileContent=original;
    release?.();
    await instance.close();
    config.obsidianSharedCacheDbPath=previous;
  }
});

test("accepted pending work is durable before an update and completion cannot clear unrelated uncertainty", async () => {
  const previous=config.obsidianSharedCacheDbPath;
  config.obsidianSharedCacheDbPath=path.join(root,"pending-event-restart.sqlite");
  let instance=new VaultCacheService(rest);
  try {
    await instance.refreshCache(true);
    assert.equal(typeof instance.markEventWorkPending,"function");
    instance.markEventWorkPending();
    await instance.close();
    instance=new VaultCacheService(rest);
    assert.equal(instance.isReady(),false);
    assert.equal(instance.getStats().freshness,"uncertain");
    await instance.refreshCache(true);
    instance.markEventWorkPending();
    instance.markFreshnessUncertain();
    instance.settleEventWork();
    assert.equal(instance.getStats().freshness,"uncertain");
    await instance.refreshCache(true);
    instance.markEventWorkPending();
    instance.settleEventWork();
    await instance.close();
    instance=new VaultCacheService(rest);
    assert.equal(instance.getStats().freshness,"observed");
  } finally { await instance.close(); config.obsidianSharedCacheDbPath=previous; }
});

test('qualification workflow explicitly checks out the pull-request head', async () => {
  const fs = await import('node:fs');
  const yaml = (await import('js-yaml')).default;
  const flow = yaml.load(fs.readFileSync(new URL('../.github/workflows/cache-events.yml', import.meta.url), 'utf8'));
  for (const job of Object.values(flow.jobs)) {
    const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 1);
    assert.equal(checkouts[0].with?.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  }
});
