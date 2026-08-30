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

test("Operon HTTP errors redact arbitrary task fields, paths, and backend messages", async () => {
  const payloadFactory = await exported("publicOperonErrorPayload");
  const secret =
    "C:\\Users\\private\\Vault\\Tasks\\Client.md description: confidential";
  const payload = payloadFactory(new Error(secret), "native-error: task title") as Record<
    string,
    any
  >;

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
    status: { enumerable: true, get: () => { throw new Error("confidential"); } },
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
): Promise<{ bridge: any; handler: Function; calls: () => number }> {
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
  return { bridge, handler: handler!, calls: () => nativeCalls };
}

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
  const { handler } = await mountedCreateMutationRoute(() => hostileNative);
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

  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.idempotencyKey, "hostile-route-failure-key");
  assert.deepEqual(response.payload.requested, {});
  assert.equal(response.payload.error.code, "mutation_unavailable");
  assert.doesNotMatch(
    JSON.stringify(response.payload),
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

  assert.equal(response.statusCode, 503);
  assert.equal(response.jsonCalls, 1);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error.code, "mutation_unavailable");
  assert.doesNotMatch(JSON.stringify(response.payload), /private|Rejected\.md|confidential/u);
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
