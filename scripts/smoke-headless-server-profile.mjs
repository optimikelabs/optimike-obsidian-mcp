#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const vaultRoot =
  process.env.HEADLESS_SERVER_VAULT ??
  process.env.OBSIDIAN_VAULT ??
  "";
const cacheDir =
  process.env.HEADLESS_SERVER_CACHE_DIR ??
  path.resolve(".tmp", "headless-server-profile-cache");
const cachePath =
  process.env.OBSIDIAN_SHARED_CACHE_DB_PATH ??
  path.join(cacheDir, "shared-cache.sqlite");
const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? "240000");

if (!vaultRoot) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: "Set HEADLESS_SERVER_VAULT or OBSIDIAN_VAULT to a dedicated/copy vault path.",
      },
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

function firstMarkdownPath(entries) {
  for (const entry of entries ?? []) {
    const pathValue = entry.path ?? entry.name ?? "";
    if (typeof pathValue === "string" && pathValue.toLowerCase().endsWith(".md")) {
      return pathValue.replace(/^\/+/u, "");
    }
  }
  return undefined;
}

async function main() {
  await mkdir(path.dirname(cachePath), { recursive: true });

  const client = new Client({
    name: "optimike-headless-server-profile-smoke",
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
      MCP_LOG_LEVEL: process.env.MCP_LOG_LEVEL ?? "error",
    },
  });

  try {
    await withTimeout(client.connect(transport), "connect");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const tools = await withTimeout(client.listTools(), "listTools");
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    for (const tool of [
      "obsidian_runtime_status",
      "obsidian_list_notes",
      "obsidian_read_note",
      "obsidian_global_search",
      "list_all_tasks",
      "query_tasks",
      "bases_list",
      "bases_query",
    ]) {
      if (!toolNames.includes(tool)) {
        throw new Error(`Missing expected headless server tool: ${tool}`);
      }
    }
    for (const forbidden of [
      "obsidian_update_note",
      "obsidian_delete_note",
      "obsidian_manage_tags",
      "bases_upsert_rows",
    ]) {
      if (toolNames.includes(forbidden)) {
        throw new Error(`Unsafe write/live tool registered in readonly server profile: ${forbidden}`);
      }
    }

    const maintenance = jsonOf(
      await withTimeout(
        client.callTool({
          name: "obsidian_runtime_maintenance",
          arguments: { action: "refresh_all" },
        }),
        "obsidian_runtime_maintenance refresh_all",
      ),
      "obsidian_runtime_maintenance refresh_all",
    );

    const status = jsonOf(
      await withTimeout(
        client.callTool({ name: "obsidian_runtime_status", arguments: {} }),
        "obsidian_runtime_status",
      ),
      "obsidian_runtime_status",
    );
    if (status.runtimeMode !== "headless-readonly") {
      throw new Error(`Unexpected runtime mode: ${status.runtimeMode}`);
    }
    if (status.writePolicy?.mode !== "readonly") {
      throw new Error(`Unexpected write policy: ${status.writePolicy?.mode}`);
    }

    const list = jsonOf(
      await withTimeout(
        client.callTool({
          name: "obsidian_list_notes",
          arguments: {
            dirPath: "/",
            fileExtensionFilter: [".md"],
            recursionDepth: 3,
            responseMode: "compact",
            limit: 50,
          },
        }),
        "obsidian_list_notes",
      ),
      "obsidian_list_notes",
    );
    const readPath = firstMarkdownPath(list.entries);
    if (!readPath) {
      throw new Error("No markdown file found within recursionDepth=3.");
    }

    const readText = textOf(
      await withTimeout(
        client.callTool({
          name: "obsidian_read_note",
          arguments: { filePath: readPath, format: "markdown" },
        }),
        "obsidian_read_note",
      ),
    );
    if (!readText.trim()) {
      throw new Error(`Read-back was empty for ${readPath}`);
    }

    const tasks = jsonOf(
      await withTimeout(
        client.callTool({
          name: "list_all_tasks",
          arguments: {
            responseFormat: "json",
            responseMode: "compact",
            responseLimit: 5,
            useCache: true,
          },
        }),
        "list_all_tasks",
      ),
      "list_all_tasks",
    );

    const bases = jsonOf(
      await withTimeout(
        client.callTool({ name: "bases_list", arguments: {} }),
        "bases_list",
      ),
      "bases_list",
    );
    if (bases.source !== "local-fallback") {
      throw new Error(`Expected local Bases fallback, got ${bases.source}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          vaultRoot,
          cachePath,
          runtimeMode: status.runtimeMode,
          writePolicy: status.writePolicy?.mode,
          cacheStatus: status.sharedCache?.status,
          cacheFiles: status.sharedCache?.dbFileCount,
          maintenance: {
            success: maintenance.success,
            action: maintenance.action,
          },
          toolCount: toolNames.length,
          sampleRead: readPath,
          taskCount: tasks.totalCount ?? tasks.tasks?.length ?? null,
          baseCount: bases.bases?.length ?? 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.exit(1);
});
