import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let bridgeModulePromise: Promise<Record<string, unknown>> | undefined;

async function bridgeModule(): Promise<Record<string, unknown>> {
  bridgeModulePromise ??= (async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: ["obsidian"],
      write: false,
      logLevel: "silent",
    });
    const loadedModule = { exports: {} as Record<string, unknown> };
    const nativeRequire = createRequire(import.meta.url);
    const obsidianStub = {
      App: class {},
      Plugin: class {},
      PluginSettingTab: class {},
      Setting: class {},
      TFile: class {},
    };
    const testRequire = (id: string) =>
      id === "obsidian" ? obsidianStub : nativeRequire(id);
    new Function("module", "exports", "require", bundle.outputFiles[0].text)(
      loadedModule,
      loadedModule.exports,
      testRequire,
    );
    return loadedModule.exports;
  })();
  return bridgeModulePromise;
}

async function exported(name: string): Promise<Function> {
  const value = (await bridgeModule())[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as Function;
}

test("Operon Bridge lifecycle remounts one Local REST provider generation", async () => {
  const Bridge = (await bridgeModule()).default as new () => any;
  const registeredCleanups: Array<() => void> = [];
  const providers: Array<{
    api: any;
    handlers: Map<string, Function>;
    unregisters: number;
    failUnregisters: number;
  }> = [];
  const makeProvider = () => {
    const record = {
      api: undefined as any,
      handlers: new Map<string, Function>(),
      unregisters: 0,
      failUnregisters: 0,
    };
    record.api = {
      addRoute: (path: string) => {
        const route = {
          get: (handler: Function) => {
            record.handlers.set(`GET ${path}`, handler);
            return route;
          },
          post: (handler: Function) => {
            record.handlers.set(`POST ${path}`, handler);
            return route;
          },
        };
        return route;
      },
      unregister: () => {
        record.unregisters += 1;
        if (record.failUnregisters > 0) {
          record.failUnregisters -= 1;
          throw new Error("fixture cleanup failure");
        }
      },
    };
    providers.push(record);
    return { getPublicApi: () => record.api };
  };
  const plugins: Record<string, unknown> = {};
  const bridge = new Bridge();
  bridge.loadData = async () => null;
  bridge.addSettingTab = () => undefined;
  bridge.register = (cleanup: () => void) => registeredCleanups.push(cleanup);
  bridge.manifest = { id: "optimike-operon-bridge", version: "test" };
  bridge.app = {
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    plugins: { plugins, getPlugin: (id: string) => plugins[id] ?? null },
  };

  await bridge.onload();
  assert.equal(bridge.restLifecycle.snapshot().state, "unavailable");
  plugins["obsidian-local-rest-api"] = makeProvider();
  bridge.restLifecycle.probeNow();
  assert.equal(bridge.restLifecycle.snapshot().mountGeneration, 1);
  let statusBody: any;
  await providers[0].handlers.get(
    "GET /extensions/optimike-operon-bridge/v1/status",
  )?.(
    {},
    {
      status() {
        return this;
      },
      json(value: unknown) {
        statusBody = value;
      },
    },
  );
  assert.equal(statusBody.lifecycle.state, "ready");
  assert.equal(statusBody.ok, false, "route readiness is not Operon readiness");
  assert.equal(statusBody.bridge.mode, "read-only");
  assert.equal(statusBody.developerApi, null);
  assert.equal(statusBody.index.diagnostics, null);
  assert.equal(statusBody.taxonomy, null);
  assert.deepEqual(statusBody.limitations, ["Operon runtime is not ready."]);
  bridge.restLifecycle.probeNow();
  assert.equal(
    bridge.restLifecycle.snapshot().mountGeneration,
    1,
    "the same provider must not duplicate Operon routes",
  );

  delete plugins["obsidian-local-rest-api"];
  providers[0].failUnregisters = 1;
  bridge.restLifecycle.probeNow();
  assert.equal(providers[0].unregisters, 1);
  assert.equal(bridge.restLifecycle.snapshot().unloadGeneration, 0);
  assert.equal(bridge.restLifecycle.snapshot().state, "degraded");
  bridge.restLifecycle.probeNow();
  assert.equal(providers[0].unregisters, 2);
  assert.equal(bridge.restLifecycle.snapshot().unloadGeneration, 1);
  plugins["obsidian-local-rest-api"] = makeProvider();
  bridge.restLifecycle.probeNow();
  assert.equal(bridge.restLifecycle.snapshot().mountGeneration, 2);
  providers[1].failUnregisters = 2;
  assert.doesNotThrow(
    () => registeredCleanups[0](),
    "plugin unload must contain a persistent unregister failure",
  );
  assert.equal(providers[1].unregisters, 1);
  assert.equal(
    providers[1].failUnregisters,
    1,
    "unload must not retry the same cleanup outside the lifecycle boundary",
  );
  assert.equal(bridge.restLifecycle, null);
  assert.equal(bridge.restCleanup, null);
});

test("Operon HTTP errors redact arbitrary task fields, paths, and backend messages", async () => {
  const payloadFactory = await exported("publicOperonErrorPayload");
  const secret =
    "C:\\Users\\private\\Vault\\Tasks\\Client.md description: confidential";
  const payload = payloadFactory(
    new Error(secret),
    "native-error: task title",
  ) as Record<string, any>;

  assert.equal(payload.ok, false);
  assert.equal(payload.contractVersion, "1");
  assert.equal(payload.status, "failed");
  assert.equal(payload.retryable, false);
  assert.deepEqual(payload.error, {
    code: "bridge_error",
    reasonCode: "bridge_failure",
    message: "The Operon Bridge request could not be completed.",
  });
  assert.ok(Array.isArray(payload.limitations));
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|Client\.md|confidential|title/u,
  );
});

test("Operon HTTP errors expose stable retry semantics for known capability failures", async () => {
  const payloadFactory = await exported("publicOperonErrorPayload");
  const payload = payloadFactory(
    new Error("C:\\Users\\private\\Vault\\Tasks\\Client.md"),
    "mutation_unavailable",
  ) as Record<string, any>;

  assert.equal(payload.status, "unavailable");
  assert.equal(payload.retryable, true);
  assert.equal(payload.error.code, "mutation_unavailable");
  assert.equal(payload.error.reasonCode, "mutation_unavailable");
  assert.doesNotMatch(JSON.stringify(payload), /private|Client\.md/u);
});

test("Operon mutation failures preserve recovery evidence without echoing task payloads", async () => {
  const payloadFactory = await exported("publicOperonMutationFailurePayload");
  const operationId = "8b7e2b7d-4c63-4470-8c28-2af9ddb0de61";
  const recoveryRef = `dvr1_${"a".repeat(48)}`;
  const secret =
    "C:\\Users\\private\\Vault\\Tasks\\Client.md field: confidential";
  const payload = payloadFactory({
    ok: false,
    contractVersion: "1",
    operationId,
    idempotencyKey: "mutation-failure-safe-key",
    status: "outcome-unknown",
    requested: { description: secret, fields: { owner: secret } },
    before: { description: secret },
    after: { description: secret },
    plan: { content: secret },
    nativeProof: { notePath: secret },
    error: { code: "outcome_unverified", message: secret },
    retryable: false,
    mutationMayHaveApplied: true,
    recoveryRequired: true,
    recoveryRef,
    planDigest: "c".repeat(64),
    stale: false,
  }) as Record<string, any>;

  assert.deepEqual(payload, {
    ok: false,
    contractVersion: "1",
    operationId,
    idempotencyKey: "mutation-failure-safe-key",
    status: "outcome-unknown",
    requested: {},
    retryable: false,
    mutationMayHaveApplied: true,
    recoveryRequired: true,
    recoveryRef,
    planDigest: "c".repeat(64),
    source: "operon-live",
    stale: false,
    error: {
      code: "outcome_unverified",
      reasonCode: "outcome_unverified",
      message:
        "The mutation outcome could not be verified. Use the recovery reference before retrying.",
    },
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|Client\.md|confidential|owner/u,
  );
});

test("Operon mutation receipts fail closed for a revoked Proxy or throwing getters", async () => {
  const payloadFactory = await exported("publicOperonMutationFailurePayload");
  const httpFactory = await exported("publicOperonHttpFailurePayload");
  const revoked = Proxy.revocable({ ok: false }, {});
  const httpRevoked = Proxy.revocable({ ok: false }, {});
  revoked.revoke();
  httpRevoked.revoke();
  const getterPayload = Object.create(null, {
    ok: { enumerable: true, get: () => false },
    status: {
      enumerable: true,
      get: () => {
        throw new Error("confidential");
      },
    },
  });

  const fromRevoked = payloadFactory(revoked.proxy) as Record<string, unknown>;
  const fromHttpRevoked = httpFactory(httpRevoked.proxy) as Record<
    string,
    unknown
  >;
  const fromGetter = httpFactory(getterPayload) as Record<string, unknown>;
  assert.deepEqual(fromRevoked.requested, {});
  assert.equal(fromRevoked.status, "failed");
  assert.equal(fromHttpRevoked.ok, false);
  assert.equal(fromGetter.ok, false);
  assert.doesNotMatch(
    JSON.stringify({ fromRevoked, fromGetter }),
    /confidential/u,
  );
});

test("Operon mutation failure receipts reject path and content sentinels as opaque identifiers", async () => {
  const payloadFactory = await exported("publicOperonMutationFailurePayload");
  const secret = "C:\\Users\\private\\Vault\\Tasks\\Client.md confidential";
  const payload = payloadFactory({
    ok: false,
    operationId: secret,
    recoveryRef: secret,
    status: "outcome-unknown",
    error: { code: "outcome-unknown", message: secret },
  }) as Record<string, unknown>;

  assert.equal("operationId" in payload, false);
  assert.equal("recoveryRef" in payload, false);
  assert.equal("idempotencyKey" in payload, false);
  assert.deepEqual(payload.requested, {});
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|Client\.md|confidential/u,
  );
});

test("Operon operation ids fail closed without a cryptographic random source", async () => {
  const factory = await exported("createOpaqueOperationId");
  assert.throws(() => factory({}), /cryptographic random source/u);
  assert.match(
    factory({ getRandomValues: (values: Uint8Array) => values.fill(0x11) }),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

function responseCapture(): Record<string, any> {
  return {
    statusCode: 0,
    jsonCalls: 0,
    status(status: number) {
      this.statusCode = status;
      return this;
    },
    json(payload: unknown) {
      this.jsonCalls += 1;
      this.payload = payload;
    },
  };
}

async function mountedCreateMutationRoute(
  nativeResult: () => unknown,
): Promise<{
  bridge: any;
  handler: Function;
  handlers: Map<string, Function>;
  calls: () => number;
}> {
  const Bridge = (await bridgeModule()).default;
  assert.equal(typeof Bridge, "function");
  const handlers = new Map<string, Function>();
  let nativeCalls = 0;
  const api = {
    addRoute: (path: string) => {
      const route = {
        get: (handler: Function) => {
          handlers.set(`GET ${path}`, handler);
          return route;
        },
        post: (handler: Function) => {
          handlers.set(`POST ${path}`, handler);
          return route;
        },
      };
      return route;
    },
    unregister: () => undefined,
  };
  const bridge = new (Bridge as new () => any)();
  bridge.settings = { mutationsEnabled: true };
  bridge.saveData = async () => undefined;
  bridge.app = {
    plugins: {
      plugins: {
        "obsidian-local-rest-api": { getPublicApi: () => api },
      },
    },
  };
  bridge.manifest = { id: "optimike-operon-bridge" };
  bridge.requireMutationRuntime = async () => ({
    developerApi: {
      executeMutation: async () => {
        nativeCalls += 1;
        return nativeResult();
      },
    },
  });
  bridge.indexState = async () => ({ ready: true });
  bridge.tryMountRestExtension();
  const handler = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/tasks",
  );
  assert.equal(typeof handler, "function");
  return { bridge, handler: handler!, handlers, calls: () => nativeCalls };
}

test("generic REST dateScheduled requests fail before reservation or native preview", async () => {
  const {
    bridge,
    handler: create,
    handlers,
    calls,
  } = await mountedCreateMutationRoute(() => ({ ok: true }));
  const update = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/tasks/:operonId/update",
  );
  const recurrence = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/tasks/:operonId/recurrence",
  );
  assert.equal(typeof update, "function");
  assert.equal(typeof recurrence, "function");

  const cyclicCreateTask: Record<string, unknown> = {
    source: "inline",
    description: "Cyclic input",
  };
  cyclicCreateTask.self = cyclicCreateTask;
  const getterCreateTask = Object.create(null, {
    source: { enumerable: true, value: "inline" },
    description: { enumerable: true, value: "Getter input" },
    nested: {
      enumerable: true,
      get: () => {
        throw new Error("must not invoke caller getters");
      },
    },
  });
  const throwingProxy = new Proxy(
    {
      idempotencyKey: "scheduled-date-proxy",
      task: { source: "inline", description: "Proxy input" },
    },
    {
      ownKeys: () => {
        throw new Error("must not enumerate proxy input");
      },
    },
  );
  let changingOwnKeysCalls = 0;
  const changingOwnKeysProxy = new Proxy(
    {
      idempotencyKey: "scheduled-date-changing-own-keys",
      task: { source: "inline", description: "Changing proxy" },
    },
    {
      ownKeys: () => {
        changingOwnKeysCalls += 1;
        return changingOwnKeysCalls === 1
          ? ["idempotencyKey", "task"]
          : ["idempotencyKey", "task", "dateScheduled"];
      },
    },
  );
  const getterProxy = new Proxy(
    {
      idempotencyKey: "scheduled-date-proxy-getter",
      dateScheduled: "2026-09-01",
      task: { source: "inline", description: "Getter proxy" },
    },
    {
      get: (target, property, receiver) => {
        if (property === "idempotencyKey") {
          return Reflect.get(target, property, receiver);
        }
        throw new Error(
          "generic routes must not reread a proxy after snapshot",
        );
      },
    },
  );

  const requests = [
    {
      label: "create",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-standard-create",
          task: {
            source: "inline",
            description: "Must stay periodic",
            fields: { dateScheduled: "2026-09-01" },
          },
        },
      },
    },
    {
      label: "update",
      handler: update,
      request: {
        params: { operonId: "task123" },
        body: {
          idempotencyKey: "scheduled-date-generic-update",
          expectedRevision: "fnv1a32:12345678",
          patch: { fields: { dateScheduled: "2026-09-01" } },
        },
      },
    },
    {
      label: "recurrence",
      handler: recurrence,
      request: {
        params: { operonId: "task123" },
        body: {
          idempotencyKey: "scheduled-date-recurrence",
          expectedRevision: "fnv1a32:12345678",
          scope: "this-task",
          changes: { dateScheduled: "2026-09-01" },
        },
      },
    },
    {
      label: "create top-level",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-top-level-create",
          dateScheduled: "2026-09-01",
          task: { source: "inline", description: "Must stay periodic" },
        },
      },
    },
    {
      label: "create array container",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-array-task",
          task: [],
        },
      },
    },
    {
      label: "create fields array container",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-array-fields-create",
          task: {
            source: "inline",
            description: "Must stay periodic",
            fields: [],
          },
        },
      },
    },
    {
      label: "create misplaced nested",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-misplaced-create",
          task: {
            source: "inline",
            description: "Must stay periodic",
            metadata: { dateScheduled: "2026-09-01" },
          },
        },
      },
    },
    {
      label: "create array",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-array-create",
          task: {
            source: "inline",
            description: "Must stay periodic",
            tags: [{ dateScheduled: "2026-09-01" }],
          },
        },
      },
    },
    {
      label: "create cycle",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-cycle-create",
          task: cyclicCreateTask,
        },
      },
    },
    {
      label: "create getter",
      handler: create,
      request: {
        body: {
          idempotencyKey: "scheduled-date-getter-create",
          task: getterCreateTask,
        },
      },
    },
    {
      label: "create proxy",
      handler: create,
      request: { body: throwingProxy },
    },
    {
      label: "create changing ownKeys proxy",
      handler: create,
      request: { body: changingOwnKeysProxy },
    },
    {
      label: "create getter proxy",
      handler: create,
      request: { body: getterProxy },
    },
    {
      label: "update array container",
      handler: update,
      request: {
        params: { operonId: "task123" },
        body: {
          idempotencyKey: "scheduled-date-array-update",
          patch: [],
        },
      },
    },
    {
      label: "update fields array container",
      handler: update,
      request: {
        params: { operonId: "task123" },
        body: {
          idempotencyKey: "scheduled-date-array-fields-update",
          patch: { fields: [] },
        },
      },
    },
    {
      label: "recurrence array container",
      handler: recurrence,
      request: {
        params: { operonId: "task123" },
        body: {
          idempotencyKey: "scheduled-date-array-recurrence",
          changes: [],
        },
      },
    },
  ] as const;

  for (const { label, handler, request } of requests) {
    const response = responseCapture();
    await handler!(request, response);
    assert.equal(response.statusCode, 400, `${label} must be rejected`);
    assert.equal(response.payload.error.code, "validation_error");
    assert.equal(
      bridge.mutationReservations.get(request.body.idempotencyKey),
      undefined,
      `${label} must not reserve an idempotency entry`,
    );
    assert.equal(
      bridge.mutationResults.has(request.body.idempotencyKey),
      false,
      `${label} must not cache a mutation result`,
    );
    assert.equal(
      bridge.mutationPreflightFlights.has(request.body.idempotencyKey),
      false,
      `${label} must be rejected before ephemeral preflight coordination`,
    );
  }
  assert.equal(
    calls(),
    0,
    "no rejected request may reach native preview/apply",
  );
  assert.equal(changingOwnKeysCalls, 2);
});

test("periodic REST creation retains its initial scheduled date", async () => {
  const { bridge, handlers } = await mountedCreateMutationRoute(() => ({
    ok: true,
  }));
  const periodic = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/tasks/periodic",
  );
  assert.equal(typeof periodic, "function");
  let received: Record<string, unknown> | undefined;
  bridge.executePeriodicCreateMutation = async (
    body: Record<string, unknown>,
  ) => {
    received = body;
    return { httpStatus: 200, payload: { ok: true } };
  };
  const response = responseCapture();
  await periodic!(
    {
      body: {
        idempotencyKey: "periodic-scheduled-date-allowed",
        description: "Initial periodic task",
        periodicKind: "daily",
        fields: { dateScheduled: "2026-09-01" },
      },
    },
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(received?.fields, { dateScheduled: "2026-09-01" });
});

test("a mutation-runtime failure before Bridge reservation is a safe same-key retry", async () => {
  const secret = "C:\\Users\\private\\Vault\\Tasks\\Client.md confidential";
  const { bridge, handlers, calls } = await mountedCreateMutationRoute(() => ({
    ok: true,
  }));
  const update = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/tasks/:operonId/update",
  );
  assert.equal(typeof update, "function");

  const requireMutationRuntime = bridge.constructor.prototype
    .requireMutationRuntime as Function;
  let indexSettled = false;
  let capabilityAvailable = true;
  let nativeMutationCalls = 0;
  const runtime = {
    developerApi: {
      hasMutationCapability: () => capabilityAvailable,
      hasRecoverySupport: () => true,
      executeMutation: async () => {
        nativeMutationCalls += 1;
        return { ok: true };
      },
    },
  };
  bridge.requireRuntime = () => runtime;
  bridge.runtimeTaskCount = () => 1;
  bridge.indexState = async () => ({
    ready: indexSettled,
    diagnostics: { taskCount: indexSettled ? 1 : 0 },
  });
  bridge.requireMutationRuntime = (capability: string) =>
    requireMutationRuntime.call(bridge, capability);
  bridge.oneTask = async () => ({
    task: { operonId: "task-1", revision: "revision-1" },
  });

  const request = {
    params: { operonId: "task-1" },
    body: {
      idempotencyKey: "pre-dispatch-runtime-same-key",
      expectedRevision: "revision-1",
      dryRun: true,
      patch: { fields: { secret } },
    },
  };
  const first = responseCapture();
  await update!(request, first);

  assert.equal(first.statusCode, 503);
  assert.equal(first.payload.ok, false);
  assert.equal(first.payload.status, "not-ready");
  assert.equal(first.payload.error.code, "operon_index_not_settled");
  assert.equal(first.payload.retryable, true);
  assert.equal(first.payload.mutationMayHaveApplied, false);
  assert.equal(first.payload.idempotencyKey, request.body.idempotencyKey);
  assert.deepEqual(first.payload.requested, {});
  assert.equal(
    bridge.mutationReservations.get(request.body.idempotencyKey),
    undefined,
  );
  assert.equal(bridge.mutationResults.has(request.body.idempotencyKey), false);
  assert.equal(calls(), 0);
  assert.equal(nativeMutationCalls, 0);
  assert.doesNotMatch(
    JSON.stringify(first.payload),
    /private|Client\.md|confidential|secret/u,
  );

  indexSettled = true;
  capabilityAvailable = false;
  const capability = responseCapture();
  await update!(
    {
      ...request,
      body: {
        ...request.body,
        idempotencyKey: "pre-dispatch-capability-unavailable",
      },
    },
    capability,
  );
  assert.equal(capability.statusCode, 503);
  assert.equal(
    capability.payload.error.code,
    "operon_mutation_capability_unavailable",
  );
  assert.equal(capability.payload.mutationMayHaveApplied, false);

  capabilityAvailable = true;
  const second = responseCapture();
  await update!(request, second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.payload.status, "planned");
  assert.equal(nativeMutationCalls, 1);
});

test("an in-flight same-key HTTP replay joins before transient runtime probes", async () => {
  const { bridge, handlers } = await mountedCreateMutationRoute(() => ({
    ok: true,
  }));
  const update = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/tasks/:operonId/update",
  );
  assert.equal(typeof update, "function");

  let resolveNative!: (result: Record<string, unknown>) => void;
  const nativeStarted = new Promise<void>((resolve) => {
    bridge.requireMutationRuntime = async () => {
      bridge.requireMutationRuntimeCalls =
        (bridge.requireMutationRuntimeCalls ?? 0) + 1;
      if (bridge.requireMutationRuntimeCalls > 1) {
        throw new Error("unrelated concurrent runtime refresh failed");
      }
      return {
        developerApi: {
          executeMutation: async () => {
            resolve();
            return new Promise<Record<string, unknown>>((done) => {
              resolveNative = done;
            });
          },
        },
      };
    };
  });
  bridge.oneTask = async () => ({
    task: { operonId: "task-1", revision: "revision-1" },
  });

  const request = {
    params: { operonId: "task-1" },
    body: {
      idempotencyKey: "concurrent-pre-reservation-key",
      expectedRevision: "revision-1",
      dryRun: true,
      patch: { fields: { priority: "A" } },
    },
  };
  const first = responseCapture();
  const firstPromise = update!(request, first);
  await nativeStarted;
  const firstReservation = bridge.mutationReservations.get(
    request.body.idempotencyKey,
  );
  assert.ok(firstReservation);

  const sameSignatureReplay = responseCapture();
  const sameSignaturePromise = update!(request, sameSignatureReplay);
  await Promise.resolve();
  assert.equal(
    bridge.requireMutationRuntimeCalls,
    1,
    "an identical replay must join before probing runtime again",
  );

  const differentSignatureFailure = responseCapture();
  await update!(
    {
      ...request,
      body: {
        ...request.body,
        patch: { fields: { priority: "B" } },
      },
    },
    differentSignatureFailure,
  );
  assert.equal(differentSignatureFailure.statusCode, 409);
  assert.equal(
    bridge.mutationReservations.get(request.body.idempotencyKey),
    firstReservation,
    "a conflicting key must not settle call A",
  );
  assert.equal(bridge.mutationResults.has(request.body.idempotencyKey), false);

  resolveNative({ ok: true, code: "planned", retryable: false });
  await Promise.all([firstPromise, sameSignaturePromise]);
  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.status, "planned");
  assert.equal(sameSignatureReplay.statusCode, 200);
  assert.deepEqual(sameSignatureReplay.payload, first.payload);
  assert.equal(bridge.requireMutationRuntimeCalls, 1);
  assert.equal(
    bridge.mutationReservations.get(request.body.idempotencyKey),
    undefined,
  );
});

test("create and recovery gates stay pre-dispatch until their native call begins", async () => {
  const {
    bridge,
    handler: create,
    handlers,
  } = await mountedCreateMutationRoute(() => ({ ok: true }));
  const recover = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/mutations/recover",
  );
  const workflowRecover = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/task-workflows/recover",
  );
  assert.equal(typeof recover, "function");
  assert.equal(typeof workflowRecover, "function");

  const cases = [
    {
      key: "create-gate-same-key",
      handler: create,
      request: {
        body: {
          idempotencyKey: "create-gate-same-key",
          dryRun: true,
          task: { source: "inline", description: "gate" },
        },
      },
      install: (attempt: number) => {
        bridge.requireMutationRuntime = async () => {
          if (attempt === 0) throw new Error("runtime startup transient");
          return {
            developerApi: {
              executeMutation: async () => ({
                ok: true,
                code: "planned",
                retryable: false,
              }),
            },
          };
        };
      },
    },
    {
      key: "recovery-gate-same-key",
      handler: recover!,
      request: {
        body: {
          idempotencyKey: "recovery-gate-same-key",
          recoveryRef: `dvr1_${"a".repeat(48)}`,
        },
      },
      install: (attempt: number) => {
        bridge.requireDeveloperApiMutationRuntime = async () => {
          if (attempt === 0) throw new Error("recovery grant transient");
          return {
            developerApi: {
              recoverMutation: async () => ({
                ok: true,
                code: "applied",
                retryable: false,
              }),
            },
          };
        };
      },
    },
    {
      key: "workflow-recovery-gate-same-key",
      handler: workflowRecover!,
      request: {
        body: {
          idempotencyKey: "workflow-recovery-gate-same-key",
          recoveryRef: `dvr1_${"b".repeat(48)}`,
          kind: "periodic-create",
        },
      },
      install: (attempt: number) => {
        bridge.requireTaskWorkflowRecoveryRuntime = async () => {
          if (attempt === 0)
            throw new Error("workflow recovery grant transient");
          return {
            developerApi: {
              recoverTaskWorkflow: async () => ({
                ok: true,
                code: "applied",
                retryable: false,
              }),
            },
          };
        };
      },
    },
  ];

  for (const scenario of cases) {
    scenario.install(0);
    const transient = responseCapture();
    await scenario.handler(scenario.request, transient);
    assert.equal(transient.statusCode, 503, scenario.key);
    assert.equal(transient.payload.mutationMayHaveApplied, false, scenario.key);
    assert.equal(bridge.mutationReservations.get(scenario.key), undefined);
    assert.equal(bridge.mutationResults.has(scenario.key), false);

    scenario.install(1);
    const replay = responseCapture();
    await scenario.handler(scenario.request, replay);
    assert.equal(replay.statusCode, 200, scenario.key);
    assert.equal(replay.payload.idempotencyKey, scenario.key);
  }
});

test("post-call ambiguity stays durable for create and both recovery routes", async () => {
  const {
    bridge,
    handler: create,
    handlers,
  } = await mountedCreateMutationRoute(() => ({ ok: true }));
  const recover = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/mutations/recover",
  );
  const workflowRecover = handlers.get(
    "POST /extensions/optimike-operon-bridge/v1/task-workflows/recover",
  );
  const scenarios = [
    {
      key: "create-post-call-unknown",
      handler: create,
      request: {
        body: {
          idempotencyKey: "create-post-call-unknown",
          dryRun: false,
          task: { source: "inline", description: "ambiguous" },
        },
      },
      install: () => {
        bridge.requireMutationRuntime = async () => ({
          developerApi: {
            executeMutation: async () => {
              throw new Error("native call became ambiguous");
            },
          },
        });
      },
    },
    {
      key: "recovery-post-call-unknown",
      handler: recover!,
      request: {
        body: {
          idempotencyKey: "recovery-post-call-unknown",
          recoveryRef: `dvr1_${"c".repeat(48)}`,
        },
      },
      install: () => {
        bridge.requireDeveloperApiMutationRuntime = async () => ({
          developerApi: {
            recoverMutation: async () => {
              throw new Error("native recovery became ambiguous");
            },
          },
        });
      },
    },
    {
      key: "workflow-recovery-post-call-unknown",
      handler: workflowRecover!,
      request: {
        body: {
          idempotencyKey: "workflow-recovery-post-call-unknown",
          recoveryRef: `dvr1_${"d".repeat(48)}`,
          kind: "periodic-create",
        },
      },
      install: () => {
        bridge.requireTaskWorkflowRecoveryRuntime = async () => ({
          developerApi: {
            recoverTaskWorkflow: async () => {
              throw new Error("workflow recovery became ambiguous");
            },
          },
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    scenario.install();
    const first = responseCapture();
    await scenario.handler(scenario.request, first);
    assert.equal(first.statusCode, 500, scenario.key);
    assert.equal(first.payload.status, "outcome-unknown", scenario.key);
    assert.equal(first.payload.mutationMayHaveApplied, true, scenario.key);
    const replay = responseCapture();
    await scenario.handler(scenario.request, replay);
    assert.equal(replay.statusCode, 500, scenario.key);
    assert.equal(replay.payload.status, "outcome-unknown", scenario.key);
    assert.equal(replay.payload.mutationMayHaveApplied, true, scenario.key);
  }
});

test("registered create route normalizes a resolved native failure and replays its safe receipt", async () => {
  const secret = "C:\\Users\\private\\Vault\\Tasks\\Client.md confidential";
  const recoveryRef = `dvr1_${"a".repeat(48)}`;
  const { handler, calls } = await mountedCreateMutationRoute(() => ({
    // The native promise resolves (a transport 2xx) with an operation failure.
    ok: false,
    code: "outcome-unknown",
    message: secret,
    retryable: false,
    mutationMayHaveApplied: true,
    recoveryRef,
    planDigest: "b".repeat(64),
    nativeProof: { path: secret, task: { description: secret } },
  }));
  const request = {
    body: {
      idempotencyKey: "native-route-failure-key",
      dryRun: false,
      task: {
        source: "inline",
        targetPath: "Tasks/Client.md",
        description: secret,
      },
    },
  };
  const first = responseCapture();
  await handler(request, first);
  const second = responseCapture();
  await handler(request, second);

  assert.equal(first.statusCode, 500);
  assert.equal(calls(), 1);
  assert.deepEqual(second.payload, first.payload);
  assert.equal(first.payload.ok, false);
  assert.equal(first.payload.idempotencyKey, "native-route-failure-key");
  assert.equal(first.payload.status, "outcome-unknown");
  assert.equal(first.payload.recoveryRef, recoveryRef);
  assert.equal(first.payload.planDigest, "b".repeat(64));
  assert.deepEqual(first.payload.requested, {});
  assert.doesNotMatch(
    JSON.stringify(first.payload),
    /private|Client\.md|confidential|description|nativeProof/u,
  );
});

test("registered create route fails closed for hostile native result getters", async () => {
  const secret = "C:\\Users\\private\\Vault\\Tasks\\Client.md confidential";
  const hostileNative = new Proxy(
    {},
    {
      get() {
        throw new Error(secret);
      },
    },
  );
  const { handler, calls } = await mountedCreateMutationRoute(
    () => hostileNative,
  );
  const response = responseCapture();
  await handler(
    {
      body: {
        idempotencyKey: "hostile-route-failure-key",
        dryRun: false,
        task: { source: "inline", description: secret },
      },
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.idempotencyKey, "hostile-route-failure-key");
  assert.deepEqual(response.payload.requested, {});
  assert.equal(response.payload.error.code, "outcome_unverified");
  assert.doesNotMatch(
    JSON.stringify(response.payload),
    /private|Client\.md|confidential/u,
  );

  // The first call had already passed Bridge reservation and invoked a hostile
  // native result. It is not safe to infer that dispatch did not happen, so a
  // same-key retry must replay the uncertainty rather than dispatch again.
  const retry = responseCapture();
  await handler(
    {
      body: {
        idempotencyKey: "hostile-route-failure-key",
        dryRun: false,
        task: { source: "inline", description: secret },
      },
    },
    retry,
  );
  assert.equal(retry.statusCode, 500);
  assert.equal(calls(), 1);
  assert.equal(retry.payload.mutationMayHaveApplied, true);
  assert.doesNotMatch(
    JSON.stringify(retry.payload),
    /private|Client\.md|confidential/u,
  );
});

test("registered create route contains a hostile rejected Proxy without a second response", async () => {
  const marker = "C:\\Users\\private\\Vault\\Tasks\\Rejected.md confidential";
  const hostileRejection = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(marker);
      },
      get() {
        throw new Error(marker);
      },
    },
  );
  const { handler } = await mountedCreateMutationRoute(() => {
    // The native operation rejects rather than resolving to a malformed DTO.
    throw hostileRejection;
  });
  const response = responseCapture();
  await handler(
    {
      body: {
        idempotencyKey: "hostile-rejection-route-key",
        dryRun: false,
        task: { source: "inline" },
      },
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.equal(response.jsonCalls, 1);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error.code, "outcome_unverified");
  assert.doesNotMatch(
    JSON.stringify(response.payload),
    /private|Rejected\.md|confidential/u,
  );
});

test("Operon runtime console diagnostics never pass raw error objects", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./main.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /console\.(?:warn|error)\([\s\S]{0,240},\s*(?:error|e)\s*[),]/u,
  );
});
