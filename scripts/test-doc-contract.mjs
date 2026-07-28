#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const excludedDirectories = new Set([".git", "dist", "node_modules"]);

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolute);
    }
  }
  return files;
}

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

const readme = await text("README.md");
const readmeFr = await text("README.fr.md");
assert.ok(readme.split(/\r?\n/).length <= 220, "README.md must stay concise");
assert.ok(
  readmeFr.split(/\r?\n/).length <= 220,
  "README.fr.md must stay concise",
);

for (const [name, content, forbidden] of [
  ["README.md", readme, [/stdio-only/i, /HTTP handoff is denied/i]],
  ["README.fr.md", readmeFr, [/stdio-only/i, /handoff (est )?refusé en HTTP/i]],
]) {
  assert.match(content, /local_path/);
  assert.match(content, /http_ticket/);
  for (const pattern of forbidden) {
    assert.doesNotMatch(
      content,
      pattern,
      `${name} contains stale handoff text`,
    );
  }
}

const externalAdr = await text("docs/adr/ADR-External-Document-Roots.md");
const httpAdr = await text("docs/adr/ADR-HTTP-External-Artifact-Delivery.md");
assert.match(externalAdr, /handoff transport amended/i);
assert.match(httpAdr, /Status: accepted and implemented on `main`/);
assert.match(httpAdr, /remote HTTP remains pilot-only/i);

const matrix = await text("docs/runtime-capability-matrix.md");
const matrixFr = await text("docs/runtime-capability-matrix.fr.md");
const commonTools = [
  "external_runtime_status",
  "external_roots_list",
  "external_list",
  "external_stat",
  "external_read",
  "external_handoff",
  "operon_status",
  "operon_get_configuration",
  "operon_list_tasks",
  "operon_get_task",
  "operon_query_tasks",
  "operon_query_saved_filter",
  "operon_validate",
  "operon_adopt_task",
  "operon_create_task",
  "operon_update_task",
  "operon_transition_task",
  "operon_convert_task",
  "operon_relocate_task",
];
for (const tool of commonTools) {
  assert.ok(matrix.includes(`\`${tool}\``), `Matrix omits ${tool}`);
  assert.ok(matrixFr.includes(`\`${tool}\``), `French matrix omits ${tool}`);
}
assert.match(matrix, /\| Admin filesystem\s+\| No\s+\| No/);
assert.match(matrixFr, /\| Admin filesystem\s+\| Non\s+\| Non/);

const packageJson = JSON.parse(await text("package.json"));
assert.equal(packageJson.scripts["start:http"], "node scripts/run-http.mjs");
assert.equal(packageJson.scripts["start:daemon"], "node scripts/run-http.mjs");
assert.equal(packageJson.scripts.inspect, "node scripts/run-inspector.mjs");
assert.equal(
  packageJson.bin["optimike-obsidian-mcp-proxy"],
  "dist/stdio-proxy.js",
);

const mcpConfig = JSON.parse(await text("mcp.json"));
const httpExample = mcpConfig.mcpServers["optimike-obsidian-mcp-http"].env;
assert.equal(httpExample.DANGEROUSLY_OMIT_AUTH, "true");
assert.equal(httpExample.MCP_HTTP_HANDOFF_ENABLED, "false");
assert.equal("MCP_AUTH_SECRET_KEY" in httpExample, false);

const bilingualPairs = [
  ["README.md", "README.fr.md"],
  ["OPERATIONS.md", "OPERATIONS.fr.md"],
  ["SECURITY.md", "SECURITY.fr.md"],
  ["docs/README.md", "docs/README.fr.md"],
  ["docs/external-roots-setup.md", "docs/external-roots-setup.fr.md"],
  ["docs/runtime-capability-matrix.md", "docs/runtime-capability-matrix.fr.md"],
  ["docs/mcp-routing-guide.md", "docs/mcp-routing-guide.fr.md"],
  ["docs/headless-server-profile.md", "docs/headless-server-profile.fr.md"],
];
for (const pair of bilingualPairs) {
  for (const file of pair) await access(path.join(root, file));
}

const brokenLinks = [];
for (const file of await markdownFiles(root)) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (!target || /^(?:https?:|mailto:|file:|#)/i.test(target)) {
      continue;
    }
    target = target.replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target) continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // The filesystem check below will report the malformed target.
    }
    const resolved = path.resolve(path.dirname(file), decoded);
    try {
      await access(resolved);
    } catch {
      brokenLinks.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}
assert.deepEqual(
  brokenLinks,
  [],
  `Broken documentation links:\n${brokenLinks.join("\n")}`,
);

console.log(
  `PASS: documentation contract, bilingual entrypoints, runtime registry and relative links are coherent`,
);
