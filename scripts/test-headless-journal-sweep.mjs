import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
const [mode, ...args] = process.argv.slice(2);
const isolation = mode ? undefined : await import("./test-support/isolated-state.mjs");
const fixtureRoot = mode ? undefined : mkdtempSync(path.join(realpathSync(os.tmpdir()), "optimike-sweep-"));
if (fixtureRoot) {
  mkdirSync(path.join(fixtureRoot, "vault"));
  process.env.OBSIDIAN_RUNTIME_MODE = "headless-filesystem";
  process.env.OBSIDIAN_VAULT = path.join(fixtureRoot, "vault");
}
const { PathLocks, filesystemLockDirectory, filesystemPathLock, vaultIdentity } =
  await import("../dist/services/operations/filesystemNoteBackend.js");
const { sweepHeadlessJournal } = await import("../dist/services/operations/headlessJournalSweep.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
if (mode === "hold") {
  const [vault, notePath] = args;
  const binding = vaultIdentity(vault);
  await new PathLocks(filesystemLockDirectory(vault, binding)).run(filesystemPathLock(notePath), async () => {
    const release = once(process, "message");
    process.send("ready");
    await release;
  });
  process.disconnect();
} else if (mode === "interrupt") {
  await sweepHeadlessJournal(...args, () => process.exit(91));
  assert.fail("The sweep did not reach the crash injection point");
} else {
  await testSweep();
}

async function testSweep() {
  const root = fixtureRoot;
  const vault = path.join(root, "vault");
  const state = path.join(root, "state");
  const journalPath = path.join(state, "fixture.sqlite");
  const removedDirectory = journalPath + ".removed";
  for (const directory of [state, removedDirectory]) mkdirSync(directory);
  const env = {
    ...isolation.isolatedStateEnv(), OBSIDIAN_RUNTIME_MODE: "headless-filesystem", OBSIDIAN_VAULT: vault,
    MCP_HEADLESS_GOVERNED_JOURNAL_PATH: journalPath, TZ: "UTC",
  };
  const script = fileURLToPath(new URL("../dist/headless-journal-maintenance.js", import.meta.url));
  const call = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args], { env, encoding: "utf8" }));
  const rowStatus = id => {
    const db = new DatabaseSync(journalPath, { readOnly: true });
    try { return db.prepare("SELECT status FROM obsidian_note_replace_plans WHERE operation_id = ?").get(id)?.status; }
    finally { db.close(); }
  };
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const binding = vaultIdentity(vault);
  const before = "# Retained before image\n";
  const digest = createHash("sha256").update(before).digest("hex");
  const journal = new ObsidianNoteReplaceJournal(journalPath, { now: () => old, plannedRetentionMs: 0 });
  const make = (name, status, copy = before, retainState = false) => {
    const plan = journal.create({ path: name, idempotencyKey: name, requestDigest: digest,
      beforeSha256: digest, afterSha256: digest, nextContent: "Stage", bindingFingerprint: binding,
      ...(retainState ? { projection: { contractVersion: 1, kind: "obsidian.operation.revert",
        publicIdempotencyKey: name, intentDigest: digest, proof: { restoreAbsence: true } } } : {}),
      filesystem: { policyDigest: digest, beforeContent: before } });
    const witness = path.join(vault, `.mcp-write-${plan.operationId}.tmp`);
    writeFileSync(witness, copy);
    const retained = path.join(removedDirectory, plan.operationId + ".md");
    if (retainState) writeFileSync(retained, before);
    if (status === "applying") journal.renewExecutionLease();
    if (status !== "planned") {
      const applying = journal.transition(plan.operationId, ["planned"], "applying");
      if (status === "outcome_unknown") {
        journal.recordFilesystemStage(plan.operationId, applying.executionOwner.attemptId, "fixture-staged", digest, before);
        journal.recordFilesystemDivergence(plan.operationId, { sha256: digest, bytesBase64: Buffer.from(before).toString("base64") });
        journal.confirmFilesystemWitnessCleanup(plan.operationId);
      } else if (status === "committed") journal.commitAfterVerifiedProof(plan.operationId, ["applying"]);
    }
    return { id: plan.operationId, witness, retained };
  };
  let holder;
  try {
    const planned = make("Planned.md", "planned");
    const running = make("Running.md", "applying");
    const recovery = make("Recovery.md", "outcome_unknown");
    const locked = make("Locked.md", "committed", before, true);
    const unproven = make("Only copy.md", "committed", "# Unique displaced edit\n");
    const unknown = path.join(vault, `.mcp-write-${randomUUID()}.tmp`);
    const unrelated = path.join(vault, ".mcp-exchange-backup-a.tmp");
    const probe = path.join(vault, `.mcp-exchange-${randomUUID()}-a.tmp`);
    const recentProbe = path.join(vault, `.mcp-exchange-${randomUUID()}-b.tmp`);
    const outOfScope = path.join(state, `${randomUUID()}.md`);
    const viaLink = path.join(state, `.mcp-exchange-${randomUUID()}-a.tmp`);
    symlinkSync(state, path.join(vault, "Linked"), process.platform === "win32" ? "junction" : "dir");
    for (const file of [unknown, unrelated, probe, recentProbe, outOfScope, viaLink]) writeFileSync(file, "");
    for (const file of [probe, viaLink]) utimesSync(file, old / 1000, old / 1000);
    assert.equal(spawnSync(process.execPath, [script], { env }).status, 1, "The sweep requires an explicit action");
    assert.equal(existsSync(probe), true);

    const preview = call("--dry-run");
    assert.deepEqual(preview.entries.map(entry => entry.id ?? entry.path).sort(), [path.basename(probe), locked.id].sort());
    assert.equal(existsSync(probe), true, "The preview lists the probe without removing it");
    assert.equal(existsSync(locked.witness), true, "The preview lists expired evidence without removing it");

    holder = fork(new URL(import.meta.url), ["hold", vault, "Locked.md"], { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const [ready] = await once(holder, "message");
    assert.equal(ready, "ready");
    assert.deepEqual(call("--apply", preview.planDigest), { mode: "apply", removed: 1, skipped: 1 });
    const released = once(holder, "exit");
    holder.send("release");
    assert.deepEqual(await released, [0, null]);
    assert.equal(existsSync(locked.witness), true);
    assert.equal(rowStatus(locked.id), "committed");

    const beforeCrash = call("--dry-run");
    const child = fork(new URL(import.meta.url), ["interrupt", vault, journalPath, beforeCrash.planDigest],
      { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    assert.deepEqual(await once(child, "exit"), [91, null]);
    assert.equal(existsSync(locked.witness), false);
    assert.equal(readFileSync(locked.retained, "utf8"), before);
    assert.equal(rowStatus(locked.id), "committed", "The journal still owns the evidence after an interrupted sweep");
    const stale = spawnSync(process.execPath, [script, "--apply", beforeCrash.planDigest], { env, encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /preview changed/u);
    const retry = call("--dry-run");
    assert.deepEqual(call("--apply", retry.planDigest), { mode: "apply", removed: 1, skipped: 0 });
    assert.equal(existsSync(locked.retained), false);
    assert.equal(rowStatus(locked.id), undefined);
    assert.deepEqual(call("--dry-run").entries, []);

    for (const [entry, status] of [[planned, "planned"], [running, "applying"], [recovery, "outcome_unknown"], [unproven, "committed"]]) {
      assert.equal(existsSync(entry.witness), true, status);
      assert.equal(rowStatus(entry.id), status);
    }
    for (const file of [unknown, unrelated, recentProbe, outOfScope, viaLink]) assert.equal(existsSync(file), true);
    console.log("PASS: headless journal sweep previews, preserves recoverable and locked work, and resumes safely after a crash");
  } finally {
    if (holder?.connected) {
      const exit = once(holder, "exit");
      holder.send("release");
      await exit;
    }
    journal.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
