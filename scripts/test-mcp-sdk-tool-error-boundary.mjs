#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(
  packageJson.dependencies["@modelcontextprotocol/sdk"],
  "1.30.0",
  "the private createToolError hook requires the exact audited SDK version",
);

const {
  installMcpSdkToolErrorPrivacyBoundary,
  installMcpToolPublicErrorBoundary,
  reportOpaqueServerFailure,
} = await import("../dist/mcp-server/server.js");

// Startup/background reporting must not inspect `instanceof`, `.message`, or
// `.stack` itself. A revoked Proxy and throwing Error accessors are therefore
// safe to send through the exact server-lifecycle reporter used by both paths.
const { proxy: revokedStartupFailure, revoke: revokeStartupFailure } =
  Proxy.revocable({}, {});
revokeStartupFailure();
assert.doesNotThrow(() =>
  reportOpaqueServerFailure(revokedStartupFailure, {
    operation: "testRevokedStartupFailure",
    context: { requestId: "startup-hostile-request" },
  }),
);
const throwingAccessorFailure = new Error("private startup failure");
for (const field of ["message", "stack"]) {
  Object.defineProperty(throwingAccessorFailure, field, {
    get() {
      throw new Error("must not escape server error reporting");
    },
  });
}
assert.doesNotThrow(() =>
  reportOpaqueServerFailure(throwingAccessorFailure, {
    operation: "testThrowingStartupAccessors",
    context: { requestId: "startup-accessor-request" },
  }),
);

const unsupportedSdkServer = new McpServer({
  name: "mcp-sdk-privacy-unsupported-test",
  version: "1",
});
Object.defineProperty(unsupportedSdkServer, "createToolError", {
  value: undefined,
});
assert.throws(
  () => installMcpSdkToolErrorPrivacyBoundary(unsupportedSdkServer),
  /createToolError is unavailable/u,
  "startup must fail rather than run without the audited SDK privacy hook",
);

const callerMarker = "P0-SDK-CALLER-MARKER-1c3f";
const backendMarker = "P0-SDK-BACKEND-MARKER-7a92";
const server = new McpServer({ name: "mcp-sdk-privacy-test", version: "1" });
installMcpSdkToolErrorPrivacyBoundary(server);
installMcpToolPublicErrorBoundary(server);

server.tool("throws_raw_error", { caller: z.string() }, async () => {
  throw new Error(`backend=${backendMarker}; caller=${callerMarker}`);
});
server.tool("throws_conflict", async () => {
  const { BaseErrorCode, McpError } = await import(
    "../dist/types-global/errors.js"
  );
  throw new McpError(BaseErrorCode.CONFLICT, backendMarker, {
    retryable: false,
    recoveryAllowed: true,
    recoveryRef: "dvr1_0123456789abcdef0123456789abcdef0123456789abcdef",
    rawMarker: backendMarker,
  });
});
server.tool("throws_timeout", async () => {
  const { BaseErrorCode, McpError } = await import(
    "../dist/types-global/errors.js"
  );
  throw new McpError(BaseErrorCode.TIMEOUT, backendMarker, {
    retryable: true,
    mutationMayHaveApplied: true,
    recoveryAllowed: true,
    recoveryRef: "dvr1_0123456789abcdef0123456789abcdef0123456789abcdef",
  });
});
server.tool("throws_recoverable_unavailable", async () => {
  const { BaseErrorCode, McpError } = await import(
    "../dist/types-global/errors.js"
  );
  throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, backendMarker, {
    retryable: true,
    recoveryAllowed: true,
    recoveryRef: "dvr1_0123456789abcdef0123456789abcdef0123456789abcdef",
    phase: "recovering",
    outcome: "outcome_unknown",
    rawMarker: backendMarker,
  });
});
server.tool(
  "validates_input",
  { expected: z.literal("expected") },
  async () => ({
    content: [{ type: "text", text: "validated" }],
  }),
);
server.tool("voluntary_error", async () => ({
  content: [{ type: "text", text: "voluntary client feedback" }],
  isError: true,
}));

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client(
  { name: "mcp-sdk-privacy-client", version: "1" },
  { capabilities: {} },
);

function text(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function assertBoundaryResult(result, label) {
  assert.equal(result.isError, true, `${label} must remain an MCP error`);
  const serialized = text(result);
  assert.doesNotMatch(serialized, new RegExp(callerMarker, "u"), label);
  assert.doesNotMatch(serialized, new RegExp(backendMarker, "u"), label);
  const payload = JSON.parse(serialized);
  assert.equal(payload.ok, false, `${label} must use the public envelope`);
  assert.match(
    payload.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    `${label} must expose a usable public request id`,
  );
  assert.equal(
    payload.error.details.requestId,
    payload.requestId,
    `${label} must expose the same request id in the canonical error details`,
  );
  assert.equal(
    payload.error.message,
    "The request could not be completed. Use the request id to inspect server diagnostics.",
    `${label} must not reflect the SDK error message`,
  );
}

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  assertBoundaryResult(
    await client.callTool({
      name: "throws_raw_error",
      arguments: { caller: callerMarker },
    }),
    "callback error",
  );
  const conflict = await client.callTool({
    name: "throws_conflict",
    arguments: {},
  });
  assert.equal(conflict.isError, true);
  const conflictPayload = JSON.parse(text(conflict));
  assert.equal(conflictPayload.error.code, "CONFLICT");
  assert.equal(conflictPayload.error.details.retryable, false);
  assert.equal(conflictPayload.error.details.recoveryAllowed, true);
  assert.equal(
    conflictPayload.error.details.recoveryRef,
    "dvr1_0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(JSON.stringify(conflictPayload).includes(backendMarker), false);

  const timeout = await client.callTool({
    name: "throws_timeout",
    arguments: {},
  });
  assert.equal(timeout.isError, true);
  const timeoutPayload = JSON.parse(text(timeout));
  assert.equal(timeoutPayload.error.code, "TIMEOUT");
  assert.equal(timeoutPayload.error.details.retryable, true);
  assert.equal(timeoutPayload.error.details.mutationMayHaveApplied, true);
  assert.equal(timeoutPayload.error.details.recoveryAllowed, true);
  const unavailable = await client.callTool({
    name: "throws_recoverable_unavailable",
    arguments: {},
  });
  assert.equal(unavailable.isError, true);
  const unavailablePayload = JSON.parse(text(unavailable));
  assert.equal(unavailablePayload.error.code, "SERVICE_UNAVAILABLE");
  assert.equal(unavailablePayload.error.details.retryable, true);
  assert.equal(unavailablePayload.error.details.recoveryAllowed, true);
  assert.equal(unavailablePayload.error.details.phase, "recovering");
  assert.equal(unavailablePayload.error.details.outcome, "outcome_unknown");
  assert.equal(
    unavailablePayload.error.details.recoveryRef,
    "dvr1_0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(
    JSON.stringify(unavailablePayload).includes(backendMarker),
    false,
  );
  assertBoundaryResult(
    await client.callTool({
      name: "validates_input",
      arguments: { expected: callerMarker },
    }),
    "input validation error",
  );
  assertBoundaryResult(
    await client.callTool({ name: `unknown_${callerMarker}`, arguments: {} }),
    "unknown tool error",
  );

  const voluntary = await client.callTool({
    name: "voluntary_error",
    arguments: {},
  });
  assert.equal(voluntary.isError, true);
  assert.equal(text(voluntary), "voluntary client feedback");
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}

console.log("MCP SDK tool error privacy boundary passed.");
