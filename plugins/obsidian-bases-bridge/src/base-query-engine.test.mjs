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

async function queryRoute({ baseText = JSON.stringify(BASE), engine = true, notes = NOTES, table = TABLE } = {}) {
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
  [BASE_PATH, ...notes].forEach(add);
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
  const rows = notes.map((path) => ({ path, name: path.split("/").pop() }));
  const handler = fakeBaseQueryHandler(vault, { rows, table, calls });
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
    metadataCache: {
      getFileCache: (file) => ({
        frontmatter: {
          status: file.basename === "b" ? "closed" : "open",
          priority: file.basename === "c" ? 1 : 2,
        },
      }),
    },
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
    const response = { statusCode: 200, json: (value) => (payload = value) };
    await post({ params: { id: BASE_PATH }, body }, response);
    return { payload, status: response.statusCode, calls, sha256: createHash("sha256").update(baseText, "utf8").digest("hex") };
  };
}

test("a request property table narrows the rows selected by either source", async () => {
  const query = await queryRoute({
    baseText: JSON.stringify({ views: [{ type: "table", name: "All" }] }),
  });
  for (const evaluate of [false, true]) {
    const { payload, status } = await query({
      evaluate,
      filter: { and: [{ status: "open", priority: { gte: 2 } }, 'file.inFolder("Notes")'] },
    });
    assert.equal(status, 200);
    assert.equal(payload.source, evaluate ? "engine" : "fallback");
    assert.deepEqual(payload.rows.map((row) => row.file.path), ["Notes/a.md"]);
    assert.equal(payload.total, 1);
    assert.equal(payload.filterVersion, 1);
    assert.deepEqual(payload.warnings, []);
  }
});

test("invalid request filters are refused before row selection, including nested leaves", async () => {
  const query = await queryRoute({ notes: [] });
  for (const [filter, node] of [
    ['status == "open"', "filter"],
    [{ and: ["status", { priority: { gtt: 1 } }] }, "filter.and[1].property[0]"],
    [{ or: ["status", "unsupported()"] }, "filter.or[1]"],
    [{ or: [], status: "open" }, "filter"],
  ]) {
    const { payload, status, calls } = await query({ evaluate: true, filter });
    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(payload.error.code, "INVALID_PARAMS");
    assert.equal(payload.error.node, node);
    assert.equal(calls.length, 0);
    assert.equal(payload.rows, undefined);
  }
});

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
  // One call selects the rows, one computes the formulas of the page.
  assert.equal(calls.length, 2);
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

test("request filters and formula column settings use the engine's formula values", async () => {
  const withSettings = {
    ...BASE,
    properties: { "formula.label": { displayName: "Label" } },
  };
  const query = await queryRoute({ baseText: JSON.stringify(withSettings) });
  const { payload } = await query({
    view: "Top",
    evaluate: true,
    filter: { and: ['formula.shout == "a.md!"'] },
  });

  assert.equal(payload.source, "engine");
  assert.deepEqual(
    payload.rows.map((row) => row.file.path),
    ["Notes/a.md"],
  );
  assert.equal(payload.rows[0].props["formula.label"], "[[a.md]]");
  assert.ok(!payload.warnings.some((warning) => warning.startsWith("Filtre sur formule")));
});

// 250 notes and a counting formula table: the engine computes a formula only
// for the rows its view keeps, like Obsidian.
function countingTable() {
  const counts = { label: 0, shout: 0 };
  return {
    counts,
    table: {
      "link(file, file.name)": (row) => (counts.label++, `[[${row.name}]]`),
      'file.name + "!"': (row) => (counts.shout++, `${row.name}!`),
    },
  };
}
const MANY = Array.from({ length: 250 }, (_, i) => `Notes/n${String(i).padStart(3, "0")}.md`);
const UNLIMITED = { ...BASE, views: [{ type: "table", name: "All", filters: 'file.inFolder("Notes")' }] };

test("formulas are computed for the requested page only", async () => {
  const { counts, table } = countingTable();
  const query = await queryRoute({ baseText: JSON.stringify(UNLIMITED), notes: MANY, table });
  const { payload, calls } = await query({ view: "All", evaluate: true, limit: 20, page: 2 });

  assert.equal(payload.source, "engine");
  assert.equal(payload.total, 250);
  assert.deepEqual(payload.rows.map((row) => row.file.path), MANY.slice(20, 40));
  assert.deepEqual(payload.rows[0].computed, { label: "[[n020.md]]", shout: "n020.md!" });
  assert.deepEqual(counts, { label: 20, shout: 20 }, "only the 20 rows of the page are computed");
  assert.equal(calls.length, 2);
});

test("a request filter on a formula computes every row in chunks of 100", async () => {
  const { counts, table } = countingTable();
  const query = await queryRoute({ baseText: JSON.stringify(UNLIMITED), notes: MANY, table });
  const { payload, calls } = await query({
    view: "All",
    evaluate: true,
    filter: { and: ['formula.shout == "n123.md!"'] },
  });

  assert.equal(payload.source, "engine");
  assert.deepEqual(payload.rows.map((row) => row.file.path), ["Notes/n123.md"]);
  assert.deepEqual(counts, { label: 250, shout: 250 });
  // One selection call, then three value chunks (100 + 100 + 50 rows).
  assert.equal(calls.length, 4);
});

test("past 1,000 rows a formula filter is not evaluated, and says so", async () => {
  const { counts, table } = countingTable();
  const notes = Array.from({ length: 1001 }, (_, i) => `Notes/m${String(i).padStart(4, "0")}.md`);
  const query = await queryRoute({ baseText: JSON.stringify(UNLIMITED), notes, table });
  const { payload } = await query({
    view: "All",
    evaluate: true,
    limit: 10,
    sort: [{ prop: "formula.shout", dir: "desc" }],
  });

  assert.equal(payload.source, "engine");
  assert.ok(payload.warnings.includes("formula_filter_not_evaluated:too_many_rows:1001:1000"));
  assert.equal(payload.rows.length, 10);
  assert.deepEqual(counts, { label: 10, shout: 10 }, "only the page is computed");
});

test("past the cap, formula predicates are skipped, not run on missing values", async () => {
  const notes = Array.from({ length: 1001 }, (_, i) => `Notes/m${String(i).padStart(4, "0")}.md`);
  const query = await queryRoute({ baseText: JSON.stringify(UNLIMITED), notes, table: countingTable().table });
  for (const predicate of ['formula.shout == "m0000.md!"', "formula.shout == null"]) {
    const { payload } = await query({ view: "All", evaluate: true, limit: 5, filter: { and: [predicate] } });
    assert.equal(payload.total, 1001, `${predicate} keeps every row`);
    assert.ok(payload.warnings.includes("formula_filter_not_evaluated:too_many_rows:1001:1000"));
  }
  // A non-formula predicate still applies next to a skipped formula one.
  const { payload } = await query({
    view: "All",
    evaluate: true,
    limit: 5,
    filter: { "file.name": "m0007", "formula.shout": null },
  });
  assert.equal(payload.total, 1);
  assert.equal(payload.rows[0].file.path, "Notes/m0007.md");
});
