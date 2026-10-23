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
    semanticIndex: () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ vectorCount: 1, embedderReady: true }),
          3000,
        ),
      ),
  },
};
const start = performance.now();
const manifest = await collectCapabilityManifest(options);
const elapsed = performance.now() - start;
const semantic = manifest.capabilities.find((c) => c.id === "semantic-search");
assert.equal(semantic.reasonCode, "semantic_probe_timed_out");
assert.equal(semantic.nextAction, "retry_capability_probe");
assert.equal(semantic.available, false);
assert.equal(semantic.authorized, false);
assert.ok(
  elapsed >= 2400 && elapsed < 2900,
  "health inspection must keep its existing bounded wait",
);
await new Promise((r) => setTimeout(r, 600));
assert.equal(
  semantic.available,
  false,
  "late completion cannot retroactively certify the earlier receipt",
);
console.log(
  "PASS actual bounded probe reports timeout and never late-promotes its receipt.",
);
