#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "semantic-readiness-"));
const source = path.join(root, ".smart-env");
const dbPath = path.join(root, "cache.sqlite");
await mkdir(source, { recursive: true });
const vectorFile = path.join(source, "vectors.json");
await writeFile(
  vectorFile,
  JSON.stringify([{ path: "Fixture.md", embedding: [0.25, 0.75] }]),
  "utf8",
);

process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = root;
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = dbPath;
process.env.LOGS_DIR = path.join(process.cwd(), "logs");
process.env.MCP_LOG_LEVEL = "error";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { SemanticCacheService } = await import(
  "../dist/services/semanticCache.js"
);
const service = new SemanticCacheService(source, dbPath, 60_000);

try {
  const observed = await service.probeReadiness();
  assert.equal(observed.vectorCount, 1);
  assert.equal(
    service.getStats().manifest,
    null,
    "the read-only readiness probe must not persist or refresh a manifest",
  );

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.vectorCount, 1);
  assert.equal(service.getStats().manifest.vectorCount, 1);

  service.forceRefresh();
  await writeFile(vectorFile, "{ malformed semantic source", "utf8");
  await assert.rejects(
    () => service.probeReadiness(),
    /No embeddings found/u,
    "a stale persisted manifest must not make a malformed current source ready",
  );
  assert.equal(
    service.getStats().manifest.vectorCount,
    1,
    "the failed readiness probe must not rewrite the persisted cache",
  );
} finally {
  service.db.close();
  await rm(root, { recursive: true, force: true });
}

console.log(
  "Semantic cache readiness probe validates the current source without mutation.",
);
