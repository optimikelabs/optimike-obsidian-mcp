#!/usr/bin/env node

import assert from "node:assert/strict";

process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { projectCapabilityManifest } = await import(
  "../dist/services/capabilityManifest.js"
);
const { compileToolProfileNames } = await import(
  "../dist/mcp-server/toolProfiles.js"
);

const privateMarkers = [
  "C:\\private-vault\\secret.md",
  "https://private.example.test:27124",
  "private-api-key-8e90",
  "binding-fingerprint-private",
  "private note body",
];

const atomicReady = {
  ok: true,
  contractVersion: 1,
  plugin: { id: "optimike-atomic-write", version: "1.0.0" },
  backend: {
    kind: "obsidian-vault-process",
    bindingFingerprint: privateMarkers[3],
    atomicCas: true,
    writeEnabled: true,
    canvasAtomicCas: true,
    canvasWriteEnabled: true,
  },
  limits: { markdownOnly: true },
};

const baseReady = {
  ok: true,
  contractVersion: 1,
  plugin: { id: "optimike-bases-bridge", version: "1.0.0" },
  backend: {
    kind: "obsidian-vault-process-base",
    bindingFingerprint: privateMarkers[3],
    atomicCas: true,
    writeEnabled: true,
  },
  limits: { baseOnly: true, sourcePreservingCompilerRequired: true },
  migration: { legacyConfigWritesEnabled: false },
};

function operonReady(overrides = {}) {
  return {
    ok: true,
    source: "operon-live",
    stale: false,
    live: {
      ok: true,
      bridge: {
        mode: "read-write",
        mutationsEnabled: true,
        ...(overrides.bridge ?? {}),
      },
      operon: {
        present: true,
        compatible: true,
        ...(overrides.operon ?? {}),
      },
      index: {
        ready: true,
        duplicateConflictCount: 0,
        ...(overrides.index ?? {}),
      },
      capabilities: {
        list: true,
        query: true,
        adopt: true,
        periodicCreate: true,
        periodicUpdate: true,
        create: true,
        update: true,
        transition: true,
        relationshipMutation: true,
        recurrenceMutation: true,
        convert: true,
        relocate: true,
        recovery: true,
        ...(overrides.capabilities ?? {}),
      },
      unsafePath: privateMarkers[0],
      unsafeUrl: privateMarkers[1],
      unsafeSecret: privateMarkers[2],
      unsafeContent: privateMarkers[4],
    },
  };
}

function input({
  profile = "full",
  registrationMode = "live",
  transport = "stdio",
  cacheReady = true,
  semanticEnabled = true,
  queryEmbeddingEnabled = true,
  operonMutationsEnabled = true,
  writeMode = "full",
  operonAllowedPathPrefixesConfigured = false,
  localRest = { state: "ready", value: { authenticated: true } },
  atomicWrite = { state: "ready", value: atomicReady },
  baseAtomicWrite = { state: "ready", value: baseReady },
  operon = { state: "ready", value: operonReady() },
  admission = {},
} = {}) {
  const toolNames = compileToolProfileNames({
    profile,
    registrationMode,
    availableStaticRequirements: ["vault-cache"],
  });
  return {
    profile,
    registrationMode,
    profileToolNames: toolNames,
    modeToolNames: toolNames,
    visibleToolNames: toolNames,
    transport,
    cacheReady,
    semanticEnabled,
    queryEmbeddingEnabled,
    operonMutationsEnabled,
    writeMode,
    operonAllowedPathPrefixesConfigured,
    localRest,
    atomicWrite,
    baseAtomicWrite,
    operon,
    admission: {
      inFlight: 0,
      queued: 0,
      rejectedQueueFull: 0,
      rejectedIdentityQueueFull: 0,
      timedOut: 0,
      cancelled: 0,
      ...admission,
    },
  };
}

function capability(manifest, id) {
  const found = manifest.capabilities.find((item) => item.id === id);
  assert.ok(found, `missing capability ${id}`);
  return found;
}

const ready = projectCapabilityManifest(input());
assert.equal(ready.contractVersion, 1);
assert.equal(ready.capabilities.length, 9);
assert.equal(ready.summary.ready, 9);
assert.equal(ready.admission.state, "not-applicable");
for (const item of ready.capabilities) {
  assert.equal(item.discoverable, true, item.id);
  assert.equal(item.available, true, item.id);
  assert.equal(item.authorized, true, item.id);
  assert.equal(item.state, "ready", item.id);
}

const standard = projectCapabilityManifest(input({ profile: "standard" }));
assert.equal(capability(standard, "governed-note-write").state, "ready");
assert.equal(capability(standard, "governed-frontmatter-write").state, "ready");
assert.equal(capability(standard, "governed-canvas-write").state, "hidden");
assert.equal(capability(standard, "governed-canvas-write").available, true);
assert.equal(capability(standard, "governed-canvas-write").authorized, true);
assert.equal(capability(standard, "governed-base-write").state, "hidden");
assert.equal(capability(standard, "operon-write").reasonCode, "profile_hidden");

const headlessStandardInput = input({
  profile: "standard",
  registrationMode: "headless-readonly",
  atomicWrite: { state: "unavailable" },
  baseAtomicWrite: { state: "unavailable" },
});
headlessStandardInput.profileToolNames = compileToolProfileNames({
  profile: "standard",
  registrationMode: "live",
  availableStaticRequirements: ["vault-cache"],
});
const headlessStandard = projectCapabilityManifest(headlessStandardInput);
assert.equal(
  capability(headlessStandard, "governed-note-write").reasonCode,
  "runtime_mode_unavailable",
);
assert.equal(
  capability(headlessStandard, "governed-note-write").nextAction,
  "use_live_runtime",
);

const missingRuntimeInput = input({ profile: "standard" });
missingRuntimeInput.visibleToolNames =
  missingRuntimeInput.visibleToolNames.filter(
    (name) => !name.startsWith("obsidian_note_replace_"),
  );
const missingRuntime = projectCapabilityManifest(missingRuntimeInput);
assert.equal(
  capability(missingRuntime, "governed-note-write").reasonCode,
  "runtime_not_initialized",
);
assert.equal(
  capability(missingRuntime, "governed-note-write").nextAction,
  "restart_mcp_runtime",
);

const tasksGrantPending = projectCapabilityManifest(
  input({
    profile: "tasks",
    operon: {
      state: "ready",
      value: operonReady({
        bridge: { mode: "read-only", mutationsEnabled: false },
      }),
    },
  }),
);
assert.equal(capability(tasksGrantPending, "operon-read").state, "ready");
assert.deepEqual(
  {
    discoverable: capability(tasksGrantPending, "operon-write").discoverable,
    available: capability(tasksGrantPending, "operon-write").available,
    authorized: capability(tasksGrantPending, "operon-write").authorized,
    state: capability(tasksGrantPending, "operon-write").state,
    reasonCode: capability(tasksGrantPending, "operon-write").reasonCode,
    nextAction: capability(tasksGrantPending, "operon-write").nextAction,
  },
  {
    discoverable: true,
    available: true,
    authorized: false,
    state: "blocked",
    reasonCode: "operon_mutations_disabled",
    nextAction: "enable_operon_mutations",
  },
);

const partialOperon = projectCapabilityManifest(
  input({
    profile: "tasks",
    operon: {
      state: "ready",
      value: operonReady({
        capabilities: { transition: false, recurrenceMutation: false },
      }),
    },
  }),
);
const partialWrite = capability(partialOperon, "operon-write");
assert.equal(partialWrite.available, true);
assert.equal(partialWrite.authorized, false);
assert.equal(partialWrite.state, "degraded");
assert.equal(partialWrite.reasonCode, "operon_partial_capabilities");
assert.equal(partialWrite.operations.length, 11);
assert.equal(
  partialWrite.operations.find((operation) => operation.id === "transition")
    .reasonCode,
  "operon_capability_not_advertised",
);
assert.equal(
  partialWrite.operations.find((operation) => operation.id === "update")
    .authorized,
  true,
);

const mcpOptInMissing = projectCapabilityManifest(
  input({ profile: "tasks", operonMutationsEnabled: false }),
);
assert.equal(
  capability(mcpOptInMissing, "operon-write").reasonCode,
  "mcp_operon_mutations_disabled",
);
assert.equal(
  capability(mcpOptInMissing, "operon-write").nextAction,
  "enable_mcp_operon_mutations",
);

const readonlyOperon = projectCapabilityManifest(
  input({ profile: "tasks", writeMode: "readonly" }),
);

const readonlyGoverned = projectCapabilityManifest(
  input({ writeMode: "readonly" }),
);
for (const id of [
  "governed-note-write",
  "governed-frontmatter-write",
  "governed-canvas-write",
  "governed-base-write",
]) {
  assert.deepEqual(
    {
      available: capability(readonlyGoverned, id).available,
      authorized: capability(readonlyGoverned, id).authorized,
      state: capability(readonlyGoverned, id).state,
      reasonCode: capability(readonlyGoverned, id).reasonCode,
      nextAction: capability(readonlyGoverned, id).nextAction,
    },
    {
      available: true,
      authorized: false,
      state: "blocked",
      reasonCode: "write_policy_blocked",
      nextAction: "enable_write_policy",
    },
    id,
  );
}
assert.equal(
  capability(readonlyOperon, "operon-write").reasonCode,
  "write_policy_blocked",
);
assert.ok(
  capability(readonlyOperon, "operon-write").operations.every(
    (operation) => operation.authorized === false,
  ),
);

const guardedOperon = projectCapabilityManifest(
  input({ profile: "tasks", writeMode: "guarded" }),
);
const guardedWrite = capability(guardedOperon, "operon-write");
assert.equal(guardedWrite.state, "degraded");
assert.equal(
  guardedWrite.operations.find((operation) => operation.id === "recurrence")
    .reasonCode,
  "operation_policy_blocked",
);
assert.equal(
  guardedWrite.operations.find((operation) => operation.id === "update")
    .authorized,
  true,
);

const operonIndexPending = projectCapabilityManifest(
  input({
    profile: "tasks",
    operon: {
      state: "ready",
      value: operonReady({ index: { ready: false } }),
    },
  }),
);
assert.equal(
  capability(operonIndexPending, "operon-read").reasonCode,
  "operon_index_not_ready",
);
assert.equal(
  capability(operonIndexPending, "operon-read").nextAction,
  "wait_for_operon_index",
);

const operonConflict = projectCapabilityManifest(
  input({
    profile: "tasks",
    operon: {
      state: "ready",
      value: operonReady({ index: { duplicateConflictCount: 2 } }),
    },
  }),
);
assert.equal(capability(operonConflict, "operon-read").available, false);
assert.equal(
  capability(operonConflict, "operon-read").reasonCode,
  "operon_duplicate_conflicts",
);
assert.equal(capability(operonConflict, "operon-write").available, false);
assert.equal(capability(operonConflict, "operon-write").authorized, false);
assert.equal(
  capability(operonConflict, "operon-write").reasonCode,
  "operon_duplicate_conflicts",
);
assert.ok(
  capability(operonConflict, "operon-write").operations.every(
    (operation) =>
      operation.available === false &&
      operation.authorized === false &&
      operation.reasonCode === "operon_duplicate_conflicts",
  ),
);

const semanticQueryEmbeddingDisabled = projectCapabilityManifest(
  input({ queryEmbeddingEnabled: false }),
);
assert.deepEqual(
  {
    available: capability(semanticQueryEmbeddingDisabled, "semantic-search")
      .available,
    authorized: capability(semanticQueryEmbeddingDisabled, "semantic-search")
      .authorized,
    state: capability(semanticQueryEmbeddingDisabled, "semantic-search").state,
    reasonCode: capability(semanticQueryEmbeddingDisabled, "semantic-search")
      .reasonCode,
    nextAction: capability(semanticQueryEmbeddingDisabled, "semantic-search")
      .nextAction,
  },
  {
    available: false,
    authorized: false,
    state: "unavailable",
    reasonCode: "semantic_query_embedding_disabled",
    nextAction: "enable_query_embedding",
  },
);

const snapshotFallbackInput = input({
  profile: "tasks",
  registrationMode: "headless-readonly",
  operon: {
    state: "ready",
    value: {
      ok: true,
      source: "operon-cache",
      stale: true,
      snapshot: { capabilities: { list: true, query: true } },
    },
  },
});
snapshotFallbackInput.profileToolNames = compileToolProfileNames({
  profile: "tasks",
  registrationMode: "live",
  availableStaticRequirements: ["vault-cache"],
});
const snapshotFallback = projectCapabilityManifest(snapshotFallbackInput);
assert.deepEqual(
  {
    available: capability(snapshotFallback, "operon-read").available,
    authorized: capability(snapshotFallback, "operon-read").authorized,
    state: capability(snapshotFallback, "operon-read").state,
    reasonCode: capability(snapshotFallback, "operon-read").reasonCode,
  },
  {
    available: true,
    authorized: true,
    state: "degraded",
    reasonCode: "operon_snapshot_fallback",
  },
);
assert.equal(
  capability(snapshotFallback, "operon-write").reasonCode,
  "runtime_mode_unavailable",
);

const cacheFallback = projectCapabilityManifest(
  input({
    registrationMode: "hybrid-degraded",
    localRest: { state: "unavailable" },
    atomicWrite: { state: "unavailable" },
    baseAtomicWrite: { state: "unavailable" },
    operon: { state: "unavailable" },
  }),
);
assert.equal(capability(cacheFallback, "local-rest").available, false);
assert.equal(
  capability(cacheFallback, "local-rest").reasonCode,
  "local_rest_not_configured",
);
assert.deepEqual(
  {
    available: capability(cacheFallback, "vault-read").available,
    authorized: capability(cacheFallback, "vault-read").authorized,
    state: capability(cacheFallback, "vault-read").state,
    reasonCode: capability(cacheFallback, "vault-read").reasonCode,
  },
  {
    available: true,
    authorized: true,
    state: "degraded",
    reasonCode: "cache_fallback",
  },
);

const unauthorized = projectCapabilityManifest(
  input({ localRest: { state: "unauthorized" } }),
);
assert.equal(capability(unauthorized, "local-rest").available, true);
assert.equal(capability(unauthorized, "local-rest").authorized, false);
assert.equal(capability(unauthorized, "local-rest").state, "blocked");

const incompatible = projectCapabilityManifest(
  input({
    atomicWrite: { state: "incompatible" },
    baseAtomicWrite: { state: "incompatible" },
    operon: { state: "incompatible" },
  }),
);
assert.equal(
  capability(incompatible, "governed-note-write").reasonCode,
  "bridge_contract_incompatible",
);
assert.equal(
  capability(incompatible, "operon-read").reasonCode,
  "operon_incompatible",
);

const malformedBridge = projectCapabilityManifest(
  input({
    localRest: { state: "ready", value: { unexpected: privateMarkers[0] } },
    atomicWrite: { state: "ready", value: { unexpected: privateMarkers[1] } },
    baseAtomicWrite: {
      state: "ready",
      value: { unexpected: privateMarkers[2] },
    },
  }),
);
assert.equal(capability(malformedBridge, "local-rest").state, "blocked");
assert.equal(
  capability(malformedBridge, "governed-note-write").reasonCode,
  "bridge_contract_incompatible",
);
assert.equal(
  capability(malformedBridge, "governed-base-write").reasonCode,
  "bridge_contract_incompatible",
);
for (const marker of privateMarkers) {
  assert.equal(JSON.stringify(malformedBridge).includes(marker), false);
}

const mountingBridge = projectCapabilityManifest(
  input({
    atomicWrite: {
      state: "ready",
      value: {
        ...atomicReady,
        lifecycle: { state: "mounting" },
      },
    },
  }),
);
assert.equal(
  capability(mountingBridge, "governed-note-write").reasonCode,
  "bridge_lifecycle_not_ready",
);
assert.equal(
  capability(mountingBridge, "governed-note-write").nextAction,
  "wait_for_bridge",
);

const pressured = projectCapabilityManifest(
  input({ transport: "http", admission: { timedOut: 3, queued: 1 } }),
);
assert.equal(pressured.admission.state, "pressured");
assert.equal(pressured.admission.timedOut, 3);
assert.equal(pressured.admission.queued, 1);

const httpReady = projectCapabilityManifest(input({ transport: "http" }));
assert.equal(httpReady.admission.state, "ready");
assert.deepEqual(
  httpReady.capabilities,
  ready.capabilities,
  "stdio and HTTP must project the same capability contract",
);

const serialized = JSON.stringify(ready);
for (const marker of privateMarkers) {
  assert.equal(serialized.includes(marker), false, `manifest leaked ${marker}`);
}

console.log("Capability manifest contract passed.");
