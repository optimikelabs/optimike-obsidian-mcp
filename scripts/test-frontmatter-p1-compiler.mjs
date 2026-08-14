#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileFrontmatterPatch } from "../dist/services/frontmatterPatchCompiler.js";

function errorReason(operation) {
  try {
    operation();
    assert.fail("Expected governed frontmatter compilation to fail closed.");
  } catch (error) {
    return error?.details?.reason ?? error?.message ?? String(error);
  }
}

const crlf = [
  "---",
  "# header remains",
  "création: 2026-08-13",
  "statut: actif # targeted inline comment",
  "# separator remains",
  "meta:",
  "  nested: true",
  'owner: "Mike"',
  "",
  "---",
  "Body line 1",
  "Body line 2",
  "",
].join("\r\n");

const compiled = compileFrontmatterPatch(crlf, [
  { op: "set", key: "rang", value: 1 },
  { op: "delete", key: "owner" },
  { op: "set", key: "statut", value: "pause" },
]);

const expected = [
  "---",
  "# header remains",
  "création: 2026-08-13",
  'statut: "pause"',
  "# separator remains",
  "meta:",
  "  nested: true",
  "rang: 1",
  "",
  "---",
  "Body line 1",
  "Body line 2",
  "",
].join("\r\n");

assert.equal(compiled.nextContent, expected);
assert.equal(
  compiled.nextContent.slice(compiled.nextContent.indexOf("---\r\n", 4) + 5),
  crlf.slice(crlf.indexOf("---\r\n", 4) + 5),
  "Markdown body must remain byte-identical",
);
assert.deepEqual(
  compiled.operations.map(({ op, key }) => ({ op, key })),
  [
    { op: "delete", key: "owner" },
    { op: "set", key: "rang" },
    { op: "set", key: "statut" },
  ],
  "operation order must be canonical",
);
assert.equal(compiled.proof.lineEnding, "crlf");
assert.equal(
  compiled.proof.sourcePreservation,
  "byte-identical-outside-authorized-frontmatter-ranges",
);
assert.equal(compiled.proof.authorizedRanges.length, 3);
assert.deepEqual(compiled.proof.changedKeys, ["owner", "rang", "statut"]);
assert.match(compiled.proof.patchDigest, /^[a-f0-9]{64}$/u);
assert.match(compiled.proof.untouchedSourceSha256, /^[a-f0-9]{64}$/u);

const nested = [
  "---",
  "title: Existing",
  "meta:",
  "  nested: true",
  "  count: 2",
  "other: 'keep exact'",
  "---",
  "Body\n",
].join("\n");
const nestedCompiled = compileFrontmatterPatch(nested, [
  {
    op: "set",
    key: "meta",
    value: { z: 2, a: [true, "x"] },
  },
]);
assert.equal(
  nestedCompiled.nextContent,
  [
    "---",
    "title: Existing",
    'meta: {"a":[true,"x"],"z":2}',
    "other: 'keep exact'",
    "---",
    "Body\n",
  ].join("\n"),
);
assert.equal(nestedCompiled.proof.lineEnding, "lf");

const sameIntentOrderA = compileFrontmatterPatch(
  "---\na: 1\nb: 2\n---\nbody\n",
  [
    { op: "set", key: "b", value: 4 },
    { op: "set", key: "a", value: 3 },
  ],
);
const sameIntentOrderB = compileFrontmatterPatch(
  "---\na: 1\nb: 2\n---\nbody\n",
  [
    { op: "set", key: "a", value: 3 },
    { op: "set", key: "b", value: 4 },
  ],
);
assert.equal(sameIntentOrderA.nextContent, sameIntentOrderB.nextContent);
assert.equal(
  sameIntentOrderA.proof.patchDigest,
  sameIntentOrderB.proof.patchDigest,
);

const composedKey = "é";
const decomposedKey = "e\u0301";
const unicodeObjectOrderA = Object.fromEntries([
  [composedKey, "composed"],
  [decomposedKey, "decomposed"],
]);
const unicodeObjectOrderB = Object.fromEntries([
  [decomposedKey, "decomposed"],
  [composedKey, "composed"],
]);
const sameUnicodeIntentOrderA = compileFrontmatterPatch(
  "---\nmeta: {}\n---\nbody\n",
  [{ op: "set", key: "meta", value: unicodeObjectOrderA }],
);
const sameUnicodeIntentOrderB = compileFrontmatterPatch(
  "---\nmeta: {}\n---\nbody\n",
  [{ op: "set", key: "meta", value: unicodeObjectOrderB }],
);
assert.equal(
  sameUnicodeIntentOrderA.nextContent,
  sameUnicodeIntentOrderB.nextContent,
  "distinct Unicode object keys must have a total canonical order independent of insertion order",
);
assert.equal(
  sameUnicodeIntentOrderA.proof.patchDigest,
  sameUnicodeIntentOrderB.proof.patchDigest,
  "equivalent Unicode-keyed object intents must produce the same digest",
);
const expectedUnicodePatchDigest = createHash("sha256")
  .update(
    JSON.stringify({
      operations: [
        {
          key: "meta",
          op: "set",
          value: Object.fromEntries([
            [decomposedKey, "decomposed"],
            [composedKey, "composed"],
          ]),
        },
      ],
    }),
    "utf8",
  )
  .digest("hex");
assert.equal(
  sameUnicodeIntentOrderA.proof.patchDigest,
  expectedUnicodePatchDigest,
  "patch proof hashing must preserve P1 code-unit ordering",
);

const untargetedBlockScalar = [
  "---",
  "description: |-",
  "  use &name literally",
  "  use *alias and !tag literally",
  "  ...",
  "statut: actif",
  "---",
  "body",
  "",
].join("\n");
const untargetedBlockScalarCompiled = compileFrontmatterPatch(
  untargetedBlockScalar,
  [{ op: "set", key: "statut", value: "pause" }],
);
assert.equal(
  untargetedBlockScalarCompiled.nextContent,
  untargetedBlockScalar.replace("statut: actif", 'statut: "pause"'),
  "literal anchor, alias, tag, and document-marker text inside an untargeted block scalar must remain byte-identical",
);

const untargetedNestedBlockScalar = [
  "---",
  "meta:",
  "  secret: |",
  "    value",
  "    # retained scalar text",
  "statut: actif",
  "---",
  "body",
  "",
].join("\n");
const untargetedNestedBlockScalarCompiled = compileFrontmatterPatch(
  untargetedNestedBlockScalar,
  [{ op: "set", key: "statut", value: "pause" }],
);
assert.equal(
  untargetedNestedBlockScalarCompiled.nextContent,
  untargetedNestedBlockScalar.replace("statut: actif", 'statut: "pause"'),
  "a nested block scalar in an untargeted entry must remain byte-identical",
);

const groupedAdditions = compileFrontmatterPatch(
  "---\nexisting: true\n---\nbody\n",
  [
    { op: "set", key: "first_added_key", value: 1 },
    { op: "set", key: "second_added_key", value: 2 },
  ],
);
assert.equal(groupedAdditions.proof.authorizedRanges.length, 1);
assert.equal(
  groupedAdditions.proof.authorizedRanges[0].key,
  "[frontmatter-additions]",
  "a grouped insertion range must use a fixed non-secret marker instead of concatenating key names",
);

const failures = [
  [
    "frontmatter_missing",
    () =>
      compileFrontmatterPatch("body only\n", [
        { op: "set", key: "a", value: 1 },
      ]),
  ],
  [
    "duplicate_frontmatter_key",
    () =>
      compileFrontmatterPatch("---\nA: 1\na: 2\n---\n", [
        { op: "set", key: "a", value: 3 },
      ]),
  ],
  [
    "yaml_anchor_unsupported",
    () =>
      compileFrontmatterPatch("---\na: &base 1\n---\n", [
        { op: "set", key: "a", value: 2 },
      ]),
  ],
  [
    "yaml_alias_unsupported",
    () =>
      compileFrontmatterPatch("---\na: 1\nb: *base\n---\n", [
        { op: "set", key: "a", value: 2 },
      ]),
  ],
  [
    "yaml_merge_key_unsupported",
    () =>
      compileFrontmatterPatch("---\n<<: {a: 1}\nb: 2\n---\n", [
        { op: "set", key: "b", value: 3 },
      ]),
  ],
  [
    "yaml_tag_unsupported",
    () =>
      compileFrontmatterPatch("---\na: !custom value\n---\n", [
        { op: "set", key: "a", value: 2 },
      ]),
  ],
  [
    "unsupported_top_level_yaml",
    () =>
      compileFrontmatterPatch('---\n"quoted key": 1\n---\n', [
        { op: "set", key: "a", value: 2 },
      ]),
  ],
  [
    "ambiguous_trailing_comment",
    () =>
      compileFrontmatterPatch(
        "---\na: 1\n# footer ownership is ambiguous\n---\n",
        [{ op: "set", key: "b", value: 2 }],
      ),
  ],
  [
    "ambiguous_delete_comment",
    () =>
      compileFrontmatterPatch(
        "---\na: 1\n# could belong to a or b\nb: 2\n---\n",
        [{ op: "delete", key: "a" }],
      ),
  ],
  [
    "ambiguous_delete_comment",
    () =>
      compileFrontmatterPatch(
        "---\na: 1\n# could belong to a or b\nb: 2\n---\n",
        [{ op: "delete", key: "b" }],
      ),
  ],
  [
    "ambiguous_delete_comment",
    () =>
      compileFrontmatterPatch(
        "---\na: 1\n  # indented but still ambiguous\nb: 2\n---\n",
        [{ op: "delete", key: "b" }],
      ),
  ],
  [
    "target_block_scalar_unsupported",
    () =>
      compileFrontmatterPatch(
        "---\nsecret: |-\n  first line\n  # retained scalar text\nnext: true\n---\nbody\n",
        [{ op: "set", key: "secret", value: "replacement" }],
      ),
  ],
  [
    "target_block_scalar_unsupported",
    () =>
      compileFrontmatterPatch(
        "---\nmeta:\n  secret: |\n    value\n    # retained scalar text\nnext: true\n---\nbody\n",
        [{ op: "set", key: "meta", value: { replacement: true } }],
      ),
  ],
  [
    "frontmatter_key_missing",
    () =>
      compileFrontmatterPatch("---\na: 1\n---\n", [
        { op: "delete", key: "missing" },
      ]),
  ],
  [
    "duplicate_patch_target",
    () =>
      compileFrontmatterPatch("---\na: 1\n---\n", [
        { op: "set", key: "a", value: 2 },
        { op: "delete", key: "A" },
      ]),
  ],
  [
    "frontmatter_number_non_finite",
    () =>
      compileFrontmatterPatch("---\na: 1\n---\n", [
        { op: "set", key: "a", value: Number.NaN },
      ]),
  ],
];

for (const [expectedReason, operation] of failures) {
  assert.equal(errorReason(operation), expectedReason);
}

const invalidYamlSecret = "TOP_SECRET_VALUE_MUST_NOT_LEAK";
try {
  compileFrontmatterPatch(
    `---\nsecret: ${invalidYamlSecret}\nbroken: [\n---\n`,
    [{ op: "set", key: "a", value: 1 }],
  );
  assert.fail("Expected invalid YAML to fail closed.");
} catch (error) {
  assert.equal(error?.details?.reason, "frontmatter_yaml_invalid");
  assert.equal(
    JSON.stringify(error?.details).includes(invalidYamlSecret),
    false,
    "parser diagnostics must not disclose source frontmatter values",
  );
}

console.log(
  "PASS: P1 compiler changes only authorized top-level frontmatter ranges, preserves body/EOL/non-target source bytes, canonicalizes intent, and fails closed on ambiguous YAML.",
);
