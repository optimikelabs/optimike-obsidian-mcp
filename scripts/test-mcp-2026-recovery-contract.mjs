import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const temporary = ["mcp-2026-import.yml", "mcp-2026-qualification.yml", "mcp-online-snapshot.yml"];
function validate(workflow, present) {
  for (const name of temporary) assert.equal(present(name), false, `temporary workflow retained: ${name}`);
  const job = workflow.jobs.matrix;
  assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
  assert.equal(JSON.stringify(job.env ?? {}).includes("runner."), false, "runner context is unavailable in job env");
  const test = job.steps.find(step => step.run === "npm run test:mcp-2026:all");
  assert.ok(test, "complete protocol/legacy/P0 gate is mandatory");
  assert.equal(test.env.MCP_EVIDENCE_DIR, "${{ runner.temp }}/mcp-2026-evidence");
  assert.ok(job.steps.some(step => step.name === "Record exact candidate"));
  assert.ok(job.steps.some(step => step.uses === "actions/checkout@v4" && step.with.ref.includes("head.sha")));
  assert.ok(workflow.jobs.gateway, "gateway regression gate is mandatory");
}
const workflow = parse(readFileSync(".github/workflows/mcp-2026-dual-stack.yml", "utf8"));
validate(workflow, name => existsSync(`.github/workflows/${name}`));
assert.throws(() => validate(workflow, () => true), /temporary workflow/);
const missing = structuredClone(workflow);
missing.jobs.matrix.steps = missing.jobs.matrix.steps.filter(step => step.run !== "npm run test:mcp-2026:all");
assert.throws(() => validate(missing, () => false), /mandatory/);
const invalid = structuredClone(workflow);
invalid.jobs.matrix.env = { EVIDENCE: "${{ runner.temp }}" };
assert.throws(() => validate(invalid, () => false), /runner context/);
const checkpoint = readFileSync("docs/mcp-2026-CHECKPOINT.md", "utf8");
assert.ok(checkpoint.includes("4e59b8ec28d01b8ccde8c04e1b8f53ea1dd13c78"));
assert.ok(checkpoint.includes("NOT_RUN"));
assert.ok(checkpoint.includes("Read main"));
console.log("PASS: checkpoint/CI recovery contract and negative gates; no temporary transfer/import workflows");
