#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const vaultRoot =
  process.env.HEADLESS_SERVER_VAULT ?? process.env.OBSIDIAN_VAULT ?? "";
const cacheDir =
  process.env.HEADLESS_SERVER_CACHE_DIR ??
  path.resolve(".tmp", "headless-long-run-cache");
const cachePath =
  process.env.OBSIDIAN_SHARED_CACHE_DB_PATH ??
  path.join(cacheDir, "shared-cache.sqlite");
const outputDir =
  process.env.HEADLESS_LONG_RUN_OUTPUT_DIR ??
  path.resolve(".tmp", "headless-long-run");
const minutes = Number(process.env.HEADLESS_LONG_RUN_MINUTES ?? "5");
const intervalSeconds = Number(
  process.env.HEADLESS_LONG_RUN_INTERVAL_SECONDS ?? "30",
);
const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? "240000");
const maxIterations = Math.max(1, Math.ceil((minutes * 60) / intervalSeconds));

if (!vaultRoot) {
  console.error(
    JSON.stringify(
      { ok: false, error: "Set HEADLESS_SERVER_VAULT or OBSIDIAN_VAULT." },
      null,
      2,
    ),
  );
  process.exit(1);
}

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function textOf(result) {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

function jsonOf(result, label) {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 1200)}`);
  }
}

async function timed(label, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { label, ok: true, ms: Date.now() - started, value };
  } catch (error) {
    return {
      label,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  await mkdir(cacheDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const client = new Client({
    name: "optimike-headless-long-run",
    version: "0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: vaultRoot,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
      OBSIDIAN_ENABLE_CACHE: "true",
      MCP_WRITE_MODE: "readonly",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_TOOL_PROFILE: "full",
      MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
    },
  });

  const samples = [];
  const errors = [];
  const startedAt = new Date().toISOString();
  try {
    await withTimeout(client.connect(transport), "connect");
    await withTimeout(
      client.callTool({
        name: "obsidian_runtime_maintenance",
        arguments: { action: "refresh_all" },
      }),
      "refresh_all",
    );

    for (let i = 0; i < maxIterations; i += 1) {
      const rssBefore = process.memoryUsage().rss;
      const results = [];
      results.push(
        await timed("status", async () =>
          jsonOf(
            await client.callTool({
              name: "obsidian_runtime_status",
              arguments: {},
            }),
            "status",
          ),
        ),
      );
      results.push(
        await timed("list", async () =>
          jsonOf(
            await client.callTool({
              name: "obsidian_list_notes",
              arguments: {
                dirPath: "/",
                responseMode: "compact",
                limit: 20,
                recursionDepth: 3,
              },
            }),
            "list",
          ),
        ),
      );
      results.push(
        await timed("search", async () =>
          textOf(
            await client.callTool({
              name: "obsidian_global_search",
              arguments: { query: "the", responseMode: "compact", pageSize: 5 },
            }),
          ),
        ),
      );
      results.push(
        await timed("tasks", async () =>
          jsonOf(
            await client.callTool({
              name: "list_all_tasks",
              arguments: {
                responseFormat: "json",
                responseMode: "compact",
                responseLimit: 5,
                useCache: true,
              },
            }),
            "tasks",
          ),
        ),
      );
      const sample = {
        iteration: i + 1,
        at: new Date().toISOString(),
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        results,
      };
      samples.push(sample);
      for (const result of results) {
        if (!result.ok) errors.push({ iteration: i + 1, ...result });
      }
      if (i < maxIterations - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, intervalSeconds * 1000),
        );
      }
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  const endedAt = new Date().toISOString();
  const report = {
    ok: errors.length === 0,
    startedAt,
    endedAt,
    vaultRoot,
    cachePath,
    iterations: samples.length,
    intervalSeconds,
    errors,
    samples,
  };
  const stamp = endedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `headless-long-run-${stamp}.json`);
  const mdPath = path.join(outputDir, `headless-long-run-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    mdPath,
    [
      "# Headless long-run report",
      "",
      `- ok: ${report.ok}`,
      `- startedAt: ${startedAt}`,
      `- endedAt: ${endedAt}`,
      `- iterations: ${samples.length}`,
      `- errors: ${errors.length}`,
      `- vaultRoot: ${vaultRoot}`,
      `- cachePath: ${cachePath}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(
    JSON.stringify(
      { ok: report.ok, jsonPath, mdPath, errors: errors.length },
      null,
      2,
    ),
  );
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
