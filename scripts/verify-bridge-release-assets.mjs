import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rootPackage = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
const name = `optimike-bridge-bundle-v${rootPackage.version}`;
const releaseRoot = path.join(repositoryRoot, "out", "bridge-release");
const zipPath = path.join(releaseRoot, `${name}.zip`);
const manifestPath = path.join(releaseRoot, `${name}.manifest.json`);
const checksumPath = path.join(releaseRoot, "SHA256SUMS");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const hash = (filePath) =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

assert.ok(statSync(zipPath).size > 0, "Bridge bundle zip is empty.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.bundle.version, rootPackage.version);
assert.equal(manifest.bundle.sourceCommit, sourceCommit);
assert.deepEqual(manifest.bridges.map((bridge) => bridge.id).sort(), [
  "obsidian-atomic-write-bridge",
  "obsidian-bases-bridge",
  "optimike-operon-bridge",
]);
const expectedLines = [zipPath, manifestPath].map(
  (filePath) => `${hash(filePath)}  ${path.basename(filePath)}`,
);
const actualLines = readFileSync(checksumPath, "utf8").trim().split(/\r?\n/u);
assert.deepEqual(actualLines, expectedLines);

console.log(
  `PASS: Bridge release assets bind ${rootPackage.version} to ${sourceCommit}`,
);
