import assert from "node:assert/strict";
import fs from "node:fs";

for (const relativePath of [
  "docs/tool-routing-evaluation-p6.md",
  "docs/tool-routing-evaluation-p6.fr.md",
]) {
  const content = fs.readFileSync(relativePath, "utf8");
  for (const required of [
    "standard",
    "authoring",
    "tasks",
    "full",
    "60",
    "81",
    "31",
    "tools/list",
    "SHA-256",
    "N/A",
    "measure-tool-profile-schemas.mjs",
    "operon_list_tasks",
    "operon_query_tasks",
  ]) {
    assert.ok(
      content.includes(required),
      `${relativePath} lost P6 contract marker ${required}`,
    );
  }
  assert.match(content, /major|majeure/u);
  assert.match(content, /no network call|aucun appel\s+réseau/u);
  assert.match(content, /allowlist/u);
  assert.match(content, /case-context|contexte de cas/u);
}

console.log(
  "PASS: bilingual P6 routing, profile, schema-cost and future-major contracts agree",
);
