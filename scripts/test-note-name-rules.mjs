import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";

const rules = await import("../dist/services/noteNameRules.js");
const { checkNoteName, suggestNoteName, assertNoteName, isNoteNameHint, isNoteNameReasonCode, hasFoldedNameCollision,
  noteNameFoldKey, NOTE_NAME_REASON_CODES, NOTE_NAME_RULES_DESCRIPTION, NoteNameError } = rules;
const { assertNoFoldedSibling } = await import("../dist/services/noteNameMcp.js");
const { NoteCreateOperationAdapter } = await import("../dist/services/operations/noteCreateOperationAdapter.js");
const { NativeNoteMoveOperationAdapter } = await import("../dist/services/operations/nativeNoteMoveOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { createPolicyDigest, validateNoteCreate } = await import("../dist/services/noteCreateContract.js");
const { nativeMovePaths, nativeNotePath, nativeDigest, sealNativeMove } = await import("../dist/services/nativeNoteMoveContract.js");
const { publicMcpToolErrorPayload, ErrorHandler } = await import("../dist/utils/index.js");
const { logger } = await import("../dist/utils/index.js");
const { McpError, BaseErrorCode } = await import("../dist/types-global/errors.js");
const { VaultFileService } = await import("../dist/services/vaultFileService.js");

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// ── 1. Real ÉLYSIA-style titles pass untouched ──────────────────────────────
const real = [
  "Efforts/Projets/Internes/Mon mcp Obsidian/Projet — Optimike Obsidian MCP — Référence Obsidian VNext.md",
  "Calendrier/NOTES PÉRIODIQUES/2026/Q4/10-octobre/W44/2026-10-27-mardi - Plan de la journée.md",
  "X/Gouvernance/MEMOIRE_PROCEDURALE.md",
  "🧭 ÉLYSIA — OS (Index).md",
  "Standard — Contrat ÉLYSIA (core · optionnel · exemples).md",
  "Index — Protocoles ÉLYSIA (SOP · Standards · Runbooks).md",
  "SOP — Incident & rollback agentique (5 min).md",
  "Cockpit — Exécution (Tasks).md",
  "TP — Contexte actif agentique.md",
  "Front door Codex — ÉLYSIA.md",
  "Atlas/Concepts/L’effet « Zeigarnik » · mémoire (2).md",
  "Efforts/Créations/Posts/Œuvres — Cœur d’été.md",
  "Hypothèses… à vérifier.md",
  "Question à 100 € – 3 % de remise ; coût, délai !.md",
  "Réunion Alpac Iso (SEO) — décisions & suites, v2.1.md",
  "Plan 2026-10-27 - Léa & Noël (brouillon).md",
  "日本語のノート.md", "Заметка о проекте.md", "فارسی\u200cزبان.md", "🚀 Lancement.md", "🏳️\u200d🌈 Fierté.md",
  "Note.MD", "a/b/c/d.md", "v1.2.3 notes.md", "~brouillon+idée@maison=ok.md",
];
for (const title of real) {
  const verdict = checkNoteName(title);
  ok(verdict.ok, `real title must pass: ${title}`);
  eq(suggestNoteName(title), title, "a conforming title is never modified");
  eq(assertNoteName(title), title);
}

// ── 2. Each rule: closed reasonCode, closed hint, deterministic valid proposal ─
const longName = "é".repeat(128) + ".md"; // 131 characters, 259 UTF-8 bytes
const cases = [
  ["a:b.md", "note_name_forbidden_character", "a — b.md"],
  ["Rapport 12:30 rdv.md", "note_name_forbidden_character", "Rapport 12-30 rdv.md"],
  ["Quoi ? Pourquoi.md", "note_name_forbidden_character", "Quoi Pourquoi.md"],
  ["Excel \"Q3\" *final*.md", "note_name_forbidden_character", "Excel 'Q3' final.md"],
  ["a|b <c>.md", "note_name_forbidden_character", "a-b c.md"],
  ["dir\\note.md", "note_name_forbidden_character", "dir/note.md"],
  ["Note [x].md", "note_name_link_character", "Note (x).md"],
  ["C# guide.md", "note_name_link_character", "C guide.md"],
  ["Idée ^1.md", "note_name_link_character", "Idée 1.md"],
  ["50%% off.md", "note_name_link_character", "50% off.md"],
  ["Note\u00a0x.md", "note_name_invisible_character", "Note x.md"],
  ["Note\u202fx.md", "note_name_invisible_character", "Note x.md"],
  ["a\u200bb.md", "note_name_invisible_character", "ab.md"],
  ["a\u200d.md", "note_name_invisible_character", "a.md"],
  ["a\u202eb.md", "note_name_invisible_character", "ab.md"],
  ["a\ufeffb.md", "note_name_invisible_character", "ab.md"],
  ["a\tb.md", "note_name_control_character", "a b.md"],
  ["a\nb.md", "note_name_control_character", "a b.md"],
  ["a\u0000b.md", "note_name_control_character", "a b.md"],
  ["e\u0301cole.md", "note_name_not_nfc", "école.md"],
  ["a\ud800.md", "note_name_invalid_unicode", "a.md"],
  ["a\ufffdb.md", "note_name_invalid_unicode", "ab.md"],
  [".hidden.md", "note_name_leading_dot", "hidden.md"],
  ["dir/.obsidian/x.md", "note_name_leading_dot", "dir/obsidian/x.md"],
  ["Note .md", "note_name_edge_space", "Note.md"],
  ["dir/ Note.md", "note_name_edge_space", "dir/Note.md"],
  [" Note.md", "note_name_edge_space", "Note.md"],
  ["dir./note.md", "note_name_trailing_dot", "dir/note.md"],
  ["dir /note.md", "note_name_edge_space", "dir/note.md"],
  ["CON.md", "note_name_reserved_name", "CON_.md"],
  ["dir/nul.txt.md", "note_name_reserved_name", "dir/nul_.txt.md"],
  ["COM1.md", "note_name_reserved_name", "COM1_.md"],
  ["LPT¹.md", "note_name_reserved_name", "LPT¹_.md"],
  ["aux/x.md", "note_name_reserved_name", "aux_/x.md"],
  ["note.txt", "note_name_extension", "note.txt.md"],
  ["note", "note_name_extension", "note.md"],
  ["a//b.md", "note_name_empty_segment", "a/b.md"],
  ["/abs.md", "note_name_empty_segment", "abs.md"],
  ["dir/", "note_name_empty_segment", "dir.md"],
  [longName, "note_name_segment_too_long", undefined],
  [("d".repeat(40) + "/").repeat(6) + "x.md", "note_name_too_long", undefined],
  ["", "note_name_empty", undefined],
  [undefined, "note_name_invalid_type", undefined],
  [42, "note_name_invalid_type", undefined],
];
for (const [input, reasonCode, expected] of cases) {
  const verdict = checkNoteName(input);
  ok(!verdict.ok, `must be refused: ${JSON.stringify(input)}`);
  const v = verdict.violation;
  eq(v.reasonCode, reasonCode, `reason for ${JSON.stringify(input)}`);
  ok(isNoteNameReasonCode(v.reasonCode));
  ok(isNoteNameHint(v.hint), `closed hint for ${v.reasonCode}: ${v.hint}`);
  if (typeof input === "string" && input.length > 3) ok(!v.hint.includes(input), "the hint never copies the submitted path");
  eq(v.suggestedPath, expected, `proposal for ${JSON.stringify(input)}`);
  eq(checkNoteName(input), verdict, "deterministic");
  if (expected !== undefined) {
    ok(checkNoteName(expected).ok, "the proposal itself satisfies the rule");
    eq(suggestNoteName(expected), expected, "the proposal is a fixed point");
    eq(v.suggestedName, expected.slice(expected.lastIndexOf("/") + 1));
  } else ok(v.suggestedName === undefined);
  assert.throws(() => assertNoteName(input), (error) => error instanceof NoteNameError && error.violation.reasonCode === reasonCode);
}
ok(NOTE_NAME_REASON_CODES.every((code) => code.startsWith("note_name_")));
ok(isNoteNameHint(checkNoteName("a:b/c:d.md").violation.hint) && /\[segment 1\]/u.test(checkNoteName("a:b/c:d.md").violation.hint));
ok(/\[U\+00A0\]/u.test(checkNoteName("a\u00a0b.md").violation.hint));

// Non-markdown extensions (headless writes of .canvas / .base) use extensions: null.
ok(checkNoteName("Boards/Carte.canvas", { extensions: null }).ok);
ok(!checkNoteName("Boards/Carte:2.canvas", { extensions: null }).ok);
eq(suggestNoteName("Boards/Carte:2.canvas", { extensions: null }), "Boards/Carte — 2.canvas");

// ── 3. Hints are a closed vocabulary ────────────────────────────────────────
for (const forged of ["", "anything", "Secret/Path.md", checkNoteName("a:b.md").violation.hint + " Secret/Path.md",
  checkNoteName("a:b.md").violation.hint.replace(" [segment 1]", " [segment 1000]"), "A colon (:) is not allowed in a name (Windows, macOS, iOS, Android, Obsidian). [U+3A]", 7, null]) {
  ok(!isNoteNameHint(forged), `forged hint refused: ${String(forged)}`);
}
ok(NOTE_NAME_RULES_DESCRIPTION.length < 500 && NOTE_NAME_RULES_DESCRIPTION.includes("suggestedPath"));

// ── 4. Case and Unicode-form collisions ─────────────────────────────────────
ok(noteNameFoldKey("É.md") === noteNameFoldKey("e\u0301.md".replace("e\u0301", "é")));
ok(hasFoldedNameCollision("note.md", ["Note.md"]));
ok(hasFoldedNameCollision("école.md", ["e\u0301cole.md"]));
ok(hasFoldedNameCollision("Léa.md", ["LÉA.md", "autre.md"]));
ok(!hasFoldedNameCollision("note.md", ["note.md", "notes.md"]), "an exact twin is 'exists', not a collision");
ok(!hasFoldedNameCollision("note.md", []));
assert.throws(() => assertNoFoldedSibling("note.md", ["Note.md"]), (error) =>
  error instanceof McpError && error.details.reasonCode === "note_name_case_collision" && isNoteNameHint(error.details.hint));
assertNoFoldedSibling("note.md", ["Sub/", "other.md"]); checks++;
assert.throws(() => assertNoFoldedSibling("Sub", ["sub/"]), McpError);

// ── 5. Create and move plans refuse before any backend call ─────────────────
const root = mkdtempSync(path.join(os.tmpdir(), "note-names-"));
try {
  let backendCalls = 0;
  const policy = { version: 1, utcOffsetMinutes: 0, fields: [] };
  const createBackend = {
    async preflight(p) { backendCalls++; return { contractVersion: 1, path: p, bindingFingerprint: "a".repeat(64), absent: true, enabled: true, policy, policyDigest: createPolicyDigest(policy) }; },
    async status() { return { backend: { bindingFingerprint: "a".repeat(64) }, frontmatterFormat: { contractVersion: 1, supported: true } }; },
    async inspectFrontmatterFormat(yaml) { return { ok: true, contractVersion: 1, bindingFingerprint: "a".repeat(64), canonicalYaml: yaml, warnings: [] }; },
    async create() { throw new Error("must not be reached"); },
    async inspect() { throw new Error("must not be reached"); },
  };
  const createJournal = new ObsidianNoteReplaceJournal(path.join(root, "create.sqlite"));
  const creator = new NoteCreateOperationAdapter(createBackend, createJournal, Date.now, () => {});
  for (const title of ["Projet — Réunion (v2).md", "Notes/Énoncé · suite’s.md"]) {
    const plan = await creator.plan({ path: title, content: "Corps.\n", idempotencyKey: "k-" + title.length });
    eq(plan.path, title); eq(plan.phase, "planned");
  }
  const before = backendCalls;
  for (const [bad, reasonCode] of [["Note [x].md", "note_name_link_character"], ["C# notes.md", "note_name_link_character"],
    ["Fin du monde: suite.md", "note_name_forbidden_character"], ["e\u0301cole.md", "note_name_not_nfc"], ["Note\u202fx.md", "note_name_invisible_character"]]) {
    await assert.rejects(creator.plan({ path: bad, content: "x\n", idempotencyKey: "bad-" + reasonCode + bad.length }), (error) => {
      eq(error.code, BaseErrorCode.VALIDATION_ERROR);
      eq(error.details.reasonCode, reasonCode);
      ok(isNoteNameHint(error.details.hint));
      ok(checkNoteName(error.details.suggestedPath).ok);
      return true;
    });
  }
  eq(backendCalls, before, "no backend call for a refused name");
  createJournal.close();

  // validateNoteCreate (shared by the Bridge apply) uses the same rule
  assert.throws(() => validateNoteCreate("Note [x].md", "x\n", policy), (error) => error instanceof NoteNameError);
  validateNoteCreate("Réunion — suite (2).md", "x\n", policy); checks++;
  // The lenient legacy check still accepts what already exists (source, neighbourhood, status)
  eq(nativeNotePath("Historique/[Guide] MX GMA.md"), "Historique/[Guide] MX GMA.md");

  // Move: the destination is new (strict), the source may keep a legacy name
  const moveJournal = new ObsidianNoteReplaceJournal(path.join(root, "move.sqlite"));
  let moveCalls = 0;
  const movePlan = sealNativeMove({ sourcePath: "Historique/[Guide] MX GMA.md", destinationPath: "Historique/(Guide) MX GMA.md", updateLinks: true,
    bindingFingerprint: "a".repeat(64), notes: [{ path: "Historique/[Guide] MX GMA.md", sha256: nativeDigest("s"), references: [], backlinks: [], unresolved: [] }] });
  const moveBackend = { async preflight() { moveCalls++; return movePlan; }, async apply() { throw new Error("no"); }, async status() { throw new Error("no"); } };
  const mover = new NativeNoteMoveOperationAdapter(moveBackend, moveJournal, () => {});
  const repair = await mover.plan({ sourcePath: "Historique/[Guide] MX GMA.md", destinationPath: "Historique/(Guide) MX GMA.md", idempotencyKey: "repair" });
  eq(repair.phase, "planned", "a legacy-named note can be moved to a valid name");
  await assert.rejects(mover.plan({ sourcePath: "A.md", destinationPath: "Dossier/Idée #4.md", idempotencyKey: "bad-move" }), (error) => {
    eq(error.details.reasonCode, "note_name_link_character"); eq(error.details.suggestedPath, "Dossier/Idée 4.md"); return true;
  });
  eq(moveCalls, 1, "no backend call for a refused destination");
  assert.throws(() => nativeMovePaths("A.md", "B:.md"), NoteNameError);
  eq(nativeMovePaths("A.md", "Dossier/B — suite.md").destinationPath, "Dossier/B — suite.md");
  moveJournal.close();

  // ── 6. Public envelope: closed fields, validated suggestion, no echo in logs ──
  const captured = [];
  const originalError = logger.error;
  logger.error = (...args) => { captured.push(args); };
  try {
    const submitted = "Secrets clients/Contrat: Dupont & fils #7.md";
    const err = await creator.plan({ path: submitted, content: "x\n", idempotencyKey: "k-public" }).catch((e) => e);
    const payload = publicMcpToolErrorPayload(err, { operation: "obsidian_note_create_plan", toolName: "obsidian_note_create_plan", params: { path: submitted, content: "x\n", idempotencyKey: "k-public" } });
    eq(payload.error.code, "VALIDATION_ERROR");
    eq(payload.error.details.reasonCode, "note_name_forbidden_character");
    ok(isNoteNameHint(payload.error.details.hint));
    eq(payload.error.details.suggestedPath, "Secrets clients/Contrat — Dupont & fils 7.md");
    eq(payload.error.details.suggestedName, "Contrat — Dupont & fils 7.md");
    ok(/note path is not a valid name/u.test(payload.error.message));
    ok(!JSON.stringify(payload.error.details.hint).includes("Dupont"));
    ok(captured.length >= 1);
    ok(!JSON.stringify(captured).includes("Dupont"), "neither the submitted path nor the proposal reaches the log sink");
    // forged details are dropped by the allowlist
    const forged = ErrorHandler.formatError(new McpError(BaseErrorCode.VALIDATION_ERROR, "x", {
      reasonCode: "note_name_forbidden_character", hint: "Dupont/secret.md", suggestedPath: "bad:name.md", suggestedName: "Dupont|.md" }));
    eq(forged.details.reasonCode, "note_name_forbidden_character");
    ok(forged.details.hint === undefined && forged.details.suggestedPath === undefined && forged.details.suggestedName === undefined);
  } finally { logger.error = originalError; }

  // ── 7. Headless filesystem writes (VaultFileService) ──────────────────────
  const vault = path.join(root, "vault");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  mkdirSync(path.join(vault, "Notes"), { recursive: true });
  writeFileSync(path.join(vault, "Notes", "Existante.md"), "x\n");
  writeFileSync(path.join(vault, "Notes", "[Legacy] note.md"), "old\n");
  const service = new VaultFileService(vault);
  const context = { requestId: "00000000-0000-4000-8000-000000000001", timestamp: new Date().toISOString(), operation: "test" };
  await service.writeAtomic("Notes/Nouvelle — idée (1).md", "ok\n", context);
  ok(existsSync(path.join(vault, "Notes", "Nouvelle — idée (1).md")));
  await assert.rejects(service.writeAtomic("Notes/Bad: name.md", "x\n", context), (error) => error.details.reasonCode === "note_name_forbidden_character" && error.details.suggestedPath === "Notes/Bad — name.md");
  if (process.platform === "linux") {
    // Case-sensitive file system: a new name that folds onto an existing one is the sync trap we refuse.
    await assert.rejects(service.writeAtomic("Notes/existante.md", "x\n", context), (error) => error.details.reasonCode === "note_name_case_collision");
  } else {
    // Windows/macOS: the same name in another case IS the existing file, so this is an edit, not a creation.
    await service.writeAtomic("Notes/existante.md", "x\n", context);
    ok((await service.read("Notes/Existante.md", context)).content === "x\n");
  }
  // an existing legacy-named file stays writable (no rename needed to edit it)
  await service.writeAtomic("Notes/[Legacy] note.md", "edited\n", context);
  await assert.rejects(service.moveFile("Notes/Existante.md", "Notes/Cible #2.md", context, { expectedHash: (await service.read("Notes/Existante.md", context)).hash }), (error) => error.details.reasonCode === "note_name_link_character");
  const moved = await service.moveFile("Notes/Existante.md", "Notes/Déplacée — ok.md", context, { expectedHash: (await service.read("Notes/Existante.md", context)).hash });
  eq(moved.result.path.replaceAll("\\", "/"), "Notes/Déplacée — ok.md");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`note name rules: ${checks} checks passed`);
