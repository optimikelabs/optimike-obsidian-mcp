import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import type { App } from "obsidian";
import { createDatePreparation } from "./datePreparation.js";
import { EffectFence, EffectFenceRefused, type EffectFenceRegistry } from "./effectFence.js";
import { createNoteCreateRoutes } from "./noteCreateRoutes.js";
import { sha256 } from "./contract.js";
import { noteCreateHash } from "../../../src/services/noteCreateContract.js";
import { LegacyCas, LegacyRead } from "./legacyWireSchemas.js";

function fence() {
  const registry: EffectFenceRegistry = { epochs: [] };
  const value = new EffectFence({ requireFence: () => false, registry });
  return { fence: value, token: (attemptId = randomUUID()) => ({ contractVersion: 1 as const, epoch: value.epoch, attemptId }) };
}

test("date preparation: a revoked attempt opens no leaf and runs no command; a live one settles", async () => {
  const f = fence();
  let opens = 0, commands = 0, clock = 0;
  const file = { path: "Test.md", extension: "md" };
  let content = "---\nstatut: actif\n---\nbody\n";
  // Same instance on every lookup: the preparation rejects a replaced plugin.
  const fdm = { settings: { enableAutoUpdate: true, enableCreateTime: true, headerCreated: "création",
    headerUpdated: "modification", dateFormat: "yyyy-MM-dd'T'HH:mm" } };
  const app: any = {
    vault: { getAbstractFileByPath: () => file, read: async () => content },
    plugins: { getPlugin: (id: string) => id === "frontmatter-date-manager" ? fdm : undefined },
    workspace: { activeLeaf: null, getLeaf: () => ({ openFile: async () => { opens++; }, detach() {} }), getActiveFile: () => file,
      setActiveLeaf(value: any) { this.activeLeaf = value; } },
    commands: { commands: { "frontmatter-date-manager:update-timestamps-current-file": {} }, executeCommandById() {
      commands++; content = content.replace("statut: actif", "statut: actif\ncréation: 2026-10-27T10:00\nmodification: 2026-10-27T10:00"); return true; } },
  };
  const parse = (yaml: string) => Object.fromEntries(yaml.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  const prepare = createDatePreparation(app, parse, {
    enabled: () => true, enterEffect: (token) => f.fence.enter(token), now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 1500,
  });
  const revoked = f.token();
  assert.deepEqual(f.fence.resolve(revoked, "revoke"), { verdict: "revoked_before_effect" });
  await assert.rejects(prepare({ path: file.path, expectedSha256: sha256(content), fence: revoked }), (error) => error instanceof EffectFenceRefused);
  assert.equal(opens, 0);
  assert.equal(commands, 0);
  const live = f.token();
  const result = await prepare({ path: file.path, expectedSha256: sha256(content), fence: live });
  assert.equal(result.datePreparation?.kind, "date-manager-before-plan");
  assert.equal(commands, 1);
  assert.equal(f.fence.resolve(live, "revoke").verdict, "effect_settled");
});

test("exclusive create: the fence decides in the same synchronous block as O_EXCL", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "create-fence-"));
  const f = fence();
  const handlers = new Map<string, (req: any, res: any) => void>();
  const app = { vault: { adapter: { getBasePath: () => root }, getAbstractFileByPath: () => null } } as unknown as App;
  const routes = createNoteCreateRoutes(app, { binding: () => "a".repeat(64), enabled: () => true, enterEffect: (token) => f.fence.enter(token) })!;
  routes.mount({ addRoute: (url) => ({ post: (fn) => { handlers.set(url, fn); } }) });
  const call = (suffix: string, body: unknown) => {
    let code = 0; let result: any;
    const res = { status: (n: number) => { code = n; return res; }, json: (v: unknown) => { result = v; } };
    handlers.get("/extensions/obsidian-atomic-write-bridge/note-create/" + suffix)!({ body }, res);
    return { code, result };
  };
  try {
    const preflight = call("preflight", { contractVersion: 1, path: "A.md" }).result;
    assert.equal(routes.capabilities().bindingFingerprint, preflight.bindingFingerprint);
    const request = (pathValue: string, token: unknown) => ({ contractVersion: 1, operationId: randomUUID(), path: pathValue, content: "x\n",
      contentSha256: noteCreateHash("x\n"), bindingFingerprint: preflight.bindingFingerprint, policyDigest: preflight.policyDigest, fence: token });
    const revoked = f.token();
    f.fence.resolve(revoked, "revoke");
    const refused = call("apply", request("A.md", revoked));
    assert.equal(refused.result.outcome, "conflict");
    assert.equal(refused.result.reason, "create_fence_refused");
    assert.deepEqual(readdirSync(root), []);
    const live = f.token();
    assert.equal(call("apply", request("A.md", live)).result.outcome, "created");
    assert.equal(f.fence.resolve(live, "revoke").verdict, "effect_settled");
    const replayed = call("apply", request("B.md", live));
    assert.equal(replayed.result.reason, "create_fence_refused");
    assert.deepEqual(readdirSync(root), ["A.md"]);
    assert.equal(call("apply", request("C.md", { contractVersion: 1, epoch: "x", attemptId: "y" })).code, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("notes/cas admits the token inside vault.process; revocation before the callback refuses the write", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
    bundle: true, format: "cjs", platform: "node", target: "node22", external: ["obsidian"], write: false, logLevel: "silent",
  });
  class TFile { path = "Note.md"; extension = "md"; stat = { mtime: 1 }; }
  const obsidianStub = { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, TFile, parseYaml: () => ({}), stringifyYaml: () => "" };
  const loaded = { exports: {} as Record<string, unknown> };
  const nativeRequire = createRequire(import.meta.url);
  new Function("module", "exports", "require", bundle.outputFiles[0].text)(loaded, loaded.exports, (id: string) => id === "obsidian" ? obsidianStub : nativeRequire(id));
  const Bridge = loaded.exports.default as new () => any;
  const handlers = new Map<string, Function>();
  const api = { addRoute: (route: string) => { const r = { get: (h: Function) => { handlers.set("GET " + route, h); return r; }, post: (h: Function) => { handlers.set("POST " + route, h); return r; } }; return r; }, unregister: () => undefined };
  let content = "avant\n";
  let beforeCallback: (() => Promise<void>) | undefined;
  const file = new TFile();
  const bridge = new Bridge();
  bridge.register = () => undefined;
  bridge.manifest = { id: "obsidian-atomic-write-bridge", version: "test" };
  bridge.allowWrites = true;
  bridge.bindingFingerprint = "b".repeat(64);
  bridge.app = {
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    plugins: { plugins: { "obsidian-local-rest-api": { getPublicApi: () => api } }, getPlugin: () => null },
    vault: {
      getAbstractFileByPath: () => file,
      read: async () => content,
      process: async (_file: unknown, fn: (value: string) => string) => {
        if (beforeCallback) { const hook = beforeCallback; beforeCallback = undefined; await hook(); }
        content = fn(content);
        return content;
      },
    },
  };
  await bridge.registerRestExtension();
  bridge.restLifecycle.probeNow();
  const invoke = async (method: string, route: string, body?: unknown) => {
    let code = 200; let payload: any;
    const res = { status(n: number) { code = n; return res; }, json(value: unknown) { payload = value; } };
    await handlers.get(`${method} /extensions/obsidian-atomic-write-bridge${route}`)!({ body }, res);
    return { code, payload };
  };
  const status = (await invoke("GET", "/status")).payload;
  assert.equal(status.effectFence.supported, true);
  const token = (attemptId = randomUUID()) => ({ contractVersion: 1, epoch: status.effectFence.epoch, attemptId });
  const cas = (fenceToken: unknown, next = "après\n") => invoke("POST", "/notes/cas", { contractVersion: 1, path: "Note.md",
    bindingFingerprint: "b".repeat(64), expectedSha256: sha256(content), nextContent: next, ...(fenceToken ? { fence: fenceToken } : {}) });
  const resolve = (attempts: unknown[], mode = "revoke", includeLegacy = false) =>
    invoke("POST", "/effect-fence/resolve", { contractVersion: 1, bindingFingerprint: "b".repeat(64), mode, attempts, includeLegacy });

  // The old client sends no fence. Replacement, text patch and frontmatter
  // patch all use this same read/CAS wire contract with the setting disabled.
  const legacyRead = await invoke("POST", "/notes/read", { contractVersion: 1, path: "Note.md" });
  assert.equal(LegacyRead.safeParse(legacyRead.payload).success, true);
  const legacyCas = await cas(undefined, "avant\n");
  assert.equal(legacyCas.code, 200);
  assert.equal(LegacyCas.safeParse(legacyCas.payload).success, true);

  // The request is inside vault.process, before the callback: the revocation wins.
  const held = token();
  beforeCallback = async () => {
    const verdict = await resolve([{ epoch: held.epoch, attemptId: held.attemptId }]);
    assert.equal(verdict.payload.results[0].verdict, "revoked_before_effect");
  };
  const refused = await cas(held);
  assert.equal(refused.code, 403);
  assert.equal(refused.payload.error.reasonCode, "effect_fence_refused");
  assert.equal(content, "avant\n");

  const live = token();
  assert.equal((await cas(live)).code, 200);
  assert.equal(content, "après\n");
  const settled = await resolve([{ epoch: live.epoch, attemptId: live.attemptId }]);
  assert.equal(settled.payload.results[0].verdict, "effect_settled");
  assert.equal((await cas(live, "rejeu\n")).payload.error.reasonCode, "effect_fence_refused");

  assert.equal((await resolve([], "inspect", true)).payload.legacy.requireFence, false);
  bridge.requireEffectFence = true;
  bridge.effectFence.requireFenceChanged();
  assert.equal((await cas(undefined, "sans jeton\n")).payload.error.reasonCode, "effect_fence_refused");
  assert.equal(content, "après\n");
  assert.equal((await invoke("POST", "/effect-fence/resolve", { contractVersion: 1, bindingFingerprint: "c".repeat(64), mode: "inspect", attempts: [], includeLegacy: false })).code, 409);
  assert.equal((await invoke("POST", "/effect-fence/resolve", { contractVersion: 1, bindingFingerprint: "b".repeat(64), mode: "delete", attempts: [], includeLegacy: false })).code, 400);
  bridge.restLifecycle.stop();
  bridge.effectFence.dispose();
});
