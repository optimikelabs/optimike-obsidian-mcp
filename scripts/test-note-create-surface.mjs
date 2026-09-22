import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-not-a-secret";
process.env.MCP_WRITE_MODE = "readonly";
const { registerNoteCreateTools } = await import(
  "../dist/mcp-server/tools/noteCreateTools/index.js"
);
const { NoteCreateOperationAdapter } = await import(
  "../dist/services/operations/noteCreateOperationAdapter.js"
);
const { ObsidianNoteReplaceJournal } = await import(
  "../dist/services/operations/obsidianNoteReplaceJournal.js"
);
const { createPolicyDigest, noteCreateHash } = await import(
  "../dist/services/noteCreateContract.js"
);
const { OperationCockpit } = await import(
  "../dist/services/operationCockpit.js"
);
const { selectAvailableToolProfileNames } = await import(
  "../dist/mcp-server/toolProfiles.js"
);
const root = mkdtempSync(path.join(os.tmpdir(), "m4-surface-"));
const journal = new ObsidianNoteReplaceJournal(path.join(root, "plans.sqlite"));
const policy = { version: 1, utcOffsetMinutes: 0, fields: [] },
  policyDigest = createPolicyDigest(policy),
  bindingFingerprint = "a".repeat(64);
const files = new Map();
let writes = 0;
const backend = {
  async preflight(path) {
    return {
      contractVersion: 1,
      path,
      bindingFingerprint,
      absent: true,
      enabled: true,
      policy,
      policyDigest,
    };
  },
  async create(r) {
    writes++;
    assert.equal(files.has(r.path), false);
    files.set(r.path, r.content);
    const { content, ...ids } = r;
    return { ...ids, outcome: "created", reason: "exclusive_create_fsynced" };
  },
  async inspect(path) {
    const content = files.get(path);
    return {
      contractVersion: 1,
      path,
      bindingFingerprint,
      exists: content !== undefined,
      ...(content !== undefined
        ? { content, sha256: noteCreateHash(content) }
        : {}),
    };
  },
};
const client = new Client({ name: "m4-hermetic", version: "1" });
const server = new McpServer({ name: "m4-hermetic", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
try {
  await assert.rejects(
    new NoteCreateOperationAdapter(backend, journal).plan({
      path: "A.md",
      content: "private",
      idempotencyKey: "no",
    }),
    /read-only/,
  );
  const runtime = new NoteCreateOperationAdapter(
    backend,
    journal,
    Date.now,
    () => {},
  );
  registerNoteCreateTools(server, runtime);
  await server.connect(st);
  await client.connect(ct);
  const tools = (await client.listTools()).tools,
    names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "obsidian_note_create_apply",
    "obsidian_note_create_plan",
    "obsidian_note_create_status",
  ]);
  assert.equal(
    tools.find((t) => t.name.endsWith("status")).annotations.readOnlyHint,
    true,
  );
  assert.equal(
    tools.find((t) => t.name.endsWith("apply")).annotations.destructiveHint,
    false,
  );
  assert.equal(
    tools.find((t) => t.name.endsWith("plan")).annotations.readOnlyHint,
    false,
  );
  assert.deepEqual(
    selectAvailableToolProfileNames({
      profile: "standard",
      availableNames: names.slice(1),
    }),
    [],
  );
  assert.deepEqual(
    selectAvailableToolProfileNames({
      profile: "standard",
      availableNames: names,
    }),
    names,
  );
  assert.deepEqual(
    selectAvailableToolProfileNames({
      profile: "tasks",
      availableNames: names,
    }),
    [],
  );
  const call = (name, args) => client.callTool({ name, arguments: args });
  const value = (response) =>
    JSON.parse(
      response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
  const p = value(
    await call("obsidian_note_create_plan", {
      path: "A.md",
      content: "PRIVATE-SENTINEL",
      idempotencyKey: "once",
    }),
  );
  assert.equal(writes, 0);
  const result = await call("obsidian_note_create_apply", {
    planRef: p.planRef,
    idempotencyKey: "once",
  });
  assert.equal(value(result).outcome, "committed");
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE-SENTINEL|plans\.sqlite|bindingFingerprint/,
  );
  await call("obsidian_note_create_apply", {
    planRef: p.planRef,
    idempotencyKey: "once",
  });
  await call("obsidian_note_create_status", { planRef: p.planRef });
  assert.equal(writes, 1);
  const wrong = await call("obsidian_note_create_status", {
    planRef: p.planRef.replace("create", "move"),
  });
  assert.equal(wrong.isError, true);
  assert.doesNotMatch(JSON.stringify(wrong), /PRIVATE-SENTINEL|plans\.sqlite/);
  const unknown = await runtime.plan({
    path: "B.md",
    content: "B",
    idempotencyKey: "unknown",
  });
  const claim = journal.transition(
    unknown.operationId,
    ["planned"],
    "applying",
  );
  journal.transition(
    unknown.operationId,
    ["applying"],
    "outcome_unknown",
    undefined,
    claim.executionOwner.attemptId,
  );
  const cockpit = new OperationCockpit([
    {
      listPendingOperationRows(args) {
        return journal.listPendingOperationRows({
          ...args,
          fallbackOperationKind: "obsidian.note.replace",
          admittedProjectionKinds: ["obsidian.note.create"],
          allowUnprojectedFallback: false,
        });
      },
    },
  ]);
  assert.equal(cockpit.list().operations[0].nextAction, "status");
  assert.equal(
    cockpit.list().operations[0].operationKind,
    "obsidian.note.create",
  );
  console.log(
    "PASS: M4 real MCP protocol, readonly policy, three-tool profile, no destructive overwrite claim, redaction and cockpit status-only reconciliation",
  );
} finally {
  await client.close();
  await server.close();
  journal.close();
  rmSync(root, { recursive: true, force: true });
}
