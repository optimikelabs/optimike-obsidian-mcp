import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const outputParent = path.join(repositoryRoot, "out", "bridge-bundle");
const repositoryUrl = "https://github.com/optimikelabs/optimike-obsidian-mcp";
const managedFiles = ["main.js", "manifest.json", "styles.css"];
const bridgeDefinitions = [
  {
    id: "optimike-operon-bridge",
    directory: "plugins/obsidian-operon-bridge",
  },
  {
    id: "obsidian-atomic-write-bridge",
    directory: "plugins/obsidian-atomic-write-bridge",
  },
  {
    id: "obsidian-bases-bridge",
    directory: "plugins/obsidian-bases-bridge",
  },
];
const installerFiles = [
  "install-bridge-bundle.mjs",
  "install-bridge-bundle.ps1",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertChild(parent, candidate, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must remain below ${parent}`);
  }
}

function assertRegularUnaliasedFile(filePath) {
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(
      `Bundle source is not a regular unaliased file: ${filePath}`,
    );
  }
}

function copyAndDescribe(sourcePath, destinationPath, relativePath) {
  assertRegularUnaliasedFile(sourcePath);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  const content = readFileSync(destinationPath);
  return {
    path: relativePath.replaceAll(path.sep, "/"),
    sha256: sha256(content),
    size: content.byteLength,
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertCleanCommit() {
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status) {
    throw new Error(
      "Refusing to attest a Bridge bundle from a dirty worktree, including untracked inputs.",
    );
  }
  const commit = git("rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Git did not return a canonical 40-character commit SHA.");
  }
  return commit;
}

function buildBundle() {
  const rootPackage = readJson(path.join(repositoryRoot, "package.json"));
  const sourceCommit = assertCleanCommit();
  const sourceCommittedAt = git("show", "-s", "--format=%cI", sourceCommit);
  const bundleDirectoryName = `optimike-bridge-bundle-v${rootPackage.version}`;
  const outputRoot = path.join(outputParent, bundleDirectoryName);
  assertChild(outputParent, outputRoot, "Bundle output");
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const installers = installerFiles.map((name) => {
    const source = path.join(repositoryRoot, "scripts", name);
    const destination = path.join(outputRoot, name);
    return copyAndDescribe(source, destination, name);
  });

  const bridges = bridgeDefinitions.map((definition) => {
    const sourceDirectory = path.join(repositoryRoot, definition.directory);
    const buildDirectory = path.join(sourceDirectory, "build");
    const bridgePackage = readJson(path.join(sourceDirectory, "package.json"));
    const sourceManifest = readJson(
      path.join(sourceDirectory, "manifest.json"),
    );
    const builtManifest = readJson(path.join(buildDirectory, "manifest.json"));
    if (
      sourceManifest.id !== definition.id ||
      bridgePackage.version !== sourceManifest.version ||
      builtManifest.id !== definition.id ||
      builtManifest.version !== sourceManifest.version ||
      builtManifest.main !== "main.js"
    ) {
      throw new Error(`Bridge manifest mismatch for ${definition.id}`);
    }

    const buildEntries = readdirSync(buildDirectory, { withFileTypes: true });
    const unexpected = buildEntries
      .filter((entry) => !entry.isFile() || !managedFiles.includes(entry.name))
      .map((entry) => entry.name);
    if (unexpected.length > 0) {
      throw new Error(
        `Unexpected build artifacts for ${definition.id}: ${unexpected.join(", ")}`,
      );
    }
    for (const required of ["main.js", "manifest.json"]) {
      if (!buildEntries.some((entry) => entry.name === required)) {
        throw new Error(`Missing ${required} for ${definition.id}`);
      }
    }

    const files = buildEntries
      .map((entry) => entry.name)
      .sort()
      .map((name) => {
        const relativePath = path.join("bridges", definition.id, name);
        return copyAndDescribe(
          path.join(buildDirectory, name),
          path.join(outputRoot, relativePath),
          relativePath,
        );
      });
    return {
      id: definition.id,
      version: sourceManifest.version,
      files,
    };
  });

  const manifest = {
    schemaVersion: 1,
    bundle: {
      name: "optimike-bridge-bundle",
      version: rootPackage.version,
      repository: repositoryUrl,
      sourceCommit,
      sourceCommittedAt,
    },
    installers,
    bridges,
  };
  const manifestPath = path.join(outputRoot, "bridge-bundle.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const artifactCount =
    1 +
    installers.length +
    bridges.reduce((sum, bridge) => sum + bridge.files.length, 0);
  const actualCount = readdirSync(outputRoot, { recursive: true }).filter(
    (entry) => {
      const fullPath = path.join(outputRoot, entry);
      return statSync(fullPath).isFile();
    },
  ).length;
  if (actualCount !== artifactCount) {
    throw new Error(
      `Bundle allowlist mismatch: expected ${artifactCount} files, found ${actualCount}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      bundleDirectory: outputRoot,
      manifestPath,
      sourceCommit,
      bundleVersion: rootPackage.version,
      bridgeCount: bridges.length,
      artifactCount,
    })}\n`,
  );
}

buildBundle();
