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
assert.equal(removed.proof.removedIncidentEdgeCount, 1);
assert.equal(removed.proof.changedEdgeCount, 1);
assert.deepEqual(removed.proof.changedEdges, []);
assert.match(removed.proof.removedIncidentEdgesSha256, /^[a-f0-9]{64}$/u);

const exactNumericLiteral = compileCanvasPatch(
  `{
  "nodes": [
    {"id":"a","type":"text","x":0,"y":0,"width":100,"height":100,"text":"A"},
    {"id":"b","type":"text","x":200,"y":0,"width":100,"height":100,"text":"B"},
    {"id":"c","type":"text","x":400,"y":0,"width":100,"height":100,"text":"C"}
  ],
  "edges": [
    {"id":"ab","fromNode":"a","toNode":"b"},
    {"id":"bc","fromNode":"b","toNode":"c","unknownInteger":9007199254740993}
  ]
}\n`,
  [{ op: "delete_node", id: "a" }],
);
assert.match(
  exactNumericLiteral.nextContent,
  /"unknownInteger":9007199254740993/u,
  "untouched edge numeric literals must never be parsed and reserialized",
);
assert.deepEqual(
  JSON.parse(exactNumericLiteral.nextContent).edges.map((edge) => edge.id),
  ["bc"],
);
assert.throws(
  () =>
    compileCanvasPatch(source, [
      { op: "delete_node", id: "a" },
      {
        op: "connect_nodes",
        id: "ab",
        fromNode: "b",
        toNode: "b",
      },
    ]),
  /already removed implicitly/u,
);
assert.throws(
  () =>
    compileCanvasPatch(source, [
      {
        op: "connect_nodes",
        id: "new-ab",
        fromNode: "a",
        toNode: "b",
      },
      { op: "delete_node", id: "a" },
    ]),
  /already changed before its implicit removal/u,
);

const largeText = "x".repeat(1_048_576);
assert.throws(
  () =>
    compileCanvasPatch(
      `${JSON.stringify({ nodes: [], edges: [] })}\n`,
      Array.from({ length: 6 }, (_, index) => ({
        op: "add_text_node",
        id: `large-${index}`,
        text: largeText,
        x: index * 220,
        y: 0,
        width: 200,
        height: 100,
      })),
    ),
  /exceeds .* during compilation/u,
);

const stressEdgeIds = Array.from(
  { length: 300 },
  (_, index) => `edge-${String(index).padStart(3, "0")}-${"x".repeat(247)}`,
);
const compactProof = compileCanvasPatch(
  JSON.stringify({
    nodes: [
      {
        id: "stress-root",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: "Root",
      },
      ...stressEdgeIds.map((_, index) => ({
        id: `stress-leaf-${index}`,
        type: "text",
        x: 200,
        y: index * 120,
        width: 100,
        height: 100,
        text: "Leaf",
      })),
    ],
    edges: stressEdgeIds.map((id, index) => ({
      id,
      fromNode: "stress-root",
      toNode: `stress-leaf-${index}`,
    })),
  }),
  [{ op: "delete_node", id: "stress-root" }],
).proof;
assert.equal(compactProof.removedIncidentEdgeCount, 300);
assert.equal(compactProof.changedEdgeCount, 300);
assert.deepEqual(compactProof.changedEdges, []);
assert.ok(
  Buffer.byteLength(JSON.stringify(compactProof), "utf8") < 128 * 1024,
  "compiler-generated proof must fit the durable projection byte contract",
);

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
  /Canvas edge must have a non-empty, unpadded, well-formed string id/u,
);
assert.throws(
  () =>
    compileCanvasPatch(
      JSON.stringify({
        nodes: [
          {
            id: " padded ",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: "Padded",
          },
        ],
        edges: [],
      }),
      [
        {
          op: "add_text_node",
          id: "valid",
          text: "After",
          x: 200,
          y: 0,
          width: 100,
          height: 100,
        },
      ],
    ),
  /Canvas node must have a non-empty, unpadded, well-formed string id/u,
);
assert.throws(
  () =>
    compileCanvasPatch(
      JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: "A",
          },
          {
            id: "b",
            type: "text",
            x: 200,
            y: 0,
            width: 100,
            height: 100,
            text: "B",
          },
        ],
        edges: [{ id: "ab", fromNode: "a", toNode: "b", fromSide: ["top"] }],
      }),
      [{ op: "move_node", id: "a", x: 10, y: 10 }],
    ),
  /current Canvas graph is invalid/u,
);

console.log(
  "PASS: Canvas compiler preserves unknown values, validates graph effects, and fails closed",
);
