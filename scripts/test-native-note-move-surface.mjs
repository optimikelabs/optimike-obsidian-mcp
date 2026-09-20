import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "fixture-not-a-secret";
process.env.MCP_WRITE_MODE = "readonly";
const { registerNativeNoteMoveTools } = await import("../dist/mcp-server/tools/nativeNoteMoveTools/index.js");
const { NativeNoteMoveOperationAdapter } = await import("../dist/services/operations/nativeNoteMoveOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { sealNativeMove, nativeDigest } = await import("../dist/services/nativeNoteMoveContract.js");
const { OperationCockpit } = await import("../dist/services/operationCockpit.js");
const { selectAvailableToolProfileNames } = await import("../dist/mcp-server/toolProfiles.js");
const root = mkdtempSync(path.join(os.tmpdir(), "m3-surface-"));
const journal = new ObsidianNoteReplaceJournal(path.join(root, "plans.sqlite"));
let calls = 0;
const preflight = sealNativeMove({ sourcePath: "A.md", destinationPath: "B.md", bindingFingerprint: "a".repeat(64), updateLinks: true,
  notes: [{ path: "A.md", sha256: nativeDigest("source"), references: [], backlinks: [], unresolved: [] }] });
const replies = new Map();
const backend = {
  async preflight() { return preflight; },
  async apply(r) {
    calls++;
    const result = { contractVersion: 1, operationId: r.operationId, preconditionDigest: r.preconditionDigest,
      bindingFingerprint: r.bindingFingerprint, outcome: "committed", reason: "native_rename_returned",
      afterSha256: nativeDigest("source"), graphPostflight: "pending", scope: "sealed_neighborhood_only", replayAllowed: false };
    replies.set(r.operationId, result); return result;
  },
  async status(id, digest) { return replies.get(id) ?? { contractVersion: 1, operationId: id, preconditionDigest: digest,
    bindingFingerprint: "a".repeat(64), outcome: "outcome_unknown", reason: "backend_receipt_unavailable",
    graphPostflight: "indeterminate", scope: "sealed_neighborhood_only", replayAllowed: false }; },
};
const client = new Client({ name: "m3-hermetic", version: "1" });
const server = new McpServer({ name: "m3-hermetic", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
try {
  const blocked = new NativeNoteMoveOperationAdapter(backend, journal);
  await assert.rejects(blocked.plan({ sourcePath: "A.md", destinationPath: "B.md", idempotencyKey: "blocked" }), /read-only/);
  assert.equal(calls, 0);
  const runtime = new NativeNoteMoveOperationAdapter(backend, journal, () => {});
  registerNativeNoteMoveTools(server, runtime);
  await server.connect(st); await client.connect(ct);
  const tools = (await client.listTools()).tools;
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ["obsidian_note_move_apply", "obsidian_note_move_plan", "obsidian_note_move_status"]);
  assert.equal(tools.find(t => t.name.endsWith("status")).annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name.endsWith("apply")).annotations.destructiveHint, true);
  assert.equal(tools.find(t => t.name.endsWith("plan")).annotations.readOnlyHint, false);
  assert.deepEqual(selectAvailableToolProfileNames({ profile: "standard", availableNames: names.slice(0, 2) }), []);
  assert.deepEqual(selectAvailableToolProfileNames({ profile: "standard", availableNames: names }), names);
  assert.deepEqual(selectAvailableToolProfileNames({ profile: "tasks", availableNames: names }), []);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const parse = response => JSON.parse(response.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
  const planned = parse(await call("obsidian_note_move_plan", { sourcePath: "A.md", destinationPath: "B.md", idempotencyKey: "once" }));
  assert.equal(planned.phase, "planned"); assert.equal(calls, 0);
  const applied = parse(await call("obsidian_note_move_apply", { planRef: planned.planRef, idempotencyKey: "once" }));
  assert.equal(applied.outcome, "committed"); assert.equal(applied.graph_postflight, "pending");
  await call("obsidian_note_move_apply", { planRef: planned.planRef, idempotencyKey: "once" });
  await call("obsidian_note_move_status", { planRef: planned.planRef });
  assert.equal(calls, 1);
  const invalid = await call("obsidian_note_move_status", { planRef: "obsidian-note-replace:v1:00000000-0000-4000-8000-000000000000" });
  assert.equal(invalid.isError, true);
  assert.doesNotMatch(JSON.stringify(invalid), /plans\.sqlite|bindingFingerprint|nextContent/);
  const uncertain = await runtime.plan({ sourcePath: "A.md", destinationPath: "B.md", idempotencyKey: "uncertain" });
  const claim = journal.transition(uncertain.operationId, ["planned"], "applying");
  journal.transition(uncertain.operationId, ["applying"], "outcome_unknown", undefined, claim.executionOwner.attemptId);
  const cockpit = new OperationCockpit([{ listPendingOperationRows(input) {
    return journal.listPendingOperationRows({ ...input, fallbackOperationKind: "obsidian.note.replace",
      admittedProjectionKinds: ["obsidian.note.move"], allowUnprojectedFallback: false });
  } }]);
  const pending = cockpit.list().operations.find(o => o.planRef === uncertain.planRef);
  assert.equal(pending.operationKind, "obsidian.note.move"); assert.equal(pending.nextAction, "status");
  assert.equal(calls, 1);
  console.log("PASS: M3 real MCP protocol, annotations, readonly policy, complete three-tool profile, domain fence and cockpit status-only recovery");
} finally {
  await client.close(); await server.close(); journal.close(); rmSync(root, { recursive: true, force: true });
}
