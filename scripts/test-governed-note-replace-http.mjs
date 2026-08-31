#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOOL_NAMES = [
  "obsidian_note_replace_apply",
  "obsidian_note_replace_plan",
  "obsidian_note_replace_recover",
  "obsidian_note_replace_status",
];
const TEXT_PATCH_TOOL_NAMES = [
  "obsidian_text_patch_apply",
  "obsidian_text_patch_plan",
  "obsidian_text_patch_recover",
  "obsidian_text_patch_status",
];
const FIXTURE_PATH = "Fixture/HTTP Shared Runtime.md";
const INITIAL_CONTENT = "---\ncréation: 2026-08-13\n---\nbefore\n";
const SECRET = "http-shared-runtime-sealed-content-MUST-NOT-LEAK";

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

class FakeAtomicWriteServer {
  constructor() {
    this.content = INITIAL_CONTENT;
    this.bindingFingerprint = sha256("http-shared-runtime-fixture");
    this.casRequests = 0;
    this.successfulWrites = 0;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        json(res, 500, {
          ok: false,
          error: {
            code: "fixture_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    });
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    assert.ok(address && typeof address === "object");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  async handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      json(res, 200, {
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "fixture", self: "5.0.2" },
      });
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/status"
    ) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        plugin: { id: "obsidian-atomic-write-bridge", version: "0.1.0" },
        backend: {
          kind: "obsidian-vault-process",
          bindingFingerprint: this.bindingFingerprint,
          atomicCas: true,
          writeEnabled: true,
        },
        limits: { markdownOnly: true },
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/notes/read"
    ) {
      const body = await requestBody(req);
      if (body.path !== FIXTURE_PATH) {
        json(res, 404, {
          ok: false,
          contractVersion: 1,
          error: { code: "note_not_found", message: "Note not found." },
        });
        return;
      }
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: FIXTURE_PATH,
        content: this.content,
        sha256: sha256(this.content),
        size: Buffer.byteLength(this.content, "utf8"),
        bindingFingerprint: this.bindingFingerprint,
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/notes/cas"
    ) {
      this.casRequests += 1;
      const body = await requestBody(req);
      if (body.bindingFingerprint !== this.bindingFingerprint) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: { code: "binding_conflict", message: "Binding conflict." },
        });
        return;
      }
      const beforeSha256 = sha256(this.content);
      if (body.expectedSha256 !== beforeSha256) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "hash_conflict",
            message: "Hash conflict.",
            details: { actualSha256: beforeSha256 },
          },
        });
        return;
      }
      this.content = body.nextContent;
      this.successfulWrites += 1;
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: FIXTURE_PATH,
        beforeSha256,
        afterSha256: sha256(this.content),
        size: Buffer.byteLength(this.content, "utf8"),
        bindingFingerprint: this.bindingFingerprint,
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  }
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

const parent = path.join(process.cwd(), ".tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "governed-note-http-"));
const logsPath = path.join(root, "logs");
const journalPath = path.join(root, "note-replace.sqlite");
mkdirSync(logsPath, { recursive: true });
const fake = new FakeAtomicWriteServer();
await fake.listen();
const port = await unusedPort();
let stderr = "";
let stdout = "";
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
  first = await startClient(mcpUrl, "governed-http-first");
  const tools = await first.client.listTools();
  assert.deepEqual(
    tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("obsidian_note_replace_"))
      .sort(),
    TOOL_NAMES,
  );
  assert.deepEqual(
    tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("obsidian_text_patch_"))
      .sort(),
    TEXT_PATCH_TOOL_NAMES,
  );

  const nextContent = `---\ncréation: 2026-08-13\n---\n${SECRET}\n`;
  const planned = await call(first, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent,
    idempotencyKey: "http-cross-session",
  });
  assert.equal(planned.phase, "planned");
  await first.close();
  first = undefined;

  second = await startClient(mcpUrl, "governed-http-second");
  const statusFromSecondSession = await call(
    second,
    "obsidian_note_replace_status",
    { planRef: planned.planRef },
  );
  assert.equal(statusFromSecondSession.operationId, planned.operationId);
  assert.equal(statusFromSecondSession.planDigest, planned.planDigest);
  assert.equal(statusFromSecondSession.phase, "planned");
  const committed = await call(second, "obsidian_note_replace_apply", {
    planRef: planned.planRef,
    idempotencyKey: "http-cross-session",
  });
  assert.equal(committed.outcome, "committed");
  await second.close();
  second = undefined;

  third = await startClient(mcpUrl, "governed-http-third");
  const statusFromThirdSession = await call(third, "obsidian_note_replace_status", {
    planRef: planned.planRef,
  });
  assert.equal(statusFromThirdSession.outcome, "committed");
  assert.equal(statusFromThirdSession.planDigest, planned.planDigest);
  const replay = await call(third, "obsidian_note_replace_apply", {
    planRef: planned.planRef,
    idempotencyKey: "http-cross-session",
  });
  assert.equal(replay.outcome, "committed");
  assert.equal(fake.casRequests, 1);
  assert.equal(fake.successfulWrites, 1);
  assert.equal(fake.content, nextContent);
  assert.equal(JSON.stringify({ planned, committed, replay }).includes(SECRET), false);

  const textPatchPlan = await call(third, "obsidian_text_patch_plan", {
    path: FIXTURE_PATH,
    operations: [
      { op: "replace_literal", search: SECRET, replacement: "patched-over-http" },
    ],
    idempotencyKey: "http-cross-session-text-patch",
  });
  assert.equal(textPatchPlan.phase, "planned");
  assert.equal(JSON.stringify(textPatchPlan).includes(SECRET), false);

  await third.close();
  third = undefined;
  first = await startClient(mcpUrl, "governed-http-fourth");
  const textPatchStatus = await call(first, "obsidian_text_patch_status", {
    planRef: textPatchPlan.planRef,
  });
  assert.equal(textPatchStatus.phase, "planned");
  const textPatchCommit = await call(first, "obsidian_text_patch_apply", {
    planRef: textPatchPlan.planRef,
    idempotencyKey: "http-cross-session-text-patch",
  });
  assert.equal(textPatchCommit.outcome, "committed");
  assert.equal(fake.casRequests, 2);
  assert.equal(fake.successfulWrites, 2);
  assert.equal(fake.content.includes("patched-over-http"), true);
  assert.equal(JSON.stringify({ textPatchPlan, textPatchCommit }).includes(SECRET), false);
  await first.close();
  first = undefined;
  const processExit = new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(backend.kill("SIGTERM"), true);
  const exit = await Promise.race([
    processExit,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for HTTP MCP process exit.")),
        10_000,
      ),
    ),
  ]);
  if (process.platform === "win32") {
    assert.deepEqual(exit, { code: null, signal: "SIGTERM" });
  } else {
    assert.deepEqual(exit, { code: 0, signal: null });
  }
  assert.equal(stderr.includes(SECRET), false);
  assert.equal(stdout.includes(SECRET), false);
  assert.equal(stderr.includes(journalPath), false);
  assert.equal(stdout.includes(journalPath), false);
  for (const file of listFiles(logsPath)) {
    const log = readFileSync(file, "utf8");
    assert.equal(log.includes(SECRET), false);
    assert.equal(log.includes(journalPath), false);
  }

  console.log(
    `PASS: one process-wide governed note runtime carried sealed note-replacement and text-patch plans across real HTTP MCP sessions, committed once per plan, replayed safely, and terminated deterministically (${process.platform}).`,
  );
} finally {
  await first?.close();
  await second?.close();
  await third?.close();
  if (backend.exitCode === null && backend.signalCode === null) {
    const forcedExit = new Promise((resolve) =>
      backend.once("exit", () => resolve()),
    );
    backend.kill("SIGKILL");
    await forcedExit;
  }
  await fake.close();
  rmSync(root, { recursive: true, force: true });
}
