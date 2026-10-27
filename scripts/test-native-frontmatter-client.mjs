import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { inspectNativeFrontmatter } from "../dist/services/obsidianFrontmatterFormat.js";
import { BaseErrorCode, McpError } from "../dist/types-global/errors.js";
process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";
const { effectFenceEpoch } = await import("../dist/services/operations/obsidianNoteReplaceOperationAdapter.js");
const { RestAtomicWriteBackend } = await import("../dist/services/operations/restAtomicWriteBackend.js");
const { RestCanvasAtomicWriteBackend } = await import("../dist/services/operations/restCanvasAtomicWriteBackend.js");
const { RestNoteCreateBackend } = await import("../dist/services/operations/restNoteCreateBackend.js");
const { RestNativeNoteMoveBackend } = await import("../dist/services/operations/restNativeNoteMoveBackend.js");

const binding = "a".repeat(64);
const status = { plugin: { id: "obsidian-atomic-write-bridge", version: "0.8.4" }, frontmatterFormat: { contractVersion: 1, supported: true }, backend: { bindingFingerprint: binding } };
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

test("requires a stable Bridge 0.8.4 or later", async () => {
  for (const version of ["0.8.2", "0.8.3", "0.8.4-rc.1", "test", undefined]) {
    const old = { ...backend, status: async () => ({ ...status, plugin: { id: "obsidian-atomic-write-bridge", version } }) };
    await assert.rejects(inspectNativeFrontmatter(old, "texte\n"), error => error.code === BaseErrorCode.SERVICE_UNAVAILABLE && error.details.reasonCode === "atomic_bridge_version_unsupported");
  }
  const rejected = { ...backend, status: async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "private", { reasonCode: "atomic_bridge_version_unsupported" }); } };
  await assert.rejects(inspectNativeFrontmatter(rejected, "texte\n"), error => error.details?.reasonCode === "atomic_bridge_version_unsupported");
  for (const version of ["0.8.4", "0.8.5", "0.9.0", "1.0.0", "0.8.4+build.1"]) {
    const newer = { ...backend, status: async () => ({ ...status, plugin: { id: "obsidian-atomic-write-bridge", version } }) };
    assert.equal((await inspectNativeFrontmatter(newer, "texte\n")).content, "texte\n");
  }
});

test("governed REST adapters refuse old Bridge versions before dispatch and do not trust their fence", async () => {
  const epoch = "a6c93a54-bb4a-46f0-8265-79c78d55226c";
  let version = "0.8.3", calls = 0;
  const advertised = () => ({ plugin: { id: "obsidian-atomic-write-bridge", version }, backend: { canvasAtomicCas: true, canvasWriteEnabled: true }, effectFence: { contractVersion: 1, supported: true, epoch } });
  const rest = { getAtomicWriteStatus: async () => advertised(), listFiles: async () => [], nativeNoteMovePreflight: async () => { calls++; return {}; } };
  const note = new RestAtomicWriteBackend(rest), canvas = new RestCanvasAtomicWriteBackend(rest), create = new RestNoteCreateBackend(rest), move = new RestNativeNoteMoveBackend(rest);
  for (const action of [() => note.status(), () => canvas.status(), () => create.status(), () => move.preflight("a.md", "b.md")]) {
    await assert.rejects(action(), error => error.code === BaseErrorCode.SERVICE_UNAVAILABLE && error.details.reasonCode === "atomic_bridge_version_unsupported");
  }
  assert.equal(calls, 0);
  assert.equal(effectFenceEpoch(advertised()), undefined);
  version = "0.8.4";
  assert.equal(effectFenceEpoch(advertised()), epoch);
  await note.status(); await canvas.status(); await create.status(); await move.preflight("a.md", "b.md");
  assert.equal(calls, 1);
});

test("invalid YAML is a validation error; infrastructure failures remain unavailable", async () => {
  const invalid = { ...backend, inspectFrontmatterFormat: async () => { throw new McpError(BaseErrorCode.VALIDATION_ERROR, "secret parser diagnostic", { reasonCode: "invalid_frontmatter" }); } };
  await assert.rejects(inspectNativeFrontmatter(invalid, "---\nsecret: x\nsecret: y\n---\n"), error =>
    error.code === BaseErrorCode.VALIDATION_ERROR && error.details.reasonCode === "invalid_frontmatter" && !error.message.includes("secret"));
  const down = { ...backend, inspectFrontmatterFormat: async () => { throw new Error("secret"); } };
  await assert.rejects(inspectNativeFrontmatter(down, "---\na: 1\n---\n"), error => error.code === BaseErrorCode.SERVICE_UNAVAILABLE && !error.message.includes("secret"));
});
