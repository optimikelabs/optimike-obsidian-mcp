import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { App } from "obsidian";
import { createNoteCreateRoutes } from "./noteCreateRoutes.js";
import { ExclusiveNoteCreateFiles } from "./exclusiveNoteCreate.js";
import { noteCreateHash } from "../../../src/services/noteCreateContract.js";
import { nativeDigest, nativeMovePaths, nativeNotePath, sealNativeMove } from "../../../src/services/nativeNoteMoveContract.js";
import { NoteNameError } from "../../../src/services/noteNameRules.js";

const NFD_E_ACUTE = "e" + String.fromCharCode(0x301);
const NARROW_NBSP = String.fromCharCode(0x202f);
const ZERO_WIDTH = String.fromCharCode(0x200b);

test("note names: the create routes refuse names that are not valid everywhere and folded siblings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "create-names-"));
  const handlers = new Map<string, (req: any, res: any) => void>();
  const app = { vault: { adapter: { getBasePath: () => root }, getAbstractFileByPath: () => null } } as unknown as App;
  const routes = createNoteCreateRoutes(app, { binding: () => "a".repeat(64), enabled: () => true })!;
  routes.mount({ addRoute: url => ({ post: fn => { handlers.set(url, fn); } }) });
  const call = (suffix: string, body: unknown) => {
    let code = 0; let result: any;
    const res = { status: (n: number) => { code = n; return res; }, json: (v: unknown) => { result = v; } };
    handlers.get("/extensions/obsidian-atomic-write-bridge/note-create/" + suffix)!({ body }, res);
    return { code, result };
  };
  try {
    for (const valid of ["Projet — Réunion (v2).md", "L’été · plan.md", "Question à 100 € ; suite.md"]) {
      assert.equal(call("preflight", { contractVersion: 1, path: valid }).code, 200, valid);
    }
    const invalidNames = ["Note [x].md", "Idée #4.md", "Idée ^1.md", "Fin: suite.md", NFD_E_ACUTE + "cole.md",
      "Note" + NARROW_NBSP + "x.md", "a" + ZERO_WIDTH + "b.md", "Note .md", "CON.md"];
    for (const invalid of invalidNames) {
      assert.equal(call("preflight", { contractVersion: 1, path: invalid }).code, 400, invalid);
    }
    // apply re-validates: a refused name cannot be created through a forged apply
    const ok = call("preflight", { contractVersion: 1, path: "Ok.md" }).result;
    const content = "x\n";
    const forged = { contractVersion: 1, operationId: randomUUID(), path: "Note [x].md", content,
      contentSha256: noteCreateHash(content), bindingFingerprint: ok.bindingFingerprint, policyDigest: ok.policyDigest };
    assert.equal(call("apply", forged).result.outcome, "conflict");
    assert.deepEqual(readdirSync(root), []);
    // a sibling that differs only by case or Unicode form is refused, whatever the file system folds
    const files = new ExclusiveNoteCreateFiles(root);
    files.create("École.md", content);
    assert.equal(files.hasFoldedSibling("école.md"), true);
    assert.equal(files.hasFoldedSibling("É".normalize("NFD") + "cole.md"), true);
    assert.equal(files.hasFoldedSibling("École.md"), false, "an exact twin is 'exists', not a folded sibling");
    assert.equal(files.hasFoldedSibling("Autre.md"), false);
    assert.equal(call("preflight", { contractVersion: 1, path: "école.md" }).code, 400);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("note names: a move destination is a new name, the source may keep a legacy name", () => {
  const legacy = "Historique/[Guide] MX GMA.md";
  for (const destination of ["B:.md", "Idée #4.md", "Note [x].md", NFD_E_ACUTE + "cole.md", "Note" + NARROW_NBSP + "x.md", "Note .md", "Dossier/CON.md"]) {
    assert.throws(() => nativeMovePaths("A.md", destination), (error: unknown) => error instanceof NoteNameError, destination);
  }
  assert.equal(nativeMovePaths("A.md", "Dossier/Réunion — suite (2).md").destinationPath, "Dossier/Réunion — suite (2).md");
  assert.equal(nativeNotePath(legacy), legacy, "the lenient structural check still accepts existing names");
  const sealed = sealNativeMove({ sourcePath: legacy, destinationPath: "Historique/(Guide) MX GMA.md", updateLinks: true,
    bindingFingerprint: "a".repeat(64), notes: [{ path: legacy, sha256: nativeDigest("source"), references: [], backlinks: [], unresolved: [] }] });
  assert.equal(sealed.destinationPath, "Historique/(Guide) MX GMA.md");
});
