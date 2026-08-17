import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compileToolNames } from "../dist/mcp-server/toolSurfaceRegistry.js";

const MODES = [
  "live",
  "hybrid-live",
  "hybrid-degraded",
  "headless-readonly",
  "headless-guarded",
  "headless-filesystem",
];

async function createTempVault() {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "optimike-tool-surface-"));
  await mkdir(path.join(vaultRoot, ".obsidian", "optimike-mcp"), {
    recursive: true,
  });
  await writeFile(path.join(vaultRoot, "Root.md"), "# Tool surface smoke\n", "utf8");
  return vaultRoot;
}

async function createFakeRestServer() {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          service: "Obsidian Local REST API",
          authenticated: true,
          versions: { obsidian: "surface-smoke", self: "surface-smoke" },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function listToolsForMode(registrationMode) {
  const vaultRoot = await createTempVault();
  const needsRest = registrationMode === "live" || registrationMode === "hybrid-live";
  const fakeRest = needsRest ? await createFakeRestServer() : undefined;
  const runtimeMode = registrationMode.startsWith("hybrid")
    ? "hybrid"
    : registrationMode;
  const apiKey = needsRest ? "surface-smoke-key" : "";
  const writeMode =
    registrationMode === "headless-readonly" ||
    registrationMode === "hybrid-degraded"
      ? "readonly"
      : registrationMode === "headless-guarded" ||
          registrationMode === "headless-filesystem"
        ? "guarded"
        : "full";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: runtimeMode,
      OBSIDIAN_VAULT: vaultRoot,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(
        vaultRoot,
        ".obsidian",
        "optimike-mcp",
        "shared-cache.sqlite",
      ),
      OBSIDIAN_ENABLE_CACHE: "true",
      OBSIDIAN_API_KEY: apiKey,
      OBSIDIAN_BASE_URL: fakeRest?.url ?? "http://127.0.0.1:9",
      OBSIDIAN_STARTUP_BLOCKING: "true",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_LOG_LEVEL: "error",
      MCP_WRITE_MODE: writeMode,
    },
  });
  const client = new Client({
    name: `optimike-tool-surface-${registrationMode}`,
    version: "0",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
  } finally {
    await client.close().catch(() => undefined);
    if (fakeRest) {
      await new Promise((resolve) => fakeRest.server.close(resolve));
    }
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

for (const registrationMode of MODES) {
  const actual = await listToolsForMode(registrationMode);
  const expected = [...compileToolNames({ registrationMode })];
  assert.deepEqual(
    actual,
    expected,
    `${registrationMode} tools/list diverges from the canonical registry`,
  );
  console.log(`PASS ${registrationMode}: ${actual.length} tools`);
}

console.log("PASS: runtime tools/list matches the canonical registry in every registration mode");
