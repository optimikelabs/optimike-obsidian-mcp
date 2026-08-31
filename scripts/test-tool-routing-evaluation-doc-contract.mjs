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
    "EXPECTED_CANDIDATE_COMMIT",
    "verifierSha",
    "candidateSha",
    "P6_COMPARE_COMMIT",
    "Completed",
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
  assert.match(content, /stale|ancien build/u);
  assert.match(content, /detached worktree|worktree détaché/u);
  assert.match(content, /fresh LLM\s+campaign|nouvelle campagne LLM/u);
  assert.match(content, /not\s+a green review|n'est pas une review verte/u);
}

console.log(
  "PASS: bilingual P6 routing, profile, schema-cost and future-major contracts agree",
);
