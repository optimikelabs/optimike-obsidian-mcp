import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const initial = "\uFEFF---\r\nlabel: first\r\n---\r\n\r\nOriginal body.\r\n";
const excluded = "Archive/Old.md";
const templated = "Snippets/Starter.md";
const raced = "Archive/Race.md";
const dateSettings = {
  headerCreated: "created_at",
  headerUpdated: "updated_at",
  headerLastViewed: "viewed_at",
  enableAutoUpdate: true,
  enableCreateTime: true,
  enableModifiedTime: true,
  enableLastViewed: true,
  enableNumberProperties: false,
  dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
  timezone: "",
  filterRules: "# last match wins\nArchive/**\n!Archive/Keep.md",
  countUpdatesEnabled: false,
  postUpdateCommand: "",
  inversionFixStrategy: "disabled",
  minSecondsBetweenSaves: 30,
};
const time = Date.parse("2026-09-05T11:12:13Z");

async function crashAfterFilesystemEffect() {
  const [vault, state, ref, key] = process.argv.slice(3);
  const { FilesystemNoteBackend } = await import("../dist/services/operations/filesystemNoteBackend.js");
  const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
  const { ObsidianNoteReplaceOperationAdapter } = await import("../dist/services/operations/obsidianNoteReplaceOperationAdapter.js");
  const journal = new ObsidianNoteReplaceJournal(state);
  const backend = new FilesystemNoteBackend(vault, state, journal, () => time, () => process.exit(87));
  const adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal, undefined, { filesystem: backend });
  await adapter.apply(ref, key);
  process.exitCode = 1;
}

async function fixtures(vault) {
  const files = new Map([
    [".obsidian/community-plugins.json", JSON.stringify(["frontmatter-date-manager", "templater-obsidian"])],
    [".obsidian/plugins/frontmatter-date-manager/data.json", JSON.stringify(dateSettings)],
    [".obsidian/plugins/templater-obsidian/data.json", JSON.stringify({ templates_folder: "Snippets" })],
    ["AGENTS.md", "# Vault instructions\n\nUse a governed plan for every note write.\n"],
    ["Note.md", initial], [excluded, initial], [templated, initial],
    ["Archive/Keep.md", initial], [raced, initial], [".hidden.md", initial],
  ]);
  for (const [relative, content] of files) {
    const target = path.join(vault, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function checkDates() {
  const { readFilesystemDatePolicy, sealFilesystemDates } = await import("../dist/services/operations/filesystemDatePolicy.js");
  const policy = await readFilesystemDatePolicy(file => Promise.resolve({
    ".obsidian/community-plugins.json": JSON.stringify(["frontmatter-date-manager"]),
    ".obsidian/plugins/frontmatter-date-manager/data.json": JSON.stringify(dateSettings),
    ".obsidian/templates.json": JSON.stringify({ folder: "Core Templates" }),
  }[file]));
  assert.equal(policy.managed(excluded), false);
  assert.equal(policy.managed("Archive/Keep.md"), true);
  assert.equal(policy.managed("Core Templates/Thing.md"), false);
  assert.equal(policy.managed("X/Modèles/Thing.md"), false);
  const edited = sealFilesystemDates(policy, "Note.md", initial, time, { content: initial, birthtimeMs: time - 1000 });
  assert.match(edited, /^\uFEFF---\r\n/u);
  assert.doesNotMatch(edited, /(?<!\r)\n/u);
  assert.match(edited, /created_at: ["']?2026-09-05T11:12:12/u);
  assert.match(edited, /updated_at: ["']?2026-09-05T11:12:13/u);
}

async function integration() {
  const root = await mkdtemp(path.join(os.tmpdir(), "optimike-governed-fs-"));
  const vault = path.join(root, "vault");
  const state = path.join(root, "private", "governed.sqlite");
  const logsParent = path.join(process.cwd(), "logs");
  await mkdir(logsParent, { recursive: true });
  const logs = await mkdtemp(path.join(logsParent, "headless-governed-"));
  const liveClients = [];
  const env = {
    ...process.env,
    OBSIDIAN_VAULT: vault,
    OBSIDIAN_API_KEY: "",
    OBSIDIAN_BASE_URL: "http://127.0.0.1:1",
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_ENABLE_CACHE: "true",
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "private", "cache.sqlite"),
    MCP_HEADLESS_GOVERNED_JOURNAL_PATH: state,
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_WRITE_MODE: "full",
    MCP_VAULT_INSTRUCTIONS: "enforce",
    MCP_TOOL_PROFILE: "full",
    MCP_LOG_LEVEL: "error",
    SEMANTIC_SEARCH_PREWARM: "false",
    LOGS_DIR: logs,
    TZ: "UTC",
  };
  async function start(mode) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["dist/index.js"], env: { ...env, OBSIDIAN_RUNTIME_MODE: mode,
        MCP_WRITE_MODE: mode === "headless-guarded" ? "guarded" : "full" },
    });
    const client = new Client({ name: "governed-headless-fixture", version: "1" });
    liveClients.push(client);
    await client.connect(transport);
    return client;
  }
  async function call(client, name, args, error = false) {
    const result = await client.callTool({ name: "obsidian_" + name, arguments: args });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(Boolean(result.isError), error, `${name}: ${JSON.stringify(payload)}`);
    if (!error) assert.equal(payload.backend?.kind, "headless-filesystem", name);
    return payload;
  }
  const read = relative => readFile(path.join(vault, relative), "utf8");
  async function capability(client, id) {
    const result = await client.callTool({ name: "obsidian_runtime_status", arguments: {} });
    return JSON.parse(result.content[0].text).capabilityManifest.capabilities.find(entry => entry.id === id);
  }
  const patch = (path, idempotencyKey, replacement = "New body.") => ({
    path, idempotencyKey, operations: [{ op: "replace_literal", search: "Original body.", replacement }],
  });
  const expectVerified = (receipt) => {
    assert.equal(receipt.outcome, "committed");
    assert.equal(receipt.postflight.status ?? receipt.postflight, "verified");
  };
  try {
    await fixtures(vault);
    const guarded = await start("headless-guarded");
    const first = await start("headless-filesystem");
    const second = await start("headless-filesystem");
    const unread = await call(guarded, "text_patch_plan", patch(raced, "instructions-unread"), true);
    assert.match(unread.error.details.reasonCode, /^vault_instructions_/u);
    for (const client of [guarded, first, second]) {
      const instructions = await client.callTool({
        name: "obsidian_read_note", arguments: { filePath: "AGENTS.md" },
      });
      assert.equal(Boolean(instructions.isError), false);
      assert.match(instructions.content[0].text, /Use a governed plan for every note write/u);
    }
    const write = await capability(guarded, "governed-note-write");
    assert.equal(write.state, "ready");
    assert.ok(write.preferredTools.includes("obsidian_text_patch_plan"));
    assert.ok(!write.preferredTools.includes("obsidian_note_replace_plan"));

    // Both plans read the same BOM+CRLF snapshot, then two independent
    // server processes race to publish exactly the same bytes.
    const plan1 = await call(guarded, "text_patch_plan", patch(raced, "race-a"));
    const plan2 = await call(first, "text_patch_plan", patch(raced, "race-b"));
    assert.equal(await read(raced), initial);
    assert.equal((await call(first, "list_pending_operations", {})).operations.some(row => row.planRef === plan1.planRef), true);
    const results = await Promise.all([
      call(guarded, "text_patch_apply", { planRef: plan1.planRef, idempotencyKey: "race-a" }),
      call(first, "text_patch_apply", { planRef: plan2.planRef, idempotencyKey: "race-b" }),
    ]);
    assert.deepEqual(results.map(row => row.outcome).sort(), ["committed", "conflict"]);
    const winner = results.find(row => row.outcome === "committed");
    const winnerKey = winner.planRef === plan1.planRef ? "race-a" : "race-b";
    expectVerified(await call(second, "text_patch_status", { planRef: winner.planRef }));
    expectVerified(await call(winnerKey === "race-a" ? guarded : first, "text_patch_recover", { planRef: winner.planRef, idempotencyKey: winnerKey }));
    const updated = await read(raced);
    assert.match(updated, /^\uFEFF---\r\nlabel: first\r\n/u);
    assert.doesNotMatch(updated, /(?<!\r)\n/u);
    assert.match(updated, /New body\./u);

    const revert = await call(first, "operation_revert_plan", { path: raced, operationRef: winner.planRef, idempotencyKey: "undo-a" });
    expectVerified(await call(first, "operation_revert_apply", { planRef: revert.planRef, idempotencyKey: "undo-a" }));
    expectVerified(await call(second, "operation_revert_status", { planRef: revert.planRef }));
    expectVerified(await call(first, "operation_revert_recover", { planRef: revert.planRef, idempotencyKey: "undo-a" }));
    assert.equal(await read(raced), initial);

    for (const [relative, property] of [[excluded, false], [templated, false], ["Archive/Keep.md", true]]) {
      const plan = await call(guarded, "frontmatter_patch_plan", { path: relative, idempotencyKey: relative,
        operations: [{ op: "set", key: "label", value: "different" }] });
      expectVerified(await call(guarded, "frontmatter_patch_apply", { planRef: plan.planRef, idempotencyKey: relative }));
      expectVerified(await call(guarded, "frontmatter_patch_status", { planRef: plan.planRef }));
      expectVerified(await call(guarded, "frontmatter_patch_recover", { planRef: plan.planRef, idempotencyKey: relative }));
      assert.equal((await read(relative)).includes("updated_at:"), property);
    }
    for (const relative of ["../escaped.md", ".hidden.md"]) await call(first, "text_patch_plan", patch(relative, relative), true);
    await call(guarded, "frontmatter_patch_plan", { path: "Note.md", idempotencyKey: "forge-date",
      operations: [{ op: "set", key: "updated_at", value: "false" }] }, true);

    const create = await call(guarded, "note_create_plan", { path: "Created.md", content: "\uFEFFNew note.\r\n", idempotencyKey: "create" });
    expectVerified(await call(guarded, "note_create_apply", { planRef: create.planRef, idempotencyKey: "create" }));
    expectVerified(await call(first, "note_create_status", { planRef: create.planRef }));
    assert.match(await read("Created.md"), /^\uFEFF---\r\ncreated_at: /u);
    const remove = await call(first, "operation_revert_plan", { path: "Created.md", operationRef: create.planRef, idempotencyKey: "remove" });
    expectVerified(await call(first, "operation_revert_apply", { planRef: remove.planRef, idempotencyKey: "remove" }));
    await assert.rejects(read("Created.md"), { code: "ENOENT" });

    const plan = await call(first, "note_replace_plan", { path: "Note.md", nextContent: (await read("Note.md")).replace("Original body.", "Before crash."),
      idempotencyKey: "crash" });
    const child = fork(new URL(import.meta.url), ["crash-after-effect", vault, state, plan.planRef, "crash"],
      { env: { ...env, OBSIDIAN_RUNTIME_MODE: "headless-filesystem" }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    assert.deepEqual(await once(child, "exit"), [87, null]);
    assert.match(await read("Note.md"), /Before crash\./u);
    assert.match(await read("Note.md"), /updated_at: ["']?2026-09-05T11:12:13/u);
    expectVerified(await call(second, "note_replace_status", { planRef: plan.planRef }));
    expectVerified(await call(first, "note_replace_recover", { planRef: plan.planRef, idempotencyKey: "crash" }));

    const stale = await call(first, "note_replace_plan", { path: "Note.md", nextContent: (await read("Note.md")).replace("Before crash.", "Edit from plan."),
      idempotencyKey: "stale" });
    const staleRevert = await call(first, "operation_revert_plan", { path: "Note.md", operationRef: plan.planRef, idempotencyKey: "stale-revert-apply" });
    const phone = (await read("Note.md")).replace("Before crash.", "Phone update.");
    await writeFile(path.join(vault, "Note.md"), phone);
    assert.equal((await call(first, "note_replace_apply", { planRef: stale.planRef, idempotencyKey: "stale" })).outcome, "conflict");
    assert.equal((await call(first, "operation_revert_apply", { planRef: staleRevert.planRef, idempotencyKey: "stale-revert-apply" })).outcome, "conflict");
    assert.equal(await read("Note.md"), phone);
    await call(first, "operation_revert_plan", { path: "Note.md", operationRef: plan.planRef, idempotencyKey: "stale-revert" }, true);

    const settingsPath = path.join(vault, ".obsidian/plugins/frontmatter-date-manager/data.json");
    const policyDrift = await call(first, "note_replace_plan", {
      path: "Note.md", nextContent: phone.replace("Phone update.", "Update under changed policy."), idempotencyKey: "policy-drift",
    });
    await writeFile(settingsPath, JSON.stringify({ ...dateSettings, dateFormat: "yyyy-MM-dd'T'HH:mm" }));
    assert.equal((await call(first, "note_replace_apply", { planRef: policyDrift.planRef, idempotencyKey: "policy-drift" })).outcome, "conflict");
    assert.equal(await read("Note.md"), phone);
    await writeFile(settingsPath, "{}");
    assert.equal((await capability(guarded, "governed-note-write")).reasonCode, "headless_date_policy_unavailable");
    const refusal = await call(first, "text_patch_plan", { ...patch("Note.md", "ambiguous"),
      operations: [{ op: "append_body", text: "\nAnother paragraph.\n" }] }, true);
    assert.equal(refusal.error.details.reasonCode, "headless_date_policy_unavailable");
  } finally {
    await Promise.all(liveClients.map(client => client.close()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    await rm(logs, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[2] === "crash-after-effect") await crashAfterFilesystemEffect();
else {
  process.env.TZ = "UTC";
  await checkDates();
  await integration();
  console.log("PASS: headless governed lifecycles, cross-process CAS, crash observation, revert, and date policy");
}
