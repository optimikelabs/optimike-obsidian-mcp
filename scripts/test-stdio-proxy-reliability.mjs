#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { safelyReadUntrustedErrorField, safelySnapshotUntrustedErrorArray } =
  await import("../dist/utils/security/safeErrorField.js");

// The stdio proxy's backend failure redaction uses this boundary for code,
// causes and aggregate errors. A hostile thrown value must be classified as
// unknown, never crash the proxy while it tries to log a redacted failure.
const hostileBackendFailure = new Proxy(
  {},
  {
    get() {
      throw new Error("stdio-proxy-hostile-backend-marker");
    },
  },
);
for (const field of ["code", "cause", "errors"]) {
  assert.equal(
    safelyReadUntrustedErrorField(hostileBackendFailure, field),
    undefined,
  );
}

const { proxy: revokedAggregateErrors, revoke } = Proxy.revocable([], {});
revoke();
assert.equal(
  safelySnapshotUntrustedErrorArray(revokedAggregateErrors),
  undefined,
  "a revoked aggregate-errors Proxy must be treated as opaque, not crash classification",
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const GLOBAL_WATCHDOG_MS = Number(
  process.env.STDIO_PROXY_FIXTURE_GLOBAL_TIMEOUT_MS ?? "60000",
);
const DEFERRED_WATCHDOG_MS = Number(
  process.env.STDIO_PROXY_FIXTURE_DEFERRED_TIMEOUT_MS ?? "5000",
);

function awaitDeferred(latch, label) {
  let timeout;
  return Promise.race([
    latch.promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `Fixture watchdog expired waiting for ${label} after ${DEFERRED_WATCHDOG_MS}ms`,
            ),
          ),
        DEFERRED_WATCHDOG_MS,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

const admissionErrorsObserved = deferred();
const releaseAdmissionSuccesses = deferred();
const invalidationRequests = deferred();
const drainSiblingStarted = deferred();
const releaseDrainSibling = deferred();
const replacementInitialized = deferred();
const staleToolsListStarted = deferred();
const releaseStaleToolsList = deferred();
const retiredGenerationClosed = deferred();
const drainTimeoutSiblingStarted = deferred();
const releaseDrainTimeoutSibling = deferred();
const drainTimeoutConnectionClosed = deferred();
const RECONNECT_FAILURE_SECRET = "fixture-reconnect-secret";
const SESSION_REPLAY_SECRET = "fixture-session-replay-secret";
const APPLICATION_404_BODY_MARKER = "fixture-application-404-body-marker";
const APPLICATION_503_BODY_MARKER = "fixture-application-503-body-marker";
const state = {
  initializeAttempts: 0,
  initializeCount: 0,
  failedReplacementInitializations: 0,
  admissionRequests: 0,
  admissionErrors: 0,
  invalidationRequests: 0,
  readNetworkRequests: 0,
  mutationRequests: 0,
  mutationReconnectFailureRequests: 0,
  readReconnectFailureRequests: 0,
  drainTimeoutMutationRequests: 0,
  drainTimeoutTriggerRequests: 0,
  generationFenceRequests: 0,
  sessionInvalidMutationReplayRequests: 0,
  sessionInvalidApplicationRequests: 0,
  failNextInitialize: false,
  deferStaleToolsList: false,
  staleToolsListSessionId: undefined,
  invalidationSessionId: undefined,
  expectedReplacementInitializeCount: undefined,
  sessions: new Set(),
  invalidSessions: new Set(),
  initialSessionId: undefined,
};

const backend = createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200).end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/mcp/full") {
    response.writeHead(404).end();
    return;
  }

  const message = await readJson(request);
  if (message.method === "initialize") {
    state.initializeAttempts += 1;
    if (state.failNextInitialize) {
      state.failNextInitialize = false;
      state.failedReplacementInitializations += 1;
      json(response, 503, {
        error: `replacement initialization failed: ${RECONNECT_FAILURE_SECRET}`,
      });
      return;
    }
    state.initializeCount += 1;
    const sessionId = `session-${state.initializeCount}`;
    state.sessions.add(sessionId);
    state.latestSessionId = sessionId;
    state.initialSessionId ??= sessionId;
    if (state.initializeCount === state.expectedReplacementInitializeCount) {
      replacementInitialized.resolve();
    }
    json(
      response,
      200,
      rpcResult(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-proxy-reliability-fixture", version: "0" },
      }),
      { "mcp-session-id": sessionId },
    );
    return;
  }
  if (message.method === "notifications/initialized") {
    response.writeHead(202).end();
    return;
  }
  if (message.method === "tools/list") {
    const sessionId = request.headers["mcp-session-id"];
    if (
      state.deferStaleToolsList &&
      sessionId === state.staleToolsListSessionId
    ) {
      state.deferStaleToolsList = false;
      staleToolsListStarted.resolve();
      await awaitDeferred(releaseStaleToolsList, "release stale tools/list");
    }
    json(
      response,
      200,
      rpcResult(message.id, {
        tools: [
          {
            name: "read_probe",
            description: "deterministic read fixture",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: "mutation_probe",
            description: "deterministic mutation fixture",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false },
          },
          {
            name: "generation_probe",
            description: "generation-bound annotation fixture",
            inputSchema: { type: "object", properties: {} },
            annotations: {
              readOnlyHint: sessionId === state.initialSessionId,
            },
          },
        ],
      }),
    );
    return;
  }
  if (message.method !== "tools/call") {
    response.writeHead(202).end();
    return;
  }

  const sessionId = request.headers["mcp-session-id"];
  if (!state.sessions.has(sessionId) || state.invalidSessions.has(sessionId)) {
    response.writeHead(404).end("session not found");
    return;
  }

  const args = message.params?.arguments ?? {};
  if (args.sessionInvalidThenReplayNetworkLoss) {
    state.sessionInvalidMutationReplayRequests += 1;
    if (state.sessionInvalidMutationReplayRequests === 1) {
      json(response, 404, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or expired session ID." },
        id: message.id,
      });
      return;
    }
    if (state.sessionInvalidMutationReplayRequests === 2) {
      response.destroy(
        Object.assign(new Error(SESSION_REPLAY_SECRET), {
          code: "ECONNRESET",
        }),
      );
      return;
    }
  }
  if (args.sessionInvalidThenApplication503) {
    state.sessionInvalidApplicationRequests += 1;
    if (state.sessionInvalidApplicationRequests === 1) {
      json(response, 404, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or expired session ID." },
        id: message.id,
      });
      return;
    }
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: APPLICATION_503_BODY_MARKER }));
    return;
  }
  if (args.admissionError) {
    state.admissionRequests += 1;
    state.admissionErrors += 1;
    if (state.admissionErrors === 2) admissionErrorsObserved.resolve();
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "backpressure" }));
    return;
  }
  if (args.admissionSuccess) {
    state.admissionRequests += 1;
    await awaitDeferred(
      releaseAdmissionSuccesses,
      "release admitted sibling calls",
    );
    json(
      response,
      200,
      rpcResult(message.id, { content: [{ type: "text", text: "ok" }] }),
    );
    return;
  }
  if (args.invalidateSession && sessionId === state.invalidationSessionId) {
    state.invalidationRequests += 1;
    if (state.invalidationRequests === 2) {
      state.invalidSessions.add(sessionId);
      invalidationRequests.resolve();
    }
    await awaitDeferred(invalidationRequests, "both session invalidations");
    json(response, 404, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid or expired session ID." },
      id: message.id,
    });
    return;
  }
  if (args.application404) {
    response.writeHead(404).end(APPLICATION_404_BODY_MARKER);
    return;
  }
  if (args.networkLossRead) {
    state.readNetworkRequests += 1;
    if (state.readNetworkRequests === 1) {
      response.destroy(
        Object.assign(new Error("fixture read network loss"), {
          code: "ECONNRESET",
        }),
      );
      return;
    }
  }
  if (args.generationFenceNetworkLoss) {
    state.generationFenceRequests += 1;
    response.destroy(
      Object.assign(new Error("fixture generation fence network loss"), {
        code: "ECONNRESET",
      }),
    );
    return;
  }
  if (args.networkLoss) {
    state.mutationRequests += 1;
    // Destroy only this response stream after the request arrived: this is a
    // transport failure with an outcome that could be unknown to the caller.
    response.destroy(
      Object.assign(new Error("fixture network loss"), { code: "ECONNRESET" }),
    );
    return;
  }
  if (args.networkLossReconnectFailure) {
    if (message.params?.name === "mutation_probe") {
      state.mutationReconnectFailureRequests += 1;
    } else {
      state.readReconnectFailureRequests += 1;
    }
    state.failNextInitialize = true;
    response.destroy(
      Object.assign(
        new Error("fixture network loss before reconnect failure"),
        {
          code: "ECONNRESET",
        },
      ),
    );
    return;
  }
  if (args.drainTimeoutSibling) {
    state.drainTimeoutMutationRequests += 1;
    drainTimeoutSiblingStarted.resolve();
    await awaitDeferred(
      releaseDrainTimeoutSibling,
      "release drain-timeout sibling call",
    );
  }
  if (args.drainTimeoutTrigger) {
    state.drainTimeoutTriggerRequests += 1;
    if (state.drainTimeoutTriggerRequests === 1) {
      response.destroy(
        Object.assign(new Error("fixture drain-timeout trigger"), {
          code: "ECONNRESET",
        }),
      );
      return;
    }
  }
  if (args.drainSibling) {
    drainSiblingStarted.resolve();
    await awaitDeferred(releaseDrainSibling, "release retired sibling call");
  }
  json(
    response,
    200,
    rpcResult(message.id, { content: [{ type: "text", text: "ok" }] }),
  );
});

const proxyStderr = [];
let transport;
let client;
let fixtureVault;
let fixtureStage = "runtime scenarios";
const globalWatchdog = setTimeout(() => {
  console.error(
    `Fixture watchdog expired during ${fixtureStage} after ${GLOBAL_WATCHDOG_MS}ms; a backend/proxy latch was not released.`,
  );
  process.exit(1);
}, GLOBAL_WATCHDOG_MS);

try {
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const address = backend.address();
  assert.ok(address && typeof address === "object");
  fixtureVault = await mkdtemp(join(tmpdir(), "optimike-stdio-proxy-"));
  const proxyEntryPath = fileURLToPath(
    new URL("../dist/stdio-proxy.js", import.meta.url),
  );

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [proxyEntryPath, "--tool-profile", "full"],
    // Keep dotenv discovery and runtime inputs independent from a developer's
    // checkout. The proxy still targets the explicit fixture backend below.
    cwd: fixtureVault,
    stderr: "pipe",
    env: {
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: fixtureVault,
      OBSIDIAN_ENABLE_CACHE: "false",
      MCP_WRITE_MODE: "readonly",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(address.port),
      MCP_TOOL_PROFILE: "full",
      MCP_LOG_LEVEL: "error",
      MCP_PROXY_START_TIMEOUT_MS: "5000",
      MCP_PROXY_RETIRED_DRAIN_TIMEOUT_MS: "1000",
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
    },
  });
  transport.stderr?.on("data", (chunk) => {
    const output = String(chunk);
    proxyStderr.push(output);
    if (output.includes("backend generation 1 closed after drained")) {
      retiredGenerationClosed.resolve();
    }
    if (output.includes("closed after drain-timeout")) {
      drainTimeoutConnectionClosed.resolve();
    }
  });
  client = new Client({ name: "stdio-proxy-reliability-test", version: "0" });
  fixtureStage = "initial client connection";
  await client.connect(transport);
  const backendEndpointMarker = `http://127.0.0.1:${address.port}/mcp/full`;
  assert.equal(
    proxyStderr.join("").includes(backendEndpointMarker),
    false,
    "stdio proxy connection stderr must not publish the backend endpoint",
  );
  fixtureStage = "initial tools/list";
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 3);

  fixtureStage = "generation-fence replay";
  await assert.rejects(
    client.callTool({
      name: "generation_probe",
      arguments: { generationFenceNetworkLoss: true },
    }),
    /backend_outcome_unknown/u,
  );
  assert.equal(
    state.generationFenceRequests,
    1,
    "a tool that changes from read-only to mutation must not replay on the replacement generation",
  );
  assert.equal(
    state.initializeCount,
    2,
    "the generation-fence fixture must rotate the backend exactly once",
  );
  const admissionStderrStart = proxyStderr.join("").length;

  fixtureStage = "admission backpressure";
  const admissionSuccesses = Array.from({ length: 8 }, () =>
    client.callTool({
      name: "read_probe",
      arguments: { admissionSuccess: true },
    }),
  );
  const admissionErrors = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      client.callTool({
        name: "read_probe",
        arguments: { admissionError: true },
      }),
    ),
  );
  await awaitDeferred(
    admissionErrorsObserved,
    "two propagated admission errors",
  );
  assert.equal(admissionErrors.length, 2);
  assert.equal(
    admissionErrors.filter((result) => result.status === "rejected").length,
    2,
  );
  assert.equal(
    admissionErrors.some(
      (result) =>
        result.status === "rejected" &&
        /Connection closed/u.test(String(result.reason)),
    ),
    false,
  );
  assert.equal(
    proxyStderr
      .join("")
      .slice(admissionStderrStart)
      .includes("reconnecting once"),
    false,
    "503 admission outcomes must not retire the shared backend transport",
  );
  releaseAdmissionSuccesses.resolve();
  const admissionSuccessResults = await Promise.allSettled(admissionSuccesses);
  assert.equal(
    admissionSuccessResults.filter((result) => result.status === "fulfilled")
      .length,
    8,
  );
  assert.equal(
    admissionSuccessResults.some(
      (result) =>
        result.status === "rejected" &&
        /Connection closed/u.test(String(result.reason)),
    ),
    false,
  );
  await client.callTool({ name: "read_probe", arguments: {} });

  const initializeBeforeApplication404 = state.initializeCount;
  let application404Failure;
  try {
    await client.callTool({
      name: "read_probe",
      arguments: { application404: true },
    });
    assert.fail("the application 404 must reject");
  } catch (error) {
    application404Failure = error;
  }
  assert.match(
    String(application404Failure),
    /MCP backend rejected the request \(status=404\)/u,
  );
  assert.doesNotMatch(
    String(application404Failure),
    /fixture-application-404-body-marker/u,
    "an HTTP 404 body must not be reflected to the stdio client",
  );
  assert.equal(
    state.initializeCount,
    initializeBeforeApplication404,
    "an application 404 must not reconnect the shared transport",
  );

  fixtureStage = "concurrent session invalidation and retired-generation drain";
  const initializeBeforeInvalidation = state.initializeCount;
  state.staleToolsListSessionId = state.latestSessionId;
  state.invalidationSessionId = state.latestSessionId;
  state.expectedReplacementInitializeCount = state.initializeCount + 1;
  state.deferStaleToolsList = true;
  const staleToolsList = client.listTools();
  await awaitDeferred(staleToolsListStarted, "old-generation tools/list");
  const sibling = client.callTool({
    name: "read_probe",
    arguments: { drainSibling: true },
  });
  await awaitDeferred(drainSiblingStarted, "retired sibling call admission");
  const invalidationResults = await Promise.all([
    client.callTool({
      name: "read_probe",
      arguments: { invalidateSession: true },
    }),
    client.callTool({
      name: "read_probe",
      arguments: { invalidateSession: true },
    }),
  ]);
  await awaitDeferred(
    replacementInitialized,
    "single-flight replacement initialization",
  );
  releaseStaleToolsList.resolve();
  const toolsAfterStaleList = await staleToolsList;
  assert.equal(
    toolsAfterStaleList.tools.find((tool) => tool.name === "generation_probe")
      ?.annotations?.readOnlyHint,
    false,
    "a stale generation tools/list result must be discarded and refreshed",
  );
  releaseDrainSibling.resolve();
  await sibling;
  await awaitDeferred(
    retiredGenerationClosed,
    "retired generation 1 transport close after drain",
  );
  assert.equal(invalidationResults.length, 2);
  assert.equal(
    state.initializeCount,
    initializeBeforeInvalidation + 1,
    "concurrent 404 session invalidations must single-flight one initialization",
  );

  fixtureStage = "read replay after network loss";
  const initializeBeforeReadNetworkLoss = state.initializeCount;
  await client.callTool({
    name: "read_probe",
    arguments: { networkLossRead: true },
  });
  assert.equal(
    state.readNetworkRequests,
    2,
    "a proven read-only call may replay once",
  );
  assert.equal(state.initializeCount, initializeBeforeReadNetworkLoss + 1);

  await assert.rejects(
    client.callTool({
      name: "mutation_probe",
      arguments: { networkLoss: true },
    }),
    /backend_outcome_unknown/u,
  );
  assert.equal(
    state.mutationRequests,
    1,
    "mutations must not be replayed after network loss",
  );
  await client.callTool({ name: "read_probe", arguments: {} });

  let sessionInvalidMutationReplayFailure;
  try {
    await client.callTool({
      name: "mutation_probe",
      arguments: { sessionInvalidThenReplayNetworkLoss: true },
    });
    assert.fail(
      "a mutation whose session-invalid retry loses the network must reject",
    );
  } catch (error) {
    sessionInvalidMutationReplayFailure = error;
  }
  assert.match(
    String(sessionInvalidMutationReplayFailure),
    /backend_outcome_unknown/u,
  );
  assert.equal(
    String(sessionInvalidMutationReplayFailure).includes(SESSION_REPLAY_SECRET),
    false,
    "the replay network failure must remain redacted",
  );
  assert.equal(
    state.sessionInvalidMutationReplayRequests,
    2,
    "an exact session-invalid mutation may retry once, but a network failure on that replay must never cause a third execution",
  );
  await client.callTool({ name: "read_probe", arguments: {} });

  let sessionInvalidApplicationFailure;
  try {
    await client.callTool({
      name: "read_probe",
      arguments: { sessionInvalidThenApplication503: true },
    });
    assert.fail("the application 503 after a session retry must reject");
  } catch (error) {
    sessionInvalidApplicationFailure = error;
  }
  assert.match(
    String(sessionInvalidApplicationFailure),
    /MCP backend rejected the request \(status=503\)/u,
  );
  assert.doesNotMatch(
    String(sessionInvalidApplicationFailure),
    /fixture-application-503-body-marker/u,
    "an HTTP 503 body must not be reflected after session retry",
  );
  assert.doesNotMatch(
    String(sessionInvalidApplicationFailure),
    /backend_unreachable|backend_outcome_unknown/u,
    "an application outcome on the permitted retry must propagate unchanged",
  );
  assert.equal(
    state.sessionInvalidApplicationRequests,
    2,
    "the application outcome must not trigger a third execution",
  );

  const initializeAttemptsBeforeMutationReconnectFailure =
    state.initializeAttempts;
  let mutationReconnectFailure;
  try {
    await client.callTool({
      name: "mutation_probe",
      arguments: { networkLossReconnectFailure: true },
    });
    assert.fail("mutation with a failed reconnect must reject");
  } catch (error) {
    mutationReconnectFailure = error;
  }
  assert.match(String(mutationReconnectFailure), /backend_outcome_unknown/u);
  assert.match(String(mutationReconnectFailure), /reconnect=failed/u);
  assert.equal(
    String(mutationReconnectFailure).includes(RECONNECT_FAILURE_SECRET),
    false,
    "reconnect failure details must be redacted",
  );
  assert.equal(state.mutationReconnectFailureRequests, 1);
  assert.equal(
    state.initializeAttempts,
    initializeAttemptsBeforeMutationReconnectFailure + 1,
    "the proxy must attempt one best-effort replacement initialization",
  );
  assert.equal(state.failedReplacementInitializations, 1);
  await client.callTool({ name: "read_probe", arguments: {} });

  let readReconnectFailure;
  try {
    await client.callTool({
      name: "read_probe",
      arguments: { networkLossReconnectFailure: true },
    });
    assert.fail("read with a failed reconnect must reject");
  } catch (error) {
    readReconnectFailure = error;
  }
  assert.match(
    String(readReconnectFailure),
    /MCP backend is unreachable after retry/u,
  );
  assert.doesNotMatch(String(readReconnectFailure), /backend_outcome_unknown/u);
  assert.equal(
    String(readReconnectFailure).includes(RECONNECT_FAILURE_SECRET),
    false,
    "read-only reconnect failures must redact backend response details",
  );
  assert.equal(state.readReconnectFailureRequests, 1);
  assert.equal(state.failedReplacementInitializations, 2);
  await client.callTool({ name: "read_probe", arguments: {} });

  fixtureStage = "forced retired-generation drain timeout";
  const drainTimeoutSibling = client.callTool({
    name: "mutation_probe",
    arguments: { drainTimeoutSibling: true },
  });
  await awaitDeferred(
    drainTimeoutSiblingStarted,
    "drain-timeout sibling admission",
  );
  await client.callTool({
    name: "read_probe",
    arguments: { drainTimeoutTrigger: true },
  });
  assert.equal(
    state.drainTimeoutTriggerRequests,
    2,
    "the proven read-only trigger may replay after replacing the generation",
  );
  await awaitDeferred(
    drainTimeoutConnectionClosed,
    "forced retired-generation close after drain timeout",
  );
  assert.match(
    proxyStderr.join(""),
    /exceeded the 1000ms retired drain; aborting 1 in-flight call\(s\)/u,
  );
  releaseDrainTimeoutSibling.resolve();
  await assert.rejects(
    drainTimeoutSibling,
    /MCP backend rejected the request \(status=unknown\)/u,
  );
  assert.equal(
    state.drainTimeoutMutationRequests,
    1,
    "the blocked mutation must not replay after forced retirement",
  );
  await client.callTool({ name: "read_probe", arguments: {} });

  // Bootstrap failures must not dump the caught error, which can contain a
  // private configured path. The deliberately missing config path is the
  // sentinel; the only accepted stderr is the fixed bootstrap category.
  const bootstrapSentinel = "stdio-proxy-bootstrap-private-sentinel";
  const bootstrapProbe = spawn(process.execPath, [proxyEntryPath], {
    cwd: fixtureVault,
    env: {
      ...process.env,
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: fixtureVault,
      OBSIDIAN_ENABLE_CACHE: "false",
      MCP_WRITE_MODE: "readonly",
      MCP_TOOL_PROFILE: "full",
      MCP_EXTERNAL_ROOTS_FILE: join(
        fixtureVault,
        bootstrapSentinel,
        "external-roots.json",
      ),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const bootstrapStderr = [];
  bootstrapProbe.stderr.on("data", (chunk) =>
    bootstrapStderr.push(String(chunk)),
  );
  const [bootstrapExitCode] = await once(bootstrapProbe, "exit");
  assert.equal(bootstrapExitCode, 1);
  assert.match(bootstrapStderr.join(""), /stdio proxy failed to start\./u);
  assert.equal(
    bootstrapStderr.join("").includes(bootstrapSentinel),
    false,
    "stdio proxy bootstrap stderr must not reflect the caught configuration error",
  );

  console.log("stdio proxy reliability fixture passed");
} catch (error) {
  const stderr = proxyStderr.join("").trim();
  console.error(
    `Fixture failed during ${fixtureStage}; state=${JSON.stringify({
      initializeAttempts: state.initializeAttempts,
      initializeCount: state.initializeCount,
      readNetworkRequests: state.readNetworkRequests,
      invalidationRequests: state.invalidationRequests,
    })}`,
  );
  if (stderr) {
    console.error(`Captured stdio proxy stderr:\n${stderr}`);
  }
  throw error;
} finally {
  fixtureStage = "cleanup: release drain-timeout sibling";
  releaseDrainTimeoutSibling.resolve();
  fixtureStage = "cleanup: client.close";
  await client?.close().catch(() => undefined);
  fixtureStage = "cleanup: transport.close";
  await transport?.close().catch(() => undefined);
  fixtureStage = "cleanup: backend.close";
  backend.closeAllConnections?.();
  await new Promise((resolve) => backend.close(resolve));
  fixtureStage = "cleanup: disposable vault removal";
  if (fixtureVault) {
    await rm(fixtureVault, { recursive: true, force: true });
  }
  clearTimeout(globalWatchdog);
}
