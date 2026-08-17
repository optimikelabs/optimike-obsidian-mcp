import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "optimike-routing-score-"));
const resultsPath = path.join(temp, "results.jsonl");

try {
  writeFileSync(
    resultsPath,
    [
      JSON.stringify({
        id: "semantic-canonical",
        harness: "fixture",
        surface: "standard",
        toolsCalled: ["smart_semantic_search"],
        success: true,
        latencyMs: 100,
        inputTokens: 1000,
      }),
      JSON.stringify({
        id: "semantic-canonical",
        harness: "fixture",
        surface: "full",
        toolsCalled: ["smart_search", "smart_semantic_search"],
        success: true,
        latencyMs: 140,
        inputTokens: 1400,
      }),
      JSON.stringify({
        id: "no-tool-explanation",
        harness: "fixture",
        surface: "standard",
        toolsCalled: [],
        success: true,
        latencyMs: 50,
        inputTokens: 500,
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const output = execFileSync(
    process.execPath,
    ["scripts/score-tool-routing-evals.mjs", resultsPath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const report = JSON.parse(output);
  assert.equal(report.evaluatedRuns, 3);

  const standard = report.summaries.find(
    (item) => item.harness === "fixture" && item.surface === "standard",
  );
  assert.ok(standard);
  assert.equal(standard.runs, 2);
  assert.equal(standard.firstToolAccuracy, 1);
  assert.equal(standard.forbiddenToolRate, 0);
  assert.equal(standard.successRate, 1);

  const full = report.summaries.find(
    (item) => item.harness === "fixture" && item.surface === "full",
  );
  assert.ok(full);
  assert.equal(full.firstToolAccuracy, 0);
  assert.equal(full.forbiddenToolRate, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].firstTool, "smart_search");

  console.log("PASS: routing eval scorer distinguishes canonical and forbidden tool choices");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
