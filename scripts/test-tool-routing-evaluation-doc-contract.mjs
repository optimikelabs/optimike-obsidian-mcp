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

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(packageJson.scripts["test:tool-routing:fast"]);
assert.match(
  packageJson.scripts["test:tool-routing"],
  /test-tool-routing-scorer\.mjs/u,
);
assert.doesNotMatch(
  packageJson.scripts["test:tool-routing:fast"],
  /test-tool-routing-scorer\.mjs/u,
);

const runtimeWorkflow = fs.readFileSync(".github/workflows/runtime.yml", "utf8");
assert.match(runtimeWorkflow, /timeout-minutes:\s*20/u);
assert.match(runtimeWorkflow, /npm run test:tool-routing:fast/u);
assert.doesNotMatch(runtimeWorkflow, /run:\s*npm run test:tool-routing\s*$/mu);

const p6Workflow = fs.readFileSync(
  ".github/workflows/p6-tool-routing-evaluation.yml",
  "utf8",
);
assert.match(p6Workflow, /runner\.os == 'Linux'[\s\S]*npm run test:tool-routing/u);
assert.match(
  p6Workflow,
  /runner\.os == 'Windows'[\s\S]*npm run test:tool-routing:fast/u,
);
assert.match(p6Workflow, /timeout-minutes:\s*20/u);

const p4Workflow = fs.readFileSync(
  ".github/workflows/tool-surface-p4.yml",
  "utf8",
);
assert.doesNotMatch(p4Workflow, /run:\s*node scripts\/test-tool-routing-scorer\.mjs/u);
assert.match(p4Workflow, /timeout-minutes:\s*15/u);

console.log(
  "PASS: CI keeps one hermetic routing owner and bounded cross-platform contracts",
);
