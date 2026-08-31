#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = [
  "docs/governed-text-patch-p4.md",
  "docs/governed-text-patch-p4.fr.md",
];
const required = [
  "obsidian_text_patch_plan",
  "apply",
  "status",
  "recover",
  "append_body",
  "prepend_body",
  "replace_literal",
  "replace_all",
  "obsidian.note.replace",
  "Atomic Write",
  "obsidian_update_note",
  "obsidian_search_replace",
  "full",
  "smoke:governed-text-patch-live",
  "OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT",
  "logs/governed-text-patch-live/",
];

for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const token of required) {
    assert.ok(content.includes(token), `${file} lost ${token}`);
  }
  assert.ok(!/If-Match/iu.test(content), `${file} must not claim Local REST If-Match`);
  assert.ok(!/generic public operation_/iu.test(content));
}

const representationContracts = {
  "docs/governed-text-patch-p4.md": [
    "LF, CRLF, and mixed line endings are supported",
    "bare CR or a UTF-8 BOM",
    "rejected fail-closed",
    "JavaScript UTF-16 code units",
    "UTF-8\nbytes",
    "CommonMark-like scanner and Operon parsing",
    "blockquote fence ambiguity",
    "remains protected",
  ],
  "docs/governed-text-patch-p4.fr.md": [
    "LF, CRLF et mixtes sont supportées",
    "CR nu ou un BOM UTF-8",
    "refusé fail-closed",
    "unités de code UTF-16 JavaScript",
    "octets UTF-8",
    "scanner CommonMark-like et le parsing Operon",
    "ambiguïté de fence\ndans une citation",
    "Tout désaccord reste protégé",
  ],
};

for (const [file, statements] of Object.entries(representationContracts)) {
  const content = (await readFile(file, "utf8")).replace(/\r\n/gu, "\n");
  for (const statement of statements) {
    assert.ok(
      content.includes(statement),
      `${file} lost text representation contract: ${statement}`,
    );
  }
}

const english = await readFile("docs/governed-text-patch-p4.md", "utf8");
assert.ok(
  english.includes("operating-system temporary directory"),
  "English P4 live-canary contract lost the OS evidence location",
);

const french = await readFile("docs/governed-text-patch-p4.fr.md", "utf8");
for (const token of [
  "smoke:governed-text-patch-live",
  "OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT",
  "dossier temporaire du système",
  "logs/governed-text-patch-live/",
]) {
  assert.ok(french.includes(token), `French P4 live-canary contract lost ${token}`);
}

const canary = await readFile("scripts/smoke-governed-text-patch-live.mjs", "utf8");
for (const token of [
  "OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT",
  "OBSIDIAN_TEXT_PATCH_CANARY_VAULT",
  "original-content.md",
  "governed-text-patch-live-evidence-",
  "logs\", \"governed-text-patch-live",
  "/extensions/obsidian-atomic-write-bridge/notes/cas",
  "process.on(\"SIGINT\"",
]) {
  assert.ok(canary.includes(token), `P4 live canary lost ${token}`);
}

const routing = await readFile("src/mcp-server/resources/toolRoutingResource.ts", "utf8");
assert.match(routing, /obsidian_text_patch_plan/u);
assert.match(routing, /body/u);
assert.match(routing, /task lines/u);

for (const index of ["docs/README.md", "docs/README.fr.md"]) {
  const content = await readFile(index, "utf8");
  assert.match(content, /governed-text-patch-p4/u, `${index} lost P4 routing`);
}

const toolSpec = await readFile("docs/obsidian_mcp_tools_spec.md", "utf8");
for (const tool of [
  "obsidian_text_patch_plan",
  "obsidian_text_patch_apply",
  "obsidian_text_patch_status",
  "obsidian_text_patch_recover",
]) {
  assert.match(toolSpec, new RegExp(tool, "u"), `tool spec lost ${tool}`);
}

console.log("PASS: bilingual P4 text-patch docs preserve CAS, recovery, routing, and compatibility boundaries.");
