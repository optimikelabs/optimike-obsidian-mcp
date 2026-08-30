#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [english, french, canary, packageJson] = await Promise.all([
  readFile(new URL("../docs/bridge-lifecycle.md", import.meta.url), "utf8"),
  readFile(new URL("../docs/bridge-lifecycle.fr.md", import.meta.url), "utf8"),
  readFile(
    new URL("./smoke-bridge-lifecycle-live.mjs", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
]);

for (const [label, document] of [
  ["English", english],
  ["French", french],
]) {
  assert.match(document, /250 ms/u, `${label} guide omits initial retry.`);
  assert.match(document, /5 second|5 secondes/u, `${label} guide omits cap.`);
  assert.match(document, /mountGeneration/u);
  assert.match(document, /unloadGeneration/u);
  assert.match(document, /degraded/u);
  assert.match(document, /partial|partiel/u);
  assert.match(document, /terminated|terminé/u);
  assert.match(document, /I_CONFIRM_PILOT_2_LOCAL_REST_RELOAD/u);
  assert.match(document, /temporary|temporaire/u);
  assert.doesNotMatch(document, /\.tmp\//u);
}

for (const required of [
  "disablePlugin('obsidian-local-rest-api')",
  "enablePlugin('obsidian-local-rest-api')",
  "sameMcpClient",
  "writeProjection",
  "git status",
]) {
  assert.equal(canary.includes(required), true, `Canary omits ${required}.`);
}

const parsedPackage = JSON.parse(packageJson);
assert.equal(
  parsedPackage.scripts["smoke:bridge-lifecycle-live"],
  "node scripts/smoke-bridge-lifecycle-live.mjs",
);
assert.equal(parsedPackage.files.includes("docs/bridge-lifecycle.md"), true);
assert.equal(parsedPackage.files.includes("docs/bridge-lifecycle.fr.md"), true);

console.log(
  "PASS: Bridge lifecycle documentation and canary contract are aligned",
);
