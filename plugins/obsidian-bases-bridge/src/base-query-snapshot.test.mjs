import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
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

test("Fallback query uses readBaseConfig's exact parsed-source snapshot", () => {
  const source = fs.readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(source, /const jsonRaw = parseYaml\(yaml\)/u);
  assert.match(source, /snapshot: baseQuerySnapshot\(path, yaml, binding\)/u);
  const route = source.slice(source.indexOf("const queryBase = async"), source.indexOf("const upsertBase = async"));
  assert.match(route, /readBaseConfig\(id\)/u);
  assert.match(route, /extractSchema\(config\.id, config\.json\)/u);
  assert.match(route, /source: "fallback",[\s\S]*?baseSnapshot: config\.snapshot/u);
});
