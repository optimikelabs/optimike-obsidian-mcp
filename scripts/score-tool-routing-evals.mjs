#!/usr/bin/env node

import fs from "node:fs";

function usage() {
  console.error(
    "Usage: node scripts/score-tool-routing-evals.mjs <results.jsonl> [corpus.json]",
  );
  process.exit(2);
}

const resultsPath = process.argv[2];
if (!resultsPath) usage();
const corpusPath = process.argv[3] ?? new URL(
  "../evals/tool-routing-corpus.json",
  import.meta.url,
);

const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const cases = new Map(corpus.map((item) => [item.id, item]));
const lines = fs
  .readFileSync(resultsPath, "utf8")
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean);

if (lines.length === 0) {
  throw new Error("Routing eval results file is empty.");
}

const rows = lines.map((line, index) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
  }
  const testCase = cases.get(parsed.id);
  if (!testCase) throw new Error(`Unknown eval id at line ${index + 1}: ${parsed.id}`);
  if (!Array.isArray(parsed.toolsCalled)) {
    throw new Error(`toolsCalled must be an array for ${parsed.id}`);
  }

  const firstTool = parsed.toolsCalled[0] ?? null;
  const expectNoTool = testCase.expectNoTool === true;
  const firstCorrect = expectNoTool
    ? firstTool === null
    : testCase.acceptableFirstTools.includes(firstTool);
  const forbidden = new Set(testCase.forbiddenTools ?? []);
  const forbiddenCalls = parsed.toolsCalled.filter((name) => forbidden.has(name));
  const unnecessaryCalls = Math.max(
    0,
    parsed.toolsCalled.length - (expectNoTool ? 0 : 1),
  );

  return {
    ...parsed,
    harness: parsed.harness ?? "unknown",
    surface: parsed.surface ?? "unknown",
    success: parsed.success === true,
    firstTool,
    firstCorrect,
    forbiddenCalls,
    unnecessaryCalls,
  };
});

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

const groups = new Map();
for (const row of rows) {
  const key = `${row.harness}::${row.surface}`;
  const group = groups.get(key) ?? [];
  group.push(row);
  groups.set(key, group);
}

const summaries = [];
for (const [key, group] of groups) {
  const [harness, surface] = key.split("::");
  const latencies = group
    .map((row) => row.latencyMs)
    .filter((value) => Number.isFinite(value));
  const inputTokens = group
    .map((row) => row.inputTokens)
    .filter((value) => Number.isFinite(value));
  const forbiddenCount = group.filter((row) => row.forbiddenCalls.length > 0).length;

  summaries.push({
    harness,
    surface,
    runs: group.length,
    firstToolAccuracy: group.filter((row) => row.firstCorrect).length / group.length,
    successRate: group.filter((row) => row.success).length / group.length,
    forbiddenToolRate: forbiddenCount / group.length,
    meanToolCalls: mean(group.map((row) => row.toolsCalled.length)),
    meanUnnecessaryCalls: mean(group.map((row) => row.unnecessaryCalls)),
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    meanInputTokens: mean(inputTokens),
  });
}

summaries.sort((a, b) =>
  `${a.harness}::${a.surface}`.localeCompare(`${b.harness}::${b.surface}`),
);

console.log(JSON.stringify({
  corpusCases: corpus.length,
  evaluatedRuns: rows.length,
  summaries,
  failures: rows
    .filter((row) => !row.firstCorrect || row.forbiddenCalls.length > 0 || !row.success)
    .map((row) => ({
      id: row.id,
      harness: row.harness,
      surface: row.surface,
      firstTool: row.firstTool,
      forbiddenCalls: row.forbiddenCalls,
      success: row.success,
    })),
}, null, 2));
