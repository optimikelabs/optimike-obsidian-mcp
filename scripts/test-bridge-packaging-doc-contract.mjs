import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(file, "utf8");
const rootPackage = JSON.parse(read("package.json"));
const english = read("docs/bridge-packaging.md");
const french = read("docs/bridge-packaging.fr.md");
const installer = read("scripts/install-bridge-bundle.mjs");
const builder = read("scripts/build-bridge-bundle.mjs");
const archive = read("scripts/archive-bridge-bundle.ps1");
const workflow = read(".github/workflows/bridge-packaging-p3.yml");
const liveCanary = read("scripts/smoke-bridge-packaging-live.mjs");

assert.equal(rootPackage.version, "3.5.0");
for (const script of [
  "build:bridge-bundle",
  "archive:bridge-bundle",
  "package:bridge-bundle",
  "test:bridge-package",
  "smoke:bridge-package-live",
]) {
  assert.ok(rootPackage.scripts[script], `Missing package script ${script}`);
}
for (const file of [
  "docs/bridge-packaging.md",
  "docs/bridge-packaging.fr.md",
]) {
  assert.ok(rootPackage.files.includes(file), `Missing package file ${file}`);
}
for (const source of [english, french]) {
  assert.match(source, /SHA256SUMS/);
  assert.match(source, /data\.json/);
  assert.match(source, /obsidian_runtime_status/);
  assert.match(source, /backupPath/);
  assert.match(source, /applying/);
  assert.match(source, /rollback_in_progress/);
  assert.match(source, /40/);
}
assert.match(builder, /status", "--porcelain", "--untracked-files=no"/);
assert.match(builder, /sourceCommit/);
assert.match(builder, /artifactCount/);
assert.doesNotMatch(
  builder.match(/const managedFiles = \[[^\]]+\]/s)?.[0] ?? "",
  /data\.json/,
);
assert.match(installer, /Bundle must never contain data\.json/);
assert.match(installer, /explicit confirmation that Obsidian is closed/);
assert.match(installer, /Rollback fence rejected/);
assert.match(installer, /manual_recovery_required/);
assert.match(installer, /rollback_in_progress/);
assert.match(installer, /processIsAlive/);
assert.match(archive, /Compress-Archive/);
assert.match(archive, /SHA256SUMS/);
assert.match(workflow, /ubuntu-latest/);
assert.match(workflow, /windows-latest/);
assert.match(workflow, /npm run test:bridge-package/);
assert.match(workflow, /npm run package:bridge-bundle/);
const rollbackCheckpoint = liveCanary.indexOf("evidence.rollback = true");
const reinstallCheckpoint = liveCanary.indexOf(
  "secondReceipt = install",
  rollbackCheckpoint,
);
assert.ok(rollbackCheckpoint > 0 && reinstallCheckpoint > rollbackCheckpoint);
assert.doesNotMatch(
  liveCanary.slice(rollbackCheckpoint, reinstallCheckpoint),
  /openPilot/,
  "Pilot 2 must not observe the downgraded Bridge between rollback and reinstall",
);

console.log(
  "PASS: Bridge packaging docs, release scripts, privacy boundary and Windows/Linux gate remain aligned",
);
