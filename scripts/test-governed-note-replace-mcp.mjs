import assert from "node:assert/strict";
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
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOL_NAMES = [
  "obsidian_note_replace_apply",
  "obsidian_note_replace_plan",
  "obsidian_note_replace_recover",
  "obsidian_note_replace_status",
];
const FIXTURE_PATH = "Fixture/Governed Note.md";
const PROTECTED_LINE = "création: 2026-08-13";
const INITIAL_CONTENT = `---\n${PROTECTED_LINE}\nstatut: actif\n---\nbefore\n`;
const DEFAULT_BINDING = sha256("governed-note-replace-fixture-vault");
const SECRET = "sealed-next-content-MUST-NOT-LEAK-47f5108a";

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function json(res, status, payload) {
  const responseBody = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(responseBody),
  });
  res.end(responseBody);
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

class FakeObsidianAtomicWriteServer {
  constructor() {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent) {
          json(res, 500, {
            ok: false,
            error: { code: "fixture_error", message: String(error) },
          });
        } else {
          res.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    this.reset();
  }

  reset(content = INITIAL_CONTENT) {
    this.content = content;
    this.bindingFingerprint = DEFAULT_BINDING;
    this.writeEnabled = true;
    this.failBeforeWriteNext = false;
    this.loseResponseAfterWriteNext = false;
    this.blockedCas = undefined;
    this.hangingCas = undefined;
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

  blockNextCas() {
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => {
      enteredResolve = resolve;
    });
    const released = new Promise((resolve) => {
      releaseResolve = resolve;
    });
    const gate = {
      entered: () => enteredResolve(),
      released,
      release: () => releaseResolve(),
    };
    this.blockedCas = gate;
    return { entered, release: gate.release };
  }

  hangNextCas() {
    let enteredResolve;
    const entered = new Promise((resolve) => {
      enteredResolve = resolve;
    });
    this.hangingCas = { entered: () => enteredResolve() };
    return entered;
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
          writeEnabled: this.writeEnabled,
        },
        limits: { markdownOnly: true },
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/notes/read"
    ) {
      const payload = await requestBody(req);
      if (payload.path !== FIXTURE_PATH) {
        json(res, 404, {
          ok: false,
          contractVersion: 1,
          error: { code: "note_not_found", message: "Fixture note not found." },
        });
        return;
      }
      this.readRequests += 1;
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
      const payload = await requestBody(req);
      this.casRequests += 1;
      if (!this.writeEnabled) {
        json(res, 403, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "writes_disabled",
            message: "Atomic note writes are disabled in the bridge settings.",
          },
        });
        return;
      }
      if (payload.path !== FIXTURE_PATH) {
        json(res, 404, {
          ok: false,
          contractVersion: 1,
          error: { code: "note_not_found", message: "Fixture note not found." },
        });
        return;
      }
      if (payload.bindingFingerprint !== this.bindingFingerprint) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "binding_conflict",
            message: "Fixture backend binding changed.",
          },
        });
        return;
      }
      if (this.failBeforeWriteNext) {
        this.failBeforeWriteNext = false;
        req.socket.destroy();
        return;
      }
      if (this.blockedCas) {
        const gate = this.blockedCas;
        this.blockedCas = undefined;
        gate.entered();
        await gate.released;
      }
      if (this.hangingCas) {
        const gate = this.hangingCas;
        this.hangingCas = undefined;
        gate.entered();
        await new Promise(() => {});
        return;
      }
      const beforeSha256 = sha256(this.content);
      if (beforeSha256 !== payload.expectedSha256) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "hash_conflict",
            message: "The note changed after the plan was created.",
            details: { actualSha256: beforeSha256 },
          },
        });
        return;
      }
      this.content = payload.nextContent;
      this.successfulWrites += 1;
      if (this.loseResponseAfterWriteNext) {
        this.loseResponseAfterWriteNext = false;
        req.socket.destroy();
        return;
      }
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
    json(res, 404, {
      ok: false,
      error: { code: "fixture_not_found", message: url.pathname },
    });
  }

  content = INITIAL_CONTENT;
  bindingFingerprint = DEFAULT_BINDING;
  writeEnabled = true;
  readRequests = 0;
  casRequests = 0;
  successfulWrites = 0;
  failBeforeWriteNext = false;
  loseResponseAfterWriteNext = false;
  blockedCas = undefined;
  hangingCas = undefined;
  baseUrl = "";
}

function nextContent(label, extra = "") {
  return `---\n${PROTECTED_LINE}\nstatut: actif\n---\n${label}\n${extra}`;
}

function textBlocks(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function parseResult(result) {
  const text = textBlocks(result);
  return JSON.parse(text || "null");
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

function assertNoSecret(value, label) {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(
    serialized.includes(SECRET),
    false,
    `${label} leaked sealed nextContent`,
  );
}

function assertNoJournalPath(value, label) {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(
    serialized.includes(journalPath),
    false,
    `${label} leaked the private journal path`,
  );
}

const testRootParent = path.join(process.cwd(), ".tmp");
mkdirSync(testRootParent, { recursive: true });
const testRoot = mkdtempSync(
  path.join(testRootParent, "governed-note-replace-mcp-"),
);
const vaultPath = path.join(testRoot, "vault");
const logsPath = path.join(testRoot, "logs");
const journalPath = path.join(testRoot, "note-replace.sqlite");
mkdirSync(vaultPath, { recursive: true });
mkdirSync(logsPath, { recursive: true });

const fake = new FakeObsidianAtomicWriteServer();
await fake.listen();
const observed = [];
const stderrs = [];

function childEnv(writeMode = "full", runtimeMode = "live") {
  const env = {
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "debug",
    LOGS_DIR: logsPath,
    MCP_WRITE_MODE: writeMode,
    MCP_GUARDED_MAX_WRITE_CHARS: "100000",
    MCP_PROTECTED_FRONTMATTER_KEYS: "création,modification",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
    MCP_OBSIDIAN_NOTE_REPLACE_EXECUTION_LEASE_MS: "250",
    OBSIDIAN_RUNTIME_MODE: runtimeMode,
    OBSIDIAN_BASE_URL: fake.baseUrl,
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_BLOCKING: "true",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    SMART_SEARCH_MODE: "files",
    OPERON_MUTATIONS_ENABLED: "false",
  };
  if (runtimeMode === "live" || runtimeMode === "hybrid") {
    env.OBSIDIAN_API_KEY = "fixture-api-key";
  } else {
    env.OBSIDIAN_VAULT = vaultPath;
  }
  return env;
}

async function startClient(writeMode = "full", runtimeMode = "live") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: childEnv(writeMode, runtimeMode),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client(
    { name: "governed-note-replace-integration", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    transport,
    async close() {
      await client.close().catch(() => undefined);
      stderrs.push(stderr);
    },
    stderr: () => stderr,
  };
}

async function call(session, name, args, expectedError = false) {
  const result = await session.client.callTool({ name, arguments: args });
  observed.push(JSON.stringify(result));
  assert.equal(Boolean(result.isError), expectedError, `${name} error status`);
  return { result, payload: parseResult(result) };
}

function assertTerminal(receipt, outcome = "committed") {
  assert.equal(receipt.phase, "terminal");
  assert.equal(receipt.outcome, outcome);
  if (outcome === "committed") {
    assert.equal(receipt.postflight.status, "verified");
    assert.equal(receipt.recoveryAllowed, false);
    assert.equal(receipt.applyAllowed, false);
  }
}

let session;
try {
  const headless = await startClient("readonly", "headless-readonly");
  const headlessTools = await headless.client.listTools();
  assert.deepEqual(
    headlessTools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("obsidian_note_replace_")),
    [],
  );
  await headless.close();

  const hybrid = await startClient("readonly", "hybrid");
  const hybridTools = await hybrid.client.listTools();
  assert.deepEqual(
    hybridTools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("obsidian_note_replace_"))
      .sort(),
    TOOL_NAMES,
  );
  await hybrid.close();

  session = await startClient("full", "live");
  const listed = await session.client.listTools();
  for (const genericName of [
    "operation_plan",
    "operation_apply",
    "operation_status",
    "operation_recover",
  ]) {
    assert.equal(
      listed.tools.some((tool) => tool.name === genericName),
      false,
      `${genericName} must remain internal`,
    );
  }
  const governed = listed.tools
    .filter((tool) => tool.name.startsWith("obsidian_note_replace_"))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(
    governed.map((tool) => tool.name),
    TOOL_NAMES,
  );
  const byName = new Map(governed.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("obsidian_note_replace_plan")?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(byName.get("obsidian_note_replace_status")?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  for (const name of [
    "obsidian_note_replace_apply",
    "obsidian_note_replace_recover",
  ]) {
    assert.deepEqual(byName.get(name)?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
  assert.deepEqual(
    [...(byName.get("obsidian_note_replace_plan")?.inputSchema.required ?? [])].sort(),
    ["idempotencyKey", "nextContent", "path"],
  );
  assert.deepEqual(
    [...(byName.get("obsidian_note_replace_apply")?.inputSchema.required ?? [])].sort(),
    ["idempotencyKey", "planRef"],
  );
  assert.deepEqual(
    [...(byName.get("obsidian_note_replace_status")?.inputSchema.required ?? [])].sort(),
    ["planRef"],
  );
  assert.deepEqual(
    [...(byName.get("obsidian_note_replace_recover")?.inputSchema.required ?? [])].sort(),
    ["idempotencyKey", "planRef"],
  );
  assert.deepEqual(
    Object.keys(
      byName.get("obsidian_note_replace_apply")?.inputSchema.properties ?? {},
    ).sort(),
    ["idempotencyKey", "planRef"],
  );
  assert.deepEqual(
    Object.keys(
      byName.get("obsidian_note_replace_recover")?.inputSchema.properties ?? {},
    ).sort(),
    ["idempotencyKey", "planRef"],
  );

  fake.reset();
  const protectedAttempt = await call(
    session,
    "obsidian_note_replace_plan",
    {
      path: FIXTURE_PATH,
      nextContent:
        "---\ncréation: 2099-01-01\nstatut: actif\n---\nforbidden\n",
      idempotencyKey: "protected-frontmatter",
    },
    true,
  );
  assert.match(protectedAttempt.payload.error.message, /protected frontmatter/u);
  assert.equal(fake.casRequests, 0);

  const invalidMarkdown = await call(
    session,
    "obsidian_note_replace_plan",
    {
      path: FIXTURE_PATH,
      nextContent: nextContent("invalid", "```unclosed"),
      idempotencyKey: "invalid-markdown",
    },
    true,
  );
  assert.match(invalidMarkdown.payload.error.message, /not valid/u);

  const invalidSecretFrontmatter = await call(
    session,
    "obsidian_note_replace_plan",
    {
      path: FIXTURE_PATH,
      nextContent: `---\ncréation: 2026-08-13\nprivate: [${SECRET}\n---\nbody\n`,
      idempotencyKey: "invalid-secret-frontmatter",
    },
    true,
  );
  assert.match(
    invalidSecretFrontmatter.payload.error.message,
    /not valid|cannot be compared safely/u,
  );
  assertNoSecret(invalidSecretFrontmatter.result, "invalid frontmatter error");

  fake.reset();
  const secretContent = nextContent("nominal", `${SECRET}\n`);
  const firstPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: secretContent,
    idempotencyKey: "nominal-secret",
  });
  const planReplay = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: secretContent,
    idempotencyKey: "nominal-secret",
  });
  assert.equal(planReplay.payload.operationId, firstPlan.payload.operationId);
  assert.equal(planReplay.payload.planDigest, firstPlan.payload.planDigest);
  assertNoSecret(firstPlan.result, "plan receipt");
  const rebound = await call(
    session,
    "obsidian_note_replace_plan",
    {
      path: FIXTURE_PATH,
      nextContent: nextContent("different"),
      idempotencyKey: "nominal-secret",
    },
    true,
  );
  assert.match(rebound.payload.error.message, /different note replacement/u);

  const casBeforeNominal = fake.casRequests;
  const writesBeforeNominal = fake.successfulWrites;
  const nominal = await call(session, "obsidian_note_replace_apply", {
    planRef: firstPlan.payload.planRef,
    idempotencyKey: "nominal-secret",
  });
  assertTerminal(nominal.payload);
  assert.equal(fake.content, secretContent);
  assert.equal(fake.casRequests - casBeforeNominal, 1);
  assert.equal(fake.successfulWrites - writesBeforeNominal, 1);
  const nominalStatus = await call(session, "obsidian_note_replace_status", {
    planRef: firstPlan.payload.planRef,
  });
  assertTerminal(nominalStatus.payload);
  assert.equal(nominalStatus.payload.planDigest, nominal.payload.planDigest);
  const nominalReplay = await call(session, "obsidian_note_replace_apply", {
    planRef: firstPlan.payload.planRef,
    idempotencyKey: "nominal-secret",
  });
  assertTerminal(nominalReplay.payload);
  assert.equal(fake.casRequests - casBeforeNominal, 1);

  fake.reset();
  const stalePlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("stale-target"),
    idempotencyKey: "stale-target",
  });
  fake.content = nextContent("third-party-edit");
  const staleWrites = fake.successfulWrites;
  const stale = await call(session, "obsidian_note_replace_apply", {
    planRef: stalePlan.payload.planRef,
    idempotencyKey: "stale-target",
  });
  assertTerminal(stale.payload, "conflict");
  assert.equal(fake.successfulWrites, staleWrites);
  assert.equal(fake.content, nextContent("third-party-edit"));

  fake.reset();
  const bindingPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("wrong-backend"),
    idempotencyKey: "wrong-backend",
  });
  fake.bindingFingerprint = sha256("different-fixture-vault");
  const bindingCas = fake.casRequests;
  const binding = await call(session, "obsidian_note_replace_apply", {
    planRef: bindingPlan.payload.planRef,
    idempotencyKey: "wrong-backend",
  });
  assertTerminal(binding.payload, "rejected");
  assert.equal(fake.casRequests, bindingCas);
  fake.bindingFingerprint = DEFAULT_BINDING;

  fake.reset();
  const winnerPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("winner"),
    idempotencyKey: "two-plan-winner",
  });
  const loserPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("loser"),
    idempotencyKey: "two-plan-loser",
  });
  const blockedWinner = fake.blockNextCas();
  const writesBeforeRace = fake.successfulWrites;
  const winnerPromise = call(session, "obsidian_note_replace_apply", {
    planRef: winnerPlan.payload.planRef,
    idempotencyKey: "two-plan-winner",
  });
  await blockedWinner.entered;
  const loser = await call(session, "obsidian_note_replace_apply", {
    planRef: loserPlan.payload.planRef,
    idempotencyKey: "two-plan-loser",
  });
  blockedWinner.release();
  const winner = await winnerPromise;
  assertTerminal(loser.payload, "committed");
  assertTerminal(winner.payload, "conflict");
  assert.equal(fake.successfulWrites - writesBeforeRace, 1);
  assert.equal(fake.content, nextContent("loser"));

  fake.reset();
  const gatePlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("gate-closed"),
    idempotencyKey: "gate-closed",
  });
  fake.writeEnabled = false;
  const gateCas = fake.casRequests;
  const gateResult = await call(session, "obsidian_note_replace_apply", {
    planRef: gatePlan.payload.planRef,
    idempotencyKey: "gate-closed",
  });
  assertTerminal(gateResult.payload, "rejected");
  assert.equal(fake.casRequests, gateCas);
  assert.equal(fake.content, INITIAL_CONTENT);
  fake.writeEnabled = true;

  fake.reset();
  const concurrentPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("concurrent-apply"),
    idempotencyKey: "concurrent-apply-mcp",
  });
  const blockApply = fake.blockNextCas();
  const concurrentCasBefore = fake.casRequests;
  const concurrentWritesBefore = fake.successfulWrites;
  const firstApplyPromise = call(session, "obsidian_note_replace_apply", {
    planRef: concurrentPlan.payload.planRef,
    idempotencyKey: "concurrent-apply-mcp",
  });
  await blockApply.entered;
  const secondApply = await call(session, "obsidian_note_replace_apply", {
    planRef: concurrentPlan.payload.planRef,
    idempotencyKey: "concurrent-apply-mcp",
  });
  assert.equal(secondApply.payload.phase, "applying");
  assert.equal(secondApply.payload.outcome, null);
  assert.equal(fake.casRequests - concurrentCasBefore, 1);
  blockApply.release();
  const firstApply = await firstApplyPromise;
  assertTerminal(firstApply.payload);
  assert.equal(fake.successfulWrites - concurrentWritesBefore, 1);

  fake.reset();
  fake.loseResponseAfterWriteNext = true;
  const lostPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("lost-response"),
    idempotencyKey: "lost-response-mcp",
  });
  const lost = await call(session, "obsidian_note_replace_apply", {
    planRef: lostPlan.payload.planRef,
    idempotencyKey: "lost-response-mcp",
  });
  assertTerminal(lost.payload);
  const lostStatus = await call(session, "obsidian_note_replace_status", {
    planRef: lostPlan.payload.planRef,
  });
  assertTerminal(lostStatus.payload);
  assert.equal(lostStatus.payload.planDigest, lost.payload.planDigest);
  assert.equal(fake.content, nextContent("lost-response"));

  fake.reset();
  const interruptedPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("recovered-after-restart"),
    idempotencyKey: "restart-recovery-mcp",
  });
  const enteredHang = fake.hangNextCas();
  const interruptedApply = call(session, "obsidian_note_replace_apply", {
    planRef: interruptedPlan.payload.planRef,
    idempotencyKey: "restart-recovery-mcp",
  }).catch(() => undefined);
  await enteredHang;
  await session.close();
  await interruptedApply;
  await new Promise((resolve) => setTimeout(resolve, 350));
  session = await startClient("full", "live");
  const interruptedStatus = await call(
    session,
    "obsidian_note_replace_status",
    { planRef: interruptedPlan.payload.planRef },
  );
  assertTerminal(interruptedStatus.payload, "outcome_unknown");
  assert.equal(interruptedStatus.payload.recoveryAllowed, true);
  const recovered = await call(session, "obsidian_note_replace_recover", {
    planRef: interruptedPlan.payload.planRef,
    idempotencyKey: "restart-recovery-mcp",
  });
  assertTerminal(recovered.payload);
  assert.equal(fake.content, nextContent("recovered-after-restart"));

  fake.reset();
  fake.failBeforeWriteNext = true;
  const recoverPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("concurrent-recover"),
    idempotencyKey: "concurrent-recover-mcp",
  });
  const unknown = await call(session, "obsidian_note_replace_apply", {
    planRef: recoverPlan.payload.planRef,
    idempotencyKey: "concurrent-recover-mcp",
  });
  assertTerminal(unknown.payload, "outcome_unknown");
  assert.equal(unknown.payload.recoveryAllowed, true);
  const blockRecover = fake.blockNextCas();
  const recoverWritesBefore = fake.successfulWrites;
  const firstRecoverPromise = call(session, "obsidian_note_replace_recover", {
    planRef: recoverPlan.payload.planRef,
    idempotencyKey: "concurrent-recover-mcp",
  });
  await blockRecover.entered;
  const secondRecover = await call(
    session,
    "obsidian_note_replace_recover",
    {
      planRef: recoverPlan.payload.planRef,
      idempotencyKey: "concurrent-recover-mcp",
    },
  );
  assert.equal(secondRecover.payload.phase, "applying");
  assert.equal(secondRecover.payload.outcome, null);
  blockRecover.release();
  const firstRecover = await firstRecoverPromise;
  assertTerminal(firstRecover.payload);
  assert.equal(fake.successfulWrites - recoverWritesBefore, 1);

  fake.reset();
  const policyPlan = await call(session, "obsidian_note_replace_plan", {
    path: FIXTURE_PATH,
    nextContent: nextContent("policy-revalidated"),
    idempotencyKey: "policy-revalidated",
  });
  await session.close();
  session = await startClient("readonly", "live");
  const policyCasBefore = fake.casRequests;
  const blockedApply = await call(
    session,
    "obsidian_note_replace_apply",
    {
      planRef: policyPlan.payload.planRef,
      idempotencyKey: "policy-revalidated",
    },
    true,
  );
  assert.match(blockedApply.payload.error.message, /read-only mode/u);
  const blockedPlan = await call(
    session,
    "obsidian_note_replace_plan",
    {
      path: FIXTURE_PATH,
      nextContent: nextContent("readonly-plan"),
      idempotencyKey: "readonly-plan",
    },
    true,
  );
  assert.match(blockedPlan.payload.error.message, /read-only mode/u);
  assert.equal(fake.casRequests, policyCasBefore);
  await session.close();
  session = await startClient("full", "live");
  const afterPolicyRestore = await call(
    session,
    "obsidian_note_replace_apply",
    {
      planRef: policyPlan.payload.planRef,
      idempotencyKey: "policy-revalidated",
    },
  );
  assertTerminal(afterPolicyRestore.payload);

  const statusCasBefore = fake.casRequests;
  await call(session, "obsidian_note_replace_status", {
    planRef: policyPlan.payload.planRef,
  });
  assert.equal(fake.casRequests, statusCasBefore);

  for (const result of observed) {
    assertNoSecret(result, "MCP response");
    assertNoJournalPath(result, "MCP response");
  }
  for (const stderr of [...stderrs, session.stderr()]) {
    assertNoSecret(stderr, "MCP stderr");
    assertNoJournalPath(stderr, "MCP stderr");
  }
  for (const file of listFiles(logsPath)) {
    const log = readFileSync(file, "utf8");
    assertNoSecret(log, `log ${file}`);
    assertNoJournalPath(log, `log ${file}`);
  }

  console.log(
    "PASS: real stdio MCP client exercised the governed note-replacement tools, exact-plan replay/recovery, process restart, protected frontmatter, policy revalidation, convergence and concurrent single-writer guarantees.",
  );
} finally {
  if (session) await session.close();
  await fake.close();
  rmSync(testRoot, { recursive: true, force: true });
}
