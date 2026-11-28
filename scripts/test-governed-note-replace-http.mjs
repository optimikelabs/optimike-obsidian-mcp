#!/usr/bin/env node

import { isolatedStateEnv } from "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { nativeFormatFixture } from "./fixtures/native-frontmatter-format.mjs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
const modern = process.env.MCP_TEST_PROTOCOL_ERA === "modern";
const { Client } = await import(
  modern
    ? "@modelcontextprotocol/client"
    : "@modelcontextprotocol/sdk/client/index.js"
);
const { StreamableHTTPClientTransport } = await import(
  modern
    ? "@modelcontextprotocol/client"
    : "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

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
// Observe the real HTTP listener in the child without polling or a server test mode.
const reportListening = `data:text/javascript,${encodeURIComponent(`
  import { Server } from "node:net";
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (...args) {
    this.once("listening", () => {
      if (this.address()?.port === Number(process.env.MCP_HTTP_PORT)) process.send("ready");
    });
    return Reflect.apply(listen, this, args);
  };
`)}`;

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
  constructor(vault) {
    this.note = path.join(vault, FIXTURE_PATH);
    mkdirSync(path.dirname(this.note), { recursive: true });
    this.content = INITIAL_CONTENT;
    this.bindingFingerprint = sha256("http-shared-runtime-fixture");
    this.casRequests = 0;
    this.successfulWrites = 0;
    this.datePreparationRequests = 0;
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

  get content() { return readFileSync(this.note, "utf8"); }
  set content(value) { writeFileSync(this.note, value, "utf8"); }

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
        plugin: { id: "obsidian-atomic-write-bridge", version: "0.8.4" },
        frontmatterFormat: { contractVersion: 1, supported: true },
        backend: {
          kind: "obsidian-vault-process",
          bindingFingerprint: this.bindingFingerprint,
          atomicCas: true,
          writeEnabled: true,
        },
        limits: { markdownOnly: true },
        ...(this.dateManagement ? {
          datePreparation: { contractVersion: 1, supported: true, fileStatProvenance: { contractVersion: 1 } },
          protection: {
            contractVersion: 1,
            frontmatterDateProperties: {
              integrations: [{ pluginId: "frontmatter-date-manager", createdPropertyName: "création" }],
            },
          },
          settlement: { contractVersion: 1, modifiedTimeFrontmatter: { integrations: [], utcOffsetMinutes: 0 } },
        } : {}),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/extensions/obsidian-atomic-write-bridge/frontmatter/format") {
      const { yaml } = await requestBody(req);
      this.onFormat?.();
      json(res, 200, await nativeFormatFixture(this.bindingFingerprint).inspectFrontmatterFormat(yaml));
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
          error: { code: "note_not_found", reasonCode: "resource_not_found", message: "Note not found." },
        });
        return;
      }
      await this.onRead?.();
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
      if (this.holdCas) {
        const onDispatch = this.holdCas;
        this.holdCas = undefined;
        const disconnected = new Promise((resolve) => res.once("close", resolve));
        onDispatch(disconnected);
        await disconnected;
        return;
      }
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
    if (url.pathname.endsWith("/notes/prepare-date")) this.datePreparationRequests += 1;
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
  const deadline = AbortSignal.timeout(15_000);
  try {
    const [ready] = await once(child, "message", { signal: deadline });
    assert.equal(ready, "ready");
    const response = await fetch(url, { signal: deadline });
    await response.body?.cancel();
    assert.equal(response.status, 200);
  } catch (error) {
    const startupLogs = listFiles(logsPath).map((file) => readFileSync(file, "utf8")).join("\n");
    throw new Error(`HTTP MCP failed to become healthy (exit=${child.exitCode ?? child.signalCode}).\n${stderr}\n${stdout}\n${startupLogs}`, { cause: error });
  }
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

async function callError(session, name, args) {
  const result = await session.client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  return JSON.parse(result.content[0].text).error;
}

async function startClient(url, name, options) {
  const transport = new StreamableHTTPClientTransport(new URL(url), options);
  const client = new Client(
    { name, version: "1.0.0" },
    {
      capabilities: {},
      ...(modern
        ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
        : {}),
    },
  );
  await client.connect(transport);
  if (modern) {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(transport.sessionId, undefined);
  }
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
const vaultPath = path.join(root, "vault");
mkdirSync(logsPath, { recursive: true });
const fake = new FakeAtomicWriteServer(vaultPath);
await fake.listen();
const port = await unusedPort();
let stderr = "";
let stdout = "";
function startBackend() {
  const child = spawn(process.execPath, ["--import", reportListening, path.resolve("dist/index.js")], {
    cwd: root,
    env: {
      ...getDefaultEnvironment(),
      ...isolatedStateEnv(),
      APPDATA: isolatedStateEnv().LOCALAPPDATA,
      NODE_ENV: "test",
      MCP_TRANSPORT_TYPE: "http",
      MCP_PROTOCOL_MODE: modern ? "dual" : "legacy",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_PORT_RETRIES: "0",
      MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY: "2",
      MCP_LOG_LEVEL: "info",
      MCP_WRITE_MODE: "full",
      MCP_VAULT_INSTRUCTIONS: "enforce",
      MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
      LOGS_DIR: logsPath,
      OBSIDIAN_RUNTIME_MODE: "live",
      OBSIDIAN_VAULT: vaultPath,
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
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  return child;
}

async function stopBackend(child, signal) {
  const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  assert.equal(child.kill(signal), true);
  const [code, terminatedBy] = await exited;
  return { code, signal: terminatedBy };
}

function againstJournal(action) {
  const database = new DatabaseSync(journalPath);
  try { return action(database); } finally { database.close(); }
}

const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
let backend = startBackend();
let first;
let second;
let third;
let lostClient;
try {
  await waitForHealth(`${baseUrl}/healthz`, backend);
  first = await startClient(mcpUrl, "governed-http-first");
  const tools = await first.client.listTools();
  assert.equal(
    tools.tools.some(
      (tool) => tool.name === "obsidian_list_pending_operations",
    ),
    true,
  );
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
  const pendingFromFirst = await call(
    first,
    "obsidian_list_pending_operations",
    { limit: 100 },
  );
  const pendingPlanned = pendingFromFirst.operations.find(
    (item) => item.planRef === planned.planRef,
  );
  assert.deepEqual(
    {
      operationKind: pendingPlanned?.operationKind,
      state: pendingPlanned?.state,
      nextAction: pendingPlanned?.nextAction,
    },
    {
      operationKind: "obsidian.note.replace",
      state: "planned",
      nextAction: "apply",
    },
  );
  assert.equal(JSON.stringify(pendingFromFirst).includes(SECRET), false);
  assert.equal(JSON.stringify(pendingFromFirst).includes(FIXTURE_PATH), false);
  assert.equal(
    JSON.stringify(pendingFromFirst).includes("http-cross-session"),
    false,
  );
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
  const pendingFromSecond = await call(
    second,
    "obsidian_list_pending_operations",
    { limit: 100 },
  );
  assert.equal(
    pendingFromSecond.operations.some(
      (item) => item.planRef === planned.planRef,
    ),
    false,
  );
  await second.close();
  second = undefined;

  third = await startClient(mcpUrl, "governed-http-third");
  const statusFromThirdSession = await call(
    third,
    "obsidian_note_replace_status",
    {
      planRef: planned.planRef,
    },
  );
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
  assert.equal(
    JSON.stringify({ planned, committed, replay }).includes(SECRET),
    false,
  );

  const proposal = {
    path: FIXTURE_PATH,
    operations: [
      {
        op: "replace_literal",
        search: SECRET,
        replacement: "patched-over-http",
      },
    ],
    idempotencyKey: "optimike:proposal:v1:http-cross-session-text-patch",
    proposal: {
      version: 1,
      bindingFingerprint: fake.bindingFingerprint,
      baseSha256: sha256(fake.content),
    },
  };
  const stale = await call(third, "obsidian_text_patch_plan", {
    ...proposal,
    idempotencyKey: "optimike:proposal:v1:stale",
    proposal: { ...proposal.proposal, baseSha256: sha256(INITIAL_CONTENT) },
  });
  assert.equal(stale.outcome, "conflict", "base drift must refuse admission");
  assert.equal(fake.content, nextContent, "a stale import must leave the file untouched");
  assert.equal(stale.trace, undefined, "base drift must not seal a plan");
  console.log("PASS: stale proposal records conflict without a plan or vault effect.");

  const wrongAuthority = await callError(third, "obsidian_text_patch_plan", {
    ...proposal,
    proposal: { ...proposal.proposal, bindingFingerprint: sha256("another authority") },
  });
  assert.equal(wrongAuthority.details.reasonCode, "proposal_authority_mismatch");
  fake.dateManagement = true;
  fake.content = "before\n";
  const undated = await callError(third, "obsidian_text_patch_plan", {
    ...proposal,
    proposal: { ...proposal.proposal, baseSha256: sha256(fake.content) },
  });
  assert.equal(undated.details.reasonCode, "proposal_date_preparation_required");
  assert.equal(fake.datePreparationRequests, 0);
  assert.equal(fake.content, "before\n");
  fake.dateManagement = false;
  fake.content = nextContent;
  console.log("PASS: wrong authority and undated target refused before any preparation.");

  const duringSeal = { ...proposal, idempotencyKey: "optimike:proposal:v1:during-seal" };
  fake.onFormat = () => {
    fake.onFormat = undefined;
    fake.content = nextContent + "Concurrent edit.\n";
  };
  assert.equal((await call(third, "obsidian_text_patch_plan", duringSeal)).outcome, "conflict");
  assert.equal(fake.content, nextContent + "Concurrent edit.\n");
  fake.content = nextContent;
  assert.equal((await call(third, "obsidian_text_patch_plan", duringSeal)).outcome, "conflict");
  console.log("PASS: drift between compilation and sealing leaves a replayable conflict.");

  const invalid = await third.client.callTool({
    name: "obsidian_text_patch_plan",
    arguments: { ...proposal, operations: [{ op: "append_body", text: "Example", unexpected: true }] },
  });
  assert.equal(invalid.isError, true, "proposal validation must reject unknown operation fields");

  const rollback = { ...proposal, idempotencyKey: "optimike:proposal:v1:rollback" };
  againstJournal((db) => db.exec(`CREATE TRIGGER reject_fixture_proposal
    BEFORE INSERT ON obsidian_text_patch_proposals WHEN NEW.id = 'rollback'
    BEGIN SELECT RAISE(ABORT, 'fixture cannot persist proposal'); END;`));
  try {
    await callError(third, "obsidian_text_patch_plan", rollback);
    assert.equal(againstJournal((db) => db.prepare(`SELECT 1 FROM obsidian_note_replace_plans
      WHERE json_extract(payload_json, '$.projection.publicIdempotencyKey') = ?`)
      .get(rollback.idempotencyKey)), undefined);
  } finally {
    againstJournal((db) => db.exec("DROP TRIGGER reject_fixture_proposal"));
  }
  console.log("PASS: failure to persist the association rolls back the plan insert.");

  first = await startClient(mcpUrl, "governed-http-concurrent");
  const bothReads = Promise.withResolvers();
  let reads = 0;
  fake.onRead = () => {
    if (++reads === 2) {
      fake.onRead = undefined;
      bothReads.resolve();
    }
    return bothReads.promise;
  };
  const [textPatchPlan, otherImport] = await Promise.all(
    [third, first].map((session) => call(session, "obsidian_text_patch_plan", proposal)),
  );
  assert.equal(textPatchPlan.phase, "planned");
  assert.equal(otherImport.planRef, textPatchPlan.planRef);
  assert.equal(otherImport.planDigest, textPatchPlan.planDigest);
  assert.equal(againstJournal((db) => db.prepare(`SELECT count(*) AS total
    FROM obsidian_note_replace_plans
    WHERE json_extract(payload_json, '$.projection.publicIdempotencyKey') = ?`)
    .get(proposal.idempotencyKey).total), 1);
  assert.equal(fake.content, nextContent);
  assert.equal(fake.casRequests, 1);
  console.log("PASS: concurrent imports share one sealed plan and leave the file unchanged.");
  assert.equal(JSON.stringify(textPatchPlan).includes(SECRET), false);

  const identityConflict = await callError(third, "obsidian_text_patch_plan", {
    ...proposal,
    operations: [{ op: "append_body", text: "Changed intent.\n" }],
  });
  assert.equal(identityConflict.details.reasonCode, "proposal_identity_conflict");
  await first.close();
  first = undefined;
  await third.close();
  third = undefined;
  first = await startClient(mcpUrl, "governed-http-fourth");
  const textPatchStatus = await call(first, "obsidian_text_patch_status", {
    planRef: textPatchPlan.planRef,
  });
  assert.equal(textPatchStatus.phase, "planned");
  const pendingTextPatch = await call(
    first,
    "obsidian_list_pending_operations",
    { limit: 100 },
  );
  const textPatchItem = pendingTextPatch.operations.find(
    (item) => item.planRef === textPatchPlan.planRef,
  );
  assert.deepEqual(
    {
      operationKind: textPatchItem?.operationKind,
      state: textPatchItem?.state,
      nextAction: textPatchItem?.nextAction,
    },
    {
      operationKind: "obsidian.text.patch",
      state: "planned",
      nextAction: "apply",
    },
  );
  const textPatchCommit = await call(first, "obsidian_text_patch_apply", {
    planRef: textPatchPlan.planRef,
    idempotencyKey: proposal.idempotencyKey,
  });
  assert.equal(textPatchCommit.outcome, "committed");
  assert.equal(fake.casRequests, 2);
  assert.equal(fake.successfulWrites, 2);
  assert.equal(fake.content.includes("patched-over-http"), true);
  assert.equal(
    JSON.stringify({ textPatchPlan, textPatchCommit }).includes(SECRET),
    false,
  );
  const importedAfterApply = await call(first, "obsidian_text_patch_plan", proposal);
  assert.equal(importedAfterApply.outcome, "committed");
  assert.equal(importedAfterApply.planDigest, textPatchPlan.planDigest);
  console.log("PASS: an imported plan applies through the existing enforced lifecycle and replays as committed.");

  const unresolvedWrite = { ...proposal, idempotencyKey: "optimike:proposal:v1:missing", path: "Fixture/Absent.md" };
  const missing = await call(first, "obsidian_text_patch_plan", unresolvedWrite);
  assert.equal(missing.outcome, "conflict");
  assert.equal(missing.trace, undefined);

  const patchedContent = fake.content;
  const recoveryProposal = {
    ...proposal,
    idempotencyKey: "optimike:proposal:v1:recover",
    operations: [{ op: "append_body", text: "Recovered once.\n" }],
    proposal: { ...proposal.proposal, baseSha256: sha256(fake.content) },
  };
  const staleAtApply = { ...recoveryProposal, idempotencyKey: "optimike:proposal:v1:stale-at-apply" };
  const staleAtApplyPlan = await call(first, "obsidian_text_patch_plan", staleAtApply);
  fake.content += "Edit after planning.\n";
  const applyConflict = await call(first, "obsidian_text_patch_apply", {
    planRef: staleAtApplyPlan.planRef,
    idempotencyKey: staleAtApply.idempotencyKey,
  });
  assert.equal(applyConflict.outcome, "conflict");
  assert.equal(fake.content, patchedContent + "Edit after planning.\n");
  assert.equal(fake.casRequests, 2);
  fake.content = patchedContent;
  console.log("PASS: apply preserves an edit made after the proposal was sealed.");

  const expiredProposal = { ...recoveryProposal, idempotencyKey: "optimike:proposal:v1:expire" };
  const expiredPlan = await call(first, "obsidian_text_patch_plan", expiredProposal);
  let dropResponse = false;
  lostClient = await startClient(mcpUrl, "governed-http-lost-response", {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (dropResponse && init?.method === "POST") {
        dropResponse = false;
        await response.arrayBuffer(); // The server finished. Deliver neither the receipt nor its reference.
        throw new Error("Planning response lost");
      }
      return response;
    },
  });
  dropResponse = true;
  await assert.rejects(call(lostClient, "obsidian_text_patch_plan", recoveryProposal), /Planning response lost/u);
  await lostClient.close();
  lostClient = undefined;
  const stored = againstJournal((db) => db.prepare(
    "SELECT plan_ref, plan_digest FROM obsidian_text_patch_proposals WHERE id = 'recover'",
  ).get());
  const recoveryPlan = await call(first, "obsidian_text_patch_plan", recoveryProposal);
  assert.equal(recoveryPlan.planRef, stored.plan_ref);
  assert.equal(recoveryPlan.planDigest, stored.plan_digest);
  console.log("PASS: a lost planning response replays the journaled plan and digest.");

  const dispatched = Promise.withResolvers();
  fake.holdCas = (disconnected) => dispatched.resolve({ disconnected });
  const interrupted = first.client.callTool({
    name: "obsidian_text_patch_apply",
    arguments: { planRef: recoveryPlan.planRef, idempotencyKey: recoveryProposal.idempotencyKey },
  }).then((result) => { throw new Error(`Apply returned before interruption: ${JSON.stringify(result)}`); });
  const { disconnected } = await Promise.race([dispatched.promise, interrupted]);
  await stopBackend(backend, "SIGKILL");
  await disconnected;
  await first.close();
  first = undefined;
  assert.equal(fake.successfulWrites, 2);

  // Sweep the dead lease, expire the pending plan, then purge its payload with
  // the production journal and an injected clock, without elapsed-time waits.
  const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
  const now = Date.now();
  for (const days of [31, 62]) {
    new ObsidianNoteReplaceJournal(journalPath, { now: () => now + days * 86_400_000 }).close();
  }
  assert.equal(againstJournal((db) => db.prepare(
    "SELECT 1 FROM obsidian_note_replace_plans WHERE operation_id = ?",
  ).get(expiredPlan.operationId)), undefined);

  backend = startBackend();
  await waitForHealth(`${baseUrl}/healthz`, backend);
  first = await startClient(mcpUrl, "governed-http-restarted");
  const expired = await call(first, "obsidian_text_patch_plan", expiredProposal);
  assert.equal(expired.outcome, "expired");
  assert.equal(expired.reason, "expired_with_trace");
  assert.deepEqual(expired.trace, { planRef: expiredPlan.planRef, planDigest: expiredPlan.planDigest });
  assert.equal(expired.applyAllowed, false);
  const purgedCommit = await call(first, "obsidian_text_patch_plan", proposal);
  assert.equal(purgedCommit.outcome, "committed");
  assert.equal(purgedCommit.reason, "receipt_purged");
  assert.deepEqual(purgedCommit.trace, { planRef: textPatchPlan.planRef, planDigest: textPatchPlan.planDigest });
  console.log("PASS: an expired and purged plan keeps its identity and cannot be re-planned.");

  const uncertain = await call(first, "obsidian_text_patch_status", { planRef: recoveryPlan.planRef });
  assert.equal(uncertain.outcome, "outcome_unknown");
  assert.equal(uncertain.planDigest, recoveryPlan.planDigest);
  const reimported = await call(first, "obsidian_text_patch_plan", recoveryProposal);
  assert.equal(reimported.recoveryRef, recoveryPlan.planRef);
  assert.equal(reimported.outcome, "outcome_unknown");
  assert.equal(fake.successfulWrites, 2);
  const recovered = await call(first, "obsidian_text_patch_recover", {
    planRef: recoveryPlan.planRef,
    idempotencyKey: recoveryProposal.idempotencyKey,
  });
  assert.equal(recovered.outcome, "committed");
  assert.equal(recovered.planDigest, recoveryPlan.planDigest);
  assert.equal(fake.successfulWrites, 3);
  assert.equal(fake.content.match(/Recovered once\./gu)?.length, 1);
  console.log("PASS: after a crash in CAS, status and recovery reconcile the same plan with one effect.");

  await first.close();
  first = undefined;
  const exit = await stopBackend(backend, "SIGTERM");
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
  await lostClient?.close();
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
