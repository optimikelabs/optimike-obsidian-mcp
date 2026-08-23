import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function createVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "optimike-profile-proxy-"));
  await mkdir(path.join(root, ".obsidian", "optimike-mcp"), {
    recursive: true,
  });
  await writeFile(path.join(root, "Root.md"), "# profile proxy\n", "utf8");
  return root;
}

function sharedEnv(vault, port, extra = {}) {
  return {
    ...process.env,
    OBSIDIAN_RUNTIME_MODE: "headless-readonly",
    OBSIDIAN_VAULT: vault,
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(
      vault,
      ".obsidian",
      "optimike-mcp",
      "shared-cache.sqlite",
    ),
    OBSIDIAN_ENABLE_CACHE: "true",
    SEMANTIC_SEARCH_PREWARM: "false",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_LOG_LEVEL: "error",
    MCP_WRITE_MODE: "readonly",
    ...extra,
  };
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited early with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("backend did not become healthy");
}

async function openProxy(vault, port, profile) {
  const args = ["dist/stdio-proxy.js"];
  if (profile) args.push("--tool-profile", profile);
  const env = sharedEnv(vault, port, { MCP_TRANSPORT_TYPE: "stdio" });
  if (profile) {
    // Deliberately conflicting env proves CLI precedence inside each proxy.
    env.MCP_TOOL_PROFILE = profile === "standard" ? "full" : "standard";
  } else {
    delete env.MCP_TOOL_PROFILE;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: process.cwd(),
    env,
  });
  const client = new Client({
    name: `tool-profile-proxy-${profile}`,
    version: "0",
  });
  await client.connect(transport);
  return client;
}

const vault = await createVault();
const port = await freePort();
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: sharedEnv(vault, port, {
    MCP_TRANSPORT_TYPE: "http",
    MCP_TOOL_PROFILE: "full",
  }),
  stdio: "ignore",
});

try {
  await waitForHealth(port, backend);

  const implicit = await openProxy(vault, port);
  try {
    const names = (await implicit.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.length, 9);
    assert.ok(names.includes("smart_semantic_search"));
    assert.ok(!names.includes("external_read"));
  } finally {
    await implicit.close().catch(() => undefined);
  }

  const standard = await openProxy(vault, port, "standard");
  try {
    const result = await standard.listTools();
    const names = result.tools.map((tool) => tool.name);
    assert.equal(names.length, 9);
    assert.ok(names.includes("smart_semantic_search"));
    assert.ok(!names.includes("smart_search"));
    assert.ok(!names.includes("smart-search"));
    assert.ok(!names.includes("external_read"));
    assert.ok(!names.includes("operon_status"));

    const hidden = await standard.callTool({
      name: "external_read",
      arguments: { rootId: "missing", relativePath: "x.txt" },
    });
    assert.equal(hidden.isError, true);
    const hiddenText = hidden.content.map((item) => item.text ?? "").join("\n");
    assert.match(hiddenText, /tool_not_exposed/);
    assert.match(hiddenText, /standard/);

    const hiddenOperon = await standard.callTool({
      name: "operon_status",
      arguments: {},
    });
    assert.equal(hiddenOperon.isError, true);
    const hiddenOperonText = hiddenOperon.content
      .map((item) => item.text ?? "")
      .join("\n");
    assert.match(hiddenOperonText, /tool_not_exposed/);
    assert.match(hiddenOperonText, /standard/);
  } finally {
    await standard.close().catch(() => undefined);
  }

  const tasks = await openProxy(vault, port, "tasks");
  try {
    const result = await tasks.listTools();
    const names = result.tools.map((tool) => tool.name);
    assert.equal(names.length, 14);
    assert.ok(names.includes("operon_status"));
    assert.ok(names.includes("operon_get_configuration"));
    assert.ok(names.includes("operon_list_tasks"));
    assert.ok(!names.includes("obsidian_update_note"));

    const status = await tasks.callTool({
      name: "operon_status",
      arguments: {},
    });
    const statusText = status.content
      .map((item) => item.text ?? "")
      .join("\n");
    assert.match(
      statusText,
      /operon-cache|unavailable|headless|stale/u,
      "the tasks profile must expose a structured non-live Operon status rather than hiding the tool",
    );
  } finally {
    await tasks.close().catch(() => undefined);
  }

  const full = await openProxy(vault, port, "full");
  try {
    const result = await full.listTools();
    const names = result.tools.map((tool) => tool.name);
    assert.equal(names.length, 46);
    assert.ok(names.includes("smart_semantic_search"));
    assert.ok(!names.includes("smart_search"));
    assert.ok(!names.includes("smart-search"));
    assert.ok(names.includes("external_read"));
  } finally {
    await full.close().catch(() => undefined);
  }

  console.log(
    "PASS: stdio proxy defaults to standard, tasks exposes structured Operon status in non-live mode, explicit profiles remain per-client, and the shared backend remains full",
  );
} finally {
  if (backend.exitCode === null) backend.kill("SIGTERM");
  await new Promise((resolve) => {
    if (backend.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      if (backend.exitCode === null) backend.kill("SIGKILL");
      resolve();
    }, 5_000);
    backend.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await rm(vault, { recursive: true, force: true });
}
