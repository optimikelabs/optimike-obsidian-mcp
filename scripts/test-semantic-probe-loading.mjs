import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "semantic-probe-loading-"));
const source = path.join(root, "source");
const db = path.join(root, "cache.sqlite");
await mkdir(source);
process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = source;
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = db;
process.env.MCP_LOG_LEVEL = "error";
process.env.ENABLE_QUERY_EMBEDDING = "true";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { collectCapabilityManifest, SEMANTIC_INITIAL_LOAD_GRACE_MS } =
  await import("../dist/services/capabilityManifest.js");
const { SemanticCacheService } = await import(
  "../dist/services/semanticCache.js"
);

function options(
  semanticIndex,
  semanticLoading,
  semanticQueryProvider = async () => "verified",
) {
  return {
    profile: "full",
    registrationMode: "live",
    runtimeStatus: {
      semanticCache: { enabled: true },
      sharedCache: { ready: true },
    },
    obsidianService: undefined,
    vaultCacheAvailable: true,
    governedRuntimes: { note: false, canvas: false, base: false, asset: false },
    probes: {
      localRest: async () => ({ authenticated: true }),
      operon: async () => ({ ok: false }),
      semanticIndex,
      semanticLoading,
      semanticQueryProvider,
    },
  };
}
const slowProbe = () =>
  new Promise((resolve) =>
    setTimeout(() => resolve({ vectorCount: 7459, embedderReady: true }), 3000),
  );
async function semantic(opts) {
  const start = performance.now();
  const manifest = await collectCapabilityManifest(opts);
  return {
    capability: manifest.capabilities.find((c) => c.id === "semantic-search"),
    elapsed: performance.now() - start,
  };
}

try {
  // A cold load of an index this cache already validated: degraded, usable.
  const loading = await semantic(
    options(slowProbe, () => ({
      startedAt: Date.now(),
      persistedVectorCount: 7459,
    })),
  );
  assert.equal(loading.capability.state, "degraded");
  assert.equal(loading.capability.available, true);
  assert.equal(loading.capability.authorized, true);
  assert.equal(loading.capability.reasonCode, "semantic_index_loading");
  assert.equal(loading.capability.nextAction, "wait_for_semantic_index");
  assert.ok(
    loading.elapsed >= 2400 && loading.elapsed < 2900,
    "the health inspection keeps its bounded wait",
  );

  // A persisted index is not enough: the query provider must be buildable now.
  const noProvider = await semantic(
    options(
      slowProbe,
      () => ({ startedAt: Date.now(), persistedVectorCount: 7459 }),
      async () => "unusable",
    ),
  );
  assert.equal(noProvider.capability.state, "unavailable");
  assert.equal(noProvider.capability.reasonCode, "semantic_embedder_unavailable");
  assert.equal(noProvider.capability.nextAction, "configure_query_embedder");

  // A provider check that does not finish is no evidence either.
  // Probe deadline timers are unref'd; keep the loop alive while they run.
  const keepAlive = setInterval(() => {}, 1_000);
  const unknownProvider = await semantic(
    options(
      slowProbe,
      () => ({ startedAt: Date.now(), persistedVectorCount: 7459 }),
      () => new Promise(() => {}),
    ),
  );
  assert.equal(unknownProvider.capability.state, "unavailable");
  assert.equal(unknownProvider.capability.reasonCode, "semantic_index_loading");
  assert.equal(unknownProvider.capability.nextAction, "wait_for_semantic_index");
  clearInterval(keepAlive);

  // A provider that is buildable but not yet exercised stays usable (degraded).
  const unverified = await semantic(
    options(
      slowProbe,
      () => ({ startedAt: Date.now(), persistedVectorCount: 7459 }),
      async () => "unverified",
    ),
  );
  assert.equal(unverified.capability.state, "degraded");
  assert.equal(unverified.capability.reasonCode, "semantic_index_loading");

  // A first load with no persisted evidence is named, but not certified.
  const firstLoad = await semantic(
    options(slowProbe, () => ({ startedAt: Date.now(), persistedVectorCount: 0 })),
  );
  assert.equal(firstLoad.capability.state, "unavailable");
  assert.equal(firstLoad.capability.reasonCode, "semantic_index_loading");
  assert.equal(firstLoad.capability.nextAction, "wait_for_semantic_index");

  // A load older than the grace period is a real timeout.
  const stale = await semantic(
    options(slowProbe, () => ({
      startedAt: Date.now() - SEMANTIC_INITIAL_LOAD_GRACE_MS - 1000,
      persistedVectorCount: 7459,
    })),
  );
  assert.equal(stale.capability.state, "unavailable");
  assert.equal(stale.capability.reasonCode, "semantic_probe_timed_out");

  // No load in flight: the timeout contract is unchanged.
  const idle = await semantic(options(slowProbe, () => null));
  assert.equal(idle.capability.reasonCode, "semantic_probe_timed_out");

  // Once the cache is loaded the probe answers in time and the capability is ready.
  const loaded = await semantic(
    options(async () => ({ vectorCount: 7459, embedderReady: true }), () => ({
      startedAt: Date.now(),
      persistedVectorCount: 7459,
    })),
  );
  assert.equal(loaded.capability.state, "ready");
  assert.equal(loaded.capability.reasonCode, "ready");

  // The real cache reports an in-flight load and its persisted evidence.
  await writeFile(
    path.join(source, "vectors.json"),
    JSON.stringify([{ path: "Test.md", embedding: [0.1, 0.3] }]),
    "utf8",
  );
  const service = new SemanticCacheService(source, db, 60000);
  try {
    assert.equal(service.loadInProgress(), null, "idle cache reports no load");
    await service.getSnapshot();
    assert.equal(service.loadInProgress(), null, "a finished load is released");

    await writeFile(
      path.join(source, "vectors.json"),
      JSON.stringify([{ path: "Next.md", embedding: [0.2, 0.4] }]),
      "utf8",
    );
    service.forceRefresh();
    const actualLoad = service.loadSource.bind(service);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    service.loadSource = async (...args) => {
      await gate;
      return actualLoad(...args);
    };
    const before = Date.now();
    const probing = service.probeReadiness();
    const inFlight = service.loadInProgress();
    assert.ok(inFlight, "a readiness validation in flight is reported");
    assert.ok(inFlight.startedAt >= before && inFlight.startedAt <= Date.now());
    assert.equal(
      inFlight.persistedVectorCount,
      1,
      "the persisted manifest of the previous load is the evidence",
    );
    release();
    const observed = await probing;
    assert.equal(observed.vectorCount, 1);
    assert.equal(service.loadInProgress(), null, "the load marker is released");
    service.loadSource = actualLoad;

    // Warm database, cold memory (a restart): the startup query and a probe
    // share one cache decode instead of two.
    await service.getSnapshot();
    service.forceRefresh();
    let decodes = 0;
    const decode = service.loadSnapshotFromDb.bind(service);
    service.loadSnapshotFromDb = (manifest) => {
      decodes += 1;
      return decode(manifest);
    };
    const [snapshot, joined] = await Promise.all([
      service.getSnapshot(),
      service.probeReadiness(),
    ]);
    assert.equal(decodes, 1, "the probe joins the in-flight query snapshot");
    assert.equal(joined.vectorCount, snapshot.items.length);
    service.loadSnapshotFromDb = decode;
  } finally {
    service.db.close();
  }

  console.log(
    "PASS semantic probe during a cold cache load: degraded semantic_index_loading with persisted evidence, unavailable without, timeout once stale, ready once loaded",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
