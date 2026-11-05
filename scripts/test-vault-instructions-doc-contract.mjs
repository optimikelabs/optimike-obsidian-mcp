#!/usr/bin/env node

// Contract of the vault instructions documentation: both guides ship in the
// npm package, and the guides, README and CHANGELOG state what the feature
// proves and where it refuses, without the absolute promises it cannot keep.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (file) => readFileSync(file, "utf8");
const pkg = JSON.parse(read("package.json"));

for (const guide of ["docs/vault-instructions.md", "docs/vault-instructions.fr.md"]) {
  assert.ok(existsSync(guide), `${guide} exists`);
  assert.ok(pkg.files.includes(guide), `the npm package ships ${guide}`);
}
assert.match(pkg.scripts["test:vault-instructions"], /test-vault-instructions-regressions\.mjs/u);
assert.match(pkg.scripts["test:vault-instructions"], /test-vault-instructions-doc-contract\.mjs/u);

const en = read("docs/vault-instructions.md");
const fr = read("docs/vault-instructions.fr.md");
const changelog = read("CHANGELOG.md");
const unreleased = changelog.slice(changelog.indexOf("## [3.19.0]"), changelog.indexOf("## [3.18.0]"));

// No absolute promise for vaults without instruction files.
assert.doesNotMatch(en, /sees no difference/u);
assert.doesNotMatch(fr, /ne voit aucune différence/u);
assert.doesNotMatch(unreleased, /A vault without instruction files, or `off`, behaves exactly as before/u);
assert.match(en, /## What changes in a vault without instruction files/u);
assert.match(fr, /## Ce qui change dans un coffre sans fichier d’instructions/u);
for (const text of [en, fr]) {
  for (const code of ["vault_instructions_target_unresolved", "vault_instructions_plan_unsealed", "seal_journal", "too_large", "invalid_response"]) {
    assert.ok(text.includes(code), `guide documents ${code}`);
  }
}

// What is proven: instructions received before writing, not respected.
assert.match(en, /the agent received the applicable instructions, in their current version, before it wrote/u);
assert.match(en, /does not prove that the model follows them/u);
assert.match(fr, /l’agent a reçu les consignes applicables, dans leur version actuelle, avant d’écrire/u);
assert.match(fr, /ne prouve ni que le modèle les respecte/u);
assert.match(unreleased, /received the instructions before writing, not that it follows them/u);

// Trust boundary and symbolic links.
assert.match(en, /## Trust boundary/u);
assert.match(en, /gains no authority over the instructions of the user or of the host/u);
assert.match(en, /symbolic link[^.]*counts as absent/u);
assert.match(fr, /## Frontière de confiance/u);
assert.match(fr, /n’acquiert aucune autorité sur les instructions de l’utilisateur ou de l’hôte/u);
assert.match(fr, /lien symbolique[^.]*compte comme absent/u);

// Bounds that are really enforced.
assert.match(en, /\| One instruction file \| 256 KiB/u);
assert.match(fr, /\| Un fichier d’instructions \| 256 Kio/u);
assert.match(en, /\| Probes in flight for the whole backend process \| 8 \|/u);

// The real targets.
assert.match(en, /affectedPaths/u);
assert.match(fr, /affectedPaths/u);
assert.match(en, /creation\.fileTasksFolder/u);
assert.match(fr, /creation\.fileTasksFolder/u);
assert.match(en, /NFD/u);
assert.match(fr, /NFD/u);

// README wording.
assert.match(read("README.md"), /the server proves they were served, not that they are followed/u);
assert.match(read("README.fr.md"), /le serveur prouve qu’ils ont été servis, pas qu’ils sont respectés/u);

console.log("vault instructions doc contract passed");
