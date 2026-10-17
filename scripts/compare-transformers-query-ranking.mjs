// Manual concordance check for the built-in Transformers query embedder.
// Usage: node scripts/compare-transformers-query-ranking.mjs <vault> <smart-connections-results.json>
// The JSON is a list of { q, top: [{ k: "<source path>", s: <score> }] } collected inside
// Obsidian with smart_sources.lookup on a vault indexed by the Smart Connections built-in model.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

const [vault, resultsFile] = process.argv.slice(2);
if (!vault || !resultsFile) {
  console.error("Usage: node scripts/compare-transformers-query-ranking.mjs <vault> <results.json>");
  process.exit(2);
}
const expected = JSON.parse(await readFile(resultsFile, "utf8"));
const scratch = await mkdtemp(path.join(os.tmpdir(), "transformers-ranking-"));
Object.assign(process.env, {
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: vault,
  SMART_ENV_DIR: path.join(vault, ".smart-env"),
  OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(scratch, "cache.sqlite"),
  SEMANTIC_SEARCH_PREWARM: "false",
  ENABLE_QUERY_EMBEDDING: "true",
  MCP_LOG_LEVEL: "error",
  QUERY_EMBEDDER: "auto",
});
delete process.env.QUERY_EMBEDDER_MODEL;

const dist = pathToFileURL(path.resolve("dist") + path.sep).href;
const { registerSemanticSearchTool } = await import(
  dist + "mcp-server/tools/semanticSearchTool/registration.js"
);
const { getSemanticCacheService } = await import(dist + "services/semanticCache.js");

const server = new McpServer({ name: "ranking", version: "1" });
const client = new Client({ name: "ranking-check", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
let top1 = 0;
let overlap = 0;
const scoreDeltas = [];
try {
  await registerSemanticSearchTool(server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  for (const { q, top } of expected) {
    const response = await client.callTool({
      name: "smart_semantic_search",
      arguments: { query: q, top_k: 5, with_snippets: false },
    });
    const value = JSON.parse(response.content[0].text);
    if (response.isError) throw new Error(`${q}: ${JSON.stringify(value.error)}`);
    const mine = value.results.map((r) => ({ k: r.path, s: r.score }));
    const ref3 = top.slice(0, 3).map((r) => r.k);
    const mine3 = mine.slice(0, 3).map((r) => r.k);
    if (ref3[0] === mine3[0]) top1++;
    overlap += mine3.filter((k) => ref3.includes(k)).length;
    for (const r of mine) {
      const ref = top.find((t) => t.k === r.k);
      if (ref) scoreDeltas.push(Math.abs(ref.s - r.s));
    }
    console.log(`\nQ: ${q}  [provider=${value.query_provider} model=${value.query_model}]`);
    for (let i = 0; i < 3; i++) {
      const same = ref3[i] === mine3[i] ? "=" : "≠";
      console.log(
        `  ${same} SC ${top[i]?.s.toFixed(3)} ${path.basename(ref3[i] ?? "")}  |  MCP ${mine[i]?.s.toFixed(3)} ${path.basename(mine3[i] ?? "")}`,
      );
    }
  }
  const maxDelta = Math.max(...scoreDeltas);
  console.log(
    `\nSUMMARY top1=${top1}/${expected.length} top3_overlap=${overlap}/${expected.length * 3} max_score_delta=${maxDelta.toFixed(4)}`,
  );
} finally {
  await client.close();
  await server.close();
  getSemanticCacheService().db.close();
  await rm(scratch, { recursive: true, force: true });
}
