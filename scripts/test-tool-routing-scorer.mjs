import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileToolProfileNames,
  TOOL_PROFILE_IDS,
} from "../dist/mcp-server/toolProfiles.js";
import { measureToolsList } from "./measure-tool-profile-schemas.mjs";

const temp = mkdtempSync(path.join(os.tmpdir(), "optimike-routing-score-"));
const corpusPath = path.join(
  process.cwd(),
  "evals",
  "tool-routing-corpus.json",
);
const corpusRaw = fs.readFileSync(corpusPath, "utf8");
const corpus = JSON.parse(corpusRaw);
const corpusHash = sha256(corpusRaw);
const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compactTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    required: [...(tool.inputSchema?.required ?? [])].sort(),
    properties: Object.keys(tool.inputSchema?.properties ?? {}).sort(),
  };
}

function profileCases(surface) {
  return corpus.cases.filter(
    (testCase) => surface === "full" || testCase.recommendedProfile === surface,
  );
}

function fixtureHash(surface, publicTools, cases) {
  return sha256(
    JSON.stringify({
      profile: surface,
      tools: publicTools.map(compactTool),
      cases: cases.map(({ id, prompt }) => ({ id, prompt })),
    }),
  );
}

function publicToolsFor(surface) {
  return compileToolProfileNames({
    profile: surface,
    registrationMode: "live",
    availableStaticRequirements: ["vault-cache"],
  })
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      description: `Fixture schema for ${name}`,
      inputSchema: { type: "object", properties: {} },
    }));
}

function buildCanonicalFixture() {
  const profiles = [];
  const traces = [];
  for (const surface of TOOL_PROFILE_IDS) {
    const cases = profileCases(surface);
    const publicTools = publicToolsFor(surface);
    const measurement = measureToolsList(publicTools);
    const surfaceFixtureHash = fixtureHash(surface, publicTools, cases);
    profiles.push({
      surface,
      caseIds: cases.map((testCase) => testCase.id),
      fixtureHash: surfaceFixtureHash,
      toolCount: measurement.toolCount,
      schemaBytes: measurement.toolSchemaBytes,
      toolsListSha256: measurement.toolsListSha256,
      publicTools,
    });
    for (let runIndex = 0; runIndex < 2; runIndex += 1) {
      for (const testCase of cases) {
        const events = [];
        if (testCase.clarificationExpectation !== "none") {
          events.push({ sequence: events.length, type: "clarification" });
        }
        const toolName = testCase.expectNoTool
          ? null
          : testCase.acceptableFirstTools[0];
        if (toolName) {
          events.push({ sequence: events.length, type: "tool_call", toolName });
        }
        events.push({ sequence: events.length, type: "assistant_final" });
        traces.push({
          schemaVersion: "tool-routing-trace/v1",
          caseId: testCase.id,
          corpusId: corpus.corpusId,
          corpusHash,
          gitSha: expectedCommit,
          harness: { name: "fixture", version: "1.0.0" },
          model: { provider: "offline", name: "deterministic", version: "1" },
          modelConfig: { temperature: 0 },
          runtimeMode: "live",
          surface,
          runIndex,
          fixtureHash: surfaceFixtureHash,
          events,
          success: true,
          successEvidence: [
            {
              kind: "fixture_assertion",
              detail: "Deterministic routing fixture passed.",
            },
          ],
          toolCount: measurement.toolCount,
          schemaBytes: measurement.toolSchemaBytes,
          toolsListSha256: measurement.toolsListSha256,
        });
      }
    }
  }
  return {
    traces,
    manifest: {
      schemaVersion: "tool-routing-run-manifest/v1",
      sourceCommit: expectedCommit,
      corpusId: corpus.corpusId,
      corpusHash,
      runtimeMode: "live",
      harness: { name: "fixture", version: "1.0.0" },
      model: { provider: "offline", name: "deterministic", version: "1" },
      modelConfig: { temperature: 0 },
      runsPerSurface: 2,
      traceCount: traces.length,
      traceFileSha256: "",
      profiles,
    },
  };
}

function writeFixture(name, fixture) {
  const tracesPath = path.join(temp, `${name}.jsonl`);
  const manifestPath = path.join(temp, `${name}.manifest.json`);
  const tracesRaw = `${fixture.traces
    .map((trace) => JSON.stringify(trace))
    .join("\n")}\n`;
  fixture.manifest.traceCount = fixture.traces.length;
  fixture.manifest.traceFileSha256 = sha256(tracesRaw);
  writeFileSync(tracesPath, tracesRaw, "utf8");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(fixture.manifest, null, 2)}\n`,
    "utf8",
  );
  return { tracesPath, manifestPath };
}

function score({ tracesPath, manifestPath }) {
  const args = ["scripts/score-tool-routing-evals.mjs", tracesPath];
  if (manifestPath) args.push(corpusPath, manifestPath);
  return JSON.parse(
    execFileSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, EXPECTED_COMMIT: expectedCommit },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function expectScoreFailure(paths, pattern, message) {
  assert.throws(
    () => score(paths),
    (error) => pattern.test(String(error.stderr)),
    message,
  );
}

try {
  const legacyPath = path.join(temp, "legacy.jsonl");
  writeFileSync(
    legacyPath,
    `${JSON.stringify({ id: "semantic-canonical", harness: "legacy", surface: "standard", toolsCalled: ["smart_semantic_search"], success: true })}\n`,
    "utf8",
  );
  const legacyReport = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/score-tool-routing-evals.mjs", legacyPath],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  assert.equal(legacyReport.legacyTraceRuns, 1);
  assert.equal(legacyReport.authority, null);

  const canonical = buildCanonicalFixture();
  const canonicalPaths = writeFixture("canonical", canonical);
  const report = score(canonicalPaths);
  assert.equal(report.evaluatedRuns, 120);
  assert.equal(report.strictTraceRuns, 120);
  assert.equal(report.legacyTraceRuns, 0);
  assert.equal(report.failures.length, 0);
  assert.equal(report.summaries.length, 4);
  assert.ok(report.summaries.every((summary) => summary.successRate === 1));
  assert.ok(report.summaries.every((summary) => summary.safetyPassRate === 1));

  const incompleteProfiles = structuredClone(canonical);
  incompleteProfiles.manifest.profiles.pop();
  expectScoreFailure(
    writeFixture("incomplete-profiles", incompleteProfiles),
    /canonical P6 profiles/u,
    "P6 scoring must require every canonical profile",
  );

  const missingTrace = structuredClone(canonical);
  missingTrace.traces.pop();
  expectScoreFailure(
    writeFixture("missing-trace", missingTrace),
    /strict trace matrix mismatch/u,
    "P6 scoring must reject selected or missing stochastic rows",
  );

  const wrongSurface = structuredClone(canonical);
  const standardProfile = wrongSurface.manifest.profiles.find(
    (profile) => profile.surface === "standard",
  );
  standardProfile.publicTools.pop();
  const wrongMeasurement = measureToolsList(standardProfile.publicTools);
  standardProfile.toolCount = wrongMeasurement.toolCount;
  standardProfile.schemaBytes = wrongMeasurement.toolSchemaBytes;
  standardProfile.toolsListSha256 = wrongMeasurement.toolsListSha256;
  standardProfile.fixtureHash = fixtureHash(
    "standard",
    standardProfile.publicTools,
    profileCases("standard"),
  );
  expectScoreFailure(
    writeFixture("wrong-surface", wrongSurface),
    /compiled live profile/u,
    "P6 scoring must bind public names to the compiled checkout profile",
  );

  const falseSuccess = structuredClone(canonical);
  falseSuccess.traces[0].success = false;
  expectScoreFailure(
    writeFixture("false-success", falseSuccess),
    /success does not match deterministic evidence/u,
    "strict success must be recomputed",
  );

  expectScoreFailure(
    { tracesPath: canonicalPaths.tracesPath },
    /verified run manifest/u,
    "strict traces must not score without a manifest",
  );

  const unsafe = structuredClone(canonical);
  const unsafeTrace = unsafe.traces.find(
    (trace) =>
      trace.surface === "tasks" &&
      trace.runIndex === 0 &&
      trace.caseId === "operon-create",
  );
  unsafeTrace.events = [
    { sequence: 0, type: "tool_call", toolName: "operon_create_task" },
    { sequence: 1, type: "clarification" },
    { sequence: 2, type: "assistant_final" },
  ];
  unsafeTrace.success = false;
  const unsafeReport = score(writeFixture("unsafe", unsafe));
  assert.equal(
    unsafeReport.failures.some(
      (failure) =>
        failure.id === "operon-create" &&
        failure.mutationBeforeClarification === true,
    ),
    true,
  );

  console.log(
    "PASS: routing eval scorer verifies the exact canonical P6 matrix, checkout profiles, strict evidence and safety",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
