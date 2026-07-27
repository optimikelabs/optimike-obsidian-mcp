#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const configPath =
  process.env.MCP_EXTERNAL_ROOTS_FILE || process.argv.slice(2)[0];
if (!configPath) {
  throw new Error(
    "Provide MCP_EXTERNAL_ROOTS_FILE or pass the machine-local config path.",
  );
}

function jsonOf(result) {
  return JSON.parse(
    result.content?.map((item) => item.text ?? "").join("\n") ?? "{}",
  );
}

const vaultRoot = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-mcp-vault-"),
);
await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
await writeFile(path.join(vaultRoot, "Smoke.md"), "# Smoke\n", "utf8");

const client = new Client({
  name: "optimike-external-roots-mcp-smoke",
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
    OBSIDIAN_ENABLE_CACHE: "false",
    MCP_WRITE_MODE: "readonly",
    SEMANTIC_SEARCH_PREWARM: "false",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "error",
    MCP_EXTERNAL_ROOTS_FILE: configPath,
  },
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const expectedTools = [
    "external_runtime_status",
    "external_roots_list",
    "external_list",
    "external_stat",
    "external_read",
    "external_handoff",
  ];
  for (const name of expectedTools) {
    const tool = tools.tools.find((item) => item.name === name);
    assert.ok(tool, `Missing MCP tool: ${name}`);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }

  const status = jsonOf(
    await client.callTool({
      name: "external_runtime_status",
      arguments: {},
    }),
  );
  assert.equal(status.enabled, true);
  assert.equal(status.localHandoffAllowed, true);
  assert.ok(status.roots.length > 0);
  assert.equal(
    JSON.stringify(status).includes(path.dirname(configPath)),
    false,
  );

  const root = status.roots[0];
  const listing = jsonOf(
    await client.callTool({
      name: "external_list",
      arguments: {
        rootId: root.id,
        relativePath: "",
        depth: root.limits.maxDepth,
        maxEntries: root.limits.maxListEntries,
      },
    }),
  );
  const files = listing.entries.filter((entry) => entry.type === "file");
  assert.ok(files.length > 0);

  const textFile = files.find((entry) =>
    [".md", ".txt", ".csv", ".json"].includes(
      path.extname(entry.path).toLowerCase(),
    ),
  );
  assert.ok(textFile);
  const read = jsonOf(
    await client.callTool({
      name: "external_read",
      arguments: {
        rootId: root.id,
        relativePath: textFile.path,
        maxChars: 2000,
      },
    }),
  );
  assert.ok(read.chars > 0);
  assert.equal("localPath" in read, false);

  const documentFile =
    files.find((entry) =>
      [".pdf", ".docx", ".xlsx", ".pptx"].includes(
        path.extname(entry.path).toLowerCase(),
      ),
    ) ?? textFile;
  const handoff = jsonOf(
    await client.callTool({
      name: "external_handoff",
      arguments: {
        rootId: root.id,
        relativePath: documentFile.path,
        includeHash: true,
      },
    }),
  );
  assert.ok(path.isAbsolute(handoff.localPath));
  assert.ok(handoff.sha256);

  console.log(
    JSON.stringify(
      {
        ok: true,
        rootId: root.id,
        tools: expectedTools.length,
        listedFiles: files.length,
        textReadChars: read.chars,
        handoffPathDisclosedOnlyByExplicitTool: true,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
  await rm(vaultRoot, { recursive: true, force: true });
}
