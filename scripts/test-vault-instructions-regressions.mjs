#!/usr/bin/env node

// Regressions of the independent review of the vault instructions gate
// (AGENTS.md cascade): the paths the backend really writes (Operon
// destinations, the notes a native move rewrites), Operon file-task creation
// under enforce, read-only sub-operations, seal persistence, raw-text REST
// reads, byte/time/concurrency bounds, cancellation and mode transitions.
//
// Real pieces: the gate, obsidian_read_note, the public error boundary, the
// MCP SDK, the SQLite seal journal, ObsidianRestApiService and OperonService
// against a local HTTP double of Local REST API and the Operon Bridge. Write
// tools are fakes registered under their real names. Every check runs even
// when another fails, so each regression is reported on its own.

import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Local HTTP double: Local REST API (/vault/...) and the Operon Bridge.

const restFiles = new Map();
const bridge = { fileTasksFolder: "Secret", configurationStatus: 200 };

const semanticConfiguration = () => ({
  language: "en",
  workflow: { language: "en", defaultPipelineName: null, pipelines: [] },
  priorities: { defaultPriority: null, items: [] },
  keys: [],
  creation: {
    fileTasksFolder: bridge.fileTasksFolder,
    inlineTaskSaveMode: "ask-every-time",
    inlineTaskUseDailyNote: false,
    inlineTaskTargetFile: "Inbox.md",
    inlineTaskHeading: "",
    inlineTaskDailyNoteAddStartDate: false,
    inlineTaskDailyNoteAddScheduledDate: false,
    taskCreatorDefaultToFileTask: false,
    taskCreatorDefaultFileTemplateId: "tpl",
    fileTaskTemplateFolder: "",
    fileTaskParentInlineTargetMode: "",
    fileTaskParentFileTargetMode: "",
    availableFileTaskTemplates: [],
  },
  automation: {
    autoCompleteParentWhenAllChildrenTerminal: false,
    cascadeCancelToDescendants: false,
    fileTaskAutoArchiveEnabled: false,
    fileTaskArchiveFolder: "",
    fileTaskArchiveDelaySeconds: 0,
    fileTaskArchiveOnlyFromFileTasksFolder: false,
    fileRepeatDestination: "",
    fileRepeatCustomFolder: "",
  },
  indexing: { excludedFolders: [], fullReindexOnStartup: false, indexEventDebounceMs: 0 },
  docs: { folder: "", autoUpdateEnabled: false },
  views: { filters: [] },
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname.endsWith("/extensions/optimike-operon-bridge/v1/configuration")) {
    if (bridge.configurationStatus !== 200) {
      response.writeHead(bridge.configurationStatus, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "offline" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      contractVersion: "1",
      source: "operon-runtime",
      stale: false,
      operonVersion: "4.4.0",
      bridgeVersion: "0.1.0",
      settingsSignature: "fnv1a32:settings",
      configuration: semanticConfiguration(),
      limitations: [],
    }));
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/vault/")) {
    const vaultPath = decodeURIComponent(url.pathname.slice("/vault/".length));
    const file = restFiles.get(vaultPath);
    if (!file) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ errorCode: 40400, message: "Not Found" }));
      return;
    }
    response.writeHead(200, { "Content-Type": file.contentType });
    response.end(file.body);
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

process.env.NODE_ENV = "test";
process.env.OBSIDIAN_API_KEY = "test-key";
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.MCP_LOG_LEVEL = "error";

const { McpServer, InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");
const { z } = await import("zod/v3");
const { mcpSchema } = await import("../dist/mcp-server/mcpSchema.js");
const { installMcpToolPublicErrorBoundary } = await import("../dist/mcp-server/toolErrorBoundary.js");
const { registerObsidianReadNoteTool } = await import("../dist/mcp-server/tools/obsidianReadNoteTool/index.js");
const { McpError, BaseErrorCode } = await import("../dist/types-global/errors.js");
const gate = await import("../dist/mcp-server/vaultInstructionsGate.js");
const core = await import("../dist/services/vaultInstructions.js");
const { VaultInstructionsSealJournal } = await import("../dist/services/vaultInstructionsSeal.js");
const { ObsidianRestApiService } = await import("../dist/services/obsidianRestAPI/service.js");
const { OperonService } = await import("../dist/services/operon/service.js");
const { defaultVaultInstructionsRuntime } = await import("../dist/mcp-server/vaultInstructionsRuntime.js");

const tempRoot = mkdtempSync(path.join(tmpdir(), "optimike-vault-instructions-regressions-"));
const failures = [];
let passed = 0;
async function check(label, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`FAIL ${label}\n  ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n  ")}`);
  }
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: no answer after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Fixtures

function makeVault(files = {}) {
  const root = mkdtempSync(path.join(tempRoot, "vault-"));
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  return root;
}
function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

/** Local REST double for obsidian_read_note, backed by a temporary folder. */
function fakeObsidian(root) {
  return {
    getFileContent: async (vaultPath, format = "markdown") => {
      const { readFileSync, existsSync, statSync } = await import("node:fs");
      const absolute = path.join(root, ...vaultPath.split("/"));
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "missing");
      }
      const content = readFileSync(absolute, "utf8");
      if (format === "json") {
        return { content, path: vaultPath, frontmatter: {}, tags: [], stat: { ctime: 1, mtime: 1, size: content.length } };
      }
      return content;
    },
    listFiles: async () => [],
  };
}

function makeRuntime(root, overrides = {}) {
  const sealPath = overrides.sealPath ?? path.join(root, "..", `${path.basename(root)}-seals.sqlite`);
  let seals;
  return {
    settings: {
      defaultMode: "enforce",
      minimumMode: "off",
      names: ["AGENTS.md"],
      vaultId: "test-vault",
      ...overrides.settings,
    },
    source: overrides.source ?? core.filesystemInstructionsSource(root),
    ledger: new core.VaultInstructionsReadLedger(),
    seals: overrides.seals ?? (() => (seals ??= new VaultInstructionsSealJournal(sealPath))),
    resolveOperonTaskPath: overrides.resolveOperonTaskPath ?? (async (id) => ({
      inl0001: "Public/Task.md",
      par0001: "Projects/Client/Parent.md",
    })[id]),
    ...(overrides.resolveOperonFileTaskFolder ? { resolveOperonFileTaskFolder: overrides.resolveOperonFileTaskFolder } : {}),
    ...(overrides.resolutionTimeoutMs ? { resolutionTimeoutMs: overrides.resolutionTimeoutMs } : {}),
    ...(overrides.probeLimiter ? { probeLimiter: overrides.probeLimiter } : {}),
    probeOptions: overrides.probeOptions ?? { probeTimeoutMs: 1_000 },
    closeSeals: () => seals?.close(),
  };
}

const counts = new Map();
const bump = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
const count = (name) => counts.get(name) ?? 0;
const receipt = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const moveReceipt = { affectedPaths: undefined };

function registerFakeTools(server) {
  const text = z.string();
  server.registerTool("obsidian_text_patch_plan", { inputSchema: mcpSchema({ path: text, idempotencyKey: text }) }, async (params) => {
    bump("obsidian_text_patch_plan");
    return receipt({ planRef: `plan:${params.idempotencyKey}`, phase: "planned" });
  });
  server.registerTool("obsidian_text_patch_apply", { inputSchema: mcpSchema({ planRef: text, idempotencyKey: text }) }, async (params) => {
    bump("obsidian_text_patch_apply");
    return receipt({ planRef: params.planRef, phase: "committed" });
  });
  server.registerTool("obsidian_note_move_plan", { inputSchema: mcpSchema({ sourcePath: text, destinationPath: text, idempotencyKey: text }) }, async (params) => {
    bump("obsidian_note_move_plan");
    return receipt({
      planRef: `move:${params.idempotencyKey}`,
      phase: "planned",
      target: { sourcePath: params.sourcePath, destinationPath: params.destinationPath },
      ...(moveReceipt.affectedPaths ? { affectedPaths: moveReceipt.affectedPaths } : {}),
    });
  });
  server.registerTool("obsidian_note_move_apply", { inputSchema: mcpSchema({ planRef: text, idempotencyKey: text }) }, async (params) => {
    bump("obsidian_note_move_apply");
    return receipt({ planRef: params.planRef, phase: "terminal", outcome: "committed" });
  });
  server.registerTool(
    "operon_convert_task",
    { inputSchema: mcpSchema({ operonId: text, target: z.enum(["inline", "file"]), targetFolder: text.optional(), targetPath: text.optional(), fileTemplateId: text.optional(), expectedRevision: text, idempotencyKey: text, dryRun: z.boolean().optional() }) },
    async () => {
      bump("operon_convert_task");
      return receipt({ ok: true });
    },
  );
  server.registerTool(
    "operon_create_task",
    { inputSchema: mcpSchema({ task: z.record(z.any()), idempotencyKey: text, dryRun: z.boolean().optional() }) },
    async () => {
      bump("operon_create_task");
      return receipt({ ok: true });
    },
  );
  server.registerTool(
    "obsidian_manage_tags",
    { inputSchema: mcpSchema({ operation: z.enum(["add", "remove", "list", "index", "audit", "rename"]), filePath: text.optional(), tags: z.array(text).optional(), fromTag: text.optional(), toTag: text.optional(), dryRun: z.boolean().optional() }) },
    async () => {
      bump("obsidian_manage_tags");
      return receipt({ success: true });
    },
  );
}

async function connect(runtime, obsidian) {
  const mcp = new McpServer({ name: "vault-instructions-regressions", version: "0" }, { capabilities: {} });
  installMcpToolPublicErrorBoundary(mcp);
  gate.installVaultInstructionsGate(mcp, runtime);
  await registerObsidianReadNoteTool(mcp, obsidian, undefined);
  registerFakeTools(mcp);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: "vault-instructions-regressions-client", version: "0" });
  await client.connect(clientTransport);
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      let json;
      try {
        json = JSON.parse(result.content?.[0]?.text);
      } catch {
        json = undefined;
      }
      return { result, json };
    },
    async read(...filePaths) {
      for (const filePath of filePaths) {
        const read = await client.callTool({ name: "obsidian_read_note", arguments: { filePath } });
        assert.equal(read.isError, false, `read ${filePath}`);
      }
    },
    async close() {
      await client.close();
      await mcp.close();
    },
  };
}

const RULES = "# Root\nAsk first.\n";
const PUBLIC = "# Public\nKeep it short.\n";
const SECRET = "# Secret\nNever write here without the owner.\n";
const states = (json) => json?.vaultInstructions?.files?.map((entry) => [entry.path, entry.state]);
const reason = (json) => json?.error?.details?.reasonCode;

async function session(files, overrides = {}) {
  const root = makeVault(files);
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, overrides);
  const connection = await connect(runtime, obsidian);
  return { root, runtime, connection, async close() { await connection.close(); runtime.closeSeals(); } };
}

// ---------------------------------------------------------------------------
// P1-1: the exact spelling the backend writes, every Unicode form checked.

await check("P1-1 a write in a decomposed (NFD) folder checks that folder's AGENTS.md, and its NFC twin", async () => {
  const nfd = "Café";
  const nfc = "Café";
  const s = await session({ [`${nfd}/AGENTS.md`]: "# NFD\n", [`${nfc}/AGENTS.md`]: "# NFC\n", [`${nfd}/N.md`]: "before\n" });
  const refused = await s.connection.call("obsidian_text_patch_plan", { path: `${nfd}/N.md`, idempotencyKey: "u" });
  assert.equal(reason(refused.json), "vault_instructions_unread");
  assert.deepEqual(states(refused.json), [[`${nfd}/AGENTS.md`, "unread"], [`${nfc}/AGENTS.md`, "unread"]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  await s.connection.read(`${nfd}/AGENTS.md`, `${nfc}/AGENTS.md`);
  const planned = await s.connection.call("obsidian_text_patch_plan", { path: `${nfd}/N.md`, idempotencyKey: "u" });
  assert.equal(planned.result.isError, false);
  await s.close();
});

// ---------------------------------------------------------------------------
// P1-2: Operon inline-to-file conversion checks the destination folder.

const CONVERT = { operonId: "inl0001", target: "file", expectedRevision: "r", idempotencyKey: "c", dryRun: true };
const operonVault = { "AGENTS.md": RULES, "Public/AGENTS.md": PUBLIC, "Public/Task.md": "- [ ] t\n", "Secret/AGENTS.md": SECRET };

await check("P1-2 legacy engine: conversion with targetFolder checks Secret/AGENTS.md before running", async () => {
  const s = await session(operonVault);
  await s.connection.read("AGENTS.md", "Public/AGENTS.md");
  const before = count("operon_convert_task");
  const refused = await s.connection.call("operon_convert_task", { ...CONVERT, targetFolder: "Secret" });
  assert.equal(reason(refused.json), "vault_instructions_unread");
  assert.equal(count("operon_convert_task"), before, "the conversion never ran");
  assert.deepEqual(states(refused.json), [["AGENTS.md", "read"], ["Public/AGENTS.md", "read"], ["Secret/AGENTS.md", "unread"]]);
  await s.connection.read("Secret/AGENTS.md");
  const converted = await s.connection.call("operon_convert_task", { ...CONVERT, targetFolder: "Secret" });
  assert.equal(converted.result.isError, false);
  await s.close();
});

await check("P1-2 Developer API V1: conversion checks the configured file-task folder read from the Bridge", async () => {
  const operon = new OperonService();
  bridge.fileTasksFolder = "Secret";
  const s = await session(operonVault, { resolveOperonFileTaskFolder: () => operon.configuredFileTaskFolder() });
  await s.connection.read("AGENTS.md", "Public/AGENTS.md");
  const before = count("operon_convert_task");
  const refused = await s.connection.call("operon_convert_task", { ...CONVERT, fileTemplateId: "tpl" });
  assert.equal(reason(refused.json), "vault_instructions_unread");
  assert.equal(count("operon_convert_task"), before);
  assert.ok(states(refused.json).some(([filePath, state]) => filePath === "Secret/AGENTS.md" && state === "unread"));
  await s.connection.read("Secret/AGENTS.md");
  assert.equal((await s.connection.call("operon_convert_task", { ...CONVERT, fileTemplateId: "tpl" })).result.isError, false);
  // An unreadable Operon configuration is unavailable, never a guess.
  bridge.configurationStatus = 503;
  const unavailable = await s.connection.call("operon_convert_task", { ...CONVERT, fileTemplateId: "tpl" });
  bridge.configurationStatus = 200;
  assert.equal(reason(unavailable.json), "vault_instructions_unavailable");
  await s.close();
});

// ---------------------------------------------------------------------------
// P1-3: a native move rewrites the notes that link to its source.

await check("P1-3 a move whose backlink lives under an unread Secret/AGENTS.md is not sealed, and the seal covers it", async () => {
  const s = await session({ "AGENTS.md": RULES, "Public/AGENTS.md": PUBLIC, "Public/A.md": "a\n", "Secret/AGENTS.md": SECRET, "Secret/Index.md": "[[Public/A]]\n" });
  moveReceipt.affectedPaths = ["Public/A.md", "Secret/Index.md"];
  await s.connection.read("AGENTS.md", "Public/AGENTS.md");
  const plan = { sourcePath: "Public/A.md", destinationPath: "Public/B.md", idempotencyKey: "mv1" };
  const refused = await s.connection.call("obsidian_note_move_plan", plan);
  assert.equal(reason(refused.json), "vault_instructions_unread", JSON.stringify(refused.json));
  assert.equal(refused.json.vaultInstructions.sealed, false);
  assert.match(refused.json.error.message, /not sealed/u);
  assert.ok(states(refused.json).some(([filePath, state]) => filePath === "Secret/AGENTS.md" && state === "unread"));
  const before = count("obsidian_note_move_apply");
  const unsealed = await s.connection.call("obsidian_note_move_apply", { planRef: "move:mv1", idempotencyKey: "mv1" });
  assert.equal(reason(unsealed.json), "vault_instructions_plan_unsealed");
  assert.equal(count("obsidian_note_move_apply"), before, "an unsealed move never applies");
  await s.connection.read("Secret/AGENTS.md");
  const planned = await s.connection.call("obsidian_note_move_plan", plan);
  assert.equal(planned.result.isError, false);
  assert.equal(planned.json.vaultInstructions.sealed, true);
  write(s.root, "Secret/AGENTS.md", `${SECRET}Changed.\n`);
  const changed = await s.connection.call("obsidian_note_move_apply", { planRef: "move:mv1", idempotencyKey: "mv1" });
  assert.equal(reason(changed.json), "vault_instructions_changed_since_plan", "the seal covers the rewritten note");
  assert.equal(count("obsidian_note_move_apply"), before);
  moveReceipt.affectedPaths = undefined;
  await s.close();
});

await check("P1-3 enforce refuses a move plan whose rewritten notes cannot be determined", async () => {
  const s = await session({ "AGENTS.md": RULES, "Public/A.md": "a\n" });
  moveReceipt.affectedPaths = undefined;
  await s.connection.read("AGENTS.md");
  const refused = await s.connection.call("obsidian_note_move_plan", { sourcePath: "Public/A.md", destinationPath: "Public/B.md", idempotencyKey: "mv2" });
  assert.equal(reason(refused.json), "vault_instructions_target_unresolved");
  assert.equal(refused.json.vaultInstructions.sealed, false);
  await s.close();
});

// ---------------------------------------------------------------------------
// P1-4: ordinary file-task creation under enforce.

const CREATE = { task: { source: "file", description: "Write the brief", fileTemplateId: "tpl" }, idempotencyKey: "k", dryRun: true };

await check("P1-4 enforce creates a file task in a vault without AGENTS.md (configured folder from the Bridge)", async () => {
  const operon = new OperonService();
  bridge.fileTasksFolder = "Tasks";
  const s = await session({ "Tasks/Existing.md": "x\n" }, { resolveOperonFileTaskFolder: () => operon.configuredFileTaskFolder() });
  const created = await s.connection.call("operon_create_task", CREATE);
  assert.equal(created.result.isError, false, JSON.stringify(created.json));
  assert.equal(created.json.vaultInstructions, undefined, "no rules, no change");
  await s.close();
});

await check("P1-4 enforce checks the configured folder and the parent task folder, then creates", async () => {
  const operon = new OperonService();
  bridge.fileTasksFolder = "Tasks";
  const s = await session(
    { "AGENTS.md": RULES, "Tasks/AGENTS.md": "# Tasks\n", "Projects/Client/AGENTS.md": "# Client\n", "Projects/Client/Parent.md": "p\n" },
    { resolveOperonFileTaskFolder: () => operon.configuredFileTaskFolder() },
  );
  await s.connection.read("AGENTS.md");
  const refused = await s.connection.call("operon_create_task", CREATE);
  assert.equal(reason(refused.json), "vault_instructions_unread");
  assert.deepEqual(states(refused.json), [["AGENTS.md", "read"], ["Tasks/AGENTS.md", "unread"]]);
  await s.connection.read("Tasks/AGENTS.md");
  assert.equal((await s.connection.call("operon_create_task", CREATE)).result.isError, false);
  const child = { ...CREATE, task: { ...CREATE.task, fields: { parentTask: "par0001" } } };
  const childRefused = await s.connection.call("operon_create_task", child);
  assert.deepEqual(states(childRefused.json).filter(([, state]) => state !== "read"), [["Projects/Client/AGENTS.md", "unread"]]);
  await s.connection.read("Projects/Client/AGENTS.md");
  assert.equal((await s.connection.call("operon_create_task", child)).result.isError, false);
  await s.close();
});

await check("P1-4 without a configured folder, enforce refuses without asking for a parameter the API rejects", async () => {
  const operon = new OperonService();
  bridge.fileTasksFolder = "";
  const s = await session({ "AGENTS.md": RULES }, { resolveOperonFileTaskFolder: () => operon.configuredFileTaskFolder() });
  await s.connection.read("AGENTS.md");
  const refused = await s.connection.call("operon_create_task", CREATE);
  bridge.fileTasksFolder = "Secret";
  assert.equal(reason(refused.json), "vault_instructions_target_unresolved");
  assert.doesNotMatch(refused.json.error.message, /targetPath|targetFolder/u);
  assert.match(refused.json.error.message, /fileTasksFolder/u);
  await s.close();
});

// ---------------------------------------------------------------------------
// P2-1: read-only sub-operations are never gated; a vault-wide rename is.

await check("P2-1 tag audit (and rename preview) run under enforce; a real rename is unresolved whatever filePath says", async () => {
  const s = await session({ "AGENTS.md": RULES, "Secret/AGENTS.md": SECRET, "Public/N.md": "#a\n" });
  for (const args of [{ operation: "audit" }, { operation: "index" }, { operation: "rename", fromTag: "a", toTag: "b" }, { operation: "rename", fromTag: "a", toTag: "b", dryRun: true }]) {
    const result = await s.connection.call("obsidian_manage_tags", args);
    assert.equal(result.result.isError, false, JSON.stringify(args));
    assert.equal(result.json.vaultInstructions, undefined);
  }
  await s.connection.read("AGENTS.md");
  const rename = await s.connection.call("obsidian_manage_tags", { operation: "rename", fromTag: "a", toTag: "b", dryRun: false, filePath: "Public/N.md" });
  assert.equal(reason(rename.json), "vault_instructions_target_unresolved");
  await s.close();
});

// ---------------------------------------------------------------------------
// P2-2: a seal that is not persisted is never announced.

await check("P2-2 journal unavailable: advise reports sealed:false, enforce refuses the plan before it runs", async () => {
  const files = { "AGENTS.md": RULES, "N.md": "x\n" };
  const advise = await session(files, { settings: { defaultMode: "advise" }, seals: () => undefined });
  await advise.connection.read("AGENTS.md");
  const planned = await advise.connection.call("obsidian_text_patch_plan", { path: "N.md", idempotencyKey: "j1" });
  assert.equal(planned.result.isError, false);
  assert.equal(planned.json.vaultInstructions.sealed, false);
  await advise.close();
  const enforce = await session(files, { seals: () => undefined });
  await enforce.connection.read("AGENTS.md");
  const before = count("obsidian_text_patch_plan");
  const refused = await enforce.connection.call("obsidian_text_patch_plan", { path: "N.md", idempotencyKey: "j2" });
  assert.equal(reason(refused.json), "vault_instructions_unavailable");
  assert.equal(refused.json.vaultInstructions.unavailableReason, "seal_journal");
  assert.equal(refused.json.error.details.retryable, false);
  assert.equal(count("obsidian_text_patch_plan"), before, "nothing was planned");
  await enforce.close();
});

await check("P2-2 a seal write that fails is reported sealed:false and its apply is refused", async () => {
  const failing = { seal() { throw new Error("disk full"); }, get() { return undefined; }, close() {} };
  const s = await session({ "AGENTS.md": RULES, "N.md": "x\n" }, { seals: () => failing });
  await s.connection.read("AGENTS.md");
  const planned = await s.connection.call("obsidian_text_patch_plan", { path: "N.md", idempotencyKey: "j3" });
  assert.equal(planned.result.isError, false);
  assert.equal(planned.json.vaultInstructions.sealed, false);
  assert.match(String(planned.json.vaultInstructions.message ?? ""), /could not be written/u);
  const applied = await s.connection.call("obsidian_text_patch_apply", { planRef: "plan:j3", idempotencyKey: "j3" });
  assert.equal(reason(applied.json), "vault_instructions_plan_unsealed");
  await s.close();
});

// ---------------------------------------------------------------------------
// P2-3: raw-text REST reads.

await check("P2-3 a Markdown AGENTS.md whose body is valid JSON is read as text through the real REST service", async () => {
  restFiles.clear();
  restFiles.set("AGENTS.md", { contentType: "text/markdown", body: '{"rules":["Ask the owner before every write"]}' });
  const runtime = defaultVaultInstructionsRuntime(new ObsidianRestApiService(), undefined);
  const content = await runtime.source.read("AGENTS.md", { maxBytes: 1024 });
  assert.equal(content, '{"rules":["Ask the owner before every write"]}');
  assert.equal(await runtime.source.read("Missing/AGENTS.md", { maxBytes: 1024 }), null, "a 404 is absent");
  const rules = await core.currentInstructionRules(runtime.source, ["AGENTS.md"], [{ path: "N.md" }]);
  assert.deepEqual(rules.files.map((entry) => entry.path), ["AGENTS.md"], "the file stays in the cascade");
});

await check("P2-3 a non-text answer is an invalid response (unavailable), never an absent file", async () => {
  const source = core.restInstructionsSource(async () => ({ rules: ["x"] }), () => false);
  await assert.rejects(() => source.read("AGENTS.md", { maxBytes: 1024 }), (error) => error instanceof core.VaultInstructionsUnavailableError && error.reason === "invalid_response");
});

// ---------------------------------------------------------------------------
// P2-4: bytes, time, cancellation and a process-wide budget.

await check("P2-4 an AGENTS.md of 4 MiB is refused as too large (enforce), never read whole", async () => {
  const s = await session({ "AGENTS.md": `# Big\n${"x".repeat(4 * 1024 * 1024)}\n`, "N.md": "x\n" });
  const before = count("obsidian_text_patch_plan");
  const refused = await s.connection.call("obsidian_text_patch_plan", { path: "N.md", idempotencyKey: "big" });
  assert.equal(reason(refused.json), "vault_instructions_unavailable");
  assert.equal(refused.json.vaultInstructions.unavailableReason, "too_large");
  assert.equal(refused.json.error.details.retryable, false);
  assert.match(refused.json.error.message, /256 KiB per file/u);
  assert.equal(count("obsidian_text_patch_plan"), before);
  await s.close();
});

await check("P2-4 the REST source bounds the body and the evaluation bounds the total", async () => {
  restFiles.clear();
  restFiles.set("AGENTS.md", { contentType: "text/markdown", body: "y".repeat(2 * 1024 * 1024) });
  const runtime = defaultVaultInstructionsRuntime(new ObsidianRestApiService(), undefined);
  await assert.rejects(() => runtime.source.read("AGENTS.md", { maxBytes: 256 * 1024 }), (error) => error?.reason === "too_large");
  // Six files of 200 KiB on one chain: each is accepted, their sum is not.
  const files = {};
  let folder = "";
  for (let depth = 0; depth < 6; depth += 1) {
    files[`${folder}AGENTS.md`] = "z".repeat(200 * 1024);
    folder += `d${depth}/`;
  }
  files[`${folder}N.md`] = "x\n";
  const root = makeVault(files);
  await assert.rejects(
    () => core.currentInstructionRules(core.filesystemInstructionsSource(root), ["AGENTS.md"], [{ path: `${folder}N.md` }]),
    (error) => error?.reason === "too_large",
  );
});

function slowSource(state, durationMs) {
  return {
    kind: "rest",
    read(_vaultPath, options) {
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      return new Promise((resolve, reject) => {
        const done = () => {
          state.active -= 1;
          options?.signal?.removeEventListener?.("abort", onAbort);
        };
        const timer = setTimeout(() => {
          done();
          resolve(null);
        }, durationMs);
        const onAbort = () => {
          clearTimeout(timer);
          done();
          reject(new Error("aborted"));
        };
        options?.signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    },
  };
}

await check("P2-4 a deadline cancels the reads still running", async () => {
  const state = { active: 0, max: 0 };
  const root = makeVault({});
  const runtime = makeRuntime(root, { source: slowSource(state, 2_000), settings: { defaultMode: "advise" }, probeOptions: { probeTimeoutMs: 50 } });
  const s = await connect(runtime, fakeObsidian(root));
  await Promise.all(["a", "b", "c"].map((top) => s.call("obsidian_text_patch_plan", { path: `${top}/x/y/N.md`, idempotencyKey: top })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(state.active, 0, `${state.active} reads still running after the deadline`);
  await s.close();
  runtime.closeSeals();
});

await check("P2-4 concurrent evaluations share one process-wide probe budget", async () => {
  const state = { active: 0, max: 0 };
  const root = makeVault({});
  const runtime = makeRuntime(root, { source: slowSource(state, 150), settings: { defaultMode: "advise" } });
  const s = await connect(runtime, fakeObsidian(root));
  await Promise.all(["a", "b", "c"].map((top) => s.call("obsidian_text_patch_plan", { path: `${top}/x/y/N.md`, idempotencyKey: top })));
  assert.ok(state.max <= core.VAULT_INSTRUCTIONS_LIMITS?.globalConcurrency && state.max <= 8, `${state.max} probes in flight at once`);
  await s.close();
  runtime.closeSeals();
});

await check("P2-4 the Operon resolution before the probes has its own deadline", async () => {
  const s = await session({ "AGENTS.md": RULES }, { resolveOperonTaskPath: () => new Promise(() => undefined), resolutionTimeoutMs: 100 });
  const refused = await withTimeout(
    s.connection.call("operon_convert_task", { operonId: "inl0001", target: "inline", targetPath: "Inbox.md", expectedRevision: "r", idempotencyKey: "t" }),
    3_000,
    "operon resolution",
  );
  assert.equal(reason(refused.json), "vault_instructions_unavailable");
  await s.close();
});

// ---------------------------------------------------------------------------
// P2-5: mode transitions in a vault without AGENTS.md.

await check("P2-5 a plan made in advise stays applicable after the client moves to enforce", async () => {
  const root = makeVault({ "N.md": "x\n" });
  const sealPath = path.join(tempRoot, "transition-seals.sqlite");
  const advise = makeRuntime(root, { settings: { defaultMode: "advise" }, sealPath });
  const first = await connect(advise, fakeObsidian(root));
  const planned = await first.call("obsidian_text_patch_plan", { path: "N.md", idempotencyKey: "t1" });
  assert.equal(planned.json.vaultInstructions, undefined, "no rules, no change in advise");
  await first.close();
  advise.closeSeals();
  const enforce = makeRuntime(root, { sealPath });
  const second = await connect(enforce, fakeObsidian(root));
  const applied = await second.call("obsidian_text_patch_apply", { planRef: "plan:t1", idempotencyKey: "t1" });
  assert.equal(applied.result.isError, false, JSON.stringify(applied.json));
  await second.close();
  enforce.closeSeals();
});

await check("P2-5 (pin, documented) off then enforce: the unsealed apply and an unknown target are refused without AGENTS.md", async () => {
  const root = makeVault({ "N.md": "x\n" });
  const sealPath = path.join(tempRoot, "transition-off-seals.sqlite");
  const off = makeRuntime(root, { settings: { defaultMode: "off" }, sealPath });
  const first = await connect(off, fakeObsidian(root));
  assert.equal((await first.call("obsidian_text_patch_plan", { path: "N.md", idempotencyKey: "t2" })).result.isError, false);
  await first.close();
  off.closeSeals();
  const enforce = makeRuntime(root, { sealPath });
  const second = await connect(enforce, fakeObsidian(root));
  const applied = await second.call("obsidian_text_patch_apply", { planRef: "plan:t2", idempotencyKey: "t2" });
  assert.equal(reason(applied.json), "vault_instructions_plan_unsealed");
  const rename = await second.call("obsidian_manage_tags", { operation: "rename", fromTag: "a", toTag: "b", dryRun: false });
  assert.equal(reason(rename.json), "vault_instructions_target_unresolved");
  await second.close();
  enforce.closeSeals();
});

// ---------------------------------------------------------------------------

server.close();
try {
  rmSync(tempRoot, { recursive: true, force: true });
} catch {
  // A temporary folder left behind is harmless.
}
if (failures.length > 0) {
  console.error(`vault instructions regressions: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`vault instructions regressions passed (${passed} checks)`);
