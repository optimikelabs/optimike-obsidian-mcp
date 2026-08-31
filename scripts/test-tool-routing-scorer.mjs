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
import {
  measureCanonicalLiveProfileSchemas,
  measureToolsList,
} from "./measure-tool-profile-schemas.mjs";

const temp = mkdtempSync(path.join(os.tmpdir(), "optimike-routing-score-"));
const corpusPath = path.join(
  process.cwd(),
  "evals",
  "tool-routing-corpus.json",
);
const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();
const corpusRaw = execFileSync(
  "git",
  ["cat-file", "blob", `${expectedCommit}:evals/tool-routing-corpus.json`],
  { cwd: process.cwd(), encoding: "buffer" },
);
const corpus = JSON.parse(corpusRaw.toString("utf8"));
const corpusHash = sha256(corpusRaw);
const candidateCheckout = path.join(temp, "candidate-checkout");
execFileSync(
  "git",
  ["worktree", "add", "--detach", candidateCheckout, expectedCommit],
  { cwd: process.cwd(), stdio: "ignore" },
);
const nodeDirectory = path.dirname(process.execPath);
const npmCli =
  process.env.npm_execpath?.trim() ||
  (process.platform === "win32"
    ? path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js")
    : path.resolve(
        nodeDirectory,
        "..",
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ));
execFileSync(process.execPath, [npmCli, "ci", "--silent"], {
  cwd: candidateCheckout,
  stdio: "ignore",
});
const checkoutProfiles = new Map(
  (await measureCanonicalLiveProfileSchemas()).map((profile) => [
    profile.profile,
    profile,
  ]),
);

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

function caseContextHash(testCase) {
  return sha256(
    JSON.stringify(
      corpus.cases
        .filter(
          (candidate) =>
            candidate.recommendedProfile === testCase.recommendedProfile,
        )
        .map(({ id, prompt }) => ({ caseId: id, prompt })),
    ),
  );
}

function publicToolsFor(surface) {
  const expectedNames = compileToolProfileNames({
    profile: surface,
    registrationMode: "live",
    availableStaticRequirements: ["vault-cache"],
  }).sort((left, right) => left.localeCompare(right));
  const profile = checkoutProfiles.get(surface);
  assert.ok(profile, `missing checkout schema profile ${surface}`);
  assert.deepEqual(profile.toolNames, expectedNames);
  return structuredClone(profile.publicTools);
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
          caseContextHash: caseContextHash(testCase),
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

function score({ tracesPath, manifestPath, corpusInputPath = corpusPath }) {
  const args = ["scripts/score-tool-routing-evals.mjs", tracesPath];
  if (manifestPath) args.push(corpusInputPath, manifestPath);
  return JSON.parse(
    execFileSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_CANDIDATE_COMMIT: expectedCommit,
        P6_INTERNAL_CANDIDATE_CHECKOUT: candidateCheckout,
      },
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
  const immutableEvidence = {
    traces: sha256(fs.readFileSync(canonicalPaths.tracesPath)),
    manifest: sha256(fs.readFileSync(canonicalPaths.manifestPath)),
    corpus: sha256(fs.readFileSync(corpusPath)),
  };
  const report = score(canonicalPaths);
  assert.equal(report.evaluatedRuns, 120);
  assert.equal(report.strictTraceRuns, 120);
  assert.equal(report.legacyTraceRuns, 0);
  assert.equal(report.scorerSchemaVersion, "tool-routing-score/v2");
  assert.equal(report.scorerVersion, "2.0.0");
  assert.equal(report.authority.verifierSha, expectedCommit);
  assert.equal(report.authority.candidateSha, expectedCommit);
  assert.equal(
    report.authority.traceFileSha256,
    canonical.manifest.traceFileSha256,
  );
  assert.equal(report.authority.corpusSha256, corpusHash);
  assert.equal(report.authority.candidateSurfaceHashes.length, 4);
  assert.ok(
    report.authority.candidateSurfaceHashes.every((surface) =>
      /^[0-9a-f]{64}$/u.test(surface.toolsListSha256),
    ),
  );
  assert.equal(report.failures.length, 0);
  assert.equal(report.summaries.length, 4);
  assert.ok(report.summaries.every((summary) => summary.successRate === 1));
  assert.ok(report.summaries.every((summary) => summary.safetyPassRate === 1));

  const registryArtifact = path.join(
    candidateCheckout,
    "dist",
    "mcp-server",
    "toolSurfaceRegistry.js",
  );
  writeFileSync(registryArtifact, "throw new Error('foreign dist');\n", "utf8");
  const rebuiltForeignDist = score(canonicalPaths);
  assert.deepEqual(
    rebuiltForeignDist.authority.candidateSurfaceHashes,
    report.authority.candidateSurfaceHashes,
    "foreign dist must be removed and rebuilt before measurement",
  );

  rmSync(path.join(candidateCheckout, "dist"), {
    recursive: true,
    force: true,
  });
  const rebuiltMissingDist = score(canonicalPaths);
  assert.deepEqual(
    rebuiltMissingDist.authority.candidateSurfaceHashes,
    report.authority.candidateSurfaceHashes,
    "missing dist must be rebuilt before measurement",
  );

  const candidateReadme = path.join(candidateCheckout, "README.md");
  const candidateReadmeBytes = fs.readFileSync(candidateReadme);
  writeFileSync(
    candidateReadme,
    Buffer.concat([candidateReadmeBytes, Buffer.from("\nmodified\n")]),
  );
  expectScoreFailure(
    canonicalPaths,
    /candidate checkout must be clean/u,
    "dirty candidate worktrees must be rejected before build",
  );
  writeFileSync(candidateReadme, candidateReadmeBytes);

  const wrongCandidate = structuredClone(canonical);
  wrongCandidate.manifest.sourceCommit = execFileSync(
    "git",
    ["rev-parse", `${expectedCommit}^`],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  expectScoreFailure(
    writeFixture("wrong-candidate", wrongCandidate),
    /candidate checkout identifies|candidateSha/u,
    "historical source identity must not be reassigned by the verifier",
  );

  const differentCorpusPath = path.join(temp, "different-corpus.json");
  const differentCorpus = structuredClone(corpus);
  differentCorpus.cases[0].prompt += " changed";
  writeFileSync(
    differentCorpusPath,
    `${JSON.stringify(differentCorpus, null, 2)}\n`,
    "utf8",
  );
  expectScoreFailure(
    {
      ...canonicalPaths,
      corpusInputPath: differentCorpusPath,
    },
    /not semantically identical/u,
    "strict rescoring must bind the supplied corpus to the candidate Git blob",
  );

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

  const wrongSchema = structuredClone(canonical);
  const wrongSchemaProfile = wrongSchema.manifest.profiles.find(
    (profile) => profile.surface === "standard",
  );
  wrongSchemaProfile.publicTools[0].description += " altered";
  const wrongSchemaMeasurement = measureToolsList(
    wrongSchemaProfile.publicTools,
  );
  wrongSchemaProfile.toolCount = wrongSchemaMeasurement.toolCount;
  wrongSchemaProfile.schemaBytes = wrongSchemaMeasurement.toolSchemaBytes;
  wrongSchemaProfile.toolsListSha256 = wrongSchemaMeasurement.toolsListSha256;
  wrongSchemaProfile.fixtureHash = fixtureHash(
    "standard",
    wrongSchemaProfile.publicTools,
    profileCases("standard"),
  );
  for (const trace of wrongSchema.traces.filter(
    (trace) => trace.surface === "standard",
  )) {
    trace.fixtureHash = wrongSchemaProfile.fixtureHash;
    trace.toolCount = wrongSchemaProfile.toolCount;
    trace.schemaBytes = wrongSchemaProfile.schemaBytes;
    trace.toolsListSha256 = wrongSchemaProfile.toolsListSha256;
  }
  expectScoreFailure(
    writeFixture("wrong-schema", wrongSchema),
    /canonical tools\/list schemas/u,
    "P6 scoring must bind full public schemas to the exact checkout",
  );

  const falseSuccess = structuredClone(canonical);
  falseSuccess.traces[0].success = false;
  expectScoreFailure(
    writeFixture("false-success", falseSuccess),
    /success does not match deterministic evidence/u,
    "strict success must be recomputed",
  );

  const confoundedContext = structuredClone(canonical);
  confoundedContext.traces[0].caseContextHash = sha256("different cases");
  expectScoreFailure(
    writeFixture("confounded-context", confoundedContext),
    /canonical comparison context/u,
    "focused and full traces must preserve identical case context",
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

  assert.deepEqual(
    {
      traces: sha256(fs.readFileSync(canonicalPaths.tracesPath)),
      manifest: sha256(fs.readFileSync(canonicalPaths.manifestPath)),
      corpus: sha256(fs.readFileSync(corpusPath)),
    },
    immutableEvidence,
    "strict rescoring must not rewrite traces, manifest, or corpus",
  );

  console.log(
    "PASS: routing eval scorer verifies the exact canonical P6 matrix, checkout profiles, strict evidence and safety",
  );
} finally {
  try {
    execFileSync("git", ["worktree", "remove", "--force", candidateCheckout], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
  } catch {}
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
  } catch {}
  rmSync(temp, { recursive: true, force: true });
}
