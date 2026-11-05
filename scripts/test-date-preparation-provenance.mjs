// Role-based proof of FDM date preparation (issue #147).
// FDM 1.6.0 writes an added creation from file.stat.ctime and a modification
// from file.stat.mtime. The synthetic Bridge returns what Atomic Write Bridge
// 0.9.2 returns: the dated content and the file stat observed just before the
// FDM command. No Obsidian instance, vault or credential is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeFormatFixture } from "./fixtures/native-frontmatter-format.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "date-preparation-provenance-"));
const journalPath = path.join(root, "journal.sqlite");
Object.assign(process.env, {
  NODE_ENV: "test", MCP_WRITE_MODE: "guarded", OBSIDIAN_RUNTIME_MODE: "live", OBSIDIAN_API_KEY: "test",
  MCP_PROTECTED_FRONTMATTER_KEYS: "création,modification", MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: journalPath,
});
const { createGovernedNoteReplaceRuntime } = await import("../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js");
const { GovernedTextPatchRuntime } = await import("../dist/services/textPatchProjectionRuntime.js");
const { GovernedFrontmatterRuntime } = await import("../dist/services/frontmatterProjectionRuntime.js");
const { BaseRowsPatchRuntime } = await import("../dist/services/baseRowsPatchRuntime.js");
const { publicMcpToolErrorPayload } = await import("../dist/utils/internal/errorHandler.js");
const { logger } = await import("../dist/utils/internal/logger.js");

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const binding = hash("provenance-vault");
const MINUTE = 60_000;
/** FDM `format(new Date(ms), "yyyy-MM-dd'T'HH:mm[:ss]")` in a process whose offset at `ms` is `offset`. */
const local = (ms, offset = 0, length = 16) => new Date(ms + offset * MINUTE).toISOString().slice(0, length);

// --- Synthetic Bridge -------------------------------------------------------
let notes = new Map();
let capability = true;
let statusOffset = 0;
let extraIntegration;
let scenario = {};
let preparations = 0;
let writes = 0;
const read = (p) => {
  const content = notes.get(p);
  return { ok: true, contractVersion: 1, path: p, content, dateManagement: { managed: scenario.managed ?? true },
    sha256: hash(content), size: Buffer.byteLength(content), bindingFingerprint: binding };
};
const fake = {
  async getAtomicWriteStatus() {
    return {
      ok: true, contractVersion: 1, plugin: { id: "obsidian-atomic-write-bridge", version: capability ? "0.9.2" : "0.9.1" },
      datePreparation: { contractVersion: 1, supported: true, ...(capability ? { fileStatProvenance: { contractVersion: 1 } } : {}) },
      frontmatterFormat: { contractVersion: 1, supported: true },
      backend: { kind: "obsidian-vault-process", bindingFingerprint: binding, atomicCas: true, writeEnabled: true },
      limits: { markdownOnly: true },
      protection: { contractVersion: 1, frontmatterDateProperties: { integrations: [
        { pluginId: "frontmatter-date-manager", createdPropertyName: "création", modifiedPropertyName: "modification" },
        ...(extraIntegration ? [extraIntegration] : []),
      ] } },
      settlement: { contractVersion: 1, modifiedTimeFrontmatter: { integrations: [
        { pluginId: "frontmatter-date-manager", propertyName: "modification", settlementObservationDelayMs: 0 }], utcOffsetMinutes: statusOffset } },
    };
  },
  async readAtomicWriteNote({ path: p }) {
    const result = read(p);
    if (scenario.freshReadTamper && scenario.prepared) return { ...result, content: result.content + "x", size: result.size + 1 };
    return result;
  },
  async inspectAtomicFrontmatterFormat({ yaml }) { return nativeFormatFixture(binding).inspectFrontmatterFormat(yaml); },
  async prepareAtomicWriteDate(request) {
    preparations++;
    const p = request.path;
    assert.equal(request.expectedSha256, hash(notes.get(p)));
    const now = Date.now();
    const stat = { ctimeMs: now, mtimeMs: now, ctimeUtcOffsetMinutes: 0, mtimeUtcOffsetMinutes: 0, observedAtMs: now, ...scenario.stat };
    const length = scenario.length ?? 16;
    const created = scenario.created ?? local(stat.ctimeMs, stat.ctimeUtcOffsetMinutes, length);
    const modified = scenario.modified ?? local(stat.mtimeMs, stat.mtimeUtcOffsetMinutes, length);
    let content = notes.get(p).replace("type: rapport", [
      "type: rapport",
      ...(scenario.omitCreated ? [] : [`création: ${created}`]),
      `modification: ${modified}`,
    ].join("\n"));
    if (scenario.nonDateDrift) content = content.replace("type: rapport", "type: dérive");
    if (scenario.alterExisting) content = content.replace(/bornAt: .*/u, "bornAt: 2001-01-01T00:00");
    notes.set(p, content);
    scenario.prepared = true;
    const fileStat = "fileStat" in scenario ? scenario.fileStat : { contractVersion: 1, ...stat };
    return { ...read(p), datePreparation: { kind: "date-manager-before-plan", message: "Note datée par le gestionnaire de dates avant le plan.",
      ...(fileStat === undefined ? {} : { fileStat }) } };
  },
  async replaceAtomicWriteNote(request) {
    writes++;
    throw new Error("no apply is expected in this test");
  },
};

const runtime = createGovernedNoteReplaceRuntime(fake);
const text = new GovernedTextPatchRuntime(runtime);
const frontmatter = new GovernedFrontmatterRuntime(runtime);
const baseRows = new BaseRowsPatchRuntime(runtime, { select: async (target) => ({ ...target, baseSha256: hash("base"),
  baseBindingFingerprint: binding, source: "bases-bridge-supported-filter-snapshot", freshness: "unknown" }) });
const locks = () => {
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try { return db.prepare("SELECT count(*) AS n FROM obsidian_date_preparation_fences").get().n; } finally { db.close(); }
};
const warnings = [];
const originalWarning = logger.warning.bind(logger);
logger.warning = (message, context) => { warnings.push({ message, context }); };

const UNDATED = "---\ntype: rapport\n---\nneedle\n";
let counter = 0;
const callers = {
  text: (p, key) => text.plan({ path: p, operations: [{ op: "append_body", text: "APPEND_SENTINEL" }], idempotencyKey: key }),
  frontmatter: (p, key) => frontmatter.plan({ path: p, operations: [{ op: "set", key: "statut", value: "clos" }], idempotencyKey: key }),
  replace: (p, key) => runtime.planPublicDirect({ path: p, nextContent: "---\ntype: rapport\n---\nAPPEND_SENTINEL\n", idempotencyKey: key }),
  baseRows: (p, key) => baseRows.plan({ baseId: "Projets.base", view: "Vue", path: p, operations: [{ op: "set", key: "statut", value: "clos" }], idempotencyKey: key }),
};
/** One plan on a fresh note; returns the observable outcome. */
async function run(name, options = {}) {
  const p = `${name}-${++counter}.md`;
  notes.set(p, options.content ?? UNDATED);
  scenario = { ...options.scenario };
  const before = { preparations, writes, locks: locks() };
  let outcome, details, error;
  try {
    const planned = await callers[options.caller ?? "text"](p, `${name}-${counter}`);
    outcome = planned.phase;
  } catch (caught) {
    error = caught;
    details = caught?.details;
    outcome = details?.reasonCode ?? String(caught?.message ?? caught);
  }
  return { path: p, outcome, check: details?.preparationCheck, details, error, content: notes.get(p),
    preparations: preparations - before.preparations, writes: writes - before.writes, locksAdded: locks() - before.locks };
}
const expectPlanned = (result, label) => {
  assert.equal(result.outcome, "planned", `${label}: ${result.outcome} ${result.check ?? ""}`);
  assert.equal(result.writes, 0, label);
  assert.equal(result.locksAdded, 0, `${label}: a verified preparation releases its lock with the plan`);
  assert(!result.content.includes("APPEND_SENTINEL"), label);
};
const expectLocked = async (result, check, label) => {
  assert.equal(result.outcome, "date_preparation_unverified", label);
  assert.equal(result.check, check, label);
  assert.equal(result.details.mutationMayHaveApplied, true, label);
  assert.equal(result.preparations, 1, label);
  assert.equal(result.locksAdded, 1, `${label}: the lock is kept`);
  // No fallback and no replay: the next plan is refused without a new preparation.
  const callsBefore = preparations;
  scenario = {};
  await assert.rejects(callers.text(result.path, `${label}-retry-${++counter}`), (e) => e.details?.reasonCode === "date_preparation_unverified");
  assert.equal(preparations, callsBefore, `${label}: never replayed`);
};

try {
  const now = Date.now();
  // 1. Harb's reproduction (issue #147), now with exact Bridge provenance.
  {
    const current = await run("current_creation");
    expectPlanned(current, "current creation");
    assert.equal(current.preparations, 1);
    const seven = await run("creation_seven_minutes_before_plan", { scenario: { stat: { ctimeMs: now - 7 * MINUTE } } });
    expectPlanned(seven, "creation seven minutes before the plan");
    assert.match(seven.content, new RegExp(`création: ${local(now - 7 * MINUTE)}\\n`));
    const historical = await run("historical_creation", { scenario: { stat: { ctimeMs: Date.parse("2020-01-02T03:04:05Z") } } });
    expectPlanned(historical, "creation in 2020");
    assert.match(historical.content, /création: 2020-01-02T03:04\n/);
    const both = await run("both_filesystem_dates_historical", { scenario: { stat: {
      ctimeMs: Date.parse("2020-01-02T03:04:05Z"), mtimeMs: Date.parse("2021-02-03T04:05:06Z") } } });
    expectPlanned(both, "both dates historical");
    assert.match(both.content, /création: 2020-01-02T03:04\nmodification: 2021-02-03T04:05\n/);
    const existing = await run("existing_historical_creation", { content: "---\ntype: rapport\ncréation: 2020-01-02T03:04\nmodification: 2021-02-03T04:05\n---\nneedle\n" });
    expectPlanned(existing, "existing creation");
    assert.equal(existing.preparations, 0);
  }

  // 2. Creation: exact ctime only, never the window.
  await expectLocked(await run("historical_ctime_creation_now", { scenario: {
    stat: { ctimeMs: Date.parse("2020-01-02T03:04:05Z") }, created: local(Date.now()) } }), "created_provenance_mismatch", "creation now despite a historical ctime");
  await expectLocked(await run("creation_future", { scenario: { created: "2099-01-01T10:00" } }), "created_provenance_mismatch", "future creation");

  // 3. Modification: exact mtime, or inside the request window.
  expectPlanned(await run("historical_mtime", { scenario: { stat: { ctimeMs: now - 60 * MINUTE, mtimeMs: Date.parse("2022-05-06T07:08:09Z") } } }), "historical modification equal to mtime");
  expectPlanned(await run("modified_in_window", { scenario: { stat: { mtimeMs: Date.parse("2022-05-06T07:08:09Z") }, modified: local(Date.now()) } }), "modification in the window");
  await expectLocked(await run("modified_neither", { scenario: { stat: { mtimeMs: Date.parse("2022-05-06T07:08:09Z") }, modified: "2021-01-01T00:00" } }),
    "modified_provenance_mismatch", "modification neither mtime nor window");
  // An mtime after its own observation cannot serve as exact provenance.
  await expectLocked(await run("modified_future_mtime", { scenario: { stat: { mtimeMs: Date.parse("2099-01-01T10:00:00Z") } } }),
    "modified_provenance_mismatch", "mtime after the Bridge observation");

  // 4. The Bridge clock bounds ctime (independent of the MCP clock).
  await expectLocked(await run("ctime_after_observation", { scenario: { stat: { ctimeMs: now + 10 * MINUTE, observedAtMs: now } } }),
    "provenance_missing_or_invalid", "ctime after observedAtMs");

  // 5. Advertised capability with a missing or invalid proof: no fallback to the old check.
  for (const [label, fileStat] of [
    ["missing", undefined],
    ["unknown version", { contractVersion: 2, ctimeMs: now, mtimeMs: now, ctimeUtcOffsetMinutes: 0, mtimeUtcOffsetMinutes: 0, observedAtMs: now }],
    ["string timestamp", { contractVersion: 1, ctimeMs: String(now), mtimeMs: now, ctimeUtcOffsetMinutes: 0, mtimeUtcOffsetMinutes: 0, observedAtMs: now }],
    ["seconds timestamp", { contractVersion: 1, ctimeMs: Math.floor(now / 1000), mtimeMs: now, ctimeUtcOffsetMinutes: 0, mtimeUtcOffsetMinutes: 0, observedAtMs: now }],
    ["non-integer offset", { contractVersion: 1, ctimeMs: now, mtimeMs: now, ctimeUtcOffsetMinutes: 30.5, mtimeUtcOffsetMinutes: 0, observedAtMs: now }],
    ["offset beyond 840", { contractVersion: 1, ctimeMs: now, mtimeMs: now, ctimeUtcOffsetMinutes: 0, mtimeUtcOffsetMinutes: 900, observedAtMs: now }],
    ["missing observation", { contractVersion: 1, ctimeMs: now, mtimeMs: now, ctimeUtcOffsetMinutes: 0, mtimeUtcOffsetMinutes: 0 }],
  ]) {
    // The dates written are the ones the old window check accepted.
    await expectLocked(await run("invalid_proof", { scenario: { fileStat } }), "provenance_missing_or_invalid", `proof ${label}`);
  }

  // 6. Old Bridge: refused before any lock or dispatch when a preparation is needed.
  capability = false;
  {
    const old = await run("old_bridge_undated");
    assert.equal(old.outcome, "date_preparation_bridge_upgrade_required");
    assert.equal(old.details.mutationMayHaveApplied, false);
    assert.equal(old.preparations, 0);
    assert.equal(old.locksAdded, 0);
    assert.equal(old.content, UNDATED);
    expectPlanned(await run("old_bridge_dated", { content: "---\ntype: rapport\ncréation: 2020-01-02T03:04\n---\nneedle\n" }), "old Bridge, dated note");
    const outside = await run("old_bridge_outside", { scenario: { managed: false } });
    expectPlanned(outside, "old Bridge, note outside date management");
    assert.equal(outside.preparations, 0);
  }
  capability = true;

  // 7. Same proof for the four callers, including base rows (requireNativeFormat=false).
  for (const caller of Object.keys(callers)) {
    expectPlanned(await run(`caller_${caller}_valid`, { caller, scenario: { stat: { ctimeMs: Date.parse("2020-01-02T03:04:05Z") } } }), `${caller} valid`);
    const refused = await run(`caller_${caller}_invalid`, { caller, scenario: { stat: { ctimeMs: Date.parse("2020-01-02T03:04:05Z") }, created: local(Date.now()) } });
    await expectLocked(refused, "created_provenance_mismatch", `${caller} invalid`);
    capability = false;
    const old = await run(`caller_${caller}_old_bridge`, { caller });
    assert.equal(old.outcome, "date_preparation_bridge_upgrade_required", caller);
    assert.equal(old.preparations, 0, caller);
    capability = true;
  }
  // Base rows now also refuses a non-date change made during the preparation.
  await expectLocked(await run("caller_baseRows_drift", { caller: "baseRows", scenario: { nonDateDrift: true } }), "non_date_drift", "base rows non-date drift");

  // 8. Other closed sub-causes.
  await expectLocked(await run("non_date_drift", { scenario: { nonDateDrift: true } }), "non_date_drift", "non-date drift");
  await expectLocked(await run("fresh_read", { scenario: { freshReadTamper: true } }), "fresh_read_mismatch", "fresh read mismatch");
  await expectLocked(await run("created_missing", { scenario: { omitCreated: true } }), "created_missing_or_duplicate", "creation not added");
  await expectLocked(await run("format", { scenario: { created: "2020-01-02" } }), "format_unqualified", "unqualified date line");
  // A pre-existing creation of another integration altered during a triggered preparation.
  extraIntegration = { pluginId: "update-time", createdPropertyName: "bornAt" };
  await expectLocked(await run("created_drift", { content: "---\ntype: rapport\nbornAt: 2019-01-01T00:00\n---\nneedle\n", scenario: { alterExisting: true } }),
    "created_drift", "existing creation altered");
  expectPlanned(await run("created_kept", { content: "---\ntype: rapport\nbornAt: 2019-01-01T00:00\n---\nneedle\n" }), "existing creation kept");
  extraIntegration = undefined;

  // 9. Minute boundary, formats 16 and 19, per-timestamp offset across DST.
  {
    const edge = Date.parse("2024-03-04T05:06:59.999Z");
    expectPlanned(await run("minute_edge", { scenario: { stat: { ctimeMs: edge } } }), "last millisecond of a minute");
    await expectLocked(await run("minute_edge_next", { scenario: { stat: { ctimeMs: edge }, created: "2024-03-04T05:07" } }), "created_provenance_mismatch", "next minute");
    for (const caller of Object.keys(callers)) {
      const seconds = await run(`seconds_format_${caller}`, { caller, scenario: { length: 19, stat: { ctimeMs: Date.parse("2020-01-02T03:04:05.900Z") } } });
      expectPlanned(seconds, `19-character format, ${caller}`);
      assert.equal(seconds.preparations, 1, `19-character format, ${caller}`);
    }
    await expectLocked(await run("seconds_format_wrong", { scenario: { length: 19, stat: { ctimeMs: Date.parse("2020-01-02T03:04:05Z") }, created: "2020-01-02T03:04:06" } }),
      "created_provenance_mismatch", "19-character format, wrong second");
    // Current offset is summer time (+120); the creation was in winter (+60).
    statusOffset = 120;
    const winter = Date.parse("2020-01-15T12:00:00Z");
    const dst = await run("dst_winter_ctime", { scenario: { stat: { ctimeMs: winter, ctimeUtcOffsetMinutes: 60, mtimeUtcOffsetMinutes: 120 } } });
    expectPlanned(dst, "winter ctime with summer current offset");
    assert.match(dst.content, /création: 2020-01-15T13:00\n/);
    await expectLocked(await run("dst_current_offset", { scenario: { stat: { ctimeMs: winter, ctimeUtcOffsetMinutes: 60, mtimeUtcOffsetMinutes: 120 }, created: local(winter, 120) } }),
      "created_provenance_mismatch", "winter ctime rendered with the current offset");
    statusOffset = 0;
  }

  // 10. Public payload as an MCP client receives it, and the warning log.
  {
    warnings.length = 0;
    const { McpServer, InMemoryTransport } = await import("@modelcontextprotocol/server");
    const { Client } = await import("@modelcontextprotocol/client");
    const { registerGovernedTextPatchTools } = await import("../dist/mcp-server/tools/governedTextPatchTools/registration.js");
    const server = new McpServer({ name: "provenance-fixture", version: "1" });
    const client = new Client({ name: "provenance-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await registerGovernedTextPatchTools(server, runtime);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name, key) => {
      const p = `${name}-PRIVATE_PATH-${++counter}.md`;
      notes.set(p, UNDATED);
      const wire = await client.callTool({ name: "obsidian_text_patch_plan", arguments: { path: p,
        operations: [{ op: "append_body", text: "PRIVATE_BODY" }], idempotencyKey: key } });
      assert.equal(wire.isError, true);
      assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_PATH|PRIVATE_BODY|needle|2020-01-02/u);
      return JSON.parse(wire.content[0].text);
    };
    try {
      scenario = { stat: { ctimeMs: Date.parse("2020-01-02T03:04:05Z") }, created: local(Date.now()) };
      const locked = await call("wire_locked", "wire-locked");
      assert.equal(locked.error.code, "CONFLICT");
      assert.equal(locked.error.details.reasonCode, "date_preparation_unverified");
      assert.equal(locked.error.details.preparationCheck, "created_provenance_mismatch");
      assert.equal(locked.error.details.mutationMayHaveApplied, true);
      assert.match(locked.error.message, /obsidian_operation_close avec datePreparationPaths/u);
      capability = false;
      scenario = {};
      const old = await call("wire_old_bridge", "wire-old-bridge");
      assert.equal(old.error.details.reasonCode, "date_preparation_bridge_upgrade_required");
      assert.equal(old.error.details.mutationMayHaveApplied, false);
      assert.equal(old.error.details.preparationCheck, undefined);
      assert.match(old.error.message, /Rien n'a été modifié et la note n'est pas verrouillée.*Atomic Write Bridge \(0\.9\.2 ou plus\).*Ne réessayez pas avant/u);
      capability = true;
    } finally { await client.close(); await server.close(); }
    const logged = warnings.filter((entry) => entry.context?.operation === "governedDatePreparationCheck");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].context.preparationCheck, "created_provenance_mismatch");
    assert.doesNotMatch(JSON.stringify(logged), /PRIVATE_PATH|wire_locked|PRIVATE_BODY|2020-01-02|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?!:\d{2}\.\d{3}Z)/u);
    // The filter keeps only the closed sub-causes.
    const { McpError, BaseErrorCode } = await import("../dist/types-global/errors.js");
    const forged = publicMcpToolErrorPayload(new McpError(BaseErrorCode.CONFLICT, "x", { reasonCode: "date_preparation_unverified", preparationCheck: "Secret/Note.md" }),
      { operation: "test", toolName: "obsidian_text_patch_plan", params: {} });
    assert.equal(forged.error.details.preparationCheck, undefined);
  }

  console.log("PASS date preparation provenance: Harb cases planned with exact file stat, creation = ctime only, modification = mtime or window, invalid proof keeps the lock without replay, old Bridge refused before dispatch, four callers share the proof, closed public sub-cause and private log.");
} finally {
  logger.warning = originalWarning;
  runtime.close();
  rmSync(root, { recursive: true, force: true });
}
