#!/usr/bin/env node

// bases_check over every Base: Bases are checked one at a time within a time
// budget; Bases left past it are named, never counted healthy. A Base with
// more rows than the engine sample says how many rows were checked.

import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { basesCheck, CHECK_ALL_BUDGET_MS } from "../dist/services/basesEngineReads.js";

const formulas = (rows) => ({ score: { status: "ok", rows, errorRows: 0, nullRows: 0, samples: [] } });
let clock = 0;
let inFlight = 0;
let maxInFlight = 0;
const evaluated = [];
const engine = {
  async evaluate({ path }) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    evaluated.push(path);
    clock += 10_000; // each Base costs 10 s of engine time
    return {
      available: true,
      obsidianVersion: "1.15.1",
      rowLimit: 100,
      formulas: formulas(path === "B/big.base" ? 100 : 7),
    };
  },
  async functions() {
    throw new Error("not used");
  },
};
const paths = ["B/a.base", "B/big.base", "B/c.base", "B/d.base", "B/e.base"];

assert.equal(CHECK_ALL_BUDGET_MS, 30_000);
const all = await basesCheck(engine, async () => paths, undefined, { now: () => clock });
assert.equal(maxInFlight, 1, "one Base at a time on Obsidian's main thread");
assert.deepEqual(evaluated, ["B/a.base", "B/big.base", "B/c.base"], "no Base starts past the budget");
assert.equal(all.summary.bases, 3);
assert.deepEqual(all.truncated, { checked: 3, total: 5 });
assert.deepEqual(all.unchecked, {
  reason: "time_budget",
  budgetMs: 30_000,
  paths: ["B/d.base", "B/e.base"],
  next: "Check them one at a time with path.",
});
assert.deepEqual(all.problems, [], "unchecked Bases are not problems and not healthy");

const big = await basesCheck(engine, async () => paths, "B/big.base");
assert.equal(big.status, "verified");
assert.equal(big.sampledRows, 100, "a Base past the sample says how many rows were checked");
const small = await basesCheck(engine, async () => paths, "B/a.base");
assert.equal("sampledRows" in small, false, "a Base within the sample was checked on every row");

console.log("PASS: bases_check checks one Base at a time within its time budget and reports sampled Bases");
