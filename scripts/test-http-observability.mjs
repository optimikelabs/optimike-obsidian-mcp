#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";

process.env.OBSIDIAN_RUNTIME_MODE ??= "headless-readonly";
process.env.OBSIDIAN_VAULT ??= process.cwd();
const {
  buildHealthSnapshot,
  sanitizeExternalCorrelationId,
  sanitizeLoggedOperationName,
  wrapResponseForCompletion,
} = await import("../dist/mcp-server/transports/httpObservability.js");

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

const directLiveWithoutCache = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "live",
  vaultPath: missingVault,
  writeMode: "full",
  staleAfterMs: 60_000,
  getLiveApiObservation: () => ({
    available: true,
    observedAt: now - 1000,
  }),
});
assert.equal(directLiveWithoutCache.state, "ready");
assert.equal(directLiveWithoutCache.provenance.source, "live-obsidian");
assert.equal(directLiveWithoutCache.capabilities.liveObsidianReads, true);
assert.equal(directLiveWithoutCache.capabilities.mutations, true);
assert.equal(directLiveWithoutCache.capabilities.cacheReads, false);

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

const refreshFailed = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "headless-readonly",
  vaultPath,
  cacheSource: "filesystem",
  staleAfterMs: 60_000,
  vaultCacheService: cache({
    status: "ready",
    ready: true,
    lastRefreshAt: new Date(now - 5000).toISOString(),
    lastRefreshError: "SECRET INTERNAL CACHE FAILURE",
    refreshSource: "filesystem",
    configuredRefreshSource: "filesystem",
    cachedFileCount: 2,
  }),
});
assert.equal(refreshFailed.state, "degraded");
assert.ok(refreshFailed.reasons.includes("cache_refresh_failed"));
assert.equal(
  JSON.stringify(refreshFailed).includes("SECRET INTERNAL CACHE FAILURE"),
  false,
);

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

const hybridWithoutSource = buildHealthSnapshot({
  now: () => now,
  runtimeMode: "hybrid",
  vaultPath,
  writeMode: "full",
});
assert.equal(hybridWithoutSource.state, "critical");
assert.equal(hybridWithoutSource.ready, false);
assert.ok(
  hybridWithoutSource.reasons.includes("no_verified_live_or_fallback_source"),
);

assert.equal(
  sanitizeExternalCorrelationId("incident-42:retry.1"),
  "incident-42:retry.1",
);
assert.equal(sanitizeExternalCorrelationId(" contains spaces "), undefined);
assert.equal(sanitizeExternalCorrelationId("Bearer secret"), undefined);
assert.equal(sanitizeExternalCorrelationId("x".repeat(129)), undefined);
assert.equal(sanitizeLoggedOperationName("tools/call"), "tools/call");
assert.equal(
  sanitizeLoggedOperationName("obsidian_read_note"),
  "obsidian_read_note",
);
assert.equal(
  sanitizeLoggedOperationName("SECRET\nDOCUMENT CONTENT"),
  undefined,
);
assert.equal(sanitizeLoggedOperationName("x".repeat(129)), undefined);

let streamController;
const completionEvents = [];
const wrappedStreamResponse = wrapResponseForCompletion(
  new Response(
    new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    }),
  ),
  (completion) => completionEvents.push(completion),
);
const pendingBody = wrappedStreamResponse.text();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(
  completionEvents,
  [],
  "a response object is not a completed body stream",
);
streamController.enqueue(new TextEncoder().encode("done"));
streamController.close();
assert.equal(await pendingBody, "done");
assert.deepEqual(completionEvents, ["response"]);

const cancellationEvents = [];
const cancellableResponse = wrapResponseForCompletion(
  new Response(new ReadableStream({ pull() {} })),
  (completion) => cancellationEvents.push(completion),
);
await cancellableResponse.body.cancel("test cancellation");
assert.deepEqual(cancellationEvents, ["cancelled"]);

let failingController;
const failureEvents = [];
const failingResponse = wrapResponseForCompletion(
  new Response(
    new ReadableStream({
      start(controller) {
        failingController = controller;
      },
    }),
  ),
  (completion) => failureEvents.push(completion),
);
const failingBody = failingResponse.text();
failingController.error(new Error("synthetic stream failure"));
await assert.rejects(failingBody, /synthetic stream failure/u);
assert.deepEqual(failureEvents, ["exception"]);

for (const snapshot of [
  live,
  stale,
  headless,
  degradedCache,
  refreshFailed,
  headlessWithoutCache,
  headlessBuildingCache,
  critical,
  directLiveWithoutCache,
  hybridWithoutSource,
]) {
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(vaultPath), false);
}

console.log(
  "PASS: readiness distinguishes direct live API health from optional cache health, hybrid requires a usable source, refresh failures degrade without leaking details, operation names are bounded, and completion waits for streamed response finish or cancellation",
);
