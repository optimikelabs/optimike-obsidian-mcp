import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.OBSIDIAN_RUNTIME_MODE ??= "headless-readonly";
process.env.OBSIDIAN_VAULT ??= process.cwd();
const { validateObsidianMarkdown } = await import("../dist/services/obsidianFormatService.js");
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/frontmatter-contract.json", import.meta.url), "utf8"));
for (const item of cases) {
  const result = validateObsidianMarkdown(item.content);
  assert.equal(result.ok, !item.code, item.id);
  assert.equal(result.errors[0]?.code ?? null, item.code, item.id);
  assert.equal(result.stats.frontmatter, !item.code && item.id !== "absent", item.id);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"), item.id);
}
console.log(`PASS: ${cases.length} shared frontmatter cases; safe diagnostics.`);
