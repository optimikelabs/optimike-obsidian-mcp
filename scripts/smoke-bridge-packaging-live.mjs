#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedVault = path.resolve(
  "C:\\Users\\micka\\.codex\\visualizations\\2026\\07\\20\\019f801c-bc43-72f0-bf34-31552d406cbc\\operon-bridge-pilot-vault-2.5.0",
);
const expectedVaultName = "operon-bridge-pilot-vault-2.5.0";
const expectedBaseUrl = "http://127.0.0.1:27233";
const confirmation = "I_CONFIRM_PILOT_2_BRIDGE_UPGRADE_AND_ROLLBACK";
const bridgeIds = [
  "optimike-operon-bridge",
  "obsidian-atomic-write-bridge",
  "obsidian-bases-bridge",
];
const managedFiles = ["main.js", "manifest.json", "styles.css"];
const routes = [
  "/extensions/optimike-operon-bridge/v1/status",
  "/extensions/obsidian-atomic-write-bridge/status",
  "/extensions/obsidian-bases-bridge/atomic/status",
];

const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const baseUrl = process.env.OBSIDIAN_BASE_URL?.replace(/\/$/u, "");
const configuredVault = path.resolve(process.env.OBSIDIAN_VAULT ?? "");
assert.equal(
  process.env.BRIDGE_PACKAGE_CANARY_CONFIRM,
  confirmation,
  `Set BRIDGE_PACKAGE_CANARY_CONFIRM=${confirmation}.`,
);
assert.ok(apiKey, "OBSIDIAN_API_KEY is required and is never logged.");
assert.equal(baseUrl, expectedBaseUrl);
assert.equal(configuredVault.toLowerCase(), expectedVault.toLowerCase());

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...options.env },
    timeout: options.timeout ?? 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 800)}`,
    );
  }
  return result.stdout.trim();
}

function runObsidian(args, label, options = {}) {
  const command = process.env.BRIDGE_PACKAGE_OBSIDIAN_CLI?.trim() || "obsidian";
  return run(command, args, label, options);
}

function runNpm(args, label, options = {}) {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args], label, options);
  }
  return run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    label,
    options,
  );
}

function snapshotInstalled() {
  const result = {};
  for (const id of bridgeIds) {
    const directory = path.join(expectedVault, ".obsidian", "plugins", id);
    result[id] = { managed: {}, data: null };
    for (const name of managedFiles) {
      const filePath = path.join(directory, name);
      result[id].managed[name] = existsSync(filePath)
        ? digest(readFileSync(filePath))
        : null;
    }
    const dataPath = path.join(directory, "data.json");
    result[id].data = existsSync(dataPath)
      ? digest(readFileSync(dataPath))
      : null;
  }
  return result;
}

function assertDataUnchanged(before, after) {
  for (const id of bridgeIds) {
    assert.equal(after[id].data, before[id].data, `${id} data.json changed.`);
  }
}

function expectedCandidateSnapshot(manifest, baseline) {
  const expected = structuredClone(baseline);
  for (const bridge of manifest.bridges) {
    for (const name of managedFiles) {
      const descriptor = bridge.files.find((file) =>
        file.path.endsWith(`/${name}`),
      );
      expected[bridge.id].managed[name] = descriptor?.sha256 ?? null;
    }
  }
  return expected;
}

async function waitForLocalRest(expectedOpen, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const response = await fetch(`${baseUrl}/`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (expectedOpen && response.ok) return;
      if (!expectedOpen) lastError = new Error("Local REST is still open.");
    } catch (error) {
      if (!expectedOpen) return;
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `Local REST did not become ${expectedOpen ? "available" : "closed"}: ${lastError?.message ?? "timeout"}`,
  );
}

async function waitForRoutes() {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      for (const route of routes) {
        const response = await fetch(`${baseUrl}${route}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        assert.equal(response.ok, true, `${route} returned ${response.status}`);
        await response.json();
      }
      return;
    } catch (error) {
      lastError = error;
      await sleep(750);
    }
  }
  throw new Error(
    `Bridge routes did not recover: ${lastError?.message ?? "timeout"}`,
  );
}

async function closePilot() {
  const command = process.env.BRIDGE_PACKAGE_OBSIDIAN_CLI?.trim() || "obsidian";
  spawnSync(
    command,
    [
      `vault=${expectedVaultName}`,
      "eval",
      "code=window.close(); 'pilot-window-close-requested'",
    ],
    { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  await waitForLocalRest(false);
}

async function openPilot() {
  let lastError;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const output = runObsidian(
        [`vault=${expectedVaultName}`, "vault", "info=path"],
        "open Pilot 2",
        { timeout: 30_000 },
      );
      assert.equal(
        path.resolve(output).toLowerCase(),
        expectedVault.toLowerCase(),
      );
      await waitForLocalRest(true);
      await waitForRoutes();
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error(`Pilot 2 did not reopen: ${lastError?.message ?? "timeout"}`);
}

function install(bundleRoot, candidateSha, backupRoot) {
  const output = run(
    process.execPath,
    [
      path.join(projectRoot, "scripts", "install-bridge-bundle.mjs"),
      "install",
      "--vault",
      expectedVault,
      "--bundle",
      bundleRoot,
      "--expected-commit",
      candidateSha,
      "--backup-root",
      backupRoot,
      "--confirm-obsidian-closed",
    ],
    "Bridge bundle install",
  );
  return JSON.parse(output);
}

function rollback(backupPath) {
  const output = run(
    process.execPath,
    [
      path.join(projectRoot, "scripts", "install-bridge-bundle.mjs"),
      "rollback",
      "--vault",
      expectedVault,
      "--backup",
      backupPath,
      "--confirm-obsidian-closed",
    ],
    "Bridge bundle rollback",
  );
  return JSON.parse(output);
}

function runDoctor() {
  runNpm(["run", "smoke:capability-doctor-live"], "capability doctor", {
    timeout: 240_000,
    env: {
      CAPABILITY_DOCTOR_CANARY_CONFIRM:
        "I_UNDERSTAND_THIS_IS_A_READ_ONLY_PILOT_2_CANARY",
    },
  });
}

async function main() {
  const activeVault = runObsidian(
    ["vault", "info=path"],
    "attest active Obsidian vault",
  );
  assert.equal(
    path.resolve(activeVault).toLowerCase(),
    expectedVault.toLowerCase(),
  );
  const targetedVault = runObsidian(
    [`vault=${expectedVaultName}`, "vault", "info=path"],
    "attest Pilot 2 vault",
  );
  assert.equal(
    path.resolve(targetedVault).toLowerCase(),
    expectedVault.toLowerCase(),
  );

  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  assert.match(candidateSha, /^[0-9a-f]{40}$/);
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim(),
    "",
    "The packaging canary requires a clean tracked exact-SHA worktree.",
  );
  runNpm(["run", "package:bridge-bundle"], "build Bridge release bundle");
  const rootPackage = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  assert.equal(rootPackage.version, "3.5.0");
  const bundleRoot = path.join(
    projectRoot,
    "out",
    "bridge-bundle",
    `optimike-bridge-bundle-v${rootPackage.version}`,
  );
  const bundleManifest = JSON.parse(
    readFileSync(path.join(bundleRoot, "bridge-bundle.json"), "utf8"),
  );
  assert.equal(bundleManifest.bundle.sourceCommit, candidateSha);

  const privateRoot = mkdtempSync(
    path.join(os.tmpdir(), "optimike-bridge-package-live-"),
  );
  const evidencePath = path.join(
    os.tmpdir(),
    `optimike-bridge-package-${Date.now()}.json`,
  );
  const baseline = snapshotInstalled();
  const expectedCandidate = expectedCandidateSnapshot(bundleManifest, baseline);
  const evidence = {
    schemaVersion: 1,
    candidateSha,
    bundleVersion: rootPackage.version,
    startedAt: new Date().toISOString(),
    upgrade: false,
    firstDoctor: false,
    rollback: false,
    reinstall: false,
    finalDoctor: false,
    dataJsonUnchanged: false,
    restoredOnFailure: false,
    ok: false,
  };
  let pilotClosed = false;
  let currentState = "baseline";
  let firstReceipt;
  let secondReceipt;

  try {
    await closePilot();
    pilotClosed = true;
    firstReceipt = install(bundleRoot, candidateSha, privateRoot);
    currentState = "candidate-first";
    evidence.upgrade = firstReceipt.outcome === "committed";
    await openPilot();
    pilotClosed = false;
    assert.deepEqual(snapshotInstalled(), expectedCandidate);
    runDoctor();
    evidence.firstDoctor = true;

    await closePilot();
    pilotClosed = true;
    assert.equal(rollback(firstReceipt.backupPath).outcome, "rolled_back");
    currentState = "baseline";
    evidence.rollback = true;
    assert.deepEqual(snapshotInstalled(), baseline);

    secondReceipt = install(bundleRoot, candidateSha, privateRoot);
    currentState = "candidate-second";
    evidence.reinstall = secondReceipt.outcome === "committed";
    await openPilot();
    pilotClosed = false;
    const finalSnapshot = snapshotInstalled();
    assert.deepEqual(finalSnapshot, expectedCandidate);
    assertDataUnchanged(baseline, finalSnapshot);
    evidence.dataJsonUnchanged = true;
    runDoctor();
    evidence.finalDoctor = true;
    evidence.ok = true;
    rmSync(privateRoot, { recursive: true, force: true });
  } finally {
    if (!evidence.ok) {
      try {
        if (!pilotClosed) {
          await closePilot();
          pilotClosed = true;
        }
        if (currentState === "candidate-second" && secondReceipt) {
          rollback(secondReceipt.backupPath);
          currentState = "baseline";
        } else if (currentState === "candidate-first" && firstReceipt) {
          rollback(firstReceipt.backupPath);
          currentState = "baseline";
        }
        await openPilot();
        pilotClosed = false;
        assert.deepEqual(snapshotInstalled(), baseline);
        evidence.restoredOnFailure = true;
      } catch {
        evidence.restoredOnFailure = false;
      }
    }
    evidence.completedAt = new Date().toISOString();
    writeFileSync(
      evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    console.log(`Evidence: ${evidencePath}`);
    if (!evidence.ok)
      console.log(`Private recovery directory retained: ${privateRoot}`);
  }
  console.log(
    "PASS: exact-SHA Bridge upgrade, restart, doctor, byte-exact rollback and final reinstall in Pilot 2",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
