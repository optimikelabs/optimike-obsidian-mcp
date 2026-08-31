#!/usr/bin/env node

import assert from "node:assert/strict";
const compilerModule = await import(
  process.env.TEXT_PATCH_COMPILER_MODULE ??
    "../dist/services/textPatchCompiler.js",
);
const { compileTextPatch } = compilerModule;

function reason(operation) {
  try {
    operation();
    assert.fail("Expected P4 compilation to fail closed.");
  } catch (error) {
    return error?.details?.reason ?? error?.message;
  }
}

for (const eol of ["\n", "\r\n"]) {
  const source = ["---", "title: Preserve exactly", "---", "Before", "target", "After", ""].join(eol);
  const compiled = compileTextPatch(source, [
    { op: "prepend_body", text: `First${eol}` },
    { op: "replace_literal", search: "target", replacement: "patched" },
    { op: "append_body", text: `Last${eol}` },
  ], "Notes/Example.md");
  assert.equal(
    compiled.nextContent,
    ["---", "title: Preserve exactly", "---", "First", "Before", "patched", "After", "Last", ""].join(eol),
    `P4 must preserve ${JSON.stringify(eol)} source and patch only the body`,
  );
  assert.equal(compiled.proof.lineEnding, eol === "\r\n" ? "crlf" : "lf");
  assert.equal(compiled.proof.beforeFrontmatterSha256, compiled.proof.afterFrontmatterSha256);
  assert.equal(compiled.proof.sourcePreservation, "byte-identical-outside-authorized-body-ranges");
  assert.equal(compiled.proof.preservedFrontmatterSha256, compiled.proof.beforeFrontmatterSha256);
  assert.deepEqual(
    compiled.proof.authorizedRanges.map((range) => range.operationIndex),
    [0, 1, 2],
  );
  assert.ok(
    compiled.proof.authorizedRanges.every(
      (range) =>
        range.coordinateSpace === "operation-input-content" &&
        /^[a-f0-9]{64}$/u.test(range.stepBeforeBodySha256) &&
        /^[a-f0-9]{64}$/u.test(range.stepAfterBodySha256),
    ),
  );
  assert.match(compiled.proof.patchDigest, /^[a-f0-9]{64}$/u);
}

const multiple = "---\ntitle: safe\n---\nneedle\nneedle\n";
assert.equal(
  reason(() => compileTextPatch(multiple, [{ op: "replace_literal", search: "needle", replacement: "done" }])),
  "literal_not_unique",
);
assert.equal(
  reason(() => compileTextPatch(multiple, [{ op: "replace_literal", search: "needle", replacement: "done", occurrence: "all" }])),
  "replace_all_intent_required",
);
const all = compileTextPatch(multiple, [{
  op: "replace_literal",
  search: "needle",
  replacement: "done",
  occurrence: "all",
  intent: "replace_all",
}]);
assert.equal(all.nextContent, "---\ntitle: safe\n---\ndone\ndone\n");
assert.equal(all.proof.authorizedRanges.length, 2);
assert.equal(
  reason(() => compileTextPatch("x ".repeat(65), [{
    op: "replace_literal",
    search: "x",
    replacement: "y",
    occurrence: "all",
    intent: "replace_all",
  }])),
  "too_many_authorized_ranges",
);

const sameA = compileTextPatch("---\na: b\n---\nold\n", [{ op: "replace_literal", search: "old", replacement: "new" }]);
const sameB = compileTextPatch("---\na: b\n---\nold\n", [{ op: "replace_literal", search: "old", replacement: "new" }]);
assert.equal(sameA.nextContent, sameB.nextContent);
assert.equal(sameA.proof.patchDigest, sameB.proof.patchDigest);

const secret = "FRONTMATTER_SECRET_MUST_NOT_LEAK";
assert.equal(
  reason(() => compileTextPatch(`---\nsecret: ${secret}\n---\nbody\n`, [{ op: "replace_literal", search: secret, replacement: "changed" }])),
  "literal_not_found",
);
assert.equal(
  reason(() => compileTextPatch("---\ntitle: broken\n", [{ op: "append_body", text: "x" }])),
  "frontmatter_unclosed",
);

for (const task of ["- [ ] todo\n", "  - [x] done\n", "\t- [-] deferred\n", "- [/] active\n"]) {
  assert.equal(
    reason(() => compileTextPatch(`intro\n${task}outro\n`, [{ op: "replace_literal", search: task.trim(), replacement: "changed" }])),
    "task_line_touched",
  );
}
for (const task of ["- [X] done\n", "* [>] forwarded\n", "+ [?] question\n"]) {
  assert.equal(
    reason(() => compileTextPatch(`intro\n${task}outro\n`, [{ op: "replace_literal", search: task.trim(), replacement: "changed" }])),
    "task_line_touched",
  );
}
const fencedExample = "before\n```md\n- [ ] example only\n```\nafter\n";
assert.equal(
  compileTextPatch(fencedExample, [{ op: "replace_literal", search: "- [ ] example only", replacement: "- [x] still example" }]).nextContent,
  "before\n```md\n- [x] still example\n```\nafter\n",
);
assert.equal(
  reason(() => compileTextPatch("body\n", [{ op: "append_body", text: "- [ ] forbidden\n" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("- TODO\n", [{ op: "replace_literal", search: "TODO", replacement: "[ ] introduced" }])),
  "task_line_touched",
);
assert.equal(
  compileTextPatch("- [ ] task", [{ op: "append_body", text: "\nplain" }]).nextContent,
  "- [ ] task\nplain",
);
assert.equal(
  compileTextPatch("- [ ] task\n", [{ op: "append_body", text: "plain" }]).nextContent,
  "- [ ] task\nplain",
);
assert.equal(
  compileTextPatch("- [ ] task", [{ op: "prepend_body", text: "plain\n" }]).nextContent,
  "plain\n- [ ] task",
);
assert.equal(
  reason(() => compileTextPatch("- [ ] task", [{ op: "append_body", text: " unsafe" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("- [ ] task", [{ op: "prepend_body", text: "unsafe " }])),
  "task_line_touched",
);

const failures = [
  ["markdown_note_missing", () => compileTextPatch("", [{ op: "append_body", text: "x" }])],
  ["markdown_path_invalid", () => compileTextPatch("body", [{ op: "append_body", text: "x" }], "Notes/not-markdown.txt")],
  ["regex_unsupported", () => compileTextPatch("body", [{ op: "replace_literal", search: /body/u, replacement: "x" }])],
  ["literal_not_found", () => compileTextPatch("body", [{ op: "replace_literal", search: "missing", replacement: "x" }])],
  ["empty_literal_search", () => compileTextPatch("body", [{ op: "replace_literal", search: "", replacement: "x" }])],
  ["replace_all_intent_mismatch", () => compileTextPatch("body", [{ op: "replace_literal", search: "body", replacement: "x", intent: "replace_all" }])],
  ["empty_patch", () => compileTextPatch("body", [])],
  ["empty_patch_text", () => compileTextPatch("body", [{ op: "append_body", text: "" }])],
];
for (const [expected, operation] of failures) assert.equal(reason(operation), expected);

console.log("PASS: P4 text compiler patches only governed Markdown bodies, preserves frontmatter/EOL, and fails closed.");
