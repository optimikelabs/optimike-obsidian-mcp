import assert from "node:assert/strict";

process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { config } = await import("../dist/config/index.js");
const { collectCapabilityManifest } = await import("../dist/services/capabilityManifest.js");

const oldEnabled = config.assetImportEnabled;
const oldWrite = config.mcpWriteMode;
const probes = {
  localRest: async () => ({ authenticated: true }),
  semanticIndex: async () => ({ vectorCount: 0, embedderReady: false }),
  atomicWrite: async () => ({ ok: false }),
  baseAtomicWrite: async () => ({ ok: false }),
  operon: async () => ({ ok: false }),
};
const base = {
  profile: "full",
  registrationMode: "live",
  runtimeStatus: {
    sharedCache: { ready: true },
    semanticCache: { enabled: false },
  },
  obsidianService: undefined,
  vaultCacheAvailable: true,
  probes,
  governedRuntimes: { note: false, base: false, canvas: false, asset: true },
};

try {
  config.assetImportEnabled = false;
  config.mcpWriteMode = "full";
  const disabled = await collectCapabilityManifest(base);
  const blocked = disabled.capabilities.find((x) => x.id === "governed-asset-import");
  assert.ok(blocked, "configured asset runtime must appear in capability diagnostics");
  assert.equal(blocked.discoverable, true);
  assert.equal(blocked.available, true);
  assert.equal(blocked.authorized, false);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reasonCode, "asset_import_disabled");
  assert.equal(blocked.nextAction, "enable_asset_import");
  assert.deepEqual(blocked.preferredTools, [
    "asset_import_plan",
    "asset_import_apply",
    "asset_import_status",
  ]);

  config.assetImportEnabled = true;
  const ready = await collectCapabilityManifest(base);
  const asset = ready.capabilities.find((x) => x.id === "governed-asset-import");
  assert.equal(asset.state, "ready");
  assert.equal(asset.authorized, true);

  config.mcpWriteMode = "guarded";
  const guarded = await collectCapabilityManifest(base);
  const denied = guarded.capabilities.find((x) => x.id === "governed-asset-import");
  assert.equal(denied.state, "blocked");
  assert.equal(denied.reasonCode, "write_policy_blocked");

  config.mcpWriteMode = "full";
  const absent = await collectCapabilityManifest({
    ...base,
    governedRuntimes: { ...base.governedRuntimes, asset: false },
  });
  const unavailable = absent.capabilities.find(
    (x) => x.id === "governed-asset-import",
  );
  assert.equal(unavailable.state, "hidden");
  assert.equal(unavailable.discoverable, false);
} finally {
  config.assetImportEnabled = oldEnabled;
  config.mcpWriteMode = oldWrite;
}

console.log("PASS test-asset-capability.mjs");
