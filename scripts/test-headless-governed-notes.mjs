import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { renameSync, writeFileSync } from "node:fs";
import fsp, { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const initial = "\uFEFF---\r\nlabel: first\r\n---\r\n\r\nOriginal body.\r\n";
const excluded = "Archive/Old.md";
const templated = "Snippets/Starter.md";
const raced = "Archive/Race.md";
const postflightRace = "Archive/Postflight.md";
const interrupted = "Archive/Interrupted.md";
const createCrash = "Archive/InterruptedCreate.md";
const published = initial.replace("Original body.", "Published by the plan.");
const interference = initial.replace("Original body.", "Synced by another writer.");
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
  hashTrackingMode: "both",
};
const time = Date.parse("2026-09-05T11:12:13Z");

async function injectAfterFilesystemEffect() {
  const [mode, vault, state, ref, key] = process.argv.slice(2);
  const { FilesystemNoteBackend } = await import("../dist/services/operations/filesystemNoteBackend.js");
  const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
  const { ObsidianNoteReplaceOperationAdapter } = await import("../dist/services/operations/obsidianNoteReplaceOperationAdapter.js");
  const { NoteCreateOperationAdapter } = await import("../dist/services/operations/noteCreateOperationAdapter.js");
  const { FilesystemRevert } = await import("../dist/services/operations/filesystemRevert.js");
  const journal = new ObsidianNoteReplaceJournal(state);
  if (mode === "crash-before-displacement") {
    const record = journal.recordFilesystemStage.bind(journal);
    journal.recordFilesystemStage = (...args) => { record(...args); process.exit(88); };
  }
  let renameAttempts = 0;
  const originalRename = fsp.rename;
  if (["crash-after-displacement", "edit-at-displacement", "blocked-displacement"].includes(mode)) {
    fsp.rename = async (source, destination) => {
      if (!String(destination).endsWith(".bak")) return originalRename(source, destination);
      if (mode === "edit-at-displacement") writeFileSync(source, interference);
      if (mode === "blocked-displacement") {
        renameAttempts += 1;
        throw Object.assign(new Error("Synthetic sharing violation"), { code: "EPERM" });
      }
      await originalRename(source, destination);
      if (mode === "crash-after-displacement") process.exit(89);
    };
  }
  const originalLink = fsp.link;
  if (["crash-after-link", "recreated-before-link", "edit-displaced-after-link"].includes(mode)) {
    fsp.link = async (source, destination) => {
      const staged = String(source).endsWith(".tmp");
      if (staged && mode === "recreated-before-link") writeFileSync(destination, interference, { flag: "wx" });
      await originalLink(source, destination);
      if (staged && mode === "crash-after-link") process.exit(90);
      if (staged && mode === "edit-displaced-after-link") writeFileSync(String(source).replace(/\.tmp$/u, ".bak"), interference);
    };
  }
  if (mode === "revert-plan-other-volume") {
    const originalStat = fsp.lstat;
    fsp.lstat = async (filename, options) => {
      const info = await originalStat(filename, options);
      return String(filename) === state + ".removed" && options?.bigint ? { dev: info.dev + 1n } : info;
    };
  }
  syncBuiltinESMExports();
  const backend = new FilesystemNoteBackend(vault, state, journal, () => time, () => {
    if (mode === "crash-after-effect") process.exit(87);
    if (mode !== "external-after-effect") return;
    const external = path.join(vault, "Archive", ".external-replacement.tmp");
    writeFileSync(external, interference);
    renameSync(external, path.join(vault, postflightRace));
  });
  try {
    if (mode === "revert-plan-other-volume") {
      const before = await readFile(path.join(vault, "Created.md"));
      await assert.rejects(new FilesystemRevert(backend, journal).plan({ path: "Created.md", operationRef: ref, idempotencyKey: key }), {
        code: "FORBIDDEN", message: /same filesystem/u,
      });
      assert.deepEqual(await readFile(path.join(vault, "Created.md")), before);
      return;
    }
    const adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal, undefined, { filesystem: backend });
    const writer = mode === "crash-after-link" ? new NoteCreateOperationAdapter(backend, journal) : adapter;
    const receipt = await writer.apply(ref, key);
    if (mode.startsWith("crash-")) assert.fail("The crash injection point was not reached");
    if (mode === "edit-at-displacement") return assert.equal(receipt.outcome, "conflict");
    if (mode === "blocked-displacement") {
      assert.equal(receipt.outcome, "failed");
      assert.equal(receipt.recoveryAllowed, false);
      assert.equal(renameAttempts, process.platform === "win32" ? 31 : 1);
      return;
    }
    assert.equal(receipt.outcome, "outcome_unknown");
    const evidence = journal.get(receipt.operationId).filesystem;
    assert.equal(evidence.beforeContent, initial);
    assert.equal(evidence.stagedContent, published);
    const observed = mode === "edit-displaced-after-link" ? evidence.displacedObservation : evidence.divergentObservation;
    assert.deepEqual(Buffer.from(observed.bytesBase64, "base64"), Buffer.from(interference));
    if (mode === "recreated-before-link") assert.deepEqual(Buffer.from(evidence.displacedObservation.bytesBase64, "base64"), Buffer.from(initial));
  } finally { journal.close(); }
}

async function fixtures(vault) {
  const files = new Map([
    [".obsidian/community-plugins.json", JSON.stringify(["frontmatter-date-manager", "templater-obsidian"])],
    [".obsidian/plugins/frontmatter-date-manager/data.json", JSON.stringify(dateSettings)],
    [".obsidian/plugins/templater-obsidian/data.json", JSON.stringify({ templates_folder: "Snippets" })],
    ["AGENTS.md", "# Vault instructions\n\nUse a governed plan for every note write.\n"],
    ["Note.md", initial], [excluded, initial], [templated, initial],
    ["Archive/Keep.md", initial], [raced, initial], [postflightRace, initial], [".hidden.md", initial],
    [interrupted, initial],
  ]);
  for (const [relative, content] of files) {
    const target = path.join(vault, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function checkDates() {
  const { readFilesystemDatePolicy, sealFilesystemDates, materializeFilesystemDates } = await import("../dist/services/operations/filesystemDatePolicy.js");
  const loadPolicy = (patch = {}) => readFilesystemDatePolicy(file => Promise.resolve({
    ".obsidian/community-plugins.json": JSON.stringify(["frontmatter-date-manager"]),
    ".obsidian/plugins/frontmatter-date-manager/data.json": JSON.stringify({ ...dateSettings, ...patch }),
    ".obsidian/templates.json": JSON.stringify({ folder: "Core Templates" }),
  }[file]));
  const policy = await loadPolicy();
  assert.equal(policy.managed(excluded), false);
  assert.equal(policy.managed("Archive/Keep.md"), true);
  assert.equal(policy.managed("Core Templates/Thing.md"), false);
  assert.equal(policy.managed("Other/Templates/Thing.md"), true);
  assert.equal(policy.managed("Canvas.md"), false);
  const edited = sealFilesystemDates(policy, "Note.md", initial.replace("Original", "Edited"), time, { content: initial, birthtimeMs: time - 1000 });
  assert.match(edited, /^\uFEFF---\r\n/u);
  assert.doesNotMatch(edited, /(?<!\r)\n/u);
  assert.match(edited, /created_at: 2026-09-05T11:12:12\r\n/u);
  assert.match(edited, /updated_at: 2026-09-05T11:12:13\r\n/u);
  const source = content => ({ content, birthtimeMs: time - 1000 });
  const emptyCreated = "---\ncreated_at:\n---\nBody.\n";
  assert.match(sealFilesystemDates(policy, "Note.md", emptyCreated.replace("Body.", "Edited."), time, source(emptyCreated)), /created_at: 2026-09-05T11:12:12\n/u);
  const bodyOnly = await loadPolicy({ hashTrackingMode: "body" });
  const withLabelEdit = edited.replace("label: first", "label: second");
  assert.equal(sealFilesystemDates(bodyOnly, "Note.md", withLabelEdit, time + 1000, source(edited)), withLabelEdit);
  assert.equal(materializeFilesystemDates(bodyOnly, "Note.md", withLabelEdit, time + 2000, edited), withLabelEdit);
  assert.throws(() => sealFilesystemDates(policy, "Note.md", withLabelEdit, time + 1000, source(edited)), /minimum save interval/u);
  assert.equal(sealFilesystemDates(policy, "Note.md", "\n", time), "\n");
  const drawing = "---\nexcalidraw-plugin: parsed\n---\nDrawing.\n";
  assert.equal(sealFilesystemDates(await loadPolicy({ trackExcalidraw: false }), "Drawing.md", drawing, time), drawing);
  await assert.rejects(loadPolicy({ timezone: "Europe/Paris" }), { code: "SERVICE_UNAVAILABLE" });
  await assert.rejects(loadPolicy({ hashTrackingMode: "unknown" }), { code: "SERVICE_UNAVAILABLE" });
  const timezone = process.env.TZ;
  delete process.env.TZ;
  try { await assert.rejects(loadPolicy(), { code: "SERVICE_UNAVAILABLE" }); }
  finally { process.env.TZ = timezone; }
}

async function checkDivergenceRetention(directory) {
  const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
  let now = time;
  const journal = new ObsidianNoteReplaceJournal(path.join(directory, "retention.sqlite"), {
    now: () => now, terminalRetentionMs: 100, purgeIntervalMs: 1,
  });
  try {
    const digest = "a".repeat(64);
    const plan = journal.create({ path: "Note.md", idempotencyKey: "retention", requestDigest: digest,
      beforeSha256: digest, afterSha256: digest, bindingFingerprint: digest, nextContent: published,
      filesystem: { policyDigest: digest, beforeContent: initial } });
    const applying = journal.transition(plan.operationId, ["planned"], "applying");
    journal.recordFilesystemStage(plan.operationId, applying.executionOwner.attemptId, "fixture-inode", digest, published);
    journal.recordFilesystemDivergence(plan.operationId, { sha256: digest, bytesBase64: Buffer.from(interference).toString("base64") });
    now += 110;
    assert.equal(journal.get(plan.operationId).status, "outcome_unknown", "Uncleaned witnesses remain attributable");
    journal.confirmFilesystemWitnessCleanup(plan.operationId);
    now += 110;
    assert.equal(journal.get(plan.operationId), undefined, "Settled divergence follows terminal retention");
  } finally { journal.close(); }
}

async function integration() {
  const root = await mkdtemp(path.join(os.tmpdir(), "optimike-governed-fs-"));
  const vault = path.join(root, "vault");
  const privateDirectory = path.join(root, "private");
  const logsParent = path.join(process.cwd(), "logs");
  await mkdir(logsParent, { recursive: true });
  const logs = await mkdtemp(path.join(logsParent, "headless-governed-"));
  const liveClients = [];
  const { MCP_HEADLESS_GOVERNED_JOURNAL_PATH: _override, ...inherited } = process.env;
  const env = {
    ...inherited,
    OBSIDIAN_VAULT: vault,
    OBSIDIAN_API_KEY: "",
    OBSIDIAN_BASE_URL: "http://127.0.0.1:1",
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_ENABLE_CACHE: "true",
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(privateDirectory, "cache.sqlite"),
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
    const journals = (await readdir(privateDirectory)).filter(name => /^[a-f0-9]{64}\.sqlite$/u.test(name));
    assert.equal(journals.length, 1, "Both headless modes share one default journal on this vault");
    const state = path.join(privateDirectory, journals[0]);
    const inject = async (mode, planRef, key, exit = 0) => {
      const worker = fork(new URL(import.meta.url), [mode, vault, state, planRef, key],
        { env: { ...env, OBSIDIAN_RUNTIME_MODE: "headless-filesystem" }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
      assert.deepEqual(await once(worker, "exit"), [exit, null], mode);
    };
    for (const client of [guarded, first]) {
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(!tools.includes("obsidian_search_replace") && !tools.includes("obsidian_manage_frontmatter"));
    }
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
    for (const relative of ["../escaped.md", ".hidden.md", "archive/Race.md"]) await call(first, "text_patch_plan", patch(relative, relative), true);
    await call(guarded, "frontmatter_patch_plan", { path: "Note.md", idempotencyKey: "forge-date",
      operations: [{ op: "set", key: "updated_at", value: "false" }] }, true);

    const create = await call(guarded, "note_create_plan", { path: "Created.md", content: "\uFEFFNew note.\r\n", idempotencyKey: "create" });
    expectVerified(await call(guarded, "note_create_apply", { planRef: create.planRef, idempotencyKey: "create" }));
    expectVerified(await call(first, "note_create_status", { planRef: create.planRef }));
    assert.match(await read("Created.md"), /^\uFEFF---\r\ncreated_at: /u);
    await inject("revert-plan-other-volume", create.planRef, "remove-cross-volume");
    const remove = await call(first, "operation_revert_plan", { path: "Created.md", operationRef: create.planRef, idempotencyKey: "remove" });
    expectVerified(await call(first, "operation_revert_apply", { planRef: remove.planRef, idempotencyKey: "remove" }));
    await assert.rejects(read("Created.md"), { code: "ENOENT" });

    const plan = await call(first, "note_replace_plan", { path: "Note.md", nextContent: (await read("Note.md")).replace("Original body.", "Before crash."),
      idempotencyKey: "crash" });
    await inject("crash-after-effect", plan.planRef, "crash", 87);
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

    const archive = path.join(vault, "Archive");
    const witnessCount = async () => (await readdir(archive)).filter(name => name.startsWith(".mcp-write-")).length;
    for (const [mode, exit, outcome, bytes] of [
      ["crash-before-displacement", 88, "conflict", initial],
      ["crash-after-displacement", 89, "conflict", initial],
      ["edit-at-displacement", 0, "conflict", interference],
      ["blocked-displacement", 0, "failed", initial],
      ["recreated-before-link", 0, "outcome_unknown", interference],
      ["edit-displaced-after-link", 0, "outcome_unknown", published],
    ]) {
      await writeFile(path.join(vault, interrupted), initial);
      const planned = await call(first, "note_replace_plan", { path: interrupted, nextContent: published, idempotencyKey: mode });
      await inject(mode, planned.planRef, mode, exit);
      if (mode === "crash-after-displacement") {
        const pending = await call(second, "note_replace_status", { planRef: planned.planRef });
        assert.equal(pending.recoveryAllowed, true);
        await assert.rejects(read(interrupted), { code: "ENOENT" }, "Status only observes the misplaced note");
      }
      const recovered = await call(second, "note_replace_recover", { planRef: planned.planRef, idempotencyKey: mode });
      assert.equal(recovered.outcome, outcome, mode);
      assert.equal(recovered.recoveryAllowed, false, mode);
      assert.equal(await read(interrupted), bytes, mode);
      assert.equal(await witnessCount(), 0, mode);
    }

    const createInterrupted = await call(guarded, "note_create_plan", { path: createCrash, content: "New file.\n", idempotencyKey: "create-link-crash" });
    await inject("crash-after-link", createInterrupted.planRef, "create-link-crash", 90);
    assert.equal((await stat(path.join(vault, createCrash))).nlink, 2);
    expectVerified(await call(second, "note_create_status", { planRef: createInterrupted.planRef }));
    assert.equal((await stat(path.join(vault, createCrash))).nlink, 1);
    assert.equal(await witnessCount(), 0);
    const writable = await call(first, "text_patch_plan", { path: createCrash, idempotencyKey: "created-after-recovery",
      operations: [{ op: "append_body", text: "Writable again.\n" }] });
    expectVerified(await call(first, "text_patch_apply", { planRef: writable.planRef, idempotencyKey: "created-after-recovery" }));

    const changed = await call(first, "note_replace_plan", { path: postflightRace, nextContent: published, idempotencyKey: "postflight-race" });
    await inject("external-after-effect", changed.planRef, "postflight-race");
    assert.equal(await read(postflightRace), interference);
    const uncertain = await call(second, "note_replace_status", { planRef: changed.planRef });
    assert.equal(uncertain.outcome, "outcome_unknown");
    assert.equal(uncertain.postflight.status, "unverified");
    const unreplayed = await call(first, "note_replace_recover", { planRef: changed.planRef, idempotencyKey: "postflight-race" });
    assert.equal(unreplayed.outcome, "outcome_unknown");
    assert.equal(await read(postflightRace), interference);
    const undoRace = await call(first, "operation_revert_plan", { path: postflightRace, operationRef: changed.planRef, idempotencyKey: "undo-postflight" });
    await writeFile(path.join(vault, postflightRace), published);
    assert.equal((await call(second, "note_replace_status", { planRef: changed.planRef })).outcome, "outcome_unknown");
    assert.equal((await call(first, "operation_revert_apply", { planRef: undoRace.planRef, idempotencyKey: "undo-postflight" })).outcome, "conflict");
    await writeFile(path.join(vault, postflightRace), interference);
    const undo = await call(first, "operation_revert_plan", { path: postflightRace, operationRef: changed.planRef, idempotencyKey: "undo-current-postflight" });
    expectVerified(await call(first, "operation_revert_apply", { planRef: undo.planRef, idempotencyKey: "undo-current-postflight" }));
    assert.equal(await read(postflightRace), initial);
    await rm(path.join(vault, postflightRace));
    assert.equal((await call(first, "operation_revert_plan", { path: postflightRace,
      operationRef: changed.planRef, idempotencyKey: "deleted-note-revert" }, true)).error.code, "CONFLICT");
    await checkDivergenceRetention(privateDirectory);

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

if (process.argv[2]) await injectAfterFilesystemEffect();
else {
  process.env.TZ = "UTC";
  await checkDates();
  await integration();
  console.log("PASS: headless governed lifecycles, cross-process CAS, crash observation, revert, and date policy");
}
