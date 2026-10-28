import assert from "node:assert/strict";
import { load } from "js-yaml";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";

const { compileBaseConfigPatch } = await import("../dist/services/baseFullConfigCompiler.js");
const { compileCanvasPatch } = await import("../dist/services/canvasPatchCompiler.js");

const BASE = `# Vues du projet
filters:
  and:
    - file.inFolder("Projets")
formulas:
  age: now() - file.ctime # en jours
properties:
  formula.age:
    displayName: Âge
views:
  - type: table
    name: Tous
    order:
      - file.name
      - formula.age
  - type: cards
    name: Cartes
    image: note.cover
`;
const reason = (code) => (error) => { assert.equal(error.details?.reasonCode, code, error.message); return true; };
let groups = 0;

{
  const { nextYaml, proof } = compileBaseConfigPatch(BASE, [
    { op: "set_filters", filters: { and: ['file.inFolder("Projets")', { not: ['statut == "clos"'] }] } },
    { op: "set_property", property: "statut", key: "displayName", value: "Statut" },
    { op: "set_summary", name: "moyenne", formula: "values.mean().round(1)" },
    { op: "add_view", view: { type: "list", name: "Liste", filters: { or: ['priorité == "haute"'] }, limit: 20 }, position: 1 },
    { op: "set_view_key", view: "Tous", key: "groupBy", value: { property: "statut", direction: "ASC" } },
    { op: "set_view_key", view: "Tous", key: "sort", value: [{ property: "formula.age", direction: "DESC" }] },
    { op: "set_view_key", view: "Tous", key: "summaries", value: { "formula.age": "Average" } },
    { op: "set_view_key", view: "Cartes", key: "name", value: "Galerie" },
    { op: "delete_view_key", view: "Galerie", key: "image" },
    { op: "move_view", view: "Galerie", position: 0 },
  ]);
  const after = load(nextYaml);
  assert.deepEqual(after.filters, { and: ['file.inFolder("Projets")', { not: ['statut == "clos"'] }] });
  assert.equal(after.properties.statut.displayName, "Statut");
  assert.equal(after.properties["formula.age"].displayName, "Âge", "untouched property kept");
  assert.equal(after.summaries.moyenne, "values.mean().round(1)");
  assert.deepEqual(after.views.map((view) => view.name), ["Galerie", "Tous", "Liste"]);
  assert.equal(after.views[0].image, undefined);
  assert.deepEqual(after.views[1].groupBy, { property: "statut", direction: "ASC" });
  assert.deepEqual(after.views[1].order, ["file.name", "formula.age"], "untouched view keys kept");
  assert.ok(nextYaml.startsWith("# Vues du projet\n"), "comments kept");
  assert.ok(nextYaml.includes("# en jours"), "inline comments kept");
  assert.equal(proof.sourcePreservation, "semantic-identical-outside-authorized-paths");
  assert.equal(proof.formattingPreserved, true);
  assert.ok(proof.changedPaths.includes("views[Tous].groupBy"));
  groups++;
}
{
  const crlf = BASE.replace(/\n/g, "\r\n");
  const { nextYaml, proof } = compileBaseConfigPatch(crlf, [{ op: "set_formula", name: "taille", expression: "file.size" }]);
  assert.equal(proof.lineEnding, "crlf");
  assert.equal(/(^|[^\r])\n/.test(nextYaml), false, "CRLF kept everywhere");
  const { nextYaml: plugin, proof: pluginProof } = compileBaseConfigPatch(BASE, [{ op: "set_view_key", view: "Tous", key: "type", value: "kanban" }]);
  assert.equal(load(plugin).views[0].type, "kanban");
  assert.ok(pluginProof.warnings.includes("base-view-type-plugin"), "plugin view types are reported, not refused");
  groups++;
}
{
  const refuse = (ops, code, source = BASE) => assert.throws(() => compileBaseConfigPatch(source, ops), reason(code));
  refuse([{ op: "set_view_key", view: "Absente", key: "limit", value: 5 }], "base_config_view_missing");
  refuse([{ op: "add_view", view: { type: "table", name: "Tous" } }], "base_config_view_exists");
  refuse([{ op: "set_view_key", view: "Tous", key: "name", value: "Cartes" }], "base_config_view_exists");
  refuse([{ op: "delete_view", view: "Tous" }, { op: "delete_view", view: "Cartes" }], "base_config_last_view");
  refuse([{ op: "set_filters", filters: { and: [] } }], "base_config_filter_invalid");
  refuse([{ op: "set_filters", filters: { and: ["a"], or: ["b"] } }], "base_config_filter_invalid");
  refuse([{ op: "delete_view_key", view: "Tous", key: "type" }], "base_config_view_invalid");
  refuse([{ op: "delete_formula", name: "absente" }], "base_config_target_missing");
  refuse([{ op: "set_view_key", view: "Tous", key: "type", value: "Not A Type!" }], "base_config_result_invalid");
  refuse([{ op: "set_formula", name: "x", expression: "1" }], "base_config_yaml_unsupported", "a: &ref 1\nviews:\n  - type: table\n    name: T\n    x: *ref\n");
  refuse([{ op: "set_formula", name: "x", expression: "1" }], "base_config_yaml_unsupported", "views:\r\n  - type: table\n    name: T\n");
  refuse([], "base_config_patch_size");
  groups++;
}
{
  const deleted = load(compileBaseConfigPatch(BASE, [
    { op: "delete_formula", name: "age" },
    { op: "delete_property", property: "formula.age" },
    { op: "delete_filters" },
    { op: "set_view_key", view: "Tous", key: "order", value: ["file.name"] },
  ]).nextYaml);
  assert.equal(deleted.formulas, undefined, "an emptied section is removed");
  assert.equal(deleted.properties, undefined);
  assert.equal(deleted.filters, undefined);
  groups++;
}
{
  const CANVAS = JSON.stringify({ nodes: [
    { id: "a", type: "text", text: "Idée", x: 0, y: 0, width: 200, height: 60 },
    { id: "b", type: "text", text: "Suite", x: 300, y: 0, width: 200, height: 60 },
  ], edges: [{ id: "e", fromNode: "a", toNode: "b" }], extra: { keep: true } }, null, "\t");
  const { nextContent } = compileCanvasPatch(CANVAS, [
    { op: "add_node", id: "f", type: "file", file: "Projets/Note.md", subpath: "#Plan", x: 0, y: 200, width: 400, height: 300, color: "4" },
    { op: "add_node", id: "l", type: "link", url: "https://obsidian.md", x: 500, y: 200, width: 300, height: 200 },
    { op: "add_node", id: "g", type: "group", label: "Bloc", background: "X/Images/fond.webp", backgroundStyle: "cover", x: -50, y: -50, width: 900, height: 700 },
    { op: "set_node_fields", id: "a", fields: { color: "#ff8800", text: "Idée revue" } },
    { op: "update_edge", id: "e", fields: { label: "mène à", toEnd: "arrow", fromEnd: "none", color: "2", toNode: "f" } },
    { op: "connect_nodes", id: "e2", fromNode: "b", toNode: "l", toEnd: "none" },
  ]);
  const after = JSON.parse(nextContent);
  const node = (id) => after.nodes.find((item) => item.id === id);
  assert.equal(node("f").subpath, "#Plan");
  assert.equal(node("l").url, "https://obsidian.md");
  assert.equal(node("g").backgroundStyle, "cover");
  assert.equal(node("a").color, "#ff8800");
  assert.equal(node("a").text, "Idée revue");
  assert.deepEqual(after.edges[0], { id: "e", fromNode: "a", toNode: "f", label: "mène à", toEnd: "arrow", fromEnd: "none", color: "2" });
  assert.equal(after.edges[1].toEnd, "none");
  assert.deepEqual(after.extra, { keep: true }, "unknown root fields kept");
  const removed = JSON.parse(compileCanvasPatch(nextContent, [
    { op: "set_node_fields", id: "a", fields: { color: null } },
    { op: "update_edge", id: "e", fields: { label: null, toEnd: null } },
  ]).nextContent);
  assert.equal("color" in removed.nodes.find((item) => item.id === "a"), false, "null removes an optional field");
  assert.equal("label" in removed.edges[0], false);
  const refuse = (ops, code) => assert.throws(() => compileCanvasPatch(CANVAS, ops), reason(code));
  refuse([{ op: "add_node", id: "x", type: "link", text: "nope", url: "https://a.b", x: 0, y: 0, width: 1, height: 1 }], "canvas_field_invalid");
  refuse([{ op: "set_node_fields", id: "a", fields: { url: "https://a.b" } }], "canvas_graph_invalid_after");
  refuse([{ op: "set_node_fields", id: "a", fields: { text: null } }], "canvas_graph_invalid_after");
  refuse([{ op: "set_node_fields", id: "a", fields: { type: "file" } }], "canvas_field_unsupported");
  refuse([{ op: "update_edge", id: "e", fields: { fromNode: null } }], "canvas_field_invalid");
  refuse([{ op: "update_edge", id: "e", fields: { toNode: "zzz" } }], "canvas_graph_invalid_after");
  refuse([{ op: "update_edge", id: "e", fields: { toEnd: "diamond" } }], "canvas_graph_invalid_after");
  refuse([{ op: "update_edge", id: "nope", fields: { label: "x" } }], "canvas_edge_missing");
  refuse([{ op: "delete_node", id: "b" }, { op: "update_edge", id: "e", fields: { label: "x" } }], "canvas_edge_reuse_after_incident_removal");
  groups++;
}
console.log(`base config and canvas full patch: ${groups} groups passed`);
