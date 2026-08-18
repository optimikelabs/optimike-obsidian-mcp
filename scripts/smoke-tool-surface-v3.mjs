#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const expectedCounts = {
  standard: 11,
  authoring: 9,
  tasks: 31,
  full: 46,
};

async function createVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "optimike-v3-surface-"));
  await mkdir(path.join(root, ".obsidian", "optimike-mcp"), { recursive: true });
  await writeFile(path.join(root, "Root.md"), "# Root\n\nsemantic smoke\n", "utf8");
  return root;
}

function textOf(result) {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function inspectProfile(vaultRoot, profile) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index-v3.js", "--tool-profile", profile],
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: vaultRoot,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(
        vaultRoot,
        ".obsidian",
        "optimike-mcp",
        `${profile}.sqlite`,
      ),
      OBSIDIAN_ENABLE_CACHE: "true",
      MCP_WRITE_MODE: "readonly",
      OBSIDIAN_API_KEY: "",
      OBSIDIAN_BASE_URL: "http://127.0.0.1:9",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_LOG_LEVEL: "error",
    },
  });
  const client = new Client({ name: `surface-${profile}`, version: "3.0.0" });
  try {
    await client.connect(transport);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    assert.equal(names.size, expectedCounts[profile], `${profile} tool count`);
    assert.equal(names.has("smart_semantic_search"), true);
    assert.equal(names.has("smart_search"), false);
    assert.equal(names.has("smart-search"), false);
    assert.equal(names.has("operon_status"), profile === "tasks" || profile === "full");
    assert.equal(names.has("external_runtime_status"), profile === "full");

    const status = await client.callTool({
      name: "obsidian_runtime_status",
      arguments: {},
    });
    const statusPayload = JSON.parse(textOf(status));
    assert.equal(statusPayload.toolSurface.profile, profile);
    assert.equal(statusPayload.toolSurface.toolCount, names.size);
    assert.equal(statusPayload.toolSurface.legacyAliasesExposed, false);

    const removedAlias = await client.callTool({
      name: "smart_search",
      arguments: { query: "smoke" },
    });
    assert.equal(removedAlias.isError, true);
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}

const vaultRoot = await createVault();
try {
  for (const profile of Object.keys(expectedCounts)) {
    await inspectProfile(vaultRoot, profile);
  }
} finally {
  await rm(vaultRoot, { recursive: true, force: true });
}

console.log("PASS: public V3 stdio surfaces are exact and semantic aliases are removed");
