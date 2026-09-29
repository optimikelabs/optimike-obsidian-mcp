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
  governedRuntimes: { note: false, base: false, canvas: false, asset: false },
};

try {
  config.assetImportEnabled = false;
  config.mcpWriteMode = "full";
  const disabled = await collectCapabilityManifest(base);
  assert.equal(
    disabled.capabilities.some((x) => x.id === "governed-asset-import"),
    false,
    "default-off asset family must not change capability output",
  );

  config.assetImportEnabled = true;
  const unavailableManifest = await collectCapabilityManifest(base);
  const unavailable = unavailableManifest.capabilities.find(
    (x) => x.id === "governed-asset-import",
  );
  assert.ok(unavailable, "configured asset policy must remain diagnosable");
  assert.equal(unavailable.discoverable, false);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.authorized, false);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.reasonCode, "asset_backend_unavailable");
  assert.equal(unavailable.nextAction, "verify_asset_backend");

  const ready = await collectCapabilityManifest({
    ...base,
    governedRuntimes: { ...base.governedRuntimes, asset: true },
  });
  const asset = ready.capabilities.find((x) => x.id === "governed-asset-import");
  assert.equal(asset.state, "ready");
  assert.equal(asset.authorized, true);

  config.mcpWriteMode = "guarded";
  const guarded = await collectCapabilityManifest({
    ...base,
    governedRuntimes: { ...base.governedRuntimes, asset: true },
  });
  const denied = guarded.capabilities.find((x) => x.id === "governed-asset-import");
  assert.equal(denied.state, "blocked");
  assert.equal(denied.reasonCode, "write_policy_blocked");

  config.mcpWriteMode = "full";
} finally {
  config.assetImportEnabled = oldEnabled;
  config.mcpWriteMode = oldWrite;
}

console.log("PASS test-asset-capability.mjs");
