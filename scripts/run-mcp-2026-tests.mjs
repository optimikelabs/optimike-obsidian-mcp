#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const mode = process.argv[2] ?? "modern";
assert.ok(
  ["modern", "all", "benchmark-modern"].includes(mode),
  "Unsupported qualification mode",
);
const output = path.resolve(
  process.env.MCP_EVIDENCE_DIR ??
    path.join(os.tmpdir(), "optimike-mcp-evidence"),
);
await mkdir(output, { recursive: true });
const modern = [
  "test-mcp-schema-compatibility.mjs",
  "test-mcp-2026-http.mjs",
  "test-mcp-2026-version-review.mjs",
  "test-mcp-2026-stdio.mjs",
  "test-mcp-2026-backpressure.mjs",
  "test-mcp-2026-proxy.mjs",
  "test-mcp-2026-governed-loss.mjs",
];
const jobs = [];
// These are separately required repository gates, never counted as local PASS.
const delegatedGates = [
  { script: "test-agentgateway-compatibility.mjs", owner: "MCP 2026 dual-stack / gateway (Linux)" },
  { script: "test-tool-routing-scorer.mjs", owner: "P6 Tool Routing Evaluation / Linux" },
];
if (mode === "all") {
  for (const file of (await readdir("scripts"))
    .filter((f) => /^test-.*\.mjs$/.test(f) && !modern.includes(f))
    .sort()) {
    // Match the repository's existing ownership: gateway and the expensive
    // clean-checkout scorer have one authoritative Linux gate. The scorer's
    // many nested npm installs exceed this runner's per-script budget and are
    // intentionally not duplicated on Windows (see the existing P6 workflow).
    if (delegatedGates.some(gate => gate.script === file)) continue;
    jobs.push({ label: file, file, env: { MCP_PROTOCOL_MODE: "legacy" } });
  }
}
if (mode !== "benchmark-modern") {
  jobs.push(...modern.map((file) => ({ label: file, file })));
  for (const file of [
    "test-governed-note-replace-mcp.mjs",
    "test-governed-note-replace-http.mjs",
  ]) {
    jobs.push({
      label: "modern-" + file,
      file,
      env: { MCP_TEST_PROTOCOL_ERA: "modern", MCP_PROTOCOL_MODE: "dual" },
    });
  }
}
for (const protocolEra of mode === "benchmark-modern"
  ? ["modern"]
  : ["legacy", "modern"]) {
  jobs.push({
    label: "benchmark-" + protocolEra,
    file: "benchmark-vnext-e2e.mjs",
    args: [path.join(output, "benchmark-" + protocolEra + ".json")],
    env: { MCP_BENCHMARK_PROTOCOL_ERA: protocolEra },
  });
}
const results = [];
for (const job of jobs) {
  const logfile = await open(path.join(output, job.label + ".log"), "w");
  const args = [
    ...(job.file === "test-vnext-retrieval.mjs" ? ["--test"] : []),
    "scripts/" + job.file,
    ...(job.args ?? []),
  ];
  const started = Date.now();
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", logfile.fd, logfile.fd],
    env: { ...process.env, MCP_PROTOCOL_MODE: "legacy", ...job.env },
  });
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    child.kill("SIGKILL");
  }, 180_000);
  const code = await new Promise((resolve) => {
    child.once("error", () => resolve("spawn-error"));
    child.once("exit", (code, signal) => resolve(code ?? signal));
  });
  clearTimeout(timer);
  await logfile.close();
  const result = {
    label: job.label,
    code,
    timeout,
    elapsedMs: Date.now() - started,
  };
  results.push(result);
  await writeFile(
    path.join(output, "results-" + mode + ".json"),
    JSON.stringify(
      { mode, platform: process.platform, node: process.version, delegatedGates, results },
      null,
      2,
    ),
  );
  console.log(
    `${code === 0 ? "PASS" : "FAIL"} ${job.label} (${result.elapsedMs} ms)`,
  );
}
if (results.some((result) => result.code !== 0)) process.exitCode = 1;
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.code === 0).length,
    total: results.length,
    delegatedGates,
    output,
  }),
);
