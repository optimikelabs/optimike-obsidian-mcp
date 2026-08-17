import assert from "node:assert/strict";
import { compileCanvasPatch } from "../dist/services/canvasPatchCompiler.js";

const source = `{
  "nodes": [
    {"id":"a","type":"text","x":0,"y":0,"width":200,"height":100,"text":"Before","custom":{"keep":true}},
    {"id":"b","type":"file","x":300,"y":0,"width":200,"height":100,"file":"Notes/B.md","unknown":"stay"}
  ],
  "edges": [
    {"id":"ab","fromNode":"a","toNode":"b","customEdge":7}
  ],
  "customRoot": {"theme":"private"}
}
`;

const compiled = compileCanvasPatch(source, [
  { op: "set_text", id: "a", text: "After" },
  { op: "move_node", id: "b", x: 320, y: 40 },
  {
    op: "add_text_node",
    id: "c",
    text: "New",
    x: 0,
    y: 180,
    width: 240,
    height: 120,
  },
  {
    op: "connect_nodes",
    id: "bc",
    fromNode: "b",
    toNode: "c",
    label: "next",
  },
]);
const after = JSON.parse(compiled.nextContent);
assert.equal(after.nodes.find((node) => node.id === "a").text, "After");
assert.deepEqual(after.nodes.find((node) => node.id === "a").custom, {
  keep: true,
});
assert.equal(after.nodes.find((node) => node.id === "b").unknown, "stay");
assert.deepEqual(after.customRoot, { theme: "private" });
assert.equal(after.edges.find((edge) => edge.id === "ab").customEdge, 7);
assert.deepEqual(compiled.proof.graphAfter, { nodes: 3, edges: 2 });
assert.equal(
  compiled.proof.rootUnknownBeforeSha256,
  compiled.proof.rootUnknownAfterSha256,
);
assert.equal(
  compiled.proof.untouchedEntitiesBeforeSha256,
  compiled.proof.untouchedEntitiesAfterSha256,
);

const removed = compileCanvasPatch(source, [{ op: "delete_node", id: "a" }]);
const removedGraph = JSON.parse(removed.nextContent);
assert.deepEqual(
  removedGraph.nodes.map((node) => node.id),
  ["b"],
);
assert.deepEqual(removedGraph.edges, []);
assert.deepEqual(removed.proof.removedIncidentEdges, ["ab"]);

assert.throws(
  () =>
    compileCanvasPatch(source, [
      { op: "set_text", id: "a", text: "one" },
      { op: "move_node", id: "a", x: 1, y: 2 },
    ]),
  /targeted more than once/u,
);
assert.throws(
  () =>
    compileCanvasPatch(source, [
      {
        op: "connect_nodes",
        id: "missing",
        fromNode: "a",
        toNode: "nope",
      },
    ]),
  /endpoints must exist/u,
);
assert.throws(
  () =>
    compileCanvasPatch(
      '{"nodes":[{"id":"a"}],"edges":[{"id":"e","fromNode":"a","toNode":"missing"}]}',
      [{ op: "delete_node", id: "a" }],
    ),
  /current Canvas graph is invalid/u,
);
assert.throws(
  () =>
    compileCanvasPatch(
      JSON.stringify({
        nodes: [
          {
            id: "root",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: "Root",
          },
          {
            id: "leaf",
            type: "text",
            x: 200,
            y: 0,
            width: 100,
            height: 100,
            text: "Leaf",
          },
        ],
        edges: [{ id: "e".repeat(257), fromNode: "root", toNode: "leaf" }],
      }),
      [{ op: "delete_node", id: "root" }],
    ),
  /Canvas edge must have a non-empty string id of at most 256 characters/u,
);

console.log(
  "PASS: Canvas compiler preserves unknown values, validates graph effects, and fails closed",
);
