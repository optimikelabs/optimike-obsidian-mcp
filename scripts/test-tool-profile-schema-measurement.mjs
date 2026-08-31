import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { measureToolsList } from "./measure-tool-profile-schemas.mjs";

const left = measureToolsList([
  { name: "b", inputSchema: { required: [], type: "object" } },
  { name: "a", inputSchema: { type: "object", properties: { q: {} } } },
]);
const right = measureToolsList([
  { name: "a", inputSchema: { properties: { q: {} }, type: "object" } },
  { name: "b", inputSchema: { type: "object", required: [] } },
]);

assert.deepEqual(
  left,
  right,
  "measurement must ignore tool and object key order",
);
assert.equal(left.toolCount, 2);
assert.deepEqual(left.toolNames, ["a", "b"]);
assert.match(left.toolsListSha256, /^[a-f0-9]{64}$/u);
assert.ok(left.toolSchemaBytes > 0);

const offline = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/measure-tool-profile-schemas.mjs", "--offline-contract"],
    { cwd: process.cwd(), encoding: "utf8" },
  ),
);
assert.equal(offline.toolCount, 2);
assert.deepEqual(offline.toolNames, ["alpha", "zeta"]);

console.log(
  "PASS: tools/list schema measurement is deterministic, order-independent and UTF-8 byte based",
);
