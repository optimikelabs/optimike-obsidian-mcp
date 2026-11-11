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

// 4. A real Bridge HTTP refusal goes through bridgeHttpError: a closed code and
//    its retryable flag are forwarded; an unknown code keeps the generic reason.
{
  const { OperonService } = await import("../dist/services/operon/service.js");
  const service = new OperonService();
  const bridgeRefusal = (status, data) => {
    try {
      service.bridgeHttpError({ isAxiosError: true, response: { status, data } }, "operonQuerySavedFilter");
    } catch (error) {
      return publicPayload(error, "operon_query_saved_filter");
    }
    assert.fail("bridgeHttpError must throw");
  };
  const known = bridgeRefusal(409, {
    ok: false,
    error: { code: "revision_conflict", message: "raw Bridge text" },
    retryable: true,
  });
  assert.equal(known.error.code, "CONFLICT");
  assert.equal(known.error.details.reasonCode, "revision_conflict");
  assert.equal(known.error.details.retryable, true);
  assert.match(known.error.message, /Re-read the task/u);
  assert.doesNotMatch(JSON.stringify(known), /raw Bridge text/u);

  const unknown = bridgeRefusal(409, {
    ok: false,
    error: { code: "private_bridge_detail", message: "secret" },
    retryable: "yes",
  });
  assert.equal(unknown.error.details.reasonCode, "OPERON_BRIDGE_CONFLICT", "generic status reason kept");
  assert.equal(unknown.error.details.retryable, undefined, "a non-boolean retryable is dropped");
  assert.doesNotMatch(JSON.stringify(unknown), /private_bridge_detail|secret/u);
}

// 5. The reuse message never claims the earlier request applied nothing, and
//    the uncertain outcome says it may have applied.
{
  const reused = publicPayload(
    new McpError(BaseErrorCode.CONFLICT, "x", { reasonCode: "idempotency_key_reused", retryable: false }),
  );
  assert.match(reused.error.message, /This call was refused and applied nothing/u);
  assert.match(reused.error.message, /check its result first/u);
  const uncertain = publicPayload(
    new McpError(BaseErrorCode.CONFLICT, "x", {
      reasonCode: "operon_mutation_outcome_uncertain",
      retryable: false,
      mutationMayHaveApplied: true,
    }),
  );
  assert.equal(uncertain.error.details.mutationMayHaveApplied, true);
  assert.match(uncertain.error.message, /may have applied/u);
}

// 5b. A lost journal reservation after a dry-run proves nothing was applied;
//     after an apply receipt the outcome is uncertain.
{
  const { OperonService } = await import("../dist/services/operon/service.js");
  const service = new OperonService();
  const lostReservation = (status) => {
    try {
      service.writeMutationJournal("create", null, { probe: status }, {
        operationId: `00000000-0000-4000-8000-00000000000${status === "planned" ? 1 : 2}`,
        idempotencyKey: `lost-reservation-${status}`,
        status,
      });
    } catch (error) {
      return publicPayload(error);
    }
    assert.fail("a missing reservation must be refused");
  };
  const planned = lostReservation("planned");
  assert.equal(planned.error.details.reasonCode, "idempotency_key_reused");
  assert.equal(planned.error.details.mutationMayHaveApplied, false);
  const applied = lostReservation("applied");
  assert.equal(applied.error.details.reasonCode, "operon_mutation_outcome_uncertain");
  assert.equal(applied.error.details.mutationMayHaveApplied, true);
}

// 6. Every dry-run mutation tool states the key rule where the agent reads it.
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

const pendingPin = publicPayload(
  new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "private native text", {
    reasonCode: "capability_pending_approval",
    retryable: true,
    mutationMayHaveApplied: false,
  }),
  "operon_set_pinned",
);
assert.equal(
  pendingPin.error.details.reasonCode,
  "capability_pending_approval",
);
assert.match(pendingPin.error.message, /Operon settings/u);
assert.doesNotMatch(JSON.stringify(pendingPin), /private native text/u);
