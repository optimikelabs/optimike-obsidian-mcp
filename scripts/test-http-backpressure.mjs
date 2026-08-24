#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Hono } from "hono";
import {
  AdmissionRejectedError,
  FairAdmissionController,
  createHttpBackpressureMiddleware,
  createHttpRequestBodyGuardMiddleware,
  httpBackpressureConfig,
} from "../dist/mcp-server/transports/httpBackpressure.js";
import { getHttpRequestState } from "../dist/mcp-server/transports/httpRequestState.js";

function controller(overrides = {}) {
  return new FairAdmissionController({
    maxInFlight: 2,
    maxInFlightPerIdentity: 1,
    expensiveMaxInFlight: 1,
    expensiveMaxInFlightPerIdentity: 1,
    mutationMaxInFlight: 1,
    mutationMaxInFlightPerIdentity: 1,
    maxQueued: 10,
    maxQueuedPerIdentity: 4,
    queueWaitTimeoutMs: 100,
    retryAfterSeconds: 1,
    ...overrides,
  });
}

function testGovernedStateChangesUseMutationBackpressureByDefault() {
  const governedStateChanges = [
    "external_move_apply",
    "external_move_rollback",
    "obsidian_note_replace_plan",
    "obsidian_note_replace_apply",
    "obsidian_note_replace_recover",
    "obsidian_frontmatter_patch_plan",
    "obsidian_frontmatter_patch_apply",
    "obsidian_frontmatter_patch_recover",
    "bases_formula_patch_plan",
    "bases_formula_patch_apply",
    "bases_formula_patch_recover",
    "obsidian_canvas_patch_plan",
    "obsidian_canvas_patch_apply",
    "obsidian_canvas_patch_recover",
    "operon_create_periodic_task",
    "operon_update_periodic_scheduling",
  ];
  for (const toolName of governedStateChanges) {
    assert.equal(
      httpBackpressureConfig.mutationTools.has(toolName),
      true,
      `${toolName} must use mutation backpressure by default`,
    );
  }
}

async function expectReason(promise, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AdmissionRejectedError);
    assert.equal(error.reason, reason);
    return true;
  });
}

async function testGlobalAndPerIdentityLimits() {
  const admission = controller();
  const a = await admission.acquire({
    identityKey: "a",
    operationClass: "standard",
  });
  const queuedA = admission.acquire({
    identityKey: "a",
    operationClass: "standard",
  });
  const b = await admission.acquire({
    identityKey: "b",
    operationClass: "standard",
  });
  assert.equal(admission.getSnapshot().inFlight, 2);
  assert.equal(admission.getSnapshot().queued, 1);

  let queuedAResolved = false;
  queuedA.then(() => {
    queuedAResolved = true;
  });
  b.release();
  await sleep(0);
  assert.equal(
    queuedAResolved,
    false,
    "identity A remains capped while A is active",
  );
  a.release();
  const a2 = await queuedA;
  assert.equal(a2.queued, true);
  assert.ok(a2.waitMs >= 0);
  a2.release();
  assert.equal(admission.getSnapshot().inFlight, 0);
}

async function testExpensiveAndMutationLimits() {
  const admission = controller({ maxInFlight: 3, maxInFlightPerIdentity: 2 });
  const expensiveA = await admission.acquire({
    identityKey: "a",
    operationClass: "expensive",
  });
  const expensiveBPromise = admission.acquire({
    identityKey: "b",
    operationClass: "expensive",
  });

  // An unrelated standard operation can still use remaining global capacity
  // while the expensive pool is saturated.
  const standardC = await admission.acquire({
    identityKey: "c",
    operationClass: "standard",
  });
  assert.equal(admission.getSnapshot().expensiveInFlight, 1);
  assert.equal(admission.getSnapshot().inFlight, 2);

  expensiveA.release();
  const expensiveB = await expensiveBPromise;
  assert.equal(admission.getSnapshot().expensiveInFlight, 1);
  standardC.release();
  expensiveB.release();

  const mutationA = await admission.acquire({
    identityKey: "a",
    operationClass: "mutation",
  });
  const mutationBPromise = admission.acquire({
    identityKey: "b",
    operationClass: "mutation",
  });
  assert.equal(admission.getSnapshot().mutationInFlight, 1);
  mutationA.release();
  const mutationB = await mutationBPromise;
  mutationB.release();
  assert.equal(admission.getSnapshot().mutationInFlight, 0);
}

async function testQueueBoundsTimeoutAndCancellation() {
  const bounded = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    maxQueued: 1,
    maxQueuedPerIdentity: 1,
    queueWaitTimeoutMs: 30,
  });
  const held = await bounded.acquire({
    identityKey: "a",
    operationClass: "standard",
  });
  const queuedTimeout = expectReason(
    bounded.acquire({
      identityKey: "a",
      operationClass: "standard",
    }),
    "timeout",
  );
  await expectReason(
    bounded.acquire({ identityKey: "b", operationClass: "standard" }),
    "queue-full",
  );
  await sleep(40);
  await queuedTimeout;
  assert.equal(bounded.getSnapshot().timedOut, 1);

  const abortController = new AbortController();
  const cancelled = bounded.acquire({
    identityKey: "b",
    operationClass: "standard",
    signal: abortController.signal,
  });
  abortController.abort();
  await expectReason(cancelled, "cancelled");
  assert.equal(bounded.getSnapshot().cancelled, 1);
  held.release();
  held.release();
  assert.equal(bounded.getSnapshot().inFlight, 0, "release is idempotent");
}

async function testRemovalRedispatchesSameIdentityQueue() {
  const admission = controller({
    maxInFlight: 2,
    maxInFlightPerIdentity: 2,
    expensiveMaxInFlight: 1,
    expensiveMaxInFlightPerIdentity: 1,
    queueWaitTimeoutMs: 30,
  });
  const expensiveA = await admission.acquire({
    identityKey: "a",
    operationClass: "expensive",
  });
  const blockedExpensiveB = admission.acquire({
    identityKey: "b",
    operationClass: "expensive",
  });
  // Give the item behind the blocked head a later deadline. If both are
  // enqueued in the same timer bucket, a fast Linux runner can expire both
  // before the timeout removal has a chance to redispatch the queue.
  await sleep(10);
  const standardBehindIt = admission.acquire({
    identityKey: "b",
    operationClass: "standard",
  });

  const blockedTimeout = expectReason(blockedExpensiveB, "timeout");
  await sleep(40);
  await blockedTimeout;
  const standardB = await Promise.race([
    standardBehindIt,
    sleep(200).then(() => {
      throw new Error("queue did not redispatch after the timed-out head item");
    }),
  ]);
  assert.equal(standardB.queued, true);
  standardB.release();
  expensiveA.release();
  assert.equal(admission.getSnapshot().queued, 0);
  assert.equal(admission.getSnapshot().inFlight, 0);
}

async function testRoundRobinFairness() {
  const admission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    maxQueued: 10,
    maxQueuedPerIdentity: 5,
  });
  const held = await admission.acquire({
    identityKey: "holder",
    operationClass: "standard",
  });
  const order = [];
  const a1Promise = admission
    .acquire({ identityKey: "a", operationClass: "standard" })
    .then((lease) => {
      order.push("a1");
      return lease;
    });
  const a2Promise = admission
    .acquire({ identityKey: "a", operationClass: "standard" })
    .then((lease) => {
      order.push("a2");
      return lease;
    });
  const b1Promise = admission
    .acquire({ identityKey: "b", operationClass: "standard" })
    .then((lease) => {
      order.push("b1");
      return lease;
    });

  held.release();
  const a1 = await a1Promise;
  a1.release();
  const b1 = await b1Promise;
  b1.release();
  const a2 = await a2Promise;
  a2.release();
  assert.deepEqual(order, ["a1", "b1", "a2"]);
}

async function testReleaseAfterError() {
  const admission = controller({ maxInFlight: 1 });
  const run = async () => {
    const lease = await admission.acquire({
      identityKey: "a",
      operationClass: "standard",
    });
    try {
      throw new Error("synthetic downstream failure");
    } finally {
      lease.release();
    }
  };
  await assert.rejects(run(), /synthetic downstream failure/u);
  assert.equal(admission.getSnapshot().inFlight, 0);
  const next = await admission.acquire({
    identityKey: "b",
    operationClass: "standard",
  });
  next.release();
}

async function testDeterministicLoad() {
  const admission = controller({
    maxInFlight: 6,
    maxInFlightPerIdentity: 2,
    expensiveMaxInFlight: 2,
    expensiveMaxInFlightPerIdentity: 1,
    mutationMaxInFlight: 1,
    mutationMaxInFlightPerIdentity: 1,
    maxQueued: 200,
    maxQueuedPerIdentity: 30,
    queueWaitTimeoutMs: 5000,
  });
  let active = 0;
  let expensiveActive = 0;
  let mutationActive = 0;
  const activeByIdentity = new Map();

  const tasks = Array.from({ length: 120 }, (_, index) => {
    const identityKey = `client-${index % 8}`;
    const operationClass =
      index % 17 === 0
        ? "mutation"
        : index % 5 === 0
          ? "expensive"
          : "standard";
    return (async () => {
      const lease = await admission.acquire({ identityKey, operationClass });
      active += 1;
      activeByIdentity.set(
        identityKey,
        (activeByIdentity.get(identityKey) ?? 0) + 1,
      );
      if (operationClass !== "standard") expensiveActive += 1;
      if (operationClass === "mutation") mutationActive += 1;
      assert.ok(active <= 6);
      assert.ok((activeByIdentity.get(identityKey) ?? 0) <= 2);
      assert.ok(expensiveActive <= 2);
      assert.ok(mutationActive <= 1);
      await sleep((index % 3) + 1);
      active -= 1;
      activeByIdentity.set(identityKey, activeByIdentity.get(identityKey) - 1);
      if (operationClass !== "standard") expensiveActive -= 1;
      if (operationClass === "mutation") mutationActive -= 1;
      lease.release();
    })();
  });

  await Promise.all(tasks);
  const snapshot = admission.getSnapshot();
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.queued, 0);
  assert.equal(snapshot.admitted, 120);
  assert.ok(snapshot.maxObservedInFlight <= 6);
  assert.ok(snapshot.maxObservedQueued > 0);
}

function attachTestIdentity(c, key) {
  getHttpRequestState(c.req.raw).identity = {
    key,
    pseudonym: `client_${key}`,
    clientId: key,
    subject: key,
    issuer: "test",
    source: "claims",
  };
}

async function testRealMiddlewareResponses() {
  const admission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    expensiveMaxInFlight: 1,
    expensiveMaxInFlightPerIdentity: 1,
    mutationMaxInFlight: 1,
    mutationMaxInFlightPerIdentity: 1,
    maxQueued: 2,
    maxQueuedPerIdentity: 1,
    queueWaitTimeoutMs: 250,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    attachTestIdentity(c, c.req.header("x-test-identity") ?? "anonymous");
    await next();
  });
  app.use("/mcp", createHttpBackpressureMiddleware(admission));
  app.post("/mcp", async (c) => {
    await sleep(Number(c.req.header("x-test-delay-ms") ?? "0"));
    return c.json({ ok: true });
  });

  const mutationBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "obsidian_update_note", arguments: {} },
  });
  const request = (identity, delay) =>
    app.request("http://test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-identity": identity,
        "x-test-delay-ms": String(delay),
      },
      body: mutationBody,
    });

  const first = request("a", 80);
  await sleep(5);
  const second = request("a", 0);
  await sleep(5);
  const rejected = await request("a", 0);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "1");
  assert.equal(
    rejected.headers.get("x-optimike-backpressure"),
    "identity-queue-full",
  );
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error.data.retryable, true);
  const admittedFirst = await first;
  assert.equal(admittedFirst.status, 200);
  await admittedFirst.arrayBuffer();
  const admittedSecond = await second;
  assert.equal(admittedSecond.status, 200);
  assert.equal(
    admittedSecond.headers.get("x-optimike-operation-class"),
    "mutation",
  );
  await admittedSecond.arrayBuffer();
}

async function testOperonPeriodicToolsUseMutationSaturation() {
  for (const [index, toolName] of [
    "operon_create_periodic_task",
    "operon_update_periodic_scheduling",
  ].entries()) {
    const admission = controller({
      maxInFlight: 2,
      maxInFlightPerIdentity: 2,
      mutationMaxInFlight: 1,
      mutationMaxInFlightPerIdentity: 1,
      maxQueued: 0,
      maxQueuedPerIdentity: 0,
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      attachTestIdentity(c, c.req.header("x-test-identity") ?? "anonymous");
      await next();
    });
    app.use("/mcp", createHttpBackpressureMiddleware(admission));
    app.post("/mcp", async (c) => {
      await sleep(Number(c.req.header("x-test-delay-ms") ?? "0"));
      return c.json({ ok: true });
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 100 + index,
      method: "tools/call",
      params: { name: toolName, arguments: {} },
    });
    const request = (identity, delay) =>
      app.request("http://test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-identity": identity,
          "x-test-delay-ms": String(delay),
        },
        body,
      });

    const held = request("periodic-a", 60);
    await sleep(5);
    assert.equal(admission.getSnapshot().mutationInFlight, 1);
    const rejected = await request("periodic-b", 0);
    assert.equal(rejected.status, 503);
    assert.equal(
      rejected.headers.get("x-optimike-operation-class"),
      "mutation",
      `${toolName} must be classified from its JSON-RPC envelope as a mutation`,
    );
    const completed = await held;
    assert.equal(completed.status, 200);
    assert.equal(
      completed.headers.get("x-optimike-operation-class"),
      "mutation",
    );
    await completed.arrayBuffer();
    assert.equal(admission.getSnapshot().mutationInFlight, 0);
  }
}

async function testDownstreamAdmissionErrorIsNotReclassified() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    attachTestIdentity(c, "downstream");
    await next();
  });
  app.use("/mcp", createHttpBackpressureMiddleware(controller()));
  app.onError((error, c) => c.json({ downstreamErrorName: error.name }, 599));
  app.post("/mcp", () => {
    throw new AdmissionRejectedError("queue-full", 1);
  });

  const response = await app.request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  assert.equal(response.status, 599);
  assert.equal(
    (await response.json()).downstreamErrorName,
    "AdmissionRejectedError",
  );
}

async function testRequestBodyParsingIsBoundedAndAdmitted() {
  const admission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    maxQueued: 0,
    maxQueuedPerIdentity: 0,
  });
  const app = new Hono();
  let handlerCalls = 0;
  app.use("*", async (c, next) => {
    attachTestIdentity(c, "bounded-body");
    await next();
  });
  app.use("/mcp", createHttpBackpressureMiddleware(admission));
  app.post("/mcp", (c) => {
    handlerCalls += 1;
    return c.json({ ok: true });
  });

  const oversized = await app.request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(httpBackpressureConfig.maxRequestBodyBytes + 1),
  });
  assert.equal(oversized.status, 413);
  assert.equal(handlerCalls, 0);
  assert.equal(admission.getSnapshot().inFlight, 0);

  let oversizedStreamCancelled;
  const oversizedStreamWasCancelled = new Promise((resolve) => {
    oversizedStreamCancelled = resolve;
  });
  let oversizedChunkSent = false;
  const oversizedChunkedRequest = new Request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      pull(streamController) {
        if (oversizedChunkSent) return;
        oversizedChunkSent = true;
        streamController.enqueue(
          new Uint8Array(httpBackpressureConfig.maxRequestBodyBytes + 1),
        );
      },
      cancel() {
        oversizedStreamCancelled();
      },
    }),
    duplex: "half",
  });
  const oversizedChunkedResponse = await app.request(oversizedChunkedRequest);
  assert.equal(oversizedChunkedResponse.status, 413);
  await oversizedStreamWasCancelled;
  assert.equal(handlerCalls, 0);
  assert.equal(admission.getSnapshot().inFlight, 0);

  let bodyStarted;
  const started = new Promise((resolve) => {
    bodyStarted = resolve;
  });
  let continueBody;
  const bodyGate = new Promise((resolve) => {
    continueBody = resolve;
  });
  let emitted = false;
  const request = new Request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      async pull(streamController) {
        if (emitted) return;
        emitted = true;
        bodyStarted();
        await bodyGate;
        streamController.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
          ),
        );
        streamController.close();
      },
    }),
    duplex: "half",
  });
  const responsePromise = app.request(request);
  await started;
  assert.equal(
    admission.getSnapshot().inFlight,
    1,
    "request-body parsing was not covered by admission",
  );
  continueBody();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(admission.getSnapshot().inFlight, 0);
}

async function testBodyGuardHasBoundedGlobalAdmission() {
  const guardAdmission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    maxQueued: 0,
    maxQueuedPerIdentity: 0,
  });
  const app = new Hono();
  app.use(
    "/mcp",
    createHttpRequestBodyGuardMiddleware(
      { maxBytes: 1024, readTimeoutMs: 500 },
      guardAdmission,
    ),
  );
  app.post("/mcp", (c) => c.json({ error: "synthetic_auth_rejection" }, 401));

  const firstPromise = app.request(
    slowJsonRequest({ jsonrpc: "2.0", id: 18, method: "ping" }, 80),
  );
  await sleep(10);
  assert.equal(guardAdmission.getSnapshot().inFlight, 1);

  const rejected = await app.request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 19, method: "ping" }),
  });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("x-optimike-backpressure"), "queue-full");

  const first = await firstPromise;
  assert.equal(first.status, 401);
  await first.arrayBuffer();
  assert.equal(guardAdmission.getSnapshot().inFlight, 0);
}

function testOneSidedZeroQueueConfigurationIsRejected() {
  const moduleUrl = new URL(
    "../dist/mcp-server/transports/httpBackpressure.js",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(moduleUrl)})`,
    ],
    {
      env: {
        ...process.env,
        MCP_HTTP_MAX_QUEUED: "1",
        MCP_HTTP_MAX_QUEUED_PER_IDENTITY: "0",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /MCP_HTTP_MAX_QUEUED_PER_IDENTITY must be positive/u,
  );
}

function stalledJsonRequest(prefix = '{"jsonrpc":"2.0"') {
  let emitted = false;
  return new Request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      pull(streamController) {
        if (!emitted) {
          emitted = true;
          streamController.enqueue(new TextEncoder().encode(prefix));
          return;
        }
        return new Promise(() => {});
      },
    }),
    duplex: "half",
  });
}

async function testStalledRequestBodyTimesOutAndReleasesLease() {
  const admission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    maxQueued: 0,
    maxQueuedPerIdentity: 0,
  });
  const app = new Hono();
  let handlerCalls = 0;
  app.use("*", async (c, next) => {
    attachTestIdentity(c, "stalled-body");
    await next();
  });
  app.use(
    "/mcp",
    createHttpBackpressureMiddleware(admission, {
      maxBytes: 1024,
      readTimeoutMs: 40,
    }),
  );
  app.post("/mcp", (c) => {
    handlerCalls += 1;
    return c.json({ ok: true });
  });

  const response = await app.request(stalledJsonRequest());
  assert.equal(response.status, 408);
  const body = await response.json();
  assert.equal(body.error.data.readTimeoutMs, 40);
  assert.equal(body.error.data.retryable, true);
  assert.equal(handlerCalls, 0);
  assert.equal(
    admission.getSnapshot().inFlight,
    0,
    "stalled body retained its parsing lease after server timeout",
  );

  const recovered = await app.request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "ping" }),
  });
  assert.equal(recovered.status, 200);
  await recovered.arrayBuffer();
  assert.equal(admission.getSnapshot().inFlight, 0);
}

async function testBodyGuardRunsBeforeBodyReadingRejections() {
  const app = new Hono();
  let rejectionMiddlewareCalls = 0;
  app.use(
    "/mcp",
    createHttpRequestBodyGuardMiddleware({
      maxBytes: 128,
      readTimeoutMs: 40,
    }),
  );
  app.use("/mcp", async (c) => {
    rejectionMiddlewareCalls += 1;
    await c.req.raw.clone().json();
    return c.json({ error: "synthetic_auth_rejection" }, 401);
  });

  const oversized = await app.request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "ping",
      padding: "x".repeat(256),
    }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(rejectionMiddlewareCalls, 0);

  const stalled = await app.request(stalledJsonRequest());
  assert.equal(stalled.status, 408);
  assert.equal(rejectionMiddlewareCalls, 0);

  const bounded = await app.request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 22, method: "ping" }),
  });
  assert.equal(bounded.status, 401);
  assert.equal(rejectionMiddlewareCalls, 1);
}

async function testJsonRpcBatchesAreRejectedFailClosed() {
  const admission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    maxQueued: 0,
    maxQueuedPerIdentity: 0,
  });
  const app = new Hono();
  let handlerCalls = 0;
  app.use("*", async (c, next) => {
    attachTestIdentity(c, "batch-client");
    await next();
  });
  app.use("/mcp", createHttpBackpressureMiddleware(admission));
  app.post("/mcp", (c) => {
    handlerCalls += 1;
    return c.json({ ok: true });
  });

  const response = await app.request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 10, method: "ping" },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "obsidian_update_note", arguments: {} },
      },
    ]),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.data.batchSupported, false);
  assert.equal(body.error.data.maxEnvelopesPerRequest, 1);
  assert.match(body.error.message, /one envelope per POST/u);
  assert.equal(handlerCalls, 0);
  assert.equal(admission.getSnapshot().inFlight, 0);
}

function slowJsonRequest(body, delayMs) {
  let emitted = false;
  return new Request("http://test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      async pull(streamController) {
        if (emitted) return;
        emitted = true;
        await sleep(delayMs);
        streamController.enqueue(
          new TextEncoder().encode(JSON.stringify(body)),
        );
        streamController.close();
      },
    }),
    duplex: "half",
  });
}

async function testReclassificationPreservesDeadlineAndCumulativeWait() {
  const mutationBody = {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "obsidian_update_note", arguments: {} },
  };

  const cumulativeAdmission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    queueWaitTimeoutMs: 150,
  });
  const cumulativeApp = new Hono();
  cumulativeApp.use("*", async (c, next) => {
    attachTestIdentity(c, "cumulative-client");
    await next();
  });
  cumulativeApp.use(
    "/mcp",
    createHttpBackpressureMiddleware(cumulativeAdmission),
  );
  cumulativeApp.post("/mcp", (c) => c.json({ ok: true }));

  const admitted = await cumulativeApp.request(
    slowJsonRequest(mutationBody, 35),
  );
  assert.equal(admitted.status, 200);
  const cumulativeWaitMs = Number(
    admitted.headers.get("x-optimike-queue-wait-ms"),
  );
  assert.ok(
    cumulativeWaitMs >= 20,
    `reclassified admission lost parsing wait: ${cumulativeWaitMs}ms`,
  );
  await admitted.arrayBuffer();
  assert.equal(cumulativeAdmission.getSnapshot().inFlight, 0);

  const deadlineAdmission = controller({
    maxInFlight: 2,
    maxInFlightPerIdentity: 1,
    expensiveMaxInFlight: 1,
    expensiveMaxInFlightPerIdentity: 1,
    mutationMaxInFlight: 1,
    mutationMaxInFlightPerIdentity: 1,
    queueWaitTimeoutMs: 80,
  });
  const held = await deadlineAdmission.acquire({
    identityKey: "holder",
    operationClass: "expensive",
  });
  const deadlineApp = new Hono();
  let handlerCalls = 0;
  deadlineApp.use("*", async (c, next) => {
    attachTestIdentity(c, "deadline-client");
    await next();
  });
  deadlineApp.use("/mcp", createHttpBackpressureMiddleware(deadlineAdmission));
  deadlineApp.post("/mcp", (c) => {
    handlerCalls += 1;
    return c.json({ ok: true });
  });

  const releaseHolder = sleep(110).then(() => held.release());
  const timedOut = await deadlineApp.request(slowJsonRequest(mutationBody, 50));
  assert.equal(timedOut.status, 503);
  assert.equal(timedOut.headers.get("x-optimike-backpressure"), "timeout");
  assert.equal(handlerCalls, 0);
  await timedOut.arrayBuffer();
  await releaseHolder;
  assert.equal(deadlineAdmission.getSnapshot().inFlight, 0);
}

async function testStreamingResponseRetainsLease() {
  const admission = controller({
    maxInFlight: 1,
    maxInFlightPerIdentity: 1,
    maxQueued: 0,
    maxQueuedPerIdentity: 0,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    attachTestIdentity(c, "stream-owner");
    await next();
  });
  app.use("/mcp", createHttpBackpressureMiddleware(admission));
  app.post(
    "/mcp",
    () =>
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode("open"));
          },
        }),
      ),
  );

  const request = () =>
    app.request("http://test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
    });

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(admission.getSnapshot().inFlight, 1);
  const rejected = await request();
  assert.equal(rejected.status, 503);
  await first.body.cancel();
  assert.equal(admission.getSnapshot().inFlight, 0);

  const recovered = await request();
  assert.equal(recovered.status, 200);
  await recovered.body.cancel();
  assert.equal(admission.getSnapshot().inFlight, 0);
}

await testGlobalAndPerIdentityLimits();
testGovernedStateChangesUseMutationBackpressureByDefault();
await testExpensiveAndMutationLimits();
await testQueueBoundsTimeoutAndCancellation();
await testRemovalRedispatchesSameIdentityQueue();
await testRoundRobinFairness();
await testReleaseAfterError();
await testDeterministicLoad();
await testRealMiddlewareResponses();
await testOperonPeriodicToolsUseMutationSaturation();
await testDownstreamAdmissionErrorIsNotReclassified();
await testRequestBodyParsingIsBoundedAndAdmitted();
await testBodyGuardHasBoundedGlobalAdmission();
testOneSidedZeroQueueConfigurationIsRejected();
await testStalledRequestBodyTimesOutAndReleasesLease();
await testBodyGuardRunsBeforeBodyReadingRejections();
await testJsonRpcBatchesAreRejectedFailClosed();
await testReclassificationPreservesDeadlineAndCumulativeWait();
await testStreamingResponseRetainsLease();

console.log(
  "PASS: HTTP admission is globally bounded, isolates verified identities, bounds raw body reads before authentication, rejects one-sided zero queue configuration, guards request bodies before body-reading rejection paths, times out stalled uploads and releases their leases, rejects JSON-RPC batches fail-closed, preserves one deadline and cumulative wait through request classification, separately protects expensive operations and mutations, bounds request-body parsing, retains leases through response streaming, uses a bounded fair queue, redispatches after timeout and cancellation, preserves downstream errors, returns deterministic retry semantics, and remains bounded under deterministic load",
);
