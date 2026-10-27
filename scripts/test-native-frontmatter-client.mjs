import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { inspectNativeFrontmatter } from "../dist/services/obsidianFrontmatterFormat.js";

const binding = "a".repeat(64);
const status = { frontmatterFormat: { contractVersion: 1, supported: true }, backend: { bindingFingerprint: binding } };
const backend = { status: async () => status, inspectFrontmatterFormat: async yaml => ({ ok: true, contractVersion: 1, bindingFingerprint: binding,
  canonicalYaml: stringify(parse(yaml), null, { nullStr: "", lineWidth: 0, aliasDuplicateObjects: false }), warnings: [] }) };

test("normalizes only the YAML and preserves delimiters and body", async () => {
  const source = "---\r\na: 'été'\r\nitems: [a, b]\r\n---\r\ncorps\r\n";
  const result = await inspectNativeFrontmatter(backend, source, binding);
  assert.equal(result.content, "---\r\na: été\nitems:\n  - a\n  - b\n---\r\ncorps\r\n");
  assert.equal(result.normalized, true);
  assert.equal((await inspectNativeFrontmatter(backend, result.content)).normalized, false);
  assert.equal((await inspectNativeFrontmatter(backend, "texte\n")).content, "texte\n");
});
test("fails closed on missing capability, identity mismatch or invalid route response", async () => {
  for (const value of [
    { ...backend, status: async () => ({ ...status, frontmatterFormat: undefined }) },
    { ...backend, inspectFrontmatterFormat: undefined },
    { ...backend, inspectFrontmatterFormat: async () => ({ ok: true, contractVersion: 1, bindingFingerprint: "b".repeat(64), canonicalYaml: "a: 1\n", warnings: [] }) },
    { ...backend, inspectFrontmatterFormat: async () => ({ invalid: true }) },
  ]) await assert.rejects(inspectNativeFrontmatter(value, "---\na: 1\n---\n"));
  await assert.rejects(inspectNativeFrontmatter(backend, "---\na: 1\n---\n", "b".repeat(64)));
});
