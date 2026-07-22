import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFilterValues,
  isTruthyFilterReference,
  isTruthyFilterValue,
  parseComparisonLiteral,
} from "./filter-comparison.mjs";

test("parses Bases comparison literals", () => {
  assert.equal(parseComparisonLiteral("null"), null);
  assert.equal(parseComparisonLiteral("true"), true);
  assert.equal(parseComparisonLiteral("42"), 42);
  assert.equal(parseComparisonLiteral('"actif"'), "actif");
});

test("matches missing frontmatter against null", () => {
  assert.equal(compareFilterValues(undefined, "==", null), true);
  assert.equal(compareFilterValues(null, "=", null), true);
  assert.equal(compareFilterValues(undefined, "!=", null), false);
  assert.equal(compareFilterValues("actif", "!=", null), true);
});

test("preserves numeric and string comparisons", () => {
  assert.equal(compareFilterValues("5", ">=", 4), true);
  assert.equal(compareFilterValues("actif", "==", "actif"), true);
  assert.equal(compareFilterValues("sommeil", "!=", "clos"), true);
});

test("recognizes truthy property and formula references", () => {
  assert.equal(isTruthyFilterReference("next_action"), true);
  assert.equal(isTruthyFilterReference("formula.next_action_ok"), true);
  assert.equal(isTruthyFilterReference("file.path"), true);
  assert.equal(isTruthyFilterReference("unknown.path"), false);
  assert.equal(isTruthyFilterValue("Planifier"), true);
  assert.equal(isTruthyFilterValue(false), false);
  assert.equal(isTruthyFilterValue(null), false);
});
