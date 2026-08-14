#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianNoteReplaceJournal } from "../dist/services/operations/obsidianNoteReplaceJournal.js";
import { ObsidianNoteReplaceOperationAdapter } from "../dist/services/operations/obsidianNoteReplaceOperationAdapter.js";
import {
  OPERATION_RUNTIME_CONTRACT_VERSION,
  operationDigest,
} from "../dist/services/operations/contract.js";
import { BaseErrorCode } from "../dist/types-global/errors.js";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function spawnCreateWorker(config) {
  const child = spawn(
    process.execPath,
    ["scripts/fixtures/obsidian-note-replace-create-worker.mjs"],
    {
      cwd: process.cwd(),
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
          reject(new Error(stderr || stdout || `worker exited ${code}`));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    }),
  };
}

async function waitForFiles(files, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!files.every((file) => existsSync(file))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${files.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function projection(publicKey, identity, label) {
  return {
    contractVersion: 1,
    kind: "obsidian.frontmatter.patch",
    publicIdempotencyKey: publicKey,
    intentDigest: identity,
    proof: {
      contractVersion: 1,
      compilerVersion: 1,
      label,
    },
  };
}

const temporaryRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-p1-idempotency-"),
);
try {
  {
    const databasePath = path.join(temporaryRoot, "same-intent.sqlite");
    new ObsidianNoteReplaceJournal(databasePath).close();
    const startPath = path.join(temporaryRoot, "same-intent.start");
    const readyPaths = [
      path.join(temporaryRoot, "same-intent-a.ready"),
      path.join(temporaryRoot, "same-intent-b.ready"),
    ];
    const publicKey = "p1-cross-process-same-intent";
    const identity = sha256("canonical frontmatter intent");
    const common = {
      idempotencyKey: sha256(`obsidian.frontmatter.patch:v1\0${publicKey}`),
      idempotencyIdentity: identity,
      path: "Fixture/Cross Process.md",
      beforeSha256: sha256("before"),
      bindingFingerprint: sha256("fixture-binding"),
    };
    const inputs = [
      {
        ...common,
        requestDigest: sha256("compiled from snapshot A"),
        afterSha256: sha256("after A"),
        nextContent: "after A",
        projection: projection(publicKey, identity, "snapshot-a"),
      },
      {
        ...common,
        requestDigest: sha256("compiled from snapshot B"),
        beforeSha256: sha256("before B"),
        afterSha256: sha256("after B"),
        nextContent: "after B",
        projection: projection(publicKey, identity, "snapshot-b"),
      },
    ];
    const workers = inputs.map((input, index) =>
      spawnCreateWorker({
        databasePath,
        readyPath: readyPaths[index],
        startPath,
        input,
      }),
    );
    await waitForFiles(readyPaths);
    writeFileSync(startPath, "go", "utf8");
    const [first, second] = await Promise.all(
      workers.map((worker) => worker.completion),
    );
    assert.equal(first.operationId, second.operationId);
    assert.equal(first.idempotencyIdentity, identity);
    assert.equal(second.idempotencyIdentity, identity);
    assert.equal(first.afterSha256, second.afterSha256);
    assert.deepEqual(first.projection, second.projection);

    const journal = new ObsidianNoteReplaceJournal(databasePath);
    const winner = journal.getByIdempotencyKey(common.idempotencyKey);
    assert.equal(winner.operationId, first.operationId);
    journal.close();
  }

  {
    const databasePath = path.join(
      temporaryRoot,
      "concurrent-different-intent.sqlite",
    );
    new ObsidianNoteReplaceJournal(databasePath).close();
    const startPath = path.join(
      temporaryRoot,
      "concurrent-different-intent.start",
    );
    const readyPaths = [
      path.join(temporaryRoot, "concurrent-different-intent-a.ready"),
      path.join(temporaryRoot, "concurrent-different-intent-b.ready"),
    ];
    const key = sha256("p1-concurrent-different-intent-key");
    const identities = [sha256("intent A"), sha256("intent B")];
    const workers = identities.map((identity, index) =>
      spawnCreateWorker({
        databasePath,
        readyPath: readyPaths[index],
        startPath,
        captureError: true,
        input: {
          idempotencyKey: key,
          requestDigest: sha256(`request ${index}`),
          idempotencyIdentity: identity,
          projection: projection("public-race-key", identity, `intent-${index}`),
          path: "Fixture/Concurrent Different Intent.md",
          beforeSha256: sha256("before"),
          afterSha256: sha256(`after ${index}`),
          nextContent: `after ${index}`,
          bindingFingerprint: sha256("fixture-binding"),
        },
      }),
    );
    await waitForFiles(readyPaths);
    writeFileSync(startPath, "go", "utf8");
    const results = await Promise.all(
      workers.map((worker) => worker.completion),
    );
    const conflicts = results.filter((result) => result.error);
    const winners = results.filter((result) => !result.error);
    assert.equal(winners.length, 1);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].error.code, BaseErrorCode.CONFLICT);
    assert.equal(
      conflicts[0].error.details?.reason,
      "note_replace_idempotency_conflict",
    );
  }

  {
    const databasePath = path.join(temporaryRoot, "different-intent.sqlite");
    const journal = new ObsidianNoteReplaceJournal(databasePath);
    const key = sha256("p1-different-intent-key");
    const firstIdentity = sha256("intent one");
    const secondIdentity = sha256("intent two");
    journal.create({
      idempotencyKey: key,
      requestDigest: sha256("request one"),
      idempotencyIdentity: firstIdentity,
      projection: projection("public-key", firstIdentity, "one"),
      path: "Fixture/Different Intent.md",
      beforeSha256: sha256("before"),
      afterSha256: sha256("after one"),
      nextContent: "after one",
      bindingFingerprint: sha256("fixture-binding"),
    });
    assert.throws(
      () =>
        journal.create({
          idempotencyKey: key,
          requestDigest: sha256("request two"),
          idempotencyIdentity: secondIdentity,
          projection: projection("public-key", secondIdentity, "two"),
          path: "Fixture/Different Intent.md",
          beforeSha256: sha256("before"),
          afterSha256: sha256("after two"),
          nextContent: "after two",
          bindingFingerprint: sha256("fixture-binding"),
        }),
      (error) => {
        assert.equal(error.code, BaseErrorCode.CONFLICT);
        assert.equal(
          error.details?.reason,
          "note_replace_idempotency_conflict",
        );
        return true;
      },
    );
    assert.equal(
      journal.getByIdempotencyKey(key).idempotencyIdentity,
      firstIdentity,
    );
    journal.close();
  }

  {
    const databasePath = path.join(temporaryRoot, "legacy.sqlite");
    const journal = new ObsidianNoteReplaceJournal(databasePath);
    const key = "legacy-direct-p0-key";
    journal.create({
      idempotencyKey: key,
      requestDigest: sha256("legacy request one"),
      path: "Fixture/Legacy.md",
      beforeSha256: sha256("before"),
      afterSha256: sha256("after one"),
      nextContent: "after one",
      bindingFingerprint: sha256("fixture-binding"),
    });
    assert.throws(
      () =>
        journal.create({
          idempotencyKey: key,
          requestDigest: sha256("legacy request two"),
          path: "Fixture/Legacy.md",
          beforeSha256: sha256("before"),
          afterSha256: sha256("after two"),
          nextContent: "after two",
          bindingFingerprint: sha256("fixture-binding"),
        }),
      (error) => {
        assert.equal(error.code, BaseErrorCode.CONFLICT);
        assert.equal(
          error.details?.reason,
          "note_replace_idempotency_conflict",
        );
        return true;
      },
    );
    journal.close();
  }

  {
    const databasePath = path.join(temporaryRoot, "p0-digest.sqlite");
    const journal = new ObsidianNoteReplaceJournal(databasePath);
    const pathValue = "Fixture/P0 Digest.md";
    const before = "before";
    const after = "after";
    const binding = sha256("p0-binding");
    const backend = {
      async status() {
        return {
          ok: true,
          contractVersion: 1,
          plugin: { id: "obsidian-atomic-write-bridge", version: "0.1.0" },
          backend: {
            kind: "obsidian-vault-process",
            bindingFingerprint: binding,
            atomicCas: true,
            writeEnabled: true,
          },
          limits: { markdownOnly: true },
        };
      },
      async read({ path }) {
        return {
          ok: true,
          contractVersion: 1,
          path,
          content: before,
          sha256: sha256(before),
          size: Buffer.byteLength(before),
          bindingFingerprint: binding,
        };
      },
      async replace() {
        throw new Error("replace is not used by the digest fixture");
      },
    };
    const adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal);
    const receipt = await adapter.plan({
      path: pathValue,
      nextContent: after,
      idempotencyKey: "p0-digest-key",
    });
    const persisted = journal.getByIdempotencyKey("p0-digest-key");
    const expectedRequestDigest = operationDigest({
      operationKind: "obsidian.note.replace",
      path: pathValue,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      bindingFingerprint: binding,
    });
    assert.equal(persisted.requestDigest, expectedRequestDigest);
    assert.equal(persisted.idempotencyIdentity, undefined);
    assert.equal(persisted.projection, undefined);
    const expectedPlanDigest = operationDigest({
      contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
      operationKind: "obsidian.note.replace",
      operationId: persisted.operationId,
      idempotencyKey: persisted.idempotencyKey,
      backendBinding: binding,
      path: pathValue,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      requestDigest: expectedRequestDigest,
    });
    assert.equal(receipt.planDigest, expectedPlanDigest);
    journal.close();
  }

  console.log(
    "PASS: P1 idempotency converges across processes on one intent winner, rejects different intents, preserves legacy P0 key semantics, and leaves direct P0 request/plan digests unchanged.",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
