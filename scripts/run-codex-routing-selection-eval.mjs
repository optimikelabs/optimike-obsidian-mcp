#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE_IDS = ["standard", "authoring", "tasks", "full"];
const CODEX_ENV_ALLOWLIST = [
  "APPDATA",
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function option(name, fallback) {
  return (
    process.argv
      .find((argument) => argument.startsWith(`--${name}=`))
      ?.slice(name.length + 3) ?? fallback
  );
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function assertCleanExactCandidate() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (status.trim()) {
    throw new Error("Routing selection eval requires a clean exact candidate.");
  }
  const commit = currentCommit();
  const expected = process.env.EXPECTED_COMMIT?.trim();
  if (!expected || commit !== expected) {
    throw new Error(
      `EXPECTED_COMMIT must equal the exact candidate ${commit}.`,
    );
  }
  return commit;
}

function exactBuildSteps(repoRoot = process.cwd()) {
  return [
    [
      process.execPath,
      [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc")],
    ],
    [
      process.execPath,
      [
        path.join(repoRoot, "scripts", "make-executable.mjs"),
        path.join(repoRoot, "dist", "index.js"),
        path.join(repoRoot, "dist", "stdio-proxy.js"),
      ],
    ],
  ];
}

function buildExactCandidate(sourceCommit) {
  for (const [command, args] of exactBuildSteps()) {
    execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const afterCommit = currentCommit();
  const afterStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  if (afterCommit !== sourceCommit || afterStatus) {
    throw new Error(
      "Exact candidate changed while rebuilding routing evaluation artifacts.",
    );
  }
}

function compactTool(tool) {
  const properties = Object.keys(tool.inputSchema?.properties ?? {}).sort();
  return {
    name: tool.name,
    description: tool.description ?? "",
    required: [...(tool.inputSchema?.required ?? [])].sort(),
    properties,
  };
}

function codexSubprocessEnvironment(source = process.env) {
  const environment = { CI: "1", NO_COLOR: "1" };
  for (const name of CODEX_ENV_ALLOWLIST) {
    if (typeof source[name] === "string" && source[name] !== "") {
      environment[name] = source[name];
    }
  }
  return environment;
}

function compactCases(cases) {
  return cases.map(({ id, prompt }) => ({ caseId: id, prompt }));
}

function caseContextHash(cases) {
  return sha256(JSON.stringify(compactCases(cases)));
}

function profileCaseBatches(profile, corpusCases) {
  if (profile !== "full") {
    return [
      {
        id: profile,
        cases: corpusCases.filter(
          (testCase) => testCase.recommendedProfile === profile,
        ),
      },
    ];
  }
  return PROFILE_IDS.map((profileId) => ({
    id: profileId,
    cases: corpusCases.filter(
      (testCase) => testCase.recommendedProfile === profileId,
    ),
  })).filter((batch) => batch.cases.length > 0);
}

function outputSchema(caseIds, toolNames) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["choices"],
    properties: {
      choices: {
        type: "array",
        minItems: caseIds.length,
        maxItems: caseIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["caseId", "toolName", "clarificationBeforeTool"],
          properties: {
            caseId: { type: "string", enum: caseIds },
            toolName: { enum: [null, ...toolNames] },
            clarificationBeforeTool: { type: "boolean" },
          },
        },
      },
    },
  };
}

function promptFor(profile, tools, cases) {
  return [
    "You are evaluating first-tool routing for an MCP surface.",
    "Do not call tools, inspect files, use the shell, or explain your choices.",
    "For every case, select exactly one first tool from AVAILABLE_TOOLS, or null when no tool should be called.",
    "Set clarificationBeforeTool=true only when the request is materially ambiguous and a user answer is required before that first tool.",
    "Return only the JSON object required by the supplied response schema.",
    `PROFILE=${profile}`,
    `AVAILABLE_TOOLS=${JSON.stringify(tools.map(compactTool))}`,
    `CASES=${JSON.stringify(compactCases(cases))}`,
  ].join("\n\n");
}

function codexEntrypointFromWindowsShim(shimPath) {
  return path.join(
    path.dirname(shimPath),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
}

function codexInvocation() {
  if (process.platform !== "win32") {
    return { command: "codex", prefixArgs: [] };
  }
  // Resolve the npm shim explicitly: a stale standalone codex.exe can shadow
  // the current npm package in the same directory, while Node cannot spawn a
  // .cmd file directly without introducing a shell.
  const shimPath = execFileSync("where.exe", ["codex.cmd"], {
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find(Boolean);
  if (!shimPath) throw new Error("Unable to locate the Codex npm shim.");
  const entrypoint = codexEntrypointFromWindowsShim(shimPath);
  if (!existsSync(entrypoint)) {
    throw new Error(`Codex npm entrypoint is missing at ${entrypoint}.`);
  }
  return { command: process.execPath, prefixArgs: [entrypoint] };
}

function codexExecArgs({
  tempRoot,
  model,
  reasoningEffort,
  schemaPath,
  outputPath,
}) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-C",
    tempRoot,
    "-s",
    "read-only",
    "-m",
    model,
    "-c",
    'approval_policy="never"',
    "-c",
    `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ];
}

function runModel({
  profile,
  batchId,
  tools,
  cases,
  model,
  reasoningEffort,
  tempRoot,
}) {
  const caseIds = cases.map((testCase) => testCase.id);
  const schemaPath = path.join(tempRoot, `${profile}-${batchId}-schema.json`);
  const outputPath = path.join(tempRoot, `${profile}-${batchId}-output.json`);
  writeFileSync(
    schemaPath,
    JSON.stringify(
      outputSchema(
        caseIds,
        tools.map((tool) => tool.name),
      ),
    ),
    "utf8",
  );
  const invocation = codexInvocation();
  const result = spawnSync(
    invocation.command,
    [
      ...invocation.prefixArgs,
      ...codexExecArgs({
        tempRoot,
        model,
        reasoningEffort,
        schemaPath,
        outputPath,
      }),
    ],
    {
      cwd: tempRoot,
      encoding: "utf8",
      env: codexSubprocessEnvironment(),
      input: promptFor(profile, tools, cases),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Codex routing run failed for ${profile}: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

function traceEvents(choice) {
  const events = [];
  if (choice.clarificationBeforeTool) {
    events.push({ sequence: events.length, type: "clarification" });
  }
  if (choice.toolName) {
    events.push({
      sequence: events.length,
      type: "tool_call",
      toolName: choice.toolName,
    });
  }
  events.push({ sequence: events.length, type: "assistant_final" });
  return events;
}

function selectionIsExposed(choice, toolNames) {
  return choice.toolName === null || toolNames.has(choice.toolName);
}

function createEvidenceRoot(sourceCommit) {
  return mkdtempSync(
    path.join(os.tmpdir(), `optimike-p6-routing-${sourceCommit.slice(0, 12)}-`),
  );
}

async function main() {
  if (process.argv.includes("--offline-contract")) {
    const prompt = promptFor(
      "standard",
      [
        {
          name: "obsidian_read_note",
          description: "Read one note",
          inputSchema: { properties: { path: {} }, required: ["path"] },
        },
      ],
      [{ id: "read", prompt: "Read A.md" }],
    );
    const args = codexExecArgs({
      tempRoot: "TEMP",
      model: "MODEL",
      reasoningEffort: "high",
      schemaPath: "SCHEMA",
      outputPath: "OUTPUT",
    });
    const schema = outputSchema(["read"], ["obsidian_read_note"]);
    const sanitizedEnvironment = codexSubprocessEnvironment({
      PATH: "safe-path",
      HOME: "safe-home",
      OBSIDIAN_API_KEY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      OBSIDIAN_VAULT: "must-not-leak",
    });
    const comparisonCases = [
      { id: "standard-a", prompt: "A", recommendedProfile: "standard" },
      { id: "tasks-a", prompt: "B", recommendedProfile: "tasks" },
    ];
    const fullBatches = profileCaseBatches("full", comparisonCases);
    const standardBatch = profileCaseBatches("standard", comparisonCases)[0];
    const buildSteps = exactBuildSteps("REPO");
    const toolNameEnum =
      schema.properties.choices.items.properties.toolName.enum;
    const firstEvidenceRoot = createEvidenceRoot("a".repeat(40));
    const secondEvidenceRoot = createEvidenceRoot("a".repeat(40));
    const uniqueEvidenceRoots = firstEvidenceRoot !== secondEvidenceRoot;
    rmSync(firstEvidenceRoot, { recursive: true, force: true });
    rmSync(secondEvidenceRoot, { recursive: true, force: true });
    if (
      !prompt.includes("obsidian_read_note") ||
      !prompt.includes("Read A.md") ||
      !toolNameEnum.includes(null) ||
      !toolNameEnum.includes("obsidian_read_note") ||
      toolNameEnum.length !== 2 ||
      !uniqueEvidenceRoots ||
      sanitizedEnvironment.PATH !== "safe-path" ||
      sanitizedEnvironment.HOME !== "safe-home" ||
      "OBSIDIAN_API_KEY" in sanitizedEnvironment ||
      "OPENAI_API_KEY" in sanitizedEnvironment ||
      "OBSIDIAN_VAULT" in sanitizedEnvironment ||
      fullBatches.length !== 2 ||
      caseContextHash(fullBatches[0].cases) !==
        caseContextHash(standardBatch.cases) ||
      buildSteps.length !== 2 ||
      !buildSteps[0][1][0].endsWith(
        path.join("node_modules", "typescript", "bin", "tsc"),
      ) ||
      !buildSteps[1][1][0].endsWith(
        path.join("scripts", "make-executable.mjs"),
      ) ||
      !codexEntrypointFromWindowsShim("C:\\npm\\codex.cmd").endsWith(
        path.join("@openai", "codex", "bin", "codex.js"),
      ) ||
      args.includes("-a") ||
      !args.includes('approval_policy="never"') ||
      selectionIsExposed(
        { toolName: "invented_hidden_tool" },
        new Set(["obsidian_read_note"]),
      )
    ) {
      throw new Error("Offline routing prompt contract failed.");
    }
    process.stdout.write("PASS: Codex routing selection harness contract\n");
    return;
  }

  const sourceCommit = assertCleanExactCandidate();
  buildExactCandidate(sourceCommit);
  const runs = Number(option("runs", "2"));
  if (!Number.isInteger(runs) || runs < 2 || runs > 5) {
    throw new Error("--runs must be an integer from 2 to 5.");
  }
  const model = option("model", "gpt-5.6-luna");
  const reasoningEffort = option("reasoning", "high");
  const corpusPath = path.join(
    process.cwd(),
    "evals",
    "tool-routing-corpus.json",
  );
  const corpusRaw = readFileSync(corpusPath);
  const corpus = JSON.parse(corpusRaw.toString("utf8"));
  const measurement = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "scripts/measure-tool-profile-schemas.mjs",
        "--require-live",
        "--include-public-schemas",
      ],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  if (measurement.sourceCommit !== sourceCommit) {
    throw new Error("Schema measurement and candidate commit differ.");
  }
  const invocation = codexInvocation();
  const harnessVersion = execFileSync(
    invocation.command,
    [...invocation.prefixArgs, "--version"],
    {
      encoding: "utf8",
    },
  ).trim();
  const tempRoot = mkdtempSync(
    path.join(os.tmpdir(), "optimike-p6-codex-routing-"),
  );
  const traces = [];
  const profileFixtures = [];
  try {
    for (const profile of PROFILE_IDS) {
      const profileMeasurement = measurement.profiles.find(
        (item) => item.profile === profile,
      );
      const cases =
        profile === "full"
          ? corpus.cases
          : corpus.cases.filter(
              (testCase) => testCase.recommendedProfile === profile,
            );
      const toolNames = new Set(
        profileMeasurement.publicTools.map((tool) => tool.name),
      );
      const caseBatches = profileCaseBatches(profile, corpus.cases);
      const fixtureHash = sha256(
        JSON.stringify({
          profile,
          tools: profileMeasurement.publicTools.map(compactTool),
          cases: cases.map(({ id, prompt }) => ({ id, prompt })),
        }),
      );
      profileFixtures.push({
        surface: profile,
        caseIds: cases.map((testCase) => testCase.id),
        fixtureHash,
        toolCount: profileMeasurement.toolCount,
        schemaBytes: profileMeasurement.toolSchemaBytes,
        toolsListSha256: profileMeasurement.toolsListSha256,
        publicTools: profileMeasurement.publicTools,
      });
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        for (const batch of caseBatches) {
          const output = runModel({
            profile,
            batchId: batch.id,
            tools: profileMeasurement.publicTools,
            cases: batch.cases,
            model,
            reasoningEffort,
            tempRoot,
          });
          const choices = new Map(
            output.choices.map((choice) => [choice.caseId, choice]),
          );
          if (choices.size !== batch.cases.length) {
            throw new Error(
              `${profile}/${batch.id} run ${runIndex} did not return every case.`,
            );
          }
          for (const testCase of batch.cases) {
            const choice = choices.get(testCase.id);
            if (!choice) throw new Error(`Missing choice for ${testCase.id}.`);
            const selectedExposedTool = selectionIsExposed(choice, toolNames);
            const expectNoTool = testCase.expectNoTool === true;
            const routeCorrect = expectNoTool
              ? choice.toolName === null
              : selectedExposedTool &&
                testCase.acceptableFirstTools.includes(choice.toolName);
            const clarificationCorrect =
              testCase.clarificationExpectation === "none"
                ? choice.clarificationBeforeTool === false
                : choice.clarificationBeforeTool === true;
            traces.push({
              schemaVersion: "tool-routing-trace/v1",
              caseId: testCase.id,
              corpusId: corpus.corpusId,
              corpusHash: sha256(corpusRaw),
              gitSha: sourceCommit,
              harness: { name: "codex-cli-selection", version: harnessVersion },
              model: { provider: "openai", name: model, version: model },
              modelConfig: { reasoningEffort },
              runtimeMode: measurement.runtimeMode,
              surface: profile,
              runIndex,
              fixtureHash,
              caseContextHash: caseContextHash(batch.cases),
              events: traceEvents(choice),
              success:
                selectedExposedTool && routeCorrect && clarificationCorrect,
              successEvidence: [
                {
                  kind: "routing_fixture_assertion",
                  detail:
                    "The selected public first tool and clarification decision were checked against the immutable corpus case.",
                },
                {
                  kind: "tool_exposure_assertion",
                  detail: selectedExposedTool
                    ? "The selected tool was present in the measured tools/list surface."
                    : `The model selected hidden tool ${choice.toolName}.`,
                },
              ],
              toolCount: profileMeasurement.toolCount,
              schemaBytes: profileMeasurement.toolSchemaBytes,
              toolsListSha256: profileMeasurement.toolsListSha256,
            });
          }
        }
      }
    }
    const evidenceRoot = createEvidenceRoot(sourceCommit);
    const outputPath = path.join(evidenceRoot, "traces.jsonl");
    const manifestPath = path.join(evidenceRoot, "manifest.json");
    const tracesRaw = `${traces
      .map((trace) => JSON.stringify(trace))
      .join("\n")}\n`;
    const temporaryOutputPath = `${outputPath}.tmp`;
    writeFileSync(temporaryOutputPath, tracesRaw, "utf8");
    renameSync(temporaryOutputPath, outputPath);
    const manifest = {
      schemaVersion: "tool-routing-run-manifest/v1",
      sourceCommit,
      corpusId: corpus.corpusId,
      corpusHash: sha256(corpusRaw),
      runtimeMode: measurement.runtimeMode,
      harness: { name: "codex-cli-selection", version: harnessVersion },
      model: { provider: "openai", name: model, version: model },
      modelConfig: { reasoningEffort },
      runsPerSurface: runs,
      traceCount: traces.length,
      traceFileSha256: sha256(tracesRaw),
      profiles: profileFixtures,
    };
    const temporaryManifestPath = `${manifestPath}.tmp`;
    const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(temporaryManifestPath, manifestRaw, "utf8");
    renameSync(temporaryManifestPath, manifestPath);
    process.stdout.write(
      `${JSON.stringify({ ok: true, sourceCommit, runsPerSurface: runs, traces: traces.length, outputPath, manifestPath, manifestSha256: sha256(manifestRaw) }, null, 2)}\n`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
