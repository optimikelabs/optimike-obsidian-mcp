import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianNoteReplaceOperationAdapter } from "../dist/services/operations/obsidianNoteReplaceOperationAdapter.js";
import {
  ObsidianNoteReplaceConcurrencyError,
  ObsidianNoteReplaceJournal,
} from "../dist/services/operations/obsidianNoteReplaceJournal.js";
import { requestLogMetadata } from "../dist/services/obsidianRestAPI/requestLogMetadata.js";
import { BaseErrorCode, McpError } from "../dist/types-global/errors.js";

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function spawnJournalCreateWorker(config) {
  const child = spawn(
    process.execPath,
    ["scripts/fixtures/obsidian-note-replace-create-worker.mjs"],
    {
      env: {
        ...process.env,
        OBSIDIAN_NOTE_REPLACE_CREATE_WORKER: JSON.stringify(config),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    completion: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Journal create worker exited with ${code}: ${stderr || stdout}`,
            ),
          );
          return;
        }
        resolve(JSON.parse(stdout));
      });
    }),
  };
}

async function waitForFiles(paths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => existsSync(candidate))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for worker barriers: ${paths.join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeAtomicWriteBackend {
  bindingFingerprint = sha256("fixture-vault-instance");
  path = "Fixture/Note.md";
  content = "before";
  replaceCalls = 0;
  failBeforeWriteOnce = false;
  rejectBeforeWriteOnce = false;
  loseResponseAfterWriteOnce = false;
  afterStatus = undefined;
  afterRead = undefined;
  beforeWrite = undefined;
  afterWriteBeforeReturn = undefined;

  async status() {
    const response = {
      ok: true,
      contractVersion: 1,
      plugin: { id: "obsidian-atomic-write-bridge", version: "0.1.0" },
      backend: {
        kind: "obsidian-vault-process",
        bindingFingerprint: this.bindingFingerprint,
        atomicCas: true,
        writeEnabled: true,
      },
      limits: { markdownOnly: true },
    };
    if (this.afterStatus) {
      const afterStatus = this.afterStatus;
      this.afterStatus = undefined;
      await afterStatus();
    }
    return response;
  }

  async read(payload) {
    assert.equal(payload.path, this.path);
    const response = {
      ok: true,
      contractVersion: 1,
      path: this.path,
      content: this.content,
      sha256: sha256(this.content),
      size: Buffer.byteLength(this.content, "utf8"),
      bindingFingerprint: this.bindingFingerprint,
    };
    if (this.afterRead) {
      const afterRead = this.afterRead;
      this.afterRead = undefined;
      await afterRead();
    }
    return response;
  }

  async replace(payload) {
    this.replaceCalls += 1;
    if (this.rejectBeforeWriteOnce) {
      this.rejectBeforeWriteOnce = false;
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Atomic note writes are disabled in the bridge settings.",
      );
    }
    if (payload.bindingFingerprint !== this.bindingFingerprint) {
      throw new McpError(BaseErrorCode.CONFLICT, "Fixture binding conflict.");
    }
    if (this.failBeforeWriteOnce) {
      this.failBeforeWriteOnce = false;
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Fixture lost the request before the write.",
      );
    }
    if (this.beforeWrite) {
      const beforeWrite = this.beforeWrite;
      this.beforeWrite = undefined;
      await beforeWrite();
    }
    const beforeSha256 = sha256(this.content);
    if (beforeSha256 !== payload.expectedSha256) {
      throw new McpError(BaseErrorCode.CONFLICT, "Fixture hash conflict.");
    }
    this.content = payload.nextContent;
    if (this.afterWriteBeforeReturn) {
      await this.afterWriteBeforeReturn();
      this.afterWriteBeforeReturn = undefined;
    }
    if (this.loseResponseAfterWriteOnce) {
      this.loseResponseAfterWriteOnce = false;
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Fixture lost the response after the write.",
      );
    }
    return {
      ok: true,
      contractVersion: 1,
      path: this.path,
      beforeSha256,
      afterSha256: sha256(this.content),
      size: Buffer.byteLength(this.content, "utf8"),
      bindingFingerprint: this.bindingFingerprint,
    };
  }
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "optimike-note-op-"));
const journals = [];

function fixture(name) {
  const backend = new FakeAtomicWriteBackend();
  const journal = new ObsidianNoteReplaceJournal(
    path.join(temporaryRoot, `${name}.sqlite`),
  );
  journals.push(journal);
  return {
    backend,
    adapter: new ObsidianNoteReplaceOperationAdapter(backend, journal),
  };
}

try {
  {
    const { backend, adapter } = fixture("commit-replay");
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "after",
      idempotencyKey: "commit-replay",
    });
    assert.equal(planned.phase, "planned");
    assert.equal(planned.applyAllowed, true);
    assert.equal(
      (await adapter.status(planned.planRef)).planDigest,
      planned.planDigest,
    );
    const committed = await adapter.apply(planned.planRef, "commit-replay");
    assert.equal(committed.outcome, "committed");
    assert.equal(committed.postflight.status, "verified");
    assert.equal(backend.content, "after");
    assert.equal(backend.replaceCalls, 1);
    const replay = await adapter.apply(planned.planRef, "commit-replay");
    assert.equal(replay.outcome, "committed");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("conflict");
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "after",
      idempotencyKey: "conflict",
    });
    backend.content = "concurrent edit";
    const result = await adapter.apply(planned.planRef, "conflict");
    assert.equal(result.outcome, "conflict");
    assert.equal(backend.content, "concurrent edit");
  }

  {
    const { backend, adapter } = fixture("disabled-between-status-and-cas");
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "must not be written after disable",
      idempotencyKey: "disabled-between-status-and-cas",
    });
    backend.rejectBeforeWriteOnce = true;
    const result = await adapter.apply(
      planned.planRef,
      "disabled-between-status-and-cas",
    );
    assert.equal(result.outcome, "rejected");
    assert.equal(result.recoveryAllowed, false);
    assert.equal(backend.content, "before");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("binding-conflict");
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "must not reach another vault",
      idempotencyKey: "binding-conflict",
    });
    backend.afterStatus = async () => {
      backend.bindingFingerprint = sha256("different-vault-instance");
    };
    const result = await adapter.apply(planned.planRef, "binding-conflict");
    assert.equal(result.outcome, "conflict");
    assert.equal(backend.content, "before");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("lost-response");
    backend.loseResponseAfterWriteOnce = true;
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "written despite lost response",
      idempotencyKey: "lost-response",
    });
    const result = await adapter.apply(planned.planRef, "lost-response");
    assert.equal(result.outcome, "committed");
    assert.equal(result.postflight.status, "verified");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("lost-response-then-drift");
    backend.loseResponseAfterWriteOnce = true;
    backend.afterWriteBeforeReturn = async () => {
      backend.content = "third-party edit after successful hidden write";
    };
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "written before subsequent drift",
      idempotencyKey: "lost-response-then-drift",
    });
    const result = await adapter.apply(
      planned.planRef,
      "lost-response-then-drift",
    );
    assert.equal(result.outcome, "outcome_unknown");
    assert.equal(result.recoveryAllowed, true);
    assert.equal(
      backend.content,
      "third-party edit after successful hidden write",
    );
  }

  {
    const { backend, adapter } = fixture("concurrent-status");
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "committed during concurrent status",
      idempotencyKey: "concurrent-status",
    });
    backend.afterWriteBeforeReturn = async () => {
      const concurrent = await adapter.status(planned.planRef);
      assert.equal(concurrent.outcome, "committed");
    };
    const committed = await adapter.apply(planned.planRef, "concurrent-status");
    assert.equal(committed.outcome, "committed");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("concurrent-apply");
    let releaseWrite;
    let markWriteEntered;
    const writeEntered = new Promise((resolve) => {
      markWriteEntered = resolve;
    });
    const writeReleased = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    backend.beforeWrite = async () => {
      markWriteEntered();
      await writeReleased;
    };
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "one write despite concurrent apply",
      idempotencyKey: "concurrent-apply",
    });
    const firstApply = adapter.apply(planned.planRef, "concurrent-apply");
    await writeEntered;
    const replay = await adapter.apply(planned.planRef, "concurrent-apply");
    assert.equal(replay.phase, "applying");
    assert.equal(replay.outcome, null);
    assert.equal(backend.replaceCalls, 1);
    releaseWrite();
    const committed = await firstApply;
    assert.equal(committed.outcome, "committed");
    assert.equal(backend.content, "one write despite concurrent apply");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("concurrent-recover");
    let releaseWrite;
    let markWriteEntered;
    const writeEntered = new Promise((resolve) => {
      markWriteEntered = resolve;
    });
    const writeReleased = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    backend.beforeWrite = async () => {
      markWriteEntered();
      await writeReleased;
    };
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "one write despite concurrent recovery",
      idempotencyKey: "concurrent-recover",
    });
    const firstApply = adapter.apply(planned.planRef, "concurrent-recover");
    await writeEntered;
    const recovery = await adapter.recover(
      planned.planRef,
      "concurrent-recover",
    );
    assert.equal(recovery.phase, "applying");
    assert.equal(recovery.outcome, null);
    assert.equal(backend.replaceCalls, 1);
    releaseWrite();
    const committed = await firstApply;
    assert.equal(committed.outcome, "committed");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("recover-same-plan");
    backend.failBeforeWriteOnce = true;
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "recovered",
      idempotencyKey: "recover-same-plan",
    });
    const unknown = await adapter.apply(planned.planRef, "recover-same-plan");
    assert.equal(unknown.outcome, "outcome_unknown");
    assert.equal(unknown.recoveryAllowed, true);
    assert.equal(backend.content, "before");
    const recovered = await adapter.recover(
      planned.planRef,
      "recover-same-plan",
    );
    assert.equal(recovered.outcome, "committed");
    assert.equal(backend.content, "recovered");
    assert.equal(backend.replaceCalls, 2);
  }

  {
    const { backend, adapter } = fixture("concurrent-recovery-replay");
    backend.failBeforeWriteOnce = true;
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "one write despite concurrent recovery replay",
      idempotencyKey: "concurrent-recovery-replay",
    });
    const unknown = await adapter.apply(
      planned.planRef,
      "concurrent-recovery-replay",
    );
    assert.equal(unknown.outcome, "outcome_unknown");

    let releaseFirstRead;
    let markFirstReadEntered;
    const firstReadEntered = new Promise((resolve) => {
      markFirstReadEntered = resolve;
    });
    const firstReadReleased = new Promise((resolve) => {
      releaseFirstRead = resolve;
    });
    backend.afterRead = async () => {
      markFirstReadEntered();
      await firstReadReleased;
    };

    let releaseWrite;
    let markWriteEntered;
    const writeEntered = new Promise((resolve) => {
      markWriteEntered = resolve;
    });
    const writeReleased = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    backend.beforeWrite = async () => {
      markWriteEntered();
      await writeReleased;
    };

    const losingRecovery = adapter.recover(
      planned.planRef,
      "concurrent-recovery-replay",
    );
    await firstReadEntered;
    const winningRecovery = adapter.recover(
      planned.planRef,
      "concurrent-recovery-replay",
    );
    await writeEntered;
    releaseFirstRead();
    const replay = await losingRecovery;
    assert.equal(replay.phase, "applying");
    assert.equal(replay.outcome, null);
    assert.equal(backend.replaceCalls, 2);
    releaseWrite();
    const committed = await winningRecovery;
    assert.equal(committed.outcome, "committed");
    assert.equal(
      backend.content,
      "one write despite concurrent recovery replay",
    );
    assert.equal(backend.replaceCalls, 2);
  }

  {
    const { backend, adapter } = fixture("recover-race-to-after");
    backend.failBeforeWriteOnce = true;
    const planned = await adapter.plan({
      path: backend.path,
      nextContent: "appeared between recovery reads",
      idempotencyKey: "recover-race-to-after",
    });
    const unknown = await adapter.apply(
      planned.planRef,
      "recover-race-to-after",
    );
    assert.equal(unknown.outcome, "outcome_unknown");
    backend.afterRead = async () => {
      backend.content = "appeared between recovery reads";
    };
    const recovered = await adapter.recover(
      planned.planRef,
      "recover-race-to-after",
    );
    assert.equal(recovered.outcome, "committed");
    assert.equal(backend.replaceCalls, 1);
  }

  {
    const { backend, adapter } = fixture("idempotency-binding");
    await adapter.plan({
      path: backend.path,
      nextContent: "first",
      idempotencyKey: "same-key",
    });
    backend.content = "changed after the plan was sealed";
    const replay = await adapter.plan({
      path: backend.path,
      nextContent: "first",
      idempotencyKey: "same-key",
    });
    assert.equal(replay.idempotencyKey, "same-key");
    await assert.rejects(
      adapter.plan({
        path: backend.path,
        nextContent: "different",
        idempotencyKey: "same-key",
      }),
      /different note replacement/u,
    );
  }

  {
    const databasePath = path.join(
      temporaryRoot,
      "multiprocess-idempotent-plan.sqlite",
    );
    const initializedJournal = new ObsidianNoteReplaceJournal(databasePath);
    initializedJournal.close();
    const startPath = path.join(temporaryRoot, "multiprocess-plan.start");
    const input = {
      idempotencyKey: "multiprocess-same-key",
      requestDigest: sha256("multiprocess-same-request"),
      path: "Fixture/Multiprocess.md",
      beforeSha256: sha256("before"),
      afterSha256: sha256("after"),
      nextContent: "after",
      bindingFingerprint: sha256("fixture-vault-instance"),
    };
    const readyPaths = [
      path.join(temporaryRoot, "multiprocess-plan-a.ready"),
      path.join(temporaryRoot, "multiprocess-plan-b.ready"),
    ];
    const workers = readyPaths.map((readyPath) =>
      spawnJournalCreateWorker({ databasePath, readyPath, startPath, input }),
    );
    await waitForFiles(readyPaths);
    writeFileSync(startPath, "go", "utf8");
    const [first, second] = await Promise.all(
      workers.map((worker) => worker.completion),
    );
    assert.equal(first.operationId, second.operationId);
    assert.equal(first.idempotencyKey, input.idempotencyKey);
    assert.equal(second.requestDigest, input.requestDigest);
  }

  {
    const privateBody = "private vault content that must not be logged";
    const metadata = requestLogMetadata({
      method: "POST",
      url: "/extensions/obsidian-atomic-write-bridge/notes/cas",
      data: { nextContent: privateBody },
      headers: { Authorization: "Bearer private-token" },
    });
    const serialized = JSON.stringify(metadata);
    assert.equal(metadata.hasBody, true);
    assert.equal(serialized.includes(privateBody), false);
    assert.equal(serialized.includes("private-token"), false);
  }

  {
    const restartPath = path.join(temporaryRoot, "restart-interruption.sqlite");
    const firstJournal = new ObsidianNoteReplaceJournal(restartPath);
    const applying = firstJournal.create({
      idempotencyKey: "restart-interruption",
      requestDigest: sha256("restart-interruption-request"),
      path: "Fixture/Restart.md",
      beforeSha256: sha256("before"),
      afterSha256: sha256("after"),
      nextContent: "retained exact recovery content",
      bindingFingerprint: sha256("fixture-vault-instance"),
    });
    firstJournal.transition(applying.operationId, ["planned"], "applying");
    firstJournal.close();
    const restartedJournal = new ObsidianNoteReplaceJournal(restartPath);
    journals.push(restartedJournal);
    const interrupted = restartedJournal.get(applying.operationId);
    assert.equal(interrupted.status, "outcome_unknown");
    assert.equal(interrupted.nextContent, "retained exact recovery content");
    assert.match(
      interrupted.failure,
      /process restarted|owning runtime closed/u,
    );
  }

  {
    const sharedPath = path.join(temporaryRoot, "live-owner.sqlite");
    let leaseNow = Date.parse("2026-08-13T00:00:00.000Z");
    const leaseOptions = {
      now: () => leaseNow,
      executionLeaseMs: 1_000,
      executionSweepIntervalMs: 100,
    };
    const ownerJournal = new ObsidianNoteReplaceJournal(
      sharedPath,
      leaseOptions,
    );
    journals.push(ownerJournal);
    const applying = ownerJournal.create({
      idempotencyKey: "live-owner",
      requestDigest: sha256("live-owner-request"),
      path: "Fixture/LiveOwner.md",
      beforeSha256: sha256("before"),
      afterSha256: sha256("after"),
      nextContent: "content owned by the live executor",
      bindingFingerprint: sha256("fixture-vault-instance"),
    });
    const originalExecution = ownerJournal.transition(
      applying.operationId,
      ["planned"],
      "applying",
    );
    const observerJournal = new ObsidianNoteReplaceJournal(
      sharedPath,
      leaseOptions,
    );
    journals.push(observerJournal);
    assert.equal(observerJournal.get(applying.operationId).status, "applying");
    // A restarted process can reuse the same OS PID (for example PID 1 in a
    // container). Only expiry of the previous instance lease proves that its
    // executor disappeared.
    leaseNow += 2_000;
    const interrupted = observerJournal.get(applying.operationId);
    assert.equal(interrupted.status, "outcome_unknown");
    assert.match(interrupted.failure, /process restarted/u);
    observerJournal.renewExecutionLease();
    const recoveredExecution = observerJournal.transition(
      applying.operationId,
      ["outcome_unknown"],
      "applying",
    );
    assert.notEqual(
      recoveredExecution.executionOwner.instanceId,
      originalExecution.executionOwner.instanceId,
    );
    assert.throws(
      () =>
        ownerJournal.transition(
          applying.operationId,
          ["applying"],
          "conflict",
          "stale executor must not terminalize the recovered owner",
          originalExecution.executionOwner.instanceId,
        ),
      ObsidianNoteReplaceConcurrencyError,
    );
    assert.equal(
      observerJournal.get(applying.operationId).executionOwner.instanceId,
      recoveredExecution.executionOwner.instanceId,
    );
    ownerJournal.close();
    observerJournal.close();
  }

  {
    let now = Date.parse("2026-08-13T00:00:00.000Z");
    const retentionPath = path.join(temporaryRoot, "retention.sqlite");
    const sensitiveTerminalContent =
      "sensitive-terminal-content-4ec0d4b4-erase-from-wal";
    const journal = new ObsidianNoteReplaceJournal(retentionPath, {
      now: () => now,
      terminalRetentionMs: 1_000,
      purgeIntervalMs: 100,
    });
    journals.push(journal);
    const terminal = journal.create({
      idempotencyKey: "retention-terminal",
      requestDigest: sha256("retention-request"),
      path: "Fixture/Retention.md",
      beforeSha256: sha256("before"),
      afterSha256: sha256("after"),
      nextContent: sensitiveTerminalContent,
      bindingFingerprint: sha256("fixture-vault-instance"),
    });
    const terminalApplying = journal.transition(
      terminal.operationId,
      ["planned"],
      "applying",
    );
    const committed = journal.transition(
      terminal.operationId,
      ["applying"],
      "committed",
      undefined,
      terminalApplying.executionOwner.instanceId,
    );
    assert.equal(committed.nextContent, "");
    for (const persistedPath of [retentionPath, `${retentionPath}-wal`]) {
      if (!existsSync(persistedPath)) continue;
      assert.equal(
        readFileSync(persistedPath).includes(
          Buffer.from(sensitiveTerminalContent, "utf8"),
        ),
        false,
      );
    }
    now += 2_000;
    journal.create({
      idempotencyKey: "retention-trigger",
      requestDigest: sha256("retention-trigger"),
      path: "Fixture/Trigger.md",
      beforeSha256: sha256("before"),
      afterSha256: sha256("next"),
      nextContent: "next",
      bindingFingerprint: sha256("fixture-vault-instance"),
    });
    assert.equal(journal.get(terminal.operationId), undefined);
  }

  console.log(
    "Obsidian note replacement operation fixture passed: plan/apply/status/recover, backend binding, atomic conflict, concurrent replay, live-owner isolation, redacted logging/WAL, and lost-response reconciliation.",
  );
} finally {
  for (const journal of journals) journal.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
