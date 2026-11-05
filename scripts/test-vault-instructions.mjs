#!/usr/bin/env node

// Vault agent instructions (AGENTS.md cascade): server instructions, read
// proofs, advise annotations, enforce refusals, plan seals and client modes.
// Real pieces: the gate, the read proof hook, obsidian_read_note, the public
// error boundary, the MCP SDK client/server and the SQLite seal journal. Write
// tools are small fakes registered under their real names, so the test proves
// the gate decides before any write tool runs. Vaults are temporary folders.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OBSIDIAN_API_KEY ??= "test-key";
process.env.OBSIDIAN_BASE_URL ??= "http://127.0.0.1:27123";
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
const names = await import("../dist/services/vaultInstructionsNames.js");
const { VaultInstructionsSealJournal } = await import("../dist/services/vaultInstructionsSeal.js");
const httpState = await import("../dist/mcp-server/transports/httpRequestState.js");

const tempRoot = mkdtempSync(path.join(tmpdir(), "optimike-vault-instructions-"));
let passed = 0;
async function check(label, work) {
  try {
    await work();
    passed += 1;
  } catch (error) {
    console.error(`FAILED: ${label}`);
    throw error;
  }
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

/** Local REST double backed by a temporary folder. */
function fakeObsidian(root) {
  const service = {
    stale: undefined,
    getFileContent: async (vaultPath, format = "markdown") => {
      const { readFileSync, existsSync, statSync } = await import("node:fs");
      const absolute = path.join(root, ...vaultPath.split("/"));
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "missing");
      }
      let content = readFileSync(absolute, "utf8");
      if (format === "json" && service.stale !== undefined) {
        content = service.stale;
        service.stale = undefined;
      }
      if (format === "json") {
        return { content, path: vaultPath, frontmatter: {}, tags: [], stat: { ctime: 1, mtime: 1, size: content.length } };
      }
      return content;
    },
    listFiles: async () => [],
  };
  return service;
}

function makeRuntime(root, obsidian, overrides = {}) {
  const sealPath = overrides.sealPath ?? path.join(root, "..", `${path.basename(root)}-seals.sqlite`);
  let seals;
  return {
    settings: {
      defaultMode: "advise",
      minimumMode: "off",
      names: ["AGENTS.md"],
      vaultId: "test-vault",
      ...overrides.settings,
    },
    source:
      overrides.source ??
      core.restInstructionsSource(
        (vaultPath) => obsidian.getFileContent(vaultPath, "markdown"),
        (error) => error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND,
      ),
    ledger: overrides.ledger ?? new core.VaultInstructionsReadLedger(),
    seals: () => (seals ??= new VaultInstructionsSealJournal(sealPath)),
    assetFolder: "Assets/Imported",
    resolveOperonTaskPath: overrides.resolveOperonTaskPath ?? (async (id) => (id === "abc1234" ? "Projects/Client/Tasks.md" : undefined)),
    probeOptions: { probeTimeoutMs: 1_000 },
    closeSeals: () => seals?.close(),
  };
}

const counts = new Map();
function bump(name) {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}
function count(name) {
  return counts.get(name) ?? 0;
}
function receipt(value, indented = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, indented ? 2 : undefined) }], isError: false };
}

function registerFakeWriteTools(server) {
  const text = z.string();
  server.registerTool(
    "obsidian_text_patch_plan",
    { inputSchema: mcpSchema({ path: text, idempotencyKey: text, responseMode: z.enum(["compact", "detailed"]).optional() }) },
    async (params) => {
      bump("obsidian_text_patch_plan");
      return receipt(
        { responseMode: params.responseMode ?? "compact", planRef: `plan:${params.idempotencyKey}`, planDigest: "d".repeat(64), phase: "planned", target: params.path },
        params.responseMode === "detailed",
      );
    },
  );
  server.registerTool(
    "obsidian_text_patch_apply",
    { inputSchema: mcpSchema({ planRef: text, idempotencyKey: text }) },
    async (params) => {
      bump("obsidian_text_patch_apply");
      return receipt({ planRef: params.planRef, planDigest: "d".repeat(64), phase: "committed", outcome: "committed" });
    },
  );
  server.registerTool(
    "obsidian_text_patch_recover",
    { inputSchema: mcpSchema({ planRef: text, idempotencyKey: text }) },
    async (params) => {
      bump("obsidian_text_patch_recover");
      return receipt({ planRef: params.planRef, phase: "committed" });
    },
  );
  server.registerTool(
    "obsidian_text_patch_status",
    { inputSchema: mcpSchema({ planRef: text }) },
    async (params) => {
      bump("obsidian_text_patch_status");
      return receipt({ planRef: params.planRef, phase: "planned" });
    },
  );
  server.registerTool(
    "obsidian_note_move_plan",
    { inputSchema: mcpSchema({ sourcePath: text, destinationPath: text, idempotencyKey: text }) },
    async (params) => {
      bump("obsidian_note_move_plan");
      return receipt({ planRef: `move:${params.idempotencyKey}`, planDigest: "e".repeat(64), phase: "planned" });
    },
  );
  server.registerTool(
    "obsidian_update_note",
    { inputSchema: mcpSchema({ targetType: z.enum(["filePath", "activeFile"]), targetIdentifier: text.optional(), content: text }) },
    async () => {
      bump("obsidian_update_note");
      return receipt({ success: true });
    },
  );
  server.registerTool(
    "obsidian_manage_frontmatter",
    { inputSchema: mcpSchema({ filePath: text, operation: z.enum(["get", "set", "delete"]), key: text }) },
    async () => {
      bump("obsidian_manage_frontmatter");
      return receipt({ value: 1 });
    },
  );
  server.registerTool(
    "operon_update_task",
    { inputSchema: mcpSchema({ operonId: text, expectedRevision: text, idempotencyKey: text, dryRun: z.boolean().optional() }) },
    async () => {
      bump("operon_update_task");
      return receipt({ ok: true, dryRun: true });
    },
  );
  server.registerTool(
    "operon_create_periodic_task",
    { inputSchema: mcpSchema({ idempotencyKey: text }) },
    async () => {
      bump("operon_create_periodic_task");
      return receipt({ ok: true });
    },
  );
  server.registerTool(
    "asset_import_plan",
    { inputSchema: mcpSchema({ idempotencyKey: text }) },
    async (params) => {
      bump("asset_import_plan");
      return receipt({ planRef: `asset:${params.idempotencyKey}`, planDigest: "f".repeat(64), phase: "planned" });
    },
  );
  server.registerTool(
    "bases_upsert_rows",
    { inputSchema: mcpSchema({ operations: z.array(z.object({ file: text })) }) },
    async () => {
      bump("bases_upsert_rows");
      return receipt({ ok: true });
    },
  );
}

async function connect(runtime, obsidian, { gateInstalled = true, instructions } = {}) {
  const server = new McpServer({ name: "vault-instructions-test", version: "0" }, { capabilities: {}, ...(instructions ? { instructions } : {}) });
  installMcpToolPublicErrorBoundary(server);
  if (gateInstalled) gate.installVaultInstructionsGate(server, runtime);
  await registerObsidianReadNoteTool(server, obsidian, undefined);
  registerFakeWriteTools(server);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "vault-instructions-client", version: "0" });
  await client.connect(clientTransport);
  return {
    client,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content?.[0]?.text;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { result, json, text };
    },
    read(filePath) {
      return client.callTool({ name: "obsidian_read_note", arguments: { filePath } });
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const ROOT_RULES = "# Rules\nAlways ask before writing.\n";
const LOCAL_RULES = "# Projects\nNever rename a project note.\n";
const CLIENT_RULES = "# Client\nClient notes are read-only on Fridays.\n";

// ---------------------------------------------------------------------------
// Pure helpers

await check("mode and file name parsing", () => {
  assert.deepEqual(names.parseVaultInstructionFileNames("AGENTS.md"), ["AGENTS.md"]);
  assert.deepEqual(names.parseVaultInstructionFileNames(" AGENTS.md , CLAUDE.md,AGENTS.md "), ["AGENTS.md", "CLAUDE.md"]);
  for (const invalid of ["", " , ", "a/AGENTS.md", "..", "x\\y", "a:b", "1,2,3,4,5,6,7,8,9"]) {
    assert.equal(names.parseVaultInstructionFileNames(invalid), undefined, invalid);
  }
  assert.equal(names.stricterVaultInstructionsMode("off", "enforce"), "enforce");
  assert.equal(names.stricterVaultInstructionsMode("advise", "off"), "advise");
  assert.equal(names.parseVaultInstructionsMode("ENFORCE"), undefined);
});

await check("vault paths and the folder chain", () => {
  assert.equal(core.normalizeVaultPath("./Projects\\Client//Note.md"), "Projects/Client/Note.md");
  assert.equal(core.normalizeVaultPath("/Projects/Note.md"), "Projects/Note.md");
  assert.equal(core.normalizeVaultPath("Projects/../Secret.md"), undefined);
  assert.equal(core.normalizeVaultPath("C:/Vault/Note.md"), undefined);
  // The exact spelling is kept (the backend writes it); every form is checked.
  assert.equal(core.normalizeVaultPath("Proje\u0301ts/Note.md"), "Proje\u0301ts/Note.md");
  assert.deepEqual(core.vaultPathAliases("Proje\u0301ts/Note.md"), ["Proje\u0301ts/Note.md", "Proj\u00e9ts/Note.md"]);
  assert.deepEqual(core.vaultPathAliases("Plain/Note.md"), ["Plain/Note.md"]);
  assert.deepEqual(core.instructionFolders("Projects/Client/Note.md"), ["", "Projects", "Projects/Client"]);
  assert.deepEqual(core.instructionFolders("Note.md"), [""]);
  assert.deepEqual(core.instructionFolders("Assets/Imported", true), ["", "Assets", "Assets/Imported"]);
  assert.equal(core.instructionContentSha256("a\r\nb\n"), core.instructionContentSha256("\uFEFFa\nb\n"));
});

await check("read ledger is bounded and expires idle readers", () => {
  let now = 0;
  const ledger = new core.VaultInstructionsReadLedger({ maxReaders: 2, maxPathsPerReader: 2, idleMs: 10, now: () => now });
  ledger.record("a", "AGENTS.md", "1");
  ledger.record("b", "AGENTS.md", "2");
  ledger.record("c", "AGENTS.md", "3");
  assert.equal(ledger.proof("a", "AGENTS.md"), undefined, "least recent reader evicted");
  assert.equal(ledger.proof("c", "AGENTS.md"), "3");
  ledger.record("c", "x/AGENTS.md", "4");
  ledger.record("c", "y/AGENTS.md", "5");
  assert.equal(ledger.proof("c", "AGENTS.md"), undefined, "oldest proof of a reader evicted");
  now = 100;
  assert.equal(ledger.proof("c", "y/AGENTS.md"), undefined, "idle reader expired");
});

// ---------------------------------------------------------------------------
// Vault without instruction files: identical behaviour in every mode.

await check("no AGENTS.md: results identical to a server without the gate, in every mode", async () => {
  const root = makeVault({ "Projects/Client/Note.md": "hello\n" });
  const obsidian = fakeObsidian(root);
  const plain = await connect(undefined, obsidian, { gateInstalled: false });
  const baseline = await plain.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "k1" });
  const baselineDirect = await plain.call("obsidian_update_note", { targetType: "filePath", targetIdentifier: "Projects/Client/Note.md", content: "x" });
  await plain.close();
  for (const mode of ["off", "advise", "enforce"]) {
    const runtime = makeRuntime(root, obsidian, { settings: { defaultMode: mode } });
    assert.equal(await gate.vaultInstructionsServerText(runtime), undefined, `${mode}: no server instructions`);
    const session = await connect(runtime, obsidian);
    const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "k1" });
    assert.deepEqual(planned.result, baseline.result, `${mode}: plan result unchanged`);
    const applied = await session.call("obsidian_text_patch_apply", { planRef: "plan:k1", idempotencyKey: "k1" });
    assert.equal(applied.result.isError, false, `${mode}: apply of a plan with no instruction file runs`);
    assert.equal(applied.json.vaultInstructions, undefined);
    const direct = await session.call("obsidian_update_note", { targetType: "filePath", targetIdentifier: "Projects/Client/Note.md", content: "x" });
    assert.deepEqual(direct.result, baselineDirect.result, `${mode}: direct write unchanged`);
    await session.close();
    runtime.closeSeals();
  }
});

// ---------------------------------------------------------------------------
// Vault with a cascade.

function cascadeVault() {
  return makeVault({
    "AGENTS.md": ROOT_RULES,
    "Projects/AGENTS.md": LOCAL_RULES,
    "Projects/Client/AGENTS.md": CLIENT_RULES,
    "Projects/Client/Note.md": "hello\n",
    "Other/Note.md": "other\n",
  });
}

await check("off: transparent even when the vault has AGENTS.md", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian, { settings: { defaultMode: "off" } });
  assert.equal(await gate.vaultInstructionsServerText(runtime), undefined);
  const plain = await connect(undefined, obsidian, { gateInstalled: false });
  const baseline = await plain.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "k" });
  await plain.close();
  const session = await connect(runtime, obsidian);
  const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "k" });
  assert.deepEqual(planned.result, baseline.result);
  const applied = await session.call("obsidian_text_patch_apply", { planRef: "plan:unknown", idempotencyKey: "k" });
  assert.equal(applied.result.isError, false, "off never refuses an unsealed apply");
  await session.close();
  runtime.closeSeals();
});

await check("server instructions point to the files, never embed them", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const advise = await gate.vaultInstructionsServerText(makeRuntime(root, obsidian));
  assert.match(advise, /AGENTS\.md/u);
  assert.match(advise, /obsidian_read_note/u);
  assert.match(advise, /parent folder/u);
  assert.doesNotMatch(advise, /Always ask before writing/u, "content is never embedded");
  assert.doesNotMatch(advise, /refused/u);
  const enforceRuntime = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" } });
  const enforce = await gate.vaultInstructionsServerText(enforceRuntime);
  assert.match(enforce, /vault_instructions_unread/u);
  const session = await connect(enforceRuntime, obsidian, { instructions: enforce });
  assert.equal(session.client.getInstructions(), enforce, "instructions reach the client at initialize");
  await session.close();
  const local = makeVault({ "Projects/AGENTS.md": LOCAL_RULES });
  assert.equal(await gate.vaultInstructionsServerText(makeRuntime(local, fakeObsidian(local))), undefined, "no root file, no instructions");
});

await check("advise: every plan lists the cascade and never blocks", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian);
  const session = await connect(runtime, obsidian);
  const before = count("obsidian_text_patch_plan");
  const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "adv" });
  assert.equal(planned.result.isError, false);
  assert.equal(count("obsidian_text_patch_plan"), before + 1, "advise never blocks");
  const info = planned.json.vaultInstructions;
  assert.equal(info.mode, "advise");
  assert.equal(info.readerScope, "process");
  assert.equal(info.complete, false);
  assert.deepEqual(info.files.map((entry) => [entry.path, entry.state]), [
    ["AGENTS.md", "unread"],
    ["Projects/AGENTS.md", "unread"],
    ["Projects/Client/AGENTS.md", "unread"],
  ]);
  assert.deepEqual(info.targets, [{ path: "Projects/Client/Note.md", rules: ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"] }]);
  assert.deepEqual(info.nextActions[1], { tool: "obsidian_read_note", arguments: { filePath: "Projects/AGENTS.md" } });
  assert.match(info.message, /obsidian_read_note/u);
  assert.equal(planned.json.planRef, "plan:adv", "the receipt itself is preserved");
  assert.ok(!planned.text.includes("\n"), "compact receipts stay compact");
  const detailed = await session.call("obsidian_text_patch_plan", { path: "Other/Note.md", idempotencyKey: "adv2", responseMode: "detailed" });
  assert.ok(detailed.text.startsWith("{\n"), "detailed receipts keep their indentation");
  assert.deepEqual(detailed.json.vaultInstructions.files.map((entry) => entry.path), ["AGENTS.md"], "only the chain of the target");
  for (const filePath of ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"]) {
    const read = await session.read(filePath);
    assert.equal(read.isError, false);
  }
  const again = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "adv3" });
  assert.equal(again.json.vaultInstructions.complete, true);
  assert.equal(again.json.vaultInstructions.message, undefined);
  assert.equal(again.json.vaultInstructions.nextActions, undefined);
  assert.equal(again.json.vaultInstructions.sealed, true);
  await session.close();
  runtime.closeSeals();
});

await check("enforce: an ignored local rule refuses the plan before it runs", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" } });
  const session = await connect(runtime, obsidian);
  await session.read("AGENTS.md");
  const before = count("obsidian_text_patch_plan");
  const refused = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "enf" });
  assert.equal(refused.result.isError, true);
  assert.equal(count("obsidian_text_patch_plan"), before, "the plan tool never ran");
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, "FORBIDDEN");
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_unread");
  assert.equal(refused.json.error.details.retryable, true);
  assert.match(refused.json.error.message, /obsidian_read_note/u);
  assert.match(refused.json.error.message, /obsidian_text_patch_plan again with the same arguments/u);
  assert.deepEqual(refused.json.vaultInstructions.files.map((entry) => [entry.path, entry.state]), [
    ["AGENTS.md", "read"],
    ["Projects/AGENTS.md", "unread"],
    ["Projects/Client/AGENTS.md", "unread"],
  ]);
  assert.deepEqual(refused.json.vaultInstructions.nextActions, [
    { tool: "obsidian_read_note", arguments: { filePath: "Projects/AGENTS.md" } },
    { tool: "obsidian_read_note", arguments: { filePath: "Projects/Client/AGENTS.md" } },
  ]);
  // A file of another folder never satisfies this chain.
  const other = await session.call("obsidian_text_patch_plan", { path: "Other/Note.md", idempotencyKey: "enf-other" });
  assert.equal(other.result.isError, false, "Other/ only needs the root file, already read");
  await session.read("Projects/AGENTS.md");
  await session.read("Projects/Client/AGENTS.md");
  const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "enf" });
  assert.equal(planned.result.isError, false);
  assert.equal(planned.json.vaultInstructions.complete, true);
  assert.equal(planned.json.vaultInstructions.mode, "enforce");
  await session.close();
  runtime.closeSeals();
});

await check("enforce: a rule modified during the session needs a new read", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" } });
  const session = await connect(runtime, obsidian);
  for (const filePath of ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"]) await session.read(filePath);
  const first = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "m1" });
  assert.equal(first.result.isError, false);
  write(root, "Projects/AGENTS.md", `${LOCAL_RULES}New: tag every project note.\n`);
  const refused = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "m2" });
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_unread");
  assert.deepEqual(
    refused.json.vaultInstructions.files.filter((entry) => entry.state !== "read").map((entry) => [entry.path, entry.state]),
    [["Projects/AGENTS.md", "changed"]],
  );
  // Line endings alone are not a change of rules.
  write(root, "AGENTS.md", ROOT_RULES.replace(/\n/gu, "\r\n"));
  await session.read("Projects/AGENTS.md");
  const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "m2" });
  assert.equal(planned.result.isError, false);
  await session.close();
  runtime.closeSeals();
});

await check("enforce: rules changed between plan and apply refuse the apply, status first", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" } });
  const session = await connect(runtime, obsidian);
  for (const filePath of ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"]) await session.read(filePath);
  const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "p1" });
  assert.equal(planned.result.isError, false);
  write(root, "Projects/Client/AGENTS.md", `${CLIENT_RULES}Changed.\n`);
  write(root, "Projects/Client/CLAUDE.md", "ignored: not a configured name\n");
  const before = count("obsidian_text_patch_apply");
  const refused = await session.call("obsidian_text_patch_apply", { planRef: "plan:p1", idempotencyKey: "p1" });
  assert.equal(refused.result.isError, true);
  assert.equal(count("obsidian_text_patch_apply"), before, "apply never ran");
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_changed_since_plan");
  const message = refused.json.error.message;
  assert.ok(message.indexOf("obsidian_text_patch_status") < message.indexOf("plan again"), "status comes first");
  assert.match(message, /Only if it reports phase planned/u);
  assert.match(message, /do not plan it again/u);
  assert.deepEqual(refused.json.vaultInstructions.files.map((entry) => [entry.path, entry.state]), [["Projects/Client/AGENTS.md", "changed"]]);
  assert.deepEqual(refused.json.vaultInstructions.nextActions[0], { tool: "obsidian_text_patch_status", arguments: { planRef: "plan:p1" } });
  // Re-reading alone does not re-evaluate the sealed plan.
  await session.read("Projects/Client/AGENTS.md");
  const stillRefused = await session.call("obsidian_text_patch_apply", { planRef: "plan:p1", idempotencyKey: "p1" });
  assert.equal(stillRefused.json.error.details.reasonCode, "vault_instructions_changed_since_plan");
  // Planning again (same intent, same key) re-seals the plan under the new rules.
  const replanned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "p1" });
  assert.equal(replanned.result.isError, false);
  const applied = await session.call("obsidian_text_patch_apply", { planRef: "plan:p1", idempotencyKey: "p1" });
  assert.equal(applied.result.isError, false);
  assert.equal(count("obsidian_text_patch_apply"), before + 1);
  // A removed file is reported as removed, with nothing to read.
  const planned2 = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "p2" });
  assert.equal(planned2.result.isError, false);
  unlinkSync(path.join(root, "Projects", "AGENTS.md"));
  const removed = await session.call("obsidian_text_patch_recover", { planRef: "plan:p2", idempotencyKey: "p2" });
  assert.equal(removed.json.error.details.reasonCode, "vault_instructions_changed_since_plan");
  assert.deepEqual(removed.json.vaultInstructions.files, [{ path: "Projects/AGENTS.md", state: "removed" }]);
  assert.deepEqual(removed.json.vaultInstructions.nextActions, [{ tool: "obsidian_text_patch_status", arguments: { planRef: "plan:p2" } }]);
  // Status is never gated.
  const status = await session.call("obsidian_text_patch_status", { planRef: "plan:p2" });
  assert.equal(status.result.isError, false);
  await session.close();
  runtime.closeSeals();
});

await check("seals survive a restart; read proofs do not", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const sealPath = path.join(tempRoot, "restart-seals.sqlite");
  const first = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" }, sealPath });
  const session = await connect(first, obsidian);
  for (const filePath of ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"]) await session.read(filePath);
  const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Client/Note.md", idempotencyKey: "r1" });
  assert.equal(planned.result.isError, false);
  await session.close();
  first.closeSeals();
  const second = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" }, sealPath });
  const restarted = await connect(second, obsidian);
  const refused = await restarted.call("obsidian_text_patch_apply", { planRef: "plan:r1", idempotencyKey: "r1" });
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_unread", "seal found, proofs lost");
  assert.match(refused.json.error.message, /Nothing was applied by this call/u);
  for (const filePath of ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"]) await restarted.read(filePath);
  const applied = await restarted.call("obsidian_text_patch_apply", { planRef: "plan:r1", idempotencyKey: "r1" });
  assert.equal(applied.result.isError, false);
  await restarted.close();
  second.closeSeals();
});

await check("enforce: an unsealed plan is refused; advise lets it run", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const enforce = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" } });
  const session = await connect(enforce, obsidian);
  const before = count("obsidian_text_patch_apply");
  const refused = await session.call("obsidian_text_patch_apply", { planRef: "plan:never-sealed", idempotencyKey: "x" });
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_plan_unsealed");
  assert.match(refused.json.error.message, /First call obsidian_text_patch_status/u);
  assert.equal(count("obsidian_text_patch_apply"), before);
  await session.close();
  enforce.closeSeals();
  const advise = makeRuntime(root, obsidian);
  const adviseSession = await connect(advise, obsidian);
  const applied = await adviseSession.call("obsidian_text_patch_apply", { planRef: "plan:never-sealed", idempotencyKey: "x" });
  assert.equal(applied.result.isError, false);
  await adviseSession.close();
  advise.closeSeals();
});

await check("a stale or mismatched read records no proof", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" } });
  const session = await connect(runtime, obsidian);
  obsidian.stale = "# Rules\nan old cached copy\n";
  await session.read("AGENTS.md");
  const refused = await session.call("obsidian_text_patch_plan", { path: "Other/Note.md", idempotencyKey: "s" });
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_unread");
  // A differently cased request is not the canonical file of the chain.
  await session.read("agents.md").catch(() => undefined);
  const stillRefused = await session.call("obsidian_text_patch_plan", { path: "Other/Note.md", idempotencyKey: "s" });
  assert.equal(stillRefused.json.error.details.reasonCode, "vault_instructions_unread");
  await session.read("AGENTS.md");
  const planned = await session.call("obsidian_text_patch_plan", { path: "Other/Note.md", idempotencyKey: "s" });
  assert.equal(planned.result.isError, false);
  await session.close();
  runtime.closeSeals();
});

await check("targets: move, batch rows, assets, Operon and read-only operations", async () => {
  const root = cascadeVault();
  write(root, "Assets/AGENTS.md", "# Assets\n");
  write(root, "Archive/AGENTS.md", "# Archive\n");
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian);
  const session = await connect(runtime, obsidian);
  const moved = await session.call("obsidian_note_move_plan", { sourcePath: "Projects/Client/Note.md", destinationPath: "Archive/Note.md", idempotencyKey: "mv" });
  assert.deepEqual(moved.json.vaultInstructions.files.map((entry) => entry.path), ["AGENTS.md", "Archive/AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"]);
  assert.deepEqual(moved.json.vaultInstructions.targets.map((target) => target.path), ["Projects/Client/Note.md", "Archive/Note.md"]);
  const rows = await session.call("bases_upsert_rows", { operations: [{ file: "Other/Note.md" }, { file: "Projects/Client/Note.md" }] });
  assert.equal(rows.json.vaultInstructions.files.length, 3);
  const asset = await session.call("asset_import_plan", { idempotencyKey: "a" });
  assert.deepEqual(asset.json.vaultInstructions.files.map((entry) => entry.path), ["AGENTS.md", "Assets/AGENTS.md"]);
  const operon = await session.call("operon_update_task", { operonId: "abc1234", expectedRevision: "r", idempotencyKey: "o" });
  assert.deepEqual(operon.json.vaultInstructions.targets, [{ path: "Projects/Client/Tasks.md", rules: ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"] }]);
  const get = await session.call("obsidian_manage_frontmatter", { filePath: "Projects/Client/Note.md", operation: "get", key: "a" });
  assert.equal(get.json.vaultInstructions, undefined, "reads are never gated or annotated");
  const set = await session.call("obsidian_manage_frontmatter", { filePath: "Projects/Client/Note.md", operation: "set", key: "a" });
  assert.equal(set.json.vaultInstructions.files.length, 3);
  await session.close();
  runtime.closeSeals();
});

await check("unresolved targets: advise lists the root, enforce refuses with the explicit form", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const advise = makeRuntime(root, obsidian);
  const session = await connect(advise, obsidian);
  const active = await session.call("obsidian_update_note", { targetType: "activeFile", content: "x" });
  assert.equal(active.result.isError, false);
  assert.equal(active.json.vaultInstructions.targetResolved, false);
  assert.deepEqual(active.json.vaultInstructions.files.map((entry) => entry.path), ["AGENTS.md"]);
  assert.match(active.json.vaultInstructions.message, /targetType "filePath"/u);
  await session.close();
  advise.closeSeals();
  const enforce = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" } });
  const enforced = await connect(enforce, obsidian);
  for (const filePath of ["AGENTS.md", "Projects/AGENTS.md", "Projects/Client/AGENTS.md"]) await enforced.read(filePath);
  const before = count("obsidian_update_note");
  const refused = await enforced.call("obsidian_update_note", { targetType: "activeFile", content: "x" });
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_target_unresolved");
  assert.equal(refused.json.error.details.retryable, false);
  assert.equal(refused.json.vaultInstructions.files, undefined, "no invented file");
  assert.equal(refused.json.vaultInstructions.nextActions, undefined, "no read proposed");
  assert.match(refused.json.error.message, /targetIdentifier/u);
  assert.equal(count("obsidian_update_note"), before);
  const periodic = await enforced.call("operon_create_periodic_task", { idempotencyKey: "p" });
  assert.equal(periodic.json.error.details.reasonCode, "vault_instructions_target_unresolved");
  assert.match(periodic.json.error.message, /lower MCP_VAULT_INSTRUCTIONS/u);
  const unknownTask = await enforced.call("operon_update_task", { operonId: "zzzzzzz", expectedRevision: "r", idempotencyKey: "o" });
  assert.equal(unknownTask.json.error.details.reasonCode, "vault_instructions_target_unresolved");
  const resolved = await enforced.call("operon_update_task", { operonId: "abc1234", expectedRevision: "r", idempotencyKey: "o" });
  assert.equal(resolved.result.isError, false);
  await enforced.close();
  enforce.closeSeals();
});

await check("unavailable instruction source: enforce refuses, advise marks it unverified", async () => {
  const root = cascadeVault();
  const obsidian = fakeObsidian(root);
  const failing = { kind: "rest", read: async () => { throw new core.VaultInstructionsUnavailableError("source_error"); } };
  const enforce = makeRuntime(root, obsidian, { settings: { defaultMode: "enforce" }, source: failing });
  const session = await connect(enforce, obsidian);
  const refused = await session.call("obsidian_text_patch_plan", { path: "Other/Note.md", idempotencyKey: "u" });
  assert.equal(refused.json.error.code, "SERVICE_UNAVAILABLE");
  assert.equal(refused.json.error.details.reasonCode, "vault_instructions_unavailable");
  assert.match(refused.json.error.message, /Retry the same call later/u);
  assert.equal(refused.json.vaultInstructions.files, undefined);
  await session.close();
  enforce.closeSeals();
  const hanging = { kind: "rest", read: () => new Promise(() => undefined) };
  const advise = makeRuntime(root, obsidian, { source: hanging });
  advise.probeOptions = { probeTimeoutMs: 50 };
  const adviseSession = await connect(advise, obsidian);
  const planned = await adviseSession.call("obsidian_text_patch_plan", { path: "Other/Note.md", idempotencyKey: "u" });
  assert.equal(planned.result.isError, false);
  assert.equal(planned.json.vaultInstructions.verified, false);
  await adviseSession.close();
  advise.closeSeals();
});

await check("several configured names: AGENTS.md and CLAUDE.md, root first", async () => {
  const root = makeVault({
    "AGENTS.md": ROOT_RULES,
    "CLAUDE.md": "# Claude\n",
    "Projects/CLAUDE.md": "# Projects Claude\n",
    "Projects/Note.md": "x\n",
  });
  const obsidian = fakeObsidian(root);
  const runtime = makeRuntime(root, obsidian, { settings: { names: ["AGENTS.md", "CLAUDE.md"], defaultMode: "enforce" } });
  const session = await connect(runtime, obsidian);
  const refused = await session.call("obsidian_text_patch_plan", { path: "Projects/Note.md", idempotencyKey: "n" });
  assert.deepEqual(refused.json.vaultInstructions.files.map((entry) => entry.path), ["AGENTS.md", "CLAUDE.md", "Projects/CLAUDE.md"]);
  for (const filePath of ["AGENTS.md", "CLAUDE.md", "Projects/CLAUDE.md"]) await session.read(filePath);
  const planned = await session.call("obsidian_text_patch_plan", { path: "Projects/Note.md", idempotencyKey: "n" });
  assert.equal(planned.result.isError, false);
  await session.close();
  runtime.closeSeals();
});

// ---------------------------------------------------------------------------
// Client mode, minimum and reader scope.

await check("client mode header, administrative minimum and reader scope", () => {
  const settings = { defaultMode: "advise", minimumMode: "off", names: ["AGENTS.md"], vaultId: "v" };
  const call = (headers, overrides = {}, ctx = {}) => {
    const request = new Request("http://127.0.0.1/mcp", { method: "POST", headers });
    const state = httpState.getHttpRequestState(request);
    state.identity = { key: "identity-key-1", pseudonym: "p", clientId: "c", issuer: "i", source: "claims" };
    return httpState.withActiveHttpRequestState(request, () =>
      gate.currentVaultInstructionsCall({ ...settings, ...overrides }, ctx),
    );
  };
  assert.equal(call({}).mode, "advise", "server default");
  assert.equal(call({ "X-Optimike-Vault-Instructions": "off" }).mode, "off", "a client may turn it off");
  assert.equal(call({ "X-Optimike-Vault-Instructions": "enforce" }).mode, "enforce");
  assert.equal(call({ "X-Optimike-Vault-Instructions": "bogus" }).mode, "advise", "invalid header ignored");
  assert.equal(call({ "X-Optimike-Vault-Instructions": "off" }, { minimumMode: "enforce" }).mode, "enforce", "minimum wins");
  assert.equal(call({ "X-Optimike-Vault-Instructions": "advise" }, { minimumMode: "enforce" }).mode, "enforce");
  assert.deepEqual(call({}, {}, { sessionId: "s-1" }).reader, { key: "session:s-1", scope: "session" });
  const context = "a".repeat(32);
  assert.deepEqual(call({ "X-Optimike-Reader-Context": context }).reader, {
    key: `identity:identity-key-1:reader:${context}`,
    scope: "reader-context",
  });
  assert.equal(call({ "X-Optimike-Reader-Context": "short" }).reader.scope, "identity", "invalid reader context ignored");
  assert.deepEqual(gate.currentVaultInstructionsCall(settings, {}).reader, { key: "process", scope: "process" }, "stdio reader");
  assert.equal(gate.currentVaultInstructionsCall({ ...settings, defaultMode: "off", minimumMode: "advise" }).mode, "advise");
});

await check("tool roles cover the governed families and leave status alone", () => {
  assert.deepEqual(gate.vaultInstructionsToolRole("bases_create"), { kind: "direct" });
  assert.deepEqual(gate.vaultInstructionsToolRole("bases_create_plan"), { kind: "plan", family: "bases_create" });
  assert.deepEqual(gate.vaultInstructionsToolRole("obsidian_canvas_patch_recover"), { kind: "apply", family: "obsidian_canvas_patch" });
  for (const name of ["obsidian_text_patch_status", "operon_recover_mutation", "obsidian_runtime_maintenance", "obsidian_operation_close", "obsidian_global_search", "external_move_plan"]) {
    assert.equal(gate.vaultInstructionsToolRole(name), undefined, name);
  }
});

await check("filesystem source stays inside the vault", async () => {
  const root = makeVault({ "AGENTS.md": ROOT_RULES, "Sub/AGENTS.md": LOCAL_RULES });
  const outside = path.join(tempRoot, "outside-AGENTS.md");
  writeFileSync(outside, "outside\n");
  const source = core.filesystemInstructionsSource(root);
  assert.equal(await source.read("AGENTS.md"), ROOT_RULES);
  assert.equal(await source.read("Missing/AGENTS.md"), null);
  assert.equal(await source.read("Sub"), null, "a folder is not a file");
  assert.equal(await source.read(`../${path.basename(outside)}`), null);
});

try {
  rmSync(tempRoot, { recursive: true, force: true });
} catch {
  // A temporary folder left behind is harmless.
}
console.log(`vault instructions tests passed (${passed} checks)`);
