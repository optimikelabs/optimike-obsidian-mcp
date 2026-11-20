import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineRequestError,
  evaluateBaseFormulas,
  parseEvaluateRequest,
  withOneShotCachedRead,
} from "./engine-evaluate.mjs";

// Synthetic stand-in for Obsidian's `base:query` CLI handler: it reads the Base
// through `vault.cachedRead`, keeps rows matching the global `filters` (a list
// of allowed row names here), applies the view limit and returns rows keyed by
// column display name, values stringified with null for empty, as Obsidian does.
// Formula results come from a per-expression table instead of a real parser.
const PARSE_ERRORS = new Set(['if(file.name == "x", 1', '"unterminated + file.name']);

function evaluateExpression(expression, row, table) {
  if (expression === '"PARSED"') return "PARSED";
  const probe = /^if\(false, (.*), "PARSED"\)$/s.exec(expression);
  // Like Obsidian's parser, an empty argument (`if(false, , ...)`) does not parse.
  if (probe) return PARSE_ERRORS.has(probe[1]) || probe[1].trim() === "" ? null : "PARSED";
  if (expression === '"oobb-canary:" + file.name') return `oobb-canary:${row.name}`;
  if (expression === "oobbCanaryMissingFunction()") {
    return "unknownFunctionValue" in table
      ? table.unknownFunctionValue
      : "Error: Unknown function oobbCanaryMissingFunction.";
  }
  if (PARSE_ERRORS.has(expression)) return null;
  const compute = table[expression];
  return compute ? compute(row) : null;
}

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
  const handler = async ({ path, view, format }) => {
    assert.equal(format, "json");
    if (handlerError) throw handlerError;
    const file = vault.getFileByPath(path);
    if (!file) throw `Base file not found: ${path}`;
    const base = JSON.parse(await vault.cachedRead(file));
    // Obsidian's Base parser throws a plain Error on a schema error.
    const rejection = rejectBase?.(base);
    if (rejection) throw rejection;
    const config = base.views.find((candidate) => candidate.name === view);
    let selected = rows.filter((row) => !base.filters || base.filters.includes(row.name));
    if (config.limit) selected = selected.slice(0, config.limit);
    return JSON.stringify(
      selected.map((row) => {
        const out = { path: row.path };
        for (const propertyId of config.order) {
          const display = base.properties?.[propertyId]?.displayName ?? propertyId;
          const value = evaluateExpression(base.formulas[propertyId.slice(8)], row, table);
          out[display] = value === "" ? null : value;
        }
        return out;
      }),
    );
  };
  const app = { vault, cli: { handlers: new Map([["base:query", { handler }]]) } };
  return { app, vault, reads, store };
}

const deps = (app, obsidianVersion = "1.15.1") => ({
  app,
  parseYaml: JSON.parse,
  stringifyYaml: (value) => JSON.stringify(value),
  obsidianVersion,
});

const ROWS = ["a", "b", "c", "d"].map((name) => ({ name, path: `${name}.md` }));

test("classifies each formula on every row with syntax > runtime > all_null > ok", async () => {
  const base = {
    filters: ["a", "b", "c", "d"],
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
    rows: ROWS,
    files: { "B/X.base": JSON.stringify(base) },
    table,
  });

  const result = await evaluateBaseFormulas(deps(app), parseEvaluateRequest({ path: "B/X.base" }));

  assert.equal(result.available, true);
  assert.equal(result.engine, "obsidian");
  assert.equal(result.obsidianVersion, "1.15.1");
  assert.deepEqual(result.canary, { ok: true });
  assert.deepEqual(result.formulas.fine, { status: "ok", rows: 4, errorRows: 0, nullRows: 0, samples: [] });
  assert.equal(result.formulas.sparse.status, "ok");
  assert.equal(result.formulas.sparse.nullRows, 3);
  assert.equal(result.formulas.broken.status, "syntax_error");
  assert.equal(result.formulas.empty.status, "all_null");
  // An empty formula parses in Obsidian: empty, not a syntax error.
  assert.equal(result.formulas.blank.status, "all_null");
  assert.deepEqual(result.formulas.failing, {
    status: "runtime_error",
    rows: 4,
    errorRows: 3,
    nullRows: 0,
    samples: [
      { path: "a.md", message: "Error: boom a" },
      { path: "b.md", message: "Error: boom b" },
      { path: "c.md", message: "Error: boom c" },
    ],
  });
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
  const base = { filters: ["nobody"], formulas: { f: 'if(file.name == "x", 1' }, views: [] };
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

test("maps each unavailable engine state to its public reason", async () => {
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
