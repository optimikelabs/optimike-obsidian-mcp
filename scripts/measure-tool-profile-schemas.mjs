#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROFILE_IDS = ["standard", "authoring", "tasks", "full"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function measureToolsList(tools) {
  const sorted = [...tools].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const canonicalJson = JSON.stringify(canonicalize(sorted));
  return {
    toolCount: sorted.length,
    toolSchemaBytes: Buffer.byteLength(canonicalJson, "utf8"),
    toolsListSha256: createHash("sha256").update(canonicalJson).digest("hex"),
    toolNames: sorted.map((tool) => tool.name),
  };
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function isolatedEnv(privateRoot, logsRoot, profile) {
  return {
    ...process.env,
    MCP_TOOL_PROFILE: profile,
    MCP_WRITE_MODE: "readonly",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "error",
    SEMANTIC_SEARCH_PREWARM: "false",
    LOGS_DIR: path.join(logsRoot, profile),
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(
      privateRoot,
      profile,
      "cache.sqlite",
    ),
    MCP_EXTERNAL_MOVE_JOURNAL_PATH: path.join(
      privateRoot,
      profile,
      "external-move.sqlite",
    ),
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(
      privateRoot,
      profile,
      "note.sqlite",
    ),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(
      privateRoot,
      profile,
      "base.sqlite",
    ),
    MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: path.join(
      privateRoot,
      profile,
      "canvas.sqlite",
    ),
  };
}

async function listProfile(profile, privateRoot, logsRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "--tool-profile", profile],
    cwd: process.cwd(),
    env: isolatedEnv(privateRoot, logsRoot, profile),
  });
  const client = new Client({
    name: `optimike-p6-schema-${profile}`,
    version: "1",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    return {
      profile,
      ...measureToolsList(listed.tools),
      ...(process.argv.includes("--include-public-schemas")
        ? {
            publicTools: [...listed.tools].sort((left, right) =>
              left.name.localeCompare(right.name),
            ),
          }
        : {}),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  if (process.argv.includes("--offline-contract")) {
    const measurement = measureToolsList([
      { name: "zeta", inputSchema: { type: "object", properties: {} } },
      { name: "alpha", inputSchema: { type: "object", required: [] } },
    ]);
    process.stdout.write(`${JSON.stringify(measurement)}\n`);
    return;
  }

  const sourceCommit = currentCommit();
  const expectedCommit = process.env.EXPECTED_COMMIT?.trim();
  if (expectedCommit && sourceCommit !== expectedCommit) {
    throw new Error(
      `Exact-SHA gate failed: expected ${expectedCommit}, found ${sourceCommit}.`,
    );
  }
  if (!process.env.OBSIDIAN_VAULT) {
    throw new Error("OBSIDIAN_VAULT is required for schema measurement.");
  }
  if (process.argv.includes("--require-live")) {
    if (process.env.OBSIDIAN_RUNTIME_MODE !== "live") {
      throw new Error("--require-live requires OBSIDIAN_RUNTIME_MODE=live.");
    }
    if (!process.env.OBSIDIAN_API_KEY) {
      throw new Error("--require-live requires OBSIDIAN_API_KEY.");
    }
  }

  const privateRoot = mkdtempSync(
    path.join(os.tmpdir(), "optimike-p6-tool-schemas-"),
  );
  const logsParent = path.join(process.cwd(), "logs", "p6-tool-schemas");
  mkdirSync(logsParent, { recursive: true });
  const logsRoot = mkdtempSync(path.join(logsParent, "run-"));
  try {
    const profiles = [];
    for (const profile of PROFILE_IDS) {
      profiles.push(await listProfile(profile, privateRoot, logsRoot));
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceCommit,
          runtimeMode: process.env.OBSIDIAN_RUNTIME_MODE ?? "unspecified",
          measurement: "canonical UTF-8 JSON bytes of the tools array",
          profiles,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(logsRoot, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  await main();
}
