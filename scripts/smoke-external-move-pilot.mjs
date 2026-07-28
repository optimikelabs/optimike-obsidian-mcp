import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const required = [
  "MCP_EXTERNAL_ROOTS_FILE",
  "MCP_EXTERNAL_MOVE_PILOT_NOTE",
  "MCP_EXTERNAL_MOVE_PILOT_ROOT_ID",
  "MCP_EXTERNAL_MOVE_PILOT_SOURCE",
  "MCP_EXTERNAL_MOVE_PILOT_TARGET",
  "MCP_EXTERNAL_MOVE_JOURNAL_PATH",
];
for (const name of required) {
  assert.ok(process.env[name], `${name} is required`);
}
process.env.MCP_WRITE_MODE = "full";
process.env.MCP_EXTERNAL_MOVE_ENABLED = "true";
process.env.OBSIDIAN_RUNTIME_MODE = "headless-filesystem";
process.env.OBSIDIAN_VAULT ??= path.dirname(
  process.env.MCP_EXTERNAL_MOVE_PILOT_NOTE,
);

const [
  { ExternalRootsService },
  { ExternalMoveCoordinator },
  { ExternalMoveJournal },
  { sha256Text },
] = await Promise.all([
  import("../dist/services/externalRootsService.js"),
  import("../dist/services/externalReferences/externalMoveCoordinator.js"),
  import("../dist/services/externalReferences/externalMoveJournal.js"),
  import("../dist/services/externalReferences/backendVaultAdapter.js"),
]);

const notePath = path.resolve(process.env.MCP_EXTERNAL_MOVE_PILOT_NOTE);
assert.equal(path.extname(notePath).toLowerCase(), ".md");
const initialNote = await readFile(notePath, "utf8");

const directVault = {
  async searchPaths(query) {
    const content = await readFile(notePath, "utf8");
    return content.includes(query) ? [path.basename(notePath)] : [];
  },
  async read(filePath) {
    assert.equal(filePath, path.basename(notePath));
    const content = await readFile(notePath, "utf8");
    return { filePath, content, sha256: sha256Text(content) };
  },
  async conditionalReplace(filePath, before, after, expectedSha256) {
    assert.equal(filePath, path.basename(notePath));
    const current = await readFile(notePath, "utf8");
    assert.equal(sha256Text(current), expectedSha256);
    assert.equal(current, before);
    const temporary = `${notePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, after, { encoding: "utf8", flag: "wx" });
    await rename(temporary, notePath);
  },
};

const roots = await ExternalRootsService.fromConfigFile(
  process.env.MCP_EXTERNAL_ROOTS_FILE,
);
const coordinator = new ExternalMoveCoordinator(
  roots,
  directVault,
  new ExternalMoveJournal(process.env.MCP_EXTERNAL_MOVE_JOURNAL_PATH),
);
if (process.env.MCP_EXTERNAL_MOVE_PILOT_RECOVER_PLAN_ID) {
  const recovered = await coordinator.rollback(
    process.env.MCP_EXTERNAL_MOVE_PILOT_RECOVER_PLAN_ID,
    process.env.MCP_EXTERNAL_MOVE_PILOT_RECOVER_IDEMPOTENCY_KEY,
  );
  assert.equal(recovered.status, "rolled_back");
  const recoveredNote = await readFile(notePath, "utf8");
  assert.ok(
    recoveredNote.includes(
      `external-ref:${process.env.MCP_EXTERNAL_MOVE_PILOT_ROOT_ID}::${process.env.MCP_EXTERNAL_MOVE_PILOT_SOURCE}`,
    ),
  );
  console.log(
    JSON.stringify({ ok: true, recovery: true, ...recovered }, null, 2),
  );
  process.exit(0);
}
const idempotencyKey = `pilot-${randomUUID()}`;
const plan = await coordinator.plan({
  rootId: process.env.MCP_EXTERNAL_MOVE_PILOT_ROOT_ID,
  sourceRelativePath: process.env.MCP_EXTERNAL_MOVE_PILOT_SOURCE,
  targetRelativePath: process.env.MCP_EXTERNAL_MOVE_PILOT_TARGET,
  idempotencyKey,
});
assert.equal(plan.readyToApply, true);
assert.deepEqual(plan.manualReview, []);
assert.equal(plan.repairs.length, 1);

const applied = await coordinator.apply(plan.planId, idempotencyKey);
assert.equal(applied.status, "applied");
const repairedNote = await readFile(notePath, "utf8");
assert.ok(
  repairedNote.includes(
    `external-ref:${process.env.MCP_EXTERNAL_MOVE_PILOT_ROOT_ID}::${process.env.MCP_EXTERNAL_MOVE_PILOT_TARGET}`,
  ),
);

const rolledBack = await coordinator.rollback(plan.planId, idempotencyKey);
assert.equal(rolledBack.status, "rolled_back");
assert.equal(await readFile(notePath, "utf8"), initialNote);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: rolledBack.status,
      planId: plan.planId,
      sourceSha256: plan.sourceSha256,
      repairedNotes: plan.repairs.length,
      manualReview: plan.manualReview.length,
    },
    null,
    2,
  ),
);
