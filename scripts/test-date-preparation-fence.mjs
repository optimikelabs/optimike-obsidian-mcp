// Run with: node --experimental-strip-types scripts/test-date-preparation-fence.mjs
// The FDM preparation lock (date_preparation_unverified) must remain only when
// the preparation may have acted. The fake Bridge uses the real effect fence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EffectFence } from "../plugins/obsidian-atomic-write-bridge/src/effectFence.ts";
import { nativeFormatFixture } from "./fixtures/native-frontmatter-format.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "date-preparation-fence-"));
const journalPath = path.join(root, "journal.sqlite");
Object.assign(process.env, {
  NODE_ENV: "test", MCP_WRITE_MODE: "guarded", OBSIDIAN_RUNTIME_MODE: "live", OBSIDIAN_API_KEY: "test",
  MCP_PROTECTED_FRONTMATTER_KEYS: "création,modification", MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
});
const { createGovernedNoteReplaceRuntime } = await import("../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js");
const { McpError, BaseErrorCode } = await import("../dist/types-global/errors.js");

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const binding = hash("date-preparation-fence");
const NOTE = "Récente.md";
const undated = "---\nstatut: actif\n---\ncorps\n";
let content = undated;
let now = Date.parse("2026-10-27T10:00:00Z");
let fenceSupported = true;
let resolveAvailable = true;
let scenario = "success";
const fence = new EffectFence({ requireFence: () => false, now: () => now, registry: { epochs: [] } });
const sent = [];

const fake = {
  ...nativeFormatFixture(binding),
  async getAtomicWriteStatus() {
    return {
      ok: true, contractVersion: 1, plugin: { id: "obsidian-atomic-write-bridge", version: "0.8.3" },
      datePreparation: { contractVersion: 1, supported: true }, frontmatterFormat: { contractVersion: 1, supported: true },
      ...(fenceSupported ? { effectFence: fence.capability() } : {}),
      backend: { kind: "obsidian-vault-process", bindingFingerprint: binding, atomicCas: true, writeEnabled: true },
      limits: { markdownOnly: true },
      protection: { contractVersion: 1, frontmatterDateProperties: { integrations: [{ pluginId: "frontmatter-date-manager", createdPropertyName: "création", modifiedPropertyName: "modification" }] } },
      settlement: { contractVersion: 1, modifiedTimeFrontmatter: { integrations: [{ pluginId: "frontmatter-date-manager", propertyName: "modification", settlementObservationDelayMs: 0 }], utcOffsetMinutes: 0 } },
    };
  },
  async inspectAtomicFrontmatterFormat(payload) { return nativeFormatFixture(binding).inspectFrontmatterFormat(payload.yaml); },
  async readAtomicWriteNote(payload) {
    assert.equal(payload.path, NOTE);
    return { ok: true, contractVersion: 1, path: NOTE, content, dateManagement: { managed: true }, sha256: hash(content), size: Buffer.byteLength(content), bindingFingerprint: binding };
  },
  async resolveAtomicWriteEffectFence(payload) {
    if (!resolveAvailable) throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "down");
    return { ok: true, contractVersion: 1, bindingFingerprint: binding, epoch: fence.epoch, mode: payload.mode,
      results: payload.attempts.map((attempt) => ({ ...attempt, ...fence.resolve(attempt, payload.mode) })) };
  },
  async prepareAtomicWriteDate(payload) {
    sent.push(payload);
    const refuse = (code, reasonCode) => { throw new McpError(code, "bridge refusal", { reasonCode }); };
    if (scenario === "changed_before_effect") refuse(BaseErrorCode.CONFLICT, "resource_changed");
    if (scenario === "fdm_pending") refuse(BaseErrorCode.CONFLICT, "date_preparation_fdm_pending");
    if (scenario === "command_missing") refuse(BaseErrorCode.VALIDATION_ERROR, "atomic_write_creation_property_missing");
    if (scenario === "lost_before_arrival") throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "no response");
    if (scenario === "replayed_after_effect") {
      // An earlier delivery of the same token passed the effect point; this one is refused.
      fence.enter(payload.fence)();
      refuse(BaseErrorCode.FORBIDDEN, "effect_fence_refused");
    }
    const settle = fence.enter(payload.fence);
    try {
      const stamp = new Date().toISOString().slice(0, 16);
      content = content.replace("statut: actif", `statut: actif\ncréation: ${stamp}\nmodification: ${stamp}`);
    } finally { settle(); }
    if (scenario === "lost_after_effect") throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "response lost");
    return { ok: true, contractVersion: 1, path: NOTE, content, sha256: hash(content), size: Buffer.byteLength(content), bindingFingerprint: binding,
      datePreparation: { kind: "date-manager-before-plan", message: "Note datée par le gestionnaire de dates avant le plan." } };
  },
};

const runtime = createGovernedNoteReplaceRuntime(fake);
const locks = () => {
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try { return db.prepare("SELECT count(*) AS n FROM obsidian_date_preparation_fences").get().n; } finally { db.close(); }
};
async function plan() {
  try { return { source: await runtime.readForProjection(NOTE, true) }; }
  catch (error) { return { error }; }
}
const reasonOf = (result) => result.error?.details?.reasonCode;

try {
  // 1. The Bridge refuses before the effect point (note edited meanwhile): no lock.
  for (const [name, expected] of [
    ["changed_before_effect", "date_preparation_not_started"],
    ["fdm_pending", "date_preparation_fdm_pending"],
    ["lost_before_arrival", "date_preparation_not_started"],
    ["command_missing", "atomic_write_creation_property_missing"],
  ]) {
    scenario = name;
    const before = sent.length;
    const result = await plan();
    assert.equal(reasonOf(result), expected, name);
    assert.equal(sent.length, before + 1, name);
    assert.equal(locks(), 0, `${name} must not leave a lock`);
    assert.equal(content, undated, name);
    // The attempt is revoked: a late delivery of the same request can never act.
    assert.throws(() => fence.enter(sent.at(-1).fence), undefined, name);
  }

  // 2. The effect started and the response was lost: the lock stays.
  scenario = "lost_after_effect";
  assert.equal(reasonOf(await plan()), "date_preparation_unverified");
  assert.equal(locks(), 1);
  scenario = "success";
  const blocked = await plan();
  assert.equal(reasonOf(blocked), "date_preparation_unverified", "a lock whose effect may have run is never auto-released");
  assert.equal(locks(), 1);
  // Only the fenced administrative review releases it, after the quiet period.
  const settling = await runtime.releaseDatePreparationLock(NOTE, { dryRun: false, reasonCode: "operator_review" });
  assert.equal(settling.reasonCode, "closure_effect_settling");
  now += 60_000;
  const released = await runtime.releaseDatePreparationLock(NOTE, { dryRun: false, reasonCode: "operator_review" });
  assert.equal(released.result, "closed");
  assert.equal(released.evidence.priorEffect, "may_have_occurred");
  assert.equal(locks(), 0);

  // 3. A lock left because the Bridge could not answer is released at the next
  // plan once the Bridge proves the attempt never started.
  content = undated;
  scenario = "lost_before_arrival";
  resolveAvailable = false;
  assert.equal(reasonOf(await plan()), "date_preparation_unverified");
  assert.equal(locks(), 1);
  resolveAvailable = true;
  scenario = "success";
  const resumed = await plan();
  assert.equal(resumed.error, undefined, String(resumed.error));
  assert.equal(resumed.source.datePreparation.kind, "date-manager-before-plan");
  assert.equal(locks(), 1, "a verified preparation stays bound to its plan until released");
  runtime.releasePreparation(resumed.source);
  assert.equal(locks(), 0);

  // 4. A fence refusal is not enough on its own: a replayed token may have acted.
  content = undated;
  scenario = "replayed_after_effect";
  assert.equal(reasonOf(await plan()), "date_preparation_unverified");
  assert.equal(locks(), 1);
  now += 60_000;
  assert.equal((await runtime.releaseDatePreparationLock(NOTE, { dryRun: false, reasonCode: "operator_review" })).result, "closed");
  assert.equal(locks(), 0);

  // 5. Without a fence-capable Bridge nothing can be proven: the lock stays.
  content = undated;
  fenceSupported = false;
  scenario = "changed_before_effect";
  assert.equal(reasonOf(await plan()), "date_preparation_unverified");
  assert.equal(locks(), 1);
  assert.equal(reasonOf(await plan()), "date_preparation_unverified");
  assert.equal(sent.at(-1).fence, undefined);
  console.log("PASS date preparation fence: no lock on proven pre-effect refusals, lock kept after a possible effect, fenced review, automatic release of unstarted attempts, legacy fail-closed");
} finally {
  runtime.close();
  rmSync(root, { recursive: true, force: true });
}
