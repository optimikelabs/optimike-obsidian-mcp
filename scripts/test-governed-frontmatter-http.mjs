#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  FRONTMATTER_FIXTURE_PATH,
  FRONTMATTER_INITIAL_CONTENT,
  GovernedFrontmatterAtomicServer,
} from "./fixtures/governed-frontmatter-atomic-server.mjs";

const TOOL_NAMES = [
  "obsidian_frontmatter_patch_apply",
  "obsidian_frontmatter_patch_plan",
  "obsidian_frontmatter_patch_recover",
  "obsidian_frontmatter_patch_status",
];
const SECRET = "http-frontmatter-sealed-MUST-NOT-LEAK";

function parse(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const payload = JSON.parse(text || "null");
  if (result.isError) {
    throw new Error(
      payload?.error?.message ?? `MCP tool failed: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP MCP exited before health check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for HTTP MCP health.");
}

async function startClient(url, name) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

async function call(session, name, args) {
  return parse(await session.client.callTool({ name, arguments: args }));
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(candidate) : [candidate];
  });
}

const parent = path.join(process.cwd(), ".tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "governed-frontmatter-http-"));
const logsPath = path.join(root, "logs");
const journalPath = path.join(root, "note-replace.sqlite");
mkdirSync(logsPath, { recursive: true });

const fake = new GovernedFrontmatterAtomicServer();
await fake.listen();
const port = await unusedPort();
let stdout = "";
let stderr = "";
const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "http",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_LOG_LEVEL: "error",
    MCP_WRITE_MODE: "full",
    MCP_PROTECTED_FRONTMATTER_KEYS: "création,modification",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
    LOGS_DIR: logsPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_BASE_URL: fake.baseUrl,
    OBSIDIAN_API_KEY: "fixture-api-key",
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_BLOCKING: "true",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
backend.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
backend.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
let first;
let second;
let third;
try {
  await waitForHealth(`${baseUrl}/healthz`, backend);
  first = await startClient(mcpUrl, "frontmatter-http-first");
  const tools = await first.client.listTools();
  assert.deepEqual(
    tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("obsidian_frontmatter_patch_"))
      .sort(),
    TOOL_NAMES,
  );

  const planned = await call(first, "obsidian_frontmatter_patch_plan", {
    path: FRONTMATTER_FIXTURE_PATH,
    operations: [
      { op: "set", key: "statut", value: SECRET },
      { op: "set", key: "rang", value: 1 },
    ],
    idempotencyKey: "p1-http-cross-session",
  });
  assert.equal(planned.phase, "planned");
  assert.equal(planned.operationKind, "obsidian.frontmatter.patch");
  assert.equal(JSON.stringify(planned).includes(SECRET), false);
  await first.close();
  first = undefined;

  second = await startClient(mcpUrl, "frontmatter-http-second");
  const secondStatus = await call(
    second,
    "obsidian_frontmatter_patch_status",
    { planRef: planned.planRef },
  );
  assert.equal(secondStatus.operationId, planned.operationId);
  assert.equal(secondStatus.phase, "planned");
  assert.equal(Object.hasOwn(secondStatus, "idempotencyKey"), false);
  assert.deepEqual(secondStatus.projection, planned.projection);
  const committed = await call(second, "obsidian_frontmatter_patch_apply", {
    planRef: planned.planRef,
    idempotencyKey: "p1-http-cross-session",
  });
  assert.equal(committed.outcome, "committed");
  await second.close();
  second = undefined;

  third = await startClient(mcpUrl, "frontmatter-http-third");
  const thirdStatus = await call(
    third,
    "obsidian_frontmatter_patch_status",
    { planRef: planned.planRef },
  );
  assert.equal(thirdStatus.outcome, "committed");
  assert.equal(Object.hasOwn(thirdStatus, "idempotencyKey"), false);
  assert.equal(thirdStatus.planDigest, committed.planDigest);
  assert.deepEqual(thirdStatus.projection, planned.projection);
  const replay = await call(third, "obsidian_frontmatter_patch_apply", {
    planRef: planned.planRef,
    idempotencyKey: "p1-http-cross-session",
  });
  assert.equal(replay.outcome, "committed");
  assert.equal(fake.casRequests, 1);
  assert.equal(fake.successfulWrites, 1);
  assert.equal(fake.content.includes(SECRET), true);
  assert.equal(fake.content.includes("Body must stay byte-identical."), true);
  assert.equal(
    JSON.stringify({ planned, committed, thirdStatus, replay }).includes(SECRET),
    false,
  );

  await third.close();
  third = undefined;
  const processExit = new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(backend.kill("SIGTERM"), true);
  const exit = await Promise.race([
    processExit,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for HTTP MCP shutdown.")),
        10_000,
      ),
    ),
  ]);
  if (process.platform === "win32") {
    assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
  } else {
    assert.deepEqual(exit, { code: 0, signal: null });
  }

  for (const value of [stdout, stderr]) {
    assert.equal(value.includes(SECRET), false);
    assert.equal(value.includes(journalPath), false);
  }
  for (const file of listFiles(logsPath)) {
    const log = readFileSync(file, "utf8");
    assert.equal(log.includes(SECRET), false);
    assert.equal(log.includes(journalPath), false);
  }

  console.log(
    `PASS: one P0 durable authority carried a governed frontmatter plan and its source-preservation proof across three real HTTP MCP sessions, committed exactly one CAS, replayed safely, and shut down cleanly (${process.platform}).`,
  );
} finally {
  await first?.close();
  await second?.close();
  await third?.close();
  if (backend.exitCode === null && backend.signalCode === null) {
    const forcedExit = new Promise((resolve) => backend.once("exit", resolve));
    backend.kill("SIGKILL");
    await forcedExit;
  }
  await fake.close();
  rmSync(root, { recursive: true, force: true });
}
