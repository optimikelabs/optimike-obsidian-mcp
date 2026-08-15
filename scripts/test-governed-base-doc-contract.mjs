#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = [
  "README.md",
  "OPERATIONS.md",
  "OPERATIONS.fr.md",
  "docs/governed-base-formula-p2.md",
  "docs/governed-base-formula-p2.fr.md",
  "plugins/obsidian-bases-bridge/README.md",
].map((path) => [path, readFileSync(path, "utf8")]);
const joined = files.map(([path, content]) => `${path}\n${content}`).join("\n");
const releaseAdr = readFileSync(
  "docs/adr/ADR-Governed-Base-Formula-P2.md",
  "utf8",
);
const changelog = readFileSync("CHANGELOG.md", "utf8");

for (const tool of [
  "bases_formula_patch_plan",
  "bases_formula_patch_apply",
  "bases_formula_patch_status",
  "bases_formula_patch_recover",
]) {
  assert.match(joined, new RegExp(tool, "u"), `${tool} missing from P2 docs`);
}
for (const invariant of [
  "Vault.process",
  "SHA-256",
  "disabled by default",
  "désactivé",
  "PROJETS.base",
  "Operon Bridge pilot vault",
  "coffre pilote Operon Bridge",
]) {
  assert.equal(
    joined.includes(invariant),
    true,
    `P2 documentation invariant missing: ${invariant}`,
  );
}
for (const invariant of [
  /complete\s+sealed next YAML/u,
  /YAML\s+suivant complet et scellé/u,
  /no final line\s+ending/u,
  /sans saut de ligne final/u,
]) {
  assert.match(
    joined,
    invariant,
    `P2 documentation invariant missing: ${invariant}`,
  );
}
assert.match(joined, /legacy whole-file config writes are default-off/u);
assert.match(joined, /ne peuvent plus contourner silencieusement/u);
assert.doesNotMatch(
  joined,
  /generic public operation API is (?:available|exposed)/iu,
  "P2 must not claim a generic public operation surface",
);
assert.match(releaseAdr, /Accepted, implemented and released in `2\.8\.0`/u);
assert.match(releaseAdr, /post-merge Windows\/Linux Runtime workflow passed/u);
assert.match(changelog, /## \[2\.8\.0\] - 2026-08-15/u);
assert.match(
  changelog,
  /Governed state-changing\s+HTTP calls use mutation backpressure/u,
);

console.log(
  "PASS: governed Base P2 documentation matches the bounded CAS and pilot-vault contract",
);
