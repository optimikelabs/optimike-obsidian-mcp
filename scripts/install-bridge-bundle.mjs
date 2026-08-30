import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const expectedBridgeIds = [
  "optimike-operon-bridge",
  "obsidian-atomic-write-bridge",
  "obsidian-bases-bridge",
];
const managedFiles = ["main.js", "manifest.json", "styles.css"];
const expectedInstallerFiles = [
  "install-bridge-bundle.mjs",
  "install-bridge-bundle.ps1",
];
const repositoryUrl = "https://github.com/optimikelabs/optimike-obsidian-mcp";
const maxManifestBytes = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

function normalizeForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(parent, candidate) {
  const normalizedParent = normalizeForComparison(parent);
  const normalizedCandidate = normalizeForComparison(candidate);
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertChild(parent, candidate, label) {
  if (
    !isWithin(parent, candidate) ||
    normalizeForComparison(parent) === normalizeForComparison(candidate)
  ) {
    fail(`${label} must remain below its expected parent.`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unsupported fields.`);
  }
}

function readBoundedJson(filePath, label) {
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail(`${label} must be a regular unaliased file.`);
  }
  if (info.size <= 0 || info.size > maxManifestBytes) {
    fail(`${label} has an invalid size.`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

function assertSafeTree(rootPath, label) {
  const rootInfo = lstatSync(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail(`${label} must be a real directory.`);
  }
  for (const entry of readdirSync(rootPath, {
    recursive: true,
    withFileTypes: true,
  })) {
    const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
    const info = lstatSync(fullPath);
    if (info.isSymbolicLink()) {
      fail(`${label} contains a symbolic link or junction.`);
    }
    if (info.isFile() && info.nlink !== 1) {
      fail(`${label} contains a hard-linked file.`);
    }
    if (!info.isFile() && !info.isDirectory()) {
      fail(`${label} contains an unsupported filesystem entry.`);
    }
  }
}

function relativeFiles(rootPath) {
  return readdirSync(rootPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(
          rootPath,
          path.join(entry.parentPath ?? entry.path, entry.name),
        )
        .replaceAll(path.sep, "/"),
    )
    .sort();
}

function validateFileDescriptor(descriptor, expectedPrefix, label) {
  assertExactKeys(descriptor, ["path", "sha256", "size"], label);
  if (
    typeof descriptor.path !== "string" ||
    descriptor.path.includes("\\") ||
    descriptor.path.startsWith("/") ||
    descriptor.path.includes("../") ||
    !descriptor.path.startsWith(expectedPrefix)
  ) {
    fail(`${label} has an unsafe path.`);
  }
  if (!/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
    fail(`${label} has an invalid SHA-256 digest.`);
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1) {
    fail(`${label} has an invalid size.`);
  }
}

function validateBundle(bundlePath, expectedCommit) {
  const requestedBundleRoot = path.resolve(bundlePath);
  const requestedBundleInfo = lstatSync(requestedBundleRoot);
  if (
    !requestedBundleInfo.isDirectory() ||
    requestedBundleInfo.isSymbolicLink()
  ) {
    fail("Bridge bundle root must be a real directory.");
  }
  const bundleRoot = realpathSync(requestedBundleRoot);
  assertSafeTree(bundleRoot, "Bridge bundle");
  const manifestPath = path.join(bundleRoot, "bridge-bundle.json");
  const manifest = readBoundedJson(manifestPath, "Bridge bundle manifest");
  assertExactKeys(
    manifest,
    ["schemaVersion", "bundle", "installers", "bridges"],
    "Bridge bundle manifest",
  );
  if (manifest.schemaVersion !== 1) fail("Unsupported bundle schema version.");
  assertExactKeys(
    manifest.bundle,
    ["name", "version", "repository", "sourceCommit", "sourceCommittedAt"],
    "Bundle identity",
  );
  if (
    manifest.bundle.name !== "optimike-bridge-bundle" ||
    manifest.bundle.repository !== repositoryUrl ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.bundle.version) ||
    !/^[0-9a-f]{40}$/.test(manifest.bundle.sourceCommit) ||
    Number.isNaN(Date.parse(manifest.bundle.sourceCommittedAt))
  ) {
    fail("Bundle identity is invalid.");
  }
  if (
    !/^[0-9a-f]{40}$/.test(expectedCommit) ||
    manifest.bundle.sourceCommit !== expectedCommit
  ) {
    fail("Bundle source commit does not match the expected release commit.");
  }

  if (!Array.isArray(manifest.installers) || manifest.installers.length !== 2) {
    fail("Bundle installer allowlist is incomplete.");
  }
  const allowedFiles = new Set(["bridge-bundle.json"]);
  for (const descriptor of manifest.installers) {
    validateFileDescriptor(
      descriptor,
      "install-bridge-bundle.",
      "Installer file",
    );
    if (!expectedInstallerFiles.includes(descriptor.path)) {
      fail("Bundle contains an unknown installer file.");
    }
    allowedFiles.add(descriptor.path);
  }

  if (!Array.isArray(manifest.bridges) || manifest.bridges.length !== 3) {
    fail("Bundle must contain exactly three Bridges.");
  }
  const bridgeIds = manifest.bridges.map((bridge) => bridge?.id).sort();
  if (
    JSON.stringify(bridgeIds) !== JSON.stringify([...expectedBridgeIds].sort())
  ) {
    fail("Bundle Bridge identity set is invalid.");
  }
  for (const bridge of manifest.bridges) {
    assertExactKeys(bridge, ["id", "version", "files"], `Bridge ${bridge?.id}`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bridge.version)) {
      fail(`Bridge ${bridge.id} has an invalid version.`);
    }
    if (!Array.isArray(bridge.files)) fail(`Bridge ${bridge.id} has no files.`);
    const names = [];
    for (const descriptor of bridge.files) {
      const prefix = `bridges/${bridge.id}/`;
      validateFileDescriptor(
        descriptor,
        prefix,
        `Bridge file for ${bridge.id}`,
      );
      const name = descriptor.path.slice(prefix.length);
      if (!managedFiles.includes(name) || name.includes("/")) {
        fail(`Bridge ${bridge.id} contains an unsupported file.`);
      }
      names.push(name);
      allowedFiles.add(descriptor.path);
    }
    if (
      !names.includes("main.js") ||
      !names.includes("manifest.json") ||
      new Set(names).size !== names.length
    ) {
      fail(`Bridge ${bridge.id} has an invalid file allowlist.`);
    }
  }

  const files = relativeFiles(bundleRoot);
  if (files.some((file) => path.basename(file).toLowerCase() === "data.json")) {
    fail("Bundle must never contain data.json.");
  }
  if (JSON.stringify(files) !== JSON.stringify([...allowedFiles].sort())) {
    fail("Bundle contains a missing or unexpected file.");
  }

  for (const descriptor of [
    ...manifest.installers,
    ...manifest.bridges.flatMap((bridge) => bridge.files),
  ]) {
    const filePath = path.join(bundleRoot, ...descriptor.path.split("/"));
    assertChild(bundleRoot, filePath, "Bundle file");
    const info = statSync(filePath);
    if (
      info.size !== descriptor.size ||
      sha256File(filePath) !== descriptor.sha256
    ) {
      fail("Bundle checksum validation failed.");
    }
  }

  for (const bridge of manifest.bridges) {
    const pluginManifest = readBoundedJson(
      path.join(bundleRoot, "bridges", bridge.id, "manifest.json"),
      `Plugin manifest for ${bridge.id}`,
    );
    if (
      pluginManifest.id !== bridge.id ||
      pluginManifest.version !== bridge.version ||
      pluginManifest.main !== "main.js"
    ) {
      fail(`Plugin manifest identity mismatch for ${bridge.id}.`);
    }
  }
  return { bundleRoot, manifest };
}

function writeDurableJson(filePath, value) {
  const handle = openSync(filePath, "w", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function updateBackupState(backupPath, transactionId, state) {
  writeDurableJson(path.join(backupPath, "state.json"), {
    schemaVersion: 1,
    transactionId,
    state,
    updatedAt: new Date().toISOString(),
  });
}

function readBackupState(backupPath, transactionId) {
  try {
    const state = readBoundedJson(
      path.join(backupPath, "state.json"),
      "Backup state",
    );
    assertExactKeys(
      state,
      ["schemaVersion", "transactionId", "state", "updatedAt"],
      "Backup state",
    );
    if (
      state.schemaVersion !== 1 ||
      state.transactionId !== transactionId ||
      typeof state.state !== "string" ||
      Number.isNaN(Date.parse(state.updatedAt))
    ) {
      fail("Backup state is invalid.");
    }
    return state.state;
  } catch {
    return "manual_recovery_required";
  }
}

function defaultBackupRoot() {
  return path.join(
    process.env.LOCALAPPDATA ||
      process.env.XDG_STATE_HOME ||
      path.join(os.homedir(), ".local", "state"),
    "optimike-obsidian-mcp",
    "bridge-backups",
  );
}

function assertSafePluginDirectory(pluginRoot, pluginDirectory) {
  assertChild(pluginRoot, pluginDirectory, "Plugin directory");
  if (!existsSync(pluginDirectory)) return;
  const info = lstatSync(pluginDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(
      "A Bridge plugin directory is a symbolic link, junction or non-directory.",
    );
  }
}

function removeStageDirectory(pluginRoot, transactionId) {
  const stagePath = path.join(
    pluginRoot,
    `.optimike-bridge-stage-${transactionId}`,
  );
  assertChild(pluginRoot, stagePath, "Staging directory");
  if (!existsSync(stagePath)) return;
  assertSafeTree(stagePath, "Bridge staging directory");
  rmSync(stagePath, { recursive: true, force: true });
}

function describeExistingFile(filePath, backupRelativePath, backupPath) {
  if (!existsSync(filePath)) return { present: false };
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail("An installed Bridge file is not a regular unaliased file.");
  }
  const destination = path.join(backupPath, ...backupRelativePath.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(filePath, destination);
  return {
    present: true,
    path: backupRelativePath,
    sha256: sha256File(destination),
    size: statSync(destination).size,
  };
}

function installExpectation(bridge, name) {
  const descriptor = bridge.files.find((file) =>
    file.path.endsWith(`/${name}`),
  );
  return descriptor
    ? { present: true, sha256: descriptor.sha256, size: descriptor.size }
    : { present: false };
}

function validatePresenceDescriptor(value, label, expectedPath) {
  assertPlainObject(value, label);
  if (value.present === false) {
    assertExactKeys(value, ["present"], label);
    return;
  }
  assertExactKeys(
    value,
    expectedPath === undefined
      ? ["present", "sha256", "size"]
      : ["present", "path", "sha256", "size"],
    label,
  );
  if (
    value.present !== true ||
    (expectedPath !== undefined && value.path !== expectedPath) ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    fail(`${label} is invalid.`);
  }
}

function validateBackupManifest(backupPath, backup, vaultRoot) {
  assertSafeTree(backupPath, "Bridge backup");
  assertExactKeys(
    backup,
    [
      "schemaVersion",
      "transactionId",
      "createdAt",
      "vaultPathSha256",
      "bundle",
      "bridges",
    ],
    "Backup manifest",
  );
  if (
    backup.schemaVersion !== 1 ||
    !/^[0-9a-f-]{36}$/.test(backup.transactionId) ||
    Number.isNaN(Date.parse(backup.createdAt)) ||
    !/^[0-9a-f]{64}$/.test(backup.vaultPathSha256) ||
    backup.vaultPathSha256 !==
      sha256(Buffer.from(normalizeForComparison(vaultRoot), "utf8"))
  ) {
    fail("Backup identity is invalid for this vault.");
  }
  assertExactKeys(backup.bundle, ["version", "sourceCommit"], "Backup bundle");
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(backup.bundle.version) ||
    !/^[0-9a-f]{40}$/.test(backup.bundle.sourceCommit)
  ) {
    fail("Backup bundle identity is invalid.");
  }
  if (!Array.isArray(backup.bridges)) fail("Backup Bridges are invalid.");
  const ids = backup.bridges.map((bridge) => bridge?.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...expectedBridgeIds].sort())) {
    fail("Backup Bridge identity set is invalid.");
  }
  const allowedFiles = new Set(["backup.json"]);
  if (existsSync(path.join(backupPath, "state.json"))) {
    allowedFiles.add("state.json");
  }
  for (const bridge of backup.bridges) {
    assertExactKeys(
      bridge,
      ["id", "version", "destinationExisted", "files"],
      `Backup Bridge ${bridge?.id}`,
    );
    if (
      typeof bridge.destinationExisted !== "boolean" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bridge.version) ||
      !Array.isArray(bridge.files) ||
      bridge.files.length !== managedFiles.length
    ) {
      fail(`Backup Bridge ${bridge.id} is invalid.`);
    }
    const names = bridge.files.map((file) => file?.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...managedFiles].sort())) {
      fail(`Backup Bridge ${bridge.id} has an invalid managed-file set.`);
    }
    for (const file of bridge.files) {
      assertExactKeys(
        file,
        ["name", "previous", "installed", "oldTempName"],
        `Backup file for ${bridge.id}`,
      );
      const previousPath = `${bridge.id}/${file.name}`;
      validatePresenceDescriptor(
        file.previous,
        `Previous file for ${bridge.id}`,
        previousPath,
      );
      validatePresenceDescriptor(
        file.installed,
        `Installed file for ${bridge.id}`,
      );
      if (
        file.oldTempName !==
        `.optimike-old-${backup.transactionId}-${file.name}`
      ) {
        fail(`Backup temporary-file identity is invalid for ${bridge.id}.`);
      }
      if (file.previous.present) {
        allowedFiles.add(file.previous.path);
        const source = path.join(backupPath, ...file.previous.path.split("/"));
        assertChild(backupPath, source, "Backup file");
        if (!currentMatches(source, file.previous)) {
          fail("Private backup checksum validation failed.");
        }
      }
    }
  }
  if (
    JSON.stringify(relativeFiles(backupPath)) !==
    JSON.stringify([...allowedFiles].sort())
  ) {
    fail("Private backup contains an unexpected or missing file.");
  }
}

function currentMatches(filePath, expectation) {
  if (!expectation.present) return !existsSync(filePath);
  if (!existsSync(filePath)) return false;
  const info = lstatSync(filePath);
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.nlink === 1 &&
    info.size === expectation.size &&
    sha256File(filePath) === expectation.sha256
  );
}

function replaceManagedFile(target, replacement, oldTemp) {
  rmSync(oldTemp, { force: true });
  let movedOld = false;
  if (existsSync(target)) {
    renameSync(target, oldTemp);
    movedOld = true;
  }
  try {
    if (replacement) renameSync(replacement, target);
  } catch (error) {
    if (movedOld && !existsSync(target)) renameSync(oldTemp, target);
    throw error;
  }
}

function assertRollbackCandidates({
  backup,
  pluginRoot,
  strictInstalledFence,
}) {
  for (const bridge of backup.bridges) {
    const destination = path.join(pluginRoot, bridge.id);
    assertSafePluginDirectory(pluginRoot, destination);
    for (const file of bridge.files) {
      const target = path.join(destination, file.name);
      const matchesInstalled = currentMatches(target, file.installed);
      const matchesPrevious = currentMatches(target, file.previous);
      const interruptedPrevious =
        !existsSync(target) &&
        file.previous.present &&
        currentMatches(path.join(destination, file.oldTempName), file.previous);
      if (
        (strictInstalledFence && !matchesInstalled) ||
        (!strictInstalledFence &&
          !matchesInstalled &&
          !matchesPrevious &&
          !interruptedPrevious)
      ) {
        fail(
          "Rollback fence rejected a Bridge file changed after installation.",
        );
      }
    }
  }
}

function rollbackInternal({
  backupPath,
  backup,
  pluginRoot,
  strictInstalledFence,
  simulateFailureAfterFile,
}) {
  assertRollbackCandidates({ backup, pluginRoot, strictInstalledFence });

  let restoredFileCount = 0;
  for (const bridge of backup.bridges) {
    const destination = path.join(pluginRoot, bridge.id);
    mkdirSync(destination, { recursive: true });
    for (const file of bridge.files) {
      const target = path.join(destination, file.name);
      const rollbackTemp = path.join(
        destination,
        `.optimike-rollback-${backup.transactionId}-${file.name}`,
      );
      rmSync(rollbackTemp, { force: true });
      if (file.previous.present) {
        const source = path.join(backupPath, ...file.previous.path.split("/"));
        if (!currentMatches(source, file.previous)) {
          fail("Private backup checksum validation failed.");
        }
        copyFileSync(source, rollbackTemp);
        replaceManagedFile(target, rollbackTemp, `${rollbackTemp}.superseded`);
      } else {
        rmSync(target, { force: true });
      }
      if (!currentMatches(target, file.previous)) {
        fail("Rollback did not restore the previous Bridge bytes.");
      }
      restoredFileCount += 1;
      if (
        process.env.OPTIMIKE_BRIDGE_INSTALL_TEST_MODE === "1" &&
        Number(simulateFailureAfterFile) === restoredFileCount
      ) {
        fail("Simulated interruption during Bridge rollback.");
      }
      rmSync(`${rollbackTemp}.superseded`, { force: true });
      rmSync(path.join(destination, file.oldTempName), { force: true });
    }
    if (!bridge.destinationExisted) {
      try {
        if (readdirSync(destination).length === 0)
          rmSync(destination, { recursive: false });
      } catch {
        // An unmanaged file may have appeared; preserving it is safer than deleting it.
      }
    }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readLock(lockPath) {
  const lock = readBoundedJson(lockPath, "Bridge installation lock");
  assertExactKeys(
    lock,
    ["schemaVersion", "transactionId", "pid", "startedAt"],
    "Bridge installation lock",
  );
  if (
    lock.schemaVersion !== 1 ||
    !/^[0-9a-f-]{36}$/.test(lock.transactionId) ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid < 1 ||
    Number.isNaN(Date.parse(lock.startedAt))
  ) {
    fail("Bridge installation lock is invalid.");
  }
  return lock;
}

function acquireLock(pluginRoot, transactionId, recoverTransactionId) {
  const lockPath = path.join(pluginRoot, ".optimike-bridge-install.lock");
  let descriptor;
  const createLock = () => {
    let candidateDescriptor;
    try {
      candidateDescriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        candidateDescriptor,
        `${JSON.stringify({
          schemaVersion: 1,
          transactionId,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      fsyncSync(candidateDescriptor);
      descriptor = candidateDescriptor;
    } catch (error) {
      if (candidateDescriptor !== undefined) {
        closeSync(candidateDescriptor);
        rmSync(lockPath, { force: true });
      }
      throw error;
    }
  };
  try {
    createLock();
  } catch {
    if (!recoverTransactionId || !existsSync(lockPath)) {
      fail(
        "Another Bridge installation or an unresolved interrupted run holds the lock.",
      );
    }
    const existing = readLock(lockPath);
    if (
      existing.transactionId !== recoverTransactionId ||
      processIsAlive(existing.pid)
    ) {
      fail(
        "Another Bridge installation or an unresolved interrupted run holds the lock.",
      );
    }
    const recoveryClaim = `${lockPath}.recover-${process.pid}-${randomUUID()}`;
    renameSync(lockPath, recoveryClaim);
    try {
      createLock();
    } finally {
      rmSync(recoveryClaim, { force: true });
    }
  }
  return () => {
    try {
      closeSync(descriptor);
    } finally {
      rmSync(lockPath, { force: true });
    }
  };
}

function installBundle(options) {
  if (!options.confirmObsidianClosed) {
    fail(
      "Refusing installation without explicit confirmation that Obsidian is closed.",
    );
  }
  const vaultRoot = realpathSync(options.vaultPath);
  const pluginRoot = path.join(vaultRoot, ".obsidian", "plugins");
  if (!existsSync(pluginRoot))
    fail("The vault plugin directory does not exist.");
  const pluginRootReal = realpathSync(pluginRoot);
  if (!isWithin(vaultRoot, pluginRootReal))
    fail("The vault plugin root escapes the vault.");

  const { bundleRoot, manifest } = validateBundle(
    options.bundlePath,
    options.expectedCommit,
  );
  if (isWithin(vaultRoot, bundleRoot)) {
    fail("The Bridge bundle must remain outside the target vault.");
  }
  const requestedBackupRoot = path.resolve(
    options.backupRoot || defaultBackupRoot(),
  );
  if (isWithin(vaultRoot, requestedBackupRoot))
    fail("Private backups must remain outside the vault.");
  mkdirSync(requestedBackupRoot, { recursive: true, mode: 0o700 });
  const backupRootInfo = lstatSync(requestedBackupRoot);
  if (!backupRootInfo.isDirectory() || backupRootInfo.isSymbolicLink()) {
    fail("Private backup root must be a real directory.");
  }
  const backupRoot = realpathSync(requestedBackupRoot);
  if (isWithin(vaultRoot, backupRoot)) {
    fail("Private backups must resolve outside the vault.");
  }
  const transactionId = randomUUID();
  const releaseLock = acquireLock(pluginRootReal, transactionId);
  let backupPath;
  let stagePath;
  let backup;
  let backupWritten = false;

  try {
    backupPath = path.join(
      backupRoot,
      `bridge-upgrade-${new Date().toISOString().replaceAll(":", "-")}-${transactionId}`,
    );
    stagePath = path.join(
      pluginRootReal,
      `.optimike-bridge-stage-${transactionId}`,
    );
    assertChild(backupRoot, backupPath, "Backup directory");
    assertChild(pluginRootReal, stagePath, "Staging directory");
    if (
      process.env.OPTIMIKE_BRIDGE_INSTALL_TEST_MODE === "1" &&
      process.env.OPTIMIKE_BRIDGE_INSTALL_TEST_PREPARATION_FAILURE === "1"
    ) {
      fail("Simulated Bridge installation preparation failure.");
    }
    mkdirSync(backupPath, { recursive: true, mode: 0o700 });
    mkdirSync(stagePath, { recursive: true });

    backup = {
      schemaVersion: 1,
      transactionId,
      createdAt: new Date().toISOString(),
      vaultPathSha256: sha256(
        Buffer.from(normalizeForComparison(vaultRoot), "utf8"),
      ),
      bundle: {
        version: manifest.bundle.version,
        sourceCommit: manifest.bundle.sourceCommit,
      },
      bridges: [],
    };
  } catch (error) {
    if (stagePath) removeStageDirectory(pluginRootReal, transactionId);
    if (backupPath) rmSync(backupPath, { recursive: true, force: true });
    releaseLock();
    throw new Error(
      `Bridge installation preparation failed before mutation. ${error.message}`,
      { cause: error },
    );
  }

  try {
    for (const bridge of manifest.bridges) {
      const destination = path.join(pluginRootReal, bridge.id);
      assertSafePluginDirectory(pluginRootReal, destination);
      const destinationExisted = existsSync(destination);
      const stageBridge = path.join(stagePath, bridge.id);
      mkdirSync(stageBridge, { recursive: true });
      for (const descriptor of bridge.files) {
        const name = path.basename(descriptor.path);
        const source = path.join(bundleRoot, ...descriptor.path.split("/"));
        const staged = path.join(stageBridge, name);
        copyFileSync(source, staged);
        if (
          !currentMatches(staged, {
            present: true,
            sha256: descriptor.sha256,
            size: descriptor.size,
          })
        ) {
          fail("Staging checksum validation failed.");
        }
      }
      const files = managedFiles.map((name) => ({
        name,
        previous: describeExistingFile(
          path.join(destination, name),
          `${bridge.id}/${name}`,
          backupPath,
        ),
        installed: installExpectation(bridge, name),
        oldTempName: `.optimike-old-${transactionId}-${name}`,
      }));
      backup.bridges.push({
        id: bridge.id,
        version: bridge.version,
        destinationExisted,
        files,
      });
    }
    writeDurableJson(path.join(backupPath, "backup.json"), backup);
    backupWritten = true;
    updateBackupState(backupPath, transactionId, "prepared");
    updateBackupState(backupPath, transactionId, "applying");

    let installedFileCount = 0;
    for (
      let bridgeIndex = 0;
      bridgeIndex < backup.bridges.length;
      bridgeIndex += 1
    ) {
      const bridge = backup.bridges[bridgeIndex];
      const destination = path.join(pluginRootReal, bridge.id);
      mkdirSync(destination, { recursive: true });
      for (const file of bridge.files) {
        const target = path.join(destination, file.name);
        const staged = file.installed.present
          ? path.join(stagePath, bridge.id, file.name)
          : null;
        replaceManagedFile(
          target,
          staged,
          path.join(destination, file.oldTempName),
        );
        installedFileCount += 1;
        if (
          process.env.OPTIMIKE_BRIDGE_INSTALL_TEST_MODE === "1" &&
          Number(options.simulateCrashAfterFile) === installedFileCount
        ) {
          process.exit(86);
        }
        if (!currentMatches(target, file.installed)) {
          fail("Installed Bridge checksum validation failed.");
        }
      }
      if (
        process.env.OPTIMIKE_BRIDGE_INSTALL_TEST_MODE === "1" &&
        Number(options.simulateFailureAfterBridge) === bridgeIndex + 1
      ) {
        fail("Simulated Bridge installation failure.");
      }
    }
    updateBackupState(backupPath, transactionId, "committed");
    for (const bridge of backup.bridges) {
      const destination = path.join(pluginRootReal, bridge.id);
      for (const file of bridge.files) {
        rmSync(path.join(destination, file.oldTempName), { force: true });
      }
    }
    removeStageDirectory(pluginRootReal, transactionId);
    return {
      ok: true,
      outcome: "committed",
      bundleVersion: manifest.bundle.version,
      sourceCommit: manifest.bundle.sourceCommit,
      bridges: backup.bridges.map(({ id, version }) => ({ id, version })),
      backupPath,
    };
  } catch (error) {
    if (!backupWritten) {
      removeStageDirectory(pluginRootReal, transactionId);
      rmSync(backupPath, { recursive: true, force: true });
      throw new Error(
        `Bridge installation failed before mutation. ${error.message}`,
        {
          cause: error,
        },
      );
    }
    try {
      updateBackupState(backupPath, transactionId, "recovery_required");
      rollbackInternal({
        backupPath,
        backup,
        pluginRoot: pluginRootReal,
        strictInstalledFence: false,
      });
      updateBackupState(backupPath, transactionId, "rolled_back_after_failure");
    } catch (rollbackError) {
      updateBackupState(backupPath, transactionId, "manual_recovery_required");
      throw new Error(
        `Bridge installation failed and automatic rollback also failed. Recovery backup: ${backupPath}. ${rollbackError.message}`,
        { cause: error },
      );
    } finally {
      removeStageDirectory(pluginRootReal, transactionId);
    }
    throw new Error(
      `Bridge installation failed and was rolled back. Recovery evidence: ${backupPath}. ${error.message}`,
      { cause: error },
    );
  } finally {
    releaseLock();
  }
}

function rollbackBundle(options) {
  if (!options.confirmObsidianClosed) {
    fail(
      "Refusing rollback without explicit confirmation that Obsidian is closed.",
    );
  }
  const vaultRoot = realpathSync(options.vaultPath);
  const pluginRoot = realpathSync(path.join(vaultRoot, ".obsidian", "plugins"));
  if (!isWithin(vaultRoot, pluginRoot)) {
    fail("The rollback plugin root escapes the vault.");
  }
  const requestedBackupPath = path.resolve(options.backupPath);
  const backupPathInfo = lstatSync(requestedBackupPath);
  if (!backupPathInfo.isDirectory() || backupPathInfo.isSymbolicLink()) {
    fail("Private backup path must be a real directory.");
  }
  const backupPath = realpathSync(requestedBackupPath);
  if (isWithin(vaultRoot, backupPath))
    fail("Private backup must remain outside the vault.");
  const backup = readBoundedJson(
    path.join(backupPath, "backup.json"),
    "Backup manifest",
  );
  validateBackupManifest(backupPath, backup, vaultRoot);
  const backupState = readBackupState(backupPath, backup.transactionId);
  if (
    ![
      "committed",
      "prepared",
      "applying",
      "recovery_required",
      "manual_recovery_required",
      "rollback_in_progress",
    ].includes(backupState)
  ) {
    fail("Backup is not authorized for rollback in this vault and state.");
  }
  const releaseLock = acquireLock(
    pluginRoot,
    backup.transactionId,
    backup.transactionId,
  );
  try {
    assertRollbackCandidates({
      backup,
      pluginRoot,
      strictInstalledFence: backupState === "committed",
    });
    if (backupState !== "rollback_in_progress") {
      updateBackupState(
        backupPath,
        backup.transactionId,
        "rollback_in_progress",
      );
    }
    rollbackInternal({
      backupPath,
      backup,
      pluginRoot,
      strictInstalledFence: false,
      simulateFailureAfterFile: options.simulateRollbackFailureAfterFile,
    });
    removeStageDirectory(pluginRoot, backup.transactionId);
    updateBackupState(backupPath, backup.transactionId, "rolled_back");
    return {
      ok: true,
      outcome: "rolled_back",
      bundleVersion: backup.bundle.version,
      sourceCommit: backup.bundle.sourceCommit,
      bridges: backup.bridges.map(({ id, version }) => ({ id, version })),
      backupPath,
    };
  } finally {
    releaseLock();
  }
}

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  if (!mode || !["install", "rollback"].includes(mode)) {
    fail("Usage: install-bridge-bundle.mjs <install|rollback> [options]");
  }
  const options = { mode, confirmObsidianClosed: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--confirm-obsidian-closed") {
      options.confirmObsidianClosed = true;
      continue;
    }
    const key = {
      "--vault": "vaultPath",
      "--bundle": "bundlePath",
      "--expected-commit": "expectedCommit",
      "--backup": "backupPath",
      "--backup-root": "backupRoot",
      "--simulate-failure-after-bridge": "simulateFailureAfterBridge",
      "--simulate-rollback-failure-after-file":
        "simulateRollbackFailureAfterFile",
      "--simulate-crash-after-file": "simulateCrashAfterFile",
    }[token];
    if (!key || index + 1 >= rest.length)
      fail(`Unknown or incomplete option: ${token}`);
    options[key] = rest[index + 1];
    index += 1;
  }
  if (!options.vaultPath) fail("--vault is required.");
  if (mode === "install" && (!options.bundlePath || !options.expectedCommit)) {
    fail("Install requires --bundle and --expected-commit.");
  }
  if (mode === "rollback" && !options.backupPath) {
    fail("Rollback requires --backup.");
  }
  if (
    (options.simulateFailureAfterBridge ||
      options.simulateRollbackFailureAfterFile ||
      options.simulateCrashAfterFile) &&
    process.env.OPTIMIKE_BRIDGE_INSTALL_TEST_MODE !== "1"
  ) {
    fail(
      "Failure simulation is available only in the deterministic test harness.",
    );
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result =
    options.mode === "install"
      ? installBundle(options)
      : rollbackBundle(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Bridge installation failed."}\n`,
  );
  process.exitCode = 1;
}
