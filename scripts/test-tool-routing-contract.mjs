import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerToolRoutingResource,
  TOOL_ROUTING_RESOURCE_TEXT,
  TOOL_ROUTING_RESOURCE_URI,
} from "../dist/mcp-server/resources/toolRoutingResource.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

let registeredResource;
registerToolRoutingResource({
  registerResource(name, uri, metadata, callback) {
    assert.equal(
      registeredResource,
      undefined,
      "routing resource must be unique",
    );
    registeredResource = { name, uri, metadata, callback };
  },
});

assert.ok(registeredResource, "routing resource was not registered");
assert.equal(registeredResource.name, "optimike-tool-routing");
assert.equal(registeredResource.uri, TOOL_ROUTING_RESOURCE_URI);
assert.equal(registeredResource.metadata.mimeType, "text/markdown");
const readResult = await registeredResource.callback();
assert.deepEqual(readResult, {
  contents: [
    {
      uri: TOOL_ROUTING_RESOURCE_URI,
      mimeType: "text/markdown",
      text: TOOL_ROUTING_RESOURCE_TEXT,
    },
  ],
});

const routingPairs = [
  ["smart_search", "smart_semantic_search"],
  ["smart-search", "smart_semantic_search"],
  ["list_all_tasks", "operon_list_tasks"],
  ["query_tasks", "operon_query_tasks"],
  ["obsidian_update_note", "obsidian_note_replace_plan"],
  ["obsidian_search_replace", "obsidian_note_replace_plan"],
  ["obsidian_manage_frontmatter", "obsidian_frontmatter_patch_plan"],
  ["bases_upsert_config", "bases_formula_patch_plan"],
  ["obsidian_manage_canvas", "obsidian_canvas_patch_plan"],
];
for (const [overlappingTool, preferredTool] of routingPairs) {
  assert.ok(
    TOOL_ROUTING_RESOURCE_TEXT.includes(overlappingTool),
    `routing resource omits ${overlappingTool}`,
  );
  assert.ok(
    TOOL_ROUTING_RESOURCE_TEXT.includes(preferredTool),
    `routing resource omits preferred tool ${preferredTool}`,
  );
}

for (const relativePath of [
  "docs/mcp-routing-guide.md",
  "docs/mcp-routing-guide.fr.md",
]) {
  const content = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  assert.ok(
    content.includes(TOOL_ROUTING_RESOURCE_URI),
    `${relativePath} does not advertise the routing resource`,
  );
  for (const [, preferredTool] of routingPairs) {
    assert.ok(
      content.includes(preferredTool),
      `${relativePath} omits preferred route ${preferredTool}`,
    );
  }
}

console.log(
  "PASS: canonical tool-routing resource, overlap precedence and bilingual documentation agree",
);
