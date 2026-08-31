#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
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

function isolatedEnv(baseEnvironment, privateRoot, logsRoot, profile) {
  return {
    ...baseEnvironment,
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

async function listProfile(
  profile,
  privateRoot,
  logsRoot,
  baseEnvironment = process.env,
  includePublicSchemas = process.argv.includes("--include-public-schemas"),
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "--tool-profile", profile],
    cwd: process.cwd(),
    env: isolatedEnv(baseEnvironment, privateRoot, logsRoot, profile),
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
      ...(includePublicSchemas
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

function operatingSystemEnvironment() {
  const allowedNames = [
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  return Object.fromEntries(
    allowedNames
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
}

async function authenticatedStatusServer() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/") {
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          status: "OK",
          service: "Obsidian Local REST API",
          authenticated: true,
          versions: { obsidian: "schema-fixture", self: "5.1.0" },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "schema_fixture_not_found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Schema fixture server did not expose a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/**
 * Reconstruct the canonical live tools/list surfaces from the current checkout.
 * The local authenticated status fixture keeps this attestation independent of
 * a user's vault, Local REST credential and backend availability.
 */
export async function measureCanonicalLiveProfileSchemas() {
  const sourceCommit = currentCommit();
  const privateRoot = mkdtempSync(
    path.join(os.tmpdir(), "optimike-p6-checkout-schemas-"),
  );
  const logsParent = path.join(process.cwd(), "logs", "p6-checkout-schemas");
  mkdirSync(logsParent, { recursive: true });
  const logsRoot = mkdtempSync(path.join(logsParent, "run-"));
  let statusServer;
  try {
    statusServer = await authenticatedStatusServer();
    const baseEnvironment = {
      ...operatingSystemEnvironment(),
      OBSIDIAN_RUNTIME_MODE: "live",
      OBSIDIAN_VAULT: path.join(privateRoot, "vault"),
      OBSIDIAN_API_KEY: "schema-fixture-only",
      OBSIDIAN_BASE_URL: statusServer.baseUrl,
      OBSIDIAN_STARTUP_MAX_RETRIES: "1",
      OBSIDIAN_STARTUP_RETRY_DELAY_MS: "1",
      OBSIDIAN_STARTUP_BLOCKING: "true",
      OBSIDIAN_ENABLE_CACHE: "true",
      SEMANTIC_SEARCH_PREWARM: "false",
    };
    mkdirSync(baseEnvironment.OBSIDIAN_VAULT, { recursive: true });
    const profiles = await Promise.all(
      PROFILE_IDS.map((profile) =>
        listProfile(profile, privateRoot, logsRoot, baseEnvironment, true),
      ),
    );
    if (currentCommit() !== sourceCommit) {
      throw new Error(
        "Checkout changed while reconstructing canonical tools/list schemas.",
      );
    }
    return profiles;
  } finally {
    try {
      if (statusServer) await statusServer.close();
    } finally {
      rmSync(privateRoot, { recursive: true, force: true });
      rmSync(logsRoot, { recursive: true, force: true });
      try {
        rmdirSync(logsParent);
      } catch (error) {
        if (!["EBUSY", "EEXIST", "ENOENT", "ENOTEMPTY"].includes(error?.code)) {
          throw error;
        }
      }
    }
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

  const logsParent = path.join(process.cwd(), "logs", "p6-tool-schemas");
  let privateRoot;
  let logsRoot;
  try {
    privateRoot = mkdtempSync(
      path.join(os.tmpdir(), "optimike-p6-tool-schemas-"),
    );
    mkdirSync(logsParent, { recursive: true });
    logsRoot = mkdtempSync(path.join(logsParent, "run-"));
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
    if (logsRoot) rmSync(logsRoot, { recursive: true, force: true });
    if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
    try {
      rmdirSync(logsParent);
    } catch (error) {
      if (!["EBUSY", "EEXIST", "ENOENT", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
      // Another concurrent measurement may still own a sibling run directory.
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  await main();
}
