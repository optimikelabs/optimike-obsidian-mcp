import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseQuerySnapshot } from "./base-query-snapshot.mjs";

test("Base query proof captures evaluated bytes, unaffected by an A-B-A disk change", () => {
  const a = "views:\n - name: A\n", b = "views:\r\n - name: B\r\n";
  let disk = b;
  const proof = baseQuerySnapshot("Work.base", disk, "a".repeat(64));
  disk = a;
  assert.notEqual(proof.sha256, createHash("sha256").update(disk).digest("hex"));
  assert.equal(proof.sha256, createHash("sha256").update(b).digest("hex"));
  assert.equal(proof.bindingFingerprint, "a".repeat(64));
  assert.throws(() => { proof.sha256 = "b".repeat(64); });
  assert.throws(() => baseQuerySnapshot("Work.base", a, "invalid"));
});
