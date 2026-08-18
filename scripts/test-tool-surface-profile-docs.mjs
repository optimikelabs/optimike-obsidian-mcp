import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

for (const relative of [
  "docs/tool-surface-profiles.md",
  "docs/tool-surface-profiles.fr.md",
]) {
  const content = read(relative);
  for (const profile of ["standard", "authoring", "tasks", "full"]) {
    assert.ok(content.includes(`\`${profile}\``), `${relative} omits ${profile}`);
  }
  assert.ok(content.includes("smart_semantic_search"));
  assert.ok(content.includes("smart_search"));
  assert.ok(content.includes("smart-search"));
  assert.ok(
    /3\.0/u.test(content),
    `${relative} must document the major-version alias-removal boundary`,
  );
  assert.ok(content.includes("/mcp/standard"));
  assert.ok(content.includes("/mcp/tasks"));
}

for (const relative of [
  "docs/mcp-routing-guide.md",
  "docs/mcp-routing-guide.fr.md",
]) {
  const content = read(relative);
  assert.ok(content.includes("smart_semantic_search"));
  assert.ok(
    !content.includes("`smart_search`") && !content.includes("`smart-search`"),
    `${relative} must teach only the canonical semantic-search tool`,
  );
  assert.ok(content.includes("tool-surface-profiles"));
}

for (const relative of ["docs/README.md", "docs/README.fr.md"]) {
  const content = read(relative);
  assert.ok(
    content.includes("tool-surface-profiles"),
    `${relative} must route readers to the profile contract`,
  );
}

const englishReadme = read("README.md");
const frenchReadme = read("README.fr.md");
for (const content of [englishReadme, frenchReadme]) {
  assert.ok(content.includes("tool-surface-profiles"));
  assert.ok(content.includes("smart_semantic_search"));
  assert.ok(content.includes("--tool-profile standard"));
  assert.ok(content.includes("/mcp/standard"));
  assert.ok(content.includes("/mcp/full"));
}

const toolSpec = read("docs/obsidian_mcp_tools_spec.md");
assert.ok(toolSpec.includes("`smart_semantic_search`: **canonical**"));
assert.ok(toolSpec.includes("`smart_search`: deprecated 2.x compatibility alias, visible only in `full`"));
assert.ok(toolSpec.includes("`smart-search`: deprecated 2.x compatibility alias, visible only in `full`"));
assert.ok(toolSpec.includes("physical removal is reserved\nfor 3.0"));

const routingResource = read("src/mcp-server/resources/toolRoutingResource.ts");
assert.ok(routingResource.includes("smart_semantic_search"));
assert.ok(!routingResource.includes("`smart_search`"));
assert.ok(!routingResource.includes("`smart-search`"));

console.log("PASS: README/profile docs own compatibility while routing docs teach only smart_semantic_search");
