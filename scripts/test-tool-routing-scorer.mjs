import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureToolsList } from "./measure-tool-profile-schemas.mjs";

const temp = mkdtempSync(path.join(os.tmpdir(), "optimike-routing-score-"));
const resultsPath = path.join(temp, "results.jsonl");
const strictResultsPath = path.join(temp, "strict-results.jsonl");
const invalidResultsPath = path.join(temp, "invalid-results.jsonl");
const clarificationCorpusPath = path.join(temp, "clarification-corpus.json");
const clarificationResultsPath = path.join(temp, "clarification-results.jsonl");
const strictManifestPath = path.join(temp, "strict-manifest.json");
const tamperedManifestPath = path.join(temp, "tampered-manifest.json");
const invalidManifestPath = path.join(temp, "invalid-manifest.json");
const clarificationManifestPath = path.join(
  temp,
  "clarification-manifest.json",
);
const corpusPath = path.join(
  process.cwd(),
  "evals",
  "tool-routing-corpus.json",
);
const corpusRaw = fs.readFileSync(corpusPath, "utf8");
const corpusHash = crypto.createHash("sha256").update(corpusRaw).digest("hex");
const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();

function fixtureHash(surface, publicTools, corpus, caseIds) {
  const caseIdSet = new Set(caseIds);
  const cases = corpus.cases.filter((item) => caseIdSet.has(item.id));
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        profile: surface,
        tools: publicTools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          required: [...(tool.inputSchema?.required ?? [])].sort(),
          properties: Object.keys(tool.inputSchema?.properties ?? {}).sort(),
        })),
        cases: cases.map(({ id, prompt }) => ({ id, prompt })),
      }),
    )
    .digest("hex");
}

function writeManifest({
  tracePath,
  manifestPath,
  corpus,
  corpusHashValue,
  surface,
  publicTools,
}) {
  const measurement = measureToolsList(publicTools);
  const traceRaw = fs.readFileSync(tracePath, "utf8");
  const traceRows = traceRaw
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const caseIds = [...new Set(traceRows.map((trace) => trace.caseId))];
  const manifest = {
    schemaVersion: "tool-routing-run-manifest/v1",
    sourceCommit: expectedCommit,
    corpusId: corpus.corpusId,
    corpusHash: corpusHashValue,
    runtimeMode: "live",
    harness: { name: "fixture", version: "1.0.0" },
    model: { provider: "offline", name: "deterministic", version: "1" },
    modelConfig: { temperature: 0 },
    runsPerSurface: 1,
    traceCount: traceRows.length,
    traceFileSha256: crypto.createHash("sha256").update(traceRaw).digest("hex"),
    profiles: [
      {
        surface,
        caseIds,
        fixtureHash: fixtureHash(surface, publicTools, corpus, caseIds),
        toolCount: measurement.toolCount,
        schemaBytes: measurement.toolSchemaBytes,
        toolsListSha256: measurement.toolsListSha256,
        publicTools,
      },
    ],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest.profiles[0];
}

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
    full.meanCallsAboveMinimum,
    0.5,
    "the scorer reports only calls above the declared minimum",
  );
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].firstTool, "obsidian_runtime_maintenance");
  assert.equal(full.firstToolFamilyAccuracy, 1);

  const strictCorpus = JSON.parse(corpusRaw);
  const strictPublicTools = [
    {
      name: "smart_semantic_search",
      description: "Semantic search",
      inputSchema: { type: "object", properties: { query: {} } },
    },
  ];
  const strictMeasurement = measureToolsList(strictPublicTools);
  const strictFixtureHash = fixtureHash(
    "standard",
    strictPublicTools,
    strictCorpus,
    ["semantic-canonical"],
  );
  const strictTrace = {
    schemaVersion: "tool-routing-trace/v1",
    caseId: "semantic-canonical",
    corpusId: "optimike-tool-routing-v1",
    corpusHash,
    gitSha: expectedCommit,
    harness: { name: "fixture", version: "1.0.0" },
    model: { provider: "offline", name: "deterministic", version: "1" },
    modelConfig: { temperature: 0 },
    runtimeMode: "live",
    surface: "standard",
    runIndex: 0,
    fixtureHash: strictFixtureHash,
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
    toolCount: strictMeasurement.toolCount,
    schemaBytes: strictMeasurement.toolSchemaBytes,
    toolsListSha256: strictMeasurement.toolsListSha256,
    inputTokens: 123,
    outputTokens: 45,
    costUsd: 0.001,
  };
  writeFileSync(strictResultsPath, `${JSON.stringify(strictTrace)}\n`, "utf8");
  writeManifest({
    tracePath: strictResultsPath,
    manifestPath: strictManifestPath,
    corpus: strictCorpus,
    corpusHashValue: corpusHash,
    surface: "standard",
    publicTools: strictPublicTools,
  });
  const strictReport = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "scripts/score-tool-routing-evals.mjs",
        strictResultsPath,
        corpusPath,
        strictManifestPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, EXPECTED_COMMIT: expectedCommit },
      },
    ),
  );
  assert.equal(strictReport.strictTraceRuns, 1);
  assert.equal(strictReport.legacyTraceRuns, 0);
  assert.equal(strictReport.summaries[0].firstToolFamilyAccuracy, 1);
  assert.equal(
    strictReport.summaries[0].meanExposedToolCount,
    strictMeasurement.toolCount,
  );
  assert.equal(
    strictReport.summaries[0].meanSchemaBytes,
    strictMeasurement.toolSchemaBytes,
  );
  assert.equal(strictReport.summaries[0].meanCostUsd, 0.001);
  assert.equal(strictReport.summaries[0].clarificationAccuracy, "N/A");
  assert.equal(strictReport.summaries[0].unjustifiedClarificationRate, 0);
  const tamperedManifest = JSON.parse(
    fs.readFileSync(strictManifestPath, "utf8"),
  );
  tamperedManifest.profiles[0].toolCount += 1;
  writeFileSync(
    tamperedManifestPath,
    `${JSON.stringify(tamperedManifest, null, 2)}\n`,
    "utf8",
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "scripts/score-tool-routing-evals.mjs",
          strictResultsPath,
          corpusPath,
          tamperedManifestPath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, EXPECTED_COMMIT: expectedCommit },
        },
      ),
    (error) => String(error.stderr).includes("publicTools bytes"),
    "strict scoring must recompute surface measurements from the manifest schemas",
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["scripts/score-tool-routing-evals.mjs", strictResultsPath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, EXPECTED_COMMIT: expectedCommit },
        },
      ),
    (error) => String(error.stderr).includes("verified run manifest"),
    "strict traces must not score without their exact-SHA surface manifest",
  );

  writeFileSync(
    invalidResultsPath,
    `${JSON.stringify({ ...strictTrace, corpusHash: "b".repeat(64) })}\n`,
    "utf8",
  );
  writeManifest({
    tracePath: invalidResultsPath,
    manifestPath: invalidManifestPath,
    corpus: strictCorpus,
    corpusHashValue: corpusHash,
    surface: "standard",
    publicTools: strictPublicTools,
  });
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "scripts/score-tool-routing-evals.mjs",
          invalidResultsPath,
          corpusPath,
          invalidManifestPath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, EXPECTED_COMMIT: expectedCommit },
        },
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
  const clarificationCorpusHash = crypto
    .createHash("sha256")
    .update(clarificationCorpusRaw)
    .digest("hex");
  const clarificationPublicTools = [
    {
      name: "operon_transition_task",
      description: "Transition one task",
      inputSchema: { type: "object", properties: { taskId: {} } },
    },
  ];
  const clarificationMeasurement = measureToolsList(clarificationPublicTools);
  const mutationBeforeClarification = {
    ...strictTrace,
    caseId: "operon-transition",
    corpusHash: clarificationCorpusHash,
    surface: "tasks",
    fixtureHash: fixtureHash(
      "tasks",
      clarificationPublicTools,
      clarificationCorpus,
      ["operon-transition"],
    ),
    events: [
      { sequence: 0, type: "tool_call", toolName: "operon_transition_task" },
      { sequence: 1, type: "clarification" },
      { sequence: 2, type: "assistant_final" },
    ],
    success: false,
    toolCount: clarificationMeasurement.toolCount,
    schemaBytes: clarificationMeasurement.toolSchemaBytes,
    toolsListSha256: clarificationMeasurement.toolsListSha256,
  };
  writeFileSync(
    clarificationResultsPath,
    `${JSON.stringify(mutationBeforeClarification)}\n`,
    "utf8",
  );
  writeManifest({
    tracePath: clarificationResultsPath,
    manifestPath: clarificationManifestPath,
    corpus: clarificationCorpus,
    corpusHashValue: clarificationCorpusHash,
    surface: "tasks",
    publicTools: clarificationPublicTools,
  });
  const clarificationReport = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "scripts/score-tool-routing-evals.mjs",
        clarificationResultsPath,
        clarificationCorpusPath,
        clarificationManifestPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, EXPECTED_COMMIT: expectedCommit },
      },
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
