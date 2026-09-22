import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

export const revision = "2026-07-28";
export const prefix = "io.modelcontextprotocol/";
export const secret = "dual-stack-fixture-only-secret-at-least-32-characters";
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function token(client = "a", ttl = "5m") {
  return new SignJWT({ cid: client, scp: ["vault:read"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://mcp-fixture.invalid")
    .setSubject(client)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(new TextEncoder().encode(secret));
}
export function envelope(method, params = {}, id = 1, client = "a") {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [prefix + "protocolVersion"]: revision,
        [prefix + "clientInfo"]: { name: client, version: "1" },
        [prefix + "clientCapabilities"]: {},
        ...params._meta,
      },
    },
  };
}
export function headers(body, bearer, overrides = {}) {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": revision,
    "Mcp-Method": body.method,
    ...(["tools/call", "resources/read", "prompts/get"].includes(body.method)
      ? { "Mcp-Name": body.params?.name ?? body.params?.uri }
      : {}),
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...overrides,
  };
}
export async function raw(base, body, bearer, extra = {}, route = "/mcp/full") {
  const response = await fetch(base + route, {
    method: "POST",
    headers: headers(body, bearer, extra),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    payload = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .find((value) => value.id === body.id);
  } else {
    try {
      payload = JSON.parse(text);
    } catch {
      /* assertions diagnose */
    }
  }
  return { response, payload, text };
}
export function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(
    result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  );
}
export async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "optimike-dual-stack-"));
  const logs = path.join(process.cwd(), ".tmp", path.basename(root));
  await mkdir(path.join(root, ".obsidian"));
  await mkdir(logs, { recursive: true });
  await writeFile(
    path.join(root, "Sentinel.md"),
    "# untouched\nDual stack sentinel.\n",
  );
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    MCP_PROTOCOL_MODE: "dual",
    MCP_TRANSPORT_TYPE: "http",
    OBSIDIAN_RUNTIME_MODE: "headless-readonly",
    OBSIDIAN_VAULT: root,
    OBSIDIAN_API_KEY: "",
    OBSIDIAN_BASE_URL: "http://127.0.0.1:1",
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_ENABLE_CACHE: "true",
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "cache.sqlite"),
    MCP_EXTERNAL_ROOTS_FILE: "",
    MCP_SKILLS_CONFIG_FILE: "",
    MCP_WRITE_MODE: "readonly",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_TOOL_PROFILE: "full",
    MCP_AUTH_MODE: "jwt",
    MCP_AUTH_SECRET_KEY: secret,
    MCP_ALLOWED_ORIGINS: "http://approved-fixture.invalid",
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "10000",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "10000",
    MCP_HTTP_MAX_SESSIONS: "2",
    MCP_LOG_LEVEL: "debug",
    LOGS_DIR: logs,
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(root, "notes.sqlite"),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(root, "bases.sqlite"),
    ...overrides,
  };
  let child,
    output = "";
  async function start() {
    child = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null)
        throw new Error("Fixture server failed: " + output);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
      } catch {
        /* startup */
      }
      await pause(50);
    }
    throw new Error("Fixture startup timed out.");
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    let timer;
    await Promise.race([
      exit,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
  }
  try {
    await start();
  } catch (error) {
    await stop();
    await rm(root, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    logs,
    env,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    start,
    stop,
    async close() {
      await stop();
      await rm(root, { recursive: true, force: true });
      await rm(logs, { recursive: true, force: true });
    },
  };
}
