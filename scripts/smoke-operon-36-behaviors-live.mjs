#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertByteExactCanaryDateIsolation } from "./modified-time-canary-helpers.mjs";

const EXPECTED_VAULT = path.resolve(
  "C:\\Users\\micka\\.codex\\visualizations\\2026\\07\\20\\019f801c-bc43-72f0-bf34-31552d406cbc\\operon-bridge-pilot-vault-2.5.0",
);
const EXPECTED_VAULT_NAME = "operon-bridge-pilot-vault-2.5.0";
const EXPECTED_BASE_URL = "http://127.0.0.1:27233";
const EXPECTED_OPERON_VERSION = "3.6.0";
const EXPECTED_MCP_VERSION = "3.2.0";
const EXPECTED_BRIDGE_VERSION = "0.8.3";
const RUN_CONFIRMATION = "I_CONFIRM_PILOT_2_OPERON_36_BEHAVIOR_MUTATIONS";
const PROJECT_ROOT = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const BACKEND_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const READ_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_36_BEHAVIOR_CANARY_READ_TIMEOUT_MS,
  30_000,
  5_000,
  120_000,
);
const MUTATION_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_36_BEHAVIOR_CANARY_MUTATION_TIMEOUT_MS,
  150_000,
  125_000,
  300_000,
);
const SETTLE_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_36_BEHAVIOR_CANARY_SETTLE_TIMEOUT_MS,
  45_000,
  10_000,
  180_000,
);

const DELETION_SKIP_REASON = "public_delete_surface_unavailable";
const PARENT_DATE_MISSING_REASON = "public_configuration_not_announced";
const PARENT_DATE_DISABLED_REASON = "public_configuration_disabled";
const PERIODIC_TASK_SOURCE_PROJECTION_UNAVAILABLE_REASON =
  "public_task_source_projection_unavailable";
const MUTATION_RETRY_LIMIT = 3;

const TOOL_MUTATION_CAPABILITIES = Object.freeze({
  operon_create_task: "create",
  operon_update_periodic_scheduling: "periodicUpdate",
  operon_update_task: "update",
  operon_set_relationships: "relationshipMutation",
});

// Live and offline destructive helpers are bound to one verified real vault
// root. A lexical prefix alone cannot contain a Windows junction swap.
let activeVaultIdentity = null;

function boundedInteger(raw, fallback, minimum, maximum) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Timeout must be an integer between ${minimum} and ${maximum} ms.`,
    );
  }
  return value;
}

function envTrue(name) {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value) {
  return sha256(String(value)).slice(0, 16);
}

function safePublicCode(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/u.test(value)
    ? value
    : null;
}

function publicFailureMetadata(result) {
  const details =
    result?.error?.details && typeof result.error.details === "object"
      ? result.error.details
      : {};
  return {
    errorCode: safePublicCode(result?.error?.code),
    reasonCode: safePublicCode(
      result?.error?.reasonCode ?? details?.reasonCode,
    ),
    retryable:
      typeof result?.retryable === "boolean"
        ? result.retryable
        : typeof details?.retryable === "boolean"
          ? details.retryable
          : null,
    mutationMayHaveApplied:
      typeof result?.mutationMayHaveApplied === "boolean"
        ? result.mutationMayHaveApplied
        : typeof details?.mutationMayHaveApplied === "boolean"
          ? details.mutationMayHaveApplied
          : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalRelativeMarkdownPath(value) {
  if (
    typeof value !== "string" ||
    !value.endsWith(".md") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment === segment.trim() &&
        segment !== "." &&
        segment !== "..",
    );
}

function normalizedPathIdentity(value) {
  const normalized = path.resolve(value).replace(/^\\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePathIdentity(left, right) {
  return normalizedPathIdentity(left) === normalizedPathIdentity(right);
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function sealPhysicalDirectoryIdentity(metadata) {
  assert.equal(
    typeof metadata.dev,
    "bigint",
    "Pilot vault root stable filesystem identity is unavailable or ambiguous.",
  );
  assert.equal(
    typeof metadata.ino,
    "bigint",
    "Pilot vault root stable filesystem identity is unavailable or ambiguous.",
  );
  assert.equal(
    metadata.dev > 0n && metadata.ino > 0n,
    true,
    "Pilot vault root stable filesystem identity is unavailable or ambiguous.",
  );
  return Object.freeze({
    device: metadata.dev.toString(),
    file: metadata.ino.toString(),
  });
}

function currentVaultIdentity() {
  assert.ok(activeVaultIdentity, "Pilot vault identity was not initialized.");
  return activeVaultIdentity;
}

async function assertVaultRootIdentity(requestedRoot) {
  const requested = path.resolve(requestedRoot);
  const metadata = await lstat(requested, { bigint: true });
  assert.equal(
    metadata.isDirectory(),
    true,
    "Pilot vault root is not a directory.",
  );
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    "Pilot vault root must not be a symlink or junction.",
  );
  const resolved = await realpath(requested);
  assert.equal(
    samePathIdentity(resolved, requested),
    true,
    "Pilot vault root must resolve to its requested path (no junction).",
  );
  return Object.freeze({
    requestedRoot: requested,
    realRoot: resolved,
    // Node maps these to volume serial + file ID on Windows and device +
    // inode on Unix. Strings keep the process-local seal serialization-safe.
    physicalIdentity: sealPhysicalDirectoryIdentity(metadata),
  });
}

async function assertVaultRootStillSame(label) {
  const sealed = currentVaultIdentity();
  const observed = await assertVaultRootIdentity(sealed.requestedRoot);
  assert.equal(
    observed.physicalIdentity.device === sealed.physicalIdentity.device &&
      observed.physicalIdentity.file === sealed.physicalIdentity.file,
    true,
    `${label}: Pilot vault root physical identity changed after preflight.`,
  );
}

async function assertSafeVaultDirectory(absolutePath, label) {
  await assertVaultRootStillSame(label);
  const identity = currentVaultIdentity();
  assert.equal(
    samePathIdentity(absolutePath, identity.realRoot) ||
      isStrictDescendant(identity.realRoot, absolutePath),
    true,
    `${label} escaped the verified Pilot vault root.`,
  );
  const metadata = await lstat(absolutePath);
  assert.equal(metadata.isDirectory(), true, `${label} is not a directory.`);
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    `${label} must not be a symlink or junction.`,
  );
  assert.equal(
    samePathIdentity(await realpath(absolutePath), absolutePath),
    true,
    `${label} must not resolve through a symlink or junction.`,
  );
}

async function assertSafeVaultParentChain(absolutePath, label) {
  const identity = currentVaultIdentity();
  assert.equal(
    isStrictDescendant(identity.realRoot, absolutePath),
    true,
    `${label} escaped the verified Pilot vault root.`,
  );
  await assertSafeVaultDirectory(identity.realRoot, "Pilot vault root");
  let current = identity.realRoot;
  for (const segment of path
    .relative(identity.realRoot, absolutePath)
    .split(path.sep)
    .slice(0, -1)) {
    current = path.join(current, segment);
    await assertSafeVaultDirectory(current, `${label} parent`);
  }
}

async function safeVaultRegularFile(
  relativePath,
  label,
  { allowMissing = false } = {},
) {
  const absolute = absoluteVaultPath(relativePath);
  await assertSafeVaultParentChain(absolute, label);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return { absolute, exists: false, metadata: null };
    }
    throw error;
  }
  assert.equal(metadata.isFile(), true, `${label} is not a regular file.`);
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    `${label} must not be a symlink or reparse point.`,
  );
  assert.equal(metadata.nlink, 1, `${label} must not be hardlinked.`);
  assert.equal(
    samePathIdentity(await realpath(absolute), absolute),
    true,
    `${label} must not resolve through a symlink or junction.`,
  );
  await assertSafeVaultParentChain(absolute, label);
  metadata = await lstat(absolute);
  assert.equal(metadata.isFile(), true, `${label} stopped being a file.`);
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    `${label} became a symlink or reparse point.`,
  );
  assert.equal(metadata.nlink, 1, `${label} became a hardlink.`);
  return { absolute, exists: true, metadata };
}

function plannedTaskSourcePaths(plan) {
  const paths = new Set(
    [
      plan?.periodicRoute?.notePath,
      plan?.periodicUpdate?.notePath,
      ...(plan?.periodicUpdate?.sourceTransitions ?? []).map(
        (transition) => transition?.filePath,
      ),
    ].filter((value) => typeof value === "string"),
  );
  const seen = new WeakSet();
  const visit = (value, key = "") => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [childKey, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        ["filePath", "notePath", "targetPath", "path"].includes(childKey)
      ) {
        paths.add(child);
      } else if (child && typeof child === "object") {
        visit(child, childKey);
      }
    }
    void key;
  };
  visit(plan);
  return paths;
}

function periodicSchedulingProjectedTaskSourcePaths(plan) {
  const sourceTransitions = Array.isArray(
    plan?.periodicUpdate?.sourceTransitions,
  )
    ? plan.periodicUpdate.sourceTransitions
    : [];
  const taskSources = Array.isArray(plan?.projection?.taskSources)
    ? plan.projection.taskSources
    : [];
  return new Set(
    [
      plan?.periodicRoute?.notePath,
      plan?.periodicUpdate?.notePath,
      ...sourceTransitions.map((transition) => transition?.filePath),
      ...taskSources.map((taskSource) => taskSource?.filePath),
    ].filter((value) => typeof value === "string"),
  );
}

function periodicSchedulingDispatchDecision(plan) {
  // Periodic scheduling needs an explicit public task-source projection. Do
  // not treat opaque metadata (including metadata.path) as a dispatch grant.
  const paths = periodicSchedulingProjectedTaskSourcePaths(plan);
  return {
    paths,
    dispatch: paths.size > 0,
    reason:
      paths.size > 0
        ? null
        : PERIODIC_TASK_SOURCE_PROJECTION_UNAVAILABLE_REASON,
  };
}

function routeAcceptsOpaquePlanMetadata(name) {
  return [
    "operon_create_task",
    "operon_update_task",
    "operon_set_relationships",
  ].includes(name);
}

async function assertSafePlannedTaskSourceArtifacts(
  plan,
  label,
  { requirePaths = false, paths = plannedTaskSourcePaths(plan) } = {},
) {
  if (requirePaths) {
    assert.ok(
      paths.size > 0,
      `${label} did not seal every periodic source path; refusing a physically unbounded mutation.`,
    );
  }
  for (const relativePath of paths) {
    await safeVaultRegularFile(relativePath, `${label} planned task source`, {
      allowMissing: true,
    });
  }
  return paths;
}

function absoluteVaultPath(relativePath) {
  assert.equal(
    canonicalRelativeMarkdownPath(relativePath),
    true,
    `Unsafe vault-relative Markdown path: ${relativePath}`,
  );
  const identity = currentVaultIdentity();
  const absolute = path.resolve(identity.realRoot, ...relativePath.split("/"));
  assert.equal(
    isStrictDescendant(identity.realRoot, absolute),
    true,
    "Resolved fixture escaped the Pilot 2 vault.",
  );
  return absolute;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function createSymlinkOrReport(target, linkPath, type) {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    // Windows can deny unprivileged symbolic-link creation. The production
    // helper still rejects links on every supported platform, so this fixture
    // is a safe explicit skip only when the OS cannot create one.
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
}

async function runProjectCommand(args, label) {
  const child = spawn("git", args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostic = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString("utf8");
  });
  const exitCode = await withTimeout(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    }),
    label,
    15_000,
  );
  if (exitCode !== 0) {
    throw new Error(`${label} failed (${String(exitCode)}).`);
  }
  // Command diagnostics can contain local paths. They are deliberately never
  // copied into the redacted canary evidence.
  void diagnostic;
  return output.trim();
}

async function runNpmCommand(args, label) {
  // Node 24 on Windows can reject a direct .cmd spawn with EINVAL. Invoke the
  // npm CLI through this same Node binary. npm_execpath is authoritative when
  // the canary is launched by npm; the fallback covers direct node invocation
  // without assuming the Windows-only Node installation layout on POSIX.
  const nodeDirectory = path.dirname(process.execPath);
  const npmCli =
    process.env.npm_execpath?.trim() ||
    (process.platform === "win32"
      ? path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js")
      : path.resolve(
          nodeDirectory,
          "..",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ));
  const child = spawn(process.execPath, [npmCli, ...args], {
    cwd: PROJECT_ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Build diagnostics are intentionally not evidence, but the pipes still
  // need draining so a verbose compiler cannot deadlock this gate.
  child.stdout.resume();
  child.stderr.resume();
  const exitCode = await withTimeout(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    }),
    label,
    120_000,
  );
  if (exitCode !== 0) throw new Error(`${label} failed (${String(exitCode)}).`);
}

async function assertRegularNonLinkFile(absolutePath, label) {
  const metadata = await lstat(absolutePath);
  assert.equal(metadata.isFile(), true, `${label} is not a file.`);
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    `${label} must not be a symlink or reparse point.`,
  );
  assert.equal(metadata.nlink, 1, `${label} must not be hardlinked.`);
  assert.equal(
    samePathIdentity(await realpath(absolutePath), absolutePath),
    true,
    `${label} must not resolve through a symlink or junction.`,
  );
}

function expectedBuiltBridgeManifest(sourceManifest) {
  assert.equal(
    sourceManifest !== null &&
      typeof sourceManifest === "object" &&
      !Array.isArray(sourceManifest),
    true,
    "Local Bridge source manifest is not an object.",
  );
  // The build adds the Obsidian runtime entry while the source manifest stays
  // the authored release contract.
  return { ...sourceManifest, main: "main.js" };
}

function assertBuiltBridgeManifest(
  sourceManifestBytes,
  buildManifestBytes,
  label,
) {
  const sourceManifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  const buildManifest = JSON.parse(buildManifestBytes.toString("utf8"));
  assert.deepEqual(
    buildManifest,
    expectedBuiltBridgeManifest(sourceManifest),
    `${label} does not equal the normalized source manifest plus main.js.`,
  );
}

async function attestLiveCandidate(vaultRoot) {
  // Both generated outputs are ignored by Git. Rebuild them first: equal
  // stale artifacts must never impersonate this checkout's candidate.
  await runNpmCommand(["run", "build"], "MCP candidate rebuild");
  await runNpmCommand(
    ["--prefix", "plugins/obsidian-operon-bridge", "run", "build"],
    "Operon Bridge candidate rebuild",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.version,
    EXPECTED_MCP_VERSION,
    "package.json MCP version differs from the expected live candidate.",
  );

  const bridgeRoot = path.join(
    PROJECT_ROOT,
    "plugins",
    "obsidian-operon-bridge",
  );
  const [bridgePackage, bridgeManifest] = await Promise.all([
    readFile(path.join(bridgeRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(bridgeRoot, "manifest.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(
    bridgePackage.version,
    EXPECTED_BRIDGE_VERSION,
    "Local Operon Bridge package version differs from the expected live candidate.",
  );
  assert.equal(
    bridgeManifest.version,
    EXPECTED_BRIDGE_VERSION,
    "Local Operon Bridge manifest version differs from the expected live candidate.",
  );

  const gitHead = await runProjectCommand(["rev-parse", "HEAD"], "git HEAD");
  assert.match(gitHead, /^[a-f0-9]{40}$/u, "git HEAD is not an exact SHA.");
  const porcelain = await runProjectCommand(
    ["status", "--porcelain=v1"],
    "git worktree status",
  );
  assert.equal(
    porcelain.length,
    0,
    "Live canary requires a clean worktree so its evidence names one exact candidate.",
  );

  const sourceBuild = path.join(bridgeRoot, "build", "main.js");
  const sourceBuildManifest = path.join(bridgeRoot, "build", "manifest.json");
  const sourceManifest = path.join(bridgeRoot, "manifest.json");
  const rootBuild = path.join(PROJECT_ROOT, "dist", "index.js");
  const installedPluginRoot = path.join(
    vaultRoot,
    ".obsidian",
    "plugins",
    "optimike-operon-bridge",
  );
  const installedBuild = path.join(installedPluginRoot, "main.js");
  const installedManifest = path.join(installedPluginRoot, "manifest.json");
  await Promise.all([
    assertRegularNonLinkFile(rootBuild, "MCP candidate build"),
    assertRegularNonLinkFile(sourceBuild, "Local Bridge candidate build"),
    assertRegularNonLinkFile(
      sourceBuildManifest,
      "Local Bridge candidate manifest",
    ),
    assertRegularNonLinkFile(sourceManifest, "Local Bridge source manifest"),
    assertRegularNonLinkFile(installedBuild, "Installed Bridge build"),
    assertRegularNonLinkFile(installedManifest, "Installed Bridge manifest"),
  ]);
  const [
    sourceBuildBytes,
    installedBuildBytes,
    sourceBuildManifestBytes,
    sourceManifestBytes,
    installedManifestBytes,
    rootBuildBytes,
  ] = await Promise.all([
    readFile(sourceBuild),
    readFile(installedBuild),
    readFile(sourceBuildManifest),
    readFile(sourceManifest),
    readFile(installedManifest),
    readFile(rootBuild),
  ]);
  const sourceHash = sha256(sourceBuildBytes);
  const installedHash = sha256(installedBuildBytes);
  assert.equal(
    installedHash,
    sourceHash,
    "Installed Operon Bridge build does not match the local candidate build.",
  );
  assertBuiltBridgeManifest(
    sourceManifestBytes,
    sourceBuildManifestBytes,
    "Generated Bridge manifest",
  );
  assert.deepEqual(
    JSON.parse(installedManifestBytes.toString("utf8")),
    JSON.parse(sourceBuildManifestBytes.toString("utf8")),
    "Installed Operon Bridge manifest does not match the local candidate manifest.",
  );
  return {
    mcpVersion: packageJson.version,
    expectedBridgeVersion: EXPECTED_BRIDGE_VERSION,
    gitHead,
    worktreeClean: true,
    mcpBuildSha256: sha256(rootBuildBytes),
    bridgeBuildSha256: sourceHash,
    installedBridgeSha256: installedHash,
    bridgeManifestSha256: sha256(sourceBuildManifestBytes),
    installedBridgeManifestSha256: sha256(installedManifestBytes),
    bridgeBuildMatchesInstalled: true,
    bridgeManifestMatchesInstalled: true,
  };
}

async function assertCandidateStillExact(candidate) {
  const [gitHead, porcelain] = await Promise.all([
    runProjectCommand(["rev-parse", "HEAD"], "git HEAD recheck"),
    runProjectCommand(["status", "--porcelain=v1"], "git worktree recheck"),
  ]);
  assert.equal(
    gitHead,
    candidate.gitHead,
    "Candidate HEAD changed after attestation.",
  );
  assert.equal(
    porcelain.length,
    0,
    "Candidate worktree changed after attestation and before native dispatch.",
  );
  assert.equal(
    sha256(await readFile(path.join(PROJECT_ROOT, "dist", "index.js"))),
    candidate.mcpBuildSha256,
    "MCP build changed after candidate attestation.",
  );
  assert.equal(
    sha256(
      await readFile(
        path.join(
          PROJECT_ROOT,
          "plugins",
          "obsidian-operon-bridge",
          "build",
          "main.js",
        ),
      ),
    ),
    candidate.bridgeBuildSha256,
    "Bridge build changed after candidate attestation.",
  );
  const installedPluginRoot = path.join(
    currentVaultIdentity().realRoot,
    ".obsidian",
    "plugins",
    "optimike-operon-bridge",
  );
  const installedBuild = path.join(installedPluginRoot, "main.js");
  const installedManifest = path.join(installedPluginRoot, "manifest.json");
  const sourceBuildManifest = path.join(
    PROJECT_ROOT,
    "plugins",
    "obsidian-operon-bridge",
    "build",
    "manifest.json",
  );
  await Promise.all([
    assertRegularNonLinkFile(
      sourceBuildManifest,
      "Local Bridge candidate manifest recheck",
    ),
    assertRegularNonLinkFile(installedBuild, "Installed Bridge build recheck"),
    assertRegularNonLinkFile(
      installedManifest,
      "Installed Bridge manifest recheck",
    ),
  ]);
  assert.equal(
    sha256(await readFile(sourceBuildManifest)),
    candidate.bridgeManifestSha256,
    "Generated Bridge manifest changed after candidate attestation.",
  );
  assert.equal(
    sha256(await readFile(installedBuild)),
    candidate.installedBridgeSha256,
    "Installed Bridge build changed after candidate attestation.",
  );
  assert.equal(
    sha256(await readFile(installedManifest)),
    candidate.installedBridgeManifestSha256,
    "Installed Bridge manifest changed after candidate attestation.",
  );
}

async function withTimeout(promise, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function redactText(value, apiKey, fixturePath, runId) {
  let text = String(value ?? "");
  for (const secret of [apiKey, EXPECTED_VAULT, fixturePath, runId]) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
    .slice(0, 2_000);
}

function parseMcpPayload(result, label) {
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned a non-JSON MCP payload.`);
  }
}

async function captureMarkdownInventory() {
  const inventory = new Map();
  async function walk(absoluteFolder, relativeFolder) {
    await assertSafeVaultDirectory(absoluteFolder, "Markdown inventory folder");
    const entries = await readdir(absoluteFolder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".obsidian") continue;
      const absolute = path.join(absoluteFolder, entry.name);
      const relative = relativeFolder
        ? `${relativeFolder}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const checked = await safeVaultRegularFile(
          relative,
          "Markdown inventory file",
        );
        const content = await readFile(checked.absolute);
        inventory.set(relative, {
          sha256: sha256(content),
          size: content.length,
        });
      }
    }
  }
  await walk(EXPECTED_VAULT, "");
  return inventory;
}

function inventoryDigest(inventory) {
  return sha256(
    [...inventory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, value]) =>
        JSON.stringify([relativePath, value.sha256, value.size]),
      )
      .join("\n"),
  );
}

function inventoryDiff(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((relativePath) => {
    const oldValue = before.get(relativePath);
    const newValue = after.get(relativePath);
    if (oldValue?.sha256 === newValue?.sha256) return [];
    return [
      {
        path: relativePath,
        change: !oldValue ? "created" : !newValue ? "removed" : "modified",
        beforeSha256: oldValue?.sha256 ?? null,
        afterSha256: newValue?.sha256 ?? null,
      },
    ];
  });
}

function redactedInventoryDiff(changes) {
  return changes.map((change) => ({
    pathHash: shortHash(change.path),
    change: change.change,
    beforeSha256Hash: change.beforeSha256
      ? shortHash(change.beforeSha256)
      : null,
    afterSha256Hash: change.afterSha256 ? shortHash(change.afterSha256) : null,
  }));
}

function parentDateAutomationState(configurationResponse) {
  const automation = configurationResponse?.configuration?.automation;
  if (
    !automation ||
    !Object.hasOwn(automation, "autoExpandParentTaskDateRange")
  ) {
    return {
      announced: false,
      enabled: false,
      reason: PARENT_DATE_MISSING_REASON,
    };
  }
  const value = automation.autoExpandParentTaskDateRange;
  assert.equal(
    typeof value,
    "boolean",
    "The public parent-date automation setting is not a boolean.",
  );
  return {
    announced: true,
    enabled: value,
    reason: value ? null : PARENT_DATE_DISABLED_REASON,
  };
}

function assertTask(task, label) {
  assert.equal(task && typeof task === "object", true, `${label} is missing.`);
  assert.match(
    task.operonId ?? "",
    /^[a-z0-9]{7}$/u,
    `${label} id is invalid.`,
  );
  assert.equal(typeof task.revision, "string", `${label} revision is missing.`);
  assert.ok(task.revision, `${label} revision is empty.`);
  assert.equal(typeof task.path, "string", `${label} path is missing.`);
  assert.equal(
    Array.isArray(task.blocking),
    true,
    `${label} blocking is malformed.`,
  );
  assert.equal(
    Array.isArray(task.blockedBy),
    true,
    `${label} blockedBy is malformed.`,
  );
  return task;
}

function assertApplied(result, label) {
  if (result?.status === "outcome-unknown") {
    throw new Error(
      `${label} returned outcome-unknown; no blind retry was attempted.`,
    );
  }
  assert.equal(result?.status, "applied", `${label} did not apply.`);
  assert.match(
    result?.planDigest ?? "",
    /^[a-f0-9]{64}$/u,
    `${label} has no sealed plan digest.`,
  );
  assertTask(result?.after, `${label} final indexed task`);
  if (result?.nativeProof) {
    assert.equal(
      ["verified", "receipt-replay"].includes(
        result.nativeProof.postflight?.status,
      ),
      true,
      `${label} native proof has no verified postflight.`,
    );
  } else {
    assert.equal(
      typeof result?.recoveryRef,
      "string",
      `${label} has neither native proof nor a durable recovery reference.`,
    );
    assert.ok(result.recoveryRef, `${label} recovery reference is empty.`);
  }
  return result;
}

function dateFixture(runId) {
  const year = 2080 + (Number.parseInt(runId.slice(0, 2), 16) % 10);
  return {
    scheduled: `${year}-06-15`,
    parentStart: `${year}-06-10`,
    parentDue: `${year}-06-20`,
    childInsideStart: `${year}-06-12`,
    childInsideDue: `${year}-06-18`,
    childOuterStart: `${year}-06-01`,
    childOuterDue: `${year}-06-30`,
  };
}

async function offlineContract() {
  assert.equal(canonicalRelativeMarkdownPath("Canary/Fixture.md"), true);
  for (const unsafe of [
    "../Fixture.md",
    "Canary\\Fixture.md",
    "/Canary/Fixture.md",
    "C:/Canary/Fixture.md",
    "Canary/../Fixture.md",
    "Canary/Fixture.txt",
  ]) {
    assert.equal(canonicalRelativeMarkdownPath(unsafe), false);
  }
  assert.deepEqual(
    parentDateAutomationState({ configuration: { automation: {} } }),
    {
      announced: false,
      enabled: false,
      reason: PARENT_DATE_MISSING_REASON,
    },
  );
  assert.deepEqual(
    parentDateAutomationState({
      configuration: {
        automation: { autoExpandParentTaskDateRange: false },
      },
    }),
    { announced: true, enabled: false, reason: PARENT_DATE_DISABLED_REASON },
  );
  assert.deepEqual(
    parentDateAutomationState({
      configuration: {
        automation: { autoExpandParentTaskDateRange: true },
      },
    }),
    { announced: true, enabled: true, reason: null },
  );
  assert.throws(() =>
    parentDateAutomationState({
      configuration: {
        automation: { autoExpandParentTaskDateRange: "true" },
      },
    }),
  );
  const periodicProjectionUnavailable = periodicSchedulingDispatchDecision({
    periodicUpdate: { metadata: { source: "opaque" } },
  });
  assert.equal(periodicProjectionUnavailable.dispatch, false);
  assert.equal(
    periodicProjectionUnavailable.reason,
    PERIODIC_TASK_SOURCE_PROJECTION_UNAVAILABLE_REASON,
  );
  const periodicMetadataPathIsNotProjection =
    periodicSchedulingDispatchDecision({
      periodicUpdate: { metadata: { path: "Canary/Fixture.md" } },
    });
  assert.equal(
    plannedTaskSourcePaths({
      periodicUpdate: { metadata: { path: "Canary/Fixture.md" } },
    }).has("Canary/Fixture.md"),
    true,
  );
  assert.equal(periodicMetadataPathIsNotProjection.dispatch, false);
  assert.equal(
    periodicMetadataPathIsNotProjection.reason,
    PERIODIC_TASK_SOURCE_PROJECTION_UNAVAILABLE_REASON,
  );
  assert.equal(
    periodicSchedulingDispatchDecision({
      periodicUpdate: {
        sourceTransitions: [{ filePath: "Canary/Fixture.md" }],
      },
    }).dispatch,
    true,
  );
  assert.equal(routeAcceptsOpaquePlanMetadata("operon_create_task"), true);
  assert.equal(routeAcceptsOpaquePlanMetadata("operon_update_task"), true);
  assert.equal(
    routeAcceptsOpaquePlanMetadata("operon_set_relationships"),
    true,
  );
  assert.equal(
    routeAcceptsOpaquePlanMetadata("operon_update_periodic_scheduling"),
    false,
  );
  assert.equal(routeAcceptsOpaquePlanMetadata("operon_unknown_route"), false);
  const baseline = new Map([
    ["Canary/Fixture.md", { sha256: sha256("before"), size: 6 }],
  ]);
  const changed = new Map([
    ["Canary/Fixture.md", { sha256: sha256("after"), size: 5 }],
    ["Canary/Created.md", { sha256: sha256("created"), size: 7 }],
  ]);
  assert.deepEqual(
    inventoryDiff(baseline, changed).map(({ path: itemPath, change }) => ({
      path: itemPath,
      change,
    })),
    [
      { path: "Canary/Created.md", change: "created" },
      { path: "Canary/Fixture.md", change: "modified" },
    ],
  );
  console.log(
    JSON.stringify({
      ok: true,
      deletion: { status: "SKIP", reason: DELETION_SKIP_REASON },
      parentDateMissing: {
        status: "SKIP",
        reason: PARENT_DATE_MISSING_REASON,
      },
      periodicScheduling: {
        status: "SKIP",
        reason: PERIODIC_TASK_SOURCE_PROJECTION_UNAVAILABLE_REASON,
      },
      periodicApplyDispatched: false,
    }),
  );
}

async function offlinePathSafetyContract() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-36-path-safety-offline-"),
  );
  const previousIdentity = activeVaultIdentity;
  try {
    await runNpmCommand(
      ["--prefix", "plugins/obsidian-operon-bridge", "run", "build"],
      "Offline Bridge manifest rebuild",
    );
    const bridgeRoot = path.join(
      PROJECT_ROOT,
      "plugins",
      "obsidian-operon-bridge",
    );
    const [sourceManifestBytes, buildManifestBytes] = await Promise.all([
      readFile(path.join(bridgeRoot, "manifest.json")),
      readFile(path.join(bridgeRoot, "build", "manifest.json")),
    ]);
    assertBuiltBridgeManifest(
      sourceManifestBytes,
      buildManifestBytes,
      "Offline rebuilt Bridge manifest",
    );
    const vaultRoot = path.join(tempRoot, "vault");
    const outsideRoot = path.join(tempRoot, "outside");
    await mkdir(vaultRoot);
    await mkdir(outsideRoot);
    await mkdir(path.join(vaultRoot, "Canary"));
    activeVaultIdentity = await assertVaultRootIdentity(vaultRoot);
    assert.throws(
      () => sealPhysicalDirectoryIdentity({ dev: 0n, ino: 0n }),
      /unavailable or ambiguous/u,
    );

    const fixturePath = "Canary/Fixture.md";
    const fixtureAbsolute = absoluteVaultPath(fixturePath);
    await writeFile(fixtureAbsolute, "fixture\n", "utf8");
    await assertSafePlannedTaskSourceArtifacts(
      { periodicUpdate: { sourceTransitions: [{ filePath: fixturePath }] } },
      "Offline behavior periodic update pre-apply",
      { requirePaths: true },
    );

    const createParent = path.join(vaultRoot, "Canary", "Periodic");
    const outsidePeriodic = path.join(outsideRoot, "periodic");
    await mkdir(createParent);
    await mkdir(outsidePeriodic);
    await assertSafePlannedTaskSourceArtifacts(
      { periodicRoute: { notePath: "Canary/Periodic/created.md" } },
      "Offline behavior periodic create pre-apply",
      { requirePaths: true },
    );
    await rm(createParent, { recursive: true, force: false });
    const junctionCreated = await createSymlinkOrReport(
      outsidePeriodic,
      createParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    if (junctionCreated) {
      await assert.rejects(
        assertSafePlannedTaskSourceArtifacts(
          { periodicRoute: { notePath: "Canary/Periodic/created.md" } },
          "Offline behavior periodic create junction swap before apply",
          { requirePaths: true },
        ),
        /symlink|junction|resolve|parent/iu,
      );
    }

    const outsideFile = path.join(outsideRoot, "outside.md");
    await writeFile(outsideFile, "outside\n", "utf8");
    await rm(fixtureAbsolute);
    await link(outsideFile, fixtureAbsolute);
    await assert.rejects(
      assertSafePlannedTaskSourceArtifacts(
        { periodicUpdate: { sourceTransitions: [{ filePath: fixturePath }] } },
        "Offline behavior periodic update hardlink swap before apply",
        { requirePaths: true },
      ),
      /hardlinked/u,
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside\n");

    const displacedVaultRoot = path.join(tempRoot, "vault-attested-original");
    await rename(vaultRoot, displacedVaultRoot);
    await mkdir(vaultRoot);
    await assert.rejects(
      assertVaultRootStillSame("Offline hostile root replacement"),
      /physical identity changed after preflight/u,
    );

    console.log(
      JSON.stringify({
        ok: true,
        periodicCreateJunctionSwapRefused: junctionCreated,
        periodicUpdateHardlinkSwapRefused: true,
        outsideFilePreserved: true,
        rootReplacementRefused: true,
        bridgeBuildManifestMatchesNormalizedSource: true,
      }),
    );
  } finally {
    activeVaultIdentity = previousIdentity;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const apiKey = (process.env.OBSIDIAN_API_KEY ?? "").trim();
  const baseUrl = (process.env.OBSIDIAN_BASE_URL ?? "").replace(/\/$/u, "");
  const requestedVault = path.resolve(process.env.OBSIDIAN_VAULT ?? "");
  const fixturePath = (
    process.env.OPERON_36_BEHAVIOR_CANARY_FIXTURE_PATH ?? ""
  ).trim();

  assert.equal(
    process.env.OPERON_36_BEHAVIOR_CANARY_CONFIRM,
    RUN_CONFIRMATION,
    `Refusing live mutations. Set OPERON_36_BEHAVIOR_CANARY_CONFIRM=${RUN_CONFIRMATION}.`,
  );
  assert.equal(
    requestedVault.toLowerCase(),
    EXPECTED_VAULT.toLowerCase(),
    "OBSIDIAN_VAULT must be the exact disposable Pilot 2 path.",
  );
  assert.equal(
    baseUrl,
    EXPECTED_BASE_URL,
    `OBSIDIAN_BASE_URL must be ${EXPECTED_BASE_URL}.`,
  );
  assert.ok(apiKey, "OBSIDIAN_API_KEY is required and is never logged.");
  assert.equal(
    envTrue("OPERON_MUTATIONS_ENABLED"),
    true,
    "OPERON_MUTATIONS_ENABLED=true is required.",
  );
  assert.equal(await exists(EXPECTED_VAULT), true, "Pilot 2 vault is missing.");
  assert.equal(
    path.basename(EXPECTED_VAULT),
    EXPECTED_VAULT_NAME,
    "Pilot 2 vault identity mismatch.",
  );
  assert.equal(
    canonicalRelativeMarkdownPath(fixturePath),
    true,
    "A canonical vault-relative existing .md fixture is required.",
  );

  activeVaultIdentity = await assertVaultRootIdentity(requestedVault);
  const fixtureCheck = await safeVaultRegularFile(fixturePath, "Fixture");
  const fixtureAbsolute = fixtureCheck.absolute;
  const fixtureStat = fixtureCheck.metadata;
  const vaultReal = activeVaultIdentity.realRoot;
  const fixtureReal = await realpath(fixtureAbsolute);

  const candidate = await attestLiveCandidate(vaultReal);

  const runId = randomUUID();
  const dates = dateFixture(runId);
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-36-behaviors-"),
  );
  const fixtureBackupPath = path.join(tempRoot, "fixture-original.md");
  const cachePath = path.join(tempRoot, "shared-cache.sqlite");
  const evidenceFile = path.join(
    os.tmpdir(),
    `operon-36-behaviors-evidence-${runId}.json`,
  );
  const manifestPath = path.join(tempRoot, "restore-manifest.json");
  const originalFixture = await readFile(fixtureAbsolute);
  const restoreTempPath = path.join(
    path.dirname(fixtureAbsolute),
    `.${path.basename(fixtureAbsolute)}.optimike-operon36-${runId}.tmp`,
  );
  const originalFixtureIdentity = {
    realPath: fixtureReal,
    nlink: fixtureStat.nlink,
  };
  const evidence = {
    schemaVersion: 1,
    redacted: true,
    ok: false,
    startedAt: new Date().toISOString(),
    runIdHash: shortHash(runId),
    vaultName: EXPECTED_VAULT_NAME,
    fixturePathHash: shortHash(fixturePath),
    candidate,
    versions: {},
    preflight: {},
    validation: {},
    pendingRecoveries: {},
    scheduledDateOnBlockedTask: { status: "PENDING" },
    parentDateExpansion: { status: "PENDING" },
    taskEditorDeletion: { status: "SKIP", reason: DELETION_SKIP_REASON },
    restoration: { restored: false },
    mutationReceipts: [],
    preDispatchDiagnostics: [],
    error: null,
  };

  let baseline = null;
  let client;
  let transport;
  let clientConnected = false;
  let backendStderr = "";
  let shutdownSignal = null;
  let mutationStarted = false;
  let success = false;
  const activeRequests = new Set();
  const createdArtifactPaths = new Set();
  const createdArtifactMarkers = new Map();

  const onSigint = () => {
    shutdownSignal ??= "SIGINT";
  };
  const onSigterm = () => {
    shutdownSignal ??= "SIGTERM";
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  function assertActive() {
    if (shutdownSignal) throw new Error(`Interrupted by ${shutdownSignal}.`);
  }

  function track(promise) {
    activeRequests.add(promise);
    promise
      .finally(() => activeRequests.delete(promise))
      .catch(() => undefined);
    return promise;
  }

  async function assertDateIsolation() {
    const [{ ObsidianRestApiService }, { requestContextService }] =
      await Promise.all([
        import("../dist/services/obsidianRestAPI/index.js"),
        import("../dist/utils/index.js"),
      ]);
    const rest = new ObsidianRestApiService();
    const context = requestContextService.createRequestContext({
      operation: "Operon36BehaviorLiveCanaryDateIsolation",
      target: fixturePath,
    });
    const status = await rest.getAtomicWriteStatus(context);
    assertByteExactCanaryDateIsolation(
      status,
      "byte-exact Operon 3.6 behavior canary",
    );
    evidence.preflight.modifiedTimeWriterIsolationVerified = true;
  }

  async function assertKnownMutationTaskSource(operonId, label) {
    const task = assertTask(
      (
        await call("operon_get_task", {
          operonId,
          includeProperties: true,
          forceRefresh: true,
        })
      )?.task,
      `${label} physical source task`,
    );
    assert.equal(
      task.path,
      fixturePath,
      `${label} addresses a task outside the dedicated fixture.`,
    );
    await safeVaultRegularFile(task.path, `${label} physical source`);
  }

  async function assertPhysicalPreDispatch(name, args, label) {
    // Every operation in this canary is deliberately confined to its existing
    // fixture. Re-read its real filesystem identity immediately before the
    // native call, not merely when the canary started.
    const expectedPaths = new Set([fixturePath]);
    await safeVaultRegularFile(fixturePath, `${label} fixture pre-dispatch`);
    const hasExplicitTaskSource = args?.task?.targetPath !== undefined;
    if (hasExplicitTaskSource) {
      assert.equal(
        args.task.targetPath,
        fixturePath,
        `${label} create target is outside the dedicated fixture.`,
      );
    }
    const taskIds = new Set(
      [
        args?.operonId,
        args?.relationships?.parentTask,
        ...(args?.relationships?.blockedBy ?? []),
        ...(args?.relationships?.blocking ?? []),
      ].filter((value) => typeof value === "string"),
    );
    let resolvedTaskSourceCount = 0;
    for (const operonId of taskIds) {
      await assertKnownMutationTaskSource(operonId, label);
      resolvedTaskSourceCount += 1;
    }

    const observed = await callRaw(
      name,
      {
        ...args,
        idempotencyKey: `${args.idempotencyKey}:physical-path-preflight`,
        dryRun: true,
      },
      { allowError: true, timeoutMs: READ_TIMEOUT_MS },
    );
    assert.equal(
      observed.isError,
      false,
      `${label} physical preflight was rejected.`,
    );
    assert.equal(
      observed.payload?.status,
      "planned",
      `${label} physical preflight did not return a sealed plan.`,
    );
    const periodicDispatch =
      name === "operon_update_periodic_scheduling"
        ? periodicSchedulingDispatchDecision(observed.payload?.plan)
        : null;
    if (periodicDispatch && !periodicDispatch.dispatch) {
      return {
        skipReason: periodicDispatch.reason,
        projectedTaskSourceCount: 0,
      };
    }
    const projectedPaths = await assertSafePlannedTaskSourceArtifacts(
      observed.payload?.plan,
      label,
      {
        // Routing and unknown operations remain strict. Generic task
        // mutations may carry opaque plan metadata only after their explicit
        // or queried task sources have been physically resolved.
        requirePaths:
          !routeAcceptsOpaquePlanMetadata(name) ||
          (!hasExplicitTaskSource && resolvedTaskSourceCount === 0),
        paths: periodicDispatch?.paths,
      },
    );
    const paths = new Set([...expectedPaths, ...projectedPaths]);
    for (const relativePath of paths) {
      await safeVaultRegularFile(relativePath, `${label} resolved path`, {
        allowMissing:
          projectedPaths.has(relativePath) && !expectedPaths.has(relativePath),
      });
    }
    return {
      paths,
      inventory: await captureMarkdownInventory(),
      projectedTaskSourceCount: projectedPaths.size,
    };
  }

  async function assertPhysicalPostDispatch(result, preflight, label) {
    assert.equal(
      result?.after?.path,
      fixturePath,
      `${label} returned a task source outside the dedicated fixture.`,
    );
    assert.equal(
      preflight.paths.has(result.after.path),
      true,
      `${label} returned a task source absent from the physical pre-dispatch proof.`,
    );
    await safeVaultRegularFile(fixturePath, `${label} fixture post-dispatch`);
    const after = await captureMarkdownInventory();
    const changes = inventoryDiff(preflight.inventory, after);
    for (const change of changes) {
      if (change.path === fixturePath) continue;
      assert.equal(
        change.change,
        "created",
        `${label} changed a non-fixture Markdown path after physical preflight.`,
      );
      assert.equal(
        preflight.paths.has(change.path),
        true,
        `${label} created a Markdown path not sealed by the physical pre-dispatch plan.`,
      );
      await safeVaultRegularFile(
        change.path,
        `${label} created planned source`,
      );
    }
    return changes;
  }

  async function callRaw(
    name,
    args,
    { allowError = false, timeoutMs = READ_TIMEOUT_MS } = {},
  ) {
    assertActive();
    const result = await withTimeout(
      track(client.callTool({ name, arguments: args })),
      name,
      timeoutMs,
    );
    assertActive();
    const payload = parseMcpPayload(result, name);
    if (result.isError && !allowError) {
      throw new Error(
        `${name} failed with ${String(payload?.error?.code ?? "MCP_TOOL_ERROR")}.`,
      );
    }
    return { payload, isError: result.isError === true };
  }

  async function call(name, args, options) {
    return (await callRaw(name, args, options)).payload;
  }

  async function diagnoseUpdatePreDispatch(args, attempt) {
    if (
      typeof args?.operonId !== "string" ||
      typeof args?.expectedRevision !== "string"
    ) {
      return { transportOk: false, requestShapeValid: false };
    }
    try {
      const response = await fetch(
        `${baseUrl}/extensions/optimike-operon-bridge/v1/tasks/${encodeURIComponent(args.operonId)}/update`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...args,
            idempotencyKey: `${runId}:diagnostic:update:${attempt}`,
            dryRun: true,
          }),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        },
      );
      const payload = await response.json().catch(() => null);
      return {
        transportOk: true,
        httpStatus: response.status,
        status: typeof payload?.status === "string" ? payload.status : null,
        ...publicFailureMetadata(payload),
        planDigestPresent: Boolean(payload?.planDigest),
      };
    } catch {
      return { transportOk: false, requestShapeValid: true };
    }
  }

  async function callMutation(name, args, label) {
    const requiredCapability = TOOL_MUTATION_CAPABILITIES[name] ?? null;
    for (let attempt = 1; attempt <= MUTATION_RETRY_LIMIT; attempt += 1) {
      await waitForLiveStatus(requiredCapability);
      const physicalPreflight =
        args.dryRun === false
          ? await assertPhysicalPreDispatch(name, args, label)
          : null;
      if (physicalPreflight?.skipReason) {
        evidence.mutationReceipts.push({
          label,
          attempt,
          status: "skipped",
          isError: false,
          reason: physicalPreflight.skipReason,
          dispatchAttempted: false,
          projectedTaskSourceCount: physicalPreflight.projectedTaskSourceCount,
        });
        return {
          status: "skipped",
          reason: physicalPreflight.skipReason,
          projectedTaskSourceCount: physicalPreflight.projectedTaskSourceCount,
          periodicApplyDispatched: false,
        };
      }
      if (args.dryRun === false) await assertCandidateStillExact(candidate);
      if (args.dryRun === false) {
        await assertVaultRootStillSame(`${label} native apply`);
      }
      const observed = await callRaw(name, args, {
        allowError: true,
        timeoutMs: MUTATION_TIMEOUT_MS,
      });
      const result = observed.payload;
      const failure = publicFailureMetadata(result);
      evidence.mutationReceipts.push({
        label,
        attempt,
        status: typeof result?.status === "string" ? result.status : null,
        isError: observed.isError,
        ...failure,
        planDigestHash: result?.planDigest
          ? shortHash(result.planDigest)
          : null,
        recoveryRefHash: result?.recoveryRef
          ? shortHash(result.recoveryRef)
          : null,
        nativeProofPresent: Boolean(result?.nativeProof),
        finalIndexedTaskPresent: Boolean(result?.after?.revision),
      });
      const safelyRetryablePreDispatch =
        failure.retryable === true && failure.mutationMayHaveApplied === false;
      if (
        name === "operon_update_task" &&
        (observed.isError || result?.status === "not-ready")
      ) {
        evidence.preDispatchDiagnostics.push({
          label,
          attempt,
          ...(await diagnoseUpdatePreDispatch(args, attempt)),
        });
      }
      if (safelyRetryablePreDispatch && attempt < MUTATION_RETRY_LIMIT) {
        await sleep(750 * attempt);
        continue;
      }
      if (observed.isError) {
        throw new Error(
          `${label} failed with ${String(failure.errorCode ?? "MCP_TOOL_ERROR")}.`,
        );
      }
      if (args.dryRun === false && !safelyRetryablePreDispatch) {
        mutationStarted = true;
      }
      if (args.dryRun === false && !observed.isError) {
        await assertPhysicalPostDispatch(result, physicalPreflight, label);
      }
      return result;
    }
    throw new Error(`${label} exhausted its bounded retry loop.`);
  }

  async function validateZero(label) {
    const result = await call("operon_validate", { forceRefresh: true });
    assert.deepEqual(
      result?.summary,
      { P0: 0, P1: 0, P2: 0 },
      `${label} validation is not zero.`,
    );
    evidence.validation[label] = result.summary;
  }

  async function pendingZero(label) {
    const result = await call("operon_list_pending_recoveries", {});
    assert.equal(
      Array.isArray(result?.recoveries),
      true,
      `${label} pending recovery response is malformed.`,
    );
    assert.equal(
      result.recoveries.length,
      0,
      `${label} has pending recoveries.`,
    );
    evidence.pendingRecoveries[label] = 0;
  }

  async function waitForLiveStatus(requiredCapability = null) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let lastState = "unavailable";
    while (Date.now() < deadline) {
      const observed = await callRaw(
        "operon_status",
        {},
        { allowError: true, timeoutMs: READ_TIMEOUT_MS },
      );
      if (!observed.isError) {
        const live = observed.payload?.live;
        lastState =
          typeof live?.operon?.compatibilityState === "string"
            ? live.operon.compatibilityState
            : live?.ok === true
              ? "healthy"
              : "unavailable";
        if (
          live?.ok === true &&
          live?.source === "operon-runtime" &&
          live?.stale === false &&
          live?.index?.ready === true &&
          (requiredCapability === null ||
            live?.capabilities?.[requiredCapability] === true)
        ) {
          return live;
        }
      }
      await sleep(750);
    }
    throw new Error(
      `Operon live status did not become healthy; lastState=${lastState}.`,
    );
  }

  async function stableTask(operonId, predicate = () => true) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let previousRevision = null;
    let lastTask = null;
    while (Date.now() < deadline) {
      const result = await call("operon_get_task", {
        operonId,
        includeProperties: true,
        forceRefresh: true,
      });
      const task = result?.task;
      if (task) {
        lastTask = task;
        if (task.revision === previousRevision && predicate(task))
          return assertTask(task, "stable task");
        previousRevision = task.revision;
      }
      await sleep(750);
    }
    throw new Error(
      `Task ${shortHash(operonId)} did not reach the expected stable state; lastRevisionHash=${lastTask?.revision ? shortHash(lastTask.revision) : "none"}.`,
    );
  }

  async function queryRunTasks() {
    const result = await call("operon_query_tasks", {
      search: runId,
      pathIncludes: [fixturePath],
      includeProperties: true,
      forceRefresh: true,
      limit: 100,
    });
    assert.equal(
      Array.isArray(result?.tasks),
      true,
      "Operon query response is malformed.",
    );
    return result.tasks;
  }

  function ensureOnlyFixtureChanged(label) {
    return captureMarkdownInventory().then((current) => {
      const changes = inventoryDiff(baseline, current);
      assert.equal(
        changes.every(
          (change) =>
            change.path === fixturePath ||
            (change.change === "created" &&
              createdArtifactPaths.has(change.path)),
        ),
        true,
        `${label} changed Markdown outside the dedicated fixture and explicitly owned run artifacts.`,
      );
      evidence.preflight[`${label}InventoryDiff`] =
        redactedInventoryDiff(changes);
      return changes;
    });
  }

  async function assertFixtureRestorationTarget() {
    const currentVaultReal = currentVaultIdentity().realRoot;
    assert.equal(
      samePathIdentity(currentVaultReal, vaultReal),
      true,
      "Pilot 2 vault real path changed after preflight.",
    );
    const checked = await safeVaultRegularFile(
      fixturePath,
      "Fixture restoration target",
    );
    const currentStat = checked.metadata;
    assert.equal(
      currentStat.nlink,
      originalFixtureIdentity.nlink,
      "Fixture hardlink count changed after preflight.",
    );
    assert.equal(currentStat.nlink, 1, "Fixture became a hardlink.");
    const currentReal = await realpath(checked.absolute);
    assert.equal(
      samePathIdentity(currentReal, originalFixtureIdentity.realPath),
      true,
      "Fixture path was replaced by a junction, link, or another real target.",
    );
    assert.equal(
      isStrictDescendant(vaultReal, currentReal),
      true,
      "Fixture real path escaped Pilot 2.",
    );
  }

  async function cleanupRestoreTemp() {
    if (!(await exists(restoreTempPath))) return;
    await assertFixtureRestorationTarget();
    await assertSafeVaultParentChain(fixtureAbsolute, "Restore temp");
    const expectedPrefix = `.${path.basename(fixtureAbsolute)}.optimike-operon36-`;
    assert.equal(
      path.dirname(restoreTempPath).toLowerCase(),
      path.dirname(fixtureAbsolute).toLowerCase(),
      "Restore temp escaped the fixture directory.",
    );
    assert.equal(
      path.basename(restoreTempPath).startsWith(expectedPrefix) &&
        path.basename(restoreTempPath).includes(runId),
      true,
      "Restore temp does not carry the exact canary marker.",
    );
    const tempStat = await lstat(restoreTempPath);
    assert.equal(
      tempStat.isFile(),
      true,
      "Restore temp is not a regular file.",
    );
    assert.equal(
      tempStat.isSymbolicLink(),
      false,
      "Restore temp became a symbolic link.",
    );
    assert.equal(tempStat.nlink, 1, "Restore temp became a hardlink.");
    const tempReal = await realpath(restoreTempPath);
    assert.equal(
      tempReal.toLowerCase(),
      restoreTempPath.toLowerCase(),
      "Restore temp path was replaced by a junction or link.",
    );
    const content = await readFile(restoreTempPath);
    assert.equal(
      content.equals(originalFixture),
      true,
      "Restore temp content differs from the byte-exact private fixture backup.",
    );
    await assertVaultRootStillSame("Restore temp deletion");
    await rm(restoreTempPath, { force: false });
  }

  async function atomicallyRestoreFixture() {
    assert.equal(
      await exists(restoreTempPath),
      false,
      "A marked restore temp already exists; inspect it before rerunning.",
    );
    await assertFixtureRestorationTarget();
    await assertSafeVaultParentChain(fixtureAbsolute, "Fixture restore");
    let handle;
    try {
      handle = await open(restoreTempPath, "wx", 0o600);
      await handle.writeFile(originalFixture);
      await handle.sync();
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const staged = await readFile(restoreTempPath);
    assert.equal(
      staged.equals(originalFixture),
      true,
      "Synced restore temp differs from the private fixture backup.",
    );
    await assertFixtureRestorationTarget();
    await assertVaultRootStillSame("Fixture atomic restoration");
    await rename(restoreTempPath, fixtureAbsolute);
    await assertFixtureRestorationTarget();
    const restored = await readFile(fixtureAbsolute);
    assert.equal(
      restored.equals(originalFixture),
      true,
      "Atomic fixture replacement did not preserve the original bytes.",
    );
  }

  async function restore() {
    if (!baseline) return;
    await assertVaultRootStillSame("Behavior canary restoration");
    const current = await captureMarkdownInventory();
    const changes = inventoryDiff(baseline, current);
    const unexpected = changes.filter(
      (change) =>
        change.path !== fixturePath &&
        !(change.change === "created" && createdArtifactPaths.has(change.path)),
    );
    const fixtureChange = changes.find((change) => change.path === fixturePath);
    if (fixtureChange) {
      assert.notEqual(
        fixtureChange.change,
        "removed",
        "Fixture disappeared; refusing to recreate a path whose identity cannot be revalidated.",
      );
      await atomicallyRestoreFixture();
    } else {
      await assertFixtureRestorationTarget();
      assert.equal(
        (await readFile(fixtureAbsolute)).equals(originalFixture),
        true,
        "Unchanged fixture no longer matches its private backup.",
      );
    }
    for (const change of changes) {
      if (change.change !== "created" || !createdArtifactPaths.has(change.path))
        continue;
      assert.notEqual(
        change.path,
        fixturePath,
        "The existing fixture may never be deleted.",
      );
      const checked = await safeVaultRegularFile(
        change.path,
        "Created artifact restoration target",
      );
      const content = await readFile(checked.absolute, "utf8");
      const deletionMarker = createdArtifactMarkers.get(change.path) ?? runId;
      assert.equal(
        content.includes(deletionMarker),
        true,
        "Refusing to delete an unmarked created artifact.",
      );
      const finalCheck = await safeVaultRegularFile(
        change.path,
        "Created artifact deletion target",
      );
      await assertVaultRootStillSame("Created artifact deletion");
      await rm(finalCheck.absolute, { force: false });
    }
    assert.deepEqual(
      unexpected,
      [],
      "Unexpected Markdown drift was detected and was deliberately not overwritten.",
    );
    if (clientConnected) {
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if ((await queryRunTasks()).length === 0) break;
        await sleep(750);
      }
      assert.equal(
        (await queryRunTasks()).length,
        0,
        "Canary tasks remained indexed after restoration.",
      );
      await validateZero("afterRestore");
      await pendingZero("afterRestore");
    } else {
      assert.equal(
        mutationStarted,
        false,
        "The MCP disconnected after mutation; indexed restoration cannot be proven.",
      );
    }
    const after = await captureMarkdownInventory();
    assert.deepEqual(
      inventoryDiff(baseline, after),
      [],
      "Markdown inventory was not restored byte-exactly.",
    );
    evidence.restoration = {
      restored: true,
      originalFixtureSha256Hash: shortHash(sha256(originalFixture)),
      finalInventoryDigestHash: shortHash(inventoryDigest(after)),
    };
  }

  try {
    await assertDateIsolation();
    baseline = await captureMarkdownInventory();
    const baselineFixture = baseline.get(fixturePath);
    assert.ok(
      baselineFixture,
      "Fixture is absent from the Markdown inventory.",
    );
    assert.equal(
      baselineFixture.sha256,
      sha256(originalFixture),
      "Fixture snapshot hash is inconsistent.",
    );
    assert.equal(
      baselineFixture.size,
      originalFixture.length,
      "Fixture snapshot size is inconsistent.",
    );
    await writeFile(fixtureBackupPath, originalFixture, { mode: 0o600 });
    const backedUpFixture = await readFile(fixtureBackupPath);
    assert.equal(
      backedUpFixture.equals(originalFixture),
      true,
      "Private fixture backup failed byte-exact verification.",
    );
    assert.equal(
      await exists(restoreTempPath),
      false,
      "A marked restore temp already exists before preflight.",
    );
    assert.equal(
      originalFixture.includes(Buffer.from(runId)),
      false,
      "Run marker collision exists in the fixture.",
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          vaultName: EXPECTED_VAULT_NAME,
          fixturePathHash: shortHash(fixturePath),
          fixtureSha256: sha256(originalFixture),
          inventoryDigest: inventoryDigest(baseline),
          restoreContract:
            "existing-fixture-byte-exact-and-created-run-artifacts-only",
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BACKEND_ENTRY],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        MCP_TRANSPORT_TYPE: "stdio",
        MCP_TOOL_PROFILE: "tasks",
        MCP_WRITE_MODE: "full",
        OPERON_MUTATIONS_ENABLED: "true",
        OPERON_MUTATION_ALLOWED_PATH_PREFIXES: "",
        OBSIDIAN_RUNTIME_MODE: "live",
        OBSIDIAN_STARTUP_BLOCKING: "false",
        OBSIDIAN_VAULT: EXPECTED_VAULT,
        OBSIDIAN_BASE_URL: baseUrl,
        OBSIDIAN_API_KEY: apiKey,
        OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
        OBSIDIAN_ENABLE_CACHE: "true",
        SEMANTIC_SEARCH_PREWARM: "false",
        // Runtime policy intentionally confines logs below the application
        // root. Error-only logging never carries the private fixture backup.
        LOGS_DIR: path.join(PROJECT_ROOT, "logs"),
        MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (backendStderr.length < 32_768)
        backendStderr += chunk.toString("utf8");
    });
    client = new Client(
      { name: "operon-36-behaviors-live-canary", version: "1.0.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), "MCP stdio connect", 30_000);
    clientConnected = true;

    const toolList = await withTimeout(
      client.listTools(),
      "MCP tools/list",
      READ_TIMEOUT_MS,
    );
    const toolNames = new Set(toolList.tools.map((tool) => tool.name));
    for (const required of [
      "operon_status",
      "operon_get_configuration",
      "operon_create_task",
      "operon_update_periodic_scheduling",
      "operon_update_task",
      "operon_set_relationships",
      "operon_get_task",
      "operon_query_tasks",
      "operon_validate",
      "operon_list_pending_recoveries",
    ]) {
      assert.equal(
        toolNames.has(required),
        true,
        `Missing public MCP tool: ${required}.`,
      );
    }
    const operonDeleteTools = [...toolNames].filter((name) =>
      /^operon_.*delete/iu.test(name),
    );
    assert.deepEqual(
      operonDeleteTools,
      [],
      "A public Operon delete tool now exists; update this canary instead of reporting SKIP.",
    );

    const live = await waitForLiveStatus();
    assert.equal(live?.ok, true, "Operon live status is unhealthy.");
    assert.equal(
      live?.source,
      "operon-runtime",
      "Operon status is not live runtime authority.",
    );
    assert.equal(live?.stale, false, "Operon live status is stale.");
    assert.equal(
      live?.operon?.version,
      EXPECTED_OPERON_VERSION,
      "Unexpected Operon version.",
    );
    assert.equal(
      live?.bridge?.version,
      EXPECTED_BRIDGE_VERSION,
      "Unexpected Bridge version.",
    );
    assert.equal(live?.bridge?.mode, "read-write", "Bridge is not read-write.");
    assert.equal(live?.index?.ready, true, "Operon index is not ready.");
    for (const capability of [
      "create",
      "update",
      "relationshipMutation",
      "recovery",
    ]) {
      assert.equal(
        live?.capabilities?.[capability],
        true,
        `Required capability unavailable: ${capability}.`,
      );
    }
    evidence.versions = {
      operon: live.operon.version,
      bridge: live.bridge.version,
      compatibilityState: live.operon.compatibilityState ?? null,
    };

    const configuration = await call("operon_get_configuration", {
      forceRefresh: true,
    });
    assert.equal(
      configuration?.ok,
      true,
      "Operon public configuration is unavailable.",
    );
    assert.equal(
      configuration?.stale,
      false,
      "Operon public configuration is stale.",
    );
    assert.equal(
      configuration?.operonVersion,
      EXPECTED_OPERON_VERSION,
      "Public configuration came from another Operon version.",
    );
    assert.equal(
      configuration?.bridgeVersion,
      EXPECTED_BRIDGE_VERSION,
      "Public configuration came from another Bridge version.",
    );
    const parentAutomation = parentDateAutomationState(configuration);
    evidence.parentDateExpansion = parentAutomation.enabled
      ? { status: "PENDING", publicConfigurationAnnounced: true }
      : {
          status: "SKIP",
          reason: parentAutomation.reason,
          publicConfigurationAnnounced: parentAutomation.announced,
        };

    await validateZero("before");
    await pendingZero("before");
    assert.equal(
      (await queryRunTasks()).length,
      0,
      "Run marker already resolves to an Operon task.",
    );

    const dryRun = await callMutation(
      "operon_create_task",
      {
        idempotencyKey: `${runId}:preflight-create`,
        dryRun: true,
        task: {
          source: "inline",
          targetPath: fixturePath,
          description: `Operon 3.6 preflight ${runId}`,
        },
      },
      "create preflight",
    );
    assert.equal(dryRun?.status, "planned", "Create preflight was not a plan.");
    assert.match(
      dryRun?.planDigest ?? "",
      /^[a-f0-9]{64}$/u,
      "Create preflight is not sealed.",
    );
    assert.deepEqual(
      inventoryDiff(baseline, await captureMarkdownInventory()),
      [],
      "Create preflight mutated Markdown.",
    );
    evidence.preflight = {
      ...evidence.preflight,
      completedBeforeMutation: true,
      fixtureRegularFile: true,
      fixtureBackupVerified: true,
      inventoryCount: baseline.size,
      inventoryDigestHash: shortHash(inventoryDigest(baseline)),
      grantsAndCapabilitiesVerified: true,
      publicConfigurationRead: true,
      validationZero: true,
      pendingRecoveriesZero: true,
      dryRunNoDiff: true,
    };

    const blockerCreate = assertApplied(
      await callMutation(
        "operon_create_task",
        {
          idempotencyKey: `${runId}:blocked:blocker:create`,
          dryRun: false,
          task: {
            source: "inline",
            targetPath: fixturePath,
            description: `Operon 3.6 blocker ${runId}`,
          },
        },
        "blocked-task blocker create",
      ),
      "blocked-task blocker create",
    );
    const blocker = assertTask(blockerCreate.after, "blocker create result");
    assert.equal(
      blocker.path,
      fixturePath,
      "Blocker was created outside the fixture.",
    );
    if (!baseline.has(blocker.path)) {
      createdArtifactPaths.add(blocker.path);
      createdArtifactMarkers.set(blocker.path, runId);
    }
    const stableBlockerAfterCreate = await stableTask(blocker.operonId);
    assert.equal(
      stableBlockerAfterCreate.path,
      fixturePath,
      "Blocker did not settle in the dedicated fixture.",
    );

    const blockedCreate = assertApplied(
      await callMutation(
        "operon_create_task",
        {
          idempotencyKey: `${runId}:blocked:task:create`,
          dryRun: false,
          task: {
            source: "inline",
            targetPath: fixturePath,
            description: `Operon 3.6 blocked task ${runId}`,
          },
        },
        "blocked task create",
      ),
      "blocked task create",
    );
    const blocked = assertTask(
      blockedCreate.after,
      "blocked task create result",
    );
    assert.equal(
      blocked.path,
      fixturePath,
      "Blocked task was created outside the fixture.",
    );

    const related = assertApplied(
      await callMutation(
        "operon_set_relationships",
        {
          operonId: blocked.operonId,
          expectedRevision: blocked.revision,
          idempotencyKey: `${runId}:blocked:relationship`,
          dryRun: false,
          relationships: { blockedBy: [blocker.operonId] },
        },
        "blockedBy relationship set",
      ),
      "blockedBy relationship set",
    );
    const relatedBlocked = await stableTask(blocked.operonId, (task) =>
      task.blockedBy.includes(blocker.operonId),
    );
    const relatedBlocker = await stableTask(blocker.operonId, (task) =>
      task.blocking.includes(blocked.operonId),
    );
    assert.deepEqual(relatedBlocked.blockedBy, [blocker.operonId]);
    assert.equal(relatedBlocker.blocking.includes(blocked.operonId), true);
    const relationBefore = {
      childBlockedBy: [...relatedBlocked.blockedBy],
      childBlocking: [...relatedBlocked.blocking],
      childParent: relatedBlocked.parentTask,
      blockerBlockedBy: [...relatedBlocker.blockedBy],
      blockerBlocking: [...relatedBlocker.blocking],
      blockerParent: relatedBlocker.parentTask,
    };

    const scheduled = await callMutation(
      "operon_update_periodic_scheduling",
      {
        operonId: blocked.operonId,
        expectedRevision: relatedBlocked.revision,
        idempotencyKey: `${runId}:blocked:scheduled`,
        dryRun: false,
        patch: { fields: { dateScheduled: dates.scheduled } },
      },
      "blocked task Scheduled Date via periodic scheduling route",
    );
    if (scheduled?.status === "skipped") {
      assert.equal(
        scheduled.reason,
        PERIODIC_TASK_SOURCE_PROJECTION_UNAVAILABLE_REASON,
      );
      assert.equal(scheduled.periodicApplyDispatched, false);
      const skippedBlocked = await stableTask(blocked.operonId);
      const skippedBlocker = await stableTask(blocker.operonId);
      assert.equal(
        skippedBlocked.dates?.scheduled ?? null,
        null,
        "Periodic scheduling was dispatched despite an unavailable task-source projection.",
      );
      assert.deepEqual(
        {
          childBlockedBy: [...skippedBlocked.blockedBy],
          childBlocking: [...skippedBlocked.blocking],
          blockerBlockedBy: [...skippedBlocker.blockedBy],
          blockerBlocking: [...skippedBlocker.blocking],
          blockerParent: skippedBlocker.parentTask,
        },
        {
          childBlockedBy: relationBefore.childBlockedBy,
          childBlocking: relationBefore.childBlocking,
          blockerBlockedBy: relationBefore.blockerBlockedBy,
          blockerBlocking: relationBefore.blockerBlocking,
          blockerParent: relationBefore.blockerParent,
        },
        "Periodic scheduling skip changed blocker relationships.",
      );
      evidence.scheduledDateOnBlockedTask = {
        status: "SKIP",
        reason: PERIODIC_TASK_SOURCE_PROJECTION_UNAVAILABLE_REASON,
        blockedTaskIdHash: shortHash(blocked.operonId),
        blockerIdHash: shortHash(blocker.operonId),
        periodicApplyDispatched: false,
        projectedTaskSourceCount: scheduled.projectedTaskSourceCount,
        blockedByPreserved: true,
        inverseBlockingPreserved: true,
      };
      await ensureOnlyFixtureChanged("scheduledDateProjectionSkip");
    } else {
      const scheduledApplied = assertApplied(
        scheduled,
        "blocked task Scheduled Date via periodic scheduling route",
      );
      const scheduledBlocked = await stableTask(
        blocked.operonId,
        (task) => task.dates?.scheduled === dates.scheduled,
      );
      const scheduledBlocker = await stableTask(blocker.operonId);
      assert.equal(scheduledBlocked.dates.scheduled, dates.scheduled);
      assert.deepEqual(
        {
          childBlockedBy: [...scheduledBlocked.blockedBy],
          childBlocking: [...scheduledBlocked.blocking],
          blockerBlockedBy: [...scheduledBlocker.blockedBy],
          blockerBlocking: [...scheduledBlocker.blocking],
          blockerParent: scheduledBlocker.parentTask,
        },
        {
          childBlockedBy: relationBefore.childBlockedBy,
          childBlocking: relationBefore.childBlocking,
          blockerBlockedBy: relationBefore.blockerBlockedBy,
          blockerBlocking: relationBefore.blockerBlocking,
          blockerParent: relationBefore.blockerParent,
        },
        "Scheduled Date update changed blocker relationships.",
      );
      const scheduledInventory = await captureMarkdownInventory();
      const createdByPeriodicWorkflow = inventoryDiff(
        baseline,
        scheduledInventory,
      ).filter(
        (change) => change.change === "created" && change.path !== fixturePath,
      );
      if (createdByPeriodicWorkflow.length > 0) {
        assert.equal(
          typeof scheduledBlocked.parentTask,
          "string",
          "Periodic workflow created Markdown without a projected parent identity.",
        );
        for (const change of createdByPeriodicWorkflow) {
          const checked = await safeVaultRegularFile(
            change.path,
            "Created periodic artifact",
          );
          const content = await readFile(checked.absolute, "utf8");
          assert.equal(
            content.includes(scheduledBlocked.parentTask),
            true,
            "Created periodic artifact is not bound to the projected parent identity.",
          );
          createdArtifactPaths.add(change.path);
          createdArtifactMarkers.set(change.path, scheduledBlocked.parentTask);
        }
      }
      assert.equal(related?.after?.operonId, blocked.operonId);
      assert.equal(scheduledApplied?.after?.operonId, blocked.operonId);
      evidence.scheduledDateOnBlockedTask = {
        status: "PASS",
        scheduledDate: dates.scheduled,
        blockedTaskIdHash: shortHash(blocked.operonId),
        blockerIdHash: shortHash(blocker.operonId),
        blockedByPreserved: true,
        inverseBlockingPreserved: true,
        periodicParentChanged:
          scheduledBlocked.parentTask !== relationBefore.childParent,
        createdPeriodicArtifactCount: createdByPeriodicWorkflow.length,
      };
      await ensureOnlyFixtureChanged("scheduledDate");
    }

    if (parentAutomation.enabled) {
      const parentCreate = assertApplied(
        await callMutation(
          "operon_create_task",
          {
            idempotencyKey: `${runId}:parent:create`,
            dryRun: false,
            task: {
              source: "inline",
              targetPath: fixturePath,
              description: `Operon 3.6 parent date ${runId}`,
              fields: {
                dateStarted: dates.parentStart,
                dateDue: dates.parentDue,
              },
            },
          },
          "parent-date parent create",
        ),
        "parent-date parent create",
      );
      const parent = assertTask(parentCreate.after, "parent-date parent");
      const childCreate = assertApplied(
        await callMutation(
          "operon_create_task",
          {
            idempotencyKey: `${runId}:parent:child:create`,
            dryRun: false,
            task: {
              source: "inline",
              targetPath: fixturePath,
              description: `Operon 3.6 parent date child ${runId}`,
              fields: {
                dateStarted: dates.childInsideStart,
                dateDue: dates.childInsideDue,
              },
            },
          },
          "parent-date child create",
        ),
        "parent-date child create",
      );
      const child = assertTask(childCreate.after, "parent-date child");
      assertApplied(
        await callMutation(
          "operon_set_relationships",
          {
            operonId: child.operonId,
            expectedRevision: child.revision,
            idempotencyKey: `${runId}:parent:relationship`,
            dryRun: false,
            relationships: { parentTask: parent.operonId },
          },
          "parent-date relationship set",
        ),
        "parent-date relationship set",
      );
      const childRelated = await stableTask(
        child.operonId,
        (task) => task.parentTask === parent.operonId,
      );
      const parentBeforeExpansion = await stableTask(parent.operonId);
      assert.equal(parentBeforeExpansion.dates.started, dates.parentStart);
      assert.equal(parentBeforeExpansion.dates.due, dates.parentDue);

      assertApplied(
        await callMutation(
          "operon_update_task",
          {
            operonId: child.operonId,
            expectedRevision: childRelated.revision,
            idempotencyKey: `${runId}:parent:expand`,
            dryRun: false,
            patch: {
              fields: {
                dateStarted: dates.childOuterStart,
                dateDue: dates.childOuterDue,
              },
            },
          },
          "parent-date outward child update",
        ),
        "parent-date outward child update",
      );
      const expandedParent = await stableTask(
        parent.operonId,
        (task) =>
          task.dates?.started === dates.childOuterStart &&
          task.dates?.due === dates.childOuterDue,
      );
      const expandedChild = await stableTask(
        child.operonId,
        (task) =>
          task.dates?.started === dates.childOuterStart &&
          task.dates?.due === dates.childOuterDue,
      );
      assert.equal(expandedChild.parentTask, parent.operonId);

      assertApplied(
        await callMutation(
          "operon_update_task",
          {
            operonId: child.operonId,
            expectedRevision: expandedChild.revision,
            idempotencyKey: `${runId}:parent:inward`,
            dryRun: false,
            patch: {
              fields: {
                dateStarted: dates.childInsideStart,
                dateDue: dates.childInsideDue,
              },
            },
          },
          "parent-date inward child update",
        ),
        "parent-date inward child update",
      );
      const nonShrunkParent = await stableTask(
        parent.operonId,
        (task) =>
          task.dates?.started === expandedParent.dates.started &&
          task.dates?.due === expandedParent.dates.due,
      );
      const inwardChild = await stableTask(
        child.operonId,
        (task) =>
          task.dates?.started === dates.childInsideStart &&
          task.dates?.due === dates.childInsideDue,
      );
      assert.equal(inwardChild.parentTask, parent.operonId);
      assert.equal(nonShrunkParent.dates.started, dates.childOuterStart);
      assert.equal(nonShrunkParent.dates.due, dates.childOuterDue);
      evidence.parentDateExpansion = {
        status: "PASS",
        publicConfigurationAnnounced: true,
        parentIdHash: shortHash(parent.operonId),
        childIdHash: shortHash(child.operonId),
        expandedStart: dates.childOuterStart,
        expandedDue: dates.childOuterDue,
        didNotShrink: true,
        parentRelationshipPreserved: true,
      };
      await ensureOnlyFixtureChanged("parentDateExpansion");
    }

    await validateZero("afterMutations");
    await pendingZero("afterMutations");
    await restore();
    success = true;
    evidence.ok = true;
    evidence.completedAt = new Date().toISOString();
  } catch (error) {
    evidence.error = {
      name: error instanceof Error ? error.name : "Error",
      message: redactText(
        error instanceof Error ? error.message : error,
        apiKey,
        fixturePath,
        runId,
      ),
    };
  } finally {
    const pending = [...activeRequests];
    if (pending.length > 0) {
      await withTimeout(
        Promise.allSettled(pending),
        "active MCP requests to settle",
        MUTATION_TIMEOUT_MS + 10_000,
      ).catch(() => undefined);
    }
    if (baseline && !evidence.restoration.restored) {
      await restore().catch((error) => {
        evidence.restoration.error = redactText(
          error.message,
          apiKey,
          fixturePath,
          runId,
        );
        evidence.error ??= {
          name: "CleanupError",
          message: redactText(error.message, apiKey, fixturePath, runId),
        };
      });
    }
    await cleanupRestoreTemp().catch((error) => {
      evidence.error ??= {
        name: "CleanupError",
        message: redactText(error.message, apiKey, fixturePath, runId),
      };
    });
    await client?.close().catch(() => undefined);
    evidence.ok = Boolean(
      success && evidence.restoration.restored && !evidence.error,
    );
    evidence.completedAt ??= new Date().toISOString();
    if (shutdownSignal) evidence.interruptedBy = shutdownSignal;
    if (backendStderr) {
      const redactedBackendStderr = redactText(
        backendStderr,
        apiKey,
        fixturePath,
        runId,
      );
      evidence.backendDiagnosticHash = shortHash(redactedBackendStderr);
      if (!success) {
        await writeFile(
          path.join(tempRoot, "backend-stderr-redacted.txt"),
          redactedBackendStderr,
          { encoding: "utf8", mode: 0o600 },
        );
        evidence.backendDiagnosticRetainedOnFailure = true;
      }
    }
    let backupDeletedOnPass = false;
    if (evidence.ok) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
        backupDeletedOnPass = true;
      } catch {
        evidence.ok = false;
        evidence.error = {
          name: "CleanupError",
          message: "Private canary backup could not be deleted after success.",
        };
      }
    }
    evidence.restoration.backupDeletedOnPass = backupDeletedOnPass;
    evidence.restoration.backupRetainedOnFailure = !evidence.ok;
    evidence.preflight.mutationStarted = mutationStarted;
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  console.log(
    JSON.stringify(
      {
        ok: evidence.ok,
        evidenceFile,
        fixtureRestored: evidence.restoration.restored,
        taskEditorDeletion: evidence.taskEditorDeletion,
        parentDateExpansion: evidence.parentDateExpansion,
        ...(evidence.ok ? {} : { backupRetainedAt: tempRoot }),
      },
      null,
      2,
    ),
  );
  if (!evidence.ok) process.exitCode = 1;
}

const offlineContractMode = process.argv.includes("--offline-contract");
const offlinePathSafetyMode = process.argv.includes(
  "--offline-path-safety-contract",
);
assert.equal(
  [offlineContractMode, offlinePathSafetyMode].filter(Boolean).length <= 1,
  true,
  "Select only one behavior canary mode.",
);
const selectedMain = offlineContractMode
  ? offlineContract
  : offlinePathSafetyMode
    ? offlinePathSafetyContract
    : main;
selectedMain().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
