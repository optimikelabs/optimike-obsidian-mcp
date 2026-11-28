import { isolatedStateEnv } from "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { compileToolProfileNames } from "../dist/mcp-server/toolProfiles.js";
import { OperonFilesystemMutationResultSchema, OperonFilesystemPendingRecoveriesSchema } from "../dist/services/operon/contract.js";
import native from "./fixtures/operon-4.6.0-native-write-bytes.json" with { type: "json" };

const root = await mkdtemp(path.join(os.tmpdir(), "operon-write-fixture-"));
const vault = path.join(root, "vault");
const before = native.inlineCompletion.before;
const initialFile = native.fileDueUpdate.before;
const timestamp = "2026-03-01T14:05:06";
const instant = Date.parse(native.instant);
const day = timestamp.slice(0, 10);
const zone = native.timeZone;
const textPath = "Synthetic\u00a0note.md";
const filePath = "Synthetic file task.md";
const racePath = "Race.md";
const interruptedPath = "Interrupted.md";
const changedAfterCrashPath = "Changed after crash.md";
const phonePath = "Phone.md";
const statuses = [
  { id: "work_open", label: "Open" }, { id: "work_active", label: "Active" },
  { id: "work_done", label: "Done", isFinished: true }, { id: "work_cancelled", label: "Cancelled", isCancelled: true },
];
const alternate = { id: "second", name: "Second", statuses: [
  { id: "second_inbox", label: "Inbox" }, { id: "second_done", label: "Done", isFinished: true },
  { id: "second_cancelled", label: "Abandoned", isCancelled: true },
] };
const beforeSources = new Map([
  [textPath, before],
  ["BOM.md", "\uFEFF" + before.replace("target1", "bom0001").replaceAll("\n", "\r\n")],
  [filePath, initialFile],
  ["File BOM.md", "\uFEFF" + initialFile.replace("file001", "bomfile")],
  ["Description.md", before.replace("target1", "descrip")],
  ["Tags.md", before.replace("target1", "tags001")],
  ["Timed.md", initialFile.replace("file001", "timed01").replace("\n---\n#", "\ndatetimeEnd: 2026-04-02T10:00\n---\n#")],
  ["Timed inline.md", before.replace("target1", "timed02").replace(" {{datetimeCreated", " {{datetimeStart:: 2026-04-02T09:00}} {{datetimeCreated")],
  [racePath, before.replace("target1", "race001")],
  [phonePath, before.replace("target1", "phone01")],
  [interruptedPath, before.replace("target1", "crash01")],
  [changedAfterCrashPath, before.replace("target1", "crash02")],
  ["Changed settings.md", before.replace("target1", "crash03")],
  ["Changed pins.md", before.replace("target1", "crash04")],
  ["Related.md", before.replace("target1", "rel0001").replace(" {{datetimeCreated", " {{blocking:: target2}} {{datetimeCreated") +
    before.replace("target1", "target2")],
  ["Repeat.md", before.replace("target1", "repeat1").replace(" {{datetimeCreated", " {{repeat:: every week}} {{datetimeCreated")],
  ["Create.md", "# Fixture destination\n"],
  ["Protected.md", before.replace("target1", "gated01")],
]);
const setup = new Map([
  ...beforeSources,
  ["AGENTS.md", "Read this synthetic rule before changing the test note.\n"],
  [".obsidian/community-plugins.json", JSON.stringify(["frontmatter-date-manager", "operon"])],
  [".obsidian/plugins/frontmatter-date-manager/data.json", JSON.stringify({
    headerCreated: "creation", headerUpdated: "modification", enableAutoUpdate: true,
    enableCreateTime: false, enableModifiedTime: true, enableLastViewed: false,
    enableNumberProperties: false, dateFormat: "yyyy-MM-dd'T'HH:mm:ss", timezone: zone,
    filterRules: "Create.md\nBOM.md", countUpdatesEnabled: false, postUpdateCommand: "",
    inversionFixStrategy: "disabled", minSecondsBetweenSaves: 5, hashTrackingMode: "both",
  })],
  [".obsidian/plugins/operon/data.json", JSON.stringify({ schemaVersion: 3,
    taxonomy: { pipelines: { defaultPipelineName: "Work", pipelines: [{ id: "work", name: "Work", statuses }, alternate] },
      priorities: { defaultPriority: "p1", priorities: [{ id: "p1", label: "High" }] }, keyMappings: { system: [], custom: [] } },
  })],
  [".obsidian/plugins/operon/manifest.json", JSON.stringify({ version: "4.6.0" })],
]);
const state = path.join(root, "state");
const clients = [];
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const runtimeModule = new URL("../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js", import.meta.url).href;
const journalModule = new URL("../dist/services/operations/obsidianNoteReplaceJournal.js", import.meta.url).href;
const cacheModule = new URL("../dist/services/obsidianRestAPI/vaultCache/index.js", import.meta.url).href;
const logsParent = fileURLToPath(new URL("../logs/", import.meta.url));
await mkdir(logsParent, { recursive: true });
const logs = await mkdtemp(path.join(logsParent, "operon-write-fixture-"));

async function start(mode = "headless-filesystem", profile = "tasks", options = {}) {
  const client = new Client({ name: "operon-filesystem-write-fixture", version: "1" });
  let bootstrap = `Date.now = () => ${options.instant ?? instant};\n`;
  if (options.cacheSkew) bootstrap += `
    import { VaultCacheService } from ${JSON.stringify(cacheModule)};
    const originalGetEntry = VaultCacheService.prototype.getEntry;
    let skewNext = true;
    VaultCacheService.prototype.getEntry = async function (relative) {
      const entry = await originalGetEntry.call(this, relative);
      if (!entry || relative !== ${JSON.stringify("/" + racePath)} || !skewNext) return entry;
      skewNext = false;
      return { ...entry, mtime: entry.mtime + 1 };
    };`;
  if (options.phone) bootstrap += `
    import { GovernedNoteReplaceRuntime } from ${JSON.stringify(runtimeModule)};
    import { appendFile } from 'node:fs/promises';
    const originalApply = GovernedNoteReplaceRuntime.prototype.apply;
    GovernedNoteReplaceRuntime.prototype.apply = async function (...args) {
      await appendFile(${JSON.stringify(path.join(vault, phonePath))}, 'Phone edit.\\n');
      return originalApply.apply(this, args);
    };`;
  if (options.crash) bootstrap += `
    import { ObsidianNoteReplaceJournal } from ${JSON.stringify(journalModule)};
    const record = ObsidianNoteReplaceJournal.prototype.recordEffectAttempt;
    ObsidianNoteReplaceJournal.prototype.recordEffectAttempt = function (...args) {
      record.apply(this, args);
      process.exit(91);
    };`;
  if (options.atomicUnavailable) bootstrap += `
    import { GovernedNoteReplaceRuntime } from ${JSON.stringify(runtimeModule)};
    const filesystemStatus = GovernedNoteReplaceRuntime.prototype.filesystemStatus;
    GovernedNoteReplaceRuntime.prototype.filesystemStatus = async function () {
      const status = await filesystemStatus.call(this);
      return { ...status, backend: { ...status.backend, headlessReplacement: 'unavailable' } };
    };`;
  const startup = path.join(root, `preload-${clients.length}.mjs`);
  await writeFile(startup, bootstrap);
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", pathToFileURL(startup).href, entry], cwd: root,
    env: { ...isolatedStateEnv(), OBSIDIAN_VAULT: vault, OBSIDIAN_RUNTIME_MODE: mode,
      OBSIDIAN_CACHE_SOURCE: "filesystem", OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(state, "cache.sqlite"),
      MCP_HEADLESS_GOVERNED_JOURNAL_PATH: path.join(state, "governed.sqlite"),
      OBSIDIAN_ENABLE_CACHE: "true", OBSIDIAN_BASE_URL: "http://127.0.0.1:9", OBSIDIAN_API_KEY: "",
      MCP_TRANSPORT_TYPE: "stdio", MCP_TOOL_PROFILE: profile, MCP_WRITE_MODE: options.writeMode ?? "full",
      OPERON_MUTATIONS_ENABLED: "true", MCP_VAULT_INSTRUCTIONS: options.instructions ?? "off",
      MCP_LOG_LEVEL: "error", LOGS_DIR: logs, SEMANTIC_SEARCH_PREWARM: "false",
      TZ: zone, OPTIMIKE_VAULT_TIMEZONE: zone, MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE: "true" }, stderr: "pipe",
  });
  clients.push({ client, transport });
  let startupDiagnostic = "";
  transport.stderr?.on("data", chunk => { startupDiagnostic = (startupDiagnostic + chunk.toString()).slice(-8192); });
  try { await client.connect(transport); }
  catch (error) {
    const diagnostic = startupDiagnostic.match(/(?:FATAL: [^\n]+|Environment validation failed for \d+ setting\(s\)|Error \[[A-Z_]+\])/gu);
    throw new Error(`Synthetic ${mode} ${profile} startup failed${diagnostic ? ` (${diagnostic.join(", ")})` : ""}.`, { cause: error });
  }
  return client;
}

async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const payload = JSON.parse(result.content[0].text);
  return { error: Boolean(result.isError), payload, code: payload.error?.code, reason: payload.error?.details?.reasonCode };
}

async function call(client, name, args) {
  const result = await tool(client, name, args);
  assert.equal(result.error, false, `${name}: ${JSON.stringify(result.payload)}`);
  if (name === "operon_list_pending_recoveries") return OperonFilesystemPendingRecoveriesSchema.parse(result.payload);
  if (["operon_create_task", "operon_update_task", "operon_transition_task", "operon_recover_mutation"].includes(name)) {
    return OperonFilesystemMutationResultSchema.parse(result.payload);
  }
  return result.payload;
}

async function rejects(client, name, args, code) {
  const result = await tool(client, name, args);
  assert.equal(result.error, true, `${name}: ${JSON.stringify(result.payload)}`);
  assert.equal(result.code, code, `${name}: ${JSON.stringify(result.payload)}`);
  return result;
}

async function profile(client, profileName, registrationMode) {
  const names = (await client.listTools()).tools.map(row => row.name).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, compileToolProfileNames({ profile: profileName, registrationMode, availableStaticRequirements: ["vault-cache"] }));
  return names;
}

const task = async (client, operonId) => (await call(client, "operon_get_task", { operonId, forceRefresh: true })).task;
const read = relative => readFile(path.join(vault, relative));
const bytes = async (relative, expected) => assert.deepEqual(await read(relative), Buffer.from(expected));
const payload = (row, key, changes = {}) => ({ operonId: row.operonId, expectedRevision: row.revision,
  idempotencyKey: key, dryRun: false, ...changes });

try {
  for (const [relative, content] of setup) {
    const target = path.join(vault, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(state);
  const first = await start();
  const names = await profile(first, "tasks", "headless-filesystem");
  for (const name of ["operon_create_task", "operon_update_task", "operon_transition_task", "operon_resolve_task",
    "operon_list_pending_recoveries", "operon_recover_mutation"]) assert.ok(names.includes(name), name);
  for (const name of ["operon_update_tasks", "operon_set_relationships", "operon_update_recurrence", "operon_update_periodic_scheduling"]) {
    assert.ok(!names.includes(name), name);
  }
  const readonly = await start("headless-readonly");
  assert.ok(!(await profile(readonly, "tasks", "headless-readonly")).includes("operon_transition_task"));
  const resolved = await call(first, "operon_resolve_task", { selector: { kind: "exact-path", filePath: textPath } });
  assert.equal(resolved.result.resolution, "resolved");
  assert.deepEqual(resolved.result.selected.locator, { representation: "inline", filePath: textPath, lineNumber: 2 });
  const initial = await task(first, "target1");
  const capabilities = (await call(first, "obsidian_runtime_status")).capabilityManifest.capabilities;
  const writer = capabilities.find(row => row.id === "operon-write");
  assert.equal(writer.authorized, process.platform !== "win32");
  assert.equal(writer.operations.find(row => row.id === "recurrence").available, false);
  if (process.platform === "win32") {
    const error = await rejects(first, "operon_transition_task", payload(initial, "windows-refusal", { intent: "complete" }), "SERVICE_UNAVAILABLE");
    assert.equal(error.reason, "headless_atomic_exchange_unavailable");
    await bytes(textPath, before);
  } else {
    const full = await start("headless-filesystem", "full", { cacheSkew: true });
    const paths = await profile(full, "full", "headless-filesystem");
    assert.ok(paths.includes("operon_update_recurrence"));
    const readonly = await start("headless-filesystem", "tasks", { writeMode: "readonly" });
    const readonlyInput = payload(initial, "readonly-preview", { intent: "cancel", dryRun: true });
    assert.equal((await call(readonly, "operon_transition_task", readonlyInput)).status, "planned");
    await rejects(readonly, "operon_transition_task", { ...readonlyInput, dryRun: false, idempotencyKey: "readonly-apply" }, "FORBIDDEN");
    const noop = payload(initial, "same-status", { statusId: "work_open" });
    const unchanged = await call(first, "operon_transition_task", noop);
    assert.equal(unchanged.noChange, true);
    assert.deepEqual(unchanged.fieldValues, {});
    assert.equal(unchanged.after.revision, initial.revision);
    assert.equal((await call(first, "operon_transition_task", noop)).status, "already-applied");
    await bytes(textPath, before);
    const preview = payload(initial, "preview-only", { intent: "complete", dryRun: true });
    assert.equal((await call(first, "operon_transition_task", preview)).status, "planned");
    await bytes(textPath, before);
    const reused = await rejects(first, "operon_transition_task", { ...preview, dryRun: false }, "CONFLICT");
    assert.equal(reused.reason, "idempotency_key_reused");
    const transitions = [
      [{ statusId: "work_active" }, "Work.Active", " ", ""],
      [{ intent: "complete" }, "Work.Done", "x", ` {{dateCompleted:: ${day}}}`],
      [{ intent: "cancel" }, "Work.Cancelled", "-", ` {{dateCancelled:: ${day}}}`],
      [{ intent: "reopen" }, "Work.Open", " ", ""],
      [{ status: "Second.Inbox" }, "Second.Inbox", " ", ""],
      [{ intent: "complete" }, "Second.Done", "x", ` {{dateCompleted:: ${day}}}`],
      [{ intent: "cancel" }, "Second.Abandoned", "-", ` {{dateCancelled:: ${day}}}`],
    ];
    for (const [index, [selector, status, mark, date]] of transitions.entries()) {
      const input = payload(await task(first, "target1"), `transition-${index}`, selector);
      const result = await call(first, "operon_transition_task", input);
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.after.status, status);
      const expected = before.replace("- [ ]", `- [${mark}]`).replace("{{status:: Work.Open}}", `{{status:: ${status}}}${date}`)
        .replace("}}\n", `}} {{datetimeModified:: ${timestamp}}}\n`);
      const captured = { "Work.Done": native.inlineCompletion.after, "Work.Cancelled": native.inlineCancel,
        ...(index === 3 ? { "Work.Open": native.inlineReopen } : {}) };
      await bytes(textPath, `---\nmodification: ${timestamp}\n---\n` + (captured[status] ?? expected));
      assert.equal((await call(first, "operon_transition_task", input)).status, "already-applied");
    }
    const updated = await call(first, "operon_update_task", payload(await task(first, "file001"), "file-update",
      { patch: { fields: { dateDue: "2026-04-03" } } }));
    assert.equal(updated.status, "applied", JSON.stringify(updated));
    await bytes(filePath, native.fileDueUpdate.after.replace("\n---\n#", `\nmodification: ${timestamp}\n---\n#`));
    for (const [intent, expectedFile, checkbox] of [["complete", native.fileCompletion, "done"], ["reopen", native.fileReopen, "open"]]) {
      const result = await call(first, "operon_transition_task", payload(await task(first, "file001"), `file-${intent}`, { intent }));
      assert.equal(result.after.checkbox, checkbox);
      await bytes(filePath, expectedFile.replace("\ndateCompleted:", `\nmodification: ${timestamp}\ndateCompleted:`));
    }
    const bom = payload(await task(first, "bom0001"), "bom-update", { patch: { description: "Updated bytes" } });
    assert.equal((await call(first, "operon_update_task", bom)).status, "applied");
    await bytes("BOM.md", beforeSources.get("BOM.md").replace("Check bytes", "Updated bytes")
      .replace("}}\r\n", `}} {{datetimeModified:: ${timestamp}}}\r\n`));
    const created = await call(first, "operon_create_task", { idempotencyKey: "inline-create", dryRun: false,
      task: { source: "inline", targetPath: "Create.md", description: "New task", tags: ["synthetic"], fields: { dateDue: "2026-04-02" } } });
    assert.equal(created.status, "applied", JSON.stringify(created));
    assert.match(created.after.operonId, /^[a-z0-9]{7}$/u);
    await bytes("Create.md", `# Fixture destination\n${native.inlineCreation.replace("new0001", created.after.operonId)}\n`);

    for (const [filename, id, patch, captured] of [
      ["Description.md", "descrip", { description: "Updated native description" }, native.inlineDescription],
      ["Tags.md", "tags001", { tags: ["synthetic", "nested/example"] }, native.inlineTags],
    ]) {
      const result = await call(first, "operon_update_task", payload(await task(first, id), `native-${id}`, { patch }));
      assert.equal(result.status, "applied");
      await bytes(filename, `---\nmodification: ${timestamp}\n---\n${captured.replace("target1", id)}`);
    }
    const bomFile = await rejects(first, "operon_update_task", payload(await task(first, "bomfile"), "bom-file",
      { patch: { fields: { dateDue: "2026-04-03" } } }), "VALIDATION_ERROR");
    assert.equal(bomFile.reason, native.fileBomRefusal.split(":")[1]);
    await bytes("File BOM.md", beforeSources.get("File BOM.md"));

    const fileTask = await task(first, "file001");
    const fileBeforeClear = await read(filePath);
    for (const [index, expected] of native.scheduling.entries()) {
      const [key, value] = Object.entries(expected)[0];
      const inputValue = index === 3 ? "2026-04-02T10:00" : value;
      const refusal = await rejects(first, "operon_update_task", payload(fileTask, `schedule-${index}`,
        { patch: { fields: { [key]: inputValue } } }), "SERVICE_UNAVAILABLE");
      assert.equal(refusal.reason, "operon_filesystem_live_required");
    }
    for (const [index, invalidValue] of [7200, null, false].entries()) {
      await rejects(first, "operon_update_task", payload(fileTask, `invalid-estimate-${index}`,
        { patch: { fields: { estimate: invalidValue } } }), "VALIDATION_ERROR");
    }
    assert.deepEqual(await read(filePath), fileBeforeClear);
    const timed = await rejects(first, "operon_update_task", payload(await task(first, "timed01"), "existing-time-slot",
      { patch: { fields: { dateDue: "2026-04-03" } } }), "SERVICE_UNAVAILABLE");
    assert.equal(timed.reason, "operon_filesystem_live_required");
    await bytes("Timed.md", beforeSources.get("Timed.md"));
    const timedInline = await task(first, "timed02");
    for (const [key, patch] of [["timed-description", { description: "New description" }], ["timed-tags", { tags: ["synthetic"] }]]) {
      const refused = await rejects(first, "operon_update_task", payload(timedInline, key, { patch }), "SERVICE_UNAVAILABLE");
      assert.equal(refused.reason, "operon_filesystem_live_required");
      await bytes("Timed inline.md", beforeSources.get("Timed inline.md"));
    }
    // The Bridge's status-only transition carries no companion changes to prepareUpdate.
    assert.equal((await call(first, "operon_transition_task", payload(timedInline, "timed-status-only", { intent: "complete" }))).status, "applied");
    assert.equal((await task(first, "timed02")).dates.scheduled, null);
    const cleared = await call(first, "operon_update_task", payload(fileTask, "clear-due",
      { patch: { fields: { dateDue: "" } } }));
    assert.equal(cleared.status, "applied");
    assert.equal((await task(first, "file001")).dates.due, null);
    const clearedTask = await task(first, "file001");
    const alreadyClearedBytes = await read(filePath);
    const unchangedClear = await call(first, "operon_update_task", payload(clearedTask, "clear-absent-due",
      { patch: { fields: { dateDue: "" } } }));
    assert.equal(unchangedClear.noChange, true);
    assert.deepEqual(unchangedClear.fieldValues, {});
    assert.equal(unchangedClear.after.revision, clearedTask.revision);
    assert.deepEqual(await read(filePath), alreadyClearedBytes);

    for (const [id, relative] of [["repeat1", "Repeat.md"], ["target2", "Related.md"]]) {
      const refused = await rejects(first, "operon_transition_task", payload(await task(first, id), `guard-${id}`, { intent: "complete" }), "SERVICE_UNAVAILABLE");
      assert.equal(refused.reason, "operon_filesystem_live_required");
      await bytes(relative, beforeSources.get(relative));
    }
    const guarded = await start("headless-filesystem", "tasks", { instructions: "enforce" });
    const gatedInput = payload(await task(guarded, "gated01"), "gated-apply", { intent: "complete" });
    await rejects(guarded, "operon_transition_task", gatedInput, "FORBIDDEN");
    await bytes("Protected.md", beforeSources.get("Protected.md"));

    const race = await task(first, "race001");
    const transitionsRaced = await Promise.all([
      tool(first, "operon_transition_task", payload(race, "race-key-a", { intent: "complete" })),
      tool(full, "operon_transition_task", payload(race, "race-key-b", { intent: "cancel" })),
    ]);
    assert.equal(transitionsRaced.filter(row => !row.error && row.payload.status === "applied").length, 1, JSON.stringify(transitionsRaced));
    assert.equal(transitionsRaced.filter(row => row.error && row.code === "CONFLICT").length, 1, JSON.stringify(transitionsRaced));

    const phone = await start("headless-filesystem", "tasks", { phone: true });
    await rejects(phone, "operon_transition_task", payload(await task(phone, "phone01"), "phone-after-plan", { intent: "cancel" }), "CONFLICT");
    await bytes(phonePath, beforeSources.get(phonePath) + "Phone edit.\n");

    const crash = await start("headless-filesystem", "tasks", { crash: true });
    await assert.rejects(call(crash, "operon_transition_task", payload(await task(crash, "crash01"), "crash-apply", { intent: "complete" })), /closed/u);
    await bytes(interruptedPath, beforeSources.get(interruptedPath));
    const resumed = await start("headless-filesystem", "tasks", { instant: instant + 120_000 });
    const pending = await call(resumed, "operon_list_pending_recoveries");
    const refs = pending.recoveries.filter(row => row.mutationKind === "operon_transition_task");
    assert.equal(refs.length, 1);
    const recoveryInput = { recoveryRef: refs[0].recoveryRef, idempotencyKey: "recover-crash", recovery: { kind: "developer-api" } };
    await rejects(guarded, "operon_recover_mutation", recoveryInput, "FORBIDDEN");
    const atomicUnavailable = await start("headless-filesystem", "tasks", { atomicUnavailable: true, instant: instant + 120_000 });
    const unavailable = await rejects(atomicUnavailable, "operon_recover_mutation", recoveryInput, "SERVICE_UNAVAILABLE");
    assert.equal(unavailable.reason, "headless_atomic_exchange_unavailable");
    assert.deepEqual((await call(resumed, "operon_list_pending_recoveries")).recoveries, refs);
    await bytes(interruptedPath, beforeSources.get(interruptedPath));
    assert.equal((await call(resumed, "operon_recover_mutation", recoveryInput)).status, "applied");
    assert.equal((await call(resumed, "operon_recover_mutation", recoveryInput)).status, "already-applied");
    const reusedRecoveryKey = await rejects(resumed, "operon_transition_task",
      payload(await task(resumed, "crash01"), recoveryInput.idempotencyKey, { intent: "reopen" }), "CONFLICT");
    assert.equal(reusedRecoveryKey.reason, "idempotency_key_reused");
    assert.deepEqual((await call(resumed, "operon_list_pending_recoveries")).recoveries, []);
    assert.equal((await task(resumed, "crash01")).dates.modified, timestamp, "Recovery must publish the originally sealed task timestamp");

    const crashBeforeEdit = await start("headless-filesystem", "tasks", { crash: true });
    const interruptedInput = payload(await task(crashBeforeEdit, "crash02"), "crash-before-phone-edit", { intent: "complete" });
    await assert.rejects(call(crashBeforeEdit, "operon_transition_task", interruptedInput), /closed/u);
    const [interrupted] = (await call(resumed, "operon_list_pending_recoveries")).recoveries;
    assert.ok(interrupted);
    const phoneEdit = beforeSources.get(changedAfterCrashPath) + "Phone edited the note after interruption.\n";
    await writeFile(path.join(vault, changedAfterCrashPath), phoneEdit, "utf8");
    const conflictInput = { ...recoveryInput, recoveryRef: interrupted.recoveryRef, idempotencyKey: "recover-after-phone-edit" };
    await rejects(resumed, "operon_recover_mutation", conflictInput, "CONFLICT");
    assert.deepEqual((await call(resumed, "operon_list_pending_recoveries")).recoveries, []);
    await rejects(resumed, "operon_recover_mutation", conflictInput, "CONFLICT");
    await rejects(resumed, "operon_transition_task", interruptedInput, "CONFLICT");
    await bytes(changedAfterCrashPath, phoneEdit);

    const configPath = ".obsidian/plugins/operon/data.json";
    const prioritiesChanged = JSON.parse(setup.get(configPath));
    prioritiesChanged.taxonomy.priorities.priorities.push({ id: "p2", label: "Low" });
    const pinStatePath = path.join(vault, ".obsidian/plugins/operon/state");
    await mkdir(pinStatePath, { recursive: true });
    for (const [kind, id, filename, changeState] of [
      ["settings", "crash03", "Changed settings.md",
        () => writeFile(path.join(vault, configPath), JSON.stringify(prioritiesChanged), "utf8")],
      ["pins", "crash04", "Changed pins.md",
        () => writeFile(path.join(pinStatePath, "pinned-tasks.json"), JSON.stringify({ itemsById: { target1: { pinned: true } } }), "utf8")],
    ]) {
      const interruptedClient = await start("headless-filesystem", "tasks", { crash: true });
      const interruptedInput = payload(await task(interruptedClient, id), "crash-before-" + kind, { intent: "complete" });
      await assert.rejects(call(interruptedClient, "operon_transition_task", interruptedInput), /closed/u);
      const [entry] = (await call(resumed, "operon_list_pending_recoveries")).recoveries;
      assert.ok(entry);
      await changeState();
      const recover = { ...recoveryInput, recoveryRef: entry.recoveryRef, idempotencyKey: "recover-after-" + kind };
      for (const [name, args] of [
        ["operon_recover_mutation", recover],
        ["operon_recover_mutation", recover],
        ["operon_transition_task", interruptedInput],
      ]) {
        const conflict = await rejects(resumed, name, args, "CONFLICT");
        assert.equal(conflict.reason, "operon_filesystem_recovery_binding_changed");
        assert.equal(conflict.payload.error.message, "Operon settings or runtime state changed since the plan was sealed.");
      }
      assert.deepEqual((await call(resumed, "operon_list_pending_recoveries")).recoveries, []);
      await bytes(filename, beforeSources.get(filename));
    }
    assert.equal((await call(resumed, "operon_recover_mutation", recoveryInput)).status, "already-applied");
    const fileBeforeRouting = await read(filePath);
    const updatedConfig = { ...JSON.parse(setup.get(configPath)),
      ui: { taskCreationProfile: { fileTaskPipelineLocations: [{ pipelineId: "second", folderPath: "Routed" }] } } };
    await writeFile(path.join(vault, configPath), JSON.stringify(updatedConfig));
    const refusedRouting = await rejects(resumed, "operon_transition_task",
      payload(await task(resumed, "file001"), "file-pipeline-routing", { statusId: "second_inbox" }), "SERVICE_UNAVAILABLE");
    assert.equal(refusedRouting.reason, "operon_filesystem_live_required");
    assert.deepEqual(await read(filePath), fileBeforeRouting);
  }
  console.log("Headless Operon mutation, byte fixtures, refusal and profile checks passed.");
} finally {
  await Promise.allSettled(clients.map(({ transport }) => transport.close()));
  await Promise.all([root, logs].map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
}
