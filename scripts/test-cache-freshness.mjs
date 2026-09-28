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
