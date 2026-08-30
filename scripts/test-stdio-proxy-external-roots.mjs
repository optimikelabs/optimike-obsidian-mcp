#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const LEGACY_FAILURE_SENTINEL = "external_root_private_legacy_sentinel";
const testWatchdog = setTimeout(() => {
  console.error("FAIL: stdio external-roots fixture exceeded 120 seconds");
  process.exit(1);
}, 120_000);
testWatchdog.unref();

function jsonOf(result) {
  return JSON.parse(
    result.content?.map((item) => item.text ?? "").join("\n") ?? "{}",
  );
}

async function snapshotProfiledMoveJournals(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /^move\.[a-f0-9]{24}\.sqlite(?:-(?:shm|wal))?$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(directory, name);
      const metadata = await stat(filePath, { bigint: true });
      return {
        name,
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
        sha256: createHash("sha256")
          .update(await readFile(filePath))
          .digest("hex"),
      };
    }),
  );
}

async function assertNoPrivateStatusSnapshots(directory, message) {
  assert.deepEqual(
    (await readdir(directory)).filter((name) =>
      name.startsWith("optimike-external-status-"),
    ),
    [],
    message,
  );
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP backend exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-proxy-"),
);
const vaultPath = path.join(sandbox, "vault");
const vaultBPath = path.join(sandbox, "vault-b");
const externalPath = path.join(sandbox, "external");
const backendExternalPath = path.join(sandbox, "backend-external");
const privateTempPath = path.join(sandbox, "private-temp");
const configPath = path.join(sandbox, "external-roots.json");
const backendConfigPath = path.join(sandbox, "backend-external-roots.json");
const legacyJournalPath = path.join(sandbox, "legacy-external-moves.sqlite");
const profiledJournalBasePath = path.join(sandbox, "move.sqlite");
const port = await unusedPort();
const httpUrl = new URL(`http://127.0.0.1:${port}/mcp/full`);
const healthUrl = new URL(`http://127.0.0.1:${port}/healthz`);

await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
await mkdir(path.join(vaultBPath, ".obsidian"), { recursive: true });
await mkdir(externalPath, { recursive: true });
await mkdir(backendExternalPath, { recursive: true });
await mkdir(privateTempPath, { recursive: true });
await writeFile(path.join(vaultPath, "Smoke.md"), "# Smoke\n", "utf8");
await writeFile(
  path.join(externalPath, "hello.txt"),
  "Bonjour depuis le proxy",
  "utf8",
);
await writeFile(
  path.join(backendExternalPath, "backend.txt"),
  "Ancienne configuration backend",
  "utf8",
);
await writeFile(
  configPath,
  JSON.stringify({
    version: 1,
    roots: [
      {
        id: "proxy.pilot",
        path: externalPath,
        capabilities: ["visible", "readable", "handoff", "move"],
        include: ["**/*.txt"],
        limits: {
          maxDepth: 2,
          maxFileBytes: 1024,
          maxListEntries: 20,
          maxTextChars: 100,
        },
      },
    ],
  }),
  "utf8",
);
await writeFile(
  backendConfigPath,
  JSON.stringify({
    version: 1,
    roots: [
      {
        id: "backend.pilot",
        path: backendExternalPath,
        capabilities: ["visible", "readable"],
        include: ["**/*.txt"],
      },
    ],
  }),
  "utf8",
);

// Legacy journals used the un-namespaced configured file. The proxy is allowed
// to show their redacted status, but never to bind them to whichever backend is
// currently reachable.
{
  const db = new DatabaseSync(legacyJournalPath);
  db.exec(`
    CREATE TABLE external_move_plans (
      plan_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const legacyPlanId = "11111111-1111-4111-8111-111111111111";
  const legacyPlan = {
    planId: legacyPlanId,
    idempotencyKey: "legacy-status-only-key",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    status: "planned",
    snapshot: {
      rootId: "proxy.pilot",
      sourceRelativePath: "hello.txt",
      targetRelativePath: "moved.txt",
      size: 21,
      modifiedAt: 0,
      sha256: "a".repeat(64),
    },
    bindingIdentity: {
      schemaVersion: 1,
      backendFingerprint: "legacy-backend",
      vaultFingerprint: "legacy-vault",
      rootConfigFingerprint: "legacy-roots",
      bindingFingerprint: "legacy-binding",
      vaultIdentitySource: "explicit_profile",
      verifiable: true,
    },
    sourceToken: "external-ref:proxy.pilot::hello.txt",
    targetToken: "external-ref:proxy.pilot::moved.txt",
    oldFileUri: "file:///P0-PRIVATE/legacy-source.txt",
    newFileUri: "file:///P0-PRIVATE/legacy-target.txt",
    repairs: [],
    manualReview: [],
    inventoryDigest: "legacy",
    appliedRepairPaths: [],
    restoredRepairPaths: [],
    recoveryErrors: [LEGACY_FAILURE_SENTINEL],
    failure: LEGACY_FAILURE_SENTINEL,
  };
  db.prepare(
    `INSERT INTO external_move_plans
      (plan_id, idempotency_key, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    legacyPlanId,
    legacyPlan.idempotencyKey,
    legacyPlan.status,
    JSON.stringify(legacyPlan),
    legacyPlan.createdAt,
    legacyPlan.updatedAt,
  );
  db.close();
}

const commonEnv = {
  ...process.env,
  TEMP: privateTempPath,
  TMP: privateTempPath,
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: vaultPath,
  OBSIDIAN_CACHE_SOURCE: "filesystem",
  OBSIDIAN_ENABLE_CACHE: "false",
  MCP_WRITE_MODE: "readonly",
  MCP_TOOL_PROFILE: "full",
  SEMANTIC_SEARCH_PREWARM: "false",
  MCP_TRANSPORT_TYPE: "http",
  MCP_HTTP_HOST: "127.0.0.1",
  MCP_HTTP_PORT: String(port),
  MCP_LOG_LEVEL: "error",
  MCP_EXTERNAL_ROOTS_FILE: backendConfigPath,
};

// The proxy remains free to use a read-only profile. Its shared backend is a
// distinct headless-filesystem process for the destructive-attestation check;
// this catches a proxy/backend vault mismatch instead of accidentally proving
// the proxy's local configuration alone.
const backendEnv = {
  ...commonEnv,
  OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
  OBSIDIAN_ENABLE_CACHE: "true",
  MCP_WRITE_MODE: "full",
  MCP_EXTERNAL_MOVE_ENABLED: "true",
  MCP_EXTERNAL_MOVE_PROFILE_ID: "stdio-proxy-move-test",
};

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: backendEnv,
  stdio: "ignore",
});

const proxyTransport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio-proxy.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: {
    ...commonEnv,
    MCP_EXTERNAL_ROOTS_FILE: configPath,
    MCP_PROXY_START_TIMEOUT_MS: "20000",
  },
});
const proxyStderr = [];
proxyTransport.stderr?.on("data", (chunk) => proxyStderr.push(String(chunk)));
const proxyClient = new Client({
  name: "optimike-external-roots-proxy-test",
  version: "0",
});
let moveProxyTransport;
let moveProxyClient;
let disabledMoveProxyTransport;
let disabledMoveProxyClient;
let profiledStatusProxyTransport;
let profiledStatusProxyClient;
let mismatchedMoveProxyTransport;
let mismatchedMoveProxyClient;

try {
  await waitForHealth(healthUrl, backend);
  await proxyClient.connect(proxyTransport);

  const tools = await proxyClient.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "external_handoff"));
  assert.equal(JSON.stringify(tools).includes(externalPath), false);

  const status = jsonOf(
    await proxyClient.callTool({
      name: "external_runtime_status",
      arguments: {},
    }),
  );
  assert.equal(status.enabled, true);
  assert.equal(status.localHandoffAllowed, true);
  assert.equal(status.externalMove.available, false);
  assert.equal(status.externalMove.identityVerified, false);
  assert.equal(
    "profileFingerprint" in status.externalMove,
    false,
    "read-only external roots must start without a move profile or journal binding",
  );
  assert.equal(JSON.stringify(status).includes(externalPath), false);

  // Planning requires an attested profile but not destructive write mode. A
  // readonly stdio process must retain scan/plan/status while apply/rollback
  // remain closed at the handler boundary.
  moveProxyTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio-proxy.js"],
    cwd: process.cwd(),
    env: {
      ...commonEnv,
      OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
      MCP_EXTERNAL_ROOTS_FILE: configPath,
      MCP_WRITE_MODE: "readonly",
      MCP_EXTERNAL_MOVE_ENABLED: "true",
      MCP_EXTERNAL_MOVE_PROFILE_ID: "stdio-proxy-move-test",
      MCP_EXTERNAL_MOVE_JOURNAL_PATH: profiledJournalBasePath,
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
      MCP_PROXY_START_TIMEOUT_MS: "20000",
    },
  });
  moveProxyClient = new Client({
    name: "optimike-external-roots-move-identity-test",
    version: "0",
  });
  await moveProxyClient.connect(moveProxyTransport);
  assert.deepEqual(
    await snapshotProfiledMoveJournals(sandbox),
    [],
    "attested readonly startup must not create a journal or WAL sidecar",
  );
  const moveStatus = jsonOf(
    await moveProxyClient.callTool({
      name: "external_runtime_status",
      arguments: {},
    }),
  );
  assert.equal(moveStatus.externalMove.available, false);
  assert.equal(moveStatus.externalMove.identityVerified, true);
  assert.equal(
    moveStatus.externalMove.identitySource,
    "backend_destructive_vault_attestation",
  );
  assert.equal(
    "profileFingerprint" in moveStatus.externalMove,
    false,
    "the private destructive binding must not be published in runtime status",
  );
  assert.deepEqual(
    await snapshotProfiledMoveJournals(sandbox),
    [],
    "external_runtime_status must not create a journal or WAL sidecar",
  );
  const readonlyScan = await moveProxyClient.callTool({
    name: "external_references_scan",
    arguments: { rootId: "proxy.pilot", relativePath: "hello.txt" },
  });
  assert.equal(readonlyScan.isError, false, JSON.stringify(readonlyScan));
  assert.deepEqual(
    await snapshotProfiledMoveJournals(sandbox),
    [],
    "external_references_scan must not create a journal or WAL sidecar",
  );
  const unknownReadonlyStatus = await moveProxyClient.callTool({
    name: "external_move_status",
    arguments: { planId: "22222222-2222-4222-8222-222222222222" },
  });
  assert.equal(unknownReadonlyStatus.isError, true);
  assert.equal(jsonOf(unknownReadonlyStatus).error, "not_found");
  assert.deepEqual(
    await snapshotProfiledMoveJournals(sandbox),
    [],
    "unknown file-backed status must not create a journal or WAL sidecar",
  );
  const readonlyPlan = jsonOf(
    await moveProxyClient.callTool({
      name: "external_move_plan",
      arguments: {
        rootId: "proxy.pilot",
        sourceRelativePath: "hello.txt",
        targetRelativePath: "moved.txt",
        idempotencyKey: "readonly-planning-remains-available",
      },
    }),
  );
  assert.equal(readonlyPlan.status, "planned");
  assert.equal(readonlyPlan.readyToApply, true);
  assert.equal(
    (await snapshotProfiledMoveJournals(sandbox)).some((entry) =>
      /^move\.[a-f0-9]{24}\.sqlite$/u.test(entry.name),
    ),
    true,
    "external_move_plan must create its durable profiled journal",
  );
  const readonlyApply = await moveProxyClient.callTool({
    name: "external_move_apply",
    arguments: {
      planId: readonlyPlan.planId,
      idempotencyKey: readonlyPlan.idempotencyKey,
    },
  });
  assert.equal(readonlyApply.isError, true);
  assert.equal(jsonOf(readonlyApply).error, "capability_denied");
  const readonlyRollback = await moveProxyClient.callTool({
    name: "external_move_rollback",
    arguments: {
      planId: readonlyPlan.planId,
      idempotencyKey: readonlyPlan.idempotencyKey,
    },
  });
  assert.equal(readonlyRollback.isError, true);
  assert.equal(jsonOf(readonlyRollback).error, "capability_denied");
  assert.equal(
    await readFile(path.join(externalPath, "hello.txt"), "utf8"),
    "Bonjour depuis le proxy",
  );

  // Close the planning process before inspecting its journal: this models a
  // restart and proves the durable receipt is in a fingerprint-suffixed file,
  // not the configured base filename.
  await moveProxyClient.close();
  await moveProxyTransport.close().catch(() => undefined);
  moveProxyClient = undefined;
  moveProxyTransport = undefined;
  const profiledJournalNames = (await readdir(sandbox)).filter((name) =>
    /^move\.[a-f0-9]{24}\.sqlite$/u.test(name),
  );
  assert.equal(profiledJournalNames.length, 1);
  const profiledJournalPath = path.join(sandbox, profiledJournalNames[0]);

  // The process was interrupted without closing its journal, so the new plan
  // remains in a non-checkpointed WAL. Status must read that generation from a
  // private snapshot without changing the original DB/WAL/SHM inventory,
  // bytes or mtimes.
  const reliableJournalSnapshot = await snapshotProfiledMoveJournals(sandbox);
  assert.equal(
    reliableJournalSnapshot.some((entry) => entry.name.endsWith("-wal")),
    true,
    "the discriminant requires a non-checkpointed WAL",
  );
  profiledStatusProxyTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio-proxy.js"],
    cwd: process.cwd(),
    env: {
      ...commonEnv,
      OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
      OBSIDIAN_VAULT: vaultBPath,
      MCP_EXTERNAL_ROOTS_FILE: configPath,
      MCP_WRITE_MODE: "readonly",
      MCP_EXTERNAL_MOVE_ENABLED: "false",
      MCP_EXTERNAL_MOVE_PROFILE_ID: "stdio-proxy-move-test",
      MCP_EXTERNAL_MOVE_JOURNAL_PATH: profiledJournalBasePath,
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
      MCP_PROXY_START_TIMEOUT_MS: "20000",
    },
  });
  profiledStatusProxyClient = new Client({
    name: "optimike-external-roots-reliable-status-test",
    version: "0",
  });
  await profiledStatusProxyClient.connect(profiledStatusProxyTransport);
  assert.deepEqual(
    await snapshotProfiledMoveJournals(sandbox),
    reliableJournalSnapshot,
    "readonly restart must not alter an existing reliable journal",
  );
  const reliableProfiledStatus = jsonOf(
    await profiledStatusProxyClient.callTool({
      name: "external_move_status",
      arguments: { planId: readonlyPlan.planId },
    }),
  );
  assert.equal(reliableProfiledStatus.status, "planned");
  assert.deepEqual(
    await snapshotProfiledMoveJournals(sandbox),
    reliableJournalSnapshot,
    "reliable file-backed status must preserve journal bytes and mtimes",
  );
  await assertNoPrivateStatusSnapshots(
    privateTempPath,
    "successful status must remove its private DB/WAL snapshot",
  );
  const corruptProfiledJournalPath = path.join(
    sandbox,
    "move.ffffffffffffffffffffffff.sqlite",
  );
  await writeFile(corruptProfiledJournalPath, "not-a-sqlite-journal", "utf8");
  const corruptSnapshotStatus = await profiledStatusProxyClient.callTool({
    name: "external_move_status",
    arguments: { planId: "33333333-3333-4333-8333-333333333333" },
  });
  assert.equal(corruptSnapshotStatus.isError, true);
  assert.equal(jsonOf(corruptSnapshotStatus).error, "not_found");
  await assertNoPrivateStatusSnapshots(
    privateTempPath,
    "failed status must remove its private DB/WAL snapshot",
  );
  await rm(corruptProfiledJournalPath, { force: true });
  await profiledStatusProxyClient.close();
  await profiledStatusProxyTransport.close().catch(() => undefined);
  profiledStatusProxyClient = undefined;
  profiledStatusProxyTransport = undefined;

  {
    const db = new DatabaseSync(profiledJournalPath);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }

  {
    const db = new DatabaseSync(profiledJournalPath);
    const row = db
      .prepare("SELECT payload_json FROM external_move_plans WHERE plan_id = ?")
      .get(readonlyPlan.planId);
    const payload = JSON.parse(row.payload_json);
    payload.status = "recovery_required";
    payload.failure = "backend_session_changed";
    payload.recoveryErrors = ["backend_session_changed"];
    payload.updatedAt = "2026-08-30T01:00:00.000Z";
    db.prepare(
      `UPDATE external_move_plans
       SET status = ?, payload_json = ?, updated_at = ?
       WHERE plan_id = ?`,
    ).run(
      payload.status,
      JSON.stringify(payload),
      payload.updatedAt,
      readonlyPlan.planId,
    );
    db.close();
  }

  // The feature flag is a destructive gate only. With full write mode but the
  // flag disabled, planning and status still work while apply stays closed.
  disabledMoveProxyTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio-proxy.js"],
    cwd: process.cwd(),
    env: {
      ...commonEnv,
      OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
      MCP_EXTERNAL_ROOTS_FILE: configPath,
      MCP_WRITE_MODE: "full",
      MCP_EXTERNAL_MOVE_ENABLED: "false",
      MCP_EXTERNAL_MOVE_PROFILE_ID: "stdio-proxy-move-test",
      MCP_EXTERNAL_MOVE_JOURNAL_PATH: profiledJournalBasePath,
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
      MCP_PROXY_START_TIMEOUT_MS: "20000",
    },
  });
  disabledMoveProxyClient = new Client({
    name: "optimike-external-roots-disabled-move-test",
    version: "0",
  });
  await disabledMoveProxyClient.connect(disabledMoveProxyTransport);
  const disabledStatus = jsonOf(
    await disabledMoveProxyClient.callTool({
      name: "external_runtime_status",
      arguments: {},
    }),
  );
  assert.equal(disabledStatus.externalMove.available, false);
  assert.equal(disabledStatus.externalMove.identityVerified, true);
  const disabledPlanReplay = jsonOf(
    await disabledMoveProxyClient.callTool({
      name: "external_move_plan",
      arguments: {
        rootId: "proxy.pilot",
        sourceRelativePath: "hello.txt",
        targetRelativePath: "moved.txt",
        idempotencyKey: "readonly-planning-remains-available",
      },
    }),
  );
  assert.equal(disabledPlanReplay.planId, readonlyPlan.planId);
  assert.equal(disabledPlanReplay.recoveryRequired, true);
  const disabledApply = await disabledMoveProxyClient.callTool({
    name: "external_move_apply",
    arguments: {
      planId: readonlyPlan.planId,
      idempotencyKey: readonlyPlan.idempotencyKey,
    },
  });
  assert.equal(disabledApply.isError, true);
  assert.equal(jsonOf(disabledApply).error, "capability_denied");
  await disabledMoveProxyClient.close();
  await disabledMoveProxyTransport.close().catch(() => undefined);
  disabledMoveProxyClient = undefined;
  disabledMoveProxyTransport = undefined;

  // On the next restart the local proxy points at another vault, so target
  // attestation deliberately fails and no coordinator exists. Status must
  // still discover the current profiled journal read-only.
  profiledStatusProxyTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio-proxy.js"],
    cwd: process.cwd(),
    env: {
      ...commonEnv,
      OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
      OBSIDIAN_VAULT: vaultBPath,
      MCP_EXTERNAL_ROOTS_FILE: configPath,
      MCP_WRITE_MODE: "readonly",
      MCP_EXTERNAL_MOVE_ENABLED: "false",
      MCP_EXTERNAL_MOVE_PROFILE_ID: "stdio-proxy-move-test",
      MCP_EXTERNAL_MOVE_JOURNAL_PATH: profiledJournalBasePath,
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
      MCP_PROXY_START_TIMEOUT_MS: "20000",
    },
  });
  profiledStatusProxyClient = new Client({
    name: "optimike-external-roots-profiled-status-test",
    version: "0",
  });
  await profiledStatusProxyClient.connect(profiledStatusProxyTransport);
  const profiledRecoveryStatus = jsonOf(
    await profiledStatusProxyClient.callTool({
      name: "external_move_status",
      arguments: { planId: readonlyPlan.planId },
    }),
  );
  assert.equal(profiledRecoveryStatus.planId, readonlyPlan.planId);
  assert.equal(profiledRecoveryStatus.legacyBinding, false);
  assert.equal(profiledRecoveryStatus.recoveryRequired, true);
  assert.equal(profiledRecoveryStatus.nextAction, "manual_review");
  assert.deepEqual(profiledRecoveryStatus.recoveryErrors, [
    "backend_session_changed",
  ]);

  // The backend remains on Vault A while this proxy expects Vault B. A
  // full-write process must retain harmless external reads but never create a
  // destructive coordinator from its own local path alone.
  mismatchedMoveProxyTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio-proxy.js"],
    cwd: process.cwd(),
    env: {
      ...commonEnv,
      OBSIDIAN_RUNTIME_MODE: "headless-filesystem",
      OBSIDIAN_VAULT: vaultBPath,
      MCP_EXTERNAL_ROOTS_FILE: configPath,
      MCP_WRITE_MODE: "full",
      MCP_EXTERNAL_MOVE_ENABLED: "true",
      MCP_EXTERNAL_MOVE_PROFILE_ID: "stdio-proxy-move-test",
      MCP_EXTERNAL_MOVE_JOURNAL_PATH: legacyJournalPath,
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
      MCP_PROXY_START_TIMEOUT_MS: "20000",
    },
  });
  mismatchedMoveProxyClient = new Client({
    name: "optimike-external-roots-move-mismatch-test",
    version: "0",
  });
  await mismatchedMoveProxyClient.connect(mismatchedMoveProxyTransport);
  const mismatchedStatus = jsonOf(
    await mismatchedMoveProxyClient.callTool({
      name: "external_runtime_status",
      arguments: {},
    }),
  );
  assert.equal(mismatchedStatus.externalMove.available, false);
  assert.equal(mismatchedStatus.externalMove.identityVerified, false);
  assert.equal(
    mismatchedStatus.externalMove.unavailableReason,
    "target_unverified",
  );
  assert.equal(JSON.stringify(mismatchedStatus).includes(vaultBPath), false);
  const mismatchRead = jsonOf(
    await mismatchedMoveProxyClient.callTool({
      name: "external_read",
      arguments: { rootId: "proxy.pilot", relativePath: "hello.txt" },
    }),
  );
  assert.equal(mismatchRead.text, "Bonjour depuis le proxy");
  const deniedMove = await mismatchedMoveProxyClient.callTool({
    name: "external_move_plan",
    arguments: {
      rootId: "proxy.pilot",
      sourceRelativePath: "hello.txt",
      targetRelativePath: "moved.txt",
      idempotencyKey: "backend-attestation-mismatch",
    },
  });
  assert.equal(deniedMove.isError, true);
  assert.equal(jsonOf(deniedMove).error, "configuration_invalid");
  assert.equal(JSON.stringify(deniedMove).includes(vaultBPath), false);
  const legacyStatus = jsonOf(
    await mismatchedMoveProxyClient.callTool({
      name: "external_move_status",
      arguments: { planId: "11111111-1111-4111-8111-111111111111" },
    }),
  );
  assert.equal(legacyStatus.legacyBinding, true);
  assert.equal(legacyStatus.bindingVerifiable, false);
  assert.equal(JSON.stringify(legacyStatus).includes("P0-PRIVATE"), false);
  assert.equal(
    JSON.stringify(legacyStatus).includes(LEGACY_FAILURE_SENTINEL),
    false,
    "external_move_status must redact raw legacy recovery failures",
  );

  const roots = jsonOf(
    await proxyClient.callTool({
      name: "external_roots_list",
      arguments: {},
    }),
  );
  assert.deepEqual(
    roots.roots.map((root) => root.id),
    ["proxy.pilot"],
  );

  const listing = jsonOf(
    await proxyClient.callTool({
      name: "external_list",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "",
        depth: 1,
      },
    }),
  );
  assert.ok(listing.entries.some((entry) => entry.path === "hello.txt"));
  assert.equal(JSON.stringify(listing).includes(externalPath), false);

  const stat = jsonOf(
    await proxyClient.callTool({
      name: "external_stat",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
        includeHash: true,
      },
    }),
  );
  assert.equal(stat.type, "file");
  assert.ok(stat.sha256);
  assert.equal("localPath" in stat, false);

  const read = jsonOf(
    await proxyClient.callTool({
      name: "external_read",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
      },
    }),
  );
  assert.equal(read.text, "Bonjour depuis le proxy");
  assert.equal("localPath" in read, false);

  const handoff = jsonOf(
    await proxyClient.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
        includeHash: true,
      },
    }),
  );
  assert.equal(path.isAbsolute(handoff.localPath), true);
  assert.notEqual(handoff.localPath, path.join(externalPath, "hello.txt"));
  assert.equal(
    await readFile(handoff.localPath, "utf8"),
    "Bonjour depuis le proxy",
  );
  assert.equal(handoff.sha256, read.sha256);

  const invalidHandoff = await proxyClient.callTool({
    name: "external_handoff",
    arguments: {
      rootId: "proxy.pilot",
      relativePath: "../outside.txt",
      unexpected: "C:\\attacker\\stdio-proxy-privacy-marker.txt",
    },
  });
  assert.equal(invalidHandoff.isError, true);
  assert.equal(jsonOf(invalidHandoff).error, "path_invalid");
  assert.equal(
    JSON.stringify(invalidHandoff).includes("stdio-proxy-privacy-marker"),
    false,
    "strict validation errors must not reflect unknown argument values",
  );
  assert.equal(
    proxyStderr.join("").includes("stdio-proxy-privacy-marker"),
    false,
    "strict validation errors must not log unknown argument values",
  );

  const httpTransport = new StreamableHTTPClientTransport(httpUrl);
  const httpClient = new Client({
    name: "optimike-external-roots-http-test",
    version: "0",
  });
  try {
    await httpClient.connect(httpTransport);
    const defaultRuntimeStatus = jsonOf(
      await httpClient.callTool({
        name: "obsidian_runtime_status",
        arguments: {},
      }),
    );
    assert.equal(
      "destructiveVaultIdentityVerified" in
        defaultRuntimeStatus.runtime.configuration,
      false,
      "ordinary runtime status must not publish a vault-proof result",
    );
    assert.equal(
      "destructiveVaultAttestation" in
        defaultRuntimeStatus.runtime.configuration,
      false,
      "ordinary runtime status must never publish a stable vault digest",
    );
    const challengeMarker = "b".repeat(64);
    const challengedRuntimeStatus = jsonOf(
      await httpClient.callTool({
        name: "obsidian_runtime_status",
        arguments: { expectedDestructiveVaultAttestation: challengeMarker },
      }),
    );
    assert.equal(
      challengedRuntimeStatus.runtime.configuration
        .destructiveVaultIdentityVerified,
      false,
    );
    assert.equal(
      challengedRuntimeStatus.runtime.configuration
        .destructiveVaultAttestationSchemeVersion,
      2,
    );
    assert.equal(
      JSON.stringify(challengedRuntimeStatus).includes(challengeMarker),
      false,
      "the status challenge must be reduced to a boolean and never reflected",
    );
    const denied = await httpClient.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(jsonOf(denied).error, "capability_denied");
    assert.equal(JSON.stringify(denied).includes(externalPath), false);
  } finally {
    await httpClient.close().catch(() => undefined);
  }

  console.log(
    "PASS: stdio proxy keeps scan/plan/status available behind readonly or disabled destructive gates, recovers profiled status after restart, denies HTTP handoff, and keeps responses path-redacted",
  );
} finally {
  await moveProxyClient?.close().catch(() => undefined);
  await moveProxyTransport?.close().catch(() => undefined);
  await disabledMoveProxyClient?.close().catch(() => undefined);
  await disabledMoveProxyTransport?.close().catch(() => undefined);
  await profiledStatusProxyClient?.close().catch(() => undefined);
  await profiledStatusProxyTransport?.close().catch(() => undefined);
  await mismatchedMoveProxyClient?.close().catch(() => undefined);
  await mismatchedMoveProxyTransport?.close().catch(() => undefined);
  await proxyClient.close().catch(() => undefined);
  backend.kill();
  await new Promise((resolve) => {
    if (backend.exitCode !== null) return resolve();
    backend.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  await rm(sandbox, { recursive: true, force: true });
  clearTimeout(testWatchdog);
}
