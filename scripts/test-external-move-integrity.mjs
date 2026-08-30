import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The coordinator reads these gates when its config module is first imported.
process.env.MCP_EXTERNAL_MOVE_ENABLED = "true";
process.env.MCP_WRITE_MODE = "full";
process.env.OBSIDIAN_RUNTIME_MODE = "headless-readonly";
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

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-external-move-integrity-"),
);

function hashText(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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
    assert.ok(
      error instanceof ExternalRootError,
      `Expected ExternalRootError, received ${error?.constructor?.name}`,
    );
    assert.equal(error.code, expectedCode);
    return true;
  });
}

async function expectSessionChanged(operation) {
  await assert.rejects(
    operation,
    (error) => error instanceof BackendVaultSessionChangedError,
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

const PRIVATE_BACKEND_SENTINEL = "private-backend-failure-sentinel-9f21";
const PRIVATE_CODE_SHAPED_LEGACY_SENTINEL =
  "external_root_private_legacy_sentinel";
const TEST_BACKEND_FINGERPRINT = hashText("test-backend");
const TEST_VAULT_FINGERPRINT = hashText("test-vault");
const TEST_ROOTS_FINGERPRINT = hashText("test-roots");
const TEST_BINDING_FINGERPRINT = hashText("test-binding");
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000001";

class FakeVault {
  constructor(entries = {}) {
    this.notes = new Map(Object.entries(entries));
    this.bindingFingerprint = TEST_BINDING_FINGERPRINT;
    this.backendGeneration = 1;
    this.backendSessionId = TEST_SESSION_ID;
    this.conditionalWritesSupported = true;
    this.openDestructiveSessionCalls = 0;
    this.conditionalReplaceCalls = 0;
    this.failConditionalReplaceAt = undefined;
    this.failConditionalReplaceError = undefined;
    this.beforeConditionalReplace = undefined;
    this.beforeRefreshInventory = undefined;
    this.beforeSearchPaths = undefined;
    this.beforeRead = undefined;
    this.afterRead = undefined;
  }

  async getBindingIdentity() {
    return {
      schemaVersion: 2,
      backendFingerprint: TEST_BACKEND_FINGERPRINT,
      vaultFingerprint: TEST_VAULT_FINGERPRINT,
      rootConfigFingerprint: TEST_ROOTS_FINGERPRINT,
      bindingFingerprint: this.bindingFingerprint,
      vaultIdentitySource: "backend_destructive_vault_attestation",
      verifiable: true,
    };
  }

  async openDestructiveSession(expectedBinding, expectedSession) {
    this.openDestructiveSessionCalls += 1;
    if (expectedSession) this.assertDestructiveSession(expectedSession);
    const identity = await this.getBindingIdentity();
    if (identity.bindingFingerprint !== expectedBinding.bindingFingerprint) {
      throw new Error("Fake backend binding changed.");
    }
    return {
      generation: this.backendGeneration,
      sessionId: this.backendSessionId,
      bindingFingerprint: identity.bindingFingerprint,
    };
  }

  async captureDestructiveSession(expectedBinding) {
    return this.openDestructiveSession(expectedBinding);
  }

  assertDestructiveSession(session) {
    if (
      session.generation !== this.backendGeneration ||
      session.sessionId !== this.backendSessionId
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
    if (session) this.assertDestructiveSession(session);
  }

  async assertConditionalWritesSupported(session) {
    if (session) this.assertDestructiveSession(session);
    if (!this.conditionalWritesSupported) {
      throw new Error("Conditional note writes are unavailable.");
    }
  }

  async searchPaths(query, searchInPath = "", caseSensitive = true, session) {
    const hook = this.beforeSearchPaths;
    this.beforeSearchPaths = undefined;
    hook?.();
    if (session) this.assertDestructiveSession(session);
    const normalizedQuery = caseSensitive ? query : query.toLowerCase();
    return [...this.notes.entries()]
      .filter(
        ([filePath, content]) =>
          (!searchInPath || filePath.startsWith(searchInPath)) &&
          (caseSensitive ? content : content.toLowerCase()).includes(
            normalizedQuery,
          ),
      )
      .map(([filePath]) => filePath)
      .sort((left, right) => left.localeCompare(right));
  }

  async read(filePath, session) {
    const beforeHook = this.beforeRead;
    this.beforeRead = undefined;
    beforeHook?.();
    if (session) this.assertDestructiveSession(session);
    const content = this.notes.get(filePath);
    if (content === undefined)
      throw new Error(`Missing fake note: ${filePath}`);
    const result = { filePath, content, sha256: hashText(content) };
    const afterHook = this.afterRead;
    this.afterRead = undefined;
    afterHook?.();
    return result;
  }

  async conditionalReplace(filePath, before, after, expectedSha256, session) {
    const hook = this.beforeConditionalReplace;
    this.beforeConditionalReplace = undefined;
    hook?.();
    if (session) this.assertDestructiveSession(session);
    this.conditionalReplaceCalls += 1;
    if (this.conditionalReplaceCalls === this.failConditionalReplaceAt) {
      throw (
        this.failConditionalReplaceError ??
        new Error(`Injected conditional repair failure for ${filePath}.`)
      );
    }
    const current = await this.read(filePath);
    if (current.sha256 !== expectedSha256 || current.content !== before) {
      throw new ExternalRootError(
        "precondition_failed",
        `Fake vault CAS rejected ${filePath}.`,
      );
    }
    this.notes.set(filePath, after);
  }
}

try {
  const rootPath = path.join(sandbox, "root");
  const archivePath = path.join(rootPath, "archive");
  await mkdir(archivePath, { recursive: true });

  // The move capability is never inferred from readable/visible.
  const noMoveService = createRootService(rootPath, ["visible", "readable"]);
  const noMoveSource = path.join(rootPath, "no-move.txt");
  await writeFile(noMoveSource, "no move", "utf8");
  await expectExternalCode(
    () =>
      noMoveService.planMove(
        "pilot.move",
        "no-move.txt",
        "archive/no-move.txt",
      ),
    "capability_denied",
  );

  const service = createRootService(rootPath);

  // Planning refuses a missing parent and an occupied target.
  const guardSource = path.join(rootPath, "guard.txt");
  await writeFile(guardSource, "guard", "utf8");
  await expectExternalCode(
    () => service.planMove("pilot.move", "guard.txt", "missing/guard.txt"),
    "not_a_directory",
  );
  const occupiedTarget = path.join(archivePath, "occupied.txt");
  await writeFile(occupiedTarget, "occupied", "utf8");
  await expectExternalCode(
    () => service.planMove("pilot.move", "guard.txt", "archive/occupied.txt"),
    "target_exists",
  );

  // A same-volume plan/apply/rollback preserves bytes and never overwrites.
  const roundTripSource = path.join(rootPath, "round-trip.txt");
  const roundTripTarget = path.join(archivePath, "round-trip.txt");
  await writeFile(roundTripSource, "round trip", "utf8");
  const roundTripPlan = await service.planMove(
    "pilot.move",
    "round-trip.txt",
    "archive/round-trip.txt",
  );
  await service.applyMove(roundTripPlan);
  assert.equal(await exists(roundTripSource), false);
  assert.equal(await readFile(roundTripTarget, "utf8"), "round trip");
  await service.rollbackMove(roundTripPlan);
  assert.equal(await readFile(roundTripSource, "utf8"), "round trip");
  assert.equal(await exists(roundTripTarget), false);

  // A stale source invalidates the immutable plan before any link is created.
  const staleSource = path.join(rootPath, "stale.txt");
  const staleTarget = path.join(archivePath, "stale.txt");
  await writeFile(staleSource, "version one", "utf8");
  const stalePlan = await service.planMove(
    "pilot.move",
    "stale.txt",
    "archive/stale.txt",
  );
  await writeFile(staleSource, "version two and different", "utf8");
  await expectExternalCode(
    () => service.applyMove(stalePlan),
    "precondition_failed",
  );
  assert.equal(
    await readFile(staleSource, "utf8"),
    "version two and different",
  );
  assert.equal(await exists(staleTarget), false);

  // Rollback refuses to destroy a target modified after the move.
  const changedSource = path.join(rootPath, "changed-after-move.txt");
  const changedTarget = path.join(archivePath, "changed-after-move.txt");
  await writeFile(changedSource, "original", "utf8");
  const changedPlan = await service.planMove(
    "pilot.move",
    "changed-after-move.txt",
    "archive/changed-after-move.txt",
  );
  await service.applyMove(changedPlan);
  await writeFile(changedTarget, "changed after move", "utf8");
  await expectExternalCode(
    () => service.rollbackMove(changedPlan),
    "precondition_failed",
  );
  assert.equal(await exists(changedSource), false);
  assert.equal(await readFile(changedTarget, "utf8"), "changed after move");

  // Coordinator happy path: exact canonical pair, CAS repair, then rollback.
  const coordinatedSource = path.join(rootPath, "coordinated.txt");
  const coordinatedTarget = path.join(archivePath, "coordinated.txt");
  await writeFile(coordinatedSource, "coordinated", "utf8");
  const coordinatedSourceUri = pathToFileURL(coordinatedSource).href;
  const coordinatedTargetUri = pathToFileURL(coordinatedTarget).href;
  const notePath = "Efforts/Projets/Pilot.md";
  const originalNote =
    "---\n" +
    "création: 2026-07-28T10:00\n" +
    "modification: 2026-07-28T10:00\n" +
    "type: projet\n" +
    "---\n\n" +
    `# Pilot\n\n- [Open](${coordinatedSourceUri}) — ` +
    "`external-ref:pilot.move::coordinated.txt`\n";
  const vault = new FakeVault({ [notePath]: originalNote });
  const coordinator = new ExternalMoveCoordinator(
    service,
    vault,
    new ExternalMoveJournal(":memory:"),
  );
  const coordinatedPlan = await coordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "coordinated.txt",
    targetRelativePath: "archive/coordinated.txt",
    idempotencyKey: "coordinator-round-trip",
  });
  assert.equal(
    coordinatedPlan.readyToApply,
    true,
    JSON.stringify(coordinatedPlan),
  );
  assert.equal(coordinatedPlan.repairs.length, 1);
  assert.equal(coordinatedPlan.manualReview.length, 0);

  const applied = await coordinator.apply(
    coordinatedPlan.planId,
    "coordinator-round-trip",
  );
  assert.equal(applied.status, "applied");
  assert.equal(applied.readyToApply, false);
  assert.equal(applied.nextAction, "rollback");
  assert.equal(await exists(coordinatedSource), false);
  assert.equal(await readFile(coordinatedTarget, "utf8"), "coordinated");
  const repairedNote = vault.notes.get(notePath);
  assert.ok(repairedNote.includes(coordinatedTargetUri));
  assert.ok(
    repairedNote.includes("`external-ref:pilot.move::archive/coordinated.txt`"),
  );

  // Runtime-maintained frontmatter may change after apply. Rollback must
  // preserve those current values while reverting only the canonical pair.
  const runtimeCreation = "création: 2026-07-28T10:03";
  const runtimeModification = "modification: 2026-07-28T10:04";
  vault.notes.set(
    notePath,
    repairedNote
      .replace("création: 2026-07-28T10:00", runtimeCreation)
      .replace("modification: 2026-07-28T10:00", runtimeModification),
  );
  const rolledBack = await coordinator.rollback(
    coordinatedPlan.planId,
    "coordinator-round-trip",
  );
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.readyToApply, true);
  assert.equal(rolledBack.nextAction, "apply");
  assert.equal(await readFile(coordinatedSource, "utf8"), "coordinated");
  assert.equal(await exists(coordinatedTarget), false);
  const expectedRuntimePreservingRollback = originalNote
    .replace("création: 2026-07-28T10:00", runtimeCreation)
    .replace("modification: 2026-07-28T10:00", runtimeModification);
  assert.equal(vault.notes.get(notePath), expectedRuntimePreservingRollback);

  // Any non-protected body edit after apply still blocks rollback.
  const editedBodySource = path.join(rootPath, "edited-body.txt");
  const editedBodyTarget = path.join(archivePath, "edited-body.txt");
  await writeFile(editedBodySource, "edited body", "utf8");
  const editedBodyUri = pathToFileURL(editedBodySource).href;
  const editedBodyNotePath = "Efforts/Projets/Edited body.md";
  const editedBodyVault = new FakeVault({
    [editedBodyNotePath]:
      "---\n" +
      "création: 2026-07-28T11:00\n" +
      "modification: 2026-07-28T11:00\n" +
      "---\n\n" +
      `[Body](${editedBodyUri}) ` +
      "`external-ref:pilot.move::edited-body.txt`\n",
  });
  const editedBodyCoordinator = new ExternalMoveCoordinator(
    service,
    editedBodyVault,
    new ExternalMoveJournal(":memory:"),
  );
  const editedBodyPlan = await editedBodyCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "edited-body.txt",
    targetRelativePath: "archive/edited-body.txt",
    idempotencyKey: "coordinator-edited-body",
  });
  await editedBodyCoordinator.apply(
    editedBodyPlan.planId,
    "coordinator-edited-body",
  );
  editedBodyVault.notes.set(
    editedBodyNotePath,
    `${editedBodyVault.notes.get(editedBodyNotePath)}\nConcurrent body edit.\n`,
  );
  await expectExternalCode(
    () =>
      editedBodyCoordinator.rollback(
        editedBodyPlan.planId,
        "coordinator-edited-body",
      ),
    "precondition_failed",
  );
  assert.equal(await exists(editedBodySource), false);
  assert.equal(await readFile(editedBodyTarget, "utf8"), "edited body");
  assert.ok(
    editedBodyVault.notes
      .get(editedBodyNotePath)
      .includes("Concurrent body edit."),
  );
  const editedBodyStatus = editedBodyCoordinator.status(editedBodyPlan.planId);
  assert.equal(editedBodyStatus.status, "recovery_required");
  // This is a durable ambiguous outcome, not permission to overwrite the
  // concurrent body edit. Its original failure code remains observable, but
  // the only permitted next step is human incident review.
  assert.equal(
    editedBodyStatus.failureCode,
    "external_root_precondition_failed",
  );
  assert.equal(editedBodyStatus.nextAction, "manual_review");
  assert.equal(editedBodyStatus.recoveryRequired, true);
  const editedBodyAfterFailedRollback =
    editedBodyVault.notes.get(editedBodyNotePath);
  await expectExternalCode(
    () =>
      editedBodyCoordinator.rollback(
        editedBodyPlan.planId,
        "coordinator-edited-body",
      ),
    "precondition_failed",
  );
  assert.equal(await exists(editedBodySource), false);
  assert.equal(await readFile(editedBodyTarget, "utf8"), "edited body");
  assert.equal(
    editedBodyVault.notes.get(editedBodyNotePath),
    editedBodyAfterFailedRollback,
    "a recovery retry must not overwrite a concurrent body edit",
  );
  assert.equal(
    editedBodyCoordinator.status(editedBodyPlan.planId).status,
    "recovery_required",
  );

  // Availability failures remain retryable: unlike a changed note they do not
  // attest a conflicting content or filesystem state. The projection keeps the
  // original public code and exposes the governed rollback continuation.
  const retryableRecoverySource = path.join(rootPath, "retryable-recovery.txt");
  const retryableRecoveryTarget = path.join(
    archivePath,
    "retryable-recovery.txt",
  );
  await writeFile(retryableRecoverySource, "retryable recovery", "utf8");
  const retryableRecoveryJournal = new ExternalMoveJournal(":memory:");
  const retryableRecoveryCoordinator = new ExternalMoveCoordinator(
    createRootService(rootPath),
    new FakeVault(),
    retryableRecoveryJournal,
  );
  const retryableRecoveryPlan = await retryableRecoveryCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "retryable-recovery.txt",
    targetRelativePath: "archive/retryable-recovery.txt",
    idempotencyKey: "coordinator-retryable-recovery",
  });
  retryableRecoveryJournal.transition(
    retryableRecoveryPlan.planId,
    ["planned"],
    "recovery_required",
    {
      failure: "external_root_timeout",
      recoveryErrors: ["external_root_timeout"],
    },
  );
  const retryableRecoveryStatus = retryableRecoveryCoordinator.status(
    retryableRecoveryPlan.planId,
  );
  assert.equal(retryableRecoveryStatus.status, "recovery_required");
  assert.equal(retryableRecoveryStatus.failureCode, "external_root_timeout");
  assert.equal(retryableRecoveryStatus.nextAction, "rollback");
  assert.equal(retryableRecoveryStatus.readyToApply, false);
  assert.equal(retryableRecoveryStatus.recoveryRequired, true);
  const retryableRecoveryResult = await retryableRecoveryCoordinator.rollback(
    retryableRecoveryPlan.planId,
    "coordinator-retryable-recovery",
  );
  assert.equal(retryableRecoveryResult.status, "rolled_back");
  assert.equal(
    await readFile(retryableRecoverySource, "utf8"),
    "retryable recovery",
  );
  assert.equal(await exists(retryableRecoveryTarget), false);
  retryableRecoveryJournal.close();

  // A rollback executor must claim the exact durable receipt before it even
  // inspects an ambiguous file placement. If another executor wins that
  // compare-and-swap, the loser cannot repair, recover the file, or replace
  // the winner's incident receipt. A subsequent executor that claims the
  // winner is the sole process allowed to perform recovery.
  const rollbackClaimRaceSource = path.join(
    rootPath,
    "rollback-claim-race.txt",
  );
  const rollbackClaimRaceTarget = path.join(
    archivePath,
    "rollback-claim-race.txt",
  );
  await writeFile(rollbackClaimRaceSource, "rollback claim race", "utf8");
  const rollbackClaimRaceUri = pathToFileURL(rollbackClaimRaceSource).href;
  const rollbackClaimRaceNotePath = "Efforts/Projets/Rollback claim race.md";
  const rollbackClaimRaceVault = new FakeVault({
    [rollbackClaimRaceNotePath]:
      `[Rollback claim race](${rollbackClaimRaceUri}) ` +
      "`external-ref:pilot.move::rollback-claim-race.txt`\n",
  });
  const rollbackClaimRaceService = createRootService(rootPath);
  const rollbackClaimRaceJournal = new ExternalMoveJournal(":memory:");
  const rollbackClaimRaceCoordinator = new ExternalMoveCoordinator(
    rollbackClaimRaceService,
    rollbackClaimRaceVault,
    rollbackClaimRaceJournal,
  );
  const rollbackClaimRacePlan = await rollbackClaimRaceCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "rollback-claim-race.txt",
    targetRelativePath: "archive/rollback-claim-race.txt",
    idempotencyKey: "coordinator-rollback-claim-race",
  });
  await rollbackClaimRaceCoordinator.apply(
    rollbackClaimRacePlan.planId,
    "coordinator-rollback-claim-race",
  );
  // Simulate the crash-window duplicate identity that only recovery may
  // collapse. The source and target are deliberately the same inode.
  await link(rollbackClaimRaceTarget, rollbackClaimRaceSource);
  const rollbackClaimRaceRecover =
    rollbackClaimRaceService.recoverMoveToSource.bind(rollbackClaimRaceService);
  let rollbackClaimRaceRecoverCalls = 0;
  rollbackClaimRaceService.recoverMoveToSource = async (...args) => {
    rollbackClaimRaceRecoverCalls += 1;
    return rollbackClaimRaceRecover(...args);
  };
  const rollbackClaimRaceTransition =
    rollbackClaimRaceJournal.transitionObserved.bind(rollbackClaimRaceJournal);
  let rollbackClaimRaceInjected = false;
  let rollbackClaimRaceWinner;
  rollbackClaimRaceJournal.transitionObserved = (observed, ...args) => {
    if (
      !rollbackClaimRaceInjected &&
      observed.planId === rollbackClaimRacePlan.planId &&
      observed.status === "applied"
    ) {
      rollbackClaimRaceInjected = true;
      const rival = rollbackClaimRaceJournal.observe(
        rollbackClaimRacePlan.planId,
      );
      assert.ok(rival);
      rollbackClaimRaceWinner = rollbackClaimRaceJournal.updateObserved(
        rival,
        "recovery_required",
        "backend_failure",
        { recoveryErrors: ["backend_failure"] },
      ).plan;
    }
    return rollbackClaimRaceTransition(observed, ...args);
  };
  await expectExternalCode(
    () =>
      rollbackClaimRaceCoordinator.rollback(
        rollbackClaimRacePlan.planId,
        "coordinator-rollback-claim-race",
      ),
    "non_verifiable",
  );
  assert.equal(rollbackClaimRaceInjected, true);
  assert.equal(
    rollbackClaimRaceRecoverCalls,
    0,
    "a CAS-losing rollback must not inspect or recover the duplicate file",
  );
  assert.deepEqual(
    rollbackClaimRaceJournal.get(rollbackClaimRacePlan.planId),
    rollbackClaimRaceWinner,
    "the loser must preserve the concurrent winner receipt exactly",
  );
  assert.equal(await exists(rollbackClaimRaceSource), true);
  assert.equal(await exists(rollbackClaimRaceTarget), true);

  // Once the injected winner is no longer racing, the successful exact claim
  // is the only executor that may collapse the duplicate and complete the
  // rollback.
  rollbackClaimRaceJournal.transitionObserved = rollbackClaimRaceTransition;
  const rollbackClaimRaceRolledBack =
    await rollbackClaimRaceCoordinator.rollback(
      rollbackClaimRacePlan.planId,
      "coordinator-rollback-claim-race",
    );
  assert.equal(rollbackClaimRaceRolledBack.status, "rolled_back");
  assert.equal(rollbackClaimRaceRecoverCalls, 1);
  assert.equal(await exists(rollbackClaimRaceSource), true);
  assert.equal(await exists(rollbackClaimRaceTarget), false);
  rollbackClaimRaceJournal.close();

  // A changed note fails the coordinator's CAS gate before the file move.
  const casSource = path.join(rootPath, "cas-source.txt");
  const casTarget = path.join(archivePath, "cas-source.txt");
  await writeFile(casSource, "CAS", "utf8");
  const casUri = pathToFileURL(casSource).href;
  const casNotePath = "Efforts/Projets/CAS.md";
  const casVault = new FakeVault({
    [casNotePath]:
      `[CAS](${casUri}) ` + "`external-ref:pilot.move::cas-source.txt`\n",
  });
  const casCoordinator = new ExternalMoveCoordinator(
    service,
    casVault,
    new ExternalMoveJournal(":memory:"),
  );
  const casPlan = await casCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "cas-source.txt",
    targetRelativePath: "archive/cas-source.txt",
    idempotencyKey: "coordinator-cas",
  });
  casVault.notes.set(
    casNotePath,
    `${casVault.notes.get(casNotePath)}\nConcurrent edit.\n`,
  );
  await expectExternalCode(
    () => casCoordinator.apply(casPlan.planId, "coordinator-cas"),
    "precondition_failed",
  );
  assert.equal(await readFile(casSource, "utf8"), "CAS");
  assert.equal(await exists(casTarget), false);

  // If one of several note repairs fails after an earlier repair succeeded,
  // apply compensates the repaired note and restores the external file.
  const compensationSource = path.join(rootPath, "compensation.txt");
  const compensationTarget = path.join(archivePath, "compensation.txt");
  await writeFile(compensationSource, "compensation", "utf8");
  const compensationUri = pathToFileURL(compensationSource).href;
  const compensationReference =
    `[Compensation](${compensationUri}) ` +
    "`external-ref:pilot.move::compensation.txt`\n";
  const compensationNotes = {
    "Efforts/Projets/Compensation A.md": compensationReference,
    "Efforts/Projets/Compensation B.md": compensationReference,
  };
  const compensationVault = new FakeVault(compensationNotes);
  const compensationCoordinator = new ExternalMoveCoordinator(
    service,
    compensationVault,
    new ExternalMoveJournal(":memory:"),
  );
  const compensationPlan = await compensationCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "compensation.txt",
    targetRelativePath: "archive/compensation.txt",
    idempotencyKey: "coordinator-compensation",
  });
  assert.equal(compensationPlan.repairs.length, 2);
  compensationVault.failConditionalReplaceAt = 2;
  compensationVault.failConditionalReplaceError = new Error(
    PRIVATE_BACKEND_SENTINEL,
  );
  await assert.rejects(
    () =>
      compensationCoordinator.apply(
        compensationPlan.planId,
        "coordinator-compensation",
      ),
    /external move did not complete/u,
  );
  const compensatedStatus = compensationCoordinator.status(
    compensationPlan.planId,
  );
  assert.equal(compensatedStatus.status, "failed_compensated");
  assert.equal(compensatedStatus.failureCode, "backend_failure");
  assert.equal(
    JSON.stringify(compensatedStatus).includes(PRIVATE_BACKEND_SENTINEL),
    false,
    "a compensated receipt must never retain a raw backend failure",
  );
  assert.equal(await readFile(compensationSource, "utf8"), "compensation");
  assert.equal(await exists(compensationTarget), false);
  assert.deepEqual(
    Object.fromEntries(compensationVault.notes),
    compensationNotes,
  );

  // A compensation executor must not adopt a receipt that another process
  // changed after the failed apply. Its exact observed CAS must fail before it
  // issues an extra repair or filesystem rollback against that replacement.
  const compensationCasSource = path.join(rootPath, "compensation-cas.txt");
  const compensationCasTarget = path.join(archivePath, "compensation-cas.txt");
  await writeFile(compensationCasSource, "compensation cas", "utf8");
  const compensationCasReference =
    `[Compensation CAS](${pathToFileURL(compensationCasSource).href}) ` +
    "`external-ref:pilot.move::compensation-cas.txt`\n";
  const compensationCasNotes = {
    "Efforts/Projets/Compensation CAS A.md": compensationCasReference,
    "Efforts/Projets/Compensation CAS B.md": compensationCasReference,
  };
  const compensationCasJournal = new ExternalMoveJournal(":memory:");
  const compensationCasVault = new FakeVault(compensationCasNotes);
  const compensationCasCoordinator = new ExternalMoveCoordinator(
    service,
    compensationCasVault,
    compensationCasJournal,
  );
  const compensationCasPlan = await compensationCasCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "compensation-cas.txt",
    targetRelativePath: "archive/compensation-cas.txt",
    idempotencyKey: "coordinator-compensation-cas",
  });
  compensationCasVault.failConditionalReplaceAt = 2;
  compensationCasVault.failConditionalReplaceError = new Error(
    "compensation-cas-failure",
  );
  const transitionObserved = compensationCasJournal.transitionObserved.bind(
    compensationCasJournal,
  );
  let compensationCasInjected = false;
  compensationCasJournal.transitionObserved = (observed, ...args) => {
    if (!compensationCasInjected && observed.status === "applying_repairs") {
      compensationCasInjected = true;
      const rival = compensationCasJournal.observe(observed.planId);
      compensationCasJournal.updateObserved(
        rival,
        "recovery_required",
        "backend_failure",
        { recoveryErrors: ["backend_failure"] },
      );
    }
    return transitionObserved(observed, ...args);
  };
  await expectExternalCode(
    () =>
      compensationCasCoordinator.apply(
        compensationCasPlan.planId,
        "coordinator-compensation-cas",
      ),
    "non_verifiable",
  );
  assert.equal(compensationCasInjected, true);
  assert.equal(
    compensationCasVault.conditionalReplaceCalls,
    2,
    "a CAS-loss compensation must not issue a third rollback repair",
  );
  assert.equal(await exists(compensationCasSource), false);
  assert.equal(await exists(compensationCasTarget), true);
  const compensationCasDurable = compensationCasJournal.get(
    compensationCasPlan.planId,
  );
  assert.equal(compensationCasDurable.status, "recovery_required");
  assert.deepEqual(compensationCasDurable.recoveryErrors, ["backend_failure"]);

  // An unsupported vault writer is rejected before the external file moves.
  const unsupportedSource = path.join(rootPath, "unsupported-writer.txt");
  const unsupportedTarget = path.join(archivePath, "unsupported-writer.txt");
  await writeFile(unsupportedSource, "unsupported writer", "utf8");
  const unsupportedUri = pathToFileURL(unsupportedSource).href;
  const unsupportedVault = new FakeVault({
    "Efforts/Projets/Unsupported writer.md":
      `[Unsupported](${unsupportedUri}) ` +
      "`external-ref:pilot.move::unsupported-writer.txt`\n",
  });
  const unsupportedCoordinator = new ExternalMoveCoordinator(
    service,
    unsupportedVault,
    new ExternalMoveJournal(":memory:"),
  );
  const unsupportedPlan = await unsupportedCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "unsupported-writer.txt",
    targetRelativePath: "archive/unsupported-writer.txt",
    idempotencyKey: "coordinator-unsupported-writer",
  });
  unsupportedVault.conditionalWritesSupported = false;
  await assert.rejects(
    () =>
      unsupportedCoordinator.apply(
        unsupportedPlan.planId,
        "coordinator-unsupported-writer",
      ),
    /Conditional note writes are unavailable/u,
  );
  assert.equal(await readFile(unsupportedSource, "utf8"), "unsupported writer");
  assert.equal(await exists(unsupportedTarget), false);

  // Apply rescans the complete vault. A new canonical reference created after
  // planning invalidates the inventory before the external file is moved.
  const inventorySource = path.join(rootPath, "inventory-change.txt");
  const inventoryTarget = path.join(archivePath, "inventory-change.txt");
  await writeFile(inventorySource, "inventory", "utf8");
  const inventoryUri = pathToFileURL(inventorySource).href;
  const inventoryVault = new FakeVault({
    "Efforts/Projets/Inventory one.md":
      `[Inventory](${inventoryUri}) ` +
      "`external-ref:pilot.move::inventory-change.txt`\n",
  });
  const inventoryCoordinator = new ExternalMoveCoordinator(
    service,
    inventoryVault,
    new ExternalMoveJournal(":memory:"),
  );
  const inventoryPlan = await inventoryCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "inventory-change.txt",
    targetRelativePath: "archive/inventory-change.txt",
    idempotencyKey: "coordinator-inventory-change",
  });
  inventoryVault.notes.set(
    "Efforts/Projets/Inventory two.md",
    `[Inventory 2](${inventoryUri}) ` +
      "`external-ref:pilot.move::inventory-change.txt`\n",
  );
  await expectExternalCode(
    () =>
      inventoryCoordinator.apply(
        inventoryPlan.planId,
        "coordinator-inventory-change",
      ),
    "precondition_failed",
  );
  assert.equal(await readFile(inventorySource, "utf8"), "inventory");
  assert.equal(await exists(inventoryTarget), false);

  // A plan is bound to one backend/vault/root profile and cannot be replayed
  // after that binding changes.
  const bindingSource = path.join(rootPath, "binding-change.txt");
  const bindingTarget = path.join(archivePath, "binding-change.txt");
  await writeFile(bindingSource, "binding", "utf8");
  const bindingUri = pathToFileURL(bindingSource).href;
  const bindingVault = new FakeVault({
    "Efforts/Projets/Binding.md":
      `[Binding](${bindingUri}) ` +
      "`external-ref:pilot.move::binding-change.txt`\n",
  });
  const bindingCoordinator = new ExternalMoveCoordinator(
    service,
    bindingVault,
    new ExternalMoveJournal(":memory:"),
  );
  const bindingPlan = await bindingCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "binding-change.txt",
    targetRelativePath: "archive/binding-change.txt",
    idempotencyKey: "coordinator-binding-change",
  });
  bindingVault.bindingFingerprint = "different-binding";
  await expectExternalCode(
    () =>
      bindingCoordinator.apply(
        bindingPlan.planId,
        "coordinator-binding-change",
      ),
    "precondition_failed",
  );
  assert.equal(await readFile(bindingSource, "utf8"), "binding");
  assert.equal(await exists(bindingTarget), false);

  // Every backend observation after planning captures its session is fenced.
  // Reconnects during refresh, search, read, or immediately after the final
  // read reject the plan without sealing a mixed-generation receipt.
  for (const [stage, hookName] of [
    ["refresh", "beforeRefreshInventory"],
    ["search", "beforeSearchPaths"],
    ["read", "beforeRead"],
    ["before-create", "afterRead"],
  ]) {
    const sourceRelativePath = `planning-swap-${stage}.txt`;
    const targetRelativePath = `archive/planning-swap-${stage}.txt`;
    const sourcePath = path.join(rootPath, sourceRelativePath);
    const targetPath = path.join(rootPath, targetRelativePath);
    await writeFile(sourcePath, `planning swap ${stage}`, "utf8");
    const sourceUri = pathToFileURL(sourcePath).href;
    const vault = new FakeVault({
      [`Efforts/Projets/Planning swap ${stage}.md`]:
        `[Planning swap](${sourceUri}) ` +
        `\`external-ref:pilot.move::${sourceRelativePath}\`\n`,
    });
    const journal = new ExternalMoveJournal(":memory:");
    const coordinator = new ExternalMoveCoordinator(service, vault, journal);
    vault[hookName] = () => {
      vault.backendGeneration = 2;
      vault.backendSessionId = `replacement-${stage}`;
    };
    const idempotencyKey = `coordinator-planning-swap-${stage}`;
    await expectSessionChanged(() =>
      coordinator.plan({
        rootId: "pilot.move",
        sourceRelativePath,
        targetRelativePath,
        idempotencyKey,
      }),
    );
    assert.equal(
      journal.getByIdempotencyKey(idempotencyKey),
      undefined,
      `a ${stage} reconnect must not create a durable plan`,
    );
    assert.equal(await readFile(sourcePath, "utf8"), `planning swap ${stage}`);
    assert.equal(await exists(targetPath), false);
  }

  // The plan is not transferable to a restarted proxy/backend session, even
  // if it presents the same attested target and binding identity.
  const restartSource = path.join(rootPath, "generation-restart.txt");
  const restartTarget = path.join(archivePath, "generation-restart.txt");
  await writeFile(restartSource, "generation restart", "utf8");
  const restartUri = pathToFileURL(restartSource).href;
  const restartVault = new FakeVault({
    "Efforts/Projets/Generation restart.md":
      `[Generation restart](${restartUri}) ` +
      "`external-ref:pilot.move::generation-restart.txt`\n",
  });
  const restartCoordinator = new ExternalMoveCoordinator(
    service,
    restartVault,
    new ExternalMoveJournal(":memory:"),
  );
  const restartPlan = await restartCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "generation-restart.txt",
    targetRelativePath: "archive/generation-restart.txt",
    idempotencyKey: "coordinator-generation-restart",
  });
  restartVault.backendGeneration = 2;
  restartVault.backendSessionId = "test-session-2";
  await expectExternalCode(
    () =>
      restartCoordinator.apply(
        restartPlan.planId,
        "coordinator-generation-restart",
      ),
    "precondition_failed",
  );
  assert.equal(await readFile(restartSource, "utf8"), "generation restart");
  assert.equal(await exists(restartTarget), false);

  // A swap after the external file moved but before the first vault repair is
  // terminal. The replacement vault receives neither a repair nor a rollback.
  const partialSource = path.join(rootPath, "generation-partial.txt");
  const partialTarget = path.join(archivePath, "generation-partial.txt");
  await writeFile(partialSource, "generation partial", "utf8");
  const partialUri = pathToFileURL(partialSource).href;
  const partialNotePath = "Efforts/Projets/Generation partial.md";
  const partialNote =
    `[Generation partial](${partialUri}) ` +
    "`external-ref:pilot.move::generation-partial.txt`\n";
  const partialVault = new FakeVault({ [partialNotePath]: partialNote });
  const partialCoordinator = new ExternalMoveCoordinator(
    service,
    partialVault,
    new ExternalMoveJournal(":memory:"),
  );
  const partialPlan = await partialCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "generation-partial.txt",
    targetRelativePath: "archive/generation-partial.txt",
    idempotencyKey: "coordinator-generation-partial",
  });
  partialVault.beforeConditionalReplace = () => {
    partialVault.backendGeneration = 2;
    partialVault.backendSessionId = "replacement-session";
  };
  await expectExternalCode(
    () =>
      partialCoordinator.apply(
        partialPlan.planId,
        "coordinator-generation-partial",
      ),
    "non_verifiable",
  );
  assert.equal(await exists(partialSource), false);
  assert.equal(await readFile(partialTarget, "utf8"), "generation partial");
  assert.equal(
    partialVault.notes.get(partialNotePath),
    partialNote,
    "the replacement vault must not receive a repair or compensation write",
  );
  assert.equal(
    partialCoordinator.status(partialPlan.planId).status,
    "recovery_required",
  );

  // A journal written before backend target attestation remains discoverable
  // for incident inspection, but it can never be silently rebound to the
  // current vault or used to mutate either surface.
  const legacySource = path.join(rootPath, "legacy-binding.txt");
  await writeFile(legacySource, "legacy binding", "utf8");
  const legacySnapshot = await service.planMove(
    "pilot.move",
    "legacy-binding.txt",
    "archive/legacy-binding.txt",
  );
  const legacyJournal = new ExternalMoveJournal(":memory:");
  const legacyStored = legacyJournal.create({
    idempotencyKey: "legacy-binding-status-only",
    snapshot: legacySnapshot,
    bindingIdentity: {
      schemaVersion: 1,
      backendFingerprint: "legacy-backend",
      vaultFingerprint: "legacy-vault",
      rootConfigFingerprint: "legacy-roots",
      bindingFingerprint: "legacy-binding",
      vaultIdentitySource: "explicit_profile",
      verifiable: true,
    },
    sourceToken: "external-ref:pilot.move::legacy-binding.txt",
    targetToken: "external-ref:pilot.move::archive/legacy-binding.txt",
    oldFileUri: "file:///private/legacy-binding.txt",
    newFileUri: "file:///private/archive/legacy-binding.txt",
    repairs: [],
    manualReview: [],
    inventoryDigest: hashText("legacy"),
    appliedRepairPaths: [],
    restoredRepairPaths: [],
    recoveryErrors: [
      PRIVATE_BACKEND_SENTINEL,
      PRIVATE_CODE_SHAPED_LEGACY_SENTINEL,
    ],
    failure: PRIVATE_CODE_SHAPED_LEGACY_SENTINEL,
  });
  const legacyCoordinator = new ExternalMoveCoordinator(
    service,
    new FakeVault(),
    legacyJournal,
  );
  const legacyStatus = legacyCoordinator.status(legacyStored.planId);
  assert.equal(legacyStatus.legacyBinding, true);
  assert.equal(legacyStatus.bindingVerifiable, false);
  assert.equal(legacyStatus.rootId, "pilot.move");
  assert.equal(legacyStatus.sourceRelativePath, "legacy-binding.txt");
  assert.equal(legacyStatus.nextAction, "manual_review");
  assert.equal(legacyStatus.readyToApply, false);
  assert.equal(legacyStatus.failureCode, "external_root_non_verifiable");
  assert.equal(JSON.stringify(legacyStatus).includes("file:///private"), false);
  assert.equal(
    JSON.stringify(legacyStatus).includes(PRIVATE_BACKEND_SENTINEL),
    false,
    "legacy journal replay must redact raw historical failure text",
  );
  assert.equal(
    JSON.stringify(legacyStatus).includes(PRIVATE_CODE_SHAPED_LEGACY_SENTINEL),
    false,
    "legacy journal replay must reject code-shaped values outside the finite failure-code allowlist",
  );
  await expectExternalCode(
    () =>
      legacyCoordinator.apply(
        legacyStored.planId,
        "legacy-binding-status-only",
      ),
    "non_verifiable",
  );
  await expectExternalCode(
    () =>
      legacyCoordinator.rollback(
        legacyStored.planId,
        "legacy-binding-status-only",
      ),
    "non_verifiable",
  );
  assert.equal(await readFile(legacySource, "utf8"), "legacy binding");
  assert.equal(
    await exists(path.join(archivePath, "legacy-binding.txt")),
    false,
  );

  // A backend swap after a successful apply must also fence recovery: the
  // proxy cannot repair Vault A's old plan through a same-endpoint Vault B.
  const swapRecoverySource = path.join(rootPath, "binding-recovery.txt");
  const swapRecoveryTarget = path.join(archivePath, "binding-recovery.txt");
  await writeFile(swapRecoverySource, "binding recovery", "utf8");
  const swapRecoveryUri = pathToFileURL(swapRecoverySource).href;
  const swapRecoveryNotePath = "Efforts/Projets/Binding recovery.md";
  const swapRecoveryVault = new FakeVault({
    [swapRecoveryNotePath]:
      `[Binding recovery](${swapRecoveryUri}) ` +
      "`external-ref:pilot.move::binding-recovery.txt`\n",
  });
  const swapRecoveryCoordinator = new ExternalMoveCoordinator(
    service,
    swapRecoveryVault,
    new ExternalMoveJournal(":memory:"),
  );
  const swapRecoveryPlan = await swapRecoveryCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "binding-recovery.txt",
    targetRelativePath: "archive/binding-recovery.txt",
    idempotencyKey: "coordinator-binding-recovery",
  });
  await swapRecoveryCoordinator.apply(
    swapRecoveryPlan.planId,
    "coordinator-binding-recovery",
  );
  assert.equal(await exists(swapRecoverySource), false);
  assert.equal(await readFile(swapRecoveryTarget, "utf8"), "binding recovery");
  swapRecoveryVault.bindingFingerprint = "swapped-backend-binding";
  await expectExternalCode(
    () =>
      swapRecoveryCoordinator.rollback(
        swapRecoveryPlan.planId,
        "coordinator-binding-recovery",
      ),
    "precondition_failed",
  );
  assert.equal(
    await readFile(swapRecoveryTarget, "utf8"),
    "binding recovery",
    "a stale backend must not recover an applied external move",
  );

  // A process crash after the file move is recoverable from the durable
  // intermediate journal state through the ordinary rollback tool.
  const recoverySource = path.join(rootPath, "recovery.txt");
  const recoveryTarget = path.join(archivePath, "recovery.txt");
  await writeFile(recoverySource, "recovery", "utf8");
  const recoveryUri = pathToFileURL(recoverySource).href;
  const recoveryNotePath = "Efforts/Projets/Recovery.md";
  const recoveryNote =
    `[Recovery](${recoveryUri}) ` + "`external-ref:pilot.move::recovery.txt`\n";
  const recoveryVault = new FakeVault({ [recoveryNotePath]: recoveryNote });
  const recoveryJournal = new ExternalMoveJournal(":memory:");
  const recoveryCoordinator = new ExternalMoveCoordinator(
    service,
    recoveryVault,
    recoveryJournal,
  );
  const recoveryPlan = await recoveryCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "recovery.txt",
    targetRelativePath: "archive/recovery.txt",
    idempotencyKey: "coordinator-recovery",
  });
  const recoveryStored = recoveryJournal.get(recoveryPlan.planId);
  await service.applyMove(recoveryStored.snapshot);
  recoveryJournal.transition(recoveryPlan.planId, ["planned"], "applying_file");
  recoveryJournal.transition(
    recoveryPlan.planId,
    ["applying_file"],
    "file_moved",
  );
  const recovered = await recoveryCoordinator.rollback(
    recoveryPlan.planId,
    "coordinator-recovery",
  );
  assert.equal(recovered.status, "rolled_back");
  assert.equal(await readFile(recoverySource, "utf8"), "recovery");
  assert.equal(await exists(recoveryTarget), false);
  assert.equal(recoveryVault.notes.get(recoveryNotePath), recoveryNote);

  // A persisted partial journal is not transferable to a real proxy restart.
  // The new concrete session must turn status into manual-review recovery
  // before it can repair or compensate a different backend vault.
  const restartedPartialSource = path.join(rootPath, "restart-partial.txt");
  const restartedPartialTarget = path.join(archivePath, "restart-partial.txt");
  await writeFile(restartedPartialSource, "restart partial", "utf8");
  const restartedPartialUri = pathToFileURL(restartedPartialSource).href;
  const restartedPartialNotePath = "Efforts/Projets/Restart partial.md";
  const restartedPartialNote =
    `[Restart partial](${restartedPartialUri}) ` +
    "`external-ref:pilot.move::restart-partial.txt`\n";
  const restartedPartialJournal = new ExternalMoveJournal(":memory:");
  const firstProcessVault = new FakeVault({
    [restartedPartialNotePath]: restartedPartialNote,
  });
  const firstProcessCoordinator = new ExternalMoveCoordinator(
    service,
    firstProcessVault,
    restartedPartialJournal,
  );
  const restartedPartialPlan = await firstProcessCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "restart-partial.txt",
    targetRelativePath: "archive/restart-partial.txt",
    idempotencyKey: "coordinator-restart-partial",
  });
  const interruptedPlan = restartedPartialJournal.get(
    restartedPartialPlan.planId,
  );
  await service.applyMove(interruptedPlan.snapshot);
  restartedPartialJournal.transition(
    restartedPartialPlan.planId,
    ["planned"],
    "applying_file",
  );
  restartedPartialJournal.transition(
    restartedPartialPlan.planId,
    ["applying_file"],
    "file_moved",
  );
  const secondProcessVault = new FakeVault({
    [restartedPartialNotePath]: restartedPartialNote,
  });
  secondProcessVault.backendGeneration = 2;
  secondProcessVault.backendSessionId = "proxy-session-after-restart";
  const secondProcessCoordinator = new ExternalMoveCoordinator(
    service,
    secondProcessVault,
    restartedPartialJournal,
  );
  const restartedPartialStatus = secondProcessCoordinator.status(
    restartedPartialPlan.planId,
  );
  assert.equal(restartedPartialStatus.status, "recovery_required");
  assert.equal(restartedPartialStatus.nextAction, "manual_review");
  assert.equal(restartedPartialStatus.failureCode, "backend_session_changed");
  assert.deepEqual(restartedPartialStatus.recoveryErrors, [
    "backend_session_changed",
  ]);
  assert.equal(
    restartedPartialJournal.get(restartedPartialPlan.planId).status,
    "recovery_required",
    "a stale partial receipt must be durably retained for manual review",
  );
  assert.deepEqual(
    restartedPartialJournal.get(restartedPartialPlan.planId).recoveryErrors,
    ["backend_session_changed"],
    "a stale partial receipt must record its stable session failure code",
  );
  assert.equal(
    JSON.stringify(restartedPartialStatus).includes(
      "proxy-session-after-restart",
    ),
    false,
    "external_move_status must not expose a private replacement session",
  );
  await expectExternalCode(
    () =>
      secondProcessCoordinator.rollback(
        restartedPartialPlan.planId,
        "coordinator-restart-partial",
      ),
    "precondition_failed",
  );
  assert.equal(await exists(restartedPartialSource), false);
  assert.equal(
    await readFile(restartedPartialTarget, "utf8"),
    "restart partial",
  );
  assert.equal(
    secondProcessVault.notes.get(restartedPartialNotePath),
    restartedPartialNote,
    "a replacement process must never repair or compensate its new vault",
  );

  // Every state that would otherwise advertise apply or rollback must be
  // fail-closed after a session restart. Partial receipts are durably marked
  // for manual review; non-partial receipts receive an ephemeral projection
  // and remain byte-for-byte unchanged in the journal.
  const durablyReconciledStaleStatuses = new Set([
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
  for (const staleStatus of [
    "planned",
    "rolled_back",
    "applied",
    "failed_compensated",
    "applying",
    "applying_file",
    "file_moved",
    "applying_repairs",
    "rolling_back",
    "rolling_back_repairs",
    "rolling_back_file",
    "failed",
    "recovery_required",
  ]) {
    const sourceRelativePath = `stale-status-${staleStatus}.txt`;
    const targetRelativePath = `archive/stale-status-${staleStatus}.txt`;
    const sourcePath = path.join(rootPath, sourceRelativePath);
    const targetPath = path.join(rootPath, targetRelativePath);
    await writeFile(sourcePath, `stale status ${staleStatus}`, "utf8");
    const sourceUri = pathToFileURL(sourcePath).href;
    const notePath = `Efforts/Projets/Stale status ${staleStatus}.md`;
    const note =
      `[Stale status](${sourceUri}) ` +
      `\`external-ref:pilot.move::${sourceRelativePath}\`\n`;
    const firstVault = new FakeVault({ [notePath]: note });
    const journal = new ExternalMoveJournal(":memory:");
    const firstCoordinator = new ExternalMoveCoordinator(
      service,
      firstVault,
      journal,
    );
    const planned = await firstCoordinator.plan({
      rootId: "pilot.move",
      sourceRelativePath,
      targetRelativePath,
      idempotencyKey: `coordinator-stale-status-${staleStatus}`,
    });
    if (staleStatus !== "planned") {
      journal.transition(planned.planId, ["planned"], staleStatus);
    }
    const replacementVault = new FakeVault({ [notePath]: note });
    replacementVault.backendGeneration = 2;
    replacementVault.backendSessionId = `replacement-${staleStatus}`;
    const replacementCoordinator = new ExternalMoveCoordinator(
      service,
      replacementVault,
      journal,
    );
    const projected = replacementCoordinator.status(planned.planId);
    assert.equal(projected.status, "recovery_required", staleStatus);
    assert.equal(projected.nextAction, "manual_review", staleStatus);
    assert.equal(projected.readyToApply, false, staleStatus);
    assert.equal(projected.failureCode, "backend_session_changed", staleStatus);
    assert.deepEqual(projected.recoveryErrors, ["backend_session_changed"]);
    const durable = journal.get(planned.planId);
    if (durablyReconciledStaleStatuses.has(staleStatus)) {
      assert.equal(durable.status, "recovery_required", staleStatus);
      assert.equal(durable.failure, "backend_session_changed", staleStatus);
      assert.deepEqual(
        durable.recoveryErrors,
        ["backend_session_changed"],
        staleStatus,
      );
    } else {
      assert.equal(durable.status, staleStatus, staleStatus);
      assert.deepEqual(durable.recoveryErrors, [], staleStatus);
    }
    if (staleStatus === "planned") {
      const replay = await replacementCoordinator.plan({
        rootId: "pilot.move",
        sourceRelativePath,
        targetRelativePath,
        idempotencyKey: `coordinator-stale-status-${staleStatus}`,
      });
      assert.equal(replay.nextAction, "manual_review");
      assert.equal(replay.readyToApply, false);
      assert.equal(journal.get(planned.planId).status, "planned");
    }
    if (staleStatus === "applied") {
      const replay = await replacementCoordinator.apply(
        planned.planId,
        `coordinator-stale-status-${staleStatus}`,
      );
      assert.equal(replay.nextAction, "manual_review");
      assert.equal(replay.readyToApply, false);
      assert.equal(journal.get(planned.planId).status, "applied");
    }
    if (staleStatus === "rolled_back") {
      const replay = await replacementCoordinator.rollback(
        planned.planId,
        `coordinator-stale-status-${staleStatus}`,
      );
      assert.equal(replay.nextAction, "manual_review");
      assert.equal(replay.readyToApply, false);
      assert.equal(journal.get(planned.planId).status, "rolled_back");
    }
    assert.equal(
      await readFile(sourcePath, "utf8"),
      `stale status ${staleStatus}`,
    );
    assert.equal(await exists(targetPath), false);
    assert.equal(
      JSON.stringify(projected).includes(`replacement-${staleStatus}`),
      false,
      "stale session identifiers must remain private",
    );
  }

  // Even a durable recovery_required receipt with a benign stored failure
  // cannot continue after the originating session is gone. Its status is an
  // ephemeral manual-review projection and rollback remains side-effect free.
  const staleRecoverySource = path.join(rootPath, "stale-recovery.txt");
  const staleRecoveryTarget = path.join(rootPath, "archive/stale-recovery.txt");
  await writeFile(staleRecoverySource, "stale recovery", "utf8");
  const staleRecoveryUri = pathToFileURL(staleRecoverySource).href;
  const staleRecoveryNotePath = "Efforts/Projets/Stale recovery.md";
  const staleRecoveryNote =
    `[Stale recovery](${staleRecoveryUri}) ` +
    "`external-ref:pilot.move::stale-recovery.txt`\n";
  const staleRecoveryJournal = new ExternalMoveJournal(":memory:");
  const staleRecoveryFirstCoordinator = new ExternalMoveCoordinator(
    service,
    new FakeVault({ [staleRecoveryNotePath]: staleRecoveryNote }),
    staleRecoveryJournal,
  );
  const staleRecoveryPlan = await staleRecoveryFirstCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "stale-recovery.txt",
    targetRelativePath: "archive/stale-recovery.txt",
    idempotencyKey: "coordinator-stale-recovery-required",
  });
  staleRecoveryJournal.transition(
    staleRecoveryPlan.planId,
    ["planned"],
    "recovery_required",
    { failure: "backend_failure", recoveryErrors: ["backend_failure"] },
  );
  const staleRecoveryReplacementVault = new FakeVault({
    [staleRecoveryNotePath]: staleRecoveryNote,
  });
  staleRecoveryReplacementVault.backendGeneration = 2;
  staleRecoveryReplacementVault.backendSessionId = "replacement-recovery";
  const staleRecoveryCoordinator = new ExternalMoveCoordinator(
    service,
    staleRecoveryReplacementVault,
    staleRecoveryJournal,
  );
  const staleRecoveryProjection = staleRecoveryCoordinator.status(
    staleRecoveryPlan.planId,
  );
  assert.equal(staleRecoveryProjection.status, "recovery_required");
  assert.equal(staleRecoveryProjection.nextAction, "manual_review");
  assert.equal(staleRecoveryProjection.readyToApply, false);
  assert.equal(staleRecoveryProjection.failureCode, "backend_session_changed");
  assert.deepEqual(staleRecoveryProjection.recoveryErrors, [
    "backend_failure",
    "backend_session_changed",
  ]);
  await expectExternalCode(
    () =>
      staleRecoveryCoordinator.rollback(
        staleRecoveryPlan.planId,
        "coordinator-stale-recovery-required",
      ),
    "precondition_failed",
  );
  const staleRecoveryDurable = staleRecoveryJournal.get(
    staleRecoveryPlan.planId,
  );
  assert.equal(staleRecoveryDurable.status, "recovery_required");
  assert.equal(staleRecoveryDurable.failure, "backend_session_changed");
  assert.deepEqual(staleRecoveryDurable.recoveryErrors, [
    "backend_failure",
    "backend_session_changed",
  ]);
  assert.equal(await readFile(staleRecoverySource, "utf8"), "stale recovery");
  assert.equal(await exists(staleRecoveryTarget), false);

  // A stale file-backed snapshot may be overtaken by a terminal executor
  // before status re-opens the writable journal. The later terminal state is
  // authoritative: do not overwrite it and do not advertise its rollback to
  // the replacement session.
  const staleSnapshotSource = path.join(rootPath, "stale-snapshot.txt");
  const staleSnapshotTarget = path.join(rootPath, "archive/stale-snapshot.txt");
  await writeFile(staleSnapshotSource, "stale snapshot", "utf8");
  const staleSnapshotUri = pathToFileURL(staleSnapshotSource).href;
  const staleSnapshotNotePath = "Efforts/Projets/Stale snapshot.md";
  const staleSnapshotNote =
    `[Stale snapshot](${staleSnapshotUri}) ` +
    "`external-ref:pilot.move::stale-snapshot.txt`\n";
  const staleSnapshotJournal = new ExternalMoveJournal(":memory:");
  const staleSnapshotFirstCoordinator = new ExternalMoveCoordinator(
    service,
    new FakeVault({ [staleSnapshotNotePath]: staleSnapshotNote }),
    staleSnapshotJournal,
  );
  const staleSnapshotPlan = await staleSnapshotFirstCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "stale-snapshot.txt",
    targetRelativePath: "archive/stale-snapshot.txt",
    idempotencyKey: "coordinator-stale-preloaded-terminal",
  });
  staleSnapshotJournal.transition(
    staleSnapshotPlan.planId,
    ["planned"],
    "file_moved",
  );
  const staleSnapshotPreloaded = staleSnapshotJournal.get(
    staleSnapshotPlan.planId,
  );
  const staleSnapshotReplacementVault = new FakeVault({
    [staleSnapshotNotePath]: staleSnapshotNote,
  });
  staleSnapshotReplacementVault.backendGeneration = 2;
  staleSnapshotReplacementVault.backendSessionId = "replacement-snapshot";
  const staleSnapshotCoordinator = new ExternalMoveCoordinator(
    service,
    staleSnapshotReplacementVault,
    staleSnapshotJournal,
  );
  const staleSnapshotObserve =
    staleSnapshotJournal.observe.bind(staleSnapshotJournal);
  let terminalizedDuringStatusReload = false;
  staleSnapshotJournal.observe = (planId) => {
    if (!terminalizedDuringStatusReload) {
      terminalizedDuringStatusReload = true;
      staleSnapshotJournal.observe = staleSnapshotObserve;
      staleSnapshotJournal.transition(planId, ["file_moved"], "applied");
    }
    return staleSnapshotObserve(planId);
  };
  const staleSnapshotStatus = staleSnapshotCoordinator.status(
    staleSnapshotPlan.planId,
    staleSnapshotPreloaded,
  );
  assert.equal(staleSnapshotStatus.status, "recovery_required");
  assert.equal(staleSnapshotStatus.nextAction, "manual_review");
  assert.equal(staleSnapshotStatus.readyToApply, false);
  assert.equal(staleSnapshotStatus.failureCode, "backend_session_changed");
  const terminalAfterSnapshotReload = staleSnapshotJournal.get(
    staleSnapshotPlan.planId,
  );
  assert.equal(terminalAfterSnapshotReload.status, "applied");
  assert.deepEqual(terminalAfterSnapshotReload.recoveryErrors, []);
  assert.equal(terminalAfterSnapshotReload.failure, undefined);
  assert.equal(
    JSON.stringify(staleSnapshotStatus).includes("replacement-snapshot"),
    false,
  );
  assert.equal(await readFile(staleSnapshotSource, "utf8"), "stale snapshot");
  assert.equal(await exists(staleSnapshotTarget), false);

  // Two stale status calls can race the same guarded transition. One may make
  // the durable recovery_required receipt; the losing status must reload that
  // winner and return the same fail-closed projection instead of surfacing a
  // concurrency error or overwriting its terminal/manual state.
  const staleRaceSource = path.join(rootPath, "stale-status-race.txt");
  const staleRaceTarget = path.join(rootPath, "archive/stale-status-race.txt");
  await writeFile(staleRaceSource, "stale status race", "utf8");
  const staleRaceUri = pathToFileURL(staleRaceSource).href;
  const staleRaceNotePath = "Efforts/Projets/Stale status race.md";
  const staleRaceNote =
    `[Stale race](${staleRaceUri}) ` +
    "`external-ref:pilot.move::stale-status-race.txt`\n";
  const staleRaceJournal = new ExternalMoveJournal(":memory:");
  const staleRaceFirstCoordinator = new ExternalMoveCoordinator(
    service,
    new FakeVault({ [staleRaceNotePath]: staleRaceNote }),
    staleRaceJournal,
  );
  const staleRacePlan = await staleRaceFirstCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "stale-status-race.txt",
    targetRelativePath: "archive/stale-status-race.txt",
    idempotencyKey: "coordinator-stale-status-race",
  });
  staleRaceJournal.transition(staleRacePlan.planId, ["planned"], "file_moved");
  const staleRaceVaultA = new FakeVault({ [staleRaceNotePath]: staleRaceNote });
  staleRaceVaultA.backendGeneration = 2;
  staleRaceVaultA.backendSessionId = "replacement-race-a";
  const staleRaceVaultB = new FakeVault({ [staleRaceNotePath]: staleRaceNote });
  staleRaceVaultB.backendGeneration = 2;
  staleRaceVaultB.backendSessionId = "replacement-race-b";
  const staleRaceCoordinatorB = new ExternalMoveCoordinator(
    service,
    staleRaceVaultB,
    staleRaceJournal,
  );
  const staleRaceCoordinatorA = new ExternalMoveCoordinator(
    service,
    staleRaceVaultA,
    staleRaceJournal,
  );
  const staleRaceUpdateObserved =
    staleRaceJournal.updateObserved.bind(staleRaceJournal);
  let interleavedStaleStatus = false;
  staleRaceJournal.updateObserved = (...args) => {
    if (!interleavedStaleStatus) {
      interleavedStaleStatus = true;
      const winner = staleRaceCoordinatorB.status(staleRacePlan.planId);
      assert.equal(winner.nextAction, "manual_review");
      throw new Error("External move plan state changed concurrently.");
    }
    return staleRaceUpdateObserved(...args);
  };
  const staleRaceLoser = staleRaceCoordinatorA.status(staleRacePlan.planId);
  assert.equal(staleRaceLoser.status, "recovery_required");
  assert.equal(staleRaceLoser.nextAction, "manual_review");
  assert.equal(staleRaceLoser.readyToApply, false);
  assert.equal(staleRaceLoser.failureCode, "backend_session_changed");
  assert.equal(
    interleavedStaleStatus,
    true,
    "the loser must exercise the observed-CAS concurrency path",
  );
  const staleRaceDurable = staleRaceJournal.get(staleRacePlan.planId);
  assert.equal(staleRaceDurable.status, "recovery_required");
  assert.equal(staleRaceDurable.failure, "backend_session_changed");
  assert.deepEqual(staleRaceDurable.recoveryErrors, [
    "backend_session_changed",
  ]);
  assert.equal(await readFile(staleRaceSource, "utf8"), "stale status race");
  assert.equal(await exists(staleRaceTarget), false);

  // A crash after the no-clobber hard link but before source unlink leaves
  // both paths on the same inode. Rollback must recover that verified window.
  const linkedRecoverySource = path.join(rootPath, "linked-recovery.txt");
  const linkedRecoveryTarget = path.join(archivePath, "linked-recovery.txt");
  await writeFile(linkedRecoverySource, "linked recovery", "utf8");
  const linkedRecoveryUri = pathToFileURL(linkedRecoverySource).href;
  const linkedRecoveryNotePath = "Efforts/Projets/Linked recovery.md";
  const linkedRecoveryNote =
    `[Linked recovery](${linkedRecoveryUri}) ` +
    "`external-ref:pilot.move::linked-recovery.txt`\n";
  const linkedRecoveryVault = new FakeVault({
    [linkedRecoveryNotePath]: linkedRecoveryNote,
  });
  const linkedRecoveryJournal = new ExternalMoveJournal(":memory:");
  const linkedRecoveryCoordinator = new ExternalMoveCoordinator(
    service,
    linkedRecoveryVault,
    linkedRecoveryJournal,
  );
  const linkedRecoveryPlan = await linkedRecoveryCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "linked-recovery.txt",
    targetRelativePath: "archive/linked-recovery.txt",
    idempotencyKey: "coordinator-linked-recovery",
  });
  await link(linkedRecoverySource, linkedRecoveryTarget);
  linkedRecoveryJournal.transition(
    linkedRecoveryPlan.planId,
    ["planned"],
    "applying_file",
  );
  const linkedRecovered = await linkedRecoveryCoordinator.rollback(
    linkedRecoveryPlan.planId,
    "coordinator-linked-recovery",
  );
  assert.equal(linkedRecovered.status, "rolled_back");
  assert.equal(await readFile(linkedRecoverySource, "utf8"), "linked recovery");
  assert.equal(await exists(linkedRecoveryTarget), false);
  assert.equal(
    linkedRecoveryVault.notes.get(linkedRecoveryNotePath),
    linkedRecoveryNote,
  );

  // Legacy physical paths are inventoried case-insensitively and block apply.
  const legacyCaseSource = path.join(rootPath, "legacy-case.txt");
  await writeFile(legacyCaseSource, "legacy case", "utf8");
  const legacyCaseVault = new FakeVault({
    "Efforts/Projets/Legacy case.md": `Legacy location: ${legacyCaseSource.toUpperCase()}\n`,
  });
  const legacyCaseCoordinator = new ExternalMoveCoordinator(
    service,
    legacyCaseVault,
    new ExternalMoveJournal(":memory:"),
  );
  const legacyCasePlan = await legacyCaseCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "legacy-case.txt",
    targetRelativePath: "archive/legacy-case.txt",
    idempotencyKey: "coordinator-legacy-case",
  });
  assert.equal(legacyCasePlan.readyToApply, false);
  assert.equal(legacyCasePlan.repairs.length, 0);
  assert.equal(legacyCasePlan.manualReview.length, 1);
  assert.equal(await readFile(legacyCaseSource, "utf8"), "legacy case");

  // Historical and legacy references are inventoried, never auto-repaired.
  const manualSource = path.join(rootPath, "manual.txt");
  await writeFile(manualSource, "manual", "utf8");
  const manualUri = pathToFileURL(manualSource).href;
  const manualNotePath = "Efforts/Projets/Manual.md";
  const manualVault = new FakeVault({
    [manualNotePath]:
      `## Historique\n\n[Old](${manualUri}) ` +
      "`external-ref:pilot.move::manual.txt`\n",
  });
  const manualCoordinator = new ExternalMoveCoordinator(
    service,
    manualVault,
    new ExternalMoveJournal(":memory:"),
  );
  const manualPlan = await manualCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "manual.txt",
    targetRelativePath: "archive/manual.txt",
    idempotencyKey: "coordinator-manual-review",
  });
  assert.equal(manualPlan.readyToApply, false);
  assert.equal(manualPlan.nextAction, "manual_review");
  assert.equal(manualPlan.repairs.length, 0);
  assert.equal(manualPlan.manualReview.length, 1);
  await expectExternalCode(
    () =>
      manualCoordinator.apply(manualPlan.planId, "coordinator-manual-review"),
    "precondition_failed",
  );
  assert.equal(await readFile(manualSource, "utf8"), "manual");
  assert.equal(await exists(path.join(archivePath, "manual.txt")), false);

  // The common operation adapter keeps the existing external-move journal as
  // its durable authority while projecting plan/apply/status/recover receipts.
  const operationDriftSource = path.join(rootPath, "operation-drift.txt");
  const operationDriftTarget = path.join(archivePath, "operation-drift.txt");
  await writeFile(operationDriftSource, "operation drift v1", "utf8");
  const operationDriftJournal = new ExternalMoveJournal(
    path.join(sandbox, "operation-drift.sqlite"),
  );
  const operationDriftCoordinator = new ExternalMoveCoordinator(
    service,
    new FakeVault(),
    operationDriftJournal,
  );
  const operationDriftAdapter = new ExternalMoveOperationAdapter(
    operationDriftCoordinator,
  );
  const operationDriftPlan = await operationDriftAdapter.plan({
    rootId: "pilot.move",
    sourceRelativePath: "operation-drift.txt",
    targetRelativePath: "archive/operation-drift.txt",
    idempotencyKey: "operation-runtime-drift",
  });
  assert.equal(operationDriftPlan.phase, "planned");
  assert.equal(operationDriftPlan.outcome, null);
  assert.equal(operationDriftPlan.applyAllowed, true);
  assert.match(operationDriftPlan.planRef, /^external-move:v1:/u);
  assert.match(operationDriftPlan.planDigest, /^[a-f0-9]{64}$/u);
  assert.equal(
    (await operationDriftAdapter.status(operationDriftPlan.planRef)).planDigest,
    operationDriftPlan.planDigest,
  );
  await writeFile(operationDriftSource, "operation drift v2", "utf8");
  await expectExternalCode(
    () =>
      operationDriftAdapter.apply(
        operationDriftPlan.planRef,
        "operation-runtime-drift",
      ),
    "precondition_failed",
  );
  assert.equal(
    await readFile(operationDriftSource, "utf8"),
    "operation drift v2",
  );
  assert.equal(await exists(operationDriftTarget), false);
  operationDriftJournal.close();

  const operationCommitSource = path.join(rootPath, "operation-commit.txt");
  const operationCommitTarget = path.join(archivePath, "operation-commit.txt");
  await writeFile(operationCommitSource, "operation commit", "utf8");
  const operationCommitJournal = new ExternalMoveJournal(
    path.join(sandbox, "operation-commit.sqlite"),
  );
  const operationCommitAdapter = new ExternalMoveOperationAdapter(
    new ExternalMoveCoordinator(
      service,
      new FakeVault(),
      operationCommitJournal,
    ),
  );
  const operationCommitPlan = await operationCommitAdapter.plan({
    rootId: "pilot.move",
    sourceRelativePath: "operation-commit.txt",
    targetRelativePath: "archive/operation-commit.txt",
    idempotencyKey: "operation-runtime-commit",
  });
  const operationCommitted = await operationCommitAdapter.apply(
    operationCommitPlan.planRef,
    "operation-runtime-commit",
  );
  assert.equal(operationCommitted.phase, "terminal");
  assert.equal(operationCommitted.outcome, "committed");
  assert.equal(operationCommitted.postflight.status, "verified");
  assert.equal(
    await readFile(operationCommitTarget, "utf8"),
    "operation commit",
  );
  const operationReplay = await operationCommitAdapter.apply(
    operationCommitPlan.planRef,
    "operation-runtime-commit",
  );
  assert.equal(operationReplay.operationId, operationCommitted.operationId);
  assert.equal(operationReplay.planDigest, operationCommitted.planDigest);
  assert.equal(operationReplay.outcome, "committed");
  assert.equal(await exists(operationCommitSource), false);
  operationCommitJournal.close();

  // Dropping the successful apply response does not authorize a retry: status
  // reconciles the durable committed receipt without another file effect.
  const operationLostSource = path.join(rootPath, "operation-lost.txt");
  const operationLostTarget = path.join(archivePath, "operation-lost.txt");
  await writeFile(operationLostSource, "operation lost response", "utf8");
  const operationLostJournalPath = path.join(sandbox, "operation-lost.sqlite");
  const operationLostJournal = new ExternalMoveJournal(
    operationLostJournalPath,
  );
  const operationLostAdapter = new ExternalMoveOperationAdapter(
    new ExternalMoveCoordinator(service, new FakeVault(), operationLostJournal),
  );
  const operationLostPlan = await operationLostAdapter.plan({
    rootId: "pilot.move",
    sourceRelativePath: "operation-lost.txt",
    targetRelativePath: "archive/operation-lost.txt",
    idempotencyKey: "operation-runtime-lost-response",
  });
  await operationLostAdapter.apply(
    operationLostPlan.planRef,
    "operation-runtime-lost-response",
  );
  operationLostJournal.close();
  const operationLostRestartedJournal = new ExternalMoveJournal(
    operationLostJournalPath,
  );
  const operationLostRestartedAdapter = new ExternalMoveOperationAdapter(
    new ExternalMoveCoordinator(
      service,
      new FakeVault(),
      operationLostRestartedJournal,
    ),
  );
  const operationLostStatus = await operationLostRestartedAdapter.status(
    operationLostPlan.planRef,
  );
  assert.equal(operationLostStatus.outcome, "committed");
  assert.equal(operationLostStatus.planDigest, operationLostPlan.planDigest);
  assert.equal(
    await readFile(operationLostTarget, "utf8"),
    "operation lost response",
  );
  operationLostRestartedJournal.close();

  // An interrupted apply is recovered only through the same persisted plan.
  const operationRecoverySource = path.join(rootPath, "operation-recovery.txt");
  const operationRecoveryTarget = path.join(
    archivePath,
    "operation-recovery.txt",
  );
  await writeFile(operationRecoverySource, "operation recovery", "utf8");
  const operationRecoveryJournalPath = path.join(
    sandbox,
    "operation-recovery.sqlite",
  );
  const operationRecoveryJournal = new ExternalMoveJournal(
    operationRecoveryJournalPath,
  );
  const operationRecoveryCoordinator = new ExternalMoveCoordinator(
    service,
    new FakeVault(),
    operationRecoveryJournal,
  );
  const operationRecoveryAdapter = new ExternalMoveOperationAdapter(
    operationRecoveryCoordinator,
  );
  const operationRecoveryPlan = await operationRecoveryAdapter.plan({
    rootId: "pilot.move",
    sourceRelativePath: "operation-recovery.txt",
    targetRelativePath: "archive/operation-recovery.txt",
    idempotencyKey: "operation-runtime-recovery",
  });
  const operationRecoveryStored = operationRecoveryJournal.get(
    operationRecoveryPlan.operationId,
  );
  await service.applyMove(operationRecoveryStored.snapshot);
  operationRecoveryJournal.transition(
    operationRecoveryPlan.operationId,
    ["planned"],
    "applying_file",
  );
  operationRecoveryJournal.transition(
    operationRecoveryPlan.operationId,
    ["applying_file"],
    "file_moved",
  );
  operationRecoveryJournal.close();
  const operationRecoveryRestartedJournal = new ExternalMoveJournal(
    operationRecoveryJournalPath,
  );
  const operationRecoveryRestartedAdapter = new ExternalMoveOperationAdapter(
    new ExternalMoveCoordinator(
      service,
      new FakeVault(),
      operationRecoveryRestartedJournal,
    ),
  );
  const interruptedStatus = await operationRecoveryRestartedAdapter.status(
    operationRecoveryPlan.planRef,
  );
  assert.equal(interruptedStatus.phase, "applying");
  assert.equal(interruptedStatus.outcome, null);
  assert.equal(interruptedStatus.recoveryAllowed, true);
  assert.equal(interruptedStatus.recoveryRef, operationRecoveryPlan.planRef);
  const operationRecovered = await operationRecoveryRestartedAdapter.recover(
    operationRecoveryPlan.planRef,
    "operation-runtime-recovery",
  );
  assert.equal(operationRecovered.phase, "terminal");
  assert.equal(operationRecovered.outcome, "compensated");
  assert.equal(operationRecovered.postflight.status, "compensated");
  assert.equal(operationRecovered.applyAllowed, false);
  assert.equal(
    await readFile(operationRecoverySource, "utf8"),
    "operation recovery",
  );
  assert.equal(await exists(operationRecoveryTarget), false);
  await assert.rejects(
    operationRecoveryRestartedAdapter.apply(
      operationRecoveryPlan.planRef,
      "operation-runtime-recovery",
    ),
    /rolled_back, not applicable/u,
  );
  assert.equal(
    await readFile(operationRecoverySource, "utf8"),
    "operation recovery",
  );
  assert.equal(await exists(operationRecoveryTarget), false);
  const operationRecoveredStatus =
    await operationRecoveryRestartedAdapter.status(
      operationRecoveryPlan.planRef,
    );
  assert.equal(operationRecoveredStatus.applyAllowed, false);
  operationRecoveryRestartedJournal.close();

  // Admission is atomic when apply preflight overlaps recovery.
  const operationRaceSource = path.join(rootPath, "operation-race.txt");
  const operationRaceTarget = path.join(archivePath, "operation-race.txt");
  await writeFile(operationRaceSource, "operation race", "utf8");
  const operationRaceJournal = new ExternalMoveJournal(
    path.join(sandbox, "operation-race.sqlite"),
  );
  const operationRaceVault = new FakeVault();
  const operationRaceCoordinator = new ExternalMoveCoordinator(
    service,
    operationRaceVault,
    operationRaceJournal,
  );
  const operationRaceAdapter = new ExternalMoveOperationAdapter(
    operationRaceCoordinator,
  );
  const operationRacePlan = await operationRaceAdapter.plan({
    rootId: "pilot.move",
    sourceRelativePath: "operation-race.txt",
    targetRelativePath: "archive/operation-race.txt",
    idempotencyKey: "operation-runtime-race",
  });
  let releaseApplyPreflight;
  let signalApplyPreflight;
  const applyPreflightReached = new Promise((resolve) => {
    signalApplyPreflight = resolve;
  });
  let conditionalWriteChecks = 0;
  operationRaceVault.assertConditionalWritesSupported = async () => {
    conditionalWriteChecks += 1;
    // Apply is deliberately paused before its claim. Recovery may still make
    // its own non-mutating capability check before it wins the planned-state
    // claim; only the first check is the injected pause.
    if (conditionalWriteChecks > 1) return;
    signalApplyPreflight();
    await new Promise((resolve) => {
      releaseApplyPreflight = resolve;
    });
  };
  const racedApply = operationRaceAdapter.apply(
    operationRacePlan.planRef,
    "operation-runtime-race",
  );
  await applyPreflightReached;
  const racedRecovery = await operationRaceAdapter.recover(
    operationRacePlan.planRef,
    "operation-runtime-race",
  );
  assert.equal(racedRecovery.phase, "terminal");
  assert.equal(racedRecovery.outcome, "compensated");
  assert.equal(racedRecovery.applyAllowed, false);
  assert.equal(conditionalWriteChecks, 2);
  releaseApplyPreflight();
  await assert.rejects(racedApply, /state changed concurrently/u);
  assert.equal(await readFile(operationRaceSource, "utf8"), "operation race");
  assert.equal(await exists(operationRaceTarget), false);
  operationRaceJournal.close();

  // A journal is durable, not trusted input. A legacy/tampered row must not
  // leak hostile paths/reasons through status or feed one into a backend call.
  const tamperedSource = path.join(rootPath, "tampered-journal.txt");
  const tamperedTarget = path.join(archivePath, "tampered-journal.txt");
  await writeFile(tamperedSource, "tampered journal", "utf8");
  const tamperedNotePath = "Efforts/Projets/Tampered journal.md";
  const tamperedNote =
    `[Tampered](${pathToFileURL(tamperedSource).href}) ` +
    "`external-ref:pilot.move::tampered-journal.txt`\n";
  const tamperedJournal = new ExternalMoveJournal(":memory:");
  const tamperedVault = new FakeVault({ [tamperedNotePath]: tamperedNote });
  const tamperedCoordinator = new ExternalMoveCoordinator(
    service,
    tamperedVault,
    tamperedJournal,
  );
  const safeTamperedPlan = await tamperedCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "tampered-journal.txt",
    targetRelativePath: "archive/tampered-journal.txt",
    idempotencyKey: "tampered-journal-plan",
  });
  tamperedJournal.transition(
    safeTamperedPlan.planId,
    ["planned"],
    "applying_file",
  );
  const safePreloadedPartial = tamperedJournal.get(safeTamperedPlan.planId);
  const tamperedStored = tamperedJournal.get(safeTamperedPlan.planId);
  const hostilePath = "C:\\private\\journal-sentinel.md";
  const hostileReason = "private-manual-review-sentinel";
  const backslashRelativePath = "folder\\journal-sentinel.md";
  tamperedStored.snapshot.sourceRelativePath = backslashRelativePath;
  tamperedStored.repairs = [
    {
      filePath: hostilePath,
      expectedSha256: hashText("before"),
      before: "before",
      after: "after",
    },
  ];
  tamperedStored.manualReview = [
    { filePath: "//server/private.md", reason: hostileReason },
  ];
  // The journal implementation intentionally exposes no mutation API for raw
  // payloads; the test injects the exact attacker/legacy storage boundary.
  tamperedJournal.db
    .prepare(
      "UPDATE external_move_plans SET payload_json = ? WHERE plan_id = ?",
    )
    .run(JSON.stringify(tamperedStored), tamperedStored.planId);
  const tamperedBytesBefore = JSON.stringify(
    tamperedJournal.get(tamperedStored.planId),
  );
  tamperedVault.backendGeneration = 2;
  tamperedVault.backendSessionId = "00000000-0000-4000-8000-000000000002";
  const tamperedStatus = tamperedCoordinator.status(
    tamperedStored.planId,
    safePreloadedPartial,
  );
  const tamperedPublic = JSON.stringify(tamperedStatus);
  assert.equal(tamperedStatus.status, "recovery_required");
  assert.equal(tamperedStatus.nextAction, "manual_review");
  assert.equal(tamperedStatus.readyToApply, false);
  assert.equal(tamperedStatus.failureCode, "external_root_non_verifiable");
  assert.equal(tamperedPublic.includes(hostilePath), false);
  assert.equal(tamperedPublic.includes(backslashRelativePath), false);
  assert.equal(tamperedPublic.includes(hostileReason), false);
  const mismatchedPreloadedStatus = tamperedCoordinator.status(
    "33333333-3333-4333-8333-333333333333",
    safePreloadedPartial,
  );
  assert.equal(mismatchedPreloadedStatus.planId, "[redacted]");
  assert.equal(mismatchedPreloadedStatus.nextAction, "manual_review");
  assert.equal(
    JSON.stringify(tamperedJournal.get(tamperedStored.planId)),
    tamperedBytesBefore,
    "tampered status is a no-write projection",
  );
  const tamperedReplay = await tamperedCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "tampered-journal.txt",
    targetRelativePath: "archive/tampered-journal.txt",
    idempotencyKey: "tampered-journal-plan",
  });
  assert.equal(tamperedReplay.planId, "[redacted]");
  assert.equal(tamperedReplay.nextAction, "manual_review");
  const sessionCallsBeforeTamper = tamperedVault.openDestructiveSessionCalls;
  await expectExternalCode(
    () =>
      tamperedCoordinator.apply(tamperedStored.planId, "tampered-journal-plan"),
    "non_verifiable",
  );
  await expectExternalCode(
    () =>
      tamperedCoordinator.rollback(
        tamperedStored.planId,
        "tampered-journal-plan",
      ),
    "non_verifiable",
  );
  assert.equal(
    tamperedVault.openDestructiveSessionCalls,
    sessionCallsBeforeTamper,
    "unsafe stored paths must fail before a destructive backend session opens",
  );
  assert.equal(await readFile(tamperedSource, "utf8"), "tampered journal");
  assert.equal(await exists(tamperedTarget), false);
  assert.equal(tamperedVault.notes.get(tamperedNotePath), tamperedNote);
  tamperedJournal.close();

  // Stable error taxonomy is part of the receipt integrity contract. A row
  // may retain an otherwise valid binding and paths while an attacker (or an
  // obsolete writer) injects an unknown failure value. Status must redact that
  // row and rollback must reject it before opening a backend session or asking
  // the filesystem about either path.
  const taxonomyTamperSource = path.join(rootPath, "taxonomy-tamper.txt");
  const taxonomyTamperTarget = path.join(archivePath, "taxonomy-tamper.txt");
  await writeFile(taxonomyTamperSource, "taxonomy tamper", "utf8");
  const taxonomyTamperRoots = createRootService(rootPath);
  const taxonomyTamperVault = new FakeVault();
  const taxonomyTamperJournal = new ExternalMoveJournal(":memory:");
  const taxonomyTamperCoordinator = new ExternalMoveCoordinator(
    taxonomyTamperRoots,
    taxonomyTamperVault,
    taxonomyTamperJournal,
  );
  const taxonomyTamperPlan = await taxonomyTamperCoordinator.plan({
    rootId: "pilot.move",
    sourceRelativePath: "taxonomy-tamper.txt",
    targetRelativePath: "archive/taxonomy-tamper.txt",
    idempotencyKey: "coordinator-taxonomy-tamper",
  });
  taxonomyTamperJournal.transition(
    taxonomyTamperPlan.planId,
    ["planned"],
    "recovery_required",
  );
  const taxonomyTamperedStored = taxonomyTamperJournal.get(
    taxonomyTamperPlan.planId,
  );
  const unknownFailureSentinel = "private-unknown-recovery-taxonomy";
  taxonomyTamperedStored.failure = unknownFailureSentinel;
  taxonomyTamperedStored.recoveryErrors = [unknownFailureSentinel];
  taxonomyTamperJournal.db
    .prepare(
      "UPDATE external_move_plans SET payload_json = ? WHERE plan_id = ?",
    )
    .run(JSON.stringify(taxonomyTamperedStored), taxonomyTamperPlan.planId);
  const taxonomyTamperBytesBefore = JSON.stringify(
    taxonomyTamperJournal.get(taxonomyTamperPlan.planId),
  );
  let taxonomyTamperRootCalls = 0;
  const taxonomyTamperInspect =
    taxonomyTamperRoots.inspectMoveSource.bind(taxonomyTamperRoots);
  taxonomyTamperRoots.inspectMoveSource = async (...args) => {
    taxonomyTamperRootCalls += 1;
    return taxonomyTamperInspect(...args);
  };
  const taxonomyTamperSessionsBefore =
    taxonomyTamperVault.openDestructiveSessionCalls;
  const taxonomyTamperStatus = taxonomyTamperCoordinator.status(
    taxonomyTamperPlan.planId,
  );
  assert.equal(taxonomyTamperStatus.status, "recovery_required");
  assert.equal(taxonomyTamperStatus.rootId, "pilot.move");
  assert.equal(taxonomyTamperStatus.sourceRelativePath, "taxonomy-tamper.txt");
  assert.equal(taxonomyTamperStatus.nextAction, "manual_review");
  assert.equal(taxonomyTamperStatus.readyToApply, false);
  assert.equal(
    taxonomyTamperStatus.failureCode,
    "external_root_non_verifiable",
  );
  assert.equal(
    JSON.stringify(taxonomyTamperStatus).includes(unknownFailureSentinel),
    false,
  );
  await expectExternalCode(
    () =>
      taxonomyTamperCoordinator.rollback(
        taxonomyTamperPlan.planId,
        "coordinator-taxonomy-tamper",
      ),
    "non_verifiable",
  );
  assert.equal(
    taxonomyTamperVault.openDestructiveSessionCalls,
    taxonomyTamperSessionsBefore,
    "unknown recovery taxonomy must fail before the backend session opens",
  );
  assert.equal(
    taxonomyTamperRootCalls,
    0,
    "unknown recovery taxonomy must fail before filesystem inspection",
  );
  assert.equal(await readFile(taxonomyTamperSource, "utf8"), "taxonomy tamper");
  assert.equal(await exists(taxonomyTamperTarget), false);
  assert.equal(
    JSON.stringify(taxonomyTamperJournal.get(taxonomyTamperPlan.planId)),
    taxonomyTamperBytesBefore,
    "unknown recovery taxonomy must not transition or normalize the journal row",
  );
  taxonomyTamperJournal.close();

  console.log("External move integrity tests passed.");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
