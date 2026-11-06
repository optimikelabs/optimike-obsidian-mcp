import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "optimike-operon-refusal-test-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.OBSIDIAN_API_KEY = "test-no-network";
process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = path.join(root, "vault");
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = path.join(root, "shared-cache.sqlite");

// #152: a closed Operon refusal code must reach the client with an action
// message, instead of a generic CONFLICT the agent cannot act on.
const { McpError, BaseErrorCode } = await import("../dist/types-global/errors.js");
const { publicMcpToolErrorPayload } = await import("../dist/utils/internal/errorHandler.js");
const { OPERON_REFUSAL_CODES, PUBLIC_OPERON_BRIDGE_REFUSAL_CODES } = await import(
  "../dist/services/operon/refusalCodes.js"
);
const { registerOperonTools } = await import(
  "../dist/mcp-server/tools/operonTools/registration.js"
);

const publicPayload = (error, tool = "operon_create_task") =>
  publicMcpToolErrorPayload(error, { operation: tool, toolName: tool, params: {} });

// 1. Reused idempotency key (journal refusal): code, retryable and action.
{
  const payload = publicPayload(
    new McpError(
      BaseErrorCode.CONFLICT,
      "Idempotency key was already reserved for a different Operon mutation request.",
      { reasonCode: "idempotency_key_reused", retryable: false, idempotencyKey: "secret-key" },
    ),
  );
  assert.equal(payload.error.code, "CONFLICT");
  assert.equal(payload.error.details.reasonCode, "idempotency_key_reused");
  assert.equal(payload.error.details.retryable, false);
  assert.match(payload.error.message, /new idempotencyKey/u);
  assert.match(payload.error.message, /dry-run/u);
  assert.doesNotMatch(payload.error.message, /conflicts with the current resource state/u);
  assert.doesNotMatch(JSON.stringify(payload), /secret-key/u, "the key itself is never echoed");
}

// 2. Every known refusal code gets its own message and survives the allowlist.
for (const code of OPERON_REFUSAL_CODES) {
  const payload = publicPayload(
    new McpError(BaseErrorCode.CONFLICT, "x", { reasonCode: code, retryable: true }),
  );
  assert.equal(payload.error.details.reasonCode, code, code);
  assert.doesNotMatch(payload.error.message, /conflicts with the current resource state/u, code);
}
assert.ok(PUBLIC_OPERON_BRIDGE_REFUSAL_CODES.has("revision_conflict"));
assert.ok(!PUBLIC_OPERON_BRIDGE_REFUSAL_CODES.has("operon_mutation_outcome_uncertain"));

// 3. An unknown code stays masked.
{
  const payload = publicPayload(
    new McpError(BaseErrorCode.CONFLICT, "raw bridge text", { reasonCode: "some_private_code" }),
  );
  assert.equal(payload.error.details.reasonCode, undefined);
  assert.equal(payload.error.message, "The request conflicts with the current resource state.");
}

// 4. Every dry-run mutation tool states the key rule where the agent reads it.
const descriptions = new Map();
await registerOperonTools({
  registerTool: (name, definition) => descriptions.set(name, definition.description),
});
const withDryRun = [...descriptions].filter(([, text]) => /dryRun defaults to true/u.test(text));
assert.ok(withDryRun.length >= 10, `expected the dry-run mutation tools, got ${withDryRun.length}`);
for (const [name, text] of withDryRun) {
  assert.match(text, /new one for the apply/u, name);
  assert.match(text, /idempotency_key_reused/u, name);
}

console.log("PASS Operon refusal codes reach the client with an action message (#152)");
