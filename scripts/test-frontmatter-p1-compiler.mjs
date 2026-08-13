#!/usr/bin/env node

import assert from "node:assert/strict";
import { compileFrontmatterPatch } from "../dist/services/frontmatterPatchCompiler.js";

const crlf = [
  "---",
  "# keep header",
  "création: 2026-08-13",
  "statut: actif",
  "meta:",
  "  nested: true",
  "# keep tail",
  "---",
  "Body line 1",
  "Body line 2",
  "",
].join("\r\n");

const body = "Body line 1\r\nBody line 2\r\n";

const setScalar = compileFrontmatterPatch(crlf, [
  { op: "set", key: "statut", value: "terminé" },
]);
assert.equal(
  setScalar.nextContent,
  [
    "---",
    "# keep header",
    "création: 2026-08-13",
    'statut: "terminé"',
    "meta:",
    "  nested: true",
    "# keep tail",
    "---",
    "Body line 1",
    "Body line 2",
    "",
  ].join("\r\n"),
);
assert.equal(setScalar.nextContent.endsWith(body), true);
assert.equal(setScalar.proof.lineEnding, "crlf");
assert.equal(
  setScalar.proof.sourcePreservation,
  "byte-identical-outside-target-frontmatter-entries",
);
assert.deepEqual(setScalar.proof.changedKeys, ["statut"]);

const replaceNested = compileFrontmatterPatch(crlf, [
  { op: "set", key: "meta", value: { nested: false, count: 2 } },
]);
assert.match(replaceNested.nextContent, /meta: \{"nested":false,"count":2\}\r\n/u);
assert.match(replaceNested.nextContent, /# keep tail\r\n---\r\n/u);
assert.equal(replaceNested.nextContent.endsWith(body), true);

const addKey = compileFrontmatterPatch(crlf, [
  { op: "set", key: "rang", value: 1 },
]);
assert.match(addKey.nextContent, /rang: 1\r\n# keep tail\r\n---\r\n/u);
assert.equal(addKey.nextContent.endsWith(body), true);

const deleteKey = compileFrontmatterPatch(crlf, [
  { op: "delete", key: "meta" },
]);
assert.doesNotMatch(deleteKey.nextContent, /^meta:/mu);
assert.match(deleteKey.nextContent, /statut: actif\r\n# keep tail/u);
assert.equal(deleteKey.nextContent.endsWith(body), true);

const multi = compileFrontmatterPatch(crlf, [
  { op: "set", key: "statut", value: "pause" },
  { op: "set", key: "rang", value: 2 },
]);
assert.match(multi.nextContent, /statut: "pause"/u);
assert.match(multi.nextContent, /rang: 2/u);
assert.equal(multi.nextContent.endsWith(body), true);

assert.throws(
  () =>
    compileFrontmatterPatch(crlf, [
      { op: "set", key: "statut", value: "pause" },
      { op: "delete", key: "STATUT" },
    ]),
  /at most once/u,
);
assert.throws(
  () => compileFrontmatterPatch(crlf, [{ op: "delete", key: "absent" }]),
  /does not exist/u,
);
assert.throws(
  () =>
    compileFrontmatterPatch('---\n"quoted key": value\n---\nbody\n', [
      { op: "set", key: "statut", value: "x" },
    ]),
  /Unsupported top-level syntax/u,
);
assert.throws(
  () => compileFrontmatterPatch("No frontmatter\n", [{ op: "set", key: "x", value: 1 }]),
  /requires an existing frontmatter block/u,
);

console.log(
  "PASS: P1 compiler preserves all non-target bytes, keeps Markdown body exact, supports bounded top-level set/delete, and fails closed on ambiguous YAML.",
);
