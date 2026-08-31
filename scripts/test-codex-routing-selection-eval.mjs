import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const output = execFileSync(
  process.execPath,
  ["scripts/run-codex-routing-selection-eval.mjs", "--offline-contract"],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.match(output, /PASS: Codex routing selection harness contract/u);

console.log(
  "PASS: optional Codex routing selection harness stays offline in CI",
);
