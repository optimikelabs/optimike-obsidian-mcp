import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { fakeBaseQueryHandler } from "./bases-engine-fixture.mjs";

// Runs the real query route of the Bridge plugin against a synthetic vault and
// a synthetic `base:query` handler (the Obsidian Desktop boundary).
let bridgeModulePromise;

function loadBridge() {
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
    const loaded = { exports: {} };
    const nativeRequire = createRequire(import.meta.url);
    class TFile {}
    const obsidian = {
      Plugin: class {
        register() {}
      },
      PluginSettingTab: class {},
      Setting: class {},
      TFile,
      apiVersion: "1.15.1",
      parseYaml: JSON.parse,
      stringifyYaml: (value) => JSON.stringify(value),
    };
    new Function("module", "exports", "require", bundle.outputFiles[0].text)(
      loaded,
      loaded.exports,
      (id) => (id === "obsidian" ? obsidian : nativeRequire(id)),
    );
    return { Bridge: loaded.exports.default, TFile };
  })();
  return bridgeModulePromise;
}

const BASE_PATH = "Bases/Work.base";
const BASE = {
  formulas: { label: "link(file, file.name)", shout: 'file.name + "!"' },
  views: [{ type: "table", name: "Top", limit: 2, filters: 'file.inFolder("Notes")' }],
};
const NOTES = ["Notes/a.md", "Notes/b.md", "Notes/c.md", "Other/z.md"];
const TABLE = {
  "link(file, file.name)": (row) => `[[${row.name}]]`,
  'file.name + "!"': (row) => `${row.name}!`,
};

async function queryRoute({ baseText = JSON.stringify(BASE), engine = true } = {}) {
  const { Bridge, TFile } = await loadBridge();
  const files = new Map();
  const add = (path) => {
    const file = new TFile();
    file.path = path;
    file.extension = path.split(".").pop();
    file.basename = path.split("/").pop().replace(/\.[^.]+$/u, "");
    file.stat = { size: 1, ctime: 1, mtime: 1 };
    files.set(path, file);
  };
  [BASE_PATH, ...NOTES].forEach(add);
  const vault = Object.create({
    cachedRead: async (file) => (file.path === BASE_PATH ? baseText : ""),
  });
  Object.assign(vault, {
    read: async (file) => (file.path === BASE_PATH ? baseText : ""),
    getFiles: () => [...files.values()],
    getFileByPath: (path) => files.get(path) ?? null,
    getAbstractFileByPath: (path) => files.get(path) ?? null,
    on: () => ({}),
  });
  const calls = [];
  const rows = NOTES.map((path) => ({ path, name: path.split("/").pop() }));
  const handler = fakeBaseQueryHandler(vault, { rows, table: TABLE, calls });
  const routes = new Map();
  const api = {
    addRoute(path) {
      const route = routes.get(path) ?? {
        get(h) {
          route.get = h;
          return route;
        },
        post(h) {
          route.post = h;
          return route;
        },
        put() {
          return route;
        },
      };
      routes.set(path, route);
      return route;
    },
  };
  const plugin = new Bridge();
  plugin.app = {
    workspace: { onLayoutReady: (callback) => callback() },
    plugins: { plugins: { "obsidian-local-rest-api": { getPublicApi: () => api } } },
    metadataCache: { getFileCache: () => ({ frontmatter: { status: "open" } }) },
    cli: { handlers: new Map(engine ? [["base:query", { handler }]] : []) },
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
  const post = routes.get("/extensions/obsidian-bases-bridge/bases/:id(*)/query").post;
  return async (body) => {
    let payload;
    await post({ params: { id: BASE_PATH }, body }, { json: (value) => (payload = value) });
    return { payload, calls, sha256: createHash("sha256").update(baseText, "utf8").digest("hex") };
  };
}

test("evaluate returns the engine's rows, view limit and formula values", async () => {
  const query = await queryRoute();
  const { payload, calls, sha256 } = await query({ view: "Top", evaluate: true, limit: 50 });

  assert.equal(payload.source, "engine");
  assert.equal(payload.total, 2);
  assert.deepEqual(
    payload.rows.map((row) => [row.file.path, row.computed]),
    [
      ["Notes/a.md", { label: "[[a.md]]", shout: "a.md!" }],
      ["Notes/b.md", { label: "[[b.md]]", shout: "b.md!" }],
    ],
  );
  assert.equal(payload.rows[0].props.label, "[[a.md]]");
  assert.deepEqual(payload.warnings, []);
  // The engine evaluated the exact bytes the snapshot proves.
  assert.equal(payload.baseSnapshot.sha256, sha256);
  assert.equal(calls.length, 1);
});

test("without the engine, every formula is reported instead of dropped", async () => {
  const query = await queryRoute({ engine: false });
  const { payload, sha256 } = await query({ view: "Top", evaluate: true, limit: 50 });

  assert.equal(payload.source, "fallback");
  assert.equal(payload.total, 2);
  assert.ok(payload.rows.every((row) => row.computed === undefined && !("label" in row.props)));
  assert.deepEqual(payload.warnings, [
    "formula_not_evaluated:label:engine_unavailable",
    "formula_not_evaluated:shout:engine_unavailable",
    "view_limit_applied_with_bridge_order:2",
  ]);
  assert.equal(payload.baseSnapshot.sha256, sha256);
});

test("evaluate:false keeps the Bridge snapshot without calling the engine", async () => {
  const unlimited = { ...BASE, views: [{ type: "table", name: "All", filters: 'file.inFolder("Notes")' }] };
  const query = await queryRoute({ baseText: JSON.stringify(unlimited) });
  const { payload, calls, sha256 } = await query({ view: "All", evaluate: false, limit: 500, page: 1 });

  assert.equal(payload.source, "fallback");
  assert.equal(payload.evaluate, false);
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.total, payload.rows.length);
  assert.deepEqual(
    payload.rows.map((row) => row.file.path),
    ["Notes/a.md", "Notes/b.md", "Notes/c.md"],
  );
  assert.equal(payload.baseSnapshot.sha256, sha256);
  assert.equal(calls.length, 0);
});
