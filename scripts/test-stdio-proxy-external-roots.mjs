#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function jsonOf(result) {
  return JSON.parse(
    result.content?.map((item) => item.text ?? "").join("\n") ?? "{}",
  );
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP backend exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-proxy-"),
);
const vaultPath = path.join(sandbox, "vault");
const externalPath = path.join(sandbox, "external");
const backendExternalPath = path.join(sandbox, "backend-external");
const configPath = path.join(sandbox, "external-roots.json");
const backendConfigPath = path.join(sandbox, "backend-external-roots.json");
const port = await unusedPort();
const httpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
const healthUrl = new URL(`http://127.0.0.1:${port}/healthz`);

await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
await mkdir(externalPath, { recursive: true });
await mkdir(backendExternalPath, { recursive: true });
await writeFile(path.join(vaultPath, "Smoke.md"), "# Smoke\n", "utf8");
await writeFile(
  path.join(externalPath, "hello.txt"),
  "Bonjour depuis le proxy",
  "utf8",
);
await writeFile(
  path.join(backendExternalPath, "backend.txt"),
  "Ancienne configuration backend",
  "utf8",
);
await writeFile(
  configPath,
  JSON.stringify({
    version: 1,
    roots: [
      {
        id: "proxy.pilot",
        path: externalPath,
        capabilities: ["visible", "readable", "handoff"],
        include: ["**/*.txt"],
        limits: {
          maxDepth: 2,
          maxFileBytes: 1024,
          maxListEntries: 20,
          maxTextChars: 100,
        },
      },
    ],
  }),
  "utf8",
);
await writeFile(
  backendConfigPath,
  JSON.stringify({
    version: 1,
    roots: [
      {
        id: "backend.pilot",
        path: backendExternalPath,
        capabilities: ["visible", "readable"],
        include: ["**/*.txt"],
      },
    ],
  }),
  "utf8",
);

const commonEnv = {
  ...process.env,
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: vaultPath,
  OBSIDIAN_CACHE_SOURCE: "filesystem",
  OBSIDIAN_ENABLE_CACHE: "false",
  MCP_WRITE_MODE: "readonly",
  SEMANTIC_SEARCH_PREWARM: "false",
  MCP_TRANSPORT_TYPE: "http",
  MCP_HTTP_HOST: "127.0.0.1",
  MCP_HTTP_PORT: String(port),
  MCP_LOG_LEVEL: "error",
  MCP_EXTERNAL_ROOTS_FILE: backendConfigPath,
};

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: commonEnv,
  stdio: "ignore",
});

const proxyTransport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio-proxy.js"],
  cwd: process.cwd(),
  env: {
    ...commonEnv,
    MCP_EXTERNAL_ROOTS_FILE: configPath,
    MCP_PROXY_START_TIMEOUT_MS: "20000",
  },
});
const proxyClient = new Client({
  name: "optimike-external-roots-proxy-test",
  version: "0",
});

try {
  await waitForHealth(healthUrl, backend);
  await proxyClient.connect(proxyTransport);

  const tools = await proxyClient.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "external_handoff"));
  assert.equal(JSON.stringify(tools).includes(externalPath), false);

  const status = jsonOf(
    await proxyClient.callTool({
      name: "external_runtime_status",
      arguments: {},
    }),
  );
  assert.equal(status.enabled, true);
  assert.equal(status.localHandoffAllowed, true);
  assert.equal(JSON.stringify(status).includes(externalPath), false);

  const roots = jsonOf(
    await proxyClient.callTool({
      name: "external_roots_list",
      arguments: {},
    }),
  );
  assert.deepEqual(
    roots.roots.map((root) => root.id),
    ["proxy.pilot"],
  );

  const listing = jsonOf(
    await proxyClient.callTool({
      name: "external_list",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "",
        depth: 1,
      },
    }),
  );
  assert.ok(listing.entries.some((entry) => entry.path === "hello.txt"));
  assert.equal(JSON.stringify(listing).includes(externalPath), false);

  const stat = jsonOf(
    await proxyClient.callTool({
      name: "external_stat",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
        includeHash: true,
      },
    }),
  );
  assert.equal(stat.type, "file");
  assert.ok(stat.sha256);
  assert.equal("localPath" in stat, false);

  const read = jsonOf(
    await proxyClient.callTool({
      name: "external_read",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
      },
    }),
  );
  assert.equal(read.text, "Bonjour depuis le proxy");
  assert.equal("localPath" in read, false);

  const handoff = jsonOf(
    await proxyClient.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
        includeHash: true,
      },
    }),
  );
  assert.equal(path.isAbsolute(handoff.localPath), true);
  assert.notEqual(handoff.localPath, path.join(externalPath, "hello.txt"));
  assert.equal(
    await readFile(handoff.localPath, "utf8"),
    "Bonjour depuis le proxy",
  );
  assert.equal(handoff.sha256, read.sha256);

  const invalidHandoff = await proxyClient.callTool({
    name: "external_handoff",
    arguments: {
      rootId: "proxy.pilot",
      relativePath: "../outside.txt",
      unexpected: true,
    },
  });
  assert.equal(invalidHandoff.isError, true);
  assert.equal(jsonOf(invalidHandoff).error, "path_invalid");

  const httpTransport = new StreamableHTTPClientTransport(httpUrl);
  const httpClient = new Client({
    name: "optimike-external-roots-http-test",
    version: "0",
  });
  try {
    await httpClient.connect(httpTransport);
    const denied = await httpClient.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "proxy.pilot",
        relativePath: "hello.txt",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(jsonOf(denied).error, "capability_denied");
    assert.equal(JSON.stringify(denied).includes(externalPath), false);
  } finally {
    await httpClient.close().catch(() => undefined);
  }

  console.log(
    "PASS: stdio proxy owns one external-roots configuration for status/list/stat/read/handoff, HTTP denies handoff, and responses remain path-redacted",
  );
} finally {
  await proxyClient.close().catch(() => undefined);
  backend.kill();
  await new Promise((resolve) => {
    if (backend.exitCode !== null) return resolve();
    backend.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  await rm(sandbox, { recursive: true, force: true });
}
