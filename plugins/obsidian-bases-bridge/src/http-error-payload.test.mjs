import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let payloadFactoryPromise;
let httpFailureFactoryPromise;

function loadPayloadFactory() {
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
    const loadedModule = { exports: {} };
    const nativeRequire = createRequire(import.meta.url);
    const obsidianStub = {
      Plugin: class {},
      PluginSettingTab: class {},
      Setting: class {},
      TFile: class {},
      parseYaml: () => ({}),
      stringifyYaml: () => "",
    };
    const testRequire = (id) =>
      id === "obsidian" ? obsidianStub : nativeRequire(id);
    new Function("module", "exports", "require", bundle.outputFiles[0].text)(
      loadedModule,
      loadedModule.exports,
      testRequire,
    );
    const payloadFactory = loadedModule.exports.publicBaseAtomicErrorPayload;
    assert.equal(typeof payloadFactory, "function");
    return payloadFactory;
  })();
  return payloadFactoryPromise;
}

function loadHttpFailureFactory() {
  httpFailureFactoryPromise ??= (async () => {
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
    const loadedModule = { exports: {} };
    const nativeRequire = createRequire(import.meta.url);
    const obsidianStub = {
      Plugin: class {},
      PluginSettingTab: class {},
      Setting: class {},
      TFile: class {},
      parseYaml: () => ({}),
      stringifyYaml: () => "",
    };
    const testRequire = (id) =>
      id === "obsidian" ? obsidianStub : nativeRequire(id);
    new Function("module", "exports", "require", bundle.outputFiles[0].text)(
      loadedModule,
      loadedModule.exports,
      testRequire,
    );
    const payloadFactory = loadedModule.exports.publicBaseHttpFailurePayload;
    assert.equal(typeof payloadFactory, "function");
    return payloadFactory;
  })();
  return httpFailureFactoryPromise;
}

test("Base HTTP errors expose only the stable recovery digest", async () => {
  const payloadFactory = await loadPayloadFactory();
  const secret =
    "C:\\Users\\private\\Vault\\Dashboards\\Revenue.base formulas: hidden";
  const payload = payloadFactory("hash_conflict", new Error(secret), {
    actualSha256: "b".repeat(64),
    path: secret,
    nextYaml: secret,
    formula: secret,
  });

  assert.deepEqual(payload, {
    ok: false,
    contractVersion: 1,
    status: "conflict",
    retryable: false,
    error: {
      code: "hash_conflict",
      reasonCode: "resource_changed",
      message:
        "The Base changed after it was read. Read it again before retrying.",
      details: { actualSha256: "b".repeat(64) },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|Revenue\.base|formula|hidden/u,
  );
});

test("Base HTTP errors normalize arbitrary codes and messages", async () => {
  const payloadFactory = await loadPayloadFactory();
  const payload = payloadFactory("formula: private", "C:\\Users\\private");
  assert.equal(payload.status, "rejected");
  assert.equal(payload.retryable, false);
  assert.equal(payload.error.code, "invalid_request");
  assert.equal(payload.error.reasonCode, "request_rejected");
  assert.doesNotMatch(JSON.stringify(payload), /private|formula/u);
});

test("Base HTTP error projectors contain revoked Proxies and throwing getters", async () => {
  const payloadFactory = await loadHttpFailureFactory();
  const atomicPayloadFactory = await loadPayloadFactory();
  const secret = "C:\\Users\\private\\Vault\\PROXY_SECRET";
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error(secret);
      },
      getPrototypeOf() {
        throw new Error(secret);
      },
    },
  );
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();

  for (const value of [throwing, revocable.proxy]) {
    const payload = payloadFactory(value);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "invalid_request");
    assert.doesNotMatch(JSON.stringify(payload), /private|PROXY_SECRET/u);

    const atomicPayload = atomicPayloadFactory(
      "hash_conflict",
      undefined,
      value,
    );
    assert.equal(atomicPayload.error.code, "hash_conflict");
    assert.equal("details" in atomicPayload.error, false);
    assert.doesNotMatch(
      JSON.stringify(atomicPayload),
      /private|PROXY_SECRET/u,
    );
  }
});

test("Base 2xx upsert failures redact a native write error and file path", async () => {
  const payloadFactory = await loadHttpFailureFactory();
  const secret = "C:\\Users\\private\\Vault\\Revenue.base formula: hidden";
  const payload = payloadFactory({
    ok: false,
    id: secret,
    results: [
      {
        file: secret,
        error: { code: "write_timeout", message: secret },
        warnings: [secret],
      },
    ],
  });

  assert.deepEqual(payload, {
    ok: false,
    results: [
      {
        mtime: 0,
        error: {
          code: "write_timeout",
          message:
            "The Base write did not complete. Verify the current state before retrying.",
          retryable: true,
        },
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|Revenue\.base|formula|hidden/u,
  );
});

test("Base 2xx serializer failures redact the thrown warning value", async () => {
  const payloadFactory = await loadHttpFailureFactory();
  const secret = "C:\\Users\\private\\Vault\\Revenue.base: hidden spec";
  const payload = payloadFactory({
    ok: false,
    id: secret,
    error: { code: "serialization_error", message: secret },
    warnings: [secret],
  });

  assert.equal(payload.error.code, "serialization_error");
  assert.equal(payload.error.reasonCode, "serialization_failed");
  assert.equal(payload.status, "rejected");
  assert.equal(payload.retryable, false);
  assert.doesNotMatch(JSON.stringify(payload), /private|Revenue\.base|hidden/u);
});

test("Base legacy config/create failures retain only strict contract fields", async () => {
  const payloadFactory = await loadHttpFailureFactory();
  const configFailure = payloadFactory({
    ok: false,
    id: "Canary/Safe.base",
    warnings: ["Payload requis: yaml ou json."],
  });
  assert.deepEqual(configFailure, {
    ok: false,
    id: "Canary/Safe.base",
    warnings: ["A YAML or JSON payload is required."],
  });

  const secret = "C:\\Users\\private\\Vault\\Revenue.base PRIVATE_CONTENT";
  const createFailure = payloadFactory({
    ok: false,
    id: secret,
    warnings: [secret],
    created: false,
    overwritten: false,
    content: secret,
    details: { path: secret },
  });
  assert.deepEqual(createFailure, {
    ok: false,
    id: "",
    warnings: ["The Base operation could not be completed."],
    created: false,
    overwritten: false,
  });
  assert.doesNotMatch(
    JSON.stringify(createFailure),
    /private|Revenue\.base|PRIVATE_CONTENT/u,
  );
});

test("Base legacy 2xx failures retain ordered safe result contracts", async () => {
  const payloadFactory = await loadHttpFailureFactory();
  const secret = "C:\\Users\\private\\Vault\\Revenue.base";
  const payload = payloadFactory({
    ok: false,
    results: [
      {
        file: secret,
        mtime: 1,
        error: {
          code: "write_timeout",
          message: secret,
          details: { content: "PRIVATE_CONTENT" },
        },
      },
      {
        file: secret,
        mtime: 2,
        error: { code: "unknown_private_code", message: secret },
      },
    ],
    summary: {
      failed_operations: [{ file: secret, code: "write_timeout" }],
    },
  });

  assert.deepEqual(payload, {
    ok: false,
    results: [
      {
        mtime: 1,
        error: {
          code: "write_timeout",
          message:
            "The Base write did not complete. Verify the current state before retrying.",
          retryable: true,
        },
      },
      {
        mtime: 2,
        error: {
          code: "write_error",
          message: "The Base write could not be completed.",
          retryable: false,
        },
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|Revenue\.base|PRIVATE_CONTENT/u,
  );
});

async function loadBridgeModule() {
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
  const loadedModule = { exports: {} };
  const nativeRequire = createRequire(import.meta.url);
  class TFileStub {}
  const obsidianStub = {
    Plugin: class {
      register() {}
    },
    PluginSettingTab: class {},
    Setting: class {},
    TFile: TFileStub,
    parseYaml: () => ({}),
    stringifyYaml: () => "",
  };
  const testRequire = (id) =>
    id === "obsidian" ? obsidianStub : nativeRequire(id);
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(
    loadedModule,
    loadedModule.exports,
    testRequire,
  );
  return { loadedModule, TFileStub };
}

test("Base atomic CAS route emits one safe 409 and distinguishes backend 500", async () => {
  const { loadedModule, TFileStub } = await loadBridgeModule();
  const Bridge = loadedModule.exports.default;
  const routes = new Map();
  const api = {
    addRoute(path) {
      const existing = routes.get(path);
      if (existing) return existing;
      const route = {
        get(handler) {
          route.getHandler = handler;
          return route;
        },
        post(handler) {
          route.postHandler = handler;
          return route;
        },
        put(handler) {
          route.putHandler = handler;
          return route;
        },
      };
      routes.set(path, route);
      return route;
    },
  };
  const file = new TFileStub();
  file.path = "Canary/Fixture.base";
  file.extension = "base";
  file.basename = "Fixture";
  file.stat = { mtime: 123 };
  const current = "views:\n  - type: table\n";
  const actualSha256 = createHash("sha256")
    .update(current, "utf8")
    .digest("hex");
  const vault = {
    getAbstractFileByPath: () => file,
    read: async () => current,
    process: async (_file, callback) => callback(current),
    getFiles: () => [],
    on: () => ({}),
  };
  const plugin = new Bridge();
  plugin.app = {
    workspace: { onLayoutReady: (callback) => callback() },
    plugins: {
      plugins: {
        "obsidian-local-rest-api": { getPublicApi: () => api },
      },
    },
    vault,
  };
  plugin.manifest = { id: "obsidian-bases-bridge", version: "test" };
  plugin.settings = {
    engineEnabled: false,
    instanceId: "instance",
    allowAtomicBaseWrites: true,
    allowLegacyConfigWrites: false,
  };
  plugin.bindingFingerprint = "a".repeat(64);
  await plugin.registerRestExtension();
  const route = routes.get(
    "/extensions/obsidian-bases-bridge/atomic/bases/cas",
  );
  assert.equal(typeof route?.postHandler, "function");

  const request = {
    contractVersion: 1,
    path: file.path,
    bindingFingerprint: plugin.bindingFingerprint,
    expectedSha256: "0".repeat(64),
    nextYaml: current,
  };
  let responseCount = 0;
  let statusCode;
  let responseBody;
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
    json(value) {
      responseCount += 1;
      responseBody = value;
    },
  };
  await route.postHandler({ body: {} }, response);
  assert.equal(statusCode, 400);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "invalid_request");

  responseCount = 0;
  responseBody = undefined;
  statusCode = undefined;
  await route.postHandler({ body: request }, response);
  assert.equal(statusCode, 409);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.details.actualSha256, actualSha256);
  assert.deepEqual(Object.keys(responseBody.error.details), ["actualSha256"]);
  assert.doesNotMatch(
    JSON.stringify(responseBody),
    /Fixture|private|PRIVATE_CONTENT/u,
  );

  vault.process = async () => {
    throw new Error("C:\\Users\\private\\Vault\\Fixture.base PRIVATE_CONTENT");
  };
  request.expectedSha256 = actualSha256;
  responseCount = 0;
  responseBody = undefined;
  statusCode = undefined;
  await route.postHandler({ body: request }, response);
  assert.equal(statusCode, 500);
  assert.equal(responseCount, 1);
  assert.equal(responseBody.error.code, "write_error");
  assert.doesNotMatch(
    JSON.stringify(responseBody),
    /private|Fixture|PRIVATE_CONTENT/u,
  );
});

test("registered Base atomic and legacy routes contain hostile thrown values", async () => {
  const { loadedModule, TFileStub } = await loadBridgeModule();
  const Bridge = loadedModule.exports.default;
  const routes = new Map();
  const api = {
    addRoute(path) {
      const existing = routes.get(path);
      if (existing) return existing;
      const route = {
        get(handler) {
          route.getHandler = handler;
          return route;
        },
        post(handler) {
          route.postHandler = handler;
          return route;
        },
        put(handler) {
          route.putHandler = handler;
          return route;
        },
      };
      routes.set(path, route);
      return route;
    },
  };
  const file = new TFileStub();
  file.path = "Canary/Fixture.base";
  file.extension = "base";
  file.basename = "Fixture";
  const secret = "C:\\Users\\private\\Vault\\HOSTILE_SECRET";
  const hostileError = () =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(secret);
        },
        getPrototypeOf() {
          throw new Error(secret);
        },
      },
    );
  const vault = {
    getAbstractFileByPath: () => file,
    process: async () => {
      throw hostileError();
    },
    getFiles: () => {
      throw hostileError();
    },
    on: () => ({}),
  };
  const plugin = new Bridge();
  plugin.app = {
    workspace: { onLayoutReady: (callback) => callback() },
    plugins: {
      plugins: {
        "obsidian-local-rest-api": { getPublicApi: () => api },
      },
    },
    vault,
  };
  plugin.manifest = { id: "obsidian-bases-bridge", version: "test" };
  plugin.settings = {
    engineEnabled: false,
    instanceId: "instance",
    allowAtomicBaseWrites: true,
    allowLegacyConfigWrites: false,
  };
  plugin.bindingFingerprint = "a".repeat(64);
  await plugin.registerRestExtension();

  const invoke = async (handler, request) => {
    let statusCode;
    let responseCount = 0;
    let responseBody;
    const response = {
      get statusCode() {
        return statusCode;
      },
      set statusCode(value) {
        statusCode = value;
      },
      json(value) {
        responseCount += 1;
        responseBody = value;
      },
    };
    await handler(request, response);
    return { statusCode, responseCount, responseBody };
  };

  const atomic = await invoke(
    routes.get("/extensions/obsidian-bases-bridge/atomic/bases/cas").postHandler,
    {
      body: {
        contractVersion: 1,
        path: file.path,
        bindingFingerprint: plugin.bindingFingerprint,
        expectedSha256: "a".repeat(64),
        nextYaml: "views: []\n",
      },
    },
  );
  assert.equal(atomic.statusCode, 500);
  assert.equal(atomic.responseCount, 1);
  assert.equal(atomic.responseBody.error.code, "write_error");
  assert.doesNotMatch(JSON.stringify(atomic.responseBody), /private|HOSTILE_SECRET/u);

  const legacy = await invoke(
    routes.get("/extensions/obsidian-bases-bridge/bases").getHandler,
    {},
  );
  assert.equal(legacy.statusCode, 500);
  assert.equal(legacy.responseCount, 1);
  assert.equal(legacy.responseBody.error.code, "read_error");
  assert.doesNotMatch(JSON.stringify(legacy.responseBody), /private|HOSTILE_SECRET/u);
});

test("legacy Base routes contain thrown Vault errors behind a value-free boundary", async () => {
  const { loadedModule } = await loadBridgeModule();
  const Bridge = loadedModule.exports.default;
  const routes = new Map();
  const api = {
    addRoute(path) {
      const existing = routes.get(path);
      if (existing) return existing;
      const route = {
        get(handler) {
          route.getHandler = handler;
          return route;
        },
        post(handler) {
          route.postHandler = handler;
          return route;
        },
        put(handler) {
          route.putHandler = handler;
          return route;
        },
      };
      routes.set(path, route);
      return route;
    },
  };
  const vault = {
    getFiles: () => {
      throw new Error("C:\\Users\\private\\Vault PRIVATE_CONTENT");
    },
    getAbstractFileByPath: () => null,
    on: () => ({}),
  };
  const plugin = new Bridge();
  plugin.app = {
    workspace: { onLayoutReady: (callback) => callback() },
    plugins: {
      plugins: {
        "obsidian-local-rest-api": { getPublicApi: () => api },
      },
    },
    vault,
  };
  plugin.manifest = { id: "obsidian-bases-bridge", version: "test" };
  plugin.settings = {
    engineEnabled: false,
    instanceId: "instance",
    allowAtomicBaseWrites: false,
    allowLegacyConfigWrites: false,
  };
  plugin.bindingFingerprint = "a".repeat(64);
  await plugin.registerRestExtension();

  const invoke = async (handler, request) => {
    let statusCode;
    let responseCount = 0;
    let responseBody;
    const response = {
      get statusCode() {
        return statusCode;
      },
      set statusCode(value) {
        statusCode = value;
      },
      json(value) {
        responseCount += 1;
        responseBody = value;
      },
    };
    await handler(request, response);
    return { statusCode, responseCount, responseBody };
  };

  const list = await invoke(
    routes.get("/extensions/obsidian-bases-bridge/bases").getHandler,
    {},
  );
  assert.equal(list.statusCode, 500);
  assert.equal(list.responseCount, 1);
  assert.equal(list.responseBody.error.code, "read_error");
  assert.doesNotMatch(
    JSON.stringify(list.responseBody),
    /private|Vault|PRIVATE_CONTENT/u,
  );

  const config = await invoke(
    routes.get("/extensions/obsidian-bases-bridge/bases/:id(*)/config")
      .getHandler,
    { params: { id: "Private/Secret.base" } },
  );
  assert.equal(config.statusCode, 404);
  assert.equal(config.responseCount, 1);
  assert.equal(config.responseBody.error.code, "base_not_found");
  assert.doesNotMatch(JSON.stringify(config.responseBody), /Private|Secret/u);
});

test("Base runtime console diagnostics never pass raw errors or engine state", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./main.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /console\.(?:warn|error)\([\s\S]{0,240},\s*(?:error|e)\s*[),]/u,
  );
  assert.doesNotMatch(
    source,
    /console\.log\(\(this as any\)\.getEngineState\(/u,
  );
});

test("Base query missing-view warning does not echo the caller value", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./main.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /Vue introuvable:\s*\$\{JSON\.stringify\(viewName\)\}/u,
  );
  assert.match(source, /["']Vue introuvable\.["']/u);
  assert.doesNotMatch(source, /Filter non reconnu:\s*\$\{raw\}/u);
  assert.match(source, /["']Filter non reconnu\.["']/u);
});
