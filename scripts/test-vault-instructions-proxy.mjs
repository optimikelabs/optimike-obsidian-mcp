#!/usr/bin/env node

// The stdio proxy relays the backend's server instructions to its client,
// sends ITS MCP_VAULT_INSTRUCTIONS choice as a per-request header (never as
// the backend's own setting) and a stable per-process reader context.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const INSTRUCTIONS =
  "This Obsidian vault defines rules for agents in instruction files (AGENTS.md). Fixture.";

const seen = [];
const backend = createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200).end();
    return;
  }
  if (request.method !== "POST" || !request.url?.startsWith("/mcp")) {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  seen.push({
    method: message.method,
    mode: request.headers["x-optimike-vault-instructions"],
    reader: request.headers["x-optimike-reader-context"],
  });
  const reply = (result, headers = {}) => {
    response.writeHead(200, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  };
  if (message.method === "initialize") {
    reply(
      {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "vault-instructions-proxy-fixture", version: "0" },
        instructions: INSTRUCTIONS,
      },
      { "mcp-session-id": `session-${seen.length}` },
    );
    return;
  }
  if (message.method === "tools/list") {
    reply({
      tools: [
        {
          name: "obsidian_read_note",
          description: "fixture",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    reply({ content: [{ type: "text", text: "{\"ok\":true}" }], isError: false });
    return;
  }
  response.writeHead(202).end();
});
backend.listen(0, "127.0.0.1");
await once(backend, "listening");
const { port } = backend.address();
const fixtureVault = await mkdtemp(join(tmpdir(), "optimike-vault-instructions-proxy-"));
const proxyEntryPath = fileURLToPath(new URL("../dist/stdio-proxy.js", import.meta.url));

async function runProxy(extraEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [proxyEntryPath, "--tool-profile", "full"],
    cwd: fixtureVault,
    stderr: "pipe",
    env: {
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: fixtureVault,
      OBSIDIAN_ENABLE_CACHE: "false",
      MCP_WRITE_MODE: "readonly",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_TOOL_PROFILE: "full",
      MCP_LOG_LEVEL: "error",
      MCP_PROXY_START_TIMEOUT_MS: "5000",
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
      ...extraEnv,
    },
  });
  const client = new Client({ name: "vault-instructions-proxy-client", version: "0" });
  try {
    await client.connect(transport);
    const instructions = client.getInstructions();
    await client.callTool({ name: "obsidian_read_note", arguments: {} });
    await client.callTool({ name: "obsidian_read_note", arguments: {} });
    return instructions;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

try {
  seen.length = 0;
  const instructions = await runProxy({ MCP_VAULT_INSTRUCTIONS: "enforce" });
  assert.equal(instructions, INSTRUCTIONS, "backend instructions reach the stdio client");
  const calls = seen.filter((entry) => entry.method === "tools/call");
  assert.equal(calls.length, 2);
  assert.ok(seen.every((entry) => entry.mode === "enforce"), "every backend request carries the client mode");
  const readers = new Set(seen.map((entry) => entry.reader));
  assert.equal(readers.size, 1, "one reader context per proxy process");
  const [firstReader] = readers;
  assert.match(firstReader, /^[A-Za-z0-9_-]{16,128}$/u);

  seen.length = 0;
  await runProxy({});
  assert.ok(seen.length > 0);
  assert.ok(seen.every((entry) => entry.mode === undefined), "no header when the client sets no mode");
  assert.notEqual(seen[0].reader, firstReader, "another proxy is another reader");

  console.log("vault instructions proxy test passed");
} finally {
  backend.closeAllConnections?.();
  await new Promise((resolve) => backend.close(resolve));
  await rm(fixtureVault, { recursive: true, force: true }).catch(() => undefined);
}
