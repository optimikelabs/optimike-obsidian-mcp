#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const read = (file) => readFile(file, "utf8");
const tools = [
  "obsidian_frontmatter_patch_plan",
  "obsidian_frontmatter_patch_apply",
  "obsidian_frontmatter_patch_status",
  "obsidian_frontmatter_patch_recover",
];

const [
  toolSurface,
  matrix,
  matrixFr,
  contract,
  contractFr,
  security,
  securityFr,
  operations,
  operationsFr,
  changelog,
  adr,
  adrIndex,
  liveCanary,
] = await Promise.all([
  read("docs/obsidian_mcp_tools_spec.md"),
  read("docs/runtime-capability-matrix.md"),
  read("docs/runtime-capability-matrix.fr.md"),
  read("docs/governed-frontmatter-p1.md"),
  read("docs/governed-frontmatter-p1.fr.md"),
  read("SECURITY.md"),
  read("SECURITY.fr.md"),
  read("OPERATIONS.md"),
  read("OPERATIONS.fr.md"),
  read("CHANGELOG.md"),
  read("docs/adr/ADR-Governed-Frontmatter-P1.md"),
  read("docs/adr/README.md"),
  read("scripts/smoke-governed-frontmatter-live.mjs"),
]);
const pkg = JSON.parse(await read("package.json"));

for (const tool of tools) {
  for (const [name, content] of [
    ["tool surface", toolSurface],
    ["runtime matrix", matrix],
    ["French runtime matrix", matrixFr],
    ["P1 contract", contract],
    ["French P1 contract", contractFr],
    ["changelog", changelog],
  ]) {
    assert.ok(content.includes(`\`${tool}\``), `${name} omits ${tool}`);
  }
}

assert.match(contract, /actualDiff\(before, after\)/);
assert.match(contractFr, /actualDiff\(before, after\)/);
assert.match(contract, /not undo/i);
assert.match(contractFr, /pas un undo|ce n[’']est pas un undo/i);
assert.match(contract, /cache is never an authority/i);
assert.match(contractFr, /cache n[’']est jamais une autorité/i);
assert.match(contract, /byte-identical/i);
assert.match(contractFr, /byte-identical/i);
assert.match(contract, /P1 canary recovery directory|OBSIDIAN_FRONTMATTER_CANARY_PATH/i);
assert.match(contractFr, /OBSIDIAN_FRONTMATTER_CANARY_PATH/i);
assert.match(security, /governed frontmatter/i);
assert.match(securityFr, /Frontmatter gouvernée|frontmatter gouvernée/i);
assert.match(operations, /governed frontmatter/i);
assert.match(operationsFr, /Frontmatter gouvernée|frontmatter gouvernée/i);
assert.match(adr, /Executor/);
assert.match(adr, /Reconciler/);
assert.match(adr, /Observer/);
assert.match(adr, /Failure matrix/);
assert.match(adr, /Linearization points/);
assert.match(adr, /actualDiff\(before, after\)/);
assert.match(adrIndex, /P1 governed frontmatter projection/);

for (const file of [
  "docs/governed-frontmatter-p1.md",
  "docs/governed-frontmatter-p1.fr.md",
  "docs/adr/ADR-Governed-Frontmatter-P1.md",
]) {
  assert.ok(pkg.files.includes(file), `package files omit ${file}`);
}
assert.equal(
  pkg.scripts["test:governed-frontmatter"],
  "npm run build && node scripts/test-governed-frontmatter-model.mjs && node scripts/test-frontmatter-p1-compiler.mjs && node scripts/test-governed-frontmatter-mcp.mjs && node scripts/test-governed-frontmatter-http.mjs",
);
assert.equal(
  pkg.scripts["smoke:governed-frontmatter-live"],
  "npm run build && node scripts/smoke-governed-frontmatter-live.mjs",
);
assert.match(pkg.scripts["test:docs"], /test-governed-frontmatter-doc-contract/);

for (const file of [
  "scripts/test-governed-frontmatter-model.mjs",
  "scripts/test-frontmatter-p1-compiler.mjs",
  "scripts/test-governed-frontmatter-mcp.mjs",
  "scripts/test-governed-frontmatter-http.mjs",
  "scripts/smoke-governed-frontmatter-live.mjs",
]) {
  await access(file);
}

assert.match(liveCanary, /os\.tmpdir\(\)/);
assert.match(liveCanary, /P1 canary recovery directory:/);
assert.match(liveCanary, /writeFileSync\(backupPath/);
assert.match(liveCanary, /emergency-restore/);
assert.match(liveCanary, /restored = true/);
assert.match(liveCanary, /rmSync\(tempRoot/);
assert.doesNotMatch(liveCanary, /path\.join\(process\.cwd\(\), ["']\.tmp["']\)/);
assert.match(
  changelog,
  /## \[Unreleased\][\s\S]*obsidian_frontmatter_patch_plan/,
);

console.log(
  "PASS: governed frontmatter P1 docs, package surface, authority model, live-canary boundary, and bilingual contracts are coherent",
);
