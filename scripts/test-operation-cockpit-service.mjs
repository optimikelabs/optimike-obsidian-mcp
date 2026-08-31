import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  OperationCockpit,
  OPERATION_COCKPIT_CONTRACT_VERSION,
} from "../dist/services/operationCockpit.js";

const now = Date.parse("2026-08-31T12:00:00.000Z");
const rows = [
  ["obsidian.note.replace", "planned", "2026-08-31T11:59:00.000Z"],
  ["obsidian.frontmatter.patch", "applying", "2026-08-31T11:58:00.000Z"],
  [
    "obsidian.base.formula.patch",
    "outcome_unknown",
    "2026-08-31T11:57:00.000Z",
  ],
  ["obsidian.canvas.patch", "planned", "2026-08-31T11:56:00.000Z"],
  ["obsidian.text.patch", "applying", "2026-08-31T11:55:00.000Z"],
].map(([operationKind, status, updatedAt], index) => ({
  operationId: randomUUID(),
  operationKind,
  status,
  createdAt: new Date(Date.parse(updatedAt) - (index + 1) * 1000).toISOString(),
  updatedAt,
  privateContent: `MUST-NOT-LEAK-${index}`,
  path: `Secret/${index}.md`,
  idempotencyKey: `private-key-${index}`,
}));

function compare(left, right) {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.operationKind.localeCompare(right.operationKind) ||
    left.operationId.localeCompare(right.operationId)
  );
}

function after(row, cursor) {
  if (!cursor) return true;
  return compare(row, cursor) > 0;
}

class FakeSource {
  constructor(sourceRows) {
    this.rows = sourceRows;
    this.calls = [];
  }

  listPendingOperationRows(input) {
    this.calls.push(structuredClone(input));
    const selected = this.rows
      .filter((row) => after(row, input.after))
      .sort(compare);
    return {
      rows: selected.slice(0, input.limit).map((row) => ({
        operationId: row.operationId,
        operationKind: row.operationKind,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      hasMore: selected.length > input.limit,
    };
  }
}

const first = new FakeSource(rows.filter((_, index) => index % 2 === 0));
const second = new FakeSource(rows.filter((_, index) => index % 2 === 1));
const cockpit = new OperationCockpit([first, second], () => now);
const collected = [];
let cursor;
do {
  const page = cockpit.list({ limit: 2, cursor });
  assert.equal(page.contractVersion, OPERATION_COCKPIT_CONTRACT_VERSION);
  assert.equal(page.generatedAt, "2026-08-31T12:00:00.000Z");
  assert.ok(page.operations.length >= 1 && page.operations.length <= 2);
  collected.push(...page.operations);
  cursor = page.nextCursor;
} while (cursor);

assert.equal(collected.length, rows.length);
assert.equal(new Set(collected.map((item) => item.planRef)).size, rows.length);
const expectedPrefixes = {
  "obsidian.note.replace": "obsidian-note-replace:v1:",
  "obsidian.frontmatter.patch": "obsidian-frontmatter-patch:v1:",
  "obsidian.base.formula.patch": "obsidian-base-formula-patch:v1:",
  "obsidian.canvas.patch": "obsidian-canvas-patch:v1:",
  "obsidian.text.patch": "obsidian-text-patch:v1:",
};
for (const item of collected) {
  assert.equal(
    item.planRef,
    `${expectedPrefixes[item.operationKind]}${rows.find((row) => row.operationKind === item.operationKind).operationId}`,
    `the ${item.operationKind} row must route to its domain lifecycle family`,
  );
}
assert.deepEqual(
  collected.map((item) => item.operationKind),
  rows.sort(compare).map((item) => item.operationKind),
);
assert.deepEqual(
  Object.fromEntries(collected.map((item) => [item.state, item.nextAction])),
  { planned: "apply", applying: "status", outcome_unknown: "recover" },
);
assert.ok(collected.every((item) => item.ageSeconds >= 0));
const serialized = JSON.stringify(collected);
for (const forbidden of ["MUST-NOT-LEAK", "Secret/", "private-key-"]) {
  assert.equal(serialized.includes(forbidden), false);
}
assert.throws(
  () => cockpit.list({ cursor: "not-a-valid-contract-cursor" }),
  /pending-operation cursor/u,
);
assert.throws(() => cockpit.list({ limit: 101 }), /limit must be/u);
assert.ok(first.calls.length > 1 && second.calls.length > 1);

console.log(
  "Operation cockpit service passed: global keyset pagination, closed next actions, bounded age, privacy and invalid-input rejection.",
);
