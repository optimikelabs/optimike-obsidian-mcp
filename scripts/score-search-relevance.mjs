import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const notePath = (path) => path.replaceAll("\\", "/").replace(/^\/+/, "");
const heading = (value) => value.normalize("NFC").replace(/[\u00a0\u202f]/gu, " ")
  .replaceAll("*", "").trim().toLowerCase();

export function readGold(value) {
  const cases = Array.isArray(value) ? value : value.queries;
  if (!Array.isArray(cases) || !cases.length) throw new Error("Expected a non-empty gold set.");
  return cases.map((item) => {
    if (typeof item.query !== "string" || !item.query.trim() ||
        typeof item.type !== "string" || !item.type || item.type === "all" ||
        !Array.isArray(item.relevant) || !item.relevant.length) throw new Error("Invalid gold case.");
    const paths = new Set();
    const relevant = item.relevant.map((entry) => {
      const { path, grade = 1, section, heading } = typeof entry === "string" ? { path: entry } : entry;
      const expectedSection = section ?? heading;
      if (typeof path !== "string" || !notePath(path) || paths.has(notePath(path)) ||
          !Number.isInteger(grade) || grade < 1 || grade > 5 ||
          (expectedSection !== undefined && (typeof expectedSection !== "string" || !expectedSection.trim()))) {
        throw new Error("Invalid or duplicate expected note.");
      }
      paths.add(notePath(path));
      return { path: notePath(path), grade, section: expectedSection };
    });
    return { query: item.query, type: item.type, relevant };
  });
}

function metrics(hits, relevant) {
  const grades = new Map(relevant.map((entry) => [entry.path, entry.grade]));
  const ranked = [...new Set(hits.map((hit) => notePath(hit.path)))].slice(0, 10);
  const recall = (k) => ranked.slice(0, k).filter((path) => grades.has(path)).length / grades.size;
  const first = ranked.findIndex((path) => grades.has(path));
  const dcg = (values) => values.reduce((sum, grade, rank) => sum + (2 ** grade - 1) / Math.log2(rank + 2), 0);
  const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, 10));
  const sectionExpectations = relevant.filter((entry) => entry.section);
  const sectionRecall = (k) => sectionExpectations.filter((entry) => hits.slice(0, k).some((hit) => {
    const headings = hit.best_section?.headings ?? hit.headings ?? [];
    return notePath(hit.path) === entry.path && headings.some((value) => heading(value) === heading(entry.section));
  })).length / sectionExpectations.length;
  return {
    recall5: recall(5),
    recall10: recall(10),
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg10: dcg(ranked.map((path) => grades.get(path) ?? 0)) / ideal,
    ...(sectionExpectations.length ? { sectionRecall5: sectionRecall(5), sectionRecall10: sectionRecall(10) } : {}),
  };
}

export async function evaluateSearch(cases, search) {
  const groups = new Map([["all", []]]);
  for (const [index, test] of cases.entries()) {
    const hits = await search(test.query, index);
    if (!Array.isArray(hits) || hits.some((hit) => typeof hit.path !== "string")) {
      throw new Error("Search did not return valid hits.");
    }
    const result = metrics(hits, test.relevant);
    if (!groups.has(test.type)) groups.set(test.type, []);
    groups.get(test.type).push(result);
    groups.get("all").push(result);
  }
  return Object.fromEntries([...groups].map(([type, rows]) => {
    const values = new Map();
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        const metric = values.get(key) ?? { count: 0, total: 0 };
        metric.count++;
        metric.total += value;
        values.set(key, metric);
      }
    }
    return [type, {
      cases: rows.length,
      ...Object.fromEntries([...values].map(([key, { total, count }]) => [key, Math.round(total / count * 10000) / 10000])),
    }];
  }));
}

export function searchRequest(mode, query) {
  if (mode === "ranked" || mode === "exact") {
    return { name: "obsidian_global_search", arguments: { query, mode, pageSize: 10 } };
  }
  if (!["hybrid", "notes", "sections"].includes(mode)) throw new Error("Unknown search mode.");
  return {
    name: "smart_semantic_search",
    arguments: { query, ...(mode === "hybrid" ? { hybrid: true } : { granularity: mode }),
      top_k: mode === "sections" ? 30 : 10, with_snippets: false },
  };
}

export async function callSearch(client, mode, query) {
  const response = await client.callTool(searchRequest(mode, query), undefined, { timeout: 60000 });
  if (response.isError) throw new Error("Search tool returned an error.");
  return JSON.parse(response.content.find((item) => item.type === "text").text).results;
}

async function main() {
  const [goldPath, endpoint, mode = "hybrid"] = process.argv.slice(2);
  if (!goldPath || !endpoint) {
    console.error("Usage: node scripts/score-search-relevance.mjs GOLD.json MCP_URL [hybrid|ranked|exact|notes|sections]");
    process.exitCode = 1;
    return;
  }
  const cases = readGold(JSON.parse(await readFile(goldPath, "utf8")));
  const token = process.env.SEARCH_EVAL_TOKEN;
  const client = new Client({ name: "search-relevance-eval", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),
      token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}));
    console.log(JSON.stringify(await evaluateSearch(cases, (query) => callSearch(client, mode, query)), null, 2));
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Search evaluation failed. Check the gold format, endpoint and tool availability.");
    process.exitCode = 1;
  });
}
