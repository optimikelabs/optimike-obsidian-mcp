#!/usr/bin/env node

import assert from "node:assert/strict";
const compilerModule = await import(
  process.env.TEXT_PATCH_COMPILER_MODULE ??
    "../dist/services/textPatchCompiler.js",
);
const taskParserModule = await import(
  process.env.TASK_PARSER_MODULE ??
    "../dist/mcp-server/tools/tasksShared/TaskParser.js",
);
const { compileTextPatch } = compilerModule;
const { parseTasks } = taskParserModule;

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
for (const [name, source, operations, expected] of [
  [
    "bare CR frontmatter source",
    "---\rtitle: unsafe\r---\rbody\r",
    [{ op: "replace_literal", search: "body", replacement: "patched" }],
    "markdown_line_ending_unsupported",
  ],
  [
    "bare CR task source",
    "- [ ] real task\rbody\r",
    [{ op: "replace_literal", search: "[ ]", replacement: "[x]" }],
    "markdown_line_ending_unsupported",
  ],
  [
    "introduced bare CR",
    "body\n",
    [{ op: "append_body", text: "\rintroduced" }],
    "markdown_line_ending_unsupported",
  ],
  [
    "BOM source",
    "\uFEFFbody\n",
    [{ op: "replace_literal", search: "body", replacement: "patched" }],
    "markdown_bom_unsupported",
  ],
  [
    "BOM prepended",
    "body\n",
    [{ op: "prepend_body", text: "\uFEFFprefix\n" }],
    "markdown_bom_unsupported",
  ],
]) {
  assert.equal(
    reason(() => compileTextPatch(source, operations)),
    expected,
    `P4 must reject ${name} with a stable reason`,
  );
}
assert.equal(
  compileTextPatch("body\n", [{
    op: "append_body",
    text: "embedded \uFEFF character\n",
  }]).nextContent,
  "body\nembedded \uFEFF character\n",
  "P4 must distinguish an in-body U+FEFF character from a leading UTF-8 BOM",
);
assert.equal(
  reason(() => compileTextPatch("body\n", [{
    op: "prepend_body",
    text: "---\nforged: true\n---\n",
  }])),
  "frontmatter_touched",
);
assert.equal(
  reason(() => compileTextPatch("X---\nforged: true\n---\nbody\n", [{
    op: "replace_literal",
    search: "X",
    replacement: "",
  }])),
  "frontmatter_touched",
);
assert.equal(
  reason(() => compileTextPatch("body\n", [{
    op: "prepend_body",
    text: "---\nforged: true\n",
  }])),
  "frontmatter_touched",
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
const commonMarkTabTaskFixtures = [
  ["bullet tab", "-\t[ ] bullet tab task"],
  ["ordered tab", "1.\t[ ] ordered tab task"],
];
for (const [name, task] of commonMarkTabTaskFixtures) {
  assert.equal(
    parseTasks(`${task}\n`, "Notes/CommonMark-tab-task.md").length,
    0,
    `TaskParser need not index the CommonMark-only ${name} fixture`,
  );
  assert.equal(
    reason(() => compileTextPatch(`before\n${task}\nafter\n`, [{
      op: "replace_literal",
      search: "[ ]",
      replacement: "[x]",
    }])),
    "task_line_touched",
    `P4 must protect the CommonMark ${name} task`,
  );
  const fencedTaskExample = "```md\n" + task + "\n```\nafter\n";
  assert.equal(
    compileTextPatch(fencedTaskExample, [{
      op: "replace_literal",
      search: "[ ]",
      replacement: "[x]",
    }]).nextContent,
    "```md\n" + task.replace("[ ]", "[x]") + "\n```\nafter\n",
    `P4 must permit the fenced CommonMark ${name} example`,
  );
}
const parserIndexedTaskFixtures = [
  ["ordered dot", "1. [ ] ordered dot"],
  ["ordered paren", "1) [ ] ordered paren"],
  ["blockquote bullet", "> - [ ] blockquote bullet"],
  ["blockquote ordered", ">> 2. [ ] blockquote ordered"],
  ["indentation", "\t  - [ ] indented task"],
];
for (const [name, task] of parserIndexedTaskFixtures) {
  assert.equal(
    parseTasks(`${task}\n`, "Notes/Task-fixture.md").length,
    1,
    `TaskParser must index the ${name} fixture guarded by P4`,
  );
  assert.equal(
    reason(() => compileTextPatch(`before\n${task}\nafter\n`, [{
      op: "replace_literal",
      search: "[ ]",
      replacement: "[x]",
    }])),
    "task_line_touched",
    `P4 must refuse direct checkbox mutation for the TaskParser-indexed ${name} fixture`,
  );
  const fencedTaskExample = "```md\n" + task + "\n```\nafter\n";
  assert.equal(
    parseTasks(fencedTaskExample, "Notes/Task-fixture.md").length,
    0,
    `TaskParser must ignore the fenced ${name} fixture`,
  );
  assert.equal(
    compileTextPatch(fencedTaskExample, [{
      op: "replace_literal",
      search: "[ ]",
      replacement: "[x]",
    }]).nextContent,
    "```md\n" + task.replace("[ ]", "[x]") + "\n```\nafter\n",
    `P4 must permit the fenced ${name} example without reclassifying a real task`,
  );
}
// Dual fence contract: P4 permits an example only when both CommonMark-like parsing
// and Operon's toggle parser consider it fenced; either parser seeing a task protects it.
const dualFenceFixtures = [
  {
    name: "invalid CommonMark backtick info string",
    source: "```lang`bad\n- [ ] dual fence task\n```\n",
    operonTaskCount: 0,
    protected: true,
  },
  {
    name: "four-backtick opener with three-backtick pseudo-closer",
    source: "````md\ninside\n```\n- [ ] dual fence task\n````\n",
    operonTaskCount: 1,
    protected: true,
  },
  {
    name: "backtick opener with tilde pseudo-closer",
    source: "```md\ninside\n~~~\n- [ ] dual fence task\n```\n",
    operonTaskCount: 1,
    protected: true,
  },
  {
    name: "valid triple fence",
    source: "```md\n- [ ] dual fence task\n```\n",
    operonTaskCount: 0,
    protected: false,
  },
  {
    name: "valid four-backtick fence",
    source: "````md\n- [ ] dual fence task\n````\n",
    operonTaskCount: 0,
    protected: false,
  },
  {
    name: "valid tilde fence",
    source: "~~~md\n- [ ] dual fence task\n~~~\n",
    operonTaskCount: 0,
    protected: false,
  },
];
for (const fixture of dualFenceFixtures) {
  assert.equal(
    parseTasks(fixture.source, "Notes/Dual-fence-fixture.md").length,
    fixture.operonTaskCount,
    `TaskParser fence state must match the ${fixture.name} fixture`,
  );
  const operation = [{ op: "replace_literal", search: "[ ]", replacement: "[x]" }];
  if (fixture.protected) {
    assert.equal(
      reason(() => compileTextPatch(fixture.source, operation)),
      "task_line_touched",
      `P4 must protect the ${fixture.name} task when either fence model sees it as real`,
    );
  } else {
    assert.equal(
      compileTextPatch(fixture.source, operation).nextContent,
      fixture.source.replace("[ ]", "[x]"),
      `P4 must permit the ${fixture.name} example fenced by both models`,
    );
  }
}
const fencedExample = "before\n```md\n- [ ] example only\n```\nafter\n";
assert.equal(
  compileTextPatch(fencedExample, [{ op: "replace_literal", search: "- [ ] example only", replacement: "- [x] still example" }]).nextContent,
  "before\n```md\n- [x] still example\n```\nafter\n",
);
for (const opener of ["```md\n", "~~~md\n"]) {
  assert.equal(
    compileTextPatch(opener, [{ op: "append_body", text: "- [ ] example\n" }]).nextContent,
    opener + "- [ ] example\n",
    `P4 must allow a task-shaped append inside an already-open ${JSON.stringify(opener)} fence`,
  );
}
assert.equal(
  reason(() => compileTextPatch("body\n", [{ op: "append_body", text: "- [ ] forbidden\n" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("```md\n", [{ op: "append_body", text: "```\n- [ ] forbidden\n" }])),
  "task_line_touched",
);
assert.equal(
  compileTextPatch("body\n", [{ op: "prepend_body", text: "```md\n- [ ] example\n```\n" }]).nextContent,
  "```md\n- [ ] example\n```\nbody\n",
);
assert.equal(
  reason(() => compileTextPatch("-", [{ op: "append_body", text: " [ ] todo" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("-", [{ op: "append_body", text: "\t[ ] todo" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("- TODO\n", [{ op: "replace_literal", search: "TODO", replacement: "[ ] introduced" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("- X[ ] todo", [{ op: "replace_literal", search: "X", replacement: "" }])),
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
assert.equal(
  reason(() => compileTextPatch("[ ] todo", [{ op: "prepend_body", text: "- " }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("- [ ] task\n", [{ op: "prepend_body", text: "```\n" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("```md\n- [ ] example\n```\n", [{ op: "replace_literal", search: "```md\n", replacement: "" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("```\nplain\n```\n- [ ] example\n", [{ op: "replace_literal", search: "plain\n```\n", replacement: "plain\n" }])),
  "task_line_touched",
);
assert.equal(
  reason(() => compileTextPatch("```md\ninside\n```note\n- [ ] example\n", [{ op: "replace_literal", search: "note", replacement: "" }])),
  "task_line_touched",
);
assert.equal(
  compileTextPatch("- [ ] task\n", [{ op: "prepend_body", text: "plain\n" }]).nextContent,
  "plain\n- [ ] task\n",
);
assert.equal(
  compileTextPatch("before\n- [ ] task\nafter\n", [{
    op: "replace_literal",
    search: "before\n",
    replacement: "first\nsecond\n",
  }]).nextContent,
  "first\nsecond\n- [ ] task\nafter\n",
);
assert.equal(
  compileTextPatch("prefix\n- [ ] task\nafter\n", [{
    op: "replace_literal",
    search: "prefix\n",
    replacement: "",
  }]).nextContent,
  "- [ ] task\nafter\n",
  "P4 must permit deletion ending exactly before a preserved task",
);

const duplicatedTaskFenceExchange = [
  "````md",
  "- [ ] duplicate task",
  "```",
  "- [ ] duplicate task",
  "````",
  "- [ ] duplicate task",
  "END",
  "",
].join("\n");
const reclassifyingFenceSwap = {
  op: "replace_literal",
  search: "````",
  replacement: "```",
  occurrence: "all",
  intent: "replace_all",
};
assert.equal(
  reason(() => compileTextPatch(duplicatedTaskFenceExchange, [reclassifyingFenceSwap])),
  "task_line_touched",
  "P4 must reject the delimiter-only 4/3-backtick identity exchange at its reclassification step",
);
assert.equal(
  reason(() => compileTextPatch(duplicatedTaskFenceExchange, [
    reclassifyingFenceSwap,
    {
      op: "replace_literal",
      search: "- [ ] duplicate task\nEND",
      replacement: "- [x] mutated former real task\nEND",
    },
  ])),
  "task_line_touched",
  "P4 must reject identical task text reclassification through 4/3-backtick fences before later mutation",
);
assert.equal(
  compileTextPatch("", [{ op: "append_body", text: "appended" }], "Notes/Empty.md").nextContent,
  "appended",
  "P4 must append to an existing zero-byte Markdown note",
);
assert.equal(
  compileTextPatch("", [{ op: "prepend_body", text: "prepended" }], "Notes/Empty.md").nextContent,
  "prepended",
  "P4 must prepend to an existing zero-byte Markdown note",
);

const failures = [
  ["markdown_note_missing", () => compileTextPatch(undefined, [{ op: "append_body", text: "x" }])],
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
