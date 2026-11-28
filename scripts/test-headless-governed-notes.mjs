import { isolatedStateDirectory } from "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
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
  const { nativeFilesystemExchange } = await import("../dist/services/operations/filesystemAtomicExchange.js");
  const journal = new ObsidianNoteReplaceJournal(state);
  if (mode === "probe-failure-cleanup") {
    const originalRm = fsp.rm;
    let failures = 0;
    fsp.rm = async (filename, options) => {
      if (path.basename(filename).startsWith(".mcp-exchange-")) {
        failures += 1;
        throw new Error("Synthetic probe cleanup failure");
      }
      return originalRm(filename, options);
    };
    syncBuiltinESMExports();
    try {
      const failing = () => () => { throw new Error("Synthetic primary probe failure"); };
      const backend = new FilesystemNoteBackend(vault, state, journal, () => time, undefined, failing, failing);
      const adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal, undefined, { filesystem: backend });
      await assert.rejects(adapter.plan({ path: raced, idempotencyKey: "double-probe-error", nextContent: published }),
        /Synthetic primary probe failure/u);
      assert.equal(failures, 2);
    } finally {
      fsp.rm = originalRm;
      syncBuiltinESMExports();
      journal.close();
    }
    return;
  }
  if (mode === "crash-before-displacement") {
    const record = journal.recordFilesystemStage.bind(journal);
    journal.recordFilesystemStage = (...args) => { record(...args); process.exit(88); };
  }
  let renameAttempts = 0;
  const originalRename = fsp.rename;
  if (["crash-after-displacement", "crash-before-status", "edit-at-displacement", "blocked-displacement"].includes(mode)) {
    fsp.rename = async (source, destination) => {
      if (!String(destination).endsWith(".bak")) return originalRename(source, destination);
      if (mode === "edit-at-displacement") writeFileSync(source, interference);
      if (mode === "blocked-displacement") {
        renameAttempts += 1;
        throw Object.assign(new Error("Synthetic sharing violation"), { code: "EPERM" });
      }
      await originalRename(source, destination);
      if (mode === "crash-after-displacement" || mode === "crash-before-status") process.exit(89);
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
    // macOS exposes its temporary directory through a symlink. The backend
    // resolves that alias before checking the journal's device.
    const removedDirectory = path.join(realpathSync(path.dirname(state)), path.basename(state) + ".removed");
    const originalStat = fsp.lstat;
    fsp.lstat = async (filename, options) => {
      const info = await originalStat(filename, options);
      return String(filename) === removedDirectory && options?.bigint ? { dev: info.dev + 1n } : info;
    };
  }
  syncBuiltinESMExports();
  let exchanges = 0;
  const injectExchange = () => {
    if (!mode.endsWith("exchange")) return undefined;
    return (target, stage) => {
      exchanges += 1;
      if (mode !== "crash-after-exchange" && exchanges === 1) writeFileSync(target, interference);
      if (mode === "crash-before-second-exchange" && exchanges === 2) process.exit(92);
      nativeFilesystemExchange()(target, stage);
      if (mode === "crash-after-exchange") process.exit(91);
      if (mode === "crash-after-second-exchange" && exchanges === 2) process.exit(93);
    };
  };
  const backend = new FilesystemNoteBackend(vault, state, journal, () => time, () => {
    if (mode === "crash-after-effect") process.exit(87);
    if (mode !== "external-after-effect") return;
    const external = path.join(vault, "Archive", ".external-replacement.tmp");
    writeFileSync(external, interference);
    renameSync(external, path.join(vault, postflightRace));
  }, injectExchange); // Other rename injections target the explicit legacy path.
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
  const excludedLabel = await loadPolicy({ frontmatterHashExcludeKeys: ["label"] });
  assert.equal(sealFilesystemDates(excludedLabel, "Note.md", withLabelEdit, time + 1000, source(edited)), withLabelEdit);
  assert.equal(sealFilesystemDates(policy, "Note.md", withLabelEdit, time + 1000, source(edited)), withLabelEdit);
  assert.equal(materializeFilesystemDates(policy, "Note.md", withLabelEdit, time + 1000, edited), withLabelEdit);
  assert.equal(sealFilesystemDates(policy, "Note.md", edited + " \r\n", time + 60_000, source(edited)), edited + " \r\n");
  assert.equal(sealFilesystemDates(policy, "Note.md", "\n", time), "\n");
  const drawing = "---\nexcalidraw-plugin: parsed\n---\nDrawing.\n";
  const noDrawings = await loadPolicy({ trackExcalidraw: false });
  assert.equal(sealFilesystemDates(noDrawings, "Drawing.md", drawing, time), drawing);
  assert.match(sealFilesystemDates(noDrawings, "Drawing.md", drawing.replace("parsed", '"false"'), time), /updated_at:/u);
  assert.match(sealFilesystemDates(noDrawings, "Drawing.md", drawing.replace("parsed", "\nlabel: first"), time), /updated_at:/u);
  assert.equal(sealFilesystemDates(noDrawings, "Drawing.md", drawing.replace("excalidraw-plugin", '"excalidraw-plugin"'), time),
    drawing.replace("excalidraw-plugin", '"excalidraw-plugin"'));
  assert.match(sealFilesystemDates(noDrawings, "Drawing.md", drawing.replace("excalidraw-plugin", "nested:\n  excalidraw-plugin"), time), /updated_at:/u);
  await assert.rejects(loadPolicy({ timezone: "Europe/Paris" }), { code: "SERVICE_UNAVAILABLE" });
  await assert.rejects(loadPolicy({ hashTrackingMode: "unknown" }), { code: "SERVICE_UNAVAILABLE" });
  const timezone = process.env.OPTIMIKE_VAULT_TIMEZONE;
  delete process.env.OPTIMIKE_VAULT_TIMEZONE;
  try { await assert.rejects(loadPolicy(), { code: "SERVICE_UNAVAILABLE" }); }
  finally { process.env.OPTIMIKE_VAULT_TIMEZONE = timezone; }
  process.env.OPTIMIKE_VAULT_TIMEZONE = "America/New_York";
  try { await assert.rejects(loadPolicy(), { code: "SERVICE_UNAVAILABLE" }); }
  finally { process.env.OPTIMIKE_VAULT_TIMEZONE = timezone; }
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

function observePath(filename) {
  let absent = 0, samples = 0, done = false;
  process.once("message", () => { done = true; });
  process.send("ready");
  const sample = () => {
    for (let i = 0; i < 128; i += 1) {
      if (!existsSync(filename)) absent += 1;
      samples += 1;
    }
    if (done) process.send({ absent, samples }, () => process.disconnect());
    else setImmediate(sample);
  };
  sample();
}

async function checkAtomicExchange() {
  const root = await mkdtemp(path.join(os.tmpdir(), "optimike-p9-"));
  const vault = path.join(root, "vault");
  const state = path.join(root, "journal.sqlite");
  process.env.OBSIDIAN_VAULT = vault;
  process.env.OBSIDIAN_RUNTIME_MODE = "headless-filesystem";
  process.env.MCP_WRITE_MODE = "full";
  process.env.MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE = "false";
  await fixtures(vault);
  const { FilesystemNoteBackend } = await import("../dist/services/operations/filesystemNoteBackend.js");
  const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
  const { ObsidianNoteReplaceOperationAdapter } = await import("../dist/services/operations/obsidianNoteReplaceOperationAdapter.js");
  const { atomicExchangeUnavailable, nativeFilesystemExchange } = await import("../dist/services/operations/filesystemAtomicExchange.js");
  const { FilesystemRevert } = await import("../dist/services/operations/filesystemRevert.js");
  const exchange = nativeFilesystemExchange();
  assert.equal(typeof exchange, "function", "The CI filesystem needs a native exchange on this platform");
  const journal = new ObsidianNoteReplaceJournal(state);
  const filename = path.join(vault, raced);
  let watcher, reader;
  try {
    let watcherAbsences = 0;
    watcher = watch(path.dirname(filename), (_, name) => {
      if (name === path.basename(filename) && !existsSync(filename)) watcherAbsences += 1;
    });
    reader = fork(new URL(import.meta.url), ["observe-exchange", filename], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const exit = once(reader, "exit");
    const [ready] = await once(reader, "message");
    assert.equal(ready, "ready");
    const backend = new FilesystemNoteBackend(vault, state, journal, () => time);
    const makeAdapter = filesystem => new ObsidianNoteReplaceOperationAdapter(filesystem, journal, undefined, { filesystem });
    const injected = (getExchange, getProbeExchange) => {
      return makeAdapter(new FilesystemNoteBackend(vault, state, journal, () => time, undefined, getExchange, getProbeExchange));
    };
    const plain = makeAdapter(backend);
    let content;
    for (let i = 0; i < 20; i += 1) {
      content = initial.replace("Original body.", `Replacement ${i}.`);
      const key = `p9-${i}`;
      const planned = await plain.plan({ path: raced, idempotencyKey: key, nextContent: content });
      assert.equal((await plain.apply(planned.planRef, key)).outcome, "committed");
    }
    const sampleResult = once(reader, "message");
    reader.send("done");
    const [{ absent, samples }] = await sampleResult;
    assert.deepEqual(await exit, [0, null]);
    watcher.close(); watcher = undefined;
    assert.ok(samples >= 20);
    assert.equal(absent, 0, "A separate process must never observe an absent note");
    assert.equal(watcherAbsences, 0);
    console.log(`p9: 20 replacements, ${samples} concurrent samples, ${absent} absent, ${watcherAbsences} watcher absences`);

    const refuseVolume = () => () => { throw atomicExchangeUnavailable(); };
    await assert.rejects(injected(undefined, refuseVolume).plan({ path: raced, idempotencyKey: "probe-volume", nextContent: published }), {
      code: "SERVICE_UNAVAILABLE", details: { reasonCode: "headless_atomic_exchange_unavailable" },
    });
    assert.equal((await readdir(path.dirname(filename))).some(name => name.startsWith(".mcp-exchange-")), false);
    const unavailable = injected(refuseVolume);
    const refused = await unavailable.plan({ path: raced, idempotencyKey: "unsupported-volume", nextContent: published });
    const failure = await unavailable.apply(refused.planRef, "unsupported-volume");
    assert.equal(failure.outcome, "failed");
    assert.equal(failure.postflight.reason, "headless_atomic_exchange_unavailable");
    assert.equal(await readFile(filename, "utf8"), content);

    for (const [key, write] of [
      ["in-place", target => writeFileSync(target, interference)],
      ["replace", target => { writeFileSync(target + ".sync", interference); renameSync(target + ".sync", target); }],
    ]) {
      await writeFile(filename, initial);
      let beforeFirstExchange = true;
      const racing = injected(() => (target, stage) => {
        if (beforeFirstExchange) { beforeFirstExchange = false; write(target); }
        exchange(target, stage);
      });
      const planned = await racing.plan({ path: raced, idempotencyKey: key, nextContent: published });
      const applied = await racing.apply(planned.planRef, key);
      assert.equal(applied.outcome, "conflict", key);
      assert.equal((await racing.status(planned.planRef)).outcome, "conflict");
      assert.equal(await readFile(filename, "utf8"), interference, key);
      assert.equal(journal.get(applied.operationId).filesystem.stagedContent, published);
    }

    await writeFile(filename, initial);
    let attempts = 0;
    const blockedRollback = injected(() => (target, stage) => {
      if (++attempts > 1) throw atomicExchangeUnavailable();
      writeFileSync(target, interference);
      exchange(target, stage);
    });
    const plan = await blockedRollback.plan({ path: raced, idempotencyKey: "blocked-rollback", nextContent: published });
    const applied = await blockedRollback.apply(plan.planRef, "blocked-rollback");
    assert.equal(applied.outcome, "outcome_unknown");
    assert.equal(applied.postflight.reason, "headless_displaced_edit");
    assert.equal(await readFile(filename, "utf8"), published);
    const reverts = new FilesystemRevert(backend, journal);
    const revert = await reverts.plan({ path: raced, operationRef: plan.planRef, idempotencyKey: "restore-phone" });
    const oldPlan = journal.get(revert.operationId);
    const oldProof = { ...oldPlan.projection.proof };
    delete oldProof.displacedEditVerified;
    const stale = journal.create({ ...oldPlan, idempotencyKey: "old-revert", projection: {
      ...oldPlan.projection, proof: oldProof, publicIdempotencyKey: "old-revert",
    } });
    await assert.rejects(reverts.apply(`obsidian-operation-revert:v1:${stale.operationId}`, "old-revert"), { code: "CONFLICT" });
    assert.equal((await reverts.apply(revert.planRef, "restore-phone")).outcome, "committed");
    assert.equal(await readFile(filename, "utf8"), interference);

    const third = initial.replace("Original body.", "Third party edit.");
    const fourth = initial.replace("Original body.", "Fourth edit.");
    const replace = (target, text) => { writeFileSync(target + ".sync", text); renameSync(target + ".sync", target); };
    const cases = [
      ["E", (target, stage) => { writeFileSync(target, third); exchange(target, stage); }, true],
      ["F", (target, stage) => { replace(target, third); exchange(target, stage); }, true],
      ["H", (target, stage) => { exchange(target, stage); writeFileSync(target, third); }, false],
      ["I", (target, stage) => { exchange(target, stage); replace(target, third); }, false],
      ["J", (target, stage) => { writeFileSync(stage, third); exchange(target, stage); }, false],
      ["K", (target, stage) => { writeFileSync(target, third); exchange(target, stage); }, true],
    ];
    for (const [key, secondExchange, recoverable] of cases) {
      await writeFile(filename, initial);
      let count = 0;
      const racing = injected(() => (target, stage) => {
        if (++count === 2) return secondExchange(target, stage);
        if (key === "K") replace(target, interference);
        else writeFileSync(target, interference);
        exchange(target, stage);
      });
      const source = await racing.plan({ path: raced, idempotencyKey: key, nextContent: published });
      const receipt = await racing.apply(source.planRef, key);
      assert.equal(receipt.outcome, recoverable ? "outcome_unknown" : "conflict", key);
      assert.equal((await racing.status(source.planRef)).postflight.reason, recoverable ? "headless_displaced_edit" : undefined, key);
      const evidence = JSON.stringify(journal.get(source.operationId).filesystem);
      for (const version of [interference, third]) assert.ok(evidence.includes(Buffer.from(version).toString("base64")), key);
      assert.equal(await readFile(filename, "utf8"), recoverable ? interference : third, key);
      const restore = () => reverts.plan({ path: raced, operationRef: source.planRef, idempotencyKey: `revert-${key}` });
      if (recoverable) {
        const plan = await restore();
        assert.equal((await reverts.apply(plan.planRef, `revert-${key}`)).outcome, "committed", key);
      } else await assert.rejects(restore, { code: "CONFLICT" });
      assert.equal(await readFile(filename, "utf8"), third, key);
    }

    for (const [key, mode, code, downtimeEdit] of [
      ["before-second", "crash-before-second-exchange", 92, false],
      ["after-second", "crash-after-second-exchange", 93, false],
      ["downtime-edit", "crash-before-second-exchange", 92, true],
    ]) {
      await writeFile(filename, initial);
      const source = await plain.plan({ path: raced, idempotencyKey: key, nextContent: published });
      const worker = fork(new URL(import.meta.url), [mode, vault, state, source.planRef, key],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      assert.deepEqual(await once(worker, "exit"), [code, null], key);
      if (downtimeEdit) await writeFile(filename, fourth);
      await backend.restoreInterruptedReplacements();
      const receipt = await plain.status(source.planRef);
      assert.equal(receipt.outcome, "conflict", key);
      assert.equal(receipt.postflight.reason, undefined, key);
      await assert.rejects(reverts.plan({ path: raced, operationRef: source.planRef, idempotencyKey: `revert-${key}` }), { code: "CONFLICT" });
      assert.equal(await readFile(filename, "utf8"), downtimeEdit ? fourth : interference, key);
      assert.equal((await readdir(path.dirname(filename))).some(name => name.startsWith(".mcp-write-")), false, key);
    }

    await writeFile(filename, initial);
    const deletedAfterExchange = injected(() => (target, stage) => {
      writeFileSync(target, interference);
      exchange(target, stage);
      rmSync(target);
    });
    const deletion = await deletedAfterExchange.plan({ path: raced, idempotencyKey: "removed-after-exchange", nextContent: published });
    assert.equal((await deletedAfterExchange.apply(deletion.planRef, "removed-after-exchange")).outcome, "conflict");
    assert.equal(existsSync(filename), false);
    await assert.rejects(reverts.plan({ path: raced, operationRef: deletion.planRef, idempotencyKey: "restore-absent" }), { code: "CONFLICT" });
    assert.equal(Buffer.from(journal.get(deletion.operationId).filesystem.displacedObservation.bytesBase64, "base64").toString(), interference);
    await writeFile(filename, interference);

    const crashed = await plain.plan({ path: raced, idempotencyKey: "crash-exchange", nextContent: published });
    const worker = fork(new URL(import.meta.url), ["crash-after-exchange", vault, state, crashed.planRef, "crash-exchange"],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    assert.deepEqual(await once(worker, "exit"), [91, null]);
    assert.equal(await readFile(filename, "utf8"), published, "Native crash leaves the path present before journal confirmation");
    assert.equal((await readdir(path.dirname(filename))).some(name => name.startsWith(".mcp-write-")), true);
    await backend.restoreInterruptedReplacements();
    assert.equal(journal.get(crashed.operationId).status, "committed");
    assert.equal((await plain.status(crashed.planRef)).outcome, "committed");
    assert.equal((await readdir(path.dirname(filename))).some(name => name.startsWith(".mcp-write-")), false);
  } finally {
    watcher?.close();
    if (reader?.connected) {
      const exit = once(reader, "exit"); reader.send("done"); await exit;
    }
    journal.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
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
    OPTIMIKE_VAULT_TIMEZONE: "UTC",
    LOCALAPPDATA: isolatedStateDirectory,
    MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE: "true",
  };
  async function start(mode, allowTransientAbsence = true) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["dist/index.js"], env: { ...env, OBSIDIAN_RUNTIME_MODE: mode,
        MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE: String(allowTransientAbsence),
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
    const probeId = "00000000-0000-4000-8000-000000000001";
    const orphan = `.mcp-exchange-${probeId}-a.tmp`;
    const nonempty = `.mcp-exchange-${probeId}-b.tmp`;
    const unrelated = ".mcp-exchange-backup-a.tmp";
    await writeFile(path.join(vault, orphan), "");
    await writeFile(path.join(vault, "Archive", orphan), "");
    await writeFile(path.join(vault, "Archive", nonempty), "preserve");
    await writeFile(path.join(vault, "Archive", unrelated), "");
    const guarded = await start("headless-guarded");
    for (const file of [orphan, `Archive/${orphan}`]) await assert.rejects(read(file), { code: "ENOENT" });
    assert.equal(await read(`Archive/${nonempty}`), "preserve");
    assert.equal(await read(`Archive/${unrelated}`), "");
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
    await inject("probe-failure-cleanup", "unused", "unused");
    for (const client of [guarded, first]) {
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      for (const hidden of ["obsidian_search_replace", "obsidian_manage_frontmatter", "obsidian_update_note", "obsidian_manage_tags", "obsidian_batch_frontmatter", "bases_upsert_rows"]) {
        assert.ok(!tools.includes(hidden), `${hidden} must be hidden in writable headless modes`);
      }
    }
    const bypass = await first.callTool({ name: "bases_upsert_rows", arguments: { base_id: "Records.base",
      operations: [{ file: "Note.md", set: { created_at: "1999-01-01T00:00:00", updated_at: "1999-01-01T00:00:00" } }] } });
    assert.equal(bypass.isError, true);
    assert.equal(await read("Note.md"), initial, "The retired direct Base row write cannot forge managed dates");
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
      ["crash-before-status", 89, "conflict", initial],
      ["edit-at-displacement", 0, "conflict", interference],
      ["blocked-displacement", 0, "failed", initial],
      ["recreated-before-link", 0, "outcome_unknown", interference],
      ["edit-displaced-after-link", 0, "outcome_unknown", published],
    ]) {
      await writeFile(path.join(vault, interrupted), initial);
      const planned = await call(first, "note_replace_plan", { path: interrupted, nextContent: published, idempotencyKey: mode });
      await inject(mode, planned.planRef, mode, exit);
      if (mode === "crash-after-displacement") {
        await assert.rejects(read(interrupted), { code: "ENOENT" });
        const restarted = await start("headless-filesystem");
        assert.equal(await read(interrupted), initial, "Startup restores the displaced note without waiting for recover");
        assert.equal((await call(restarted, "note_replace_status", { planRef: planned.planRef })).outcome, "conflict");
      }
      if (mode === "crash-before-status") {
        await assert.rejects(read(interrupted), { code: "ENOENT" });
        assert.equal((await call(second, "note_replace_status", { planRef: planned.planRef })).outcome, "conflict");
        assert.equal(await read(interrupted), initial, "First status restores the displaced note");
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
    const missingRevert = await call(first, "operation_revert_plan", { path: postflightRace,
      operationRef: changed.planRef, idempotencyKey: "deleted-note-revert" }, true);
    assert.equal(missingRevert.error.code, "CONFLICT");
    assert.equal(missingRevert.error.message, "The note no longer exists.");
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

    if (process.platform === "win32") {
      await writeFile(settingsPath, JSON.stringify(dateSettings));
      const safe = await start("headless-filesystem", false);
      await safe.callTool({ name: "obsidian_read_note", arguments: { filePath: "AGENTS.md" } });
      const unavailable = await call(safe, "text_patch_plan", patch(raced, "no-atomic-exchange"), true);
      assert.equal(unavailable.error.details.reasonCode, "headless_atomic_exchange_unavailable");
      assert.equal((await capability(safe, "governed-note-write")).reasonCode, "headless_atomic_exchange_unavailable");
      assert.equal((await capability(safe, "governed-note-create")).state, "ready");
      assert.equal(await read(raced), initial);
    }
  } finally {
    await Promise.all(liveClients.map(client => client.close()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    await rm(logs, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[2] === "observe-exchange") observePath(process.argv[3]);
else if (process.argv[2]) await injectAfterFilesystemEffect();
else {
  process.env.TZ = "UTC";
  process.env.OPTIMIKE_VAULT_TIMEZONE = "UTC";
  await checkDates();
  await integration();
  if (process.platform === "linux" || process.platform === "darwin") await checkAtomicExchange();
  console.log("PASS: headless governed lifecycles, cross-process CAS, crash observation, revert, and date policy");
}
