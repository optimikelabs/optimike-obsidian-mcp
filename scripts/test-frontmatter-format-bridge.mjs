import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { inspectFrontmatterFormat } from "../plugins/obsidian-atomic-write-bridge/src/frontmatterFormat.ts";

// Obsidian 1.15.0's exported stringifyYaml is the same function called by
// processFrontMatter. Its bundled yaml version is unknown; replay in Obsidian
// is mandatory. These are the options observed in its asar.
const obsidianOptions = (value) => stringify(value, null, {
  nullStr: "", lineWidth: 0, aliasDuplicateObjects: false,
});
const types = { getAssignedWidget: (key) => ({ statut: "multitext", nombre: "number", coche: "checkbox" })[key] ?? null };

test("read-only serializer uses the observed Obsidian options and signals types", () => {
  const source = "statut: 'actif' # comment\r\nvide: null\r\ntexte: >-\r\n  bonjour\r\n  monde\r\ntags: [un, deux]\r\ndate: \"2026-10-21\"\r\nnombre: 3\r\ncoche: true\r\naccent: été\r\n";
  const result = inspectFrontmatterFormat(source, parse, obsidianOptions, types);
  assert.equal(result.canonicalYaml, "statut: actif\nvide:\ntexte: bonjour monde\ntags:\n  - un\n  - deux\ndate: 2026-10-21\nnombre: 3\ncoche: true\naccent: été\n");
  assert.deepEqual(result.warnings.find(w => w.key === "statut"), { key: "statut", reason: "type_mismatch", declaredType: "multitext", actualType: "text" });
  assert.ok(result.warnings.some(w => w.key === "tags" && w.reason === "untyped"));
  assert.ok(!result.warnings.some(w => w.key === "nombre" || w.key === "coche"));
  assert.equal(inspectFrontmatterFormat(result.canonicalYaml, parse, obsidianOptions, types).canonicalYaml, result.canonicalYaml);
});

test("rejects non-mapping roots and never returns parser diagnostics", () => {
  for (const input of ["- a\n", "texte\n", "null\n"]) {
    assert.throws(() => inspectFrontmatterFormat(input, parse, obsidianOptions, types), /invalid_frontmatter/);
  }
});
