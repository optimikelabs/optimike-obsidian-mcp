#!/usr/bin/env node

import assert from "node:assert/strict";

process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { projectPublicRuntimeMaintenanceResult, projectPublicRuntimeStatus } =
  await import("../dist/services/runtimeState.js");

const windowsVaultMarker = "C:\\P0-RUNTIME-PRIVATE\\Vault";
const windowsCacheMarker =
  "C:\\P0-RUNTIME-PRIVATE\\Vault\\.obsidian\\optimike-mcp\\shared.sqlite";
const apiUrlMarker = "https://p0-runtime-api.private.example.test/v1";
const baseUrlMarker = "https://p0-runtime-base.private.example.test/embeddings";
const callerMarker = "P0-RUNTIME-CALLER-MARKER";
const sensitiveMarkers = [
  windowsVaultMarker,
  windowsCacheMarker,
  apiUrlMarker,
  baseUrlMarker,
  callerMarker,
];

const internalStatus = {
  ok: true,
  pid: 4242,
  transport: callerMarker,
  runtimeMode: callerMarker,
  runtime: {
    packageVersion: "3.1.2",
    nodeVersion: "v24.0.0",
    cwd: windowsVaultMarker,
    projectRoot: windowsVaultMarker,
    entrypoint: `${windowsVaultMarker}\\dist\\index.js`,
    git: { sha: "a".repeat(40), shortSha: "aaaaaaa" },
    processUptimeSec: 60,
    dist: {
      index: {
        path: `${windowsVaultMarker}\\dist\\index.js`,
        exists: true,
        sizeBytes: 100,
      },
      stdioProxy: {
        path: `${windowsVaultMarker}\\dist\\stdio-proxy.js`,
        exists: true,
        sizeBytes: 101,
      },
      isNewerThanProcess: false,
    },
    configHash: "unsafe-unkeyed-config-hash",
    configFields: {
      obsidianVaultPath: windowsVaultMarker,
      obsidianSharedCacheDbPath: windowsCacheMarker,
      obsidianBaseUrl: apiUrlMarker,
      openaiBaseUrl: baseUrlMarker,
      apiKey: callerMarker,
    },
  },
  sharedCache: {
    dbPath: windowsCacheMarker,
    dbExists: true,
    dbSizeBytes: 512,
    dbFileCount: 3,
    dbTaskCacheFileCount: 2,
    dbSemanticVectorCount: 1,
    ready: true,
    building: false,
    status: callerMarker,
    refreshSource: callerMarker,
    configuredRefreshSource: callerMarker,
    schemaVersion: callerMarker,
    lastRefreshError: `${callerMarker}: ${windowsVaultMarker}`,
  },
  semanticCache: {
    enabled: true,
    smartEnvDir: `${windowsVaultMarker}\\.smart-env`,
    ttlMs: 60000,
    manifest: {
      sourceSignature: callerMarker,
      sourceFileCount: 4,
      vectorCount: 5,
      dominantModel: callerMarker,
      dominantDim: 1536,
    },
  },
  degradedMode: {
    readOnlyWhenRestUnavailable: ["obsidian_read_note", "query_tasks"],
    writeToolsRequireApi: true,
  },
  writePolicy: {
    mode: callerMarker,
    guardedMaxWriteChars: 100000,
    guardedMaxBatchOperations: 25,
    protectedFrontmatterKeys: [callerMarker],
  },
};

function assertRedacted(value, label) {
  const serialized = JSON.stringify(value);
  for (const marker of sensitiveMarkers) {
    assert.equal(
      serialized.includes(marker),
      false,
      `${label} leaked private marker ${marker}`,
    );
  }
}

const status = projectPublicRuntimeStatus(internalStatus);
assertRedacted(status, "runtime status");
assert.equal(status.runtime.git.revision, "aaaaaaa");
assert.equal(
  "fingerprint" in status.runtime.configuration,
  false,
  "public status must not expose a stable configuration correlator",
);
assert.equal(status.sharedCache.lastRefreshFailed, true);
assert.equal(status.semanticCache.manifest?.dominantDimension, 1536);
assert.equal(status.degradedMode.readOnlyToolCount, 2);
assert.equal(status.writePolicy.protectedFrontmatterKeyCount, 1);

const maintenance = projectPublicRuntimeMaintenanceResult("refresh_all", {
  action: "refresh_all",
  sharedCache: internalStatus.sharedCache,
  semanticCache: internalStatus.semanticCache,
  tasksCache: { sourceFileCount: 3, taskFileCount: 2 },
});
assertRedacted(maintenance, "runtime maintenance");
assert.deepEqual(maintenance.tasksCache, {
  sourceFileCount: 3,
  taskFileCount: 2,
});

const maintenanceMode = projectPublicRuntimeMaintenanceResult(
  "run_maintenance",
  {
    action: "run_maintenance",
    sharedCache: {
      vacuum: true,
      analyze: true,
      checkpoint: callerMarker,
    },
  },
);
assertRedacted(maintenanceMode, "runtime maintenance mode");
assert.equal(maintenanceMode.sharedCache.checkpoint, undefined);

console.log("Public runtime status redaction contract passed.");
