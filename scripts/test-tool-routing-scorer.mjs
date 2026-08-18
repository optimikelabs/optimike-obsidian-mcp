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
        id: "runtime-status",
        harness: "fixture",
        surface: "full",
        toolsCalled: ["obsidian_runtime_maintenance", "obsidian_runtime_status"],
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
      JSON.stringify({
        id: "external-move-full",
        harness: "fixture",
        surface: "full",
        toolsCalled: [
          "external_references_scan",
          "external_move_plan",
          "external_move_apply",
        ],
        success: true,
        latencyMs: 180,
        inputTokens: 1600,
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
  assert.equal(report.evaluatedRuns, 4);

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
  assert.equal(full.runs, 2);
  assert.equal(full.firstToolAccuracy, 0.5);
  assert.equal(full.forbiddenToolRate, 0.5);
  assert.equal(
    full.meanUnnecessaryCalls,
    0.5,
    "the three required external-move calls must not be scored as unnecessary",
  );
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].firstTool, "obsidian_runtime_maintenance");

  console.log("PASS: routing eval scorer distinguishes canonical and forbidden tool choices");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
