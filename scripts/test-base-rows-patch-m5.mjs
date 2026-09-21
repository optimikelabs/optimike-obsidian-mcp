import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GovernedFrontmatterAtomicServer, FRONTMATTER_FIXTURE_PATH as notePath, FRONTMATTER_INITIAL_CONTENT, fixtureSha256 } from "./fixtures/governed-frontmatter-atomic-server.mjs";
// The fixture deliberately opens many independent process-owned runtimes.
process.setMaxListeners(64);
process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-not-a-secret";
process.env.MCP_WRITE_MODE = "full";
const root = mkdtempSync(path.join(os.tmpdir(), "base-row-patch-"));
const fixture = new GovernedFrontmatterAtomicServer(); await fixture.listen();
process.env.OBSIDIAN_BASE_URL = fixture.baseUrl;
const { config } = await import("../dist/config/index.js");
const { ObsidianRestApiService } = await import("../dist/services/obsidianRestAPI/service.js");
const { createGovernedNoteReplaceRuntime } = await import("../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js");
const { BaseRowSelectionReader } = await import("../dist/services/baseRowSelection.js");
const { BaseRowsPatchRuntime, BASE_ROWS_PREFIX } = await import("../dist/services/baseRowsPatchRuntime.js");
const { registerBaseRowsPatchTools } = await import("../dist/mcp-server/tools/baseRowsPatchTools/index.js");
const rest = new ObsidianRestApiService();
const input = { baseId: "Work.base", view: "Open", path: notePath, operations: [{ op: "set", key: "statut", value: "closed" }, { op: "delete", key: "owner" }], idempotencyKey: "once" };
let cases = 0;
function scenario(id) {
  fixture.content = FRONTMATTER_INITIAL_CONTENT;
  config.obsidianNoteReplaceJournalPath = path.join(root, `${id}.sqlite`);
  let yaml = "views:\n  - name: Open\n    type: table\n", binding = "a".repeat(64), present = true, queries = 0;
  const selection = new BaseRowSelectionReader({
    async read(baseId) { return { ok: true, contractVersion: 1, path: baseId, yaml, sha256: fixtureSha256(yaml), size: Buffer.byteLength(yaml), bindingFingerprint: binding }; },
    async query() { queries++; return { baseSnapshot: { contractVersion: 1, path: input.baseId, sha256: fixtureSha256(yaml), bindingFingerprint: binding }, total: present ? 1 : 0, page: 1, source: "fallback", evaluate: false, warnings: [], rows: present ? [{ file: { path: notePath, name: "Governed Frontmatter" }, props: {} }] : [] }; },
  });
  const notes = createGovernedNoteReplaceRuntime(rest), runtime = new BaseRowsPatchRuntime(notes, selection);
  return { notes, runtime, selection, queries: () => queries,
    changeBase: () => { yaml += "# edited\n"; }, rebind: () => { binding = "b".repeat(64); }, remove: () => { present = false; },
    reopen: () => { notes.close(); const fresh = createGovernedNoteReplaceRuntime(rest); return { notes: fresh, runtime: new BaseRowsPatchRuntime(fresh, selection) }; } };
}
try {
  {
    const f = scenario("nominal"), writes = fixture.successfulWrites, p = await f.runtime.plan(input);
    assert.equal(p.phase, "planned"); assert.equal(fixture.successfulWrites, writes);
    assert.equal((await f.runtime.plan(input)).planRef, p.planRef);
    await assert.rejects(f.runtime.plan({ ...input, operations: [{ op: "set", key: "statut", value: "different" }] }));
    await assert.rejects(f.runtime.apply(p.planRef, "wrong-key"));
    const childRef = p.planRef.replace(BASE_ROWS_PREFIX, "obsidian-note-replace:v1:");
    await assert.rejects(f.notes.statusPublicDirectPlan(childRef));
    await assert.rejects(f.runtime.status(childRef));
    const result = await f.runtime.apply(p.planRef, input.idempotencyKey);
    assert.equal(result.outcome, "committed"); assert.equal(result.recoveryAllowed, false);
    assert.equal(result.recoveryRef, undefined); assert.equal(result.idempotencyKey, undefined);
    assert.equal(fixture.successfulWrites, writes + 1);
    assert.equal(fixture.content.split("---\n").at(-1), FRONTMATTER_INITIAL_CONTENT.split("---\n").at(-1));
    assert.match(fixture.content, /statut: "closed"/); assert.doesNotMatch(fixture.content, /owner:/);
    const reads = f.queries(); f.remove();
    assert.equal((await f.runtime.status(p.planRef)).outcome, "committed");
    assert.equal((await f.runtime.apply(p.planRef, input.idempotencyKey)).outcome, "committed");
    assert.equal(f.queries(), reads, "postpatch view membership is not a new mutation prerequisite");
    assert.equal(fixture.successfulWrites, writes + 1);
    assert.doesNotMatch(JSON.stringify(result), /Private prose|nextContent|projection:v1:/);
    f.notes.close(); cases++;
  }
  for (const change of ["changeBase", "rebind", "remove"]) {
    const f = scenario(change), p = await f.runtime.plan(input), writes = fixture.successfulWrites;
    f[change](); await assert.rejects(f.runtime.apply(p.planRef, input.idempotencyKey));
    assert.equal(fixture.successfulWrites, writes); f.notes.close(); cases++;
  }
  {
    const f = scenario("source-conflict"), p = await f.runtime.plan(input), writes = fixture.successfulWrites;
    fixture.content += "Concurrent prose.\n";
    const result = await f.runtime.apply(p.planRef, input.idempotencyKey);
    assert.equal(result.outcome, "conflict"); assert.equal(fixture.successfulWrites, writes); f.notes.close(); cases++;
  }
  {
    const f = scenario("readonly"), p = await f.runtime.plan(input), writes = fixture.successfulWrites;
    const old = config.mcpWriteMode; config.mcpWriteMode = "readonly";
    try { await assert.rejects(f.runtime.apply(p.planRef, input.idempotencyKey)); await f.runtime.status(p.planRef); }
    finally { config.mcpWriteMode = old; }
    assert.equal(fixture.successfulWrites, writes); f.notes.close(); cases++;
  }
  for (const key of ["file.path", "formula.score", "computed.rank", "création", "__proto__"]) {
    const f = scenario("key-" + cases), writes = fixture.successfulWrites;
    await assert.rejects(f.runtime.plan({ ...input, operations: [{ op: "set", key, value: "unsafe" }] }));
    assert.equal(fixture.successfulWrites, writes); f.notes.close(); cases++;
  }
  for (const after of [false, true]) {
    const f = scenario("loss-" + after), p = await f.runtime.plan(input), calls = fixture.casRequests;
    if (after) fixture.loseResponseAfterWriteNext = true; else fixture.failBeforeWriteNext = true;
    await f.runtime.apply(p.planRef, input.idempotencyKey);
    const restarted = f.reopen();
    const status = await restarted.runtime.status(p.planRef);
    assert.equal(status.outcome, after ? "committed" : "outcome_unknown");
    await restarted.runtime.apply(p.planRef, input.idempotencyKey);
    assert.equal(fixture.casRequests, calls + 1, "unknown child may be observed, never blindly reapplied");
    restarted.notes.close(); cases++;
  }
  {
    const f = scenario("concurrent"), p = await f.runtime.plan(input), writes = fixture.successfulWrites;
    const second = createGovernedNoteReplaceRuntime(rest), runtime2 = new BaseRowsPatchRuntime(second, f.selection);
    const gate = fixture.blockNextCas();
    const first = f.runtime.apply(p.planRef, input.idempotencyKey); await gate.entered;
    const duplicate = await runtime2.apply(p.planRef, input.idempotencyKey);
    assert.notEqual(duplicate.outcome, "committed"); gate.release();
    assert.equal((await first).outcome, "committed");
    assert.equal(fixture.successfulWrites, writes + 1); second.close(); f.notes.close(); cases++;
  }
  {
    const f = scenario("concurrent-view-exit"), p = await f.runtime.plan(input), writes = fixture.successfulWrites;
    const second = createGovernedNoteReplaceRuntime(rest);
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const delayedSelection = {
      select: async target => {
        enter();
        await released;
        return f.selection.select(target);
      },
    };
    const runtime2 = new BaseRowsPatchRuntime(second, delayedSelection);
    const duplicatePromise = runtime2.apply(p.planRef, input.idempotencyKey);
    await entered;
    const winner = await f.runtime.apply(p.planRef, input.idempotencyKey);
    assert.equal(winner.outcome, "committed");
    f.remove(); // The winning patch may remove the row from the view.
    release();
    const duplicate = await duplicatePromise;
    assert.equal(duplicate.outcome, "committed");
    assert.equal(fixture.successfulWrites, writes + 1, "the stale caller must not redispatch");
    second.close(); f.notes.close(); cases++;
  }
  {
    const f = scenario("protocol"), server = new McpServer({ name: "rows-fixture", version: "1" }), client = new Client({ name: "test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); registerBaseRowsPatchTools(server, f.runtime);
    await server.connect(st); await client.connect(ct);
    try {
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map(t => t.name).sort(), ["bases_rows_patch_apply", "bases_rows_patch_plan", "bases_rows_patch_status"]);
      assert.equal(tools.find(t => t.name.endsWith("status")).annotations.readOnlyHint, true);
      const p = JSON.parse((await client.callTool({ name: "bases_rows_patch_plan", arguments: input })).content[0].text);
      assert.equal(p.phase, "planned");
      const result = await client.callTool({ name: "bases_rows_patch_apply", arguments: { planRef: p.planRef, idempotencyKey: input.idempotencyKey } });
      assert.equal(JSON.parse(result.content[0].text).outcome, "committed");
      const invalid = await client.callTool({ name: "bases_rows_patch_status", arguments: { planRef: "bad" } });
      assert.equal(invalid.isError, true); assert.doesNotMatch(JSON.stringify(invalid), /\.sqlite|nextContent/);
    } finally { await client.close(); await server.close(); f.notes.close(); }
    cases++;
  }
  console.log(`PASS: ${cases} M5 durable CAS and real MCP scenarios; Base drift, domain fences, protected keys, restart, loss, replay and single-writer concurrency`);
} finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
