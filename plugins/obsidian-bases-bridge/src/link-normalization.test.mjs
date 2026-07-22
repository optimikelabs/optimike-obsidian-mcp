import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLinkish } from "./link-normalization.mjs";

test("normalizes Obsidian wikilinks used by collection.contains(link())", () => {
  assert.equal(normalizeLinkish("[[Projets]]"), "Projets");
  assert.equal(normalizeLinkish("[[Projets|Portefeuille]]"), "Projets");
  assert.equal(normalizeLinkish("[[Projets#Actifs]]"), "Projets");
});

test("normalizes Markdown paths without damaging plain values", () => {
  assert.equal(normalizeLinkish("Atlas/Maps/Projets.md"), "Atlas/Maps/Projets");
  assert.equal(normalizeLinkish("Projets"), "Projets");
});
