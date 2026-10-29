// Regression (2026-10-29): a Bridge native-move refusal reached the caller as a bare
// VALIDATION_ERROR because the REST client and the public boundary dropped its reasonCode.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-not-a-secret";
process.env.MCP_WRITE_MODE = "full";

let bridgeReason = "move_reference_limit";
let requests = 0;
const bridge = createServer((req, res) => {
  requests++;
  req.resume();
  req.on("end", () => {
    res.writeHead(400, { "content-type": "application/json" });
    // Exact 400 body of the Atomic Write Bridge native-move routes.
    res.end(JSON.stringify({ ok: false, contractVersion: 1, retryable: false, error: {
      code: "native_move_rejected", reasonCode: bridgeReason,
      message: "The native move request could not be admitted or observed." } }));
  });
});
await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${bridge.address().port}`;

const { ObsidianRestApiService } = await import("../dist/services/obsidianRestAPI/service.js");
const { NativeNoteMoveOperationAdapter } = await import("../dist/services/operations/nativeNoteMoveOperationAdapter.js");
const { ObsidianNoteReplaceJournal } = await import("../dist/services/operations/obsidianNoteReplaceJournal.js");
const { registerNativeNoteMoveTools } = await import("../dist/mcp-server/tools/nativeNoteMoveTools/index.js");
const { requestContextService } = await import("../dist/utils/index.js");

const root = mkdtempSync(path.join(os.tmpdir(), "native-move-refusal-"));
const journal = new ObsidianNoteReplaceJournal(path.join(root, "plans.sqlite"));
const rest = new ObsidianRestApiService();
const context = () => requestContextService.createRequestContext({ operation: "NativeNoteMovePreflight" });
const backend = {
  preflight: (sourcePath, destinationPath) =>
    rest.nativeNoteMovePreflight({ contractVersion: 1, sourcePath, destinationPath }, context()),
  apply: async () => { throw new Error("apply must never be reached by a refused plan"); },
  status: async () => { throw new Error("status must never be reached by a refused plan"); },
};
const client = new Client({ name: "move-refusal", version: "1" });
const server = new McpServer({ name: "move-refusal", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
const source = "Efforts/Domaines/PKM & Maîtrise/PKM/ÉLYSIA/Architecture/Standard — Provenance cognitive des notes.md";
const destination = "Efforts/Domaines/PKM & Maîtrise/PKM/ÉLYSIA/Architecture/Standard — Provenance cognitive des notes 2.md";
try {
  registerNativeNoteMoveTools(server, new NativeNoteMoveOperationAdapter(backend, journal, () => {}));
  await server.connect(st);
  await client.connect(ct);
  const plan = async (idempotencyKey) => {
    const response = await client.callTool({ name: "obsidian_note_move_plan",
      arguments: { sourcePath: source, destinationPath: destination, idempotencyKey } });
    assert.equal(response.isError, true);
    const text = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.doesNotMatch(text, /Provenance|Maîtrise|ÉLYSIA|plans\.sqlite/u, "a refusal never echoes paths");
    return JSON.parse(text);
  };
  const expected = {
    move_reference_limit: ["VALIDATION_ERROR", "move_reference_limit", /more than 200 links/u],
    move_neighborhood_limit: ["VALIDATION_ERROR", "move_neighborhood_limit", /More than 16 notes/u],
    metadata_snapshot_unavailable: ["CONFLICT", "move_metadata_unavailable", /stable metadata snapshot/u],
    destination_not_free: ["CONFLICT", "move_destination_not_free", /destination exists/u],
    native_moves_disabled: ["FORBIDDEN", "move_bridge_grant_disabled", /not enabled/u],
  };
  for (const [reason, [code, reasonCode, hint]] of Object.entries(expected)) {
    bridgeReason = reason;
    const refused = await plan("refused-" + reason);
    assert.equal(refused.ok, false, reason);
    assert.equal(refused.error.code, code, reason);
    assert.equal(refused.error.details.reasonCode, reasonCode, reason);
    assert.match(refused.error.details.hint, hint, reason);
    assert.equal(refused.error.message, "The note move was refused. See reasonCode and hint.", reason);
  }
  // An unknown Bridge reason stays closed: no reasonCode or hint crosses the boundary.
  bridgeReason = "native_move_failed";
  const opaque = await plan("refused-opaque");
  assert.equal(opaque.error.code, "VALIDATION_ERROR");
  assert.equal(opaque.error.details?.reasonCode, undefined);
  assert.equal(opaque.error.details?.hint, undefined);
  assert.equal(requests, Object.keys(expected).length + 1);
  console.log("PASS: native-move Bridge refusals reach the caller with a closed reasonCode and hint, never a path");
} finally {
  await client.close();
  await server.close();
  journal.close();
  bridge.close();
  rmSync(root, { recursive: true, force: true });
}
