#!/usr/bin/env node
// Run with: node --experimental-strip-types scripts/test-operation-close-mcp.mjs
// Real MCP stdio server against an HTTP Bridge fixture that uses the real
// Atomic Write Bridge effect fence. A write is held inside the "Bridge" before
// its effect point, the MCP process is killed, a new process closes the
// operation, then the held write resumes: it must be refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EffectFence, EffectFenceRefused } from "../plugins/obsidian-atomic-write-bridge/src/effectFence.ts";
import { nativeFormatFixture } from "./fixtures/native-frontmatter-format.mjs";

const NOTE = "Fixture/Clôture.md";
const BEFORE = "Corps initial privé.\n";
const AFTER = "Corps suivant PRIVATE-CLOSURE-PAYLOAD.\n";
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

class FencedBridgeServer {
  content = BEFORE;
  binding = sha256("operation-close-fixture");
  writes = 0;
  refusals = 0;
  fence = new EffectFence({ requireFence: () => false, registry: { epochs: [] } });
  hold = undefined;
  dropNextCas = false;

  constructor() {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) json(response, 500, { ok: false, error: { code: "fixture_error", message: String(error) } });
      });
    });
  }
  async listen() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
  }
  close() { this.server.closeAllConnections?.(); return new Promise((resolve) => this.server.close(resolve)); }
  holdNextCas() {
    let entered, release;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    this.hold = { entered, released };
    return { entered: enteredPromise, release };
  }
  status() {
    return { ok: true, contractVersion: 1, plugin: { id: "obsidian-atomic-write-bridge", version: "0.8.4" },
      frontmatterFormat: { contractVersion: 1, supported: true }, effectFence: this.fence.capability(),
      backend: { kind: "obsidian-vault-process", bindingFingerprint: this.binding, atomicCas: true, writeEnabled: true },
      limits: { markdownOnly: true } };
  }
  async handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname.replace("/extensions/obsidian-atomic-write-bridge", "");
    if (request.method === "GET" && url.pathname === "/") return json(response, 200, { service: "Obsidian Local REST API", authenticated: true, versions: { obsidian: "fixture", self: "5.0.2" } });
    if (request.method === "GET" && route === "/status") return json(response, 200, this.status());
    if (request.method !== "POST") return json(response, 404, { error: "not_found" });
    const payload = await body(request);
    if (route === "/frontmatter/format") return json(response, 200, await nativeFormatFixture(this.binding).inspectFrontmatterFormat(payload.yaml));
    if (route === "/notes/read") {
      if (payload.path !== NOTE) return json(response, 404, { ok: false, error: { code: "note_not_found", reasonCode: "resource_not_found" } });
      return json(response, 200, { ok: true, contractVersion: 1, path: NOTE, content: this.content, sha256: sha256(this.content),
        size: Buffer.byteLength(this.content, "utf8"), bindingFingerprint: this.binding });
    }
    if (route === "/effect-fence/resolve") {
      if (payload.bindingFingerprint !== this.binding) return json(response, 409, { ok: false, error: { code: "binding_conflict", reasonCode: "backend_binding_changed" } });
      return json(response, 200, { ok: true, contractVersion: 1, bindingFingerprint: this.binding, epoch: this.fence.epoch, mode: payload.mode,
        results: payload.attempts.map((attempt) => ({ ...attempt, ...this.fence.resolve(attempt, payload.mode) })),
        ...(payload.includeLegacy ? { legacy: this.fence.legacy() } : {}) });
    }
    if (route === "/notes/cas") {
      if (this.hold) { const hold = this.hold; this.hold = undefined; hold.entered(payload); await hold.released; }
      if (this.dropNextCas) { this.dropNextCas = false; request.socket.destroy(); return; }
      if (sha256(this.content) !== payload.expectedSha256) return json(response, 409, { ok: false, error: { code: "hash_conflict", reasonCode: "resource_changed" } });
      let settle;
      try { settle = this.fence.enter(payload.fence); }
      catch (error) {
        assert.ok(error instanceof EffectFenceRefused);
        this.refusals += 1;
        return json(response, 403, { ok: false, contractVersion: 1, status: "blocked", retryable: false,
          error: { code: "effect_fence_refused", reasonCode: "effect_fence_refused", message: "refused" } });
      }
      try { this.content = payload.nextContent; this.writes += 1; } finally { settle(); }
      return json(response, 200, { ok: true, contractVersion: 1, path: NOTE, beforeSha256: payload.expectedSha256,
        afterSha256: sha256(this.content), size: Buffer.byteLength(this.content, "utf8"), bindingFingerprint: this.binding });
    }
    return json(response, 404, { error: "not_found" });
  }
}

const parent = path.join(process.cwd(), ".tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "operation-close-mcp-"));
const logsPath = path.join(root, "logs");
mkdirSync(logsPath, { recursive: true });
const journalPath = path.join(root, "note-replace.sqlite");
const bridge = new FencedBridgeServer();
await bridge.listen();
const transcripts = [];

function serverEnv(writeMode) {
  return {
      NODE_ENV: "test", MCP_TRANSPORT_TYPE: "stdio", MCP_LOG_LEVEL: "error", LOGS_DIR: logsPath, MCP_WRITE_MODE: writeMode,
      MCP_GUARDED_MAX_WRITE_CHARS: "100000", MCP_PROTECTED_FRONTMATTER_KEYS: "création,modification",
      MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath, MCP_OBSIDIAN_NOTE_REPLACE_EXECUTION_LEASE_MS: "1000",
      OBSIDIAN_RUNTIME_MODE: "live", OBSIDIAN_API_KEY: "fixture-api-key", OBSIDIAN_BASE_URL: bridge.baseUrl,
      OBSIDIAN_VERIFY_SSL: "false", OBSIDIAN_ENABLE_CACHE: "false", OBSIDIAN_STARTUP_BLOCKING: "true",
      OBSIDIAN_STARTUP_MAX_RETRIES: "1", OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10", SEMANTIC_SEARCH_PREWARM: "false",
      ENABLE_QUERY_EMBEDDING: "false", SMART_SEARCH_MODE: "files", OPERON_MUTATIONS_ENABLED: "false", MCP_TOOL_PROFILE: "operational",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

async function startClient(writeMode = "full") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: serverEnv(writeMode),
    stderr: "pipe",
  });
  const client = new Client({ name: "operation-close-integration", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function call(session, name, args, expectedError = false) {
  const result = await session.client.callTool({ name, arguments: args });
  transcripts.push(JSON.stringify(result));
  assert.equal(Boolean(result.isError), expectedError, `${name} error status: ${JSON.stringify(result).slice(0, 400)}`);
  return JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || "null");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let first;
let second;
try {
  first = await startClient();
  const tools = (await first.client.listTools()).tools;
  const close = tools.find((tool) => tool.name === "obsidian_operation_close");
  assert.ok(close, "obsidian_operation_close is registered");
  assert.equal(close.annotations?.readOnlyHint, false);
  assert.equal(close.annotations?.destructiveHint, false);
  assert.match(close.description, /never writes a note/u);
  assert.equal(close.inputSchema.properties.dryRun.default, true);

  const plan = await call(first, "obsidian_note_replace_plan", { path: NOTE, nextContent: AFTER, idempotencyKey: "close-e2e", responseMode: "detailed" });
  const planRef = plan.planRef ?? plan.receipt?.planRef;
  assert.match(planRef, /^obsidian-note-replace:v1:/u);

  // The write reaches the Bridge and is held before its effect point.
  const held = bridge.holdNextCas();
  const pendingApply = call(first, "obsidian_note_replace_apply", { planRef, idempotencyKey: "close-e2e", completionMode: "deferred", responseMode: "detailed" }).catch(() => undefined);
  const heldPayload = await held.entered;
  assert.equal(heldPayload.fence.epoch, bridge.fence.epoch, "the attempt token reaches the Bridge");

  // While its executor is alive the operation can still evolve: refused, nothing revoked.
  const alive = await call(first, "obsidian_operation_close", { planRefs: [planRef], dryRun: false });
  assert.equal(alive.items[0].result, "refused");
  assert.equal(alive.items[0].reasonCode, "closure_operation_still_applying");
  assert.deepEqual(bridge.fence.resolve(heldPayload.fence, "inspect"), { verdict: "not_reached" });

  // Crash of the MCP process with the request still inside the Bridge.
  await first.client.close().catch(() => undefined);
  first = undefined;
  void pendingApply;
  await sleep(1_500);

  second = await startClient();
  const listed = await call(second, "obsidian_list_pending_operations", { status: "outcome_unknown" });
  assert.equal(listed.operations.length, 1);
  assert.equal(listed.operations[0].closeAllowed, true);

  const dry = await call(second, "obsidian_operation_close", { planRefs: [planRef] });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.items[0].result, "would_close");
  assert.equal(dry.items[0].evidence.attempts[0].verdict, "not_reached");
  assert.deepEqual(bridge.fence.resolve(heldPayload.fence, "inspect"), { verdict: "not_reached" }, "dry run revokes nothing");

  const readonly = await startClient("readonly");
  await call(readonly, "obsidian_operation_close", { planRefs: [planRef], dryRun: false }, true);
  await readonly.client.close().catch(() => undefined);

  const closed = await call(second, "obsidian_operation_close", { planRefs: [planRef], dryRun: false, reasonCode: "historical_cleanup" });
  assert.equal(closed.items[0].result, "closed");
  assert.equal(closed.items[0].outcome, "reviewed_unverified");
  assert.equal(closed.items[0].evidence.priorEffect, "none");
  assert.equal(closed.items[0].evidence.attempts[0].verdict, "revoked_before_effect");
  assert.deepEqual(closed.items[0].evidence.observation, { kind: "note-sha256", sha256: sha256(BEFORE), matches: "before" });

  // The held request finally reaches the effect point: refused, no write.
  held.release();
  await sleep(200);
  assert.equal(bridge.writes, 0);
  assert.equal(bridge.refusals, 1);
  assert.equal(bridge.content, BEFORE);

  const replay = await call(second, "obsidian_operation_close", { planRefs: [planRef], dryRun: false });
  assert.equal(replay.items[0].result, "already_closed");
  const status = await call(second, "obsidian_note_replace_status", { planRef, responseMode: "detailed" });
  assert.equal((status.outcome ?? status.receipt?.outcome), "reviewed_unverified");
  assert.equal((await call(second, "obsidian_list_pending_operations", {})).operations.length, 0);

  const notLocked = await call(second, "obsidian_operation_close", { datePreparationPaths: [NOTE], dryRun: false });
  assert.equal(notLocked.items[0].result, "not_needed");
  assert.equal(notLocked.items[0].reasonCode, "date_preparation_not_locked");
  await call(second, "obsidian_operation_close", { dryRun: false }, true);

  // Batch command of the operations procedure, through a launcher like launch.mjs.
  for (const key of ["batch-a", "batch-b"]) {
    bridge.content = BEFORE;
    const planned = await call(second, "obsidian_note_replace_plan", { path: NOTE, nextContent: AFTER + key, idempotencyKey: key, responseMode: "detailed" });
    bridge.dropNextCas = true;
    const lost = await call(second, "obsidian_note_replace_apply", { planRef: planned.planRef, idempotencyKey: key, completionMode: "deferred", responseMode: "detailed" });
    assert.equal(lost.outcome, "outcome_unknown");
  }
  const launcher = path.join(root, "launch-fixture.mjs");
  writeFileSync(launcher, `Object.assign(process.env, ${JSON.stringify(serverEnv("full"))});\nprocess.chdir(${JSON.stringify(process.cwd())});\nawait import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "dist/index.js")).href)});\n`, "utf8");
  // Asynchronous on purpose: this process also serves the fixture Bridge.
  const runBatch = async (...extra) => {
    const out = path.join(root, `batch-${extra.length ? "apply" : "dry"}.json`);
    await promisify(execFile)(process.execPath, ["scripts/close-pending-operations.mjs", "--launcher", launcher, "--out", out, ...extra]);
    return JSON.parse(readFileSync(out, "utf8"));
  };
  const dryBatch = await runBatch();
  assert.equal(dryBatch.apply, false);
  assert.deepEqual(dryBatch.summary, { would_close: 2 });
  assert.equal((await call(second, "obsidian_list_pending_operations", { status: "outcome_unknown" })).operations.length, 2);
  const applied = await runBatch("--apply");
  assert.deepEqual(applied.summary, { closed: 2 });
  assert.ok(applied.items.every((item) => item.evidence.priorEffect === "none"));
  assert.equal((await call(second, "obsidian_list_pending_operations", {})).operations.length, 0);
  assert.equal(bridge.writes, 0);

  const serialized = transcripts.join("\n");
  assert.equal(serialized.includes("PRIVATE-CLOSURE-PAYLOAD"), false, "closure receipts never return note content");
  console.log("PASS operation close MCP: held write refused after crash and closure, dry run, readonly policy, idempotent replay, cockpit and status, batch script dry run then apply");
} finally {
  await first?.client.close().catch(() => undefined);
  await second?.client.close().catch(() => undefined);
  await bridge.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
