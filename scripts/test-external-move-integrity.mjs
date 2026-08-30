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
const { BackendVaultSessionChangedError } = await import(
  "../dist/services/externalReferences/backendVaultAdapter.js"
);
const { ExternalMoveJournal } = await import(
  "../dist/services/externalReferences/externalMoveJournal.js"
);
const { ExternalMoveOperationAdapter } = await import(
  "../dist/services/operations/externalMoveOperationAdapter.js"
);

const UNAVAILABLE = "native_handle_relative_mutation_unavailable";
const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-move-integrity-"),
);
const hashText = (content) =>
  createHash("sha256").update(content, "utf8").digest("hex");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function expectExternalCode(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ExternalRootError, error?.constructor?.name);
    assert.equal(error.code, expectedCode);
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

function createRootService(
  rootPath,
  capabilities = ["visible", "readable", "move"],
) {
  return ExternalRootsService.fromConfig({
    version: 1,
    roots: [
      {
        id: "pilot.move",
        path: rootPath,
        capabilities,
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
  constructor(entries) {
    this.notes = new Map(Object.entries(entries));
    this.openDestructiveSessionCalls = 0;
    this.conditionalReplaceCalls = 0;
    this.bindingFingerprint = hashText("test-binding");
    this.backendGeneration = 1;
    this.backendSessionId = "00000000-0000-4000-8000-000000000001";
    this.beforeRefreshInventory = undefined;
    this.beforeSearchPaths = undefined;
    this.beforeRead = undefined;
    this.afterRead = undefined;
  }
  async getBindingIdentity() {
    return {
      schemaVersion: 2,
      backendFingerprint: hashText("test-backend"),
      vaultFingerprint: hashText("test-vault"),
      rootConfigFingerprint: hashText("test-roots"),
      bindingFingerprint: this.bindingFingerprint,
      vaultIdentitySource: "backend_destructive_vault_attestation",
      verifiable: true,
    };
  }
  async openDestructiveSession() {
    this.openDestructiveSessionCalls += 1;
    return {
      generation: this.backendGeneration,
      sessionId: this.backendSessionId,
      bindingFingerprint: this.bindingFingerprint,
    };
  }
  async captureDestructiveSession() {
    return this.openDestructiveSession();
  }
  assertDestructiveSession(session) {
    if (
      session &&
      (session.generation !== this.backendGeneration ||
        session.sessionId !== this.backendSessionId)
    ) {
      throw new BackendVaultSessionChangedError();
    }
  }
  isDestructiveSessionCurrent(session) {
    try {
      this.assertDestructiveSession(session);
      return true;
    } catch {
      return false;
    }
  }
  async refreshInventory(session) {
    const hook = this.beforeRefreshInventory;
    this.beforeRefreshInventory = undefined;
    hook?.();
    this.assertDestructiveSession(session);
  }
  async assertConditionalWritesSupported(session) {
    this.assertDestructiveSession(session);
  }
  async searchCanonicalPaths() {
    return [...this.notes.keys()].sort();
  }
  async searchPaths(_query, _searchInPath, _caseSensitive, session) {
    const hook = this.beforeSearchPaths;
    this.beforeSearchPaths = undefined;
    hook?.();
    this.assertDestructiveSession(session);
    return [...this.notes.keys()].sort();
  }
  async read(filePath, session) {
    const before = this.beforeRead;
    this.beforeRead = undefined;
    before?.();
    this.assertDestructiveSession(session);
    const content = this.notes.get(filePath);
    if (content === undefined)
      throw new Error(`Missing fake note: ${filePath}`);
    const result = { filePath, content, sha256: hashText(content) };
    const after = this.afterRead;
    this.afterRead = undefined;
    after?.();
    return result;
  }
  async conditionalReplace() {
    this.conditionalReplaceCalls += 1;
    throw new Error(
      "Mutation reached the fake vault despite the fail-closed gate.",
    );
  }
}

let journal;
try {
  const rootPath = path.join(sandbox, "root");
  const archivePath = path.join(rootPath, "archive");
  await mkdir(archivePath, { recursive: true });

  const noMoveService = createRootService(rootPath, ["visible", "readable"]);
  await writeFile(path.join(rootPath, "no-move.txt"), "no move", "utf8");
  await expectExternalCode(
    () =>
      noMoveService.planMove(
        "pilot.move",
        "no-move.txt",
        "archive/no-move.txt",
      ),
    "capability_denied",
  );

  // Planning remains strict even though the result is now diagnostic-only.
  const planningService = createRootService(rootPath);
  await writeFile(path.join(rootPath, "planning.txt"), "planning", "utf8");
  await expectExternalCode(
    () =>
      planningService.planMove(
        "pilot.move",
        "planning.txt",
        "missing/planning.txt",
      ),
    "not_a_directory",
  );
  await writeFile(path.join(archivePath, "occupied.txt"), "occupied", "utf8");
  await expectExternalCode(
    () =>
      planningService.planMove(
        "pilot.move",
        "planning.txt",
        "archive/occupied.txt",
      ),
    "target_exists",
  );

  const sourcePath = path.join(rootPath, "source.txt");
  const targetPath = path.join(archivePath, "source.txt");
  await writeFile(sourcePath, "immutable external source", "utf8");
  const roots = createRootService(rootPath);
  const servicePlan = await roots.planMove(
    "pilot.move",
    "source.txt",
    "archive/source.txt",
  );
  const sourceBeforeServiceMutation = await readFile(sourcePath);
  await expectExternalCode(() => roots.applyMove(servicePlan), "unsupported");
  await expectExternalCode(
    () => roots.rollbackMove(servicePlan),
    "unsupported",
  );
  await expectExternalCode(
    () => roots.recoverMoveToSource(servicePlan),
    "unsupported",
  );
  assert.deepEqual(await readFile(sourcePath), sourceBeforeServiceMutation);
  assert.equal(await exists(targetPath), false);

  // Inventory still distinguishes one exact canonical repair from physical,
  // case/historical and ambiguous occurrences. None can become actionable.
  const sourceUri = pathToFileURL(sourcePath).href;
  const physicalLocation = await roots.getPrivateReferenceLocation(
    "pilot.move",
    "source.txt",
  );
  const inventoryVault = new FakeVault({
    "Inventory/Canonical.md": `[Source](${sourceUri}) \`external-ref:pilot.move::source.txt\`\n`,
    "Inventory/Physical.md": `Legacy physical reference: ${physicalLocation.absolutePath}\n`,
    "Inventory/Case.md": `[Case](${sourceUri.toUpperCase()}) \`external-ref:pilot.move::source.txt\`\n`,
    "Inventory/Historical.md": `Historical external-ref:pilot.move::source.txt\n`,
    "Inventory/Ambiguous.md": `[Ambiguous](${sourceUri}) \`external-ref:pilot.move::other.txt\`\n`,
  });
  const inventoryJournal = new ExternalMoveJournal(":memory:");
  const inventoryCoordinator = new ExternalMoveCoordinator(
    roots,
    inventoryVault,
    inventoryJournal,
  );
  const inventoryPlan = await inventoryCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "source.txt",
    targetRelativePath: "archive/source.txt",
    idempotencyKey: "inventory-manual-review-plan",
  });
  assert.equal(inventoryPlan.repairs.length, 1);
  assert.ok(
    inventoryPlan.manualReview.length >= 3,
    JSON.stringify(inventoryPlan.manualReview),
  );
  assert.equal(inventoryPlan.readyToApply, false);
  assert.equal(inventoryPlan.nextAction, "none");
  assert.equal(inventoryPlan.mutationAvailable, false);
  assert.equal(inventoryVault.conditionalReplaceCalls, 0);
  inventoryJournal.close();

  // All legacy gates are open. A diagnostic plan/status remains available, but
  // no mutation may reach the journal, backend, vault or filesystem.
  const notePath = "Efforts/Projets/Pilot.md";
  const noteBefore = `[Source](${sourceUri}) \`external-ref:pilot.move::source.txt\`\n`;
  const vault = new FakeVault({ [notePath]: noteBefore });
  const journalPath = path.join(sandbox, "fail-closed.sqlite");
  journal = new ExternalMoveJournal(journalPath);
  const coordinator = new ExternalMoveCoordinator(roots, vault, journal);
  const plan = await coordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "source.txt",
    targetRelativePath: "archive/source.txt",
    idempotencyKey: "fail-closed-coordinator-plan",
  });
  assert.equal(plan.status, "planned");
  assert.equal(plan.readyToApply, false);
  assert.equal(plan.nextAction, "none");
  assert.equal(plan.mutationAvailable, false);
  assert.equal(plan.mutationUnavailableReason, UNAVAILABLE);
  const replay = await coordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "source.txt",
    targetRelativePath: "archive/source.txt",
    idempotencyKey: "fail-closed-coordinator-plan",
  });
  assert.equal(replay.planId, plan.planId);
  assert.equal(replay.inventoryDigest, plan.inventoryDigest);
  await expectExternalCode(
    () =>
      coordinator.plan({
        rootId: "pilot.move",
        sourceRelativePath: "source.txt",
        targetRelativePath: "archive/changed-intent.txt",
        idempotencyKey: "fail-closed-coordinator-plan",
      }),
    "precondition_failed",
  );
  assert.equal(
    JSON.stringify(journal.get(plan.planId)).includes("changed-intent"),
    false,
  );
  const operationSourcePath = path.join(rootPath, "operation-source.txt");
  const operationTargetPath = path.join(archivePath, "operation-source.txt");
  await writeFile(operationSourcePath, "operation source", "utf8");
  const adapter = new ExternalMoveOperationAdapter(coordinator);
  const operationPlan = await adapter.plan({
    rootId: "pilot.move",
    sourceRelativePath: "operation-source.txt",
    targetRelativePath: "archive/operation-source.txt",
    idempotencyKey: "fail-closed-operation-plan",
  });
  assert.equal(operationPlan.applyAllowed, false);
  assert.equal(operationPlan.recoveryAllowed, false);
  const journalBeforeMutation = await snapshotJournalFamily(journalPath);
  const sourceBeforeMutation = await readFile(sourcePath);
  const noteBeforeMutation = vault.notes.get(notePath);
  const sessionsBeforeMutation = vault.openDestructiveSessionCalls;
  const repairsBeforeMutation = vault.conditionalReplaceCalls;

  await expectExternalCode(
    () => coordinator.apply(plan.planId, plan.idempotencyKey),
    "unsupported",
  );
  await expectExternalCode(
    () => coordinator.rollback(plan.planId, plan.idempotencyKey),
    "unsupported",
  );
  await expectExternalCode(
    () => adapter.recover(operationPlan.planRef, operationPlan.idempotencyKey),
    "unsupported",
  );
  assert.deepEqual(await readFile(sourcePath), sourceBeforeMutation);
  assert.equal(await exists(targetPath), false);
  assert.equal(await readFile(operationSourcePath, "utf8"), "operation source");
  assert.equal(await exists(operationTargetPath), false);
  assert.equal(vault.notes.get(notePath), noteBeforeMutation);
  assert.equal(vault.openDestructiveSessionCalls, sessionsBeforeMutation);
  assert.equal(vault.conditionalReplaceCalls, repairsBeforeMutation);
  assert.deepEqual(
    await snapshotJournalFamily(journalPath),
    journalBeforeMutation,
    "Unsupported mutation paths must not alter journal bytes, WAL, or metadata.",
  );

  const status = coordinator.status(plan.planId);
  assert.equal(status.status, "planned");
  assert.equal(status.readyToApply, false);
  assert.equal(status.nextAction, "none");
  assert.equal(status.mutationAvailable, false);
  assert.equal(status.mutationUnavailableReason, UNAVAILABLE);
  assert.equal(
    status.bindingFingerprint,
    undefined,
    "P0 status must not publish private binding state.",
  );

  // Every planning observation is fenced. A session swap at refresh, search,
  // read, or immediately after the last read cannot leave a durable receipt.
  for (const stage of ["refresh", "search", "read", "after-read"]) {
    const sessionVault = new FakeVault({
      [`Session/${stage}.md`]: `[Source](${sourceUri}) \`external-ref:pilot.move::source.txt\`\n`,
    });
    const sessionJournal = new ExternalMoveJournal(":memory:");
    const sessionCoordinator = new ExternalMoveCoordinator(
      roots,
      sessionVault,
      sessionJournal,
    );
    const swap = () => {
      sessionVault.backendSessionId = `replacement-${stage}`;
    };
    if (stage === "refresh") sessionVault.beforeRefreshInventory = swap;
    if (stage === "search") sessionVault.beforeSearchPaths = swap;
    if (stage === "read") sessionVault.beforeRead = swap;
    if (stage === "after-read") sessionVault.afterRead = swap;
    const sessionKey = `planning-session-swap-${stage}`;
    await assert.rejects(
      () =>
        sessionCoordinator.plan({
          rootId: "pilot.move",
          sourceRelativePath: "source.txt",
          targetRelativePath: `archive/session-${stage}.txt`,
          idempotencyKey: sessionKey,
        }),
      (error) => error instanceof BackendVaultSessionChangedError,
    );
    assert.equal(sessionJournal.getByIdempotencyKey(sessionKey), undefined);
    assert.equal(sessionVault.conditionalReplaceCalls, 0);
    assert.deepEqual(await readFile(sourcePath), sourceBeforeMutation);
    sessionJournal.close();
  }

  // P0 privacy/tamper proof: an unknown failure is a stable redacted incident;
  // status must neither leak it nor normalize/rewrite the durable receipt.
  const privateSentinel = "private-unknown-recovery-taxonomy";
  const stored = journal.get(plan.planId);
  stored.status = "recovery_required";
  stored.failure = privateSentinel;
  stored.recoveryErrors = [privateSentinel];
  journal.db
    .prepare(
      "UPDATE external_move_plans SET status = ?, payload_json = ? WHERE plan_id = ?",
    )
    .run(stored.status, JSON.stringify(stored), stored.planId);
  const tamperedJournalStateBeforeStatus = JSON.stringify(
    journal.get(plan.planId),
  );
  const tamperedStatus = coordinator.status(plan.planId);
  assert.equal(tamperedStatus.status, "recovery_required");
  assert.equal(tamperedStatus.nextAction, "none");
  assert.equal(tamperedStatus.readyToApply, false);
  assert.equal(tamperedStatus.mutationAvailable, false);
  assert.equal(tamperedStatus.mutationUnavailableReason, UNAVAILABLE);
  assert.equal(tamperedStatus.failureCode, "external_root_non_verifiable");
  assert.equal(JSON.stringify(tamperedStatus).includes(privateSentinel), false);
  assert.equal(
    JSON.stringify(journal.get(plan.planId)),
    tamperedJournalStateBeforeStatus,
    "P0 status must not rewrite a hostile receipt.",
  );
  await expectExternalCode(
    () => coordinator.rollback(plan.planId, plan.idempotencyKey),
    "unsupported",
  );
  assert.equal(vault.openDestructiveSessionCalls, sessionsBeforeMutation);
  assert.equal(vault.conditionalReplaceCalls, repairsBeforeMutation);
  assert.deepEqual(await readFile(sourcePath), sourceBeforeMutation);
  assert.equal(vault.notes.get(notePath), noteBeforeMutation);

  journal.close();
  journal = undefined;
  console.log("External move integrity tests passed.");
} finally {
  journal?.close();
  await rm(sandbox, { recursive: true, force: true });
}
