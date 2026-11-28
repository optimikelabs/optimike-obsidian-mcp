import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineRequestError,
  ENGINE_SAMPLE_ROWS,
  evaluateBaseFormulas,
  parseEvaluateRequest,
  withOneShotCachedRead,
} from "./engine-evaluate.mjs";
import { fakeBaseQueryHandler } from "./bases-engine-fixture.mjs";
import nativeCapture from "./fixtures/bases-native-1.15.1.json" with { type: "json" };

function syntheticApp({ rows, files, table = {}, handlerError, rejectBase } = {}) {
  const store = new Map(Object.entries(files));
  const reads = [];
  const vault = Object.create({
    cachedRead(file) {
      reads.push(file.path);
      return Promise.resolve(store.get(file.path));
    },
  });
  vault.read = (file) => Promise.resolve(store.get(file.path));
  vault.getFileByPath = (path) =>
    store.has(path) ? { path, extension: path.split(".").pop() } : null;
  const handler = fakeBaseQueryHandler(vault, { rows, table, handlerError, rejectBase });
  const app = { vault, cli: { handlers: new Map([["base:query", { handler }]]) } };
  return { app, vault, reads, store };
}

const deps = (app, obsidianVersion = "1.15.1") => ({
  app,
  parseYaml: JSON.parse,
  stringifyYaml: (value) => JSON.stringify(value),
  obsidianVersion,
});

const ROWS = ["a", "b", "c", "d"].map((name) => ({ name, path: `Notes/${name}.md` }));

test("classifies each formula on every row with syntax > runtime > all_null > ok", async () => {
  const base = {
    filters: 'file.inFolder("Data/Diag")',
    formulas: {
      fine: "file.name",
      sparse: "note.sparse",
      broken: 'if(file.name == "x", 1',
      failing: "note.failing",
      empty: "note.missing",
      blank: "",
    },
    // A view limit must not hide rows from the diagnosis.
    views: [{ type: "table", name: "Main", limit: 1 }],
  };
  const table = {
    "file.name": (row) => row.name,
    "note.sparse": (row) => (row.name === "a" ? "x" : null),
    "note.failing": (row) => (row.name === "d" ? "ok" : `Error: boom ${row.name}`),
  };
  const { app, store } = syntheticApp({
    rows: ROWS.map(({ name }) => ({ name, path: `Data/Diag/${name}.md` })),
    files: { "B/X.base": JSON.stringify(base) },
    table,
  });

  const result = await evaluateBaseFormulas(deps(app), parseEvaluateRequest({ path: "B/X.base" }));

  assert.equal(result.available, true);
  assert.equal(result.engine, "obsidian");
  assert.equal(result.obsidianVersion, "1.15.1");
  assert.deepEqual(result.canary, { ok: true });
  // Includes the native distinction between a syntax error and a blank formula.
  assert.deepEqual(result.formulas, nativeCapture.diagnostics);
  // Only the in-memory candidate carried the probes; the stored Base is untouched.
  assert.deepEqual(JSON.parse(store.get("B/X.base")), base);
});

test("evaluates a candidate YAML and only the requested formulas", async () => {
  const stored = { formulas: { old: "file.name" }, views: [] };
  const { app } = syntheticApp({
    rows: ROWS,
    files: { "X.base": JSON.stringify(stored) },
    table: { "note.next": () => "v" },
  });
  const result = await evaluateBaseFormulas(
    deps(app),
    parseEvaluateRequest({
      path: "X.base",
      yaml: JSON.stringify({ formulas: { next: "note.next", other: "file.name" } }),
      formulas: ["next", "ghost"],
    }),
  );
  assert.equal(result.available, true);
  assert.deepEqual(Object.keys(result.formulas).sort(), ["ghost", "next"]);
  assert.equal(result.formulas.next.status, "ok");
  assert.equal(result.formulas.ghost.status, "not_evaluated");
  assert.deepEqual(result.warnings, ["formula_not_found:ghost"]);
});

test("reports not_evaluated without rows once the engine canary holds elsewhere", async () => {
  const base = { filters: 'file.inFolder("Nowhere")', formulas: { f: 'if(file.name == "x", 1' }, views: [] };
  const { app } = syntheticApp({ rows: ROWS, files: { "X.base": JSON.stringify(base) } });
  const result = await evaluateBaseFormulas(deps(app), parseEvaluateRequest({ path: "X.base" }));
  assert.equal(result.available, true);
  assert.deepEqual(result.formulas.f, {
    status: "not_evaluated",
    rows: 0,
    errorRows: 0,
    nullRows: 0,
    samples: [],
  });
});

test("a failing canary makes the answer unavailable, never ok", async () => {
  const base = { formulas: { fine: "file.name" }, views: [] };
  for (const unknownFunctionValue of [null, "silently ok"]) {
    const { app } = syntheticApp({
      rows: ROWS,
      files: { "X.base": JSON.stringify(base) },
      table: { "file.name": (row) => row.name, unknownFunctionValue },
    });
    const result = await evaluateBaseFormulas(deps(app), parseEvaluateRequest({ path: "X.base" }));
    assert.deepEqual(result, { available: false, reason: "canary_failed", formulas: {} });
  }
});

test("maps simulated-only engine failures to their public reasons", async () => {
  const files = { "X.base": JSON.stringify({ formulas: { f: "file.name" } }) };
  const cases = [
    ["unsupported_obsidian", () => deps(syntheticApp({ rows: ROWS, files }).app, "1.14.4"), "X.base"],
    [
      "engine_unavailable",
      () => {
        const { app } = syntheticApp({ rows: ROWS, files });
        app.cli.handlers.clear();
        return deps(app);
      },
      "X.base",
    ],
    ["base_not_found", () => deps(syntheticApp({ rows: ROWS, files }).app), "Missing.base"],
    [
      "invalid_yaml",
      () => deps(syntheticApp({ rows: ROWS, files: { "X.base": "{ not json" } }).app),
      "X.base",
    ],
    [
      // The parser rejects the candidate while a canary-only Base still runs.
      "invalid_yaml",
      () =>
        deps(
          syntheticApp({
            rows: ROWS,
            files,
            rejectBase: (base) => ("f" in base.formulas ? new Error("Views must have a name") : null),
          }).app,
        ),
      "X.base",
    ],
    [
      // Every query fails, the canary included: the engine itself is unusable.
      "engine_unavailable",
      () => deps(syntheticApp({ rows: ROWS, files, handlerError: new Error("boom") }).app),
      "X.base",
    ],
    [
      // A non-string formula breaks the whole Base, even when not requested.
      "invalid_yaml",
      () =>
        deps(
          syntheticApp({
            rows: ROWS,
            files: { "X.base": JSON.stringify({ formulas: { f: "file.name", n: 3 } }) },
          }).app,
        ),
      "X.base",
      ["f"],
    ],
  ];
  for (const [reason, makeDeps, path, formulas] of cases) {
    const result = await evaluateBaseFormulas(makeDeps(), parseEvaluateRequest({ path, formulas }));
    assert.deepEqual(result, { available: false, reason, formulas: {} }, reason);
  }
});

test("the cachedRead interception is one-shot, path-scoped and restored on throw", async () => {
  const { vault, store } = syntheticApp({ rows: [], files: { "X.base": "stored", "Y.base": "other" } });
  const inherited = vault.cachedRead;
  assert.equal(Object.prototype.hasOwnProperty.call(vault, "cachedRead"), false);
  const seen = [];
  await assert.rejects(
    withOneShotCachedRead(vault, "X.base", "candidate", async () => {
      seen.push(await vault.cachedRead({ path: "Y.base" }));
      seen.push(await vault.cachedRead({ path: "X.base" }));
      seen.push(await vault.cachedRead({ path: "X.base" }));
      throw new Error("handler failed");
    }),
    /handler failed/,
  );
  assert.deepEqual(seen, ["other", "candidate", "stored"]);
  assert.equal(Object.prototype.hasOwnProperty.call(vault, "cachedRead"), false);
  assert.equal(vault.cachedRead, inherited);
  assert.equal(store.get("X.base"), "stored");
});

test("concurrent evaluations never leave an interceptor installed", async () => {
  const base = { formulas: { fine: "file.name" }, views: [] };
  const { app, vault } = syntheticApp({
    rows: ROWS,
    files: { "X.base": JSON.stringify(base), "Y.base": JSON.stringify(base) },
    table: { "file.name": (row) => row.name },
  });
  const inherited = vault.cachedRead;
  const results = await Promise.all([
    evaluateBaseFormulas(deps(app), parseEvaluateRequest({ path: "X.base" })),
    evaluateBaseFormulas(deps(app), parseEvaluateRequest({ path: "Y.base" })),
  ]);
  assert.deepEqual(
    results.map((result) => result.formulas.fine.status),
    ["ok", "ok"],
  );
  assert.equal(vault.cachedRead, inherited);
  assert.equal(Object.prototype.hasOwnProperty.call(vault, "cachedRead"), false);
});

test("rejects malformed requests before touching the engine", () => {
  for (const body of [null, {}, { path: "" }, { path: "X.base", yaml: 1 }, { path: "X.base", formulas: [1] }]) {
    assert.throws(() => parseEvaluateRequest(body), EngineRequestError);
  }
  assert.equal(parseEvaluateRequest({ path: "A\\X.base" }).path, "A/X.base");
});

test("a formula check computes at most ENGINE_SAMPLE_ROWS rows and says so", async () => {
  let computed = 0;
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `n${i}`, path: `Notes/n${i}.md` }));
  const base = { filters: 'file.inFolder("Notes")', formulas: { name: "file.name" }, views: [] };
  const { app } = syntheticApp({
    rows: many,
    files: { "B/Big.base": JSON.stringify(base) },
    table: { "file.name": (row) => (computed++, row.name) },
  });

  const result = await evaluateBaseFormulas(deps(app), parseEvaluateRequest({ path: "B/Big.base" }));

  assert.equal(ENGINE_SAMPLE_ROWS, 100);
  assert.equal(result.available, true);
  assert.equal(result.rowLimit, 100);
  assert.equal(result.formulas.name.status, "ok");
  assert.equal(result.formulas.name.rows, 100);
  assert.equal(computed, 100, "the engine computes the formula for the sampled rows only");
});
