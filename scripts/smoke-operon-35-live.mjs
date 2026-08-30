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
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";

const EXPECTED_VAULT = path.resolve(
  "C:\\Users\\micka\\.codex\\visualizations\\2026\\07\\20\\019f801c-bc43-72f0-bf34-31552d406cbc\\operon-bridge-pilot-vault-2.5.0",
);
const EXPECTED_VAULT_NAME = "operon-bridge-pilot-vault-2.5.0";
const EXPECTED_OPERON_VERSION = (
  process.env.OPERON_35_CANARY_EXPECTED_OPERON_VERSION ?? "3.6.0"
).trim();
const EXPECTED_BRIDGE_VERSION = (
  process.env.OPERON_35_CANARY_EXPECTED_BRIDGE_VERSION ?? "0.8.3"
).trim();
const EXPECTED_MCP_VERSION = (
  process.env.OPERON_35_CANARY_EXPECTED_MCP_VERSION ?? "3.2.0"
).trim();
const EXPECTED_BASE_URL = "http://127.0.0.1:27233";
const FIXTURE_PATH = "Canary/Operon-3.5-Live-Canary.md";
const PERIODIC_REGISTRY_PATH = path.join(
  EXPECTED_VAULT,
  ".obsidian",
  "plugins",
  "operon",
  "state",
  "periodic-note-containers.json",
);
const ORIGINAL_MODIFICATION = "2000-01-01T00:00:00";
const PROJECT_ROOT = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const BACKEND_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");
const PROJECT_LOGS_PATH = path.join(PROJECT_ROOT, "logs");
const BRIDGE_PREFIX = "/extensions/optimike-operon-bridge/v1";
const RUN_CONFIRMATION = "I_CONFIRM_PILOT_2_DISPOSABLE_LIVE_MUTATIONS";
const OPEN_CONFIRMATION = "I_CONFIRM_OPENING_ONLY_OPERON_PILOT_2";
const MUTATION_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_MUTATION_TIMEOUT_MS,
  150_000,
  125_000,
  300_000,
);
const READ_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_READ_TIMEOUT_MS,
  30_000,
  5_000,
  120_000,
);
const STARTUP_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_STARTUP_TIMEOUT_MS,
  180_000,
  15_000,
  600_000,
);
const CLI_TIMEOUT_MS = boundedInteger(
  process.env.OPERON_35_CANARY_CLI_TIMEOUT_MS,
  30_000,
  5_000,
  120_000,
);

// This is deliberately process-local. All destructive vault helpers require a
// root identity verified at live-canary entry, rather than re-resolving the
// user-supplied string at each call.
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

function boundedDiagnosticToken(value) {
  if (typeof value !== "string" || !value) return null;
  return value.length <= 128 && /^[a-z0-9_.:-]+$/iu.test(value)
    ? value
    : `hashed-${shortHash(value)}`;
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

function currentVaultIdentity() {
  assert.ok(activeVaultIdentity, "Pilot vault identity was not initialized.");
  return activeVaultIdentity;
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
  const resolved = await realpath(absolutePath);
  assert.equal(
    samePathIdentity(resolved, absolutePath),
    true,
    `${label} must not resolve through a symlink or junction.`,
  );
  return metadata;
}

async function assertSafeVaultParentChain(absolutePath, label) {
  const identity = currentVaultIdentity();
  const relative = path.relative(identity.realRoot, absolutePath);
  assert.equal(
    isStrictDescendant(identity.realRoot, absolutePath),
    true,
    `${label} escaped the verified Pilot vault root.`,
  );
  await assertSafeVaultDirectory(identity.realRoot, "Pilot vault root");
  const segments = relative.split(path.sep);
  let current = identity.realRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    await assertSafeVaultDirectory(current, `${label} parent`);
  }
}

async function ensureSafeVaultParentChain(absolutePath, label) {
  const identity = currentVaultIdentity();
  const relative = path.relative(identity.realRoot, absolutePath);
  assert.equal(
    isStrictDescendant(identity.realRoot, absolutePath),
    true,
    `${label} escaped the verified Pilot vault root.`,
  );
  await assertSafeVaultDirectory(identity.realRoot, "Pilot vault root");
  let current = identity.realRoot;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    try {
      await assertSafeVaultDirectory(current, `${label} parent`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await assertSafeVaultDirectory(
        path.dirname(current),
        `${label} parent before creation`,
      );
      await mkdir(current);
      await assertSafeVaultDirectory(current, `${label} created parent`);
    }
  }
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
    "Resolved path escaped the Pilot 2 vault.",
  );
  return absolute;
}

async function safeVaultRegularFile(relativePath, label, options = {}) {
  const { allowMissing = false } = options;
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
  assert.equal(metadata.nlink, 1, `${label} must not be a hardlinked file.`);
  const resolved = await realpath(absolute);
  assert.equal(
    samePathIdentity(resolved, absolute),
    true,
    `${label} must not resolve through a symlink or junction.`,
  );
  // Repeat the path checks after lstat/realpath. Node does not expose openat
  // across supported platforms; this is the narrowest useful TOCTOU fence.
  await assertSafeVaultParentChain(absolute, label);
  const finalMetadata = await lstat(absolute);
  assert.equal(finalMetadata.isFile(), true, `${label} stopped being a file.`);
  assert.equal(
    finalMetadata.isSymbolicLink(),
    false,
    `${label} became a symlink or reparse point.`,
  );
  assert.equal(finalMetadata.nlink, 1, `${label} became a hardlinked file.`);
  return { absolute, exists: true, metadata: finalMetadata };
}

async function assertSafeMissingVaultTarget(relativePath, label) {
  const checked = await safeVaultRegularFile(relativePath, label, {
    allowMissing: true,
  });
  assert.equal(checked.exists, false, `${label} already exists.`);
  return checked.absolute;
}

function periodicTaskSourcePaths(plan) {
  const paths = new Set(
    [
      plan?.periodicRoute?.notePath,
      plan?.periodicUpdate?.notePath,
      ...(plan?.periodicUpdate?.sourceTransitions ?? []).map(
        (transition) => transition?.filePath,
      ),
      ...(plan?.projection?.taskSources ?? []).map(
        (taskSource) => taskSource?.filePath,
      ),
    ].filter((value) => typeof value === "string"),
  );
  return paths;
}

const PERIODIC_PROJECTION_SKIP_REASON =
  "public_task_source_projection_unavailable";

function selectPeriodicCanaryExecution(plan) {
  // Periodic applies are authorized only by these public task-source
  // projections. Opaque plan metadata (including a generic metadata.path)
  // is not a task-source grant and must fail closed.
  const projectedTaskSourcePaths = periodicTaskSourcePaths(plan);
  if (projectedTaskSourcePaths.size === 0) {
    return {
      mode: "skip",
      reason: PERIODIC_PROJECTION_SKIP_REASON,
      projectedTaskSourcePaths,
      periodicApplyOperations: [],
      periodicApplyDispatched: false,
      periodicApplyDispatchCount: 0,
    };
  }
  const periodicApplyOperations = [
    "daily-create",
    "weekly-create",
    "schedule-set",
    "schedule-clear",
    "bridge-concurrency",
  ];
  return {
    mode: "apply",
    projectedTaskSourcePaths,
    periodicApplyOperations,
    periodicApplyDispatched: true,
    periodicApplyDispatchCount: periodicApplyOperations.length,
  };
}

function mutationRequiresProjectedTaskSourcePaths(name, resolvedPathCount) {
  switch (name) {
    case "operon_adopt_task":
    case "operon_update_task":
      // These mutations are already physically bounded by the exact targetPath
      // or by the source paths resolved from every referenced Operon identity.
      // Task Workflow V1 adoption intentionally exposes only plan metadata;
      // ordinary update is likewise bounded to the pre-resolved task sources.
      // An empty public path projection is therefore not evidence of an
      // unbounded write once at least one such source is sealed.
      return resolvedPathCount === 0;
    case "operon_create_periodic_task":
    case "operon_update_periodic_scheduling":
    default:
      // Routing mutations can create or move task sources that are not fully
      // determined by their request. They must enumerate those paths in the
      // projected plan before dispatch.
      return true;
  }
}

async function assertSafePlannedTaskSourceArtifacts(
  plan,
  label,
  { requirePaths = true } = {},
) {
  const paths = periodicTaskSourcePaths(plan);
  if (requirePaths) {
    assert.ok(
      paths.size > 0,
      `${label} did not seal every task-source path; refusing a physically unbounded mutation.`,
    );
  }
  for (const relativePath of paths) {
    // Existing sources must be regular, unlinked files; absent targets are
    // accepted only below an already-existing, non-reparse parent chain.
    await safeVaultRegularFile(relativePath, `${label} planned task source`, {
      allowMissing: true,
    });
  }
  return paths;
}

async function removeRunOwnedVaultArtifact(relativePath, exactMarker, label) {
  const checked = await safeVaultRegularFile(relativePath, label);
  const content = await readFile(checked.absolute, "utf8");
  assert.equal(
    content.includes(exactMarker),
    true,
    `${label} has no exact run marker; refusing deletion.`,
  );
  // Revalidate at the last possible point before the non-recursive delete.
  const finalCheck = await safeVaultRegularFile(relativePath, label);
  await assertVaultRootStillSame(`${label} deletion`);
  await rm(finalCheck.absolute);
  await safeVaultRegularFile(relativePath, label, { allowMissing: true });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
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
  // Keep diagnostics intentionally unused: command output may include a local
  // path and must never be carried into a redacted live-canary proof.
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
  // esbuild deliberately appends this runtime entry to the distributable
  // manifest. The source manifest remains the canonical authoring surface.
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

async function attestLiveCandidate(releaseCandidate) {
  // `build/` and `dist/` are ignored. Rebuild both artifacts from this exact
  // checkout before they influence the Git identity or installed-artifact
  // comparison; otherwise two equally stale files could falsely attest.
  await runNpmCommand(["run", "build"], "MCP candidate rebuild");
  await runNpmCommand(
    ["--prefix", "plugins/obsidian-operon-bridge", "run", "build"],
    "Operon Bridge candidate rebuild",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );
  assert.match(
    packageJson?.version ?? "",
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "package.json has no valid MCP version.",
  );
  assert.equal(
    packageJson.version,
    EXPECTED_MCP_VERSION,
    "package.json MCP version differs from the expected live candidate.",
  );
  const gitHead = await runProjectCommand(["rev-parse", "HEAD"], "git HEAD");
  assert.match(gitHead, /^[a-f0-9]{40}$/u, "git HEAD is not an exact SHA.");
  const porcelain = await runProjectCommand(
    ["status", "--porcelain=v1"],
    "git worktree status",
  );
  const worktreeClean = porcelain.length === 0;
  assert.equal(
    worktreeClean,
    true,
    "Live canary requires a clean worktree so its evidence names one exact candidate.",
  );

  const bridgeRoot = path.join(
    PROJECT_ROOT,
    "plugins",
    "obsidian-operon-bridge",
  );
  const sourceBuild = path.join(bridgeRoot, "build", "main.js");
  const sourceBuildManifest = path.join(bridgeRoot, "build", "manifest.json");
  const sourceManifest = path.join(bridgeRoot, "manifest.json");
  const rootBuild = path.join(PROJECT_ROOT, "dist", "index.js");
  const installedPluginRoot = path.join(
    currentVaultIdentity().realRoot,
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
  const sourceHash = sha256(await readFile(sourceBuild));
  const installedHash = sha256(await readFile(installedBuild));
  const rootBuildHash = sha256(await readFile(rootBuild));
  const sourceBuildManifestBytes = await readFile(sourceBuildManifest);
  const sourceManifestBytes = await readFile(sourceManifest);
  const installedManifestBytes = await readFile(installedManifest);
  assertBuiltBridgeManifest(
    sourceManifestBytes,
    sourceBuildManifestBytes,
    "Generated Bridge manifest",
  );
  assert.equal(
    installedHash,
    sourceHash,
    "Installed Operon Bridge build does not match the local candidate build.",
  );
  assert.deepEqual(
    JSON.parse(installedManifestBytes.toString("utf8")),
    JSON.parse(sourceBuildManifestBytes.toString("utf8")),
    "Installed Operon Bridge manifest does not match the local candidate manifest.",
  );
  return {
    mcpVersion: packageJson.version,
    gitHead,
    worktreeClean,
    releaseCandidate,
    expectedBridgeVersion: EXPECTED_BRIDGE_VERSION,
    mcpBuildSha256: rootBuildHash,
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

function redactText(value, apiKey) {
  let text = String(value ?? "");
  if (apiKey) text = text.split(apiKey).join("[REDACTED_API_KEY]");
  text = text
    .split(EXPECTED_VAULT)
    .join(`[REDACTED_VAULT]${path.sep}`)
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]");
  return text.slice(0, 2_000);
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

function markdownFrontmatter(content, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  assert.ok(match, `${label} has no YAML frontmatter.`);
  const parsed = parseYaml(match[1]);
  assert.equal(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    true,
    `${label} frontmatter is not a YAML mapping.`,
  );
  return parsed;
}

function frontmatterScalarWhenValid(content, key) {
  try {
    const value = markdownFrontmatter(content, "canary fixture")[key];
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : null;
  } catch {
    return null;
  }
}

function mutationStatus(result, label, expected) {
  const status = result?.status;
  if (status === "outcome-unknown") {
    const recovery = result.recoveryRef
      ? ` recoveryRefHash=${shortHash(result.recoveryRef)}`
      : "";
    throw new Error(`${label} returned outcome-unknown.${recovery}`);
  }
  assert.equal(status, expected, `${label} returned status ${String(status)}.`);
  return result;
}

function assertNativeMutationProof(result, label) {
  assert.match(
    result?.planDigest ?? "",
    /^[a-f0-9]{64}$/u,
    `${label} did not return an exact sealed planDigest.`,
  );
  const proof = result?.nativeProof;
  assert.equal(proof?.contractVersion, 1, `${label} native proof is missing.`);
  assert.equal(proof?.kind, "mutation-result");
  assert.equal(proof?.mutationMayHaveApplied, true);
  assert.equal(proof?.retryAllowed, false);
  assert.equal(proof?.receipt?.planDigest, result.planDigest);
  assert.equal(
    ["verified", "receipt-replay"].includes(proof?.postflight?.status),
    true,
    `${label} native postflight is not verified.`,
  );
  assert.equal(Array.isArray(proof?.groupResults), true);
  assert.ok(proof.groupResults.length > 0, `${label} has no atomic groups.`);
  const revisions = proof.groupResults.flatMap((group) => {
    assert.equal(
      group.status,
      "committed",
      `${label} has an uncommitted group.`,
    );
    assert.equal(Array.isArray(group.resourceRevisions), true);
    return group.resourceRevisions;
  });
  assert.ok(revisions.length > 0, `${label} has no resource revisions.`);
  for (const revision of revisions) {
    assert.equal(typeof revision.resourceKind, "string");
    assert.ok(revision.resourceKey);
    assert.ok(revision.revision);
  }
  return {
    label,
    status: proof.status,
    planDigestHash: shortHash(result.planDigest),
    postflight: proof.postflight.status,
    atomicGroupCount: proof.groupResults.length,
    resourceRevisionCount: revisions.length,
    resourceRevisionHashes: revisions.map((revision) =>
      shortHash(
        `${revision.resourceKind}\0${revision.resourceKey}\0${revision.revision}`,
      ),
    ),
  };
}

function strictDate(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/u);
  return value;
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoWeekMarkers(value) {
  const date = new Date(`${strictDate(value)}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  const monday = addUtcDays(date, 1 - day);
  const thursday = addUtcDays(date, 4 - day);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return [
    isoDate(monday),
    `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
  ];
}

function routeDates(runId) {
  const digest = createHash("sha256").update(runId).digest();
  const offset = digest.readUInt16BE(0) % 5_000;
  const first = addUtcDays(new Date(Date.UTC(2080, 0, 1)), offset);
  const daily = strictDate(isoDate(first));
  return {
    daily,
    scheduled: strictDate(
      isoDate(addUtcDays(new Date(`${daily}T00:00:00Z`), 7)),
    ),
    weekly: strictDate(isoDate(addUtcDays(first, 35))),
    concurrent: strictDate(isoDate(addUtcDays(first, 77))),
  };
}

function assertCollisionFree(snapshot, markers) {
  const collisions = [];
  for (const [relativePath, value] of snapshot) {
    const content = value.content.toString("utf8");
    const matched = markers.filter(
      (marker) => content.includes(marker) || relativePath.includes(marker),
    );
    if (matched.length > 0) {
      collisions.push({
        pathHash: shortHash(relativePath),
        markerHashes: matched.map(shortHash),
      });
    }
  }
  assert.deepEqual(
    collisions,
    [],
    "Canary marker or route-date collision exists before mutation.",
  );
}

async function captureMarkdownSnapshot(backupRoot) {
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
      const metadata = await lstat(absolute);
      // Never traverse a symlink/reparse point while building the inventory.
      // A live artifact must pass the stricter file identity checks below.
      if (metadata.isSymbolicLink()) {
        continue;
      }
      if (metadata.isDirectory()) {
        await walk(absolute, relative);
      } else if (
        metadata.isFile() &&
        entry.name.toLowerCase().endsWith(".md")
      ) {
        const content = await readFile(absolute);
        inventory.set(relative, {
          sha256: sha256(content),
          size: content.length,
          content,
        });
        if (backupRoot) {
          const backupPath = path.join(backupRoot, ...relative.split("/"));
          await mkdir(path.dirname(backupPath), { recursive: true });
          await writeFile(backupPath, content, { mode: 0o600 });
        }
      }
    }
  }
  await walk(EXPECTED_VAULT, "");
  return inventory;
}

async function markdownInventory() {
  return await captureMarkdownSnapshot();
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

function redactedInventoryChanges(changes) {
  return changes.map((change) => ({
    pathHash: shortHash(change.path),
    change: change.change,
    beforeSha256Hash: change.beforeSha256
      ? shortHash(change.beforeSha256)
      : null,
    afterSha256Hash: change.afterSha256 ? shortHash(change.afterSha256) : null,
  }));
}

async function unusedLoopbackUrl() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

async function fetchWithAbortTimeout(url, init, label, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(
        `${label} timed out after ${timeoutMs}ms.`,
      );
      timeoutError.code = "FETCH_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function assertAbortableFetchContract() {
  let observeAbort;
  const abortedRequest = new Promise((resolve) => {
    observeAbort = resolve;
  });
  const server = createHttpServer((request) => {
    request.once("aborted", () => observeAbort(true));
    request.once("close", () => {
      if (request.aborted) observeAbort(true);
    });
    // Deliberately never respond: the client timeout must abort the request.
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  try {
    await assert.rejects(
      fetchWithAbortTimeout(
        `http://127.0.0.1:${address.port}/blocked-mutation`,
        { method: "POST", body: "bounded-offline-test" },
        "offline abortable fetch",
        250,
      ),
      (error) => error?.code === "FETCH_TIMEOUT",
    );
    assert.equal(
      await withTimeout(
        abortedRequest,
        "offline server to observe fetch abort",
        2_000,
      ),
      true,
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function offlineStartupOrderContract() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-startup-order-offline-"),
  );
  assert.equal(await exists(BACKEND_ENTRY), true, "Run npm run build first.");
  const closedBaseUrl = await unusedLoopbackUrl();
  const childEnv = { ...process.env };
  delete childEnv.OBSIDIAN_STARTUP_BLOCKING;
  delete childEnv.OBSIDIAN_STARTUP_MAX_RETRIES;
  delete childEnv.OBSIDIAN_STARTUP_RETRY_DELAY_MS;
  Object.assign(childEnv, {
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_TOOL_PROFILE: "tasks",
    MCP_WRITE_MODE: "readonly",
    OPERON_MUTATIONS_ENABLED: "false",
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_VAULT: tempRoot,
    OBSIDIAN_BASE_URL: closedBaseUrl,
    OBSIDIAN_API_KEY: "offline-contract-placeholder",
    OBSIDIAN_ENABLE_CACHE: "false",
    SEMANTIC_SEARCH_PREWARM: "false",
    // LOGS_DIR is intentionally kept inside the project boundary required by
    // config.ensureDirectory; an OS-temp LOGS_DIR makes the backend exit.
    LOGS_DIR: PROJECT_LOGS_PATH,
    MCP_LOG_LEVEL: "error",
  });

  let client;
  let diagnostic = "";
  try {
    await assertAbortableFetchContract();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BACKEND_ENTRY],
      cwd: tempRoot,
      env: childEnv,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (diagnostic.length < 16_384) diagnostic += chunk.toString("utf8");
    });
    client = new Client(
      { name: "operon-startup-order-offline", version: "1.0.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), "offline MCP connect", 30_000);
    const before = await withTimeout(
      client.listTools(),
      "offline tools/list before status",
      READ_TIMEOUT_MS,
    );
    const result = await withTimeout(
      client.callTool({ name: "operon_status", arguments: {} }),
      "offline operon_status",
      READ_TIMEOUT_MS,
    );
    const payload = parseMcpPayload(result, "offline operon_status");
    assert.equal(result.isError, false);
    assert.equal(payload?.ok, false);
    assert.equal(payload?.source, "unavailable");
    assert.equal(payload?.error?.code, "live_bridge_unavailable");
    const after = await withTimeout(
      client.listTools(),
      "offline tools/list after status",
      READ_TIMEOUT_MS,
    );
    assert.equal(after.tools.length, before.tools.length);
    assert.equal(
      after.tools.some((tool) => tool.name === "operon_status"),
      true,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          runtimeMode: "live",
          startupBlockingExplicit: false,
          degradedStatusObserved: true,
          sameClientAliveAfterStatus: true,
          abortableFetchTimeoutVerified: true,
          diagnosticHash: diagnostic ? shortHash(diagnostic) : null,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const safeDiagnostic = redactText(
      diagnostic.split(tempRoot).join("[OFFLINE_TEMP]"),
      "offline-contract-placeholder",
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; backendDiagnostic=${safeDiagnostic || "[none]"}`,
    );
  } finally {
    await client?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function createSymlinkOrReport(target, linkPath, type) {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    // Windows may deny unprivileged file symlink creation. A skipped optional
    // symlink fixture is safe only because every production helper still fails
    // closed when it encounters one.
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
}

async function offlinePathSafetyContract() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-path-safety-offline-"),
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
    activeVaultIdentity = await assertVaultRootIdentity(vaultRoot);
    assert.throws(
      () => sealPhysicalDirectoryIdentity({ dev: 0n, ino: 0n }),
      /unavailable or ambiguous/u,
    );

    const normalPath = "Canary/normal.md";
    const normalAbsolute = absoluteVaultPath(normalPath);
    await ensureSafeVaultParentChain(normalAbsolute, "Offline normal artifact");
    await assertSafeMissingVaultTarget(normalPath, "Offline normal artifact");
    await writeFile(normalAbsolute, "offline-run-marker\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await safeVaultRegularFile(normalPath, "Offline normal artifact");

    const outsideFile = path.join(outsideRoot, "outside.md");
    await writeFile(outsideFile, "outside-content-must-survive\n", "utf8");

    const plannedCreatePath = "Canary/planned-create.md";
    const plannedCreatePaths = await assertSafePlannedTaskSourceArtifacts(
      { periodicRoute: { notePath: plannedCreatePath } },
      "Offline periodic create pre-apply",
    );
    assert.equal(plannedCreatePaths.has(plannedCreatePath), true);
    assert.equal(
      mutationRequiresProjectedTaskSourcePaths("operon_adopt_task", 1),
      false,
    );
    assert.equal(
      mutationRequiresProjectedTaskSourcePaths("operon_update_task", 1),
      false,
    );
    assert.equal(
      mutationRequiresProjectedTaskSourcePaths("operon_adopt_task", 0),
      true,
    );
    assert.equal(
      mutationRequiresProjectedTaskSourcePaths("operon_update_task", 0),
      true,
    );
    assert.equal(
      mutationRequiresProjectedTaskSourcePaths(
        "operon_create_periodic_task",
        1,
      ),
      true,
    );
    assert.equal(
      mutationRequiresProjectedTaskSourcePaths(
        "operon_update_periodic_scheduling",
        1,
      ),
      true,
    );
    assert.equal(
      mutationRequiresProjectedTaskSourcePaths("unknown_periodic_route", 1),
      true,
      "Unknown mutation routes must remain strict.",
    );
    const metadataOnlyPeriodicExecution = selectPeriodicCanaryExecution({});
    assert.equal(metadataOnlyPeriodicExecution.mode, "skip");
    assert.equal(
      metadataOnlyPeriodicExecution.reason,
      PERIODIC_PROJECTION_SKIP_REASON,
    );
    assert.equal(
      metadataOnlyPeriodicExecution.projectedTaskSourcePaths.size,
      0,
    );
    assert.deepEqual(metadataOnlyPeriodicExecution.periodicApplyOperations, []);
    assert.equal(metadataOnlyPeriodicExecution.periodicApplyDispatched, false);
    assert.equal(metadataOnlyPeriodicExecution.periodicApplyDispatchCount, 0);
    const opaqueMetadataPathPeriodicExecution = selectPeriodicCanaryExecution({
      metadata: { path: plannedCreatePath },
    });
    assert.equal(
      opaqueMetadataPathPeriodicExecution.mode,
      "skip",
      "An opaque metadata.path must not authorize a periodic task-source apply.",
    );
    assert.equal(
      opaqueMetadataPathPeriodicExecution.reason,
      PERIODIC_PROJECTION_SKIP_REASON,
    );
    assert.equal(
      opaqueMetadataPathPeriodicExecution.projectedTaskSourcePaths.size,
      0,
    );
    assert.equal(
      opaqueMetadataPathPeriodicExecution.periodicApplyDispatched,
      false,
    );
    assert.equal(
      opaqueMetadataPathPeriodicExecution.periodicApplyDispatchCount,
      0,
    );
    await assert.rejects(
      assertSafePlannedTaskSourceArtifacts(
        { metadata: { path: plannedCreatePath } },
        "Offline opaque metadata.path periodic create",
      ),
      /did not seal every task-source path/u,
    );
    const projectedPeriodicExecution = selectPeriodicCanaryExecution({
      periodicRoute: { notePath: plannedCreatePath },
    });
    assert.equal(projectedPeriodicExecution.mode, "apply");
    assert.deepEqual(projectedPeriodicExecution.periodicApplyOperations, [
      "daily-create",
      "weekly-create",
      "schedule-set",
      "schedule-clear",
      "bridge-concurrency",
    ]);
    assert.equal(projectedPeriodicExecution.periodicApplyDispatched, true);
    assert.equal(
      projectedPeriodicExecution.periodicApplyDispatchCount,
      projectedPeriodicExecution.periodicApplyOperations.length,
    );
    const metadataOnlyAdoptionPlan = await assertSafePlannedTaskSourceArtifacts(
      {},
      "Offline request-bounded adoption",
      { requirePaths: false },
    );
    assert.equal(metadataOnlyAdoptionPlan.size, 0);
    const requestBoundAdoptionPaths = new Set([
      normalPath,
      ...metadataOnlyAdoptionPlan,
    ]);
    assert.equal(requestBoundAdoptionPaths.size, 1);
    await safeVaultRegularFile(
      [...requestBoundAdoptionPaths][0],
      "Offline request-bounded adoption source",
    );
    await assert.rejects(
      assertSafePlannedTaskSourceArtifacts(
        {},
        "Offline adoption without a resolved source",
        {
          requirePaths: mutationRequiresProjectedTaskSourcePaths(
            "operon_adopt_task",
            0,
          ),
        },
      ),
      /did not seal every task-source path/u,
    );
    await assert.rejects(
      assertSafePlannedTaskSourceArtifacts(
        { periodicRoute: {} },
        "Offline unbounded periodic create",
      ),
      /did not seal every task-source path/u,
    );

    const plannedParent = path.join(vaultRoot, "Canary", "planned-parent");
    const plannedOutside = path.join(outsideRoot, "planned-outside");
    await mkdir(plannedParent);
    await mkdir(plannedOutside);
    const plannedJunction = await createSymlinkOrReport(
      plannedOutside,
      plannedParent,
      process.platform === "win32" ? "junction" : "dir",
    ).catch(async (error) => {
      // A directory must first be absent before the junction is placed. Keep
      // this in the contract rather than relying on platform-specific shell
      // junction primitives.
      if (error?.code !== "EEXIST") throw error;
      await rm(plannedParent, { recursive: true, force: false });
      return createSymlinkOrReport(
        plannedOutside,
        plannedParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    });
    if (plannedJunction) {
      await assert.rejects(
        assertSafePlannedTaskSourceArtifacts(
          { periodicRoute: { notePath: "Canary/planned-parent/created.md" } },
          "Offline periodic create junction swap before apply",
        ),
        /symlink|junction|resolve|parent/iu,
      );
    }

    const plannedUpdatePath = "Canary/planned-update.md";
    const plannedUpdateAbsolute = absoluteVaultPath(plannedUpdatePath);
    await writeFile(plannedUpdateAbsolute, "local-update-target\n", "utf8");
    await safeVaultRegularFile(plannedUpdatePath, "Offline periodic update");
    await rm(plannedUpdateAbsolute);
    await link(outsideFile, plannedUpdateAbsolute);
    await assert.rejects(
      assertSafePlannedTaskSourceArtifacts(
        { periodicUpdate: { notePath: plannedUpdatePath } },
        "Offline periodic update hardlink swap before apply",
      ),
      /hardlinked/u,
    );

    const hardlinkSource = path.join(vaultRoot, "Canary", "hardlink-source.md");
    const hardlinkAlias = path.join(vaultRoot, "Canary", "hardlink-alias.md");
    await writeFile(hardlinkSource, "hardlink fixture\n", "utf8");
    await link(hardlinkSource, hardlinkAlias);
    await assert.rejects(
      safeVaultRegularFile(
        "Canary/hardlink-source.md",
        "Offline hardlink source",
      ),
      /hardlinked/u,
    );

    const swappedPath = "Canary/swapped.md";
    const swappedAbsolute = absoluteVaultPath(swappedPath);
    await writeFile(swappedAbsolute, "offline-run-marker\n", "utf8");
    await safeVaultRegularFile(swappedPath, "Offline swapped artifact");
    await rm(swappedAbsolute);
    await link(outsideFile, swappedAbsolute);
    await assert.rejects(
      removeRunOwnedVaultArtifact(
        swappedPath,
        "offline-run-marker",
        "Offline swapped artifact",
      ),
      /hardlinked/u,
    );
    assert.equal(
      await readFile(outsideFile, "utf8"),
      "outside-content-must-survive\n",
      "Hardlink swap altered the outside file.",
    );

    const rootLink = path.join(tempRoot, "vault-link");
    const rootLinkCreated = await createSymlinkOrReport(
      vaultRoot,
      rootLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    if (rootLinkCreated) {
      await assert.rejects(
        assertVaultRootIdentity(rootLink),
        /symlink|junction|resolve|not a directory/iu,
      );
    }

    const fileLink = path.join(vaultRoot, "Canary", "file-link.md");
    const fileLinkCreated = await createSymlinkOrReport(
      outsideFile,
      fileLink,
      "file",
    );
    if (fileLinkCreated) {
      await assert.rejects(
        safeVaultRegularFile("Canary/file-link.md", "Offline file link"),
        /symlink|reparse|not a regular file/iu,
      );
    }

    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    const mcpBuildIndex = source.indexOf(
      'await runNpmCommand(["run", "build"], "MCP candidate rebuild")',
    );
    const bridgeBuildIndex = source.indexOf("Operon Bridge candidate rebuild");
    const gitHeadIndex = source.indexOf(
      'runProjectCommand(["rev-parse", "HEAD"], "git HEAD")',
    );
    const backupIndex = source.indexOf(
      'path.join(os.tmpdir(), "operon-35-live-backup-")',
    );
    assert.ok(mcpBuildIndex > 0, "MCP rebuild attestation is missing.");
    assert.ok(bridgeBuildIndex > mcpBuildIndex, "Bridge rebuild is missing.");
    assert.ok(
      bridgeBuildIndex < gitHeadIndex,
      "Generated artifacts must be rebuilt before Git identity is read.",
    );
    assert.ok(
      gitHeadIndex < backupIndex,
      "Candidate identity must be attested before private backup creation.",
    );
    assert.ok(
      source.includes("bridgeManifestMatchesInstalled: true"),
      "Installed Bridge manifest equality is missing.",
    );
    assert.ok(
      source.includes("await assertCandidateStillExact(candidate);"),
      "Native dispatch must recheck the attested candidate.",
    );
    const callMutationIndex = source.indexOf("async function callMutation");
    const mutationRootFenceIndex = source.indexOf(
      "await assertVaultRootStillSame(`${label} native apply`);",
      callMutationIndex,
    );
    const mutationDispatchIndex = source.indexOf(
      "observed = await callRaw(name, args",
      callMutationIndex,
    );
    assert.ok(
      mutationRootFenceIndex > callMutationIndex &&
        mutationRootFenceIndex < mutationDispatchIndex,
      "Every MCP native apply must revalidate the sealed physical vault root immediately before dispatch.",
    );
    const directPreviewIndex = source.indexOf(
      '"Bridge concurrency physical preview"',
    );
    const directPathFenceIndex = source.indexOf(
      '"Bridge concurrency physical apply pre-dispatch"',
    );
    const directCandidateRecheckIndex = source.indexOf(
      "await assertCandidateStillExact(candidate);",
      directPathFenceIndex,
    );
    const directRootFenceIndex = source.indexOf(
      'await assertVaultRootStillSame("Bridge concurrency native apply");',
      directCandidateRecheckIndex,
    );
    const directFetchIndex = source.indexOf(
      "const response = await fetchWithAbortTimeout",
      directRootFenceIndex,
    );
    const directDispatchIndex = source.indexOf(
      "const bridgeSettled = await Promise.allSettled",
    );
    assert.ok(
      directPreviewIndex > 0,
      "Direct Bridge concurrency route has no physical preview.",
    );
    assert.ok(
      directPathFenceIndex > directPreviewIndex,
      "Direct Bridge concurrency route has no post-preview path revalidation.",
    );
    assert.ok(
      directCandidateRecheckIndex > directPathFenceIndex,
      "Direct Bridge concurrency route has no final candidate recheck.",
    );
    assert.ok(
      directRootFenceIndex > directCandidateRecheckIndex &&
        directRootFenceIndex < directFetchIndex,
      "Direct Bridge native apply must revalidate the sealed physical vault root immediately before dispatch.",
    );
    assert.ok(
      directDispatchIndex > directCandidateRecheckIndex,
      "Direct Bridge concurrency route dispatches before its physical and candidate gates.",
    );
    assert.ok(
      source.includes(
        "Concurrent Bridge result source was not sealed by the physical pre-dispatch plan.",
      ),
      "Direct Bridge concurrency result is not tied to its sealed physical plan.",
    );

    const displacedVaultRoot = path.join(tempRoot, "vault-attested-original");
    await rename(vaultRoot, displacedVaultRoot);
    await mkdir(vaultRoot);
    await assert.rejects(
      assertVaultRootStillSame("Offline hostile root replacement"),
      /physical identity changed after preflight/u,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          regularFileAccepted: true,
          plannedCreatePathAttested: true,
          unboundedPlanRefused: true,
          metadataOnlyPeriodicPreviewSkipped: true,
          metadataOnlyPeriodicApplyOperations: 0,
          opaqueMetadataPathPeriodicPreviewSkipped: true,
          opaqueMetadataPathPeriodicApplyDispatchCount: 0,
          projectedPeriodicApplyDispatchCount:
            projectedPeriodicExecution.periodicApplyDispatchCount,
          unknownMutationRouteStrict: true,
          periodicCreateJunctionSwapRefused: plannedJunction,
          periodicUpdateHardlinkSwapRefused: true,
          candidateBuildOrderAttested: true,
          bridgeBuildManifestMatchesNormalizedSource: true,
          directBridgeConcurrencyPreDispatchAttested: true,
          hardlinkRefused: true,
          swappedHardlinkDeleteRefused: true,
          outsideFilePreserved: true,
          rootReplacementRefused: true,
          rootLinkRefused: rootLinkCreated,
          rootLinkFixture: rootLinkCreated ? "executed" : "safe-skip",
          fileLinkRefused: fileLinkCreated,
          fileLinkFixture: fileLinkCreated ? "executed" : "safe-skip",
        },
        null,
        2,
      ),
    );
  } finally {
    activeVaultIdentity = previousIdentity;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function inspectPendingLive() {
  const apiKey = (process.env.OBSIDIAN_API_KEY ?? "").trim();
  const baseUrl = (process.env.OBSIDIAN_BASE_URL ?? "").replace(/\/$/u, "");
  const requestedVault = path.resolve(process.env.OBSIDIAN_VAULT ?? "");
  assert.equal(
    requestedVault.toLowerCase(),
    EXPECTED_VAULT.toLowerCase(),
    "OBSIDIAN_VAULT must be the exact disposable Pilot 2 path.",
  );
  activeVaultIdentity = await assertVaultRootIdentity(requestedVault);
  assert.equal(baseUrl, EXPECTED_BASE_URL);
  assert.ok(apiKey, "OBSIDIAN_API_KEY is required and is never logged.");
  assert.equal(
    envTrue("OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN"),
    true,
    "Confirm that Pilot 2 is already open.",
  );
  assert.equal(await exists(EXPECTED_VAULT), true, "Pilot 2 vault is missing.");

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-pending-live-inspect-"),
  );
  const cachePath = path.join(tempRoot, "shared-cache.sqlite");
  let client;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BACKEND_ENTRY],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        MCP_TRANSPORT_TYPE: "stdio",
        MCP_TOOL_PROFILE: "tasks",
        MCP_WRITE_MODE: "readonly",
        OPERON_MUTATIONS_ENABLED: "false",
        OPERON_MUTATION_ALLOWED_PATH_PREFIXES: "",
        OBSIDIAN_RUNTIME_MODE: "live",
        OBSIDIAN_STARTUP_BLOCKING: "false",
        OBSIDIAN_VAULT: EXPECTED_VAULT,
        OBSIDIAN_BASE_URL: baseUrl,
        OBSIDIAN_API_KEY: apiKey,
        OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
        OBSIDIAN_ENABLE_CACHE: "true",
        SEMANTIC_SEARCH_PREWARM: "false",
        LOGS_DIR: PROJECT_LOGS_PATH,
        MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    client = new Client(
      { name: "operon-pending-live-inspector", version: "1.0.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), "MCP stdio connect", 30_000);

    const statusResult = await withTimeout(
      client.callTool({ name: "operon_status", arguments: {} }),
      "operon_status",
      READ_TIMEOUT_MS,
    );
    assert.equal(statusResult.isError, false, "operon_status failed.");
    const status = parseMcpPayload(statusResult, "operon_status");
    // A read-only pending-recovery inspection must not require optional
    // task-workflow grants before the operation that needs them negotiates.
    assertLiveStatus(status?.live, false);

    const pendingResult = await withTimeout(
      client.callTool({
        name: "operon_list_pending_recoveries",
        arguments: {},
      }),
      "operon_list_pending_recoveries",
      READ_TIMEOUT_MS,
    );
    assert.equal(
      pendingResult.isError,
      false,
      "operon_list_pending_recoveries failed.",
    );
    const pending = parseMcpPayload(
      pendingResult,
      "operon_list_pending_recoveries",
    );
    assert.equal(Array.isArray(pending?.recoveries), true);
    const recoveries = pending.recoveries.map((recovery) => ({
      kind: boundedDiagnosticToken(recovery?.kind) ?? "unknown",
      recoveryRefHash:
        typeof recovery?.recoveryRef === "string"
          ? shortHash(recovery.recoveryRef)
          : null,
      planDigestHash:
        typeof recovery?.planDigest === "string"
          ? shortHash(recovery.planDigest)
          : null,
    }));
    console.log(
      JSON.stringify({ count: recoveries.length, recoveries }, null, 2),
    );
  } finally {
    await client?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function waitForFileStable(absolutePath, predicate, label) {
  const deadline = Date.now() + 25_000;
  let previous = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const current = await readFile(absolutePath, "utf8");
    if (predicate(current)) {
      stableCount = current === previous ? stableCount + 1 : 0;
      if (stableCount >= 2) return current;
    }
    previous = current;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function runCli(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  const exitCode = await withTimeout(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    }),
    "Obsidian CLI vault open",
    CLI_TIMEOUT_MS,
  ).catch((error) => {
    // Never terminate an Obsidian process as a timeout side effect. The CLI
    // child is detached from this canary's event-loop ownership instead.
    child.unref();
    throw error;
  });
  if (exitCode !== 0) {
    throw new Error(`Obsidian CLI exited ${String(exitCode)}.`);
  }
  return { exitCode };
}

async function waitForLocalRestClosed() {
  const deadline = Date.now() + CLI_TIMEOUT_MS;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    try {
      await fetchWithAbortTimeout(
        EXPECTED_BASE_URL,
        {},
        "Pilot 2 Local REST close probe",
        1_000,
      );
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) return;
    }
    await sleep(250);
  }
  throw new Error("Pilot 2 Local REST remained available after CLI close.");
}

async function optionalFileState(absolutePath) {
  if (!(await exists(absolutePath))) return { exists: false, content: null };
  return { exists: true, content: await readFile(absolutePath) };
}

function sameOptionalFileState(left, right) {
  return (
    left?.exists === right?.exists &&
    (!left?.exists || left.content.equals(right.content))
  );
}

function assertLiveStatus(status, requireTaskWorkflowCapabilities = true) {
  assert.equal(status?.ok, true, "Operon status is not healthy.");
  assert.equal(status?.source, "operon-runtime");
  assert.equal(status?.stale, false);
  assert.equal(status?.bridge?.version, EXPECTED_BRIDGE_VERSION);
  assert.equal(status?.bridge?.mode, "read-write");
  assert.equal(status?.operon?.present, true);
  assert.equal(status?.operon?.version, EXPECTED_OPERON_VERSION);
  assert.equal(status?.operon?.compatible, true);
  assert.equal(status?.index?.ready, true);
  assert.equal(Number.isInteger(status?.index?.generation), true);
  assert.ok(status.index.generation > 0);
  assert.equal(status?.index?.duplicateConflictCount, 0);
  const requiredCapabilities = [
    "status",
    "configuration",
    "list",
    "get",
    "query",
    "validate",
    "create",
    "update",
  ];
  if (requireTaskWorkflowCapabilities) {
    requiredCapabilities.push(
      "adopt",
      "periodicCreate",
      "periodicUpdate",
      "taskWorkflowRecovery",
    );
  }
  for (const capability of requiredCapabilities) {
    assert.equal(
      status?.capabilities?.[capability],
      true,
      `Required live capability is unavailable: ${capability}.`,
    );
  }
}

function assertRefreshedSnapshotStatus(status) {
  assert.equal(status?.ok, true, "Forced Operon snapshot refresh failed.");
  assert.equal(status?.source, "operon-live");
  assert.equal(status?.stale, false);
  assert.equal(status?.snapshot?.bridgeVersion, EXPECTED_BRIDGE_VERSION);
  assert.equal(status?.snapshot?.operonVersion, EXPECTED_OPERON_VERSION);
  assert.equal(Number.isInteger(status?.snapshot?.generation), true);
  assert.ok(status.snapshot.generation > 0);
}

async function main() {
  const apiKey = (process.env.OBSIDIAN_API_KEY ?? "").trim();
  const baseUrl = (process.env.OBSIDIAN_BASE_URL ?? "").replace(/\/$/u, "");
  const requestedVault = path.resolve(process.env.OBSIDIAN_VAULT ?? "");
  const startupOrder = envTrue("OPERON_35_CANARY_OPEN_VAULT");

  assert.equal(
    process.env.OPERON_35_CANARY_CONFIRM,
    RUN_CONFIRMATION,
    `Refusing live mutations. Set OPERON_35_CANARY_CONFIRM=${RUN_CONFIRMATION}.`,
  );
  assert.equal(
    requestedVault.toLowerCase(),
    EXPECTED_VAULT.toLowerCase(),
    "OBSIDIAN_VAULT must be the exact disposable Pilot 2 path.",
  );
  activeVaultIdentity = await assertVaultRootIdentity(requestedVault);
  assert.equal(
    baseUrl,
    EXPECTED_BASE_URL,
    `OBSIDIAN_BASE_URL must be exactly ${EXPECTED_BASE_URL}.`,
  );
  assert.ok(apiKey, "OBSIDIAN_API_KEY is required and is never logged.");
  assert.equal(
    envTrue("OPERON_MUTATIONS_ENABLED"),
    true,
    "OPERON_MUTATIONS_ENABLED=true is required.",
  );
  assert.equal(
    path.basename(EXPECTED_VAULT),
    EXPECTED_VAULT_NAME,
    "Pilot 2 vault identity mismatch.",
  );
  if (startupOrder) {
    assert.equal(
      process.env.OPERON_35_CANARY_CONFIRM_OPEN_VAULT,
      OPEN_CONFIRMATION,
      `Refusing to open Obsidian. Set OPERON_35_CANARY_CONFIRM_OPEN_VAULT=${OPEN_CONFIRMATION}.`,
    );
  } else {
    assert.equal(
      envTrue("OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN"),
      true,
      "Confirm the already-open Pilot 2 with OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN=true, or use the guarded startup-order mode.",
    );
  }

  const fixtureAbsolutePath = await assertSafeMissingVaultTarget(
    FIXTURE_PATH,
    "Dedicated fixture",
  );
  const candidate = await attestLiveCandidate(
    envTrue("OPERON_35_CANARY_RELEASE_CANDIDATE"),
  );

  const runId = randomUUID();
  const dates = routeDates(runId);
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "operon-35-live-backup-"),
  );
  const backupManifestPath = path.join(tempRoot, "fixture-state.json");
  const evidenceFile = path.join(
    os.tmpdir(),
    `operon-35-live-evidence-${runId}.json`,
  );
  const cachePath = path.join(tempRoot, "shared-cache.sqlite");
  const markdownBackupPath = path.join(tempRoot, "markdown-backup");
  const periodicRegistryBackupPath = path.join(
    tempRoot,
    "periodic-note-containers-before.json",
  );
  await writeFile(
    backupManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        vaultName: EXPECTED_VAULT_NAME,
        fixturePath: FIXTURE_PATH,
        existedBefore: false,
        restoreContract: "all-canary-markdown-byte-exact",
        runIdHash: shortHash(runId),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const evidence = {
    schemaVersion: 2,
    redacted: true,
    ok: false,
    runId,
    startedAt: new Date().toISOString(),
    vaultName: EXPECTED_VAULT_NAME,
    fixturePath: FIXTURE_PATH,
    candidate,
    startupOrder: { enabled: startupOrder, degradedObserved: false },
    routeDates: dates,
    runtime: null,
    firstUseNegotiation: {},
    validation: {},
    frontmatterDateManager: {},
    adoption: {},
    media: {},
    periodicCertification: { status: "not-run" },
    periodicScheduling: {},
    periodicCreates: [],
    bridgeConcurrency: {},
    pendingRecoveries: {},
    mutationStatuses: [],
    nativeProofs: [],
    preMutationInventory: null,
    artifactRestoration: { restored: false },
    periodicRegistryRestoration: { restored: false },
    fixtureRestoration: { restored: false },
    error: null,
  };

  let transport;
  let client;
  let backendStderr = "";
  let fixtureCreated = false;
  let fixtureRestored = false;
  let baselineSnapshot = null;
  let periodicRegistryBaseline = null;
  let openedVaultCli = null;
  let success = false;
  let shutdownSignal = null;
  const activeRequests = new Set();
  const runOwnedArtifacts = new Map();
  const physicalPreflightByIdempotencyKey = new Map();

  const onSignal = (signal) => {
    shutdownSignal ??= signal;
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  function assertActive() {
    if (shutdownSignal) throw new Error(`Interrupted by ${shutdownSignal}.`);
  }

  function track(promise) {
    activeRequests.add(promise);
    promise.then(
      () => activeRequests.delete(promise),
      () => activeRequests.delete(promise),
    );
    return promise;
  }

  async function callRaw(name, args, options = {}) {
    assertActive();
    const underlying = track(client.callTool({ name, arguments: args }));
    const result = await withTimeout(
      underlying,
      name,
      options.timeoutMs ?? READ_TIMEOUT_MS,
    );
    assertActive();
    const payload = parseMcpPayload(result, name);
    if (result.isError && !options.allowError) {
      const code = payload?.error?.code ?? "MCP_TOOL_ERROR";
      throw new Error(`${name} failed with ${String(code)}.`);
    }
    return { payload, isError: result.isError === true };
  }

  async function call(name, args, options = {}) {
    return (await callRaw(name, args, options)).payload;
  }

  function mutationDiagnostic(result, label, options = {}) {
    const error =
      result?.error && typeof result.error === "object" ? result.error : {};
    const details =
      error?.details && typeof error.details === "object" ? error.details : {};
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof options.thrownMessage === "string"
          ? options.thrownMessage
          : null;
    const safeMessage = message
      ? redactText(message, apiKey)
          .split(runId)
          .join("[REDACTED_RUN_ID]")
          .split(FIXTURE_PATH)
          .join("[REDACTED_FIXTURE]")
      : null;
    const recoveryRef = result?.recoveryRef ?? details?.recoveryRef;
    const planDigest = result?.planDigest ?? details?.planDigest;
    const nativeStatus = result?.nativeStatus ?? details?.nativeStatus;
    const mutationMayHaveApplied =
      result?.mutationMayHaveApplied ?? details?.mutationMayHaveApplied;
    const nativeProof =
      result?.nativeProof && typeof result.nativeProof === "object"
        ? result.nativeProof
        : null;
    const nativeGroups = Array.isArray(nativeProof?.groupResults)
      ? nativeProof.groupResults.slice(0, 32)
      : [];
    const diagnosticCode = boundedDiagnosticToken(
      typeof error.code === "string"
        ? error.code
        : typeof options.thrownCode === "string"
          ? options.thrownCode
          : options.transportError
            ? /timed out/iu.test(message ?? "")
              ? "MCP_TIMEOUT"
              : /connection closed/iu.test(message ?? "")
                ? "MCP_CONNECTION_CLOSED"
                : "MCP_TRANSPORT_ERROR"
            : undefined,
    );
    return {
      label,
      status: boundedDiagnosticToken(
        result?.status ??
          (options.transportError
            ? "transport-error"
            : options.mcpToolError
              ? "mcp-tool-error"
              : null),
      ),
      ...(diagnosticCode ? { code: diagnosticCode } : {}),
      ...(boundedDiagnosticToken(nativeStatus)
        ? { nativeStatus: boundedDiagnosticToken(nativeStatus) }
        : {}),
      ...(typeof nativeProof?.status === "string"
        ? { nativeProofStatus: boundedDiagnosticToken(nativeProof.status) }
        : {}),
      ...(nativeGroups.length > 0
        ? {
            nativeGroupStatuses: nativeGroups.map(
              (group) => boundedDiagnosticToken(group?.status) ?? "unknown",
            ),
            nativeGroupErrorCodes: nativeGroups.flatMap((group) => {
              const code = boundedDiagnosticToken(group?.error?.code);
              return code ? [code] : [];
            }),
          }
        : {}),
      ...(typeof mutationMayHaveApplied === "boolean"
        ? { mutationMayHaveApplied }
        : {}),
      ...(typeof result?.retryable === "boolean"
        ? { retryable: result.retryable }
        : {}),
      ...(typeof result?.operationId === "string"
        ? { operationIdHash: shortHash(result.operationId) }
        : {}),
      ...(typeof recoveryRef === "string" && recoveryRef
        ? { recoveryRefHash: shortHash(recoveryRef) }
        : {}),
      ...(typeof planDigest === "string" && planDigest
        ? { planDigestHash: shortHash(planDigest) }
        : {}),
      ...(safeMessage
        ? {
            messageHash: shortHash(safeMessage),
            messageChars: safeMessage.length,
            messageTruncated: message.length > 2_000,
          }
        : {}),
      ...(options.mcpToolError ? { mcpToolError: true } : {}),
      ...(options.transportError ? { transportError: true } : {}),
    };
  }

  async function callMutation(name, args, label) {
    const physicalPreflight =
      args?.dryRun === false
        ? await assertPhysicalPreDispatch(name, args, label)
        : null;
    if (args?.dryRun === false) {
      // This is intentionally immediately before every native dispatch. The
      // live proof must never describe a checkout that changed after its build
      // attestation, even between two canary steps.
      await assertCandidateStillExact(candidate);
      await assertVaultRootStillSame(`${label} native apply`);
    }
    let observed;
    try {
      observed = await callRaw(name, args, {
        allowError: true,
        timeoutMs: MUTATION_TIMEOUT_MS,
      });
    } catch (error) {
      evidence.mutationStatuses.push(
        mutationDiagnostic(null, label, {
          transportError: true,
          thrownMessage: error instanceof Error ? error.message : String(error),
          thrownCode: typeof error?.code === "string" ? error.code : undefined,
        }),
      );
      throw error;
    }
    const result = observed.payload;
    evidence.mutationStatuses.push(
      mutationDiagnostic(result, label, { mcpToolError: observed.isError }),
    );
    if (observed.isError) {
      const code = result?.error?.code ?? "MCP_TOOL_ERROR";
      throw new Error(`${label} failed with ${String(code)}.`);
    }
    if (result?.status === "outcome-unknown") {
      throw new Error(
        `${label} returned outcome-unknown; no recovery or blind retry was attempted.`,
      );
    }
    if (physicalPreflight) {
      await assertPhysicalPostDispatch(result, physicalPreflight, label);
    }
    return result;
  }

  async function waitForLiveStatus() {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const observed = await callRaw(
        "operon_status",
        {},
        { allowError: true, timeoutMs: READ_TIMEOUT_MS },
      );
      if (!observed.isError) {
        try {
          const liveStatus = observed.payload?.live;
          // A cold status must prove the core runtime only. Optional workflows
          // are deliberately negotiated by the exact first operation rather
          // than by this readiness poll.
          assertLiveStatus(liveStatus, false);
          return { status: liveStatus, attempts };
        } catch {
          // The same stdio connection remains alive while the live runtime settles.
        }
      }
      await sleep(1_000);
    }
    throw new Error(
      `Pilot 2 did not become live on the same MCP client within ${STARTUP_TIMEOUT_MS}ms.`,
    );
  }

  async function waitForRefreshedSnapshotStatus(label) {
    const deadline = Date.now() + Math.max(READ_TIMEOUT_MS, 30_000);
    let attempts = 0;
    let lastSource = null;
    while (Date.now() < deadline) {
      attempts += 1;
      const observed = await callRaw(
        "operon_status",
        { forceRefresh: true },
        { allowError: true, timeoutMs: READ_TIMEOUT_MS },
      );
      if (!observed.isError) {
        lastSource = boundedDiagnosticToken(observed.payload?.source);
        try {
          assertRefreshedSnapshotStatus(observed.payload);
          return { status: observed.payload, attempts };
        } catch {
          // Operon may briefly serve the last durable snapshot while its index
          // and post-write automations settle. Only an eventual live snapshot
          // satisfies this gate.
        }
      }
      await sleep(750);
    }
    throw new Error(
      `${label} did not produce an operon-live refreshed snapshot; lastSource=${lastSource ?? "unknown"}.`,
    );
  }

  async function validateZero(label) {
    const result = await call("operon_validate", { forceRefresh: true });
    assert.deepEqual(
      result?.summary,
      { P0: 0, P1: 0, P2: 0 },
      `${label} validation is not P0/P1/P2 = 0/0/0.`,
    );
    evidence.validation[label] = result.summary;
    return result;
  }

  async function pendingRecoveriesZero(label) {
    const result = await call("operon_list_pending_recoveries", {});
    assert.equal(
      Array.isArray(result?.recoveries),
      true,
      `${label} pending recovery response is malformed.`,
    );
    assert.equal(
      result.recoveries.length,
      0,
      `${label} has pending Operon recoveries; the canary will not recover or retry them.`,
    );
    evidence.pendingRecoveries[label] = 0;
  }

  async function stableTask(operonId) {
    const deadline = Date.now() + 30_000;
    let previousRevision = null;
    while (Date.now() < deadline) {
      const result = await call("operon_get_task", {
        operonId,
        includeProperties: true,
        forceRefresh: true,
      });
      const task = result?.task;
      if (task?.revision && task.revision === previousRevision) return task;
      previousRevision = task?.revision ?? null;
      await sleep(750);
    }
    throw new Error(
      `Operon task ${shortHash(operonId)} did not reach a stable revision.`,
    );
  }

  async function assertKnownMutationTaskSource(operonId, label) {
    const task = await stableTask(operonId);
    assert.equal(
      canonicalRelativeMarkdownPath(task?.path),
      true,
      `${label} resolved an unsafe task source path.`,
    );
    await safeVaultRegularFile(task.path, `${label} physical task source`);
    return task.path;
  }

  async function assertPhysicalPreDispatch(name, args, label) {
    // A sealed Developer API plan is logical evidence, not filesystem
    // containment. Every native mutation gets a fresh dry-run and an immediate
    // physical source/target proof; no unresolved or ambiguous target may
    // reach the subsequent apply dispatch.
    assert.equal(
      typeof args?.idempotencyKey,
      "string",
      `${label} has no idempotency key for physical pre-dispatch attestation.`,
    );
    const previous = physicalPreflightByIdempotencyKey.get(args.idempotencyKey);
    if (previous) {
      // A same-key replay is already bound to the original sealed plan. Do not
      // issue a different-key dry-run that could be rejected because the first
      // apply has intentionally changed the source; re-attest the exact prior
      // paths immediately before the replay dispatch instead.
      for (const relativePath of previous.paths) {
        await safeVaultRegularFile(
          relativePath,
          `${label} replay physical pre-dispatch`,
        );
      }
      return {
        paths: new Set(previous.paths),
        inventory: await markdownInventory(),
      };
    }
    const expectedPaths = new Set();
    const explicitPaths = [
      args?.adoption?.targetPath,
      args?.task?.targetPath,
      args?.targetPath,
    ].filter((value) => typeof value === "string");
    for (const relativePath of explicitPaths) {
      assert.equal(
        canonicalRelativeMarkdownPath(relativePath),
        true,
        `${label} has an unsafe explicit task source path.`,
      );
      await safeVaultRegularFile(relativePath, `${label} explicit task source`);
      expectedPaths.add(relativePath);
    }
    const taskIds = new Set(
      [
        args?.operonId,
        args?.relationships?.parentTask,
        ...(args?.relationships?.blockedBy ?? []),
        ...(args?.relationships?.blocking ?? []),
      ].filter((value) => typeof value === "string"),
    );
    for (const operonId of taskIds) {
      expectedPaths.add(await assertKnownMutationTaskSource(operonId, label));
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
    const preflightConflict =
      !observed.isError && observed.payload?.status === "conflict";
    assert.equal(
      observed.isError,
      false,
      `${label} physical preflight was rejected; refusing native dispatch.`,
    );
    assert.equal(
      observed.payload?.status === "planned" || preflightConflict,
      true,
      `${label} physical preflight did not return a sealed plan or expected stale conflict.`,
    );
    const projectedPaths = preflightConflict
      ? new Set()
      : await assertSafePlannedTaskSourceArtifacts(
          observed.payload?.plan,
          label,
          {
            requirePaths: mutationRequiresProjectedTaskSourcePaths(
              name,
              expectedPaths.size,
            ),
          },
        );
    assert.equal(
      preflightConflict && expectedPaths.size === 0,
      false,
      `${label} stale preflight has no previously resolved task source; refusing native dispatch.`,
    );
    const paths = new Set([...expectedPaths, ...projectedPaths]);
    assert.ok(
      paths.size > 0,
      `${label} has no physically resolved task source; refusing native dispatch.`,
    );
    for (const relativePath of paths) {
      await safeVaultRegularFile(
        relativePath,
        `${label} physical pre-dispatch`,
        {
          allowMissing:
            projectedPaths.has(relativePath) &&
            !expectedPaths.has(relativePath),
        },
      );
    }
    const preflight = { paths, inventory: await markdownInventory() };
    physicalPreflightByIdempotencyKey.set(args.idempotencyKey, {
      paths: new Set(paths),
    });
    return preflight;
  }

  async function assertPhysicalPostDispatch(result, preflight, label) {
    if (typeof result?.after?.path === "string") {
      assert.equal(
        preflight.paths.has(result.after.path),
        true,
        `${label} returned a task source not sealed by the physical pre-dispatch proof.`,
      );
      await safeVaultRegularFile(
        result.after.path,
        `${label} physical post-dispatch`,
      );
    }
    const changes = inventoryDiff(
      preflight.inventory,
      await markdownInventory(),
    );
    for (const change of changes) {
      assert.equal(
        preflight.paths.has(change.path),
        true,
        `${label} changed a Markdown source absent from the physical pre-dispatch proof.`,
      );
      await safeVaultRegularFile(
        change.path,
        `${label} changed physical source`,
      );
    }
  }

  async function preparePeriodicCreateViaMcp(kind, routeDate, label) {
    const description = `Operon 3.5 ${kind} canary ${runId}`;
    const before = await markdownInventory();
    const periodic = {
      description,
      periodicKind: kind,
      routeDate,
      fields: { taskType: `canary-${kind}` },
    };
    const preview = mutationStatus(
      await callMutation(
        "operon_create_periodic_task",
        {
          idempotencyKey: `${runId}:${kind}:preview`,
          dryRun: true,
          periodic,
        },
        `${label} preview`,
      ),
      `${label} preview`,
      "planned",
    );
    assert.equal(
      preview.plan?.capability,
      "tasks.create.periodic-note.preview",
    );
    assert.equal(preview.plan?.mutationKind, "task.create");
    assert.equal(preview.plan?.planDigest, preview.planDigest);
    const plannedSourcePaths = await assertSafePlannedTaskSourceArtifacts(
      preview.plan,
      `${label} preview`,
      { requirePaths: false },
    );
    assert.deepEqual(
      redactedInventoryChanges(
        inventoryDiff(before, await markdownInventory()),
      ),
      [],
      `${label} preview changed the vault inventory.`,
    );
    return {
      before,
      description,
      kind,
      label,
      periodic,
      plannedSourcePaths,
      preview,
      routeDate,
    };
  }

  async function applyPreparedPeriodicCreate(prepared) {
    const {
      before,
      kind,
      label,
      periodic,
      plannedSourcePaths,
      preview,
      routeDate,
    } = prepared;
    assert.ok(
      plannedSourcePaths.size > 0,
      `${label} has no public task-source projection; refusing periodic apply.`,
    );
    // A plan is not a physical containment proof: revalidate immediately
    // before dispatch so a parent junction or a target hardlink swap aborts
    // before Operon can write through it.
    await assertSafePlannedTaskSourceArtifacts(
      preview.plan,
      `${label} apply pre-dispatch`,
    );
    const result = mutationStatus(
      await callMutation(
        "operon_create_periodic_task",
        {
          idempotencyKey: `${runId}:${kind}:apply`,
          dryRun: false,
          periodic,
        },
        label,
      ),
      label,
      "applied",
    );
    evidence.nativeProofs.push(assertNativeMutationProof(result, label));
    assert.equal(result?.after?.source, "inline");
    assert.equal(
      canonicalRelativeMarkdownPath(result?.after?.path),
      true,
      `${label} returned an unsafe source path.`,
    );
    assert.equal(
      plannedSourcePaths.has(result.after.path),
      true,
      `${label} returned a source path not sealed by its physical pre-dispatch plan.`,
    );
    await recordRunOwnedArtifact(result.after.path, `${label} result`);
    const after = await markdownInventory();
    const changes = inventoryDiff(before, after);
    const sourceBefore = before.get(result.after.path);
    assert.equal(
      sourceBefore,
      undefined,
      `${label} routed into a pre-existing Markdown note; refusing to treat it as a canary artifact.`,
    );
    assert.equal(
      changes.some(
        (change) =>
          change.path === result.after.path && change.change === "created",
      ),
      true,
      `${label} did not create a dedicated periodic note.`,
    );
    const sourceContent = await readFile(
      absoluteVaultPath(result.after.path),
      "utf8",
    );
    assert.equal(
      sourceContent.includes(runId),
      true,
      `${label} source does not contain the run marker.`,
    );
    evidence.periodicCreates.push({
      kind,
      routeDate,
      pathHash: shortHash(result.after.path),
      operationIdHash: shortHash(result.operationId),
      operonIdHash: shortHash(result.after.operonId),
      previewPlanDigestHash: shortHash(preview.planDigest),
      markdownChanges: redactedInventoryChanges(changes),
      restoredOnPass: false,
    });
    return result.after;
  }

  async function recordRunOwnedArtifact(relativePath, label) {
    assert.equal(
      baselineSnapshot?.has(relativePath),
      false,
      `${label} tried to claim a pre-existing Markdown path as canary-owned.`,
    );
    const checked = await safeVaultRegularFile(relativePath, label);
    const content = await readFile(checked.absolute, "utf8");
    assert.equal(
      content.includes(runId),
      true,
      `${label} has no exact canary marker and cannot be removed by this run.`,
    );
    runOwnedArtifacts.set(relativePath, runId);
  }

  async function trackNativeTaskSourceArtifacts(result, label) {
    for (const group of result?.nativeProof?.groupResults ?? []) {
      for (const revision of group.resourceRevisions ?? []) {
        if (revision.resourceKind !== "task-source") continue;
        assert.equal(
          canonicalRelativeMarkdownPath(revision.resourceKey),
          true,
          `${label} returned an unsafe task-source resource key.`,
        );
        if (!baselineSnapshot?.has(revision.resourceKey)) {
          await recordRunOwnedArtifact(revision.resourceKey, label);
        }
      }
    }
  }

  async function removeEmptyArtifactParents(relativePath) {
    let current = path.dirname(absoluteVaultPath(relativePath));
    const vaultRoot = currentVaultIdentity().realRoot;
    while (!samePathIdentity(current, vaultRoot)) {
      try {
        await assertSafeVaultDirectory(current, "Canary artifact parent");
        await assertVaultRootStillSame("Canary artifact parent deletion");
        await rmdir(current);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return;
        throw error;
      }
      current = path.dirname(current);
    }
  }

  async function restoreAllCanaryArtifacts() {
    if (!baselineSnapshot) {
      fixtureRestored = !fixtureCreated;
      evidence.fixtureRestoration = {
        restored: fixtureRestored,
        expectedState: "absent",
      };
      return;
    }
    await assertVaultRootStillSame("Canary artifact restoration");

    const current = await captureMarkdownSnapshot();
    const changes = inventoryDiff(baselineSnapshot, current);
    const restorable = [];
    const unexpected = [];
    for (const change of changes) {
      const recordedMarker = runOwnedArtifacts.get(change.path);
      const currentContent = current.get(change.path)?.content;
      const belongsToRun =
        !baselineSnapshot.has(change.path) &&
        recordedMarker === runId &&
        (!currentContent ||
          currentContent.includes(Buffer.from(recordedMarker, "utf8")));
      (belongsToRun ? restorable : unexpected).push(change);
    }

    for (const change of restorable) {
      const checked = await safeVaultRegularFile(
        change.path,
        "Run-owned canary artifact",
        { allowMissing: true },
      );
      if (checked.exists) {
        await removeRunOwnedVaultArtifact(
          change.path,
          runId,
          "Run-owned canary artifact",
        );
        await removeEmptyArtifactParents(change.path);
      }
    }

    const after = await captureMarkdownSnapshot();
    const remaining = inventoryDiff(baselineSnapshot, after);
    const restored = remaining.length === 0 && unexpected.length === 0;
    fixtureRestored = !(
      await safeVaultRegularFile(FIXTURE_PATH, "Dedicated fixture", {
        allowMissing: true,
      })
    ).exists;
    evidence.fixtureRestoration = {
      restored: fixtureRestored,
      expectedState: "absent",
    };
    evidence.artifactRestoration = {
      restored,
      restoredChangeCount: restorable.length,
      unexpectedChangeCount: unexpected.length,
      remainingChangeCount: remaining.length,
      restoredPathHashes: restorable.map((change) => shortHash(change.path)),
      unexpectedPathHashes: unexpected.map((change) => shortHash(change.path)),
      remainingPathHashes: remaining.map((change) => shortHash(change.path)),
      finalInventoryDigestHash: shortHash(inventoryDigest(after)),
    };
    assert.equal(
      unexpected.length,
      0,
      "Unexpected Markdown changes occurred during the canary; they were not overwritten.",
    );
    assert.deepEqual(
      remaining,
      [],
      "Canary Markdown artifacts were not restored byte-for-byte.",
    );
  }

  try {
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
        // The startup-order contract is a live-runtime promise: the MCP must
        // remain connected while Desktop/Local REST is temporarily absent.
        OBSIDIAN_STARTUP_BLOCKING: "false",
        OBSIDIAN_VAULT: EXPECTED_VAULT,
        OBSIDIAN_BASE_URL: baseUrl,
        OBSIDIAN_API_KEY: apiKey,
        OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
        OBSIDIAN_ENABLE_CACHE: "true",
        SEMANTIC_SEARCH_PREWARM: "false",
        LOGS_DIR: PROJECT_LOGS_PATH,
        MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (backendStderr.length < 32_768) {
        backendStderr += chunk.toString("utf8");
      }
    });
    client = new Client(
      { name: "operon-35-live-canary", version: "1.0.0" },
      { capabilities: {} },
    );
    await withTimeout(client.connect(transport), "MCP stdio connect", 30_000);

    const toolListBefore = await withTimeout(
      client.listTools(),
      "MCP tools/list",
      READ_TIMEOUT_MS,
    );
    const toolNames = new Set(toolListBefore.tools.map((tool) => tool.name));
    for (const required of [
      "operon_status",
      "operon_validate",
      "operon_adopt_task",
      "operon_create_periodic_task",
      "operon_update_periodic_scheduling",
      "operon_update_task",
      "operon_get_task",
      "operon_query_tasks",
      "operon_list_pending_recoveries",
      "operon_recover_mutation",
    ]) {
      assert.equal(
        toolNames.has(required),
        true,
        `Missing MCP tool: ${required}.`,
      );
    }

    if (startupOrder) {
      const degraded = await callRaw("operon_status", {}, { allowError: true });
      const degradedObserved =
        degraded.isError ||
        degraded.payload?.ok !== true ||
        degraded.payload?.live?.index?.ready !== true;
      assert.equal(
        degradedObserved,
        true,
        "Startup-order mode requires Pilot 2 to be closed at the first status call.",
      );
      evidence.startupOrder.degradedObserved = true;
      evidence.startupOrder.connectionAliveAfterDegraded =
        (
          await withTimeout(
            client.listTools(),
            "MCP tools/list after degraded status",
            READ_TIMEOUT_MS,
          )
        ).tools.length === toolListBefore.tools.length;
      assert.equal(
        evidence.startupOrder.connectionAliveAfterDegraded,
        true,
        "MCP connection did not survive the degraded status call.",
      );
      const cliCommand =
        (process.env.OPERON_35_CANARY_OBSIDIAN_CLI ?? "obsidian").trim() ||
        "obsidian";
      openedVaultCli = cliCommand;
      const cli = await runCli(cliCommand, [
        `vault=${EXPECTED_VAULT_NAME}`,
        "version",
      ]);
      evidence.startupOrder.cliExitCode = cli.exitCode;
    }

    const live = await waitForLiveStatus();
    evidence.startupOrder.liveAttempts = live.attempts;
    evidence.startupOrder.sameClientBecameLive = true;
    evidence.runtime = {
      operonVersion: live.status.operon.version,
      bridgeVersion: live.status.bridge.version,
      bridgeMode: live.status.bridge.mode,
      compatibilityState: live.status.operon.compatibilityState ?? null,
      generation: live.status.index.generation,
      taskCount: live.status.index.taskCount,
      capabilities: Object.fromEntries(
        [
          "adopt",
          "create",
          "update",
          "periodicCreate",
          "periodicUpdate",
          "taskWorkflowRecovery",
          "filterQuery",
        ].map((name) => [name, live.status.capabilities[name]]),
      ),
    };
    for (const capability of [
      "adopt",
      "periodicCreate",
      "periodicUpdate",
      "taskWorkflowRecovery",
      "filterQuery",
    ]) {
      assert.equal(
        live.status.capabilities[capability],
        false,
        `Optional capability must remain cold before its exact first operation: ${capability}.`,
      );
    }
    evidence.firstUseNegotiation.initiallyCold = true;

    await validateZero("before");

    const collisionMarkers = [
      ...new Set([
        runId,
        dates.daily,
        dates.scheduled,
        dates.weekly,
        ...isoWeekMarkers(dates.weekly),
        dates.concurrent,
      ]),
    ];
    baselineSnapshot = await captureMarkdownSnapshot(markdownBackupPath);
    periodicRegistryBaseline = await optionalFileState(PERIODIC_REGISTRY_PATH);
    if (periodicRegistryBaseline.exists) {
      await writeFile(
        periodicRegistryBackupPath,
        periodicRegistryBaseline.content,
        { mode: 0o600 },
      );
    }
    assertCollisionFree(baselineSnapshot, collisionMarkers);
    await writeFile(
      backupManifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          vaultName: EXPECTED_VAULT_NAME,
          fixturePath: FIXTURE_PATH,
          existedBefore: false,
          restoreContract: "all-canary-markdown-byte-exact",
          runIdHash: shortHash(runId),
          markdownCount: baselineSnapshot.size,
          inventoryDigest: inventoryDigest(baselineSnapshot),
          periodicRegistryExisted: periodicRegistryBaseline.exists,
          periodicRegistryDigest: periodicRegistryBaseline.exists
            ? sha256(periodicRegistryBaseline.content)
            : null,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const preflightQuery = await call("operon_query_tasks", {
      search: runId,
      forceRefresh: true,
      limit: 100,
    });
    assert.equal(
      (preflightQuery?.tasks ?? []).length,
      0,
      "The unique canary run marker already resolves to an Operon task.",
    );
    evidence.preMutationInventory = {
      completed: true,
      markdownCount: baselineSnapshot.size,
      inventoryDigestHash: shortHash(inventoryDigest(baselineSnapshot)),
      collisionMarkerHashes: collisionMarkers.map(shortHash),
      operonCollisionCount: 0,
      backupStoredInPrivateTemp: true,
      periodicRegistryExisted: periodicRegistryBaseline.exists,
      periodicRegistryDigestHash: periodicRegistryBaseline.exists
        ? shortHash(sha256(periodicRegistryBaseline.content))
        : null,
    };

    const communityPlugins = JSON.parse(
      await readFile(
        path.join(EXPECTED_VAULT, ".obsidian", "community-plugins.json"),
        "utf8",
      ),
    );
    const operonSettings = JSON.parse(
      await readFile(
        path.join(
          EXPECTED_VAULT,
          ".obsidian",
          "plugins",
          "operon",
          "data.json",
        ),
        "utf8",
      ),
    );
    const periodicProfile = operonSettings?.ui?.taskCreationProfile;
    assert.equal(
      periodicProfile?.manageDailyNotesWithOperon,
      true,
      "Pilot 2 must use Operon-managed Daily Notes before the canary mutates Markdown.",
    );
    assert.equal(
      periodicProfile?.createDailyNotesAsOperonTask,
      true,
      "Pilot 2 must create Daily Notes as Operon tasks before the canary mutates Markdown.",
    );
    assert.equal(
      periodicProfile?.manageWeeklyNotesWithOperon,
      true,
      "Pilot 2 must use Operon-managed Weekly Notes before the canary mutates Markdown.",
    );
    assert.equal(
      periodicProfile?.createWeeklyNotesAsOperonTask,
      true,
      "Pilot 2 must create Weekly Notes as Operon tasks before the canary mutates Markdown.",
    );
    const dateManagerSettings = JSON.parse(
      await readFile(
        path.join(
          EXPECTED_VAULT,
          ".obsidian",
          "plugins",
          "frontmatter-date-manager",
          "data.json",
        ),
        "utf8",
      ),
    );
    const dateManagerManifest = JSON.parse(
      await readFile(
        path.join(
          EXPECTED_VAULT,
          ".obsidian",
          "plugins",
          "frontmatter-date-manager",
          "manifest.json",
        ),
        "utf8",
      ),
    );
    assert.equal(communityPlugins.includes("frontmatter-date-manager"), true);
    assert.equal(dateManagerManifest.version, "1.2.1");
    assert.equal(dateManagerSettings.enableAutoUpdate, true);
    assert.equal(dateManagerSettings.enableModifiedTime, true);

    await ensureSafeVaultParentChain(fixtureAbsolutePath, "Dedicated fixture");
    await assertSafeMissingVaultTarget(FIXTURE_PATH, "Dedicated fixture");
    const expectedLine = `- [ ] Operon adoption canary ${runId}`;
    const initialFixture = [
      "---",
      "canary: operon-3.5-live",
      `modification: ${ORIGINAL_MODIFICATION}`,
      "---",
      "",
      `Dedicated Pilot 2 fixture ${runId}.`,
      expectedLine,
      "",
    ].join("\n");
    await writeFile(fixtureAbsolutePath, initialFixture, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await safeVaultRegularFile(FIXTURE_PATH, "Dedicated fixture");
    await recordRunOwnedArtifact(FIXTURE_PATH, "Dedicated fixture");
    fixtureCreated = true;
    const fixtureBeforeAdoption = await waitForFileStable(
      fixtureAbsolutePath,
      (content) =>
        content.includes(expectedLine) &&
        frontmatterScalarWhenValid(content, "modification") ===
          ORIGINAL_MODIFICATION,
      "the external fixture to settle before governed adoption",
    );
    const fixtureLines = fixtureBeforeAdoption.split(/\r?\n/u);
    const adoptionIndexes = fixtureLines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line === expectedLine);
    assert.equal(adoptionIndexes.length, 1);
    const adoptionLine = adoptionIndexes[0].index + 1;
    const adoptionArgs = {
      idempotencyKey: `${runId}:adopt:apply`,
      dryRun: false,
      adoption: {
        targetPath: FIXTURE_PATH,
        line: adoptionLine,
        expectedLine,
      },
    };
    const adopted = mutationStatus(
      await callMutation("operon_adopt_task", adoptionArgs, "adoption apply"),
      "adoption apply",
      "applied",
    );
    const adoptionStatusGate = await waitForRefreshedSnapshotStatus(
      "post-adoption status",
    );
    const postAdoptionStatus = adoptionStatusGate.status;
    assertRefreshedSnapshotStatus(postAdoptionStatus);
    assert.equal(postAdoptionStatus.snapshot.capabilities.adopt, true);
    assert.equal(
      postAdoptionStatus.snapshot.capabilities.periodicCreate,
      false,
    );
    assert.equal(
      postAdoptionStatus.snapshot.capabilities.periodicUpdate,
      false,
    );
    assert.equal(postAdoptionStatus.snapshot.capabilities.filterQuery, false);
    evidence.firstUseNegotiation.adoptionOnly = true;
    evidence.firstUseNegotiation.adoptionStatusAttempts =
      adoptionStatusGate.attempts;
    evidence.nativeProofs.push(
      assertNativeMutationProof(adopted, "adoption apply"),
    );
    assert.equal(adopted.after?.path, FIXTURE_PATH);
    assert.equal(adopted.after?.line, adoptionLine);
    const fixtureAfterGovernedAdoption = await waitForFileStable(
      fixtureAbsolutePath,
      (content) => {
        const modification = frontmatterScalarWhenValid(
          content,
          "modification",
        );
        return (
          content.includes(runId) &&
          modification !== null &&
          modification !== ORIGINAL_MODIFICATION
        );
      },
      "Frontmatter Date Manager after governed Operon adoption",
    );
    const observedModification = markdownFrontmatter(
      fixtureAfterGovernedAdoption,
      "governed adoption fixture",
    ).modification;
    assert.ok(observedModification);
    evidence.frontmatterDateManager = {
      enabled: true,
      version: dateManagerManifest.version,
      autoUpdate: true,
      modifiedTimeObserved: true,
      trigger: "operon_adopt_task",
      externalCreateWasNotTreatedAsTheTrigger: true,
      beforeContentHash: shortHash(fixtureBeforeAdoption),
      afterContentHash: shortHash(fixtureAfterGovernedAdoption),
      observedModificationHash: shortHash(String(observedModification)),
      pluginSettingsHash: shortHash(JSON.stringify(dateManagerSettings)),
    };
    const adoptedId = adopted.after.operonId;
    const replay = await callMutation(
      "operon_adopt_task",
      adoptionArgs,
      "adoption replay",
    );
    assert.equal(
      replay.operationId,
      adopted.operationId,
      "Adoption replay returned a different operationId.",
    );
    assert.equal(replay.replayed, true);
    evidence.nativeProofs.push(
      assertNativeMutationProof(replay, "adoption replay"),
    );
    const staleLine = mutationStatus(
      await callMutation(
        "operon_adopt_task",
        {
          ...adoptionArgs,
          idempotencyKey: `${runId}:adopt:stale-line`,
        },
        "adoption stale line",
      ),
      "adoption stale line",
      "conflict",
    );
    evidence.adoption = {
      applied: true,
      replayed: replay.replayed,
      staleLineConflict: staleLine.status,
      operationIdHash: shortHash(adopted.operationId),
      operonIdHash: shortHash(adoptedId),
      exactLine: adoptionLine,
    };

    const beforeMedia = await stableTask(adoptedId);
    const taskType = `canary-type-${runId.slice(0, 8)}`;
    const taskImage = `Canary\\cover;${runId.slice(0, 8)}.png`;
    const galleryInput = [
      `Canary/gallery;${runId.slice(0, 8)}.png`,
      `Canary\\gallery;${runId.slice(0, 8)}.png`,
      `Canary/gallery;${runId.slice(0, 8)}.png`,
    ];
    const galleryExpected = galleryInput.slice(0, 2);
    const mediaApplied = mutationStatus(
      await callMutation(
        "operon_update_task",
        {
          operonId: adoptedId,
          expectedRevision: beforeMedia.revision,
          idempotencyKey: `${runId}:media:apply`,
          dryRun: false,
          patch: {
            fields: {
              taskType,
              taskImage,
              taskGallery: galleryInput,
            },
          },
        },
        "typed media apply",
      ),
      "typed media apply",
      "applied",
    );
    evidence.nativeProofs.push(
      assertNativeMutationProof(mediaApplied, "typed media apply"),
    );
    assert.equal(typeof mediaApplied.after?.fields?.taskType, "string");
    assert.equal(mediaApplied.after.fields.taskType, taskType);
    assert.equal(typeof mediaApplied.after.fields.taskImage, "string");
    assert.equal(mediaApplied.after.fields.taskImage, taskImage);
    assert.equal(Array.isArray(mediaApplied.after.fields.taskGallery), true);
    assert.deepEqual(mediaApplied.after.fields.taskGallery, galleryExpected);
    // Isolate the stale-revision assertion from normal post-write index churn
    // (including Frontmatter Date Manager's immediate timestamp update). The
    // following mutation must fail because its revision is stale, not because
    // the Operon snapshot was sampled while a live generation was settling.
    await stableTask(adoptedId);
    const staleRevision = mutationStatus(
      await callMutation(
        "operon_update_task",
        {
          operonId: adoptedId,
          expectedRevision: beforeMedia.revision,
          idempotencyKey: `${runId}:media:stale-revision`,
          dryRun: false,
          patch: { fields: { taskType: `${taskType}-stale` } },
        },
        "typed media stale revision",
      ),
      "typed media stale revision",
      "conflict",
    );
    evidence.media = {
      taskTypeScalar: true,
      taskImageScalar: true,
      galleryArray: true,
      galleryOrderPreserved: true,
      galleryFirstOccurrenceDeduplicated: true,
      punctuationPreserved: true,
      staleRevisionConflict: staleRevision.status,
    };

    const dailyPreview = await preparePeriodicCreateViaMcp(
      "daily",
      dates.daily,
      "Daily periodic create",
    );
    const periodicCreateStatusGate = await waitForRefreshedSnapshotStatus(
      "post-periodic-create preview status",
    );
    const postPeriodicCreateStatus = periodicCreateStatusGate.status;
    assertRefreshedSnapshotStatus(postPeriodicCreateStatus);
    assert.equal(
      postPeriodicCreateStatus.snapshot.capabilities.periodicCreate,
      true,
    );
    assert.equal(
      postPeriodicCreateStatus.snapshot.capabilities.periodicUpdate,
      false,
    );
    assert.equal(
      postPeriodicCreateStatus.snapshot.capabilities.filterQuery,
      false,
    );
    evidence.firstUseNegotiation.periodicCreateOnly = true;
    evidence.firstUseNegotiation.periodicCreateStatusAttempts =
      periodicCreateStatusGate.attempts;
    const periodicExecution = selectPeriodicCanaryExecution(
      dailyPreview.preview.plan,
    );
    if (periodicExecution.mode === "skip") {
      evidence.periodicCertification = {
        status: "skipped",
        reason: periodicExecution.reason,
        dailyPreview: {
          capability: dailyPreview.preview.plan?.capability ?? null,
          mutationKind: dailyPreview.preview.plan?.mutationKind ?? null,
          planDigestHash: shortHash(dailyPreview.preview.planDigest),
          projectedTaskSourcePathCount:
            periodicExecution.projectedTaskSourcePaths.size,
        },
        appliedOperations: periodicExecution.periodicApplyOperations,
        periodicApplyDispatched: periodicExecution.periodicApplyDispatched,
        periodicApplyDispatchCount:
          periodicExecution.periodicApplyDispatchCount,
        skippedApplyOperations: [
          "daily-create",
          "weekly-create",
          "schedule-set",
          "schedule-clear",
          "bridge-concurrency",
        ],
      };
      evidence.periodicScheduling = {
        status: "skipped",
        reason: periodicExecution.reason,
      };
      evidence.bridgeConcurrency = {
        status: "skipped",
        reason: periodicExecution.reason,
        restoredOnPass: "not-applicable",
      };
    } else {
      const daily = await applyPreparedPeriodicCreate(dailyPreview);
      const weekly = await applyPreparedPeriodicCreate(
        await preparePeriodicCreateViaMcp(
          "weekly",
          dates.weekly,
          "Weekly periodic create",
        ),
      );
      assert.notEqual(daily.path, weekly.path);

      const schedulingStatusGate = await waitForRefreshedSnapshotStatus(
        "pre-periodic-update status",
      );
      const schedulingCapabilityStatus = schedulingStatusGate.status;
      assertRefreshedSnapshotStatus(schedulingCapabilityStatus);
      assert.equal(
        schedulingCapabilityStatus.snapshot.capabilities.periodicUpdate,
        false,
        "Periodic-update must remain cold until its own exact first operation.",
      );
      const beforeSchedule = await stableTask(daily.operonId);
      assert.deepEqual(
        { path: beforeSchedule.path, line: beforeSchedule.line },
        { path: daily.path, line: daily.line },
        "The created Daily fixture locator changed before periodic scheduling.",
      );
      assert.equal(beforeSchedule.source, "inline");
      assert.equal(
        typeof beforeSchedule.parentTask === "string" &&
          beforeSchedule.parentTask.length > 0,
        true,
        "The created Daily fixture has no projected periodic parent; refusing periodic scheduling.",
      );
      const sourceLocator = {
        path: beforeSchedule.path,
        line: beforeSchedule.line,
      };
      const schedulePreview = mutationStatus(
        await callMutation(
          "operon_update_periodic_scheduling",
          {
            operonId: daily.operonId,
            expectedRevision: beforeSchedule.revision,
            idempotencyKey: `${runId}:periodic-schedule:set-preview`,
            dryRun: true,
            patch: { fields: { dateScheduled: dates.scheduled } },
          },
          "periodic scheduling set preview",
        ),
        "periodic scheduling set preview",
        "planned",
      );
      assert.equal(
        schedulePreview.plan?.capability,
        "tasks.update.periodic-note.preview",
        "Operon did not project the additive periodic-update plan for the created Daily fixture.",
      );
      assert.equal(schedulePreview.plan?.mutationKind, "task.update");
      assert.equal(
        schedulePreview.plan?.planDigest,
        schedulePreview.planDigest,
      );
      const periodicUpdateStatusGate = await waitForRefreshedSnapshotStatus(
        "post-periodic-update status",
      );
      const postPeriodicUpdateStatus = periodicUpdateStatusGate.status;
      assertRefreshedSnapshotStatus(postPeriodicUpdateStatus);
      assert.equal(
        postPeriodicUpdateStatus.snapshot.capabilities.periodicUpdate,
        true,
      );
      assert.equal(
        postPeriodicUpdateStatus.snapshot.capabilities.filterQuery,
        false,
      );
      evidence.firstUseNegotiation.periodicUpdateOnly = true;
      evidence.firstUseNegotiation.periodicUpdateStatusAttempts =
        periodicUpdateStatusGate.attempts;
      const schedulePlannedSourcePaths =
        await assertSafePlannedTaskSourceArtifacts(
          schedulePreview.plan,
          "Periodic scheduling set preview",
        );
      const beforeScheduleApply = await stableTask(daily.operonId);
      assert.equal(
        beforeScheduleApply.revision,
        beforeSchedule.revision,
        "The Daily fixture changed after periodic scheduling preview.",
      );
      const beforeSchedulingMutationInventory = await markdownInventory();
      await assertSafePlannedTaskSourceArtifacts(
        schedulePreview.plan,
        "Periodic scheduling set apply pre-dispatch",
      );
      const scheduledResult = await callMutation(
        "operon_update_periodic_scheduling",
        {
          operonId: daily.operonId,
          expectedRevision: beforeScheduleApply.revision,
          idempotencyKey: `${runId}:periodic-schedule:set`,
          dryRun: false,
          patch: { fields: { dateScheduled: dates.scheduled } },
        },
        "periodic scheduling set",
      );
      const schedulingMutationChanges = inventoryDiff(
        beforeSchedulingMutationInventory,
        await markdownInventory(),
      );
      for (const change of schedulingMutationChanges) {
        if (
          change.change === "created" &&
          path.basename(change.path, ".md") === dates.scheduled
        ) {
          assert.equal(
            schedulePlannedSourcePaths.has(change.path),
            true,
            "Periodic scheduling created a source path not sealed by the pre-dispatch plan.",
          );
          assert.equal(
            canonicalRelativeMarkdownPath(change.path),
            true,
            "Periodic scheduling created an unsafe task-source path.",
          );
          await recordRunOwnedArtifact(
            change.path,
            "Periodic scheduling generated source",
          );
        }
      }
      await trackNativeTaskSourceArtifacts(
        scheduledResult,
        "Periodic scheduling set",
      );
      const scheduled = mutationStatus(
        scheduledResult,
        "periodic scheduling set",
        "applied",
      );
      evidence.nativeProofs.push(
        assertNativeMutationProof(scheduled, "periodic scheduling set"),
      );
      assert.equal(scheduled.after.path, sourceLocator.path);
      await safeVaultRegularFile(
        scheduled.after.path,
        "Periodic scheduling updated source",
      );
      assert.equal(scheduled.after.operonId, daily.operonId);
      assert.equal(Number.isInteger(scheduled.after.line), true);
      assert.equal(scheduled.after.dates.scheduled, dates.scheduled);
      assert.equal(
        typeof scheduled.after.parentTask === "string" &&
          scheduled.after.parentTask.length > 0,
        true,
        "Periodic scheduling set did not project a periodic parent.",
      );
      assert.notEqual(scheduled.after.parentTask, beforeSchedule.parentTask);
      const beforeClear = await stableTask(daily.operonId);
      assert.equal(beforeClear.parentTask === beforeSchedule.parentTask, false);
      const clearPreview = mutationStatus(
        await callMutation(
          "operon_update_periodic_scheduling",
          {
            operonId: daily.operonId,
            expectedRevision: beforeClear.revision,
            idempotencyKey: `${runId}:periodic-schedule:clear-preview`,
            dryRun: true,
            patch: { fields: { dateScheduled: null } },
          },
          "periodic scheduling clear preview",
        ),
        "periodic scheduling clear preview",
        "planned",
      );
      assert.equal(
        clearPreview.plan?.capability,
        "tasks.update.periodic-note.preview",
        "Operon did not project the additive periodic-update clear plan for the created Daily fixture.",
      );
      assert.equal(clearPreview.plan?.mutationKind, "task.update");
      assert.equal(clearPreview.plan?.planDigest, clearPreview.planDigest);
      const clearPlannedSourcePaths =
        await assertSafePlannedTaskSourceArtifacts(
          clearPreview.plan,
          "Periodic scheduling clear preview",
        );
      const beforeClearApply = await stableTask(daily.operonId);
      assert.equal(
        beforeClearApply.revision,
        beforeClear.revision,
        "The Daily fixture changed after periodic scheduling clear preview.",
      );
      await assertSafePlannedTaskSourceArtifacts(
        clearPreview.plan,
        "Periodic scheduling clear apply pre-dispatch",
      );
      const clearedResult = await callMutation(
        "operon_update_periodic_scheduling",
        {
          operonId: daily.operonId,
          expectedRevision: beforeClearApply.revision,
          idempotencyKey: `${runId}:periodic-schedule:clear`,
          dryRun: false,
          patch: { fields: { dateScheduled: null } },
        },
        "periodic scheduling clear",
      );
      await trackNativeTaskSourceArtifacts(
        clearedResult,
        "Periodic scheduling clear",
      );
      const cleared = mutationStatus(
        clearedResult,
        "periodic scheduling clear",
        "applied",
      );
      assert.equal(
        clearPlannedSourcePaths.has(cleared.after.path),
        true,
        "Periodic scheduling clear returned a source path not sealed by the pre-dispatch plan.",
      );
      await safeVaultRegularFile(
        cleared.after.path,
        "Periodic scheduling cleared source",
      );
      evidence.nativeProofs.push(
        assertNativeMutationProof(cleared, "periodic scheduling clear"),
      );
      assert.equal(cleared.after.path, sourceLocator.path);
      assert.equal(cleared.after.operonId, daily.operonId);
      assert.equal(Number.isInteger(cleared.after.line), true);
      assert.equal(cleared.after.dates.scheduled, null);
      assert.equal(cleared.after.parentTask, null);
      evidence.periodicScheduling = {
        fixtureKind: "daily",
        fixtureOperonIdHash: shortHash(daily.operonId),
        capabilityProjected: true,
        periodicParentProjected: true,
        initialParentTaskHash: shortHash(beforeSchedule.parentTask),
        setPreviewPlanDigestHash: shortHash(schedulePreview.planDigest),
        clearPreviewPlanDigestHash: shortHash(clearPreview.planDigest),
        set: true,
        clear: true,
        sourcePathPreserved: true,
        sourceIdentityPreserved: true,
        sourceLineShiftObserved:
          scheduled.after.line !== sourceLocator.line ||
          cleared.after.line !== sourceLocator.line,
        sourcePathHash: shortHash(sourceLocator.path),
      };

      const beforeConcurrent = await markdownInventory();
      const concurrentDescription = `Operon 3.5 concurrent periodic canary ${runId}`;
      const concurrentPeriodic = {
        description: concurrentDescription,
        periodicKind: "daily",
        routeDate: dates.concurrent,
        fields: { taskType: "canary-concurrent-periodic" },
      };
      // The direct Bridge route below intentionally tests HTTP same-key joining.
      // It must nevertheless receive the same physical containment gate as an
      // MCP mutation: a distinct non-mutating preview seals every task source.
      const concurrentPreview = mutationStatus(
        await callMutation(
          "operon_create_periodic_task",
          {
            idempotencyKey: `${runId}:bridge:periodic-concurrent:physical-preview`,
            dryRun: true,
            periodic: concurrentPeriodic,
          },
          "Bridge concurrency physical preview",
        ),
        "Bridge concurrency physical preview",
        "planned",
      );
      const concurrentPlannedSourcePaths =
        await assertSafePlannedTaskSourceArtifacts(
          concurrentPreview.plan,
          "Bridge concurrency physical preview",
        );
      assert.deepEqual(
        redactedInventoryChanges(
          inventoryDiff(beforeConcurrent, await markdownInventory()),
        ),
        [],
        "Bridge concurrency physical preview changed the vault inventory.",
      );
      const concurrentBody = JSON.stringify({
        idempotencyKey: `${runId}:bridge:periodic-concurrent`,
        dryRun: false,
        periodic: concurrentPeriodic,
      });
      const bridgeUrl = `${baseUrl}${BRIDGE_PREFIX}/tasks/periodic`;
      const bridgePost = async () => {
        // The two same-key calls are intentionally concurrent, but each HTTP
        // dispatch owns its own final physical and candidate re-attestation.
        // They are not treated as one atomic batch by this client process.
        await assertSafePlannedTaskSourceArtifacts(
          concurrentPreview.plan,
          "Bridge concurrency physical apply pre-dispatch",
        );
        await assertCandidateStillExact(candidate);
        await assertVaultRootStillSame("Bridge concurrency native apply");
        const response = await fetchWithAbortTimeout(
          bridgeUrl,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: concurrentBody,
          },
          "concurrent Bridge periodic POST",
          MUTATION_TIMEOUT_MS,
        );
        const payload = await response.json();
        return { status: response.status, payload };
      };
      const bridgeSettled = await Promise.allSettled([
        track(bridgePost()),
        track(bridgePost()),
      ]);
      for (const [index, settled] of bridgeSettled.entries()) {
        if (settled.status === "rejected") {
          evidence.mutationStatuses.push(
            mutationDiagnostic(
              null,
              `Bridge concurrency ${index === 0 ? "A" : "B"}`,
              {
                transportError: true,
                thrownMessage:
                  settled.reason instanceof Error
                    ? settled.reason.message
                    : String(settled.reason),
                thrownCode:
                  typeof settled.reason?.code === "string"
                    ? settled.reason.code
                    : undefined,
              },
            ),
          );
        }
      }
      const rejectedBridge = bridgeSettled.find(
        (settled) => settled.status === "rejected",
      );
      if (rejectedBridge) throw rejectedBridge.reason;
      const [bridgeA, bridgeB] = bridgeSettled.map((settled) => settled.value);
      evidence.mutationStatuses.push(
        {
          ...mutationDiagnostic(bridgeA.payload, "Bridge concurrency A"),
          httpStatus: bridgeA.status,
        },
        {
          ...mutationDiagnostic(bridgeB.payload, "Bridge concurrency B"),
          httpStatus: bridgeB.status,
        },
      );
      assert.equal(bridgeA.status, 200);
      assert.equal(bridgeB.status, 200);
      mutationStatus(bridgeA.payload, "Bridge concurrency A", "applied");
      evidence.nativeProofs.push(
        assertNativeMutationProof(bridgeA.payload, "Bridge concurrency A"),
      );
      assert.equal(bridgeB.payload.status, bridgeA.payload.status);
      assert.equal(
        bridgeB.payload.operationId,
        bridgeA.payload.operationId,
        "Concurrent Bridge responses returned different operationIds.",
      );
      const bridgeResultHash = sha256(JSON.stringify(bridgeA.payload));
      assert.equal(
        sha256(JSON.stringify(bridgeB.payload)),
        bridgeResultHash,
        "Concurrent Bridge responses returned different result bodies.",
      );
      const concurrentTask = bridgeA.payload.after;
      assert.equal(concurrentTask?.source, "inline");
      assert.equal(canonicalRelativeMarkdownPath(concurrentTask?.path), true);
      assert.equal(
        concurrentPlannedSourcePaths.has(concurrentTask.path),
        true,
        "Concurrent Bridge result source was not sealed by the physical pre-dispatch plan.",
      );
      await safeVaultRegularFile(
        concurrentTask.path,
        "Concurrent Bridge result source",
      );
      const afterConcurrent = await markdownInventory();
      const concurrentChanges = inventoryDiff(
        beforeConcurrent,
        afterConcurrent,
      );
      for (const change of concurrentChanges) {
        assert.equal(
          change.change,
          "created",
          "Concurrent Bridge request changed a pre-existing Markdown source.",
        );
        assert.equal(
          concurrentPlannedSourcePaths.has(change.path),
          true,
          "Concurrent Bridge request created a source not sealed by the physical pre-dispatch plan.",
        );
        await safeVaultRegularFile(
          change.path,
          "Concurrent Bridge created planned source",
        );
      }
      await recordRunOwnedArtifact(
        concurrentTask.path,
        "Concurrent Bridge periodic result",
      );
      assert.equal(beforeConcurrent.has(concurrentTask.path), false);
      assert.equal(
        concurrentChanges.some(
          (change) =>
            change.path === concurrentTask.path && change.change === "created",
        ),
        true,
      );
      const concurrentQuery = await call("operon_query_tasks", {
        search: concurrentDescription,
        pathIncludes: [concurrentTask.path],
        forceRefresh: true,
        limit: 100,
      });
      const exactConcurrentTasks = (concurrentQuery?.tasks ?? []).filter(
        (task) =>
          task.description === concurrentDescription &&
          task.path === concurrentTask.path,
      );
      assert.equal(
        exactConcurrentTasks.length,
        1,
        "Concurrent Bridge requests created more than one periodic task.",
      );
      assert.equal(
        exactConcurrentTasks[0].operonId,
        concurrentTask.operonId,
        "The single visible concurrent task does not match the Bridge result.",
      );
      evidence.bridgeConcurrency = {
        route: `${BRIDGE_PREFIX}/tasks/periodic`,
        httpStatuses: [bridgeA.status, bridgeB.status],
        sameOperationId: true,
        sameResult: true,
        exactVisibleTaskCount: exactConcurrentTasks.length,
        resultHash: bridgeResultHash,
        operationIdHash: shortHash(bridgeA.payload.operationId),
        operonIdHash: shortHash(concurrentTask.operonId),
        pathHash: shortHash(concurrentTask.path),
        markdownChanges: redactedInventoryChanges(concurrentChanges),
        restoredOnPass: false,
      };
      evidence.periodicCertification = {
        status: "certified",
        appliedOperations: periodicExecution.periodicApplyOperations,
        periodicApplyDispatched: periodicExecution.periodicApplyDispatched,
        periodicApplyDispatchCount:
          periodicExecution.periodicApplyDispatchCount,
      };
    }

    await validateZero("afterMutations");
    await pendingRecoveriesZero("afterMutations");

    await restoreAllCanaryArtifacts();
    assert.equal(fixtureRestored, true);
    const cleanupDeadline = Date.now() + 45_000;
    while (Date.now() < cleanupDeadline) {
      const query = await call("operon_query_tasks", {
        search: runId,
        forceRefresh: true,
        limit: 100,
      });
      if ((query?.tasks ?? []).length === 0) break;
      await sleep(750);
    }
    const restoredQuery = await call("operon_query_tasks", {
      search: runId,
      forceRefresh: true,
      limit: 100,
    });
    assert.equal((restoredQuery?.tasks ?? []).length, 0);
    await validateZero("afterArtifactRestore");
    await pendingRecoveriesZero("afterArtifactRestore");
    const finalSnapshot = await captureMarkdownSnapshot();
    assert.deepEqual(
      inventoryDiff(baselineSnapshot, finalSnapshot),
      [],
      "Markdown inventory drifted after Operon refreshed the restored artifacts.",
    );
    evidence.artifactRestoration.finalVerifiedAfterIndexRefresh = true;
    evidence.artifactRestoration.finalInventoryDigestHash = shortHash(
      inventoryDigest(finalSnapshot),
    );
    const registryDeadline = Date.now() + 45_000;
    let periodicRegistryAfter = await optionalFileState(PERIODIC_REGISTRY_PATH);
    while (
      !sameOptionalFileState(periodicRegistryBaseline, periodicRegistryAfter) &&
      Date.now() < registryDeadline
    ) {
      await sleep(750);
      periodicRegistryAfter = await optionalFileState(PERIODIC_REGISTRY_PATH);
    }
    assert.equal(
      sameOptionalFileState(periodicRegistryBaseline, periodicRegistryAfter),
      true,
      "Operon periodic container registry drifted after artifact restoration.",
    );
    evidence.periodicRegistryRestoration = {
      restored: true,
      expectedState: periodicRegistryBaseline.exists ? "present" : "absent",
      finalDigestHash: periodicRegistryAfter.exists
        ? shortHash(sha256(periodicRegistryAfter.content))
        : null,
    };
    for (const artifact of evidence.periodicCreates) {
      artifact.restoredOnPass = true;
    }
    if (evidence.periodicCertification.status === "certified") {
      evidence.bridgeConcurrency.restoredOnPass = true;
    }

    evidence.ok = true;
    evidence.completedAt = new Date().toISOString();
    success = true;
  } catch (error) {
    evidence.error = {
      name: error instanceof Error ? error.name : "Error",
      message: redactText(
        error instanceof Error ? error.message : error,
        apiKey,
      ),
    };
  } finally {
    const pending = [...activeRequests];
    if (pending.length > 0) {
      await withTimeout(
        Promise.allSettled(pending),
        "active MCP requests to settle before artifact restoration",
        MUTATION_TIMEOUT_MS + 10_000,
      ).catch((error) => {
        evidence.error ??= {
          name: "CleanupError",
          message: redactText(error.message, apiKey),
        };
      });
    }
    if (!evidence.artifactRestoration.restored || evidence.error) {
      await restoreAllCanaryArtifacts().catch((error) => {
        evidence.fixtureRestoration = {
          restored: false,
          expectedState: "absent",
          error: redactText(error.message, apiKey),
        };
        evidence.error ??= {
          name: "CleanupError",
          message: "Canary artifact restoration failed.",
        };
      });
    }
    await client?.close().catch(() => undefined);
    if (startupOrder && openedVaultCli) {
      try {
        const closed = await runCli(openedVaultCli, [
          `vault=${EXPECTED_VAULT_NAME}`,
          "eval",
          "code=window.close();'closing...'",
        ]);
        evidence.startupOrder.closeCliExitCode = closed.exitCode;
        await waitForLocalRestClosed();
        evidence.startupOrder.closedOnExit = true;
      } catch (error) {
        evidence.startupOrder.closedOnExit = false;
        evidence.error ??= {
          name: "CleanupError",
          message: redactText(error.message, apiKey),
        };
      }
    }
    evidence.ok = Boolean(
      success &&
        fixtureRestored &&
        evidence.artifactRestoration.restored &&
        evidence.periodicRegistryRestoration.restored &&
        !evidence.error,
    );
    evidence.completedAt ??= new Date().toISOString();
    evidence.fixtureRestoration.restored = fixtureRestored;
    if (shutdownSignal) evidence.interruptedBy = shutdownSignal;
    if (backendStderr) {
      evidence.backendDiagnosticHash = shortHash(
        redactText(backendStderr, apiKey),
      );
    }
    let backupDeletedOnPass = false;
    if (evidence.ok) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
        backupDeletedOnPass = true;
      } catch (error) {
        evidence.ok = false;
        evidence.error = {
          name: "CleanupError",
          message: "Private canary backup could not be deleted after success.",
        };
      }
    }
    if (evidence.preMutationInventory) {
      evidence.preMutationInventory.backupDeletedOnPass = backupDeletedOnPass;
      evidence.preMutationInventory.backupRetainedOnFailure = !evidence.ok;
    }
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  const summary = {
    ok: evidence.ok,
    evidenceFile,
    fixtureRestored,
    periodicArtifactsRetained: evidence.ok ? 0 : null,
    ...(evidence.ok ? {} : { backupRetainedAt: tempRoot }),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!evidence.ok) process.exitCode = 1;
}

const inspectPendingMode = process.argv.includes("--inspect-pending-live");
const offlineContractMode = process.argv.includes(
  "--offline-startup-order-contract",
);
const pathSafetyContractMode = process.argv.includes(
  "--offline-path-safety-contract",
);
assert.ok(
  [inspectPendingMode, offlineContractMode, pathSafetyContractMode].filter(
    Boolean,
  ).length <= 1,
  "Select only one canary mode.",
);
const selectedMain = inspectPendingMode
  ? inspectPendingLive
  : offlineContractMode
    ? offlineStartupOrderContract
    : pathSafetyContractMode
      ? offlinePathSafetyContract
      : main;

selectedMain().catch((error) => {
  if (inspectPendingMode) {
    const apiKey = (process.env.OBSIDIAN_API_KEY ?? "").trim();
    console.error(
      JSON.stringify({
        count: null,
        recoveries: [],
        errorHash: shortHash(
          redactText(
            error instanceof Error ? error.message : String(error),
            apiKey,
          ),
        ),
      }),
    );
    process.exitCode = 1;
    return;
  }
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      note: offlineContractMode
        ? "The deterministic offline startup-order contract failed."
        : pathSafetyContractMode
          ? "The deterministic offline path-safety contract failed."
          : "The canary refused before its guarded live workflow started.",
    }),
  );
  process.exitCode = 1;
});
