#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE_IDS = ["standard", "authoring", "tasks", "full"];

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

function compactTool(tool) {
  const properties = Object.keys(tool.inputSchema?.properties ?? {}).sort();
  return {
    name: tool.name,
    description: tool.description ?? "",
    required: [...(tool.inputSchema?.required ?? [])].sort(),
    properties,
  };
}

function outputSchema(caseIds) {
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
            toolName: { type: ["string", "null"] },
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
    `CASES=${JSON.stringify(cases.map(({ id, prompt }) => ({ caseId: id, prompt })))}`,
  ].join("\n\n");
}

function codexCommand() {
  return process.platform === "win32" ? "codex.exe" : "codex";
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

function runModel({ profile, tools, cases, model, reasoningEffort, tempRoot }) {
  const caseIds = cases.map((testCase) => testCase.id);
  const schemaPath = path.join(tempRoot, `${profile}-schema.json`);
  const outputPath = path.join(tempRoot, `${profile}-output.json`);
  writeFileSync(schemaPath, JSON.stringify(outputSchema(caseIds)), "utf8");
  const result = spawnSync(
    codexCommand(),
    codexExecArgs({
      tempRoot,
      model,
      reasoningEffort,
      schemaPath,
      outputPath,
    }),
    {
      cwd: tempRoot,
      encoding: "utf8",
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
    if (
      !prompt.includes("obsidian_read_note") ||
      !prompt.includes("Read A.md") ||
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
  const harnessVersion = execFileSync(codexCommand(), ["--version"], {
    encoding: "utf8",
  }).trim();
  const tempRoot = mkdtempSync(
    path.join(os.tmpdir(), "optimike-p6-codex-routing-"),
  );
  const traces = [];
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
      const fixtureHash = sha256(
        JSON.stringify({
          profile,
          tools: profileMeasurement.publicTools.map(compactTool),
          cases: cases.map(({ id, prompt }) => ({ id, prompt })),
        }),
      );
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const output = runModel({
          profile,
          tools: profileMeasurement.publicTools,
          cases,
          model,
          reasoningEffort,
          tempRoot,
        });
        const choices = new Map(
          output.choices.map((choice) => [choice.caseId, choice]),
        );
        if (choices.size !== cases.length) {
          throw new Error(
            `${profile} run ${runIndex} did not return every case.`,
          );
        }
        for (const testCase of cases) {
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
          });
        }
      }
    }
    const outputPath = path.join(
      os.tmpdir(),
      `optimike-p6-routing-${sourceCommit.slice(0, 12)}.jsonl`,
    );
    writeFileSync(
      outputPath,
      `${traces.map((trace) => JSON.stringify(trace)).join("\n")}\n`,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, sourceCommit, runsPerSurface: runs, traces: traces.length, outputPath }, null, 2)}\n`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
