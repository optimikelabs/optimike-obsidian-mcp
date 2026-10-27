import "./lib/isolated-state.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "optimike-operon-recovery-test-"));
process.env.OBSIDIAN_API_KEY = "test-no-network";
process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = path.join(root, "vault");
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = path.join(root, "shared-cache.sqlite");
process.env.MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH = path.join(root, "note-replace.sqlite");
process.env.MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH = path.join(root, "base-formula.sqlite");
process.env.MCP_OBSIDIAN_CANVAS_JOURNAL_PATH = path.join(root, "canvas.sqlite");
process.env.MCP_EXTERNAL_MOVE_JOURNAL_PATH = path.join(root, "external-moves.sqlite");
process.env.OPERON_MUTATION_ALLOWED_PATH_PREFIXES = "Efforts/Projets";

const { OperonService } = await import("../dist/services/operon/service.js");
const { publicMcpToolErrorPayload } = await import("../dist/utils/internal/errorHandler.js");
const { registerOperonTools } = await import("../dist/mcp-server/tools/operonTools/registration.js");

try {
  const service = new OperonService();
  for (const [tool, call] of [
    ["operon_list_pending_recoveries", () => service.pendingRecoveries({})],
    ["operon_recover_mutation", () => service.recoverMutation({
      recoveryRef: `dvr1_${"a".repeat(48)}`,
      idempotencyKey: "test-recovery-key-0001",
      recovery: { kind: "developer-api" },
    })],
  ]) {
    const error = await call().then(
      () => assert.fail(`${tool} must refuse`),
      (caught) => caught,
    );
    const payload = publicMcpToolErrorPayload(error, { operation: tool, toolName: tool, params: {} });
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "FORBIDDEN");
    assert.equal(payload.error.details.reasonCode, "operon_recovery_blocked_by_path_scope", tool);
    assert.equal(payload.error.details.retryable, false);
    assert.match(payload.error.message, /not an empty list/u);
    assert.match(payload.error.message, /do not replay/iu);
    assert.doesNotMatch(JSON.stringify(payload), /Efforts|allowedPathPrefixes|routeEvidence/u);
  }

  // The tools stay discoverable but say they are unavailable before any call.
  const descriptions = new Map();
  await registerOperonTools({
    registerTool: (name, definition) => descriptions.set(name, definition.description),
  });
  for (const tool of ["operon_list_pending_recoveries", "operon_recover_mutation"]) {
    assert.match(descriptions.get(tool), /^UNAVAILABLE in this runtime/u, tool);
    assert.match(descriptions.get(tool), /operon_recovery_blocked_by_path_scope/u);
  }
  assert.doesNotMatch(descriptions.get("operon_get_task"), /UNAVAILABLE/u);

  console.log("PASS Operon recovery refusal is explicit and advertised while the allowlist is set");
} finally {
  rmSync(root, { recursive: true, force: true });
}
