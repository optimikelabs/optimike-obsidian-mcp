import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, after } from "node:test";
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
const context = {
  requestId: "cache-freshness-test",
  timestamp: new Date(0).toISOString(),
  operation: "test",
};
let fetches = 0;
let fail = false;
let content = "old";
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
    fail = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    await instance.refreshCache(true);
    assert.equal(instance.getStats().lastRefreshAt, successfulAt);
    await instance.close();
    instance = new VaultCacheService(rest);
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
