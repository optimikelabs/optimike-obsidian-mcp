import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Import-time policy gates are deliberately all permissive. The assertions
// prove that the all-platform fail-closed mutation boundary still wins.
process.env.MCP_EXTERNAL_MOVE_ENABLED = "true";
process.env.MCP_WRITE_MODE = "full";
process.env.OBSIDIAN_RUNTIME_MODE = "headless-filesystem";
process.env.OBSIDIAN_VAULT = os.tmpdir();

const { ExternalRootError, ExternalRootsService } = await import(
  "../dist/services/externalRootsService.js"
);
const { ExternalMoveCoordinator } = await import(
  "../dist/services/externalReferences/externalMoveCoordinator.js"
);
const { ExternalMoveJournal } = await import(
  "../dist/services/externalReferences/externalMoveJournal.js"
);

const UNAVAILABLE = "native_handle_relative_mutation_unavailable";
const STATUSES = [
  "planned",
  "applying_file",
  "file_moved",
  "applying_repairs",
  "applied",
  "rolling_back_repairs",
  "rolling_back_file",
  "rolled_back",
  "failed_compensated",
  "recovery_required",
  "applying",
  "rolling_back",
  "failed",
];
const PARTIAL_STATUSES = new Set([
  "applying",
  "applying_file",
  "file_moved",
  "applying_repairs",
  "rolling_back",
  "rolling_back_repairs",
  "rolling_back_file",
  "failed",
  "recovery_required",
]);
const EPHEMERAL_STALE_STATUSES = new Set([
  "planned",
  "applied",
  "rolled_back",
  "failed_compensated",
]);
const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-move-status-security-"),
);

const hashText = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function expectUnsupported(operation) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ExternalRootError, error?.constructor?.name);
    assert.equal(error.code, "unsupported");
    return true;
  });
}

async function snapshotJournalFamily(journalPath) {
  const directory = path.dirname(journalPath);
  const extension = path.extname(journalPath);
  const stem = path.basename(journalPath, extension);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matcher = new RegExp(
    `^${escape(stem)}(?:\\.[a-f0-9]{24})?${escape(extension)}(?:-(?:shm|wal))?$`,
    "u",
  );
  const names = (await readdir(directory))
    .filter((name) => matcher.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(directory, name);
      const metadata = await stat(filePath, { bigint: true });
      return {
        name,
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
        bytes: Buffer.from(await readFile(filePath)).toString("base64"),
      };
    }),
  );
}

function createRoots(rootPath) {
  return ExternalRootsService.fromConfig({
    version: 1,
    roots: [
      {
        id: "pilot.move",
        path: rootPath,
        capabilities: ["visible", "readable", "move"],
        include: ["**"],
        exclude: [],
        limits: {
          maxDepth: 6,
          maxFileBytes: 1024 * 1024,
          maxListEntries: 100,
          maxTextChars: 100_000,
        },
      },
    ],
  });
}

class FakeVault {
  constructor(entries, sessionId = "00000000-0000-4000-8000-000000000001") {
    this.notes = new Map(Object.entries(entries));
    this.sessionId = sessionId;
    this.bindingFingerprint = hashText("status-security-binding");
    this.backendCalls = 0;
    this.conditionalReplaceCalls = 0;
  }

  async getBindingIdentity() {
    this.backendCalls += 1;
    return {
      schemaVersion: 2,
      backendFingerprint: hashText("status-security-backend"),
      vaultFingerprint: hashText("status-security-vault"),
      rootConfigFingerprint: hashText("status-security-roots"),
      bindingFingerprint: this.bindingFingerprint,
      vaultIdentitySource: "backend_destructive_vault_attestation",
      verifiable: true,
    };
  }

  async openDestructiveSession() {
    this.backendCalls += 1;
    return {
      generation: 1,
      sessionId: this.sessionId,
      bindingFingerprint: this.bindingFingerprint,
    };
  }

  async captureDestructiveSession() {
    return this.openDestructiveSession();
  }

  assertDestructiveSession(session) {
    if (
      session &&
      (session.generation !== 1 || session.sessionId !== this.sessionId)
    ) {
      throw new Error("The fake backend session changed.");
    }
  }

  isDestructiveSessionCurrent(session) {
    return (
      session?.generation === 1 &&
      session?.sessionId === this.sessionId &&
      session?.bindingFingerprint === this.bindingFingerprint
    );
  }

  async refreshInventory(session) {
    this.backendCalls += 1;
    this.assertDestructiveSession(session);
  }

  async assertConditionalWritesSupported(session) {
    this.backendCalls += 1;
    this.assertDestructiveSession(session);
  }

  async searchPaths(_query, _searchInPath, _caseSensitive, session) {
    this.backendCalls += 1;
    this.assertDestructiveSession(session);
    return [...this.notes.keys()].sort();
  }

  async read(filePath, session) {
    this.backendCalls += 1;
    this.assertDestructiveSession(session);
    const content = this.notes.get(filePath);
    if (content === undefined)
      throw new Error(`Missing fake note: ${filePath}`);
    return { filePath, content, sha256: hashText(content) };
  }

  async conditionalReplace() {
    this.conditionalReplaceCalls += 1;
    throw new Error("A fail-closed move must never write the backend.");
  }
}

function instrumentRoots(roots) {
  let calls = 0;
  const methods = [
    "inspectMoveSource",
    "getPrivateMoveLocations",
    "applyMove",
    "rollbackMove",
    "recoverMoveToSource",
  ];
  for (const method of methods) {
    const original = roots[method].bind(roots);
    roots[method] = async (...args) => {
      calls += 1;
      return original(...args);
    };
  }
  return () => calls;
}

function assertUnavailableProjection(view) {
  assert.equal(view.readyToApply, false);
  assert.equal(view.mutationAvailable, false);
  assert.equal(view.mutationUnavailableReason, UNAVAILABLE);
  assert.equal(view.nextAction, "none");
}

function replaceStoredPlan(journal, plan) {
  journal.db
    .prepare(
      "UPDATE external_move_plans SET status = ?, payload_json = ?, updated_at = ? WHERE plan_id = ?",
    )
    .run(plan.status, JSON.stringify(plan), plan.updatedAt, plan.planId);
}

async function removeSandbox() {
  // SQLite's Windows handle release can lag a synchronous close by one event
  // turn. Retrying cleanup keeps this test's pass/fail signal independent of
  // that platform detail and never touches data outside its mkdtemp root.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(sandbox, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY") throw error;
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

let openJournal;
try {
  const rootPath = path.join(sandbox, "root");
  const archivePath = path.join(rootPath, "archive");
  const sourcePath = path.join(rootPath, "source.txt");
  const targetPath = path.join(archivePath, "source.txt");
  await mkdir(archivePath, { recursive: true });
  await writeFile(sourcePath, "status security source", "utf8");

  const roots = createRoots(rootPath);
  const rootCallCount = instrumentRoots(roots);
  const sourceUri = pathToFileURL(sourcePath).href;
  const notePath = "Efforts/Projets/Status security.md";
  const note = `[Source](${sourceUri}) \`external-ref:pilot.move::source.txt\`\n`;
  const journalPath = path.join(sandbox, "status-security.sqlite");

  // Matrix A: every persisted state is safely inspectable after a restart
  // against the same attested backend session. Status is read-only; all apply
  // and rollback attempts fail at the global mutation boundary first.
  for (const status of STATUSES) {
    let journal = new ExternalMoveJournal(journalPath);
    const planningVault = new FakeVault({ [notePath]: note });
    const planningCoordinator = new ExternalMoveCoordinator(
      roots,
      planningVault,
      journal,
    );
    const planned = await planningCoordinator.plan({
      rootId: "pilot.move",
      sourceRelativePath: "source.txt",
      targetRelativePath: "archive/source.txt",
      idempotencyKey: `status-matrix-${status}`,
    });
    const stored = journal.get(planned.planId);
    stored.status = status;
    stored.failure = undefined;
    stored.recoveryErrors = [];
    replaceStoredPlan(journal, stored);
    journal.close();

    journal = new ExternalMoveJournal(journalPath);
    openJournal = journal;
    const restartedVault = new FakeVault({ [notePath]: note });
    const coordinator = new ExternalMoveCoordinator(
      roots,
      restartedVault,
      journal,
    );
    const familyBefore = await snapshotJournalFamily(journalPath);
    const rootBefore = rootCallCount();
    const backendBefore = restartedVault.backendCalls;
    const view = coordinator.status(planned.planId);
    assert.equal(view.status, status, `same-session ${status} status`);
    assertUnavailableProjection(view);
    assert.equal(
      rootCallCount(),
      rootBefore,
      `status ${status} must not read roots`,
    );
    assert.equal(
      restartedVault.backendCalls,
      backendBefore,
      `status ${status} must not call the backend`,
    );
    assert.deepEqual(
      await snapshotJournalFamily(journalPath),
      familyBefore,
      `status ${status} must not rewrite the journal family`,
    );

    await expectUnsupported(() =>
      coordinator.apply(planned.planId, planned.idempotencyKey),
    );
    await expectUnsupported(() =>
      coordinator.rollback(planned.planId, planned.idempotencyKey),
    );
    assert.equal(
      rootCallCount(),
      rootBefore,
      `mutations ${status} must not read roots`,
    );
    assert.equal(
      restartedVault.backendCalls,
      backendBefore,
      `mutations ${status} must not call the backend`,
    );
    assert.equal(restartedVault.conditionalReplaceCalls, 0);
    assert.deepEqual(
      await readFile(sourcePath, "utf8"),
      "status security source",
    );
    assert.equal(await exists(targetPath), false);
    assert.deepEqual(
      await snapshotJournalFamily(journalPath),
      familyBefore,
      `unsupported mutations ${status} must not alter any journal-family file`,
    );
    journal.close();
    openJournal = undefined;
  }

  // Matrix B: after a real backend restart, partial receipts become a durable
  // manual incident. Non-partial receipts remain immutable and receive only
  // an ephemeral unavailable-session projection. Neither path resumes work.
  for (const status of STATUSES) {
    let journal = new ExternalMoveJournal(journalPath);
    const firstVault = new FakeVault({ [notePath]: note });
    const firstCoordinator = new ExternalMoveCoordinator(
      roots,
      firstVault,
      journal,
    );
    const planned = await firstCoordinator.plan({
      rootId: "pilot.move",
      sourceRelativePath: "source.txt",
      targetRelativePath: "archive/source.txt",
      idempotencyKey: `restart-matrix-${status}`,
    });
    const stored = journal.get(planned.planId);
    stored.status = status;
    stored.failure = undefined;
    stored.recoveryErrors = [];
    replaceStoredPlan(journal, stored);
    journal.close();

    journal = new ExternalMoveJournal(journalPath);
    openJournal = journal;
    const restartedVault = new FakeVault(
      { [notePath]: note },
      `00000000-0000-4000-8000-${String(STATUSES.indexOf(status) + 2).padStart(12, "0")}`,
    );
    const coordinator = new ExternalMoveCoordinator(
      roots,
      restartedVault,
      journal,
    );
    const rootBefore = rootCallCount();
    const backendBefore = restartedVault.backendCalls;
    const familyBefore = await snapshotJournalFamily(journalPath);
    const view = coordinator.status(planned.planId);
    assert.equal(
      view.status,
      "recovery_required",
      `stale ${status} projection`,
    );
    assertUnavailableProjection(view);
    assert.equal(view.failureCode, "backend_session_changed");
    assert.equal(
      rootCallCount(),
      rootBefore,
      `stale ${status} must not read roots`,
    );
    assert.equal(
      restartedVault.backendCalls,
      backendBefore,
      `stale ${status} must not call the backend`,
    );

    const durable = journal.get(planned.planId);
    if (PARTIAL_STATUSES.has(status)) {
      assert.equal(
        durable.status,
        "recovery_required",
        `${status} durable incident`,
      );
      assert.deepEqual(durable.recoveryErrors, ["backend_session_changed"]);
      assert.notDeepEqual(
        await snapshotJournalFamily(journalPath),
        familyBefore,
        `${status} must durably record the lost-session incident`,
      );
    } else {
      assert.ok(
        EPHEMERAL_STALE_STATUSES.has(status),
        `unexpected stale status ${status}`,
      );
      assert.equal(durable.status, status, `${status} must remain immutable`);
      assert.deepEqual(
        await snapshotJournalFamily(journalPath),
        familyBefore,
        `${status} must stay an ephemeral projection`,
      );
    }
    await expectUnsupported(() =>
      coordinator.apply(planned.planId, planned.idempotencyKey),
    );
    await expectUnsupported(() =>
      coordinator.rollback(planned.planId, planned.idempotencyKey),
    );
    assert.equal(rootCallCount(), rootBefore);
    assert.equal(restartedVault.backendCalls, backendBefore);
    assert.deepEqual(
      await readFile(sourcePath, "utf8"),
      "status security source",
    );
    assert.equal(await exists(targetPath), false);
    journal.close();
    openJournal = undefined;
  }

  async function makeTamperCase(key) {
    const journal = new ExternalMoveJournal(journalPath);
    const firstVault = new FakeVault({ [notePath]: note });
    const coordinator = new ExternalMoveCoordinator(roots, firstVault, journal);
    const plan = await coordinator.plan({
      rootId: "pilot.move",
      sourceRelativePath: "source.txt",
      targetRelativePath: "archive/source.txt",
      idempotencyKey: key,
    });
    const partial = journal.get(plan.planId);
    partial.status = "applying_file";
    replaceStoredPlan(journal, partial);
    return { journal, plan, preloaded: journal.get(plan.planId) };
  }

  async function assertTamperNoWrite(
    { journal, plan, preloaded },
    mutate,
    sentinel,
  ) {
    const hostile = journal.get(plan.planId);
    mutate(hostile);
    replaceStoredPlan(journal, hostile);
    const rootBefore = rootCallCount();
    const replacementVault = new FakeVault(
      { [notePath]: note },
      "00000000-0000-4000-8000-000000000099",
    );
    const coordinator = new ExternalMoveCoordinator(
      roots,
      replacementVault,
      journal,
    );
    // SQLite may update volatile SHM reader bookkeeping on a first SELECT.
    // Prove first that it did not alter the durable row, then snapshot the
    // entire family and repeat the hostile status assertion byte-for-byte.
    const durableBefore = JSON.stringify(journal.get(plan.planId));
    const warmup = coordinator.status(plan.planId, preloaded);
    assert.equal(warmup.status, "recovery_required");
    assertUnavailableProjection(warmup);
    assert.equal(JSON.stringify(journal.get(plan.planId)), durableBefore);
    const familyBefore = await snapshotJournalFamily(journalPath);
    const view = coordinator.status(plan.planId, preloaded);
    assert.equal(view.status, "recovery_required");
    assertUnavailableProjection(view);
    assert.equal(JSON.stringify(view).includes(sentinel), false);
    assert.equal(
      rootCallCount(),
      rootBefore,
      "tampered status must not read roots",
    );
    assert.equal(
      replacementVault.backendCalls,
      0,
      "tampered status must not call backend",
    );
    assert.deepEqual(
      await snapshotJournalFamily(journalPath),
      familyBefore,
      "tampered status must preserve SQLite main/WAL/SHM bytes and mtimes",
    );
    await expectUnsupported(() =>
      coordinator.apply(plan.planId, plan.idempotencyKey),
    );
    await expectUnsupported(() =>
      coordinator.rollback(plan.planId, plan.idempotencyKey),
    );
    assert.equal(rootCallCount(), rootBefore);
    assert.equal(replacementVault.backendCalls, 0);
    assert.deepEqual(
      await readFile(sourcePath, "utf8"),
      "status security source",
    );
    assert.equal(await exists(targetPath), false);
    journal.close();
  }

  // A stale preloaded receipt is not authority for a changed durable binding
  // or a changed sealed intent. Status must render the prior receipt as an
  // unavailable incident, rather than overwriting/adopting the replacement.
  await assertTamperNoWrite(
    await makeTamperCase("tamper-foreign-binding"),
    (hostile) => {
      const foreign = hashText("foreign-binding-sentinel");
      hostile.bindingIdentity.bindingFingerprint = foreign;
      hostile.destructiveSession.bindingFingerprint = foreign;
    },
    "foreign-binding-sentinel",
  );
  await assertTamperNoWrite(
    await makeTamperCase("tamper-changed-intent"),
    (hostile) => {
      hostile.snapshot.targetRelativePath =
        "archive/foreign-intent-sentinel.txt";
    },
    "foreign-intent-sentinel",
  );
  await assertTamperNoWrite(
    await makeTamperCase("tamper-hostile-path"),
    (hostile) => {
      hostile.snapshot.sourceRelativePath = "..\\hostile-path-sentinel";
    },
    "hostile-path-sentinel",
  );

  // A caller-supplied plan ID cannot be paired with another preloaded receipt.
  // This is a value-free projection and it leaves the persistent receipt alone.
  const mismatch = await makeTamperCase("tamper-plan-id-mismatch");
  const mismatchFamilyBefore = await snapshotJournalFamily(journalPath);
  const mismatchVault = new FakeVault({ [notePath]: note });
  const mismatchCoordinator = new ExternalMoveCoordinator(
    roots,
    mismatchVault,
    mismatch.journal,
  );
  const mismatchView = mismatchCoordinator.status(
    "33333333-3333-4333-8333-333333333333",
    mismatch.preloaded,
  );
  assert.equal(mismatchView.planId, "[redacted]");
  assertUnavailableProjection(mismatchView);
  assert.equal(mismatchVault.backendCalls, 0);
  assert.deepEqual(
    await snapshotJournalFamily(journalPath),
    mismatchFamilyBefore,
  );
  mismatch.journal.close();

  console.log("External move status security tests passed.");
} finally {
  openJournal?.close();
  await removeSandbox();
}
