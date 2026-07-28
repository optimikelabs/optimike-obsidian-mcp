import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
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
const { ExternalMoveJournal } = await import(
  "../dist/services/externalReferences/externalMoveJournal.js"
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
  constructor(entries = {}) {
    this.notes = new Map(Object.entries(entries));
    this.bindingFingerprint = "test-binding";
    this.conditionalWritesSupported = true;
  }

  async getBindingIdentity() {
    return {
      schemaVersion: 1,
      backendFingerprint: "test-backend",
      vaultFingerprint: "test-vault",
      rootConfigFingerprint: "test-roots",
      bindingFingerprint: this.bindingFingerprint,
      vaultIdentitySource: "explicit_profile",
      verifiable: true,
    };
  }

  async refreshInventory() {}

  async assertConditionalWritesSupported() {
    if (!this.conditionalWritesSupported) {
      throw new Error("Conditional note writes are unavailable.");
    }
  }

  async searchPaths(query, searchInPath = "", caseSensitive = true) {
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

  async read(filePath) {
    const content = this.notes.get(filePath);
    if (content === undefined)
      throw new Error(`Missing fake note: ${filePath}`);
    return { filePath, content, sha256: hashText(content) };
  }

  async conditionalReplace(filePath, before, after, expectedSha256) {
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
  assert.equal(
    editedBodyCoordinator.status(editedBodyPlan.planId).status,
    "applied",
  );

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

  // An unsupported vault writer is rejected before the external file moves.
  const unsupportedSource = path.join(rootPath, "unsupported-writer.txt");
  const unsupportedTarget = path.join(
    archivePath,
    "unsupported-writer.txt",
  );
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
  assert.equal(
    await readFile(unsupportedSource, "utf8"),
    "unsupported writer",
  );
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

  // Legacy physical paths are inventoried case-insensitively and block apply.
  const legacyCaseSource = path.join(rootPath, "legacy-case.txt");
  await writeFile(legacyCaseSource, "legacy case", "utf8");
  const legacyCaseVault = new FakeVault({
    "Efforts/Projets/Legacy case.md":
      `Legacy location: ${legacyCaseSource.toUpperCase()}\n`,
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
  assert.equal(manualPlan.repairs.length, 0);
  assert.equal(manualPlan.manualReview.length, 1);
  await expectExternalCode(
    () =>
      manualCoordinator.apply(manualPlan.planId, "coordinator-manual-review"),
    "precondition_failed",
  );
  assert.equal(await readFile(manualSource, "utf8"), "manual");
  assert.equal(await exists(path.join(archivePath, "manual.txt")), false);

  console.log("External move integrity tests passed.");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
