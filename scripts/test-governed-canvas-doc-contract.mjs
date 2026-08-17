#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = [
  "docs/governed-canvas-p3.md",
  "docs/governed-canvas-p3.fr.md",
  "docs/adr/ADR-Governed-Canvas-P3.md",
  "docs/mcp-routing-guide.md",
  "docs/mcp-routing-guide.fr.md",
  "plugins/obsidian-atomic-write-bridge/README.md",
  "OPERATIONS.md",
  "OPERATIONS.fr.md",
  "src/mcp-server/resources/toolRoutingResource.ts",
  "src/mcp-server/tools/governedCanvasTools/registration.ts",
].map((file) => [file, readFileSync(file, "utf8")]);
const joined = files.map(([file, content]) => `${file}\n${content}`).join("\n");

for (const tool of [
  "obsidian_canvas_patch_plan",
  "obsidian_canvas_patch_apply",
  "obsidian_canvas_patch_status",
  "obsidian_canvas_patch_recover",
]) {
  assert.match(joined, new RegExp(tool, "u"), `${tool} missing from P3 docs`);
}
for (const invariant of [
  "Vault.process",
  "SHA-256",
  "disabled by default",
  "désactivé par défaut",
  "unknown root",
  "valeurs inconnues",
  "Operon Bridge pilot vault",
  "coffre pilote Operon Bridge",
  "Atomic Write Bridge 0.4.0",
  "MCP_OBSIDIAN_CANVAS_JOURNAL_PATH",
  "OBSIDIAN_CANVAS_CANARY_PATH",
  "OBSIDIAN_CANVAS_CANARY_CONFIRM",
  "I_UNDERSTAND_THIS_DISPOSABLE_CANVAS_WILL_BE_MUTATED_AND_RESTORED",
  "OBSIDIAN_API_KEY",
  "OBSIDIAN_BASE_URL",
  "MCP_WRITE_MODE",
  "smoke:governed-canvas-live",
]) {
  assert.equal(
    joined.includes(invariant),
    true,
    `P3 documentation invariant missing: ${invariant}`,
  );
}
assert.match(joined, /pre-dispatch interruption/u);
assert.match(joined, /interruption avant envoi/u);
assert.match(joined, /post-write\s+response loss/u);
assert.match(joined, /perte de réponse post-écriture/u);
assert.match(joined, /OS\s+temporary evidence JSON path/u);
assert.match(joined, /dossier temporaire de l'OS/u);
assert.match(joined, /separate \*\*Allow atomic Canvas writes\*\* gate/u);
assert.match(joined, /gate séparé \*\*Autoriser les écritures Canvas/u);
assert.match(
  joined,
  /direct helper remains a headless-filesystem\s+compatibility path without a durable receipt/u,
);
assert.match(joined, /helper direct reste une voie de compatibilité/u);
assert.doesNotMatch(
  joined,
  /generic public operation API is (?:available|exposed)/iu,
  "P3 must not claim a generic public operation surface",
);

console.log(
  "PASS: governed Canvas P3 documentation matches the bounded graph, separate gate, CAS, and pilot-vault contract",
);
