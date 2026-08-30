import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let payloadFactoryPromise: Promise<Function> | undefined;

function loadPayloadFactory(): Promise<Function> {
  payloadFactoryPromise ??= (async () => {
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
    const payloadFactory = (loadedModule.exports as Record<string, unknown>)
      .publicAtomicErrorPayload;
    assert.equal(typeof payloadFactory, "function");
    return payloadFactory as Function;
  })();
  return payloadFactoryPromise;
}

test("HTTP error payloads redact arbitrary note, Canvas, and filesystem values", async () => {
  const payloadFactory = await loadPayloadFactory();
  const secret =
    "C:\\Users\\private\\Vault\\Notes\\Client.md formula: secret canvas content";
  const payload = payloadFactory("hash_conflict", new Error(secret), {
    actualSha256: "a".repeat(64),
    path: secret,
    content: secret,
    formula: secret,
    canvas: secret,
  }) as Record<string, any>;

  assert.deepEqual(payload, {
    ok: false,
    contractVersion: 1,
    status: "conflict",
    retryable: false,
    error: {
      code: "hash_conflict",
      reasonCode: "resource_changed",
      message:
        "The resource changed after it was read. Read it again before retrying.",
      details: { actualSha256: "a".repeat(64) },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|formula|canvas|Client\.md/u,
  );
});

test("HTTP error payloads normalize unrecognized public codes", async () => {
  const payloadFactory = await loadPayloadFactory();
  const payload = payloadFactory(
    "path: Notes/Private.md",
    "raw backend value",
  ) as Record<string, any>;

  assert.equal(payload.status, "rejected");
  assert.equal(payload.retryable, false);
  assert.equal(payload.error.code, "invalid_request");
  assert.equal(payload.error.reasonCode, "request_rejected");
  assert.doesNotMatch(JSON.stringify(payload), /Private\.md|backend/u);
});

test("HTTP error payloads survive hostile codes, details, and error objects", async () => {
  const payloadFactory = await loadPayloadFactory();
  const secret = "C:\\Private\\Vault\\HOSTILE_SECRET.md";
  const throwingDetails = Object.defineProperty({}, "actualSha256", {
    get() {
      throw new Error(secret);
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const throwingCode = new Proxy(
    {},
    {
      get() {
        throw new Error(secret);
      },
    },
  );

  for (const details of [throwingDetails, revoked.proxy]) {
    const payload = payloadFactory(
      throwingCode,
      revoked.proxy,
      details,
    ) as Record<string, any>;
    assert.equal(payload.error.code, "invalid_request");
    assert.equal(payload.error.details, undefined);
    assert.doesNotMatch(JSON.stringify(payload), /Private|HOSTILE_SECRET/u);
  }
});

test("Atomic Write runtime console diagnostics never pass raw error objects", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./main.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /console\.(?:warn|error)\([\s\S]{0,240},\s*(?:error|e)\s*[),]/u,
  );
});

test("Atomic note CAS route emits one safe conflict and backend failure", async () => {
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
  class TFileStub {}
  const obsidianStub = {
    Plugin: class {
      register() {}
    },
    PluginSettingTab: class {},
    Setting: class {},
    TFile: TFileStub,
  };
  const testRequire = (id: string) =>
    id === "obsidian" ? obsidianStub : nativeRequire(id);
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(
    loadedModule,
    loadedModule.exports,
    testRequire,
  );
  const Bridge = loadedModule.exports.default as any;
  const routes = new Map<string, any>();
  const api = {
    addRoute(path: string) {
      const route: any = {
        get(handler: Function) {
          route.getHandler = handler;
          return route;
        },
        post(handler: Function) {
          route.postHandler = handler;
          return route;
        },
      };
      routes.set(path, route);
      return route;
    },
  };
  const file = new TFileStub() as any;
  file.path = "Canary/Fixture.md";
  file.extension = "md";
  const current = "# Before\n";
  const actualSha256 = createHash("sha256")
    .update(current, "utf8")
    .digest("hex");
  const vault: any = {
    getAbstractFileByPath: () => file,
    read: async () => current,
    process: async (_file: unknown, callback: (value: string) => string) =>
      callback(current),
  };
  const plugin = new Bridge();
  plugin.app = {
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    plugins: {
      plugins: {
        "obsidian-local-rest-api": { getPublicApi: () => api },
      },
    },
    vault,
  };
  plugin.manifest = { id: "obsidian-atomic-write-bridge", version: "test" };
  plugin.allowWrites = true;
  const bindingFingerprint = "a".repeat(64);
  (plugin as any).bindingFingerprint = bindingFingerprint;
  await (plugin as any).registerRestExtension();
  const route = routes.get(
    "/extensions/obsidian-atomic-write-bridge/notes/cas",
  );
  const canvasRoute = routes.get(
    "/extensions/obsidian-atomic-write-bridge/canvas/cas",
  );
  assert.equal(typeof route?.postHandler, "function");
  assert.equal(typeof canvasRoute?.postHandler, "function");
  plugin.allowCanvasWrites = true;
  const request = {
    contractVersion: 1,
    path: file.path,
    bindingFingerprint,
    expectedSha256: "0".repeat(64),
    nextContent: "# After\n",
  };
  let statusCode: number | undefined;
  let responseCount = 0;
  let responseBody: any;
  const response = {
    set statusCode(value: number) {
      statusCode = value;
    },
    json(value: unknown) {
      responseCount += 1;
      responseBody = value;
    },
  };
  await route.postHandler({ body: {} }, response);
  assert.equal(statusCode, 400);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "invalid_request");

  statusCode = undefined;
  responseCount = 0;
  responseBody = undefined;
  await route.postHandler({ body: request }, response);
  assert.equal(statusCode, 409);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.details.actualSha256, actualSha256);
  assert.deepEqual(Object.keys(responseBody.error.details), ["actualSha256"]);

  vault.process = async () => {
    throw new Error("C:\\Users\\private\\Vault\\Fixture.md PRIVATE_CONTENT");
  };
  request.expectedSha256 = actualSha256;
  statusCode = undefined;
  responseCount = 0;
  responseBody = undefined;
  await route.postHandler({ body: request }, response);
  assert.equal(statusCode, 500);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "write_error");
  assert.doesNotMatch(
    JSON.stringify(responseBody),
    /private|Fixture|PRIVATE_CONTENT/u,
  );

  const secret = "C:\\Users\\private\\Vault\\HOSTILE_SECRET.canvas";
  const requestWithThrowingBody = Object.defineProperty({}, "body", {
    get() {
      throw new Error(secret);
    },
  });
  statusCode = undefined;
  responseCount = 0;
  responseBody = undefined;
  await route.postHandler(requestWithThrowingBody, response);
  assert.equal(statusCode, 400);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "invalid_request");
  assert.doesNotMatch(JSON.stringify(responseBody), /private|HOSTILE_SECRET/u);

  statusCode = undefined;
  responseCount = 0;
  responseBody = undefined;
  await canvasRoute.postHandler(requestWithThrowingBody, response);
  assert.equal(statusCode, 400);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "invalid_request");
  assert.doesNotMatch(JSON.stringify(responseBody), /private|HOSTILE_SECRET/u);

  const hostileError = Object.defineProperty({}, "message", {
    get() {
      throw new Error(secret);
    },
  });
  vault.process = async () => {
    throw hostileError;
  };
  statusCode = undefined;
  responseCount = 0;
  responseBody = undefined;
  await route.postHandler({ body: request }, response);
  assert.equal(statusCode, 500);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "write_error");
  assert.doesNotMatch(JSON.stringify(responseBody), /private|HOSTILE_SECRET/u);

  const canvasRequest = {
    contractVersion: 1,
    path: "Canary/Fixture.canvas",
    bindingFingerprint,
    expectedSha256: actualSha256,
    nextContent: JSON.stringify({ nodes: [], edges: [] }),
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  vault.process = async () => {
    throw revoked.proxy;
  };
  statusCode = undefined;
  responseCount = 0;
  responseBody = undefined;
  await canvasRoute.postHandler({ body: canvasRequest }, response);
  assert.equal(statusCode, 500);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "write_error");
  assert.doesNotMatch(JSON.stringify(responseBody), /private|HOSTILE_SECRET/u);
});

test("Atomic Write lifecycle keeps a value-free bounded retry alive", async () => {
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
    Plugin: class {
      register() {}
    },
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
  const Bridge = loadedModule.exports.default as any;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let scheduledDelay: number | undefined;
  globalThis.setTimeout = ((_callback: () => void, delay?: number) => {
    scheduledDelay = delay;
    return 2 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
  console.warn = (...args: unknown[]) => warnings.push(args);
  let plugin: any;
  try {
    plugin = new Bridge();
    plugin.app = {
      workspace: { onLayoutReady: (callback: () => void) => callback() },
      plugins: { plugins: {} },
    };
    plugin.manifest = { id: "obsidian-atomic-write-bridge", version: "test" };
    await (plugin as any).registerRestExtension();
  } finally {
    plugin?.restLifecycle?.stop();
    console.warn = originalWarn;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(scheduledDelay, 250);
  assert.equal(plugin.restLifecycle.snapshot().state, "unavailable");
  assert.deepEqual(warnings, []);
  assert.doesNotMatch(JSON.stringify(warnings), /secret|vault|path/u);
});

test("Atomic Write Bridge remounts exactly once after Local REST reload", async () => {
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
  const Bridge = loadedModule.exports.default as new () => any;
  const plugins: Record<string, unknown> = {};
  const providers: Array<{
    handlers: Map<string, Function>;
    unregisters: number;
  }> = [];
  const makeProvider = (failAtRoute?: number) => {
    const record = { handlers: new Map<string, Function>(), unregisters: 0 };
    let routeCount = 0;
    const api = {
      addRoute: (path: string) => {
        routeCount += 1;
        if (routeCount === failAtRoute) {
          throw new Error("private partial registration failure");
        }
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
      },
    };
    providers.push(record);
    return { getPublicApi: () => api };
  };
  const bridge = new Bridge();
  bridge.register = () => undefined;
  bridge.manifest = { id: "obsidian-atomic-write-bridge", version: "test" };
  bridge.app = {
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    plugins: { plugins, getPlugin: (id: string) => plugins[id] ?? null },
  };

  await bridge.registerRestExtension();
  assert.equal(bridge.restLifecycle.snapshot().state, "unavailable");
  plugins["obsidian-local-rest-api"] = makeProvider(2);
  bridge.restLifecycle.probeNow();
  assert.equal(bridge.restLifecycle.snapshot().state, "degraded");
  assert.equal(bridge.restLifecycle.snapshot().mountGeneration, 0);
  assert.equal(
    providers[0].unregisters,
    1,
    "a partial route generation must roll back before retry",
  );
  plugins["obsidian-local-rest-api"] = makeProvider();
  bridge.restLifecycle.probeNow();
  bridge.restLifecycle.probeNow();
  assert.equal(bridge.restLifecycle.snapshot().mountGeneration, 1);
  let statusBody: any;
  providers[1].handlers.get(
    "GET /extensions/obsidian-atomic-write-bridge/status",
  )?.(
    {},
    {
      json(value: unknown) {
        statusBody = value;
      },
    },
  );
  assert.equal(statusBody.lifecycle.state, "ready");
  assert.equal(
    statusBody.backend.writeEnabled,
    false,
    "route readiness must not enable writes",
  );
  delete plugins["obsidian-local-rest-api"];
  bridge.restLifecycle.probeNow();
  assert.equal(providers[1].unregisters, 1);
  plugins["obsidian-local-rest-api"] = makeProvider();
  bridge.restLifecycle.probeNow();
  assert.equal(bridge.restLifecycle.snapshot().mountGeneration, 2);
  bridge.restLifecycle.stop();
  assert.equal(providers[2].unregisters, 1);
});
