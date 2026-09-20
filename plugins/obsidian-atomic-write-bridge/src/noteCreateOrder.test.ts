import assert from "node:assert/strict";
import test from "node:test";
import { observeCreateContent, type NoteCreatePolicy } from "../../../src/services/noteCreateContract.js";

const start = Date.parse("2026-09-20T10:00:00Z");
const policy: NoteCreatePolicy = { version: 1, utcOffsetMinutes: 0, fields: [
  { pluginId: "update-time", propertyName: "a_updated", role: "modified", delayMs: 1000 },
  { pluginId: "update-time", propertyName: "z_created", role: "created", delayMs: 1000 },
] };

test("M4 multiple automatic date insertions preserve observed order, position and CRLF", () => {
  for (const eol of ["\n", "\r\n"]) {
    const expected = ["---", "title: Test", "other: keep", "---", "Body", ""].join(eol);
    const variants = [
      ["---", "title: Test", "other: keep", "z_created: 2026-09-20T10:00:01", "a_updated: 2026-09-20T10:00:02", "---", "Body", ""],
      ["---", "z_created: 2026-09-20T10:00:01", "title: Test", "a_updated: 2026-09-20T10:00:02", "other: keep", "---", "Body", ""],
      ["---", "a_updated: 2026-09-20T10:00:02", "title: Test", "other: keep", "z_created: 2026-09-20T10:00:01", "---", "Body", ""],
    ];
    for (const lines of variants) {
      const observed = lines.join(eol);
      assert.equal(observeCreateContent(expected, observed, policy, start, start + 86400000)?.kind, "date-settled");
      assert.equal(observeCreateContent(expected, observed.replace("other: keep", "other: changed"), policy, start, start + 86400000), undefined);
      assert.equal(observeCreateContent(expected, observed.replace("10:00:02", "10:10:00"), policy, start, start + 86400000), undefined);
    }
  }
});

test("M4 existing creation dates cannot be replaced while reconciling a new modification date", () => {
  const expected = "---\nz_created: 2026-09-19T10:00:00\ntitle: Test\n---\nBody\n";
  const observed = expected.replace("title: Test", "a_updated: 2026-09-20T10:00:02\ntitle: Test");
  assert.equal(observeCreateContent(expected, observed, policy, start, start + 5000)?.kind, "date-settled");
  assert.equal(observeCreateContent(expected, observed.replace("2026-09-19T10:00:00", "2026-09-20T10:00:01"), policy, start, start + 5000), undefined);
});
