import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "optimike-routing-score-"));
const resultsPath = path.join(temp, "results.jsonl");
const strictResultsPath = path.join(temp, "strict-results.jsonl");
const invalidResultsPath = path.join(temp, "invalid-results.jsonl");
const clarificationCorpusPath = path.join(temp, "clarification-corpus.json");
const clarificationResultsPath = path.join(temp, "clarification-results.jsonl");
const corpusPath = path.join(
  process.cwd(),
  "evals",
  "tool-routing-corpus.json",
);
const corpusRaw = fs.readFileSync(corpusPath, "utf8");
const corpusHash = crypto.createHash("sha256").update(corpusRaw).digest("hex");

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
        toolsCalled: [
          "obsidian_runtime_maintenance",
          "obsidian_runtime_status",
        ],
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
  assert.equal(standard.meanSchemaBytes, "N/A");

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
  assert.equal(full.firstToolFamilyAccuracy, 1);

  const strictTrace = {
    schemaVersion: "tool-routing-trace/v1",
    caseId: "semantic-canonical",
    corpusId: "optimike-tool-routing-v1",
    corpusHash,
    gitSha: "91f52a06610811b34c1777b21b64ee257149e782",
    harness: { name: "fixture", version: "1.0.0" },
    model: { provider: "offline", name: "deterministic", version: "1" },
    modelConfig: { temperature: 0 },
    runtimeMode: "live",
    surface: "standard",
    runIndex: 0,
    fixtureHash: "a".repeat(64),
    events: [
      { sequence: 0, type: "tool_call", toolName: "smart_semantic_search" },
      { sequence: 1, type: "assistant_final" },
    ],
    success: true,
    successEvidence: [
      {
        kind: "fixture_assertion",
        detail: "Canonical search returned the expected fixture match.",
      },
    ],
    toolCount: 22,
    schemaBytes: 2048,
    inputTokens: 123,
    outputTokens: 45,
    costUsd: 0.001,
  };
  writeFileSync(strictResultsPath, `${JSON.stringify(strictTrace)}\n`, "utf8");
  const strictReport = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/score-tool-routing-evals.mjs", strictResultsPath],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  assert.equal(strictReport.strictTraceRuns, 1);
  assert.equal(strictReport.legacyTraceRuns, 0);
  assert.equal(strictReport.summaries[0].firstToolFamilyAccuracy, 1);
  assert.equal(strictReport.summaries[0].meanExposedToolCount, 22);
  assert.equal(strictReport.summaries[0].meanSchemaBytes, 2048);
  assert.equal(strictReport.summaries[0].meanCostUsd, 0.001);
  assert.equal(strictReport.summaries[0].clarificationAccuracy, "N/A");
  assert.equal(strictReport.summaries[0].unjustifiedClarificationRate, 0);

  writeFileSync(
    invalidResultsPath,
    `${JSON.stringify({ ...strictTrace, corpusHash: "b".repeat(64), toolCount: 2 })}\n`,
    "utf8",
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["scripts/score-tool-routing-evals.mjs", invalidResultsPath],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      ),
    (error) => String(error.stderr).includes("corpusHash"),
    "strict traces must fail closed when their reproducibility anchor drifts",
  );

  const clarificationCorpus = JSON.parse(corpusRaw);
  const transitionCase = clarificationCorpus.cases.find(
    (item) => item.id === "operon-transition",
  );
  transitionCase.clarificationExpectation = "before_mutation";
  const clarificationCorpusRaw = `${JSON.stringify(clarificationCorpus, null, 2)}\n`;
  writeFileSync(clarificationCorpusPath, clarificationCorpusRaw, "utf8");
  const mutationBeforeClarification = {
    ...strictTrace,
    caseId: "operon-transition",
    corpusHash: crypto
      .createHash("sha256")
      .update(clarificationCorpusRaw)
      .digest("hex"),
    surface: "tasks",
    events: [
      { sequence: 0, type: "tool_call", toolName: "operon_transition_task" },
      { sequence: 1, type: "clarification" },
      { sequence: 2, type: "assistant_final" },
    ],
    toolCount: 34,
  };
  writeFileSync(
    clarificationResultsPath,
    `${JSON.stringify(mutationBeforeClarification)}\n`,
    "utf8",
  );
  const clarificationReport = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "scripts/score-tool-routing-evals.mjs",
        clarificationResultsPath,
        clarificationCorpusPath,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  assert.equal(clarificationReport.summaries[0].clarificationAccuracy, 0);
  assert.equal(clarificationReport.summaries[0].safetyPassRate, 0);
  assert.equal(
    clarificationReport.failures[0].mutationBeforeClarification,
    true,
  );

  console.log(
    "PASS: routing eval scorer validates strict reproducible traces and distinguishes safety, family and cost signals",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
