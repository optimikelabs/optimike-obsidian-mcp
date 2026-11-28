
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const server = fileURLToPath(new URL("../dist/index.js", import.meta.url));
export async function withOperonClient({ vault, cache, mode, url, token, profile = "tasks" }, run) {
  const client = new Client({ name: "operon-headless-parity", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: cache,
    env: {
      OBSIDIAN_VAULT: vault,
      OBSIDIAN_RUNTIME_MODE: mode,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_ENABLE_CACHE: "true",
      OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(cache, mode + ".sqlite"),
      OBSIDIAN_BASE_URL: url ?? "http://127.0.0.1:9",
      OBSIDIAN_API_KEY: token ?? "",
      OBSIDIAN_VERIFY_SSL: process.env.OPERON_PARITY_VERIFY_SSL ?? "true",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_TOOL_PROFILE: profile,
      MCP_WRITE_MODE: "readonly",
      OPERON_MUTATIONS_ENABLED: "false",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_LOG_LEVEL: "error",
    },
    stderr: "pipe",
  });
  // Drain process diagnostics without putting source text or local configuration in reports.
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await transport.close();
  }
}

export async function callOperon(client, name, args = {}, allowError = false) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const result = JSON.parse(reply.content[0].text);
  if (reply.isError && !allowError) throw new Error(name + " failed: " + (result.code ?? result.error?.code ?? "unknown"));
  return result;
}

async function allTasks(client, expectedSource, forceRefresh) {
  const tasks = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await callOperon(client, "operon_list_tasks", {
      cursor, includeProperties: true, forceRefresh: forceRefresh && cursor === undefined, limit: 100,
    });
    if (page.source !== expectedSource || page.partial || page.stale) {
      throw new Error("Parity requires a settled " + expectedSource + " task page.");
    }
    tasks.push(...page.tasks);
    cursor = page.hasMore ? page.nextCursor : undefined;
    if (page.hasMore && (!cursor || seen.has(cursor))) throw new Error("Invalid parity continuation.");
    seen.add(cursor);
    if (seen.size > 10_000) throw new Error("Parity page limit exceeded.");
  } while (cursor);
  return tasks;
}

export function compareTasks(live, filesystem) {
  const differing = [];
  const index = (tasks) => {
    const result = new Map();
    for (const row of tasks) {
      if (result.has(row.operonId)) throw new Error("Duplicate Operon identity in parity input.");
      result.set(row.operonId, row);
    }
    return result;
  };
  const a = index(live);
  const b = index(filesystem);
  // These fields describe the read authority or depend on the copy's mtime.
  const ignored = new Set(["sourceKind", "revision", "sourceMtime", "bridgeVersion", "operonVersion"]);
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const left = a.get(id);
    const right = b.get(id);
    const fields = left && right
      ? [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .filter(field => !ignored.has(field) && !isDeepStrictEqual(left[field], right[field])).sort()
      : [left ? "missing-in-filesystem" : "missing-in-live"];
    // Report identities and fields only. Never dump note text or field values.
    if (fields.length) differing.push({ operonId: id, fields });
  }
  return differing;
}

export async function runParity(liveClient, filesystemClient) {
  const [live, filesystem] = await Promise.allSettled([
    allTasks(liveClient, "operon-live", true), allTasks(filesystemClient, "filesystem", true),
  ]);
  if (live.status === "rejected") throw live.reason;
  if (filesystem.status === "rejected") throw filesystem.reason;
  return { liveCount: live.value.length, filesystemCount: filesystem.value.length, differences: compareTasks(live.value, filesystem.value) };
}

async function main() {
  const [requestedVault] = process.argv.slice(2);
  const { OPERON_PARITY_LOCAL_REST_URL: url, OPERON_PARITY_LOCAL_REST_KEY: token } = process.env;
  if (!requestedVault || !url || !token) {
    throw new Error("Usage: node scripts/operon-headless-parity.mjs <disposable-vault-copy> with OPERON_PARITY_LOCAL_REST_URL and OPERON_PARITY_LOCAL_REST_KEY.");
  }
  const target = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !["http:", "https:"].includes(target.protocol) ||
      target.username || target.password || target.search || target.hash) {
    throw new Error("Parity expects a loopback Obsidian Local REST URL.");
  }
  const vault = await realpath(requestedVault);
  // Check an opt-in marker through REST as well as disk so an unrelated Desktop
  // vault is never used merely because it happens to be listening on the port.
  const markerName = "operon-parity-copy.md";
  const marker = await readFile(path.join(vault, markerName), "utf8");
  if (!/^operon-parity-copy: [a-f0-9-]{36}\r?\n?$/iu.test(marker)) throw new Error("Create a disposable copy marker first.");
  // Use the same REST client as the MCP, including its explicit TLS setting.
  const { default: axios } = await import("axios");
  const { Agent } = await import("node:https");
  const markerUrl = new URL("/vault/" + markerName, target);
  const response = await axios.get(markerUrl.href, {
    headers: { Authorization: "Bearer " + token, Accept: "text/markdown" },
    httpsAgent: new Agent({ rejectUnauthorized: process.env.OPERON_PARITY_VERIFY_SSL !== "false" }),
    timeout: 10_000, maxRedirects: 0, responseType: "text",
  }).catch(() => { throw new Error("Local REST could not read the disposable copy marker."); });
  if (response.data.trim() !== marker.trim()) throw new Error("Local REST does not serve this disposable vault copy.");
  const cache = await mkdtemp(path.join(tmpdir(), "operon-parity-"));
  try {
    const result = await withOperonClient({ vault, cache, mode: "live", url, token }, live =>
      withOperonClient({ vault, cache, mode: "headless-readonly" }, fs => runParity(live, fs)));
    console.log(JSON.stringify(result, null, 2));
    if (result.differences.length) process.exitCode = 1;
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
