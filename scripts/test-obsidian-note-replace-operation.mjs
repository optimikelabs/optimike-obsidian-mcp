import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianNoteReplaceOperationAdapter } from "../dist/services/operations/obsidianNoteReplaceOperationAdapter.js";
import { ObsidianNoteReplaceJournal } from "../dist/services/operations/obsidianNoteReplaceJournal.js";
import { requestLogMetadata } from "../dist/services/obsidianRestAPI/requestLogMetadata.js";
import { BaseErrorCode, McpError } from "../dist/types-global/errors.js";

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

class FakeAtomicWriteBackend {
  bindingFingerprint = sha256("fixture-vault-instance");
  path = "Fixture/Note.md";
  content = "before";
  replaceCalls = 0;
  failBeforeWriteOnce = false;
  loseResponseAfterWriteOnce = false;
  beforeWrite = undefined;
  afterWriteBeforeReturn = undefined;

  async status() {
    return {
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
  }

  async read(payload) {
    assert.equal(payload.path, this.path);
    return {
      ok: true,
      contractVersion: 1,
      path: this.path,
      content: this.content,
      sha256: sha256(this.content),
      size: Buffer.byteLength(this.content, "utf8"),
      bindingFingerprint: this.bindingFingerprint,
    };
  }

  async replace(payload) {
    this.replaceCalls += 1;
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
    journal.transition(terminal.operationId, ["planned"], "applying");
    const committed = journal.transition(
      terminal.operationId,
      ["applying"],
      "committed",
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
    "Obsidian note replacement operation fixture passed: plan/apply/status/recover, atomic conflict, concurrent replay, redacted logging/WAL, and lost-response reconciliation.",
  );
} finally {
  for (const journal of journals) journal.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
