import assert from "node:assert/strict";
import fs from "node:fs";

const rubric = JSON.parse(
  fs.readFileSync(
    new URL("../evals/tool-routing-judge-rubric.json", import.meta.url),
    "utf8",
  ),
);

assert.equal(rubric.schemaVersion, "tool-routing-judge-rubric/v1");
assert.equal(rubric.execution.mode, "data-only");
assert.equal(rubric.execution.providerCallsProhibited, true);
assert.deepEqual(
  rubric.criteria.map((criterion) => criterion.id),
  [
    "task-success-evidence",
    "routing-and-family",
    "safety-and-recovery",
    "clarification-discipline",
  ],
);
assert.ok(
  Math.abs(
    rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0) -
      1,
  ) < 1e-12,
  "judge rubric weights must remain deterministic",
);
assert.ok(rubric.outputContract.required.includes("evidenceRefs"));
assert.ok(rubric.inputContract.forbidden.includes("provider-side tool calls"));

console.log("PASS: tool-routing judge rubric is a provider-free data contract");
