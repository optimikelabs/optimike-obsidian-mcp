import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { App } from "obsidian";
import { createVaultFileCreateRoutes, vaultFileContentParses } from "./vaultFileCreateRoutes.js";
import { createNoteCreateRoutes } from "./noteCreateRoutes.js";
import { EffectFenceRefused } from "./effectFence.js";
import { vaultFileCreateHash } from "../../../src/services/vaultFileCreateContract.js";

// Obsidian's parseYaml exists only inside the app, and this package is also
// checked standalone. The stand-in returns the shapes the guard distinguishes.
function parse(text: string): unknown {
  if (/\[[^\]]*$/mu.test(text)) throw new Error("unclosed flow sequence");
  const lines = text.split(/\r?\n/u).filter(Boolean);
  if (lines[0]?.startsWith("- ")) return lines.map((line) => line.slice(2));
  if (/^[\w.-]+:/u.test(lines[0] ?? "")) return Object.fromEntries(lines.filter((line) => /^[\w.-]+:/u.test(line)).map((line) => [line.split(":")[0], true]));
  return text.trim();
}

const BASE = "filters:\n  and:\n    - file.ext == \"md\"\nviews:\n  - type: table\n    name: Tout\n";
const CANVAS = "{\n\t\"nodes\":[],\n\t\"edges\":[]\n}";

function harness(kind: "base" | "canvas", options: { enterEffect?: () => () => void } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `${kind}-create-routes-`));
  let enabled = true;
  const handlers = new Map<string, (req: any, res: any) => void>();
  const app = { vault: { adapter: { getBasePath: () => root }, getAbstractFileByPath: () => null } } as unknown as App;
  const routes = createVaultFileCreateRoutes(app, { kind, binding: () => "a".repeat(64), enabled: () => enabled, parseYaml: parse,
    ...(options.enterEffect ? { enterEffect: options.enterEffect } : {}) })!;
  routes.mount({ addRoute: url => ({ post: fn => { handlers.set(url, fn); } }) });
  function call(suffix: string, body: unknown) {
    let code = 0; let result: any;
    const res = { status: (n: number) => { code = n; return res; }, json: (v: unknown) => { result = v; } };
    const handler = handlers.get(`/extensions/obsidian-atomic-write-bridge/${kind}-create/${suffix}`);
    assert.ok(handler, `route ${kind}-create/${suffix} must be mounted`);
    handler({ body }, res);
    return { code, result };
  }
  function request(file: string, content: string, binding: string) {
    return { contractVersion: 1, operationId: randomUUID(), path: file, content, contentSha256: vaultFileCreateHash(content), bindingFingerprint: binding };
  }
  return { root, app, routes, call, request, disable: () => { enabled = false; }, enable: () => { enabled = true; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Base creation is exclusive, kind-bound and never overwrites", () => {
  const h = harness("base");
  try {
    const p = h.call("preflight", { contractVersion: 1, path: "Vues.base" });
    assert.equal(p.code, 200);
    assert.equal(p.result.kind, "base");
    assert.equal(p.result.absent, true);
    assert.equal("policy" in p.result, false, "no Markdown date policy for a Base");
    const note = createNoteCreateRoutes(h.app, { binding: () => "a".repeat(64), enabled: () => true })!;
    assert.notEqual(p.result.bindingFingerprint, note.capabilities().bindingFingerprint, "a Base plan cannot be applied as a note");
    const stale = h.call("apply", h.request("Vues.base", BASE, "b".repeat(64)));
    assert.equal(stale.result.outcome, "conflict");
    assert.deepEqual(readdirSync(h.root), []);
    const request = h.request("Vues.base", BASE, p.result.bindingFingerprint);
    const created = h.call("apply", request);
    assert.equal(created.result.outcome, "created");
    assert.equal(created.result.kind, "base");
    assert.equal(readFileSync(path.join(h.root, "Vues.base"), "utf8"), BASE);
    assert.equal(h.call("apply", { ...request, content: "views: []\n", contentSha256: vaultFileCreateHash("views: []\n") }).result.outcome, "conflict");
    assert.equal(readFileSync(path.join(h.root, "Vues.base"), "utf8"), BASE, "an existing Base is never overwritten");
    const found = h.call("inspect", { contractVersion: 1, path: "Vues.base" });
    assert.equal(found.result.exists, true);
    assert.equal(found.result.sha256, request.contentSha256);
    const existing = h.call("preflight", { contractVersion: 1, path: "Vues.base" });
    assert.equal(existing.code, 409);
    assert.equal(existing.result.error.reasonCode, "file_create_target_exists");
  } finally { h.cleanup(); }
});

test("Base creation refuses other kinds, invalid YAML, a disabled grant and unsafe paths", () => {
  const h = harness("base");
  try {
    const binding = h.call("preflight", { contractVersion: 1, path: "A.base" }).result.bindingFingerprint;
    for (const file of ["A.md", "A.canvas", "../A.base", ".obsidian/A.base", "A:B.base"]) {
      const refused = h.call("preflight", { contractVersion: 1, path: file });
      assert.equal(refused.code, 400, file);
    }
    const orphan = h.call("preflight", { contractVersion: 1, path: "Dossier/A.base" });
    assert.equal(orphan.code, 404);
    assert.equal(orphan.result.error.reasonCode, "file_create_parent_missing");
    const invalid = h.call("apply", h.request("A.base", "views: [unclosed\n", binding));
    assert.equal(invalid.result.outcome, "conflict");
    const scalar = h.call("apply", h.request("A.base", "just text\n", binding));
    assert.equal(scalar.result.outcome, "conflict", "a YAML scalar is not a Base");
    assert.deepEqual(readdirSync(h.root), []);
    h.disable();
    const disabled = h.call("preflight", { contractVersion: 1, path: "A.base" });
    assert.equal(disabled.code, 403);
    assert.equal(disabled.result.error.reasonCode, "file_create_disabled");
    assert.equal(h.call("apply", h.request("A.base", BASE, binding)).result.outcome, "conflict");
    assert.deepEqual(readdirSync(h.root), []);
    h.enable();
    writeFileSync(path.join(h.root, "vues.base"), BASE);
    const folded = h.call("preflight", { contractVersion: 1, path: "Vues.base" });
    assert.equal(folded.code, 400);
    assert.equal(folded.result.error.reasonCode, "note_name_case_collision");
    const leak = h.call("apply", { ...h.request("../private.base", BASE, binding) });
    assert.equal(leak.code, 400);
    assert.equal(JSON.stringify(leak.result).includes(h.root), false);
    assert.equal(JSON.stringify(leak.result).includes("private.base"), false);
  } finally { h.cleanup(); }
});

test("Canvas creation needs a graph envelope and the parent directory", () => {
  const h = harness("canvas");
  try {
    const p = h.call("preflight", { contractVersion: 1, path: "Carte.canvas" });
    assert.equal(p.result.kind, "canvas");
    assert.equal(h.call("apply", h.request("Carte.canvas", "{\"nodes\":[]}", p.result.bindingFingerprint)).result.outcome, "conflict");
    assert.equal(h.call("preflight", { contractVersion: 1, path: "Carte.base" }).code, 400);
    assert.equal(h.call("apply", h.request("Absent/Carte.canvas", CANVAS, p.result.bindingFingerprint)).result.outcome, "conflict",
      "the parent directory is never created");
    mkdirSync(path.join(h.root, "Cartes"));
    const created = h.call("apply", h.request("Cartes/Carte.canvas", CANVAS, p.result.bindingFingerprint));
    assert.equal(created.result.outcome, "created");
    assert.deepEqual(readdirSync(path.join(h.root, "Cartes")), ["Carte.canvas"]);
  } finally { h.cleanup(); }
});

test("a refusing effect fence leaves no Base or Canvas file", () => {
  const h = harness("canvas", { enterEffect: () => { throw new EffectFenceRefused("fence_epoch_superseded"); } });
  try {
    const binding = h.call("preflight", { contractVersion: 1, path: "C.canvas" }).result.bindingFingerprint;
    const refused = h.call("apply", h.request("C.canvas", CANVAS, binding));
    assert.equal(refused.result.outcome, "conflict");
    assert.equal(refused.result.reason, "create_fence_refused");
    assert.deepEqual(readdirSync(h.root), []);
  } finally { h.cleanup(); }
});

test("Bridge content guard follows the Obsidian parsers", () => {
  assert.equal(vaultFileContentParses("base", BASE, parse), true);
  assert.equal(vaultFileContentParses("base", "- a\n- b\n", parse), false);
  assert.equal(vaultFileContentParses("canvas", CANVAS, parse), true);
  assert.equal(vaultFileContentParses("canvas", "[]", parse), false);
  assert.equal(vaultFileContentParses("canvas", "{\"nodes\":[],\"edges\":{}}", parse), false);
});
