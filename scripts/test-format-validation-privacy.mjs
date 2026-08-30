import assert from "node:assert/strict";

// obsidianFormatService shares the vault tag extractor, whose module loads the
// application configuration. Keep this unit-style test runnable without a
// developer .env or a live REST key.
process.env.OBSIDIAN_RUNTIME_MODE ??= "headless-readonly";
process.env.OBSIDIAN_VAULT ??= process.cwd();

const { validateJsonCanvas, validateObsidianBase, validateObsidianMarkdown } =
  await import("../dist/services/obsidianFormatService.js");

function serialized(result) {
  return JSON.stringify(result);
}

function assertParserIssue(result, code, message, path, sentinel, label) {
  assert.equal(result.ok, false, `${label} must be invalid`);
  assert.equal(
    result.errors.length,
    1,
    `${label} must expose one parser issue`,
  );
  assert.deepEqual(result.errors[0], {
    severity: "error",
    code,
    message,
    path,
  });
  assert.doesNotMatch(
    serialized(result),
    new RegExp(sentinel, "u"),
    `${label} must not reflect source content`,
  );
}

function assertSemanticIssue(result, expectedIssue, sentinels, label) {
  assert.ok(
    [...result.errors, ...result.warnings].some((issue) =>
      Object.entries(expectedIssue).every(
        ([key, value]) => issue[key] === value,
      ),
    ),
    `${label} must expose the expected structural issue`,
  );
  for (const sentinel of sentinels) {
    assert.doesNotMatch(
      serialized(result),
      new RegExp(sentinel, "u"),
      `${label} must not reflect semantic input values`,
    );
  }
}

const frontmatterSentinel = "FRONTMATTER_PRIVATE_SENTINEL_7F3A";
assertParserIssue(
  validateObsidianMarkdown(
    `---\nprivate: [${frontmatterSentinel}\n---\nVisible body`,
  ),
  "frontmatter-yaml-invalid",
  "Frontmatter YAML is invalid.",
  "frontmatter",
  frontmatterSentinel,
  "malformed frontmatter",
);

const baseSentinel = "BASE_PRIVATE_SENTINEL_8B4C";
assertParserIssue(
  validateObsidianBase(`views: [${baseSentinel}`),
  "base-yaml-invalid",
  ".base YAML is invalid.",
  "base",
  baseSentinel,
  "malformed Base",
);

const canvasSentinel = "CANVAS_PRIVATE_SENTINEL_9D5E";
assertParserIssue(
  validateJsonCanvas(`{"nodes":[{"id":"${canvasSentinel}"`),
  "canvas-json-invalid",
  "Canvas JSON is invalid.",
  "canvas",
  canvasSentinel,
  "malformed Canvas",
);

const markdownCalloutSentinel = "x7";
const markdownSemanticResult = validateObsidianMarkdown(
  `> [!${markdownCalloutSentinel}] Parsed semantic sentinel`,
);
assert.equal(
  markdownSemanticResult.ok,
  true,
  "Markdown must parse successfully",
);
assertSemanticIssue(
  markdownSemanticResult,
  {
    severity: "warning",
    code: "unknown-callout",
    message: "Callout type is not in the common Obsidian callout set.",
    path: "body",
  },
  [markdownCalloutSentinel],
  "parsed Markdown semantic issue",
);

const markdownTagSentinel = "x7!";
const markdownTagResult = validateObsidianMarkdown(
  `---\ntags: [${markdownTagSentinel}]\n---\nParsed semantic sentinel`,
);
assert.equal(markdownTagResult.ok, true, "Markdown must parse successfully");
assertSemanticIssue(
  markdownTagResult,
  {
    severity: "warning",
    code: "tag-syntax",
    message: "Tag is outside the conservative Obsidian tag pattern.",
    path: "tags",
  },
  [markdownTagSentinel],
  "parsed Markdown tag issue",
);

const baseFormulaSentinel = "42";
const baseSemanticResult = validateObsidianBase(
  `views: []\nproperties:\n  p7: "formula.${baseFormulaSentinel}"`,
);
assert.equal(baseSemanticResult.ok, true, "Base must parse successfully");
assertSemanticIssue(
  baseSemanticResult,
  {
    severity: "warning",
    code: "base-undefined-formula",
    message: "A formula is referenced but not defined in formulas.",
    path: "formulas",
  },
  [baseFormulaSentinel],
  "parsed Base semantic issue",
);

const canvasNodeIdSentinel = "17";
const canvasEdgeIdSentinel = "E7";
const canvasMissingNodeSentinel = "N9";
const canvasSemanticResult = validateJsonCanvas(
  JSON.stringify({
    nodes: [
      {
        id: canvasNodeIdSentinel,
        type: "text",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        text: "First node",
      },
      {
        id: canvasNodeIdSentinel,
        type: "text",
        x: 2,
        y: 0,
        width: 1,
        height: 1,
        text: "Second node",
      },
    ],
    edges: [
      {
        id: canvasEdgeIdSentinel,
        fromNode: canvasMissingNodeSentinel,
        toNode: canvasNodeIdSentinel,
      },
      {
        id: canvasEdgeIdSentinel,
        fromNode: canvasNodeIdSentinel,
        toNode: canvasNodeIdSentinel,
      },
    ],
  }),
);
assert.equal(
  canvasSemanticResult.ok,
  false,
  "Canvas semantic errors must fail validation",
);
assertSemanticIssue(
  canvasSemanticResult,
  {
    severity: "error",
    code: "canvas-node-id-duplicate",
    message: "Canvas node id is duplicated.",
    path: "nodes[1].id",
  },
  [canvasNodeIdSentinel, canvasEdgeIdSentinel, canvasMissingNodeSentinel],
  "parsed Canvas node issue",
);
assertSemanticIssue(
  canvasSemanticResult,
  {
    severity: "error",
    code: "canvas-edge-id-duplicate",
    message: "Canvas edge id is duplicated.",
    path: "edges[1].id",
  },
  [canvasNodeIdSentinel, canvasEdgeIdSentinel, canvasMissingNodeSentinel],
  "parsed Canvas edge issue",
);

console.log("Format validation privacy tests passed.");
