#!/usr/bin/env node

import assert from "node:assert/strict";
import { compileBaseFormulaPatch } from "../dist/services/baseConfigPatchCompiler.js";

const fixture = [
  "filters:",
  "  and:",
  '    - collection.contains(link("Projets"))',
  "formulas:",
  "  projet: link(file, file.name)",
  "  statut_score: |",
  "    if(",
  '      statut == "actif", 4, 0',
  "    )",
  "",
  "properties:",
  "  projet:",
  "    kind: formula",
  "views:",
  "  - type: table",
  "    name: Projets – Pipeline",
  "    groupBy:",
  "      property: parent",
  "      direction: ASC",
  "",
].join("\r\n");

const compiled = compileBaseFormulaPatch(fixture, [
  {
    op: "set_formula",
    name: "statut_score",
    expression: 'if(statut == "actif", 5, 0)',
  },
  {
    op: "set_formula",
    name: "next_action_ok",
    expression: "next_action != null",
  },
  { op: "delete_formula", name: "projet" },
]);

assert.equal(compiled.proof.lineEnding, "crlf");
assert.deepEqual(compiled.proof.changedFormulas, [
  "next_action_ok",
  "projet",
  "statut_score",
]);
assert.match(compiled.nextYaml, /  next_action_ok: "next_action != null"\r\n/u);
assert.match(
  compiled.nextYaml,
  /  statut_score: "if\(statut == \\"actif\\", 5, 0\)"\r\n/u,
);
assert.doesNotMatch(compiled.nextYaml, /  projet: link\(file, file\.name\)/u);
assert.equal(
  compiled.nextYaml.slice(compiled.nextYaml.indexOf("properties:")),
  fixture.slice(fixture.indexOf("properties:")),
  "untargeted properties and views must remain byte-identical",
);
assert.equal(
  compiled.proof.sourcePreservation,
  "byte-identical-outside-authorized-base-ranges",
);

const sameA = compileBaseFormulaPatch(fixture, [
  { op: "set_formula", name: "b", expression: "2" },
  { op: "set_formula", name: "a", expression: "1" },
]);
const sameB = compileBaseFormulaPatch(fixture, [
  { op: "set_formula", name: "a", expression: "1" },
  { op: "set_formula", name: "b", expression: "2" },
]);
assert.equal(sameA.nextYaml, sameB.nextYaml);
assert.equal(sameA.proof.patchDigest, sameB.proof.patchDigest);

const casingPreserved = compileBaseFormulaPatch(
  "formulas:\n  StatusScore: old\nviews: []\n",
  [{ op: "set_formula", name: "statusscore", expression: "new" }],
);
assert.match(casingPreserved.nextYaml, /  StatusScore: "new"\n/u);
assert.doesNotMatch(casingPreserved.nextYaml, /  statusscore:/u);

const nullFormulaDeleted = compileBaseFormulaPatch(
  "formulas:\n  keep: value\n  nullable: null\nviews: []\n",
  [{ op: "delete_formula", name: "nullable" }],
);
assert.doesNotMatch(nullFormulaDeleted.nextYaml, /nullable/u);

for (const eol of ["\n", "\r\n"]) {
  const withoutFinalEol = ["formulas:", "  existing: value"].join(eol);
  const appended = compileBaseFormulaPatch(withoutFinalEol, [
    { op: "set_formula", name: "added", expression: "next" },
  ]);
  assert.equal(
    appended.nextYaml,
    `${withoutFinalEol}${eol}  added: "next"${eol}`,
    `formula additions must be line-separated for ${JSON.stringify(eol)} files without a final EOL`,
  );
}

for (const { header, blockTail } of [
  { header: "|", blockTail: "     # literal formula text\n" },
  { header: "|+", blockTail: "    value\n\n" },
]) {
  const blockSource = `formulas:\n  a: ${header}\n${blockTail}views: []\n`;
  const blockAppend = compileBaseFormulaPatch(blockSource, [
    { op: "set_formula", name: "b", expression: "next" },
  ]);
  assert.equal(
    blockAppend.nextYaml,
    `formulas:\n  a: ${header}\n${blockTail}  b: "next"\nviews: []\n`,
    "formula additions must append after every parser-owned block-scalar byte",
  );
}

const scalarIndicators = compileBaseFormulaPatch(
  [
    "formulas:",
    '  quoted: "text &anchor *alias !tag <<: and # content"',
    "  block: |",
    "    text &anchor *alias !tag <<: and # content",
    '  plain_comparison: statut != "actif"',
    "# comment &anchor *alias !tag <<:",
    "views: []",
    "",
  ].join("\n"),
  [{ op: "set_formula", name: "quoted", expression: "a && !done" }],
);
assert.match(scalarIndicators.nextYaml, /a && !done/u);
assert.match(
  scalarIndicators.nextYaml,
  /text &anchor \*alias !tag <<: and # content/u,
  "block scalar and comment indicators must remain ordinary source text",
);
function reason(operation) {
  try {
    operation();
    assert.fail("Expected fail-closed compilation.");
  } catch (error) {
    return error?.details?.reason ?? error?.message;
  }
}

assert.equal(
  reason(() =>
    compileBaseFormulaPatch(
      [
        "formulas:",
        '  quoted: "first',
        '    b: bar"',
        "  keep: value",
        "",
      ].join("\n"),
      [{ op: "set_formula", name: "keep", expression: "next" }],
    ),
  ),
  "base_formula_layout_unsupported",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch(
      'metadata: unmatched"\nreal: &anchor value\nformulas:\n  keep: value\n',
      [{ op: "set_formula", name: "keep", expression: "next" }],
    ),
  ),
  "base_yaml_reference_unsupported",
);

assert.equal(
  reason(() =>
    compileBaseFormulaPatch("views: []\n", [
      { op: "set_formula", name: "a", expression: "1" },
    ]),
  ),
  "base_formulas_mapping_ambiguous",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch("formulas: &shared\n  a: 1\n", [
      { op: "set_formula", name: "a", expression: "2" },
    ]),
  ),
  "base_yaml_reference_unsupported",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch(
      "shared: &shared value\nformulas:\n  a: *shared\n",
      [{ op: "set_formula", name: "a", expression: "2" }],
    ),
  ),
  "base_yaml_reference_unsupported",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch("formulas:\n  a: !!str value\n", [
      { op: "set_formula", name: "a", expression: "2" },
    ]),
  ),
  "base_yaml_extension_unsupported",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch(
      "formulas:\n  <<: { inherited: value }\n  keep: 2\n",
      [{ op: "set_formula", name: "keep", expression: "3" }],
    ),
  ),
  "base_yaml_extension_unsupported",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch(
      "defaults: &defaults\n  a: 1\nformulas:\n  <<: *defaults\n  keep: 2\n",
      [{ op: "set_formula", name: "keep", expression: "3" }],
    ),
  ),
  "base_yaml_reference_unsupported",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch("formulas:\n  A: 1\n  a: 2\n", [
      { op: "set_formula", name: "a", expression: "3" },
    ]),
  ),
  "duplicate_base_formula",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch(fixture, [
      { op: "delete_formula", name: "missing" },
    ]),
  ),
  "base_formula_not_found",
);
assert.equal(
  reason(() =>
    compileBaseFormulaPatch("formulas:\n  only: value\n", [
      { op: "delete_formula", name: "only" },
    ]),
  ),
  "base_last_formula_delete_unsupported",
);

console.log(
  "PASS: P2 Base formula compiler preserves every untargeted byte and fails closed on ambiguous YAML",
);
