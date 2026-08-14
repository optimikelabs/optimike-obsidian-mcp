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
assert.equal(pkg.version, "2.7.0");

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
assert.match(contract, /not\s+undo/i);
assert.match(contractFr, /pas\s+un\s+undo|ce\s+n[’']est\s+pas\s+un\s+undo/i);
assert.match(contract, /cache is never an authority/i);
assert.match(contractFr, /cache n[’']est jamais une autorité/i);
assert.match(contract, /byte-identical/i);
assert.match(contractFr, /byte-identical/i);
assert.match(
  contract,
  /P1 canary recovery directory|OBSIDIAN_FRONTMATTER_CANARY_PATH/i,
);
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
assert.match(adr, /Accepted, implemented, and prepared for release in `2\.7\.0`/);
assert.match(adr, /Live admission passed[\s\S]*2026-08-14/i);
assert.match(
  adr,
  /445a4ebc-fce6-4199-b0e8-5f93dcfeac9d[\s\S]*original and final SHA-256 were both[\s\S]*5492f80849812193137d8ef66b4349982d8a443503e555f8cd188efe99980912/i,
);
assert.match(contract, /Live admission passed[\s\S]*status-credential redaction/i);
assert.match(contractFr, /admission live a réussi[\s\S]*expurgation de la clé d.exécution dans status/i);
assert.match(contract, /fixed bounded marker/i);
assert.match(contractFr, /marqueur fixe et borné/i);
assert.match(
  contract,
  /targeted entries containing direct or[\s\S]*nested block scalars or multiline quoted scalars/i,
);
assert.match(
  contractFr,
  /entrées ciblées contenant des[\s\S]*scalaires de bloc directs ou imbriqués ou des scalaires quotés multilignes/i,
);
assert.match(
  adr,
  /targeted entries containing direct or nested YAML block scalars or multiline[\s\S]*quoted scalars/i,
);
assert.match(contract, /total code-unit order[\s\S]*intent[\s\S]*proof/i);
assert.match(contractFr, /ordre total des unités de code/i);
assert.match(adr, /intent and patch-proof digests[\s\S]*code-unit ordering/i);
assert.match(contract, /well-formed Unicode[\s\S]*NOT_FOUND/i);
assert.match(contractFr, /Unicode bien formées[\s\S]*NOT_FOUND/i);
assert.match(adr, /well-formed Unicode[\s\S]*NOT_FOUND/i);
assert.match(contract, /Projected child plans[\s\S]*public P0[\s\S]*NOT_FOUND/i);
assert.match(
  contract,
  /Status receipts never expose[\s\S]*public idempotency key[\s\S]*internal[\s\S]*apply authority/i,
);
assert.match(contract, /reserved projection namespace[\s\S]*P0 and P1/i);
assert.match(
  contractFr,
  /child plans projetés[\s\S]*outils P0 publics[\s\S]*NOT_FOUND/i,
);
assert.match(
  contractFr,
  /reçus de status n.exposent ni la clé d.idempotence publique ni la clé[\s\S]*interne[\s\S]*autorité d.apply/i,
);
assert.match(contractFr, /namespace de projection[\s\S]*appelants P0 et P1/i);
assert.match(adr, /Projected child plans[\s\S]*public P0/i);
assert.match(
  adr,
  /Status receipts omit both the public idempotency key[\s\S]*internal[\s\S]*apply\s+authority/i,
);
assert.match(adr, /reserved prefix[\s\S]*authority domains/i);
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
  "npm run build && node scripts/test-governed-frontmatter-model.mjs && node scripts/test-frontmatter-p1-compiler.mjs && node scripts/test-frontmatter-p1-idempotency.mjs && node scripts/test-governed-frontmatter-mcp.mjs && node scripts/test-governed-frontmatter-http.mjs",
);
assert.equal(
  pkg.scripts["smoke:governed-frontmatter-live"],
  "npm run build && node scripts/smoke-governed-frontmatter-live.mjs",
);
assert.match(
  pkg.scripts["test:docs"],
  /test-governed-frontmatter-doc-contract/,
);

for (const file of [
  "scripts/test-governed-frontmatter-model.mjs",
  "scripts/test-frontmatter-p1-compiler.mjs",
  "scripts/test-frontmatter-p1-idempotency.mjs",
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
assert.match(
  liveCanary,
  /transientLogsParent[\s\S]*process\.cwd\(\)[\s\S]*["']logs["'][\s\S]*mkdtempSync/,
);
assert.match(liveCanary, /renameSync\(logsPath, retainedLogsPath\)/);
assert.doesNotMatch(
  liveCanary,
  /const logsPath = path\.join\(tempRoot, ["']logs["']\)/,
);
assert.doesNotMatch(
  liveCanary,
  /path\.join\(process\.cwd\(\), ["']\.tmp["']\)/,
);
const changelogHeadings = [
  ...changelog.matchAll(/^## \[([^\]]+)\](?: - .*?)?$/gm),
];
function changelogSection(version) {
  const headingIndex = changelogHeadings.findIndex(
    (heading) => heading[1] === version,
  );
  assert.notEqual(headingIndex, -1, `missing changelog section ${version}`);
  const start = changelogHeadings[headingIndex].index;
  const end = changelogHeadings[headingIndex + 1]?.index ?? changelog.length;
  return changelog.slice(start, end);
}

assert.match(changelog, /^## \[2\.7\.0\] - 2026-08-14$/m);
const releaseSection = changelogSection("2.7.0");
const unreleasedSection = changelogSection("Unreleased");
for (const tool of tools) {
  assert.ok(
    releaseSection.includes(`\`${tool}\``),
    `2.7.0 changelog section omits ${tool}`,
  );
  assert.ok(
    !unreleasedSection.includes(`\`${tool}\``),
    `${tool} must belong to 2.7.0, not Unreleased`,
  );
}

console.log(
  "PASS: governed frontmatter P1 docs, package surface, authority model, live-canary boundary, and bilingual contracts are coherent",
);
