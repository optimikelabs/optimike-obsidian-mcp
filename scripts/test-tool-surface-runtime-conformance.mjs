import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  compileToolNames,
  getToolSurfaceEntry,
} from "../dist/mcp-server/toolSurfaceRegistry.js";
import {
  TOOL_SEARCH_HINT_META_KEY,
  TOOL_SEARCH_HINTS,
} from "../dist/mcp-server/toolSearchHints.js";

// Claude Code ToolSearch does not drop these words, so a hint containing one
// would lift every hinted tool for any query that contains it: function words
// and words true of the whole vault surface.
const HINT_FUNCTION_WORDS = new Set(
  [
    "a an and are as at be by for from in into is it its my of on or the this to with",
    "content file files markdown note notes vault",
  ]
    .join(" ")
    .split(" "),
);
const HINT_MAX_LENGTH = 100;

for (const [name, hint] of Object.entries(TOOL_SEARCH_HINTS)) {
  assert.ok(hint.length > 0 && hint.length <= HINT_MAX_LENGTH, `${name}: hint length`);
  const words = hint.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  assert.deepEqual(
    words.filter((word) => HINT_FUNCTION_WORDS.has(word)),
    [],
    `${name}: hint has function words`,
  );
  // The client already scores a query word found inside a name part.
  const nameParts = ["obsidian", ...name.split("_")];
  assert.deepEqual(
    words.filter((word) => nameParts.some((part) => part.includes(word))),
    [],
    `${name}: hint repeats words of the tool name`,
  );
  // A renamed or removed tool must not leave a hint behind.
  const entry = getToolSurfaceEntry(name);
  assert.ok(entry, `${name}: search hint for a tool missing from the registry`);
  const role = entry.lifecycleRole;
  assert.ok(role === undefined || role === "plan", `${name}: hint the plan, not its ${role} step`);
}
const hintedSeen = new Set();

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
      // Registry conformance compares the complete active-runtime surface.
      // Default-standard behavior is verified by dedicated profile tests.
      MCP_TOOL_PROFILE: "full",
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
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.equal(
        tool._meta?.[TOOL_SEARCH_HINT_META_KEY],
        TOOL_SEARCH_HINTS[tool.name],
        `${registrationMode}: ${tool.name} search hint`,
      );
      if (TOOL_SEARCH_HINTS[tool.name]) hintedSeen.add(tool.name);
    }
    return tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
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
console.log(`PASS: ${hintedSeen.size} search hints served as _meta["${TOOL_SEARCH_HINT_META_KEY}"]`);
