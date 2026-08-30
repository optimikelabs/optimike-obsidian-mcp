import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Legacy environment contract retained for direct invocations. This smoke is
// diagnostic-only: external-root mutation is fail-closed on every OS.
const required = [
  "MCP_EXTERNAL_ROOTS_FILE",
  "MCP_EXTERNAL_MOVE_PILOT_NOTE",
  "MCP_EXTERNAL_MOVE_PILOT_ROOT_ID",
  "MCP_EXTERNAL_MOVE_PILOT_SOURCE",
  "MCP_EXTERNAL_MOVE_PILOT_TARGET",
  "MCP_EXTERNAL_MOVE_JOURNAL_PATH",
];
for (const name of required)
  assert.ok(process.env[name], `${name} is required`);
process.env.MCP_WRITE_MODE = "full";
process.env.MCP_EXTERNAL_MOVE_ENABLED = "true";
process.env.OBSIDIAN_RUNTIME_MODE = "headless-filesystem";
process.env.OBSIDIAN_VAULT ??= path.dirname(
  process.env.MCP_EXTERNAL_MOVE_PILOT_NOTE,
);

const [
  { ExternalRootError, ExternalRootsService },
  { ExternalMoveCoordinator },
  { ExternalMoveJournal },
  { sha256Text },
] = await Promise.all([
  import("../dist/services/externalRootsService.js"),
  import("../dist/services/externalReferences/externalMoveCoordinator.js"),
  import("../dist/services/externalReferences/externalMoveJournal.js"),
  import("../dist/services/externalReferences/backendVaultAdapter.js"),
]);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function snapshotJournalFamily(journalPath) {
  const directory = path.dirname(journalPath);
  const extension = path.extname(journalPath);
  const stem = path.basename(journalPath, extension);
  const names = (await readdir(directory))
    .filter(
      (name) =>
        name === `${stem}${extension}` ||
        (name.startsWith(`${stem}.`) &&
          (name.endsWith(extension) ||
            name.endsWith(`${extension}-shm`) ||
            name.endsWith(`${extension}-wal`))),
    )
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      bytes: Buffer.from(await readFile(path.join(directory, name))).toString(
        "base64",
      ),
      size: (
        await stat(path.join(directory, name), { bigint: true })
      ).size.toString(),
      mtimeNs: (
        await stat(path.join(directory, name), { bigint: true })
      ).mtimeNs.toString(),
    })),
  );
}

const notePath = path.resolve(process.env.MCP_EXTERNAL_MOVE_PILOT_NOTE);
assert.equal(path.extname(notePath).toLowerCase(), ".md");
const initialNote = await readFile(notePath, "utf8");
const session = {
  generation: 1,
  sessionId: "00000000-0000-4000-8000-000000000001",
  bindingFingerprint: sha256Text("legacy-pilot-binding"),
};
const directVault = {
  async getBindingIdentity() {
    return {
      schemaVersion: 2,
      backendFingerprint: sha256Text("legacy-pilot-backend"),
      vaultFingerprint: sha256Text("legacy-pilot-vault"),
      rootConfigFingerprint: sha256Text("legacy-pilot-roots"),
      bindingFingerprint: session.bindingFingerprint,
      vaultIdentitySource: "backend_destructive_vault_attestation",
      verifiable: true,
    };
  },
  async captureDestructiveSession() {
    return session;
  },
  assertDestructiveSession(candidate) {
    if (
      candidate &&
      (candidate.generation !== session.generation ||
        candidate.sessionId !== session.sessionId ||
        candidate.bindingFingerprint !== session.bindingFingerprint)
    ) {
      throw new Error("Diagnostic fixture session changed.");
    }
  },
  isDestructiveSessionCurrent(candidate) {
    try {
      this.assertDestructiveSession(candidate);
      return true;
    } catch {
      return false;
    }
  },
  async refreshInventory(candidate) {
    this.assertDestructiveSession(candidate);
  },
  async assertConditionalWritesSupported(candidate) {
    this.assertDestructiveSession(candidate);
  },
  async searchPaths(query, _searchInPath, _caseSensitive, candidate) {
    this.assertDestructiveSession(candidate);
    return (await readFile(notePath, "utf8")).includes(query)
      ? [path.basename(notePath)]
      : [];
  },
  async read(filePath, candidate) {
    this.assertDestructiveSession(candidate);
    assert.equal(filePath, path.basename(notePath));
    const content = await readFile(notePath, "utf8");
    return { filePath, content, sha256: sha256Text(content) };
  },
  async conditionalReplace() {
    throw new Error("Mutation reached fake vault despite fail-closed gate.");
  },
};

const roots = await ExternalRootsService.fromConfigFile(
  process.env.MCP_EXTERNAL_ROOTS_FILE,
);
const rootConfig = JSON.parse(
  await readFile(process.env.MCP_EXTERNAL_ROOTS_FILE, "utf8"),
);
const root = rootConfig.roots.find(
  (candidate) => candidate.id === process.env.MCP_EXTERNAL_MOVE_PILOT_ROOT_ID,
);
assert.ok(root, "Pilot rootId is absent from the roots file.");
const sourcePath = path.join(
  path.resolve(root.path),
  process.env.MCP_EXTERNAL_MOVE_PILOT_SOURCE,
);
const targetPath = path.join(
  path.resolve(root.path),
  process.env.MCP_EXTERNAL_MOVE_PILOT_TARGET,
);
assert.equal(await exists(sourcePath), true, "Pilot source must exist.");
assert.equal(await exists(targetPath), false, "Pilot target must be absent.");

const journalPath = path.resolve(process.env.MCP_EXTERNAL_MOVE_JOURNAL_PATH);
const journal = new ExternalMoveJournal(journalPath);
try {
  const coordinator = new ExternalMoveCoordinator(roots, directVault, journal);
  const idempotencyKey = `legacy-pilot-${randomUUID()}`;
  const plan = await coordinator.plan({
    rootId: process.env.MCP_EXTERNAL_MOVE_PILOT_ROOT_ID,
    sourceRelativePath: process.env.MCP_EXTERNAL_MOVE_PILOT_SOURCE,
    targetRelativePath: process.env.MCP_EXTERNAL_MOVE_PILOT_TARGET,
    idempotencyKey,
  });
  assert.equal(plan.status, "planned");
  assert.equal(plan.readyToApply, false);
  assert.equal(plan.mutationAvailable, false);
  assert.equal(
    plan.mutationUnavailableReason,
    "native_handle_relative_mutation_unavailable",
  );
  assert.equal(plan.nextAction, "none");

  const sourceBefore = await readFile(sourcePath);
  const noteBefore = await readFile(notePath, "utf8");
  const journalBefore = await snapshotJournalFamily(journalPath);
  const expectUnsupported = async (operation) =>
    assert.rejects(operation, (error) => {
      assert.ok(error instanceof ExternalRootError, error?.constructor?.name);
      assert.equal(error.code, "unsupported");
      return true;
    });
  await expectUnsupported(() => coordinator.apply(plan.planId, idempotencyKey));
  await expectUnsupported(() =>
    coordinator.rollback(plan.planId, idempotencyKey),
  );
  if (process.env.MCP_EXTERNAL_MOVE_PILOT_RECOVER_PLAN_ID) {
    await expectUnsupported(() =>
      coordinator.rollback(
        process.env.MCP_EXTERNAL_MOVE_PILOT_RECOVER_PLAN_ID,
        process.env.MCP_EXTERNAL_MOVE_PILOT_RECOVER_IDEMPOTENCY_KEY,
      ),
    );
  }
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
  assert.equal(await exists(targetPath), false);
  assert.equal(await readFile(notePath, "utf8"), noteBefore);
  assert.deepEqual(
    await snapshotJournalFamily(journalPath),
    journalBefore,
    "Unsupported mutation changed journal family.",
  );
  const status = coordinator.status(plan.planId);
  assert.equal(status.status, "planned");
  assert.equal(status.readyToApply, false);
  assert.equal(status.mutationAvailable, false);
  assert.equal(
    status.mutationUnavailableReason,
    "native_handle_relative_mutation_unavailable",
  );
  assert.equal(await readFile(notePath, "utf8"), initialNote);
  console.log(
    JSON.stringify(
      {
        ok: true,
        diagnosticOnly: true,
        planId: plan.planId,
        repairedNotes: plan.repairs.length,
        manualReview: plan.manualReview.length,
        mutationAvailable: status.mutationAvailable,
        mutationUnavailableReason: status.mutationUnavailableReason,
        finalStatus: status.status,
      },
      null,
      2,
    ),
  );
} finally {
  journal.close();
}
