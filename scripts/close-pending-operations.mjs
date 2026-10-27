#!/usr/bin/env node
// Batch administrative closure through the public MCP tools only.
//
//   node scripts/close-pending-operations.mjs --launcher <launch.mjs> [--apply]
//        [--reason historical_cleanup|operator_review] [--out receipts.json]
//        [--kind obsidian.note.create] [--limit 400]
//
// Without --apply every call is a dry run (no Bridge revocation, no journal
// change). With --apply each batch is closed only where the Bridge effect fence
// proves that no attempt can still change the vault. Refusals are recorded and
// never retried automatically. Notes are never read or written by this script.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLOSABLE = new Set([
  "obsidian.note.replace", "obsidian.frontmatter.patch", "obsidian.text.patch",
  "obsidian.base.rows.patch", "obsidian.note.create", "obsidian.note.move",
]);
const BATCH = 20;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[index + 1] : fallback;
}
const launcher = option("--launcher");
if (!launcher) {
  console.error("Usage: node scripts/close-pending-operations.mjs --launcher <launch.mjs> [--apply] [--reason historical_cleanup] [--out file] [--kind kind] [--limit n]");
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const reasonCode = option("--reason", "historical_cleanup");
const kind = option("--kind");
const limit = Number(option("--limit", "1000"));
const out = path.resolve(option("--out", `closure-${apply ? "apply" : "dry-run"}-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`));
if (!["historical_cleanup", "operator_review"].includes(reasonCode) || !Number.isSafeInteger(limit) || limit < 1) {
  console.error("Invalid --reason or --limit.");
  process.exit(2);
}

const parse = (result) => JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || "null");
const client = new Client({ name: "optimike-close-pending-operations", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.resolve(launcher)], cwd: path.dirname(path.resolve(launcher)),
  env: { ...process.env }, stderr: "inherit",
});
const report = { startedAt: new Date().toISOString(), apply, reasonCode, candidates: [], items: [], summary: {} };
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["obsidian_list_pending_operations", "obsidian_operation_close"]) {
    if (!tools.includes(name)) throw new Error(`Tool ${name} is not exposed by this runtime (profile operational or full required).`);
  }
  // Inventory first, then close: closing shrinks the pending list.
  for (const status of ["outcome_unknown", "applying"]) {
    let cursor;
    do {
      const page = parse(await client.callTool({ name: "obsidian_list_pending_operations",
        arguments: { status, limit: 100, ...(cursor ? { cursor } : {}), ...(kind ? { operationKind: kind } : {}) } }));
      for (const item of page.operations) {
        if (CLOSABLE.has(item.operationKind) && report.candidates.length < limit) report.candidates.push(item);
      }
      cursor = page.nextCursor;
    } while (cursor && report.candidates.length < limit);
  }
  for (let index = 0; index < report.candidates.length; index += BATCH) {
    const planRefs = report.candidates.slice(index, index + BATCH).map((item) => item.planRef);
    const result = await client.callTool({ name: "obsidian_operation_close", arguments: { planRefs, dryRun: !apply, reasonCode } });
    if (result.isError) {
      report.items.push(...planRefs.map((planRef) => ({ target: { kind: "operation", planRef }, result: "tool_error", error: parse(result) })));
      continue;
    }
    report.items.push(...parse(result).items);
    process.stderr.write(`${Math.min(index + BATCH, report.candidates.length)}/${report.candidates.length}\n`);
  }
  for (const item of report.items) {
    const key = `${item.result}${item.reasonCode ? `:${item.reasonCode}` : ""}`;
    report.summary[key] = (report.summary[key] ?? 0) + 1;
  }
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(out, JSON.stringify(report, null, 2), { encoding: "utf8" });
  await client.close().catch(() => undefined);
}
console.log(JSON.stringify({ out, candidates: report.candidates.length, summary: report.summary }, null, 2));
