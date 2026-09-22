import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { envelope, prefix, revision } from "./fixtures/mcp-2026/runtime.mjs";
const root = await mkdtemp(path.join(tmpdir(), "optimike-modern-stdio-")),
  logs = path.join(process.cwd(), ".tmp", path.basename(root));
await mkdir(path.join(root, ".obsidian"));
await mkdir(logs, { recursive: true });
await writeFile(path.join(root, "Sentinel.md"), "stdio immutable sentinel\n");
const baseEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        ![
          "MCP_AUTH_MODE",
          "MCP_AUTH_SECRET_KEY",
          "MCP_BACKEND_BEARER_TOKEN",
          "MCP_PROTOCOL_MODE",
        ].includes(key),
    ),
  ),
  NODE_ENV: "test",
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: root,
  OBSIDIAN_ENABLE_CACHE: "true",
  OBSIDIAN_CACHE_SOURCE: "filesystem",
  OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "cache.sqlite"),
  MCP_WRITE_MODE: "readonly",
  MCP_TRANSPORT_TYPE: "stdio",
  MCP_EXTERNAL_ROOTS_FILE: "",
  MCP_SKILLS_CONFIG_FILE: "",
  SEMANTIC_SEARCH_PREWARM: "false",
  ENABLE_QUERY_EMBEDDING: "false",
  LOGS_DIR: logs,
  MCP_LOG_LEVEL: "error",
};
const sessions = [];
let rawChild;
const watchdog = setTimeout(() => {
  rawChild?.kill("SIGKILL");
  console.error("stdio fixture watchdog");
  process.exit(2);
}, 60000);
try {
  for (const [profile, count] of [
    ["standard", 9],
    ["authoring", 9],
    ["tasks", 14],
    ["full", 48],
  ]) {
    const transport = new ModernStdio({
      command: process.execPath,
      args: ["dist/index.js", "--tool-profile", profile],
      cwd: process.cwd(),
      env: { ...baseEnv, MCP_PROTOCOL_MODE: "dual" },
      stderr: "pipe",
    });
    const sent = [],
      send = transport.send.bind(transport);
    transport.send = async (message, ...rest) => {
      sent.push(message);
      return send(message, ...rest);
    };
    const client = new ModernClient(
      { name: "stdio-2026", version: "1" },
      { versionNegotiation: { mode: { pin: revision } } },
    );
    sessions.push(client);
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    await client.discover();
    assert.equal((await client.listTools()).tools.length, count);
    const status = await client.callTool({
      name: "obsidian_runtime_status",
      arguments: {},
    });
    assert.notEqual(status.isError, true);
    assert.equal(
      JSON.parse(status.content[0].text).capabilityManifest.profile,
      profile,
    );
    assert.ok(sent.some((x) => x.method === "server/discover"));
    assert.equal(
      sent.some((x) => x.method === "initialize"),
      false,
    );
    sent
      .filter((x) => x.id !== undefined)
      .forEach((x) => {
        assert.equal(x.params._meta[prefix + "protocolVersion"], revision);
        assert.ok(x.params._meta[prefix + "clientCapabilities"]);
      });
    await client.close();
  }
  for (const mode of [undefined, "dual"]) {
    const transport = new LegacyStdio({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: process.cwd(),
      env: { ...baseEnv, ...(mode ? { MCP_PROTOCOL_MODE: mode } : {}) },
      stderr: "pipe",
    });
    const client = new LegacyClient({
      name: "genuine-v1-client",
      version: "1",
    });
    sessions.push(client);
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 9);
    await client.close();
  }
  // Raw frames prove metadata is revalidated; the SDK client normally fills it.
  rawChild = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...baseEnv, MCP_PROTOCOL_MODE: "dual" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  let buffer = "",
    stdoutError;
  rawChild.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        waiting.get(frame.id)?.(frame);
        waiting.delete(frame.id);
      } catch {
        stdoutError = line;
      }
    }
  });
  rawChild.stderr.on("data", () => {});
  const exchange = (body) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(body.id);
        reject(Error("stdio response timeout"));
      }, 8000);
      waiting.set(body.id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      rawChild.stdin.write(JSON.stringify(body) + "\n");
    });
  const first = await exchange(envelope("tools/list", {}, 1));
  assert.equal(
    first.result.tools.length,
    9,
    "modern tools/list requires no initialize and no prior discovery",
  );
  const missing = envelope("tools/list", {}, 2);
  delete missing.params._meta[prefix + "clientCapabilities"];
  assert.equal(
    (await exchange(missing)).error.code,
    -32602,
    "earlier capabilities cannot leak into a later request",
  );
  const invalid = envelope("tools/list", {}, 3);
  invalid.params._meta[prefix + "protocolVersion"] = "2099-01-01";
  assert.equal((await exchange(invalid)).error.code, -32022);
  const after = await exchange(envelope("tools/list", {}, 4));
  assert.equal(after.result.tools.length, 9);
  assert.equal(stdoutError, undefined, "stdout is JSON-RPC only");
  const rawExit = new Promise((resolve) => rawChild.once("exit", resolve));
  rawChild.stdin.end();
  rawChild.kill("SIGTERM");
  await rawExit;
  const bad = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...baseEnv, MCP_PROTOCOL_MODE: "invalid-fixture-mode" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  bad.stdout.on("data", (c) => (output += c));
  bad.stderr.on("data", (c) => (output += c));
  const exit = await new Promise((r) => bad.once("exit", r));
  assert.notEqual(exit, 0);
  assert.equal(
    output.includes("invalid-fixture-mode"),
    false,
    "invalid config must not echo its value",
  );
  console.log(
    "PASS: modern stdio 4 profiles, genuine v1 default/dual clients, discovery-free request, per-request metadata, unsupported version, JSON-only stdout and fail-closed protocol mode",
  );
} finally {
  clearTimeout(watchdog);
  rawChild?.kill("SIGKILL");
  await Promise.allSettled(sessions.map((c) => c.close()));
  await rm(root, { recursive: true, force: true });
  await rm(logs, { recursive: true, force: true });
}
