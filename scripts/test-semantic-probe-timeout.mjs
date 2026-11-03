import assert from "node:assert/strict";
process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.ENABLE_QUERY_EMBEDDING = "true";
process.env.SEMANTIC_SEARCH_PREWARM = "false";
const { collectCapabilityManifest } = await import(
  "../dist/services/capabilityManifest.js"
);
const options = {
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
    // Never settles: the receipt can only come from the probe deadline.
    semanticIndex: () => new Promise(() => {}),
  },
};
// The probe deadline timer is unref'd; keep the loop alive while it runs.
const keepAlive = setInterval(() => {}, 1_000);
const start = performance.now();
const manifest = await collectCapabilityManifest(options);
clearInterval(keepAlive);
const elapsed = performance.now() - start;
const semantic = manifest.capabilities.find((c) => c.id === "semantic-search");
assert.equal(semantic.reasonCode, "semantic_probe_timed_out");
assert.equal(semantic.nextAction, "retry_capability_probe");
assert.equal(semantic.available, false);
assert.equal(semantic.authorized, false);
assert.ok(
  elapsed >= 2400 && elapsed < 6000,
  "health inspection must keep its existing bounded wait",
);
console.log(
  "PASS actual bounded probe reports timeout at its deadline.",
);
