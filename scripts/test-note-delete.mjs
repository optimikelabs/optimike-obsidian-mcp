import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-fixture-key";
process.env.OBSIDIAN_BASE_URL = "http://127.0.0.1:1";

const { NoteDeleteOperationAdapter } = await import("../dist/services/operations/noteDeleteOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { sealNoteDelete, noteDeleteDigest } = await import("../dist/services/noteDeleteContract.js");
const { BaseErrorCode, McpError } = await import("../dist/types-global/errors.js");
const { publicMcpToolErrorPayload } = await import("../dist/utils/internal/errorHandler.js");
const { registerNoteDeleteTools } = await import("../dist/mcp-server/tools/noteDeleteTools/index.js");
const { compileToolProfileNames } = await import("../dist/mcp-server/toolProfiles.js");
const { proxyMutationFailure } = await import("../dist/utils/proxyMutationFailure.js");

const root = mkdtempSync(path.join(os.tmpdir(), "note-delete-"));
const BINDING = "a".repeat(64);
const SHA = noteDeleteDigest("note body");

function seal(overrides = {}) {
  return sealNoteDelete({
    bindingFingerprint: BINDING, path: "Projects/Old.md", sha256: SHA, byteLength: 9,
    backlinks: [], acknowledgeBacklinks: false, trashOption: "local", ...overrides,
  });
}
function bridgeRefusal(reasonCode) {
  // What the REST boundary produces for a Bridge refusal: a closed reason code in the details.
  return new McpError(BaseErrorCode.VALIDATION_ERROR, "Obsidian API rejected the request (HTTP 400).", { reasonCode });
}
const openJournals = [];
function setup(name, { plan = seal(), refusal } = {}) {
  const db = path.join(root, name + ".sqlite");
  const journal = new ObsidianNoteReplaceJournal(db);
  openJournals.push(journal);
  let applies = 0;
  let preflights = 0;
  let loseReply = false;
  let postflight = "pending";
  let allow = true;
  const receipts = new Map();
  const observation = (request, extra = {}) => ({
    contractVersion: 1, operationId: request.operationId, bindingFingerprint: request.bindingFingerprint,
    preconditionDigest: request.preconditionDigest, outcome: "committed", reason: "native_trash_returned",
    trashOption: plan.trashOption, trashPostflight: postflight, replayAllowed: false, ...extra,
  });
  const backend = {
    async preflight() { preflights++; if (refusal) throw bridgeRefusal(refusal); return plan; },
    async apply(request) {
      applies++;
      const result = observation(request);
      receipts.set(request.operationId, request);
      if (loseReply) throw new Error("connection reset");
      return result;
    },
    async status(operationId, preconditionDigest) {
      const request = receipts.get(operationId);
      return request ? observation(request) : { contractVersion: 1, operationId, preconditionDigest,
        bindingFingerprint: BINDING, outcome: "outcome_unknown", reason: "backend_receipt_unavailable",
        trashOption: plan.trashOption, trashPostflight: "indeterminate", replayAllowed: false };
    },
  };
  const authorize = () => { if (!allow) throw new Error("writes disabled"); };
  const adapter = new NoteDeleteOperationAdapter(backend, journal, authorize);
  return { journal, adapter, backend, db, receipts, authorize, applies: () => applies, preflights: () => preflights,
    loseReply: () => { loseReply = true; }, setPostflight: (value) => { postflight = value; }, disable: () => { allow = false; } };
}
const request = { path: "Projects/Old.md", idempotencyKey: "delete-once" };
const publicOf = (error, tool = "obsidian_note_delete_plan") =>
  publicMcpToolErrorPayload(error, { operation: tool, toolName: tool, params: {} });

try {
  // Nominal: plan seals the hash, apply dispatches once, replay and status never dispatch again.
  const f = setup("nominal");
  const planned = await f.adapter.plan(request);
  assert.equal(planned.phase, "planned");
  assert.equal(planned.beforeProof.sha256, SHA);
  assert.equal(planned.trash.preference, "local");
  assert.equal(f.applies(), 0);
  assert.equal((await f.adapter.plan(request)).planRef, planned.planRef, "replanning with the same key returns the same plan");
  assert.equal(f.preflights(), 1);
  await assert.rejects(f.adapter.plan({ ...request, acknowledgeBacklinks: true }), /idempotency|invalid/iu, "same key, different intent");
  await assert.rejects(f.adapter.apply(planned.planRef, "another-key"));
  await assert.rejects(f.adapter.status(planned.planRef.replace("note-delete", "note-move")));
  f.setPostflight("verified");
  const applied = await f.adapter.apply(planned.planRef, request.idempotencyKey);
  assert.equal(applied.outcome, "committed");
  assert.equal(applied.postflight.status, "verified");
  assert.equal(applied.nextAction, "none");
  assert.equal((await f.adapter.apply(planned.planRef, request.idempotencyKey)).outcome, "committed");
  assert.equal(f.applies(), 1, "a replay never dispatches the effect again");
  for (const field of ["nextContent", "idempotencyKey", "bindingFingerprint", "afterSha256"]) {
    assert.equal(Object.hasOwn(applied, field), false);
  }
  // Durable across a restart even though the backend lost its in-memory receipts.
  f.journal.close();
  const reopened = new ObsidianNoteReplaceJournal(f.db);
  openJournals.push(reopened);
  f.receipts.clear();
  const afterRestart = await new NoteDeleteOperationAdapter(f.backend, reopened, f.authorize).status(planned.planRef);
  assert.equal(afterRestart.outcome, "committed");
  reopened.close();

  // The cockpit lists a planned deletion (the journal admits seven projection kinds; it used to cap at six).
  const pendingProbe = setup("cockpit");
  const pendingPlan = await pendingProbe.adapter.plan(request);
  const { OperationCockpit } = await import("../dist/services/operationCockpit.js");
  const cockpit = new OperationCockpit([{ listPendingOperationRows: (input) => pendingProbe.journal.listPendingOperationRows({
    ...input, fallbackOperationKind: "obsidian.note.replace", allowUnprojectedFallback: true,
    admittedProjectionKinds: ["obsidian.frontmatter.patch", "obsidian.text.patch", "obsidian.note.move", "obsidian.note.delete",
      "obsidian.note.create", "obsidian.base.rows.patch", "obsidian.asset.import"],
  }) }]);
  const listed = cockpit.list({ limit: 10 }).operations;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].operationKind, "obsidian.note.delete");
  assert.equal(listed[0].planRef, pendingPlan.planRef);
  assert.equal(listed[0].nextAction, "apply");

  // System trash: committed, but the receipt never claims verified presence in the trash.
  const system = setup("system", { plan: seal({ trashOption: "system" }) });
  const systemPlan = await system.adapter.plan(request);
  assert.equal(systemPlan.trash.destination, "system_trash_or_vault_trash");
  system.setPostflight("path_absent_only");
  const systemApplied = await system.adapter.apply(systemPlan.planRef, request.idempotencyKey);
  assert.equal(systemApplied.outcome, "committed");
  assert.equal(systemApplied.postflight.status, "path_absent_only");

  // Note with backlinks: refused by the Bridge unless acknowledged, with an actionable public message.
  const linked = setup("linked", { refusal: "note_has_backlinks" });
  const refused = await linked.adapter.plan(request).then(() => assert.fail("must refuse"), (error) => error);
  const refusedPublic = publicOf(refused);
  assert.equal(refusedPublic.error.code, "VALIDATION_ERROR");
  assert.equal(refusedPublic.error.details.reasonCode, "delete_note_has_backlinks");
  assert.match(refusedPublic.error.message, /acknowledgeBacklinks=true/u);
  assert.equal((await setup("none").adapter.plan(request)).incomingLinks.acknowledged, false);
  const ack = setup("ack", { plan: seal({ backlinks: [{ sourcePath: "Index.md", count: 2 }], acknowledgeBacklinks: true }) });
  const ackPlan = await ack.adapter.plan({ ...request, acknowledgeBacklinks: true });
  assert.deepEqual(ackPlan.incomingLinks, { acknowledged: true, sources: [{ sourcePath: "Index.md", count: 2 }] });
  // A Bridge answer that disagrees with the requested acknowledgement is never sealed.
  await assert.rejects(ack.adapter.plan({ path: request.path, idempotencyKey: "other" }));

  // Absent note, permanent preference and disabled Bridge grant: closed, actionable refusals.
  for (const [bridge, code, reason] of [
    ["note_not_found", "NOT_FOUND", "delete_note_not_found"],
    ["trash_preference_permanent", "FORBIDDEN", "delete_trash_preference_permanent"],
    ["note_delete_disabled", "FORBIDDEN", "delete_bridge_grant_disabled"],
    ["trash_preference_unavailable", "SERVICE_UNAVAILABLE", "delete_trash_preference_unavailable"],
  ]) {
    const g = setup("refusal-" + bridge, { refusal: bridge });
    const error = await g.adapter.plan({ ...request, idempotencyKey: "k-" + bridge }).then(() => assert.fail("must refuse"), (caught) => caught);
    const payload = publicOf(error);
    assert.equal(payload.error.code, code, bridge);
    assert.equal(payload.error.details.reasonCode, reason, bridge);
    assert.equal(g.applies(), 0);
  }
  await assert.rejects(setup("badpath").adapter.plan({ path: "notes.txt", idempotencyKey: "k" }));

  // Concurrent apply of the same plan reaches the backend at most once.
  const race = setup("race");
  const racePlan = await race.adapter.plan(request);
  const outcomes = await Promise.all([1, 2, 3].map(() => race.adapter.apply(racePlan.planRef, request.idempotencyKey)));
  assert.equal(race.applies(), 1);
  assert.ok(outcomes.every((item) => ["committed", "applying"].includes(item.outcome ?? item.phase) || item.phase === "applying"));

  // Lost reply: outcome_unknown, never replayed; status reconciles from the backend receipt.
  const lost = setup("lost");
  const lostPlan = await lost.adapter.plan(request);
  lost.loseReply();
  const unknown = await lost.adapter.apply(lostPlan.planRef, request.idempotencyKey);
  assert.equal(unknown.outcome, "outcome_unknown");
  assert.equal(unknown.nextAction, "status");
  assert.equal(lost.applies(), 1);
  assert.equal((await lost.adapter.apply(lostPlan.planRef, request.idempotencyKey)).outcome, "committed", "a replay only reconciles");
  assert.equal(lost.applies(), 1);

  // Backend that forgot the receipt (restart): the uncertain outcome stays unknown, never guessed.
  const forgot = setup("forgot");
  const forgotPlan = await forgot.adapter.plan(request);
  forgot.loseReply();
  await forgot.adapter.apply(forgotPlan.planRef, request.idempotencyKey);
  forgot.receipts.clear();
  assert.equal((await forgot.adapter.status(forgotPlan.planRef)).outcome, "outcome_unknown");

  // Authorization is rechecked at apply; a refused apply leaves the plan untouched and applicable.
  const policy = setup("policy");
  const policyPlan = await policy.adapter.plan(request);
  policy.disable();
  await assert.rejects(policy.adapter.apply(policyPlan.planRef, request.idempotencyKey), /writes disabled/u);
  assert.equal((await policy.adapter.status(policyPlan.planRef)).phase, "planned");

  // Identity checks on the Bridge reply.
  const lying = setup("lying");
  const lyingPlan = await lying.adapter.plan(request);
  lying.backend.apply = async (req) => ({ contractVersion: 1, operationId: req.operationId, bindingFingerprint: "b".repeat(64),
    preconditionDigest: req.preconditionDigest, outcome: "committed", reason: "native_trash_returned",
    trashOption: "local", trashPostflight: "verified", replayAllowed: false });
  assert.equal((await lying.adapter.apply(lyingPlan.planRef, request.idempotencyKey)).outcome, "outcome_unknown");

  // Effect fence (administrative-closure mechanism): token recorded before dispatch, unqualified Bridge refused before any state change.
  const fenced = setup("fenced");
  const epoch = "11111111-1111-4111-8111-111111111111";
  fenced.backend.bridgeStatus = async () => ({ plugin: { version: "0.8.4" }, effectFence: { contractVersion: 1, supported: true, epoch } });
  let sentFence;
  const realApply = fenced.backend.apply;
  fenced.backend.apply = async (req) => { sentFence = req.fence; return realApply(req); };
  const fencedPlan = await fenced.adapter.plan(request);
  await fenced.adapter.apply(fencedPlan.planRef, request.idempotencyKey);
  assert.equal(sentFence.epoch, epoch);
  assert.match(sentFence.attemptId, /^[0-9a-f-]{36}$/u);
  const old = setup("old-bridge");
  const oldPlan = await old.adapter.plan(request);
  old.backend.bridgeStatus = async () => { throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "old", { reasonCode: "atomic_bridge_version_unsupported" }); };
  await assert.rejects(old.adapter.apply(oldPlan.planRef, request.idempotencyKey));
  assert.equal(old.applies(), 0);
  assert.equal((await old.adapter.status(oldPlan.planRef)).phase, "planned", "an unqualified Bridge is refused before any state change");

  // Tools: three governed names, own plan prefix, honest proxy receipt when the response is lost.
  const registered = new Map();
  registerNoteDeleteTools({ registerTool: (name, definition, handler) => registered.set(name, { definition, handler }) }, system.adapter);
  assert.deepEqual([...registered.keys()].sort(), ["obsidian_note_delete_apply", "obsidian_note_delete_plan", "obsidian_note_delete_status"]);
  const viaTool = await registered.get("obsidian_note_delete_status").handler({ planRef: systemApplied.planRef });
  assert.equal(JSON.parse(viaTool.content[0].text).outcome, "committed");
  const badTool = await registered.get("obsidian_note_delete_plan").handler({ path: "x.md", idempotencyKey: "k", extra: 1 });
  assert.equal(badTool.isError, true);
  const lostReply = proxyMutationFailure("obsidian_note_delete_apply", { planRef: planned.planRef });
  assert.equal(JSON.parse(lostReply.content[0].text).error.details.nextAction, "obsidian_note_delete_status");
  registerNoteDeleteTools({ registerTool: () => assert.fail("no runtime, no tool") }, undefined);

  // Exposure: the governed family replaces the direct delete in `operational`, `full` keeps both.
  const names = (profile) => compileToolProfileNames({ profile, registrationMode: "live", availableStaticRequirements: ["vault-cache"] });
  for (const tool of ["obsidian_note_delete_plan", "obsidian_note_delete_apply", "obsidian_note_delete_status"]) {
    assert.ok(names("operational").includes(tool), `operational exposes ${tool}`);
    assert.ok(names("full").includes(tool));
    assert.ok(!names("standard").includes(tool) && !names("authoring").includes(tool), "never in standard or authoring");
  }
  assert.ok(!names("operational").includes("obsidian_delete_note"), "the direct delete is hidden in operational");
  assert.ok(names("full").includes("obsidian_delete_note"), "the direct delete stays available in full");
  const headless = compileToolProfileNames({ profile: "operational", registrationMode: "headless-filesystem", availableStaticRequirements: ["vault-cache"] });
  assert.ok(headless.includes("obsidian_delete_note") && !headless.includes("obsidian_note_delete_plan"),
    "without a Bridge-backed runtime the direct tool remains the only route");

  console.log("PASS governed note deletion: sealed hash, trash-only, backlinks, CAS refusals, replay, lost reply, exposure");
} finally {
  for (const journal of openJournals) { try { journal.close(); } catch { /* already closed */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
