import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const installer = path.join(
  repositoryRoot,
  "scripts",
  "install-bridge-bundle.mjs",
);
const wrapper = path.join(
  repositoryRoot,
  "scripts",
  "install-bridge-bundle.ps1",
);
const expectedCommit = "a".repeat(40);
const bridgeIds = [
  "optimike-operon-bridge",
  "obsidian-atomic-write-bridge",
  "obsidian-bases-bridge",
];
const digest = (content) => createHash("sha256").update(content).digest("hex");

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function descriptor(root, relativePath) {
  const content = readFileSync(path.join(root, ...relativePath.split("/")));
  return { path: relativePath, sha256: digest(content), size: content.length };
}

function createBundle(root) {
  const bundle = path.join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  for (const name of [
    "install-bridge-bundle.mjs",
    "install-bridge-bundle.ps1",
  ]) {
    copyFileSync(
      path.join(repositoryRoot, "scripts", name),
      path.join(bundle, name),
    );
  }
  const bridges = bridgeIds.map((id, index) => {
    const directory = path.join(bundle, "bridges", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "main.js"),
      `new-${id}-${index}\n`,
      "utf8",
    );
    writeJson(path.join(directory, "manifest.json"), {
      id,
      name: id,
      version: `9.${index}.0`,
      main: "main.js",
      minAppVersion: "1.13.1",
    });
    return {
      id,
      version: `9.${index}.0`,
      files: ["main.js", "manifest.json"].map((name) =>
        descriptor(bundle, `bridges/${id}/${name}`),
      ),
    };
  });
  writeJson(path.join(bundle, "bridge-bundle.json"), {
    schemaVersion: 1,
    bundle: {
      name: "optimike-bridge-bundle",
      version: "3.5.0",
      repository: "https://github.com/optimikelabs/optimike-obsidian-mcp",
      sourceCommit: expectedCommit,
      sourceCommittedAt: "2026-08-30T00:00:00.000Z",
    },
    installers: ["install-bridge-bundle.mjs", "install-bridge-bundle.ps1"].map(
      (name) => descriptor(bundle, name),
    ),
    bridges,
  });
  return bundle;
}

function createVault(root) {
  const vault = path.join(root, "Coffre P3 — riche (é)");
  const plugins = path.join(vault, ".obsidian", "plugins");
  mkdirSync(plugins, { recursive: true });
  for (const [index, id] of bridgeIds.entries()) {
    const directory = path.join(plugins, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "main.js"),
      `old-${id}-${index}\n`,
      "utf8",
    );
    writeJson(path.join(directory, "manifest.json"), {
      id,
      name: id,
      version: `1.${index}.0`,
      main: "main.js",
    });
    if (index === 0)
      writeFileSync(path.join(directory, "styles.css"), "old-style\n");
    writeJson(path.join(directory, "data.json"), {
      writeGate: index === 1,
      customSetting: `préservé-${index}`,
    });
    writeFileSync(path.join(directory, "unmanaged.bin"), `keep-${index}`);
  }
  return vault;
}

function createEmptyVault(root) {
  const vault = path.join(root, "Coffre neuf P3");
  mkdirSync(path.join(vault, ".obsidian", "plugins"), { recursive: true });
  return vault;
}

function snapshot(vault) {
  const result = {};
  for (const id of bridgeIds) {
    const directory = path.join(vault, ".obsidian", "plugins", id);
    result[id] = {};
    for (const name of [
      "main.js",
      "manifest.json",
      "styles.css",
      "data.json",
      "unmanaged.bin",
    ]) {
      try {
        result[id][name] = digest(readFileSync(path.join(directory, name)));
      } catch {
        result[id][name] = null;
      }
    }
  }
  return result;
}

function runInstall({ vault, bundle, backupRoot, extra = [], env = {} }) {
  return spawnSync(
    process.execPath,
    [
      installer,
      "install",
      "--vault",
      vault,
      "--bundle",
      bundle,
      "--expected-commit",
      expectedCommit,
      "--backup-root",
      backupRoot,
      "--confirm-obsidian-closed",
      ...extra,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

function runRollback({ vault, backupPath, extra = [], env = {} }) {
  return spawnSync(
    process.execPath,
    [
      installer,
      "rollback",
      "--vault",
      vault,
      "--backup",
      backupPath,
      "--confirm-obsidian-closed",
      ...extra,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "optimike-bridge-p3-"));
try {
  const bundle = createBundle(tempRoot);
  const vault = createVault(tempRoot);
  const backupRoot = path.join(tempRoot, "private backups");
  const original = snapshot(vault);

  const emptyVault = createEmptyVault(tempRoot);
  const emptyBaseline = snapshot(emptyVault);
  const cleanInstall = runInstall({
    vault: emptyVault,
    bundle,
    backupRoot,
  });
  assert.equal(cleanInstall.status, 0, cleanInstall.stderr);
  const cleanReceipt = JSON.parse(cleanInstall.stdout);
  for (const id of bridgeIds) {
    assert.notEqual(snapshot(emptyVault)[id]["main.js"], null);
    assert.equal(snapshot(emptyVault)[id]["data.json"], null);
  }
  const cleanRollback = runRollback({
    vault: emptyVault,
    backupPath: cleanReceipt.backupPath,
  });
  assert.equal(cleanRollback.status, 0, cleanRollback.stderr);
  assert.deepEqual(snapshot(emptyVault), emptyBaseline);

  const noConfirmation = spawnSync(
    process.execPath,
    [
      installer,
      "install",
      "--vault",
      vault,
      "--bundle",
      bundle,
      "--expected-commit",
      expectedCommit,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(noConfirmation.status, 0);
  assert.match(noConfirmation.stderr, /explicit confirmation/);
  assert.deepEqual(snapshot(vault), original);

  const vaultLocalBackupRoot = path.join(vault, ".private-backups");
  const vaultLocalBackup = runInstall({
    vault,
    bundle,
    backupRoot: vaultLocalBackupRoot,
  });
  assert.notEqual(vaultLocalBackup.status, 0);
  assert.match(vaultLocalBackup.stderr, /outside the vault/);
  assert.equal(existsSync(vaultLocalBackupRoot), false);
  assert.deepEqual(snapshot(vault), original);

  const installed = runInstall({ vault, bundle, backupRoot });
  assert.equal(installed.status, 0, installed.stderr);
  const receipt = JSON.parse(installed.stdout);
  assert.equal(receipt.outcome, "committed");
  assert.equal(receipt.sourceCommit, expectedCommit);
  assert.equal(
    path.resolve(receipt.backupPath).startsWith(path.resolve(vault)),
    false,
  );
  const afterInstall = snapshot(vault);
  for (const id of bridgeIds) {
    assert.notEqual(afterInstall[id]["main.js"], original[id]["main.js"]);
    assert.equal(afterInstall[id]["data.json"], original[id]["data.json"]);
    assert.equal(
      afterInstall[id]["unmanaged.bin"],
      original[id]["unmanaged.bin"],
    );
    assert.equal(afterInstall[id]["styles.css"], null);
  }

  const rolledBack = runRollback({ vault, backupPath: receipt.backupPath });
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(JSON.parse(rolledBack.stdout).outcome, "rolled_back");
  assert.deepEqual(snapshot(vault), original);

  const tamperedMain = path.join(bundle, "bridges", bridgeIds[0], "main.js");
  const untamperedMain = readFileSync(tamperedMain);
  writeFileSync(tamperedMain, "tampered\n");
  const checksumFailure = runInstall({ vault, bundle, backupRoot });
  assert.notEqual(checksumFailure.status, 0);
  assert.match(checksumFailure.stderr, /checksum validation failed/);
  assert.deepEqual(snapshot(vault), original);
  writeFileSync(tamperedMain, untamperedMain);

  const forbiddenData = path.join(bundle, "bridges", bridgeIds[0], "data.json");
  writeFileSync(forbiddenData, "{}\n");
  const extraFileFailure = runInstall({ vault, bundle, backupRoot });
  assert.notEqual(extraFileFailure.status, 0);
  assert.match(extraFileFailure.stderr, /never contain data\.json/);
  assert.deepEqual(snapshot(vault), original);
  unlinkSync(forbiddenData);

  const wrongCommit = spawnSync(
    process.execPath,
    [
      installer,
      "install",
      "--vault",
      vault,
      "--bundle",
      bundle,
      "--expected-commit",
      "b".repeat(40),
      "--confirm-obsidian-closed",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(wrongCommit.status, 0);
  assert.match(wrongCommit.stderr, /expected release commit/);
  assert.deepEqual(snapshot(vault), original);

  const simulatedFailure = runInstall({
    vault,
    bundle,
    backupRoot,
    extra: ["--simulate-failure-after-bridge", "1"],
    env: { OPTIMIKE_BRIDGE_INSTALL_TEST_MODE: "1" },
  });
  assert.notEqual(simulatedFailure.status, 0);
  assert.match(simulatedFailure.stderr, /was rolled back/);
  assert.deepEqual(snapshot(vault), original);

  const lockPath = path.join(
    vault,
    ".obsidian",
    "plugins",
    ".optimike-bridge-install.lock",
  );
  const preparationFailure = runInstall({
    vault,
    bundle,
    backupRoot,
    env: {
      OPTIMIKE_BRIDGE_INSTALL_TEST_MODE: "1",
      OPTIMIKE_BRIDGE_INSTALL_TEST_PREPARATION_FAILURE: "1",
    },
  });
  assert.notEqual(preparationFailure.status, 0);
  assert.match(preparationFailure.stderr, /preparation failed before mutation/);
  assert.equal(
    existsSync(lockPath),
    false,
    "a failed preparation must release its vault-local lock",
  );
  assert.deepEqual(snapshot(vault), original);

  writeFileSync(lockPath, "existing transaction\n");
  const lockedInstall = runInstall({ vault, bundle, backupRoot });
  assert.notEqual(lockedInstall.status, 0);
  assert.match(lockedInstall.stderr, /holds the lock/);
  assert.deepEqual(snapshot(vault), original);
  unlinkSync(lockPath);

  const recoveryInstall = runInstall({ vault, bundle, backupRoot });
  assert.equal(recoveryInstall.status, 0, recoveryInstall.stderr);
  const recoveryReceipt = JSON.parse(recoveryInstall.stdout);
  const recoveryBackup = JSON.parse(
    readFileSync(path.join(recoveryReceipt.backupPath, "backup.json"), "utf8"),
  );
  writeJson(lockPath, {
    schemaVersion: 1,
    transactionId: recoveryBackup.transactionId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const liveOwnerRollback = runRollback({
    vault,
    backupPath: recoveryReceipt.backupPath,
  });
  assert.notEqual(liveOwnerRollback.status, 0);
  assert.match(liveOwnerRollback.stderr, /holds the lock/);
  unlinkSync(lockPath);
  const immutableBackupFile = path.join(
    recoveryReceipt.backupPath,
    bridgeIds[0],
    "main.js",
  );
  const immutableBackupBytes = readFileSync(immutableBackupFile);
  writeFileSync(immutableBackupFile, "tampered private backup\n");
  const tamperedBackupRollback = runRollback({
    vault,
    backupPath: recoveryReceipt.backupPath,
  });
  assert.notEqual(tamperedBackupRollback.status, 0);
  assert.match(
    tamperedBackupRollback.stderr,
    /backup checksum validation failed/i,
  );
  writeFileSync(immutableBackupFile, immutableBackupBytes);
  unlinkSync(path.join(recoveryReceipt.backupPath, "state.json"));
  const missingStateRollback = runRollback({
    vault,
    backupPath: recoveryReceipt.backupPath,
  });
  assert.equal(missingStateRollback.status, 0, missingStateRollback.stderr);
  assert.deepEqual(snapshot(vault), original);

  const interruptedRollbackInstall = runInstall({
    vault,
    bundle,
    backupRoot,
  });
  assert.equal(
    interruptedRollbackInstall.status,
    0,
    interruptedRollbackInstall.stderr,
  );
  const interruptedRollbackReceipt = JSON.parse(
    interruptedRollbackInstall.stdout,
  );
  const interruptedRollback = runRollback({
    vault,
    backupPath: interruptedRollbackReceipt.backupPath,
    extra: ["--simulate-rollback-failure-after-file", "2"],
    env: { OPTIMIKE_BRIDGE_INSTALL_TEST_MODE: "1" },
  });
  assert.notEqual(interruptedRollback.status, 0);
  assert.match(
    interruptedRollback.stderr,
    /interruption during Bridge rollback/,
  );
  const resumedRollback = runRollback({
    vault,
    backupPath: interruptedRollbackReceipt.backupPath,
  });
  assert.equal(resumedRollback.status, 0, resumedRollback.stderr);
  assert.deepEqual(snapshot(vault), original);

  const crashBackupRoot = path.join(tempRoot, "crash recovery backups");
  const crashedInstall = runInstall({
    vault,
    bundle,
    backupRoot: crashBackupRoot,
    extra: ["--simulate-crash-after-file", "1"],
    env: { OPTIMIKE_BRIDGE_INSTALL_TEST_MODE: "1" },
  });
  assert.equal(crashedInstall.status, 86);
  const crashBackups = readdirSync(crashBackupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(crashBackupRoot, entry.name));
  assert.equal(crashBackups.length, 1);
  assert.equal(existsSync(lockPath), true);
  const crashRecovery = runRollback({
    vault,
    backupPath: crashBackups[0],
  });
  assert.equal(crashRecovery.status, 0, crashRecovery.stderr);
  assert.equal(existsSync(lockPath), false);
  assert.equal(
    readdirSync(path.dirname(lockPath)).some((name) =>
      name.startsWith(".optimike-bridge-stage-"),
    ),
    false,
  );
  assert.deepEqual(snapshot(vault), original);

  const staleInstall = runInstall({ vault, bundle, backupRoot });
  assert.equal(staleInstall.status, 0, staleInstall.stderr);
  const staleReceipt = JSON.parse(staleInstall.stdout);
  const installedMainPath = path.join(
    vault,
    ".obsidian",
    "plugins",
    bridgeIds[0],
    "main.js",
  );
  const expectedInstalledMain = readFileSync(installedMainPath);
  writeFileSync(installedMainPath, "third-party-change\n");
  const staleRollback = runRollback({
    vault,
    backupPath: staleReceipt.backupPath,
  });
  assert.notEqual(staleRollback.status, 0);
  assert.match(staleRollback.stderr, /changed after installation/);
  assert.equal(readFileSync(installedMainPath, "utf8"), "third-party-change\n");
  writeFileSync(installedMainPath, expectedInstalledMain);
  const finalRollback = runRollback({
    vault,
    backupPath: staleReceipt.backupPath,
  });
  assert.equal(finalRollback.status, 0, finalRollback.stderr);
  assert.deepEqual(snapshot(vault), original);

  const hardlinkTarget = path.join(bundle, "installer-hardlink-test");
  linkSync(path.join(bundle, "install-bridge-bundle.ps1"), hardlinkTarget);
  const hardlinkFailure = runInstall({ vault, bundle, backupRoot });
  assert.notEqual(hardlinkFailure.status, 0);
  assert.match(hardlinkFailure.stderr, /hard-linked file/);
  unlinkSync(hardlinkTarget);

  const escapedRootInstall = runInstall({ vault, bundle, backupRoot });
  assert.equal(escapedRootInstall.status, 0, escapedRootInstall.stderr);
  const escapedRootReceipt = JSON.parse(escapedRootInstall.stdout);
  const obsidianRoot = path.join(vault, ".obsidian");
  const realPluginRoot = path.join(obsidianRoot, "plugins");
  const parkedPluginRoot = path.join(obsidianRoot, "plugins-contained-fixture");
  const outsidePluginRoot = path.join(tempRoot, "outside plugin root");
  mkdirSync(outsidePluginRoot, { recursive: true });
  renameSync(realPluginRoot, parkedPluginRoot);
  symlinkSync(
    outsidePluginRoot,
    realPluginRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    const escapedRootRollback = runRollback({
      vault,
      backupPath: escapedRootReceipt.backupPath,
    });
    assert.notEqual(escapedRootRollback.status, 0);
    assert.match(escapedRootRollback.stderr, /plugin root escapes the vault/);
  } finally {
    rmSync(realPluginRoot, { force: true });
    renameSync(parkedPluginRoot, realPluginRoot);
  }
  const containedRootRollback = runRollback({
    vault,
    backupPath: escapedRootReceipt.backupPath,
  });
  assert.equal(containedRootRollback.status, 0, containedRootRollback.stderr);
  assert.deepEqual(snapshot(vault), original);

  const wrapperFailure = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      wrapper,
      "-Mode",
      "install",
      "-VaultPath",
      vault,
      "-BundlePath",
      bundle,
      "-ExpectedCommit",
      expectedCommit,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(wrapperFailure.status, 0);
  assert.match(
    `${wrapperFailure.stdout}\n${wrapperFailure.stderr}`,
    /explicit confirmation/,
  );

  console.log(
    "PASS: exact-SHA bundle, configuration preservation, stale-lock crash recovery, resumable rollback, fences and rich paths",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
