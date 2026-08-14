#!/usr/bin/env node

import assert from "node:assert/strict";
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
  "meta:",
  "  nested: true",
  "# separator remains",
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
  "meta:",
  "  nested: true",
  "# separator remains",
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

console.log(
  "PASS: P1 compiler changes only authorized top-level frontmatter ranges, preserves body/EOL/non-target source bytes, canonicalizes intent, and fails closed on ambiguous YAML.",
);
