#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";

process.env.OBSIDIAN_RUNTIME_MODE ??= "headless-readonly";
process.env.OBSIDIAN_VAULT ??= process.cwd();
const { buildHealthSnapshot, sanitizeExternalCorrelationId } =
  await import("../dist/mcp-server/transports/httpObservability.js");

const now = Date.parse("2026-07-29T12:00:00.000Z");
const vaultPath = process.cwd();
const missingVault = path.join(
  process.cwd(),
  ".tmp",
  "observability-missing-vault",
);

function cache(stats) {
  return { getStats: () => stats };
}

const live = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "live",
  vaultPath,
  writeMode: "readwrite",
  staleAfterMs: 60_000,
  vaultCacheService: cache({
    status: "ready",
    lastRefreshAt: new Date(now - 5000).toISOString(),
    refreshSource: "rest",
    configuredRefreshSource: "rest",
    cachedFileCount: 10,
  }),
});
assert.equal(live.state, "ready");
assert.equal(live.provenance.source, "live-obsidian");
assert.equal(live.provenance.origin, "obsidian_api");
assert.equal(live.provenance.stale, false);
assert.equal(live.capabilities.liveObsidianReads, true);
assert.equal(live.capabilities.mutations, true);

const stale = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "hybrid",
  vaultPath,
  writeMode: "readonly",
  staleAfterMs: 60_000,
  vaultCacheService: cache({
    status: "ready",
    lastRefreshAt: new Date(now - 5 * 60_000).toISOString(),
    refreshSource: "rest",
    configuredRefreshSource: "rest",
    cachedFileCount: 10,
  }),
});
assert.equal(stale.state, "degraded");
assert.equal(stale.ready, true);
assert.equal(stale.provenance.source, "snapshot");
assert.equal(stale.provenance.stale, true);
assert.notEqual(
  stale.provenance.source,
  "live-obsidian",
  "a stale fallback must never be presented as live",
);

const headless = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "headless-readonly",
  vaultPath,
  cacheSource: "filesystem",
  writeMode: "readonly",
  vaultCacheService: cache({
    status: "ready",
    refreshSource: "filesystem",
    configuredRefreshSource: "filesystem",
    cachedFileCount: 3,
  }),
});
assert.equal(headless.state, "ready");
assert.equal(headless.provenance.source, "filesystem");
assert.equal(headless.dependencies.obsidianDesktop.required, false);
assert.equal(headless.capabilities.mutations, false);

const degradedCache = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "headless-readonly",
  vaultPath,
  cacheSource: "filesystem",
  staleAfterMs: 60_000,
  vaultCacheService: cache({
    status: "ready",
    lastRefreshAt: new Date(now - 5 * 60_000).toISOString(),
    refreshSource: "filesystem",
    configuredRefreshSource: "filesystem",
    cachedFileCount: 2,
  }),
});
assert.equal(degradedCache.state, "degraded");
assert.equal(degradedCache.critical, false);
assert.ok(degradedCache.reasons.includes("fallback_data_stale"));

const headlessWithoutCache = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "headless-readonly",
  vaultPath,
  cacheSource: "filesystem",
  vaultCacheService: undefined,
});
assert.equal(headlessWithoutCache.state, "critical");
assert.equal(headlessWithoutCache.ready, false);
assert.equal(headlessWithoutCache.capabilities.filesystemReads, false);
assert.equal(headlessWithoutCache.capabilities.cacheReads, false);
assert.ok(headlessWithoutCache.reasons.includes("headless_cache_unavailable"));

const headlessBuildingCache = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "headless-readonly",
  vaultPath,
  cacheSource: "filesystem",
  vaultCacheService: cache({
    status: "building",
    building: true,
    configuredRefreshSource: "filesystem",
    cachedFileCount: 0,
  }),
});
assert.equal(headlessBuildingCache.state, "critical");
assert.equal(
  headlessBuildingCache.dependencies.sharedCache.reason,
  "cache_building",
);

const critical = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "headless-readonly",
  vaultPath: missingVault,
  cacheSource: "filesystem",
  vaultCacheService: undefined,
});
assert.equal(critical.state, "critical");
assert.equal(critical.ready, false);
assert.equal(critical.provenance.source, "unknown");
assert.ok(critical.reasons.includes("headless_vault_and_cache_unavailable"));

const liveWithoutProof = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "live",
  vaultPath: missingVault,
  vaultCacheService: undefined,
});
assert.equal(liveWithoutProof.state, "critical");
assert.equal(liveWithoutProof.capabilities.liveObsidianReads, false);

assert.equal(
  sanitizeExternalCorrelationId("incident-42:retry.1"),
  "incident-42:retry.1",
);
assert.equal(sanitizeExternalCorrelationId(" contains spaces "), undefined);
assert.equal(sanitizeExternalCorrelationId("Bearer secret"), undefined);
assert.equal(sanitizeExternalCorrelationId("x".repeat(129)), undefined);

for (const snapshot of [
  live,
  stale,
  headless,
  degradedCache,
  headlessWithoutCache,
  headlessBuildingCache,
  critical,
]) {
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(vaultPath), false);
}

console.log(
  "PASS: readiness requires a usable cache-backed read path, the real REST cache vocabulary maps to live Obsidian, stale data is never labeled live, dependency and capability states are sanitized, and external correlation identifiers are strictly bounded",
);
