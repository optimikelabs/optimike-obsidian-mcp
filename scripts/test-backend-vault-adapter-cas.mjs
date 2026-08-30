import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { attestVaultFilesystemTarget, BackendVaultAdapter } = await import(
  "../dist/services/externalReferences/backendVaultAdapter.js"
);

const before = "# Pilot\n\nOld reference\n";
const after = "# Pilot\n\nNew reference\n";
const expectedHash = createHash("sha256").update(before, "utf8").digest("hex");
const resultingHash = createHash("sha256").update(after, "utf8").digest("hex");

function result(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

function publicRuntimeStatus({
  fingerprint = "a".repeat(64),
  destructiveVaultIdentityVerified = false,
  destructiveVaultAttestationSchemeVersion = 2,
} = {}) {
  return {
    runtimeMode: "headless-filesystem",
    transport: "stdio",
    runtime: {
      configuration: {
        fingerprint,
        destructiveVaultIdentityVerified,
        destructiveVaultAttestationSchemeVersion,
        vaultConfigured: true,
        semanticCacheConfigured: false,
        queryEmbeddingEnabled: false,
        cacheSource: "filesystem",
        writeMode: "full",
        protectedFrontmatterKeyCount: 2,
      },
      // These legacy/private values must have no effect on the binding.
      configFields: {
        obsidianVaultPath: "C:\\P0-PRIVATE\\Vault",
        obsidianBaseUrl: "https://p0-private.example.test/api",
      },
    },
    sharedCache: { dbPath: "C:\\P0-PRIVATE\\Vault\\.obsidian\\cache.sqlite" },
  };
}

function backendAttestation(label) {
  return createHash("sha256")
    .update(`optimike-test-backend-attestation-v2\0${label}`, "utf8")
    .digest("hex");
}

function bindingAdapter(
  profileId,
  status = publicRuntimeStatus({
    destructiveVaultIdentityVerified: true,
  }),
  { target = "vault-a", backendEndpoint = "http://127.0.0.1:3010/mcp" } = {},
) {
  return new BackendVaultAdapter(
    async (name, args) => {
      assert.equal(name, "obsidian_runtime_status");
      assert.equal(
        args.expectedDestructiveVaultAttestation,
        backendAttestation(target),
      );
      return result(status);
    },
    {
      backendEndpoint,
      rootConfigFingerprint: "roots-fingerprint",
      profileId,
      expectedTargetAttestation: backendAttestation(target),
    },
  );
}

{
  let calls = 0;
  const adapter = new BackendVaultAdapter(
    async (name) => {
      calls += 1;
      assert.equal(name, "obsidian_runtime_status");
      return result(publicRuntimeStatus());
    },
    {
      backendEndpoint: "http://127.0.0.1:3010/mcp",
      rootConfigFingerprint: "roots-fingerprint",
      profileId: "pilot.vault",
    },
  );
  await assert.rejects(
    () => adapter.getBindingIdentity(),
    /External move target identity could not be proven by the backend/u,
  );
  assert.equal(calls, 1, "an unproven backend target must fail closed");
}

{
  let calls = 0;
  const adapter = new BackendVaultAdapter(
    async () => {
      calls += 1;
      return result(publicRuntimeStatus());
    },
    {
      backendEndpoint: "http://127.0.0.1:3010/mcp",
      rootConfigFingerprint: "roots-fingerprint",
    },
  );
  await assert.rejects(
    () => adapter.getBindingIdentity(),
    /External move profile ID is required\. Configure MCP_EXTERNAL_MOVE_PROFILE_ID\./u,
  );
  assert.equal(calls, 0, "missing profile must fail before runtime inspection");
}

{
  const first = await bindingAdapter(
    "pilot.vault",
    publicRuntimeStatus({
      destructiveVaultIdentityVerified: true,
    }),
  ).getBindingIdentity();
  const restarted = await bindingAdapter(
    "pilot.vault",
    publicRuntimeStatus({
      destructiveVaultIdentityVerified: true,
    }),
  ).getBindingIdentity();
  const vaultB = await bindingAdapter(
    "pilot.vault",
    publicRuntimeStatus({
      destructiveVaultIdentityVerified: true,
    }),
    { target: "vault-b" },
  ).getBindingIdentity();
  const differentProfile = await bindingAdapter(
    "replacement.vault",
    publicRuntimeStatus({
      destructiveVaultIdentityVerified: true,
    }),
  ).getBindingIdentity();

  assert.deepEqual(
    restarted,
    first,
    "a restart against the same backend vault must remain stable",
  );
  assert.notEqual(
    vaultB.bindingFingerprint,
    first.bindingFingerprint,
    "Vault B must reject a plan sealed for Vault A even if endpoint and profile label are unchanged",
  );
  assert.notEqual(
    differentProfile.bindingFingerprint,
    first.bindingFingerprint,
    "a different profile must select a different binding",
  );
  const differentBackend = await bindingAdapter(
    "pilot.vault",
    publicRuntimeStatus({ destructiveVaultIdentityVerified: true }),
    { backendEndpoint: "http://127.0.0.1:3011/mcp" },
  ).getBindingIdentity();
  assert.notEqual(
    differentBackend.bindingFingerprint,
    first.bindingFingerprint,
    "a changed backend endpoint must select a different binding",
  );
  assert.equal(
    first.vaultIdentitySource,
    "backend_destructive_vault_attestation",
  );
  assert.equal(first.verifiable, true);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("configFields"), false);
  assert.equal(serialized.includes("sharedCache"), false);
}

{
  let activeTarget = "vault-a";
  const adapter = new BackendVaultAdapter(
    async (name, args) => {
      assert.equal(name, "obsidian_runtime_status");
      return result(
        publicRuntimeStatus({
          destructiveVaultIdentityVerified:
            args.expectedDestructiveVaultAttestation ===
            backendAttestation(activeTarget),
        }),
      );
    },
    {
      backendEndpoint: "http://127.0.0.1:3010/mcp",
      rootConfigFingerprint: "roots-fingerprint",
      profileId: "pilot.vault",
      expectedTargetAttestation: backendAttestation("vault-a"),
    },
  );
  const planned = await adapter.getBindingIdentity(true);
  activeTarget = "vault-b";
  await assert.rejects(
    () => adapter.getBindingIdentity(true),
    /External move target identity could not be proven by the backend/u,
    "a backend target swap at the same endpoint must be rejected on refresh",
  );
  assert.equal(planned.verifiable, true);
}

{
  let activeSession = { generation: 1, sessionId: "proxy-session-a" };
  const adapter = new BackendVaultAdapter(
    async () => ({
      result: result(
        publicRuntimeStatus({ destructiveVaultIdentityVerified: true }),
      ),
      ...activeSession,
    }),
    {
      backendEndpoint: "http://127.0.0.1:3010/mcp",
      rootConfigFingerprint: "roots-fingerprint",
      profileId: "pilot.vault",
      expectedTargetAttestation: backendAttestation("vault-a"),
      getActiveBackendSession: () => activeSession,
    },
  );
  const binding = await adapter.getBindingIdentity(true);
  const session = await adapter.captureDestructiveSession(binding);
  activeSession = { generation: 2, sessionId: "proxy-session-b" };
  await assert.rejects(
    () => adapter.openDestructiveSession(binding, session),
    /backend session changed/u,
    "a plan session must not be reopened through a replacement backend",
  );
}

{
  const sandbox = await mkdtemp(
    path.join(os.tmpdir(), "optimike-backend-vault-attestation-"),
  );
  try {
    const vaultA = path.join(sandbox, "vault-a");
    const vaultB = path.join(sandbox, "vault-b");
    await mkdir(vaultA);
    await mkdir(vaultB);
    const first = attestVaultFilesystemTarget(vaultA);
    const restarted = attestVaultFilesystemTarget(vaultA);
    const other = attestVaultFilesystemTarget(vaultB);
    assert.match(first ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(
      first,
      restarted,
      "the same directory remains stable across reads",
    );
    assert.notEqual(
      first,
      other,
      "two vault directories have distinct opaque proofs",
    );
    assert.equal(
      attestVaultFilesystemTarget(path.join(sandbox, "missing")),
      undefined,
    );
    assert.equal(JSON.stringify({ first, other }).includes(vaultA), false);
    assert.equal(JSON.stringify({ first, other }).includes(vaultB), false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

{
  const calls = [];
  const adapter = new BackendVaultAdapter(async (name, args) => {
    calls.push({ name, args });
    return result({
      success: true,
      replacementsApplied: 1,
      stats: { hash: resultingHash },
    });
  });

  await adapter.conditionalReplace(
    "Efforts/Projets/Pilot.md",
    before,
    after,
    expectedHash,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "obsidian_search_replace");
  assert.equal(calls[0].args.expectedHash, expectedHash);
  assert.equal("expectedSha256" in calls[0].args, false);
}

for (const payload of [
  {
    success: true,
    replacementsApplied: 0,
    stats: { hash: resultingHash },
  },
  {
    success: true,
    replacementsApplied: 1,
    stats: { hash: expectedHash },
  },
]) {
  const adapter = new BackendVaultAdapter(async () => result(payload));
  await assert.rejects(
    () =>
      adapter.conditionalReplace(
        "Efforts/Projets/Pilot.md",
        before,
        after,
        expectedHash,
      ),
    /conditional vault repair did not succeed/u,
  );
}

{
  const privateBackendText = "private-backend-isError-sentinel-0d76";
  const adapter = new BackendVaultAdapter(async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ message: privateBackendText }),
      },
    ],
    isError: true,
  }));
  let failure;
  try {
    await adapter.conditionalReplace(
      "Efforts/Projets/Pilot.md",
      before,
      after,
      expectedHash,
    );
  } catch (error) {
    failure = error;
  }
  assert.match(String(failure), /vault backend rejected the request/u);
  assert.equal(
    String(failure).includes(privateBackendText),
    false,
    "a backend isError payload must never reflect into an external move failure",
  );
}

{
  const hostilePaths = [
    "C:\\\\private-backend-path-sentinel-1a2b",
    "\\\\server\\share\\private-backend-path-sentinel-2b3c",
    "../../private-backend-path-sentinel-3c4d",
    "/private-backend-path-sentinel-4d5e",
    "folder/./private-backend-path-sentinel-5e6f",
    "folder/../private-backend-path-sentinel-6f7a",
    "folder//private-backend-path-sentinel-7a8b",
    "folder/\u0000private-backend-path-sentinel-8b9c",
    "https://private-backend-path-sentinel-9c0d.example.test/note.md",
  ];

  for (const hostilePath of hostilePaths) {
    const calls = [];
    const adapter = new BackendVaultAdapter(async (name, args) => {
      calls.push({ name, args });
      return result({ results: [{ path: hostilePath }], totalPages: 1 });
    });
    let failure;
    try {
      await adapter.searchPaths("reference");
    } catch (error) {
      failure = error;
    }
    assert.equal(
      String(failure),
      "BackendVaultInvalidPathError: The vault backend returned an invalid vault-relative path.",
    );
    assert.equal(
      String(failure).includes(hostilePath),
      false,
      "a rejected backend path must not be reflected into the failure",
    );
    assert.deepEqual(
      calls.map((call) => call.name),
      ["obsidian_global_search"],
      "rejecting a backend path must not invoke any repair mutation",
    );
  }
}

{
  const adapter = new BackendVaultAdapter(async () =>
    result({
      results: [
        { path: "Dossiers\\Réunion équipe\\Décision café.md" },
        { path: "Dossiers/Réunion équipe/Décision café.md" },
      ],
      totalPages: 1,
    }),
  );
  assert.deepEqual(await adapter.searchPaths("Décision"), [
    "Dossiers/Réunion équipe/Décision café.md",
  ]);
}

console.log(
  "Backend vault adapter binding privacy, path boundary, CAS forwarding, and repair proof tests passed.",
);
