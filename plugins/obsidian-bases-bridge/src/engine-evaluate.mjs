// Evaluates Base formulas with Obsidian's own Bases engine.
//
// Obsidian exposes no public API that evaluates a Base. Its core CLI handler
// `base:query` (registered by the Bases core plugin in `app.cli.handlers`)
// parses a Base from text, applies its global filters and evaluates the columns
// of one view. This module feeds that handler a candidate text built from the
// stored Base (or from caller-supplied YAML) by intercepting exactly one
// `app.vault.cachedRead()` call for the target path. Nothing is written.

/** Earliest Obsidian version on which this path was proven live. */
export const ENGINE_MIN_OBSIDIAN_VERSION = "1.15.0";

const ENGINE_HANDLER_ID = "base:query";
const PROBE_PREFIX = "__oobb_";
const PROBE_VIEW_NAME = "__oobb_engine_probe";
const MAX_SAMPLES = 3;
const PARSED_MARKER = "PARSED";
const CANARY_OK_PREFIX = "oobb-canary:";
// A known-good formula (string concatenation over a row field) and a formula
// that always parses but fails at evaluation (unknown global function).
const CANARY_OK_FORMULA = `"${CANARY_OK_PREFIX}" + file.name`;
const CANARY_BAD_FORMULA = "oobbCanaryMissingFunction()";

export class EngineRequestError extends Error {}

class EngineUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export function unavailableEvaluation(reason) {
  return { available: false, reason, formulas: {} };
}

/** Compares dotted numeric versions; non-numeric parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".");
  const pb = String(b ?? "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const y = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Validates the HTTP body; throws EngineRequestError when malformed. */
export function parseEvaluateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EngineRequestError("A JSON object body is required.");
  }
  const rawPath = body.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new EngineRequestError("path must be a non-empty string.");
  }
  if (body.yaml !== undefined && typeof body.yaml !== "string") {
    throw new EngineRequestError("yaml must be a string when provided.");
  }
  if (
    body.formulas !== undefined &&
    (!Array.isArray(body.formulas) ||
      body.formulas.some((name) => typeof name !== "string" || name === ""))
  ) {
    throw new EngineRequestError(
      "formulas must be an array of non-empty strings when provided.",
    );
  }
  return {
    path: rawPath.replace(/\\/g, "/"),
    yaml: body.yaml,
    formulas: body.formulas ? Array.from(new Set(body.formulas)) : undefined,
  };
}

// Engine calls share one vault method; serialize them so an interception is
// never installed while another one is active.
let engineQueue = Promise.resolve();

function runExclusive(task) {
  const run = engineQueue.then(task, task);
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Calls `handler(args)` while `vault.cachedRead(file)` returns `text` exactly
 * once, for `path` only. The original method is restored in `finally`, even
 * when the handler throws.
 */
export async function withOneShotCachedRead(vault, path, text, call) {
  const hadOwn = Object.prototype.hasOwnProperty.call(vault, "cachedRead");
  const original = vault.cachedRead;
  let pending = true;
  const interceptor = function (file, ...rest) {
    if (pending && file && file.path === path) {
      pending = false;
      return Promise.resolve(text);
    }
    return original.call(this, file, ...rest);
  };
  vault.cachedRead = interceptor;
  try {
    return await call();
  } finally {
    pending = false;
    if (vault.cachedRead === interceptor) {
      if (hadOwn) vault.cachedRead = original;
      else delete vault.cachedRead;
    }
  }
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function freshName(taken, base) {
  let name = base;
  while (taken.has(name)) name = `${name}_`;
  taken.add(name);
  return name;
}

/**
 * Builds the candidate Base: the original document plus probe formulas and one
 * probe table view. Without `baseView` the probe view has no view filters and
 * no limit, so the engine evaluates the formulas on every row selected by the
 * global filters. With `baseView`, the probe view keeps that view's filters,
 * sort and limit, so the engine selects exactly the rows of that view. Each
 * probe column gets a unique display name because the handler keys rows by
 * display name.
 */
export function buildProbeCandidate(
  doc,
  formulaNames,
  { parseProbes = true, baseView = null } = {},
) {
  const candidate = clonePlain(doc);
  if (candidate.formulas === undefined || candidate.formulas === null) {
    candidate.formulas = {};
  }
  if (typeof candidate.formulas !== "object" || Array.isArray(candidate.formulas)) {
    throw new EngineUnavailable("invalid_yaml");
  }
  if (candidate.properties === undefined || candidate.properties === null) {
    candidate.properties = {};
  }
  if (typeof candidate.properties !== "object" || Array.isArray(candidate.properties)) {
    throw new EngineUnavailable("invalid_yaml");
  }
  if (candidate.views === undefined || candidate.views === null) {
    candidate.views = [];
  }
  if (!Array.isArray(candidate.views)) {
    throw new EngineUnavailable("invalid_yaml");
  }

  const taken = new Set(Object.keys(candidate.formulas));
  const columns = [];
  const order = [];
  const addColumn = (formulaName, kind, target) => {
    const propertyId = `formula.${formulaName}`;
    const display = freshName(
      new Set(columns.map((column) => column.display)),
      `${PROBE_PREFIX}${kind}_${columns.length}`,
    );
    const existing = candidate.properties[propertyId];
    candidate.properties[propertyId] = {
      ...(existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing
        : {}),
      displayName: display,
    };
    order.push(propertyId);
    columns.push({ kind, target, display });
  };

  formulaNames.forEach((name, index) => {
    const expression = candidate.formulas[name];
    addColumn(name, "value", name);
    if (!parseProbes) return;
    const probe = freshName(taken, `${PROBE_PREFIX}parse_${index}`);
    candidate.formulas[probe] = `if(false, ${expression}, "${PARSED_MARKER}")`;
    addColumn(probe, "parse", name);
  });
  const ok = freshName(taken, `${PROBE_PREFIX}canary_ok`);
  candidate.formulas[ok] = CANARY_OK_FORMULA;
  addColumn(ok, "canary_ok", null);
  const bad = freshName(taken, `${PROBE_PREFIX}canary_bad`);
  candidate.formulas[bad] = CANARY_BAD_FORMULA;
  addColumn(bad, "canary_bad", null);

  const viewNames = new Set(
    candidate.views.map((view) => (view && typeof view === "object" ? view.name : undefined)),
  );
  const viewName = freshName(viewNames, PROBE_VIEW_NAME);
  const inherited = {};
  if (baseView && typeof baseView === "object" && !Array.isArray(baseView)) {
    for (const [key, value] of Object.entries(clonePlain(baseView))) {
      if (key !== "name" && key !== "order" && key !== "type") inherited[key] = value;
    }
  }
  candidate.views.push({ ...inherited, type: "table", name: viewName, order });
  return { candidate, columns, viewName };
}

function isErrorValue(value) {
  return typeof value === "string" && value.startsWith("Error:");
}

function isNullValue(value) {
  return value === null || value === undefined || value === "";
}

/** Status precedence: syntax_error > runtime_error > all_null > ok. */
export function classifyFormula(rows, valueKey, parseKey) {
  const total = rows.length;
  if (total === 0) {
    return { status: "not_evaluated", rows: 0, errorRows: 0, nullRows: 0, samples: [] };
  }
  let errorRows = 0;
  let nullRows = 0;
  let parsed = true;
  const samples = [];
  for (const row of rows) {
    const value = row[valueKey];
    if (row[parseKey] !== PARSED_MARKER) parsed = false;
    if (isErrorValue(value)) {
      errorRows++;
      if (samples.length < MAX_SAMPLES) {
        samples.push({ path: String(row.path ?? ""), message: value });
      }
    } else if (isNullValue(value)) {
      nullRows++;
    }
  }
  let status = "ok";
  if (!parsed) status = "syntax_error";
  else if (errorRows > 0) status = "runtime_error";
  else if (nullRows === total) status = "all_null";
  return { status, rows: total, errorRows, nullRows, samples };
}

/** True when every row proves a working engine: good canary ok, bad canary error. */
export function canaryHolds(rows, okKey, badKey) {
  if (rows.length === 0) return false;
  return rows.every(
    (row) =>
      typeof row[okKey] === "string" &&
      row[okKey].startsWith(CANARY_OK_PREFIX) &&
      isErrorValue(row[badKey]),
  );
}

function classifyHandlerFailure(error) {
  const message =
    typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : "";
  if (message.startsWith("Base file not found") || message.startsWith("Not a base file")) {
    return "base_not_found";
  }
  if (message.startsWith("Failed to parse base file")) return "invalid_yaml";
  return "engine_unavailable";
}

async function runProbeQuery(engine, path, candidateText, viewName) {
  let output;
  try {
    output = await withOneShotCachedRead(engine.vault, path, candidateText, () =>
      engine.handler({ path, view: viewName, format: "json" }),
    );
  } catch (error) {
    throw new EngineUnavailable(classifyHandlerFailure(error));
  }
  let rows;
  try {
    rows = JSON.parse(String(output));
  } catch {
    throw new EngineUnavailable("engine_unavailable");
  }
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object")) {
    throw new EngineUnavailable("engine_unavailable");
  }
  return rows;
}

function columnKey(columns, kind, target) {
  return columns.find((column) => column.kind === kind && column.target === target)?.display;
}

/** Locates the native engine pieces; throws EngineUnavailable when absent. */
export function resolveEngine(app, obsidianVersion) {
  if (
    typeof obsidianVersion !== "string" ||
    compareVersions(obsidianVersion, ENGINE_MIN_OBSIDIAN_VERSION) < 0
  ) {
    throw new EngineUnavailable("unsupported_obsidian");
  }
  let handler;
  try {
    handler = app?.cli?.handlers?.get?.(ENGINE_HANDLER_ID)?.handler;
  } catch {
    handler = undefined;
  }
  const vault = app?.vault;
  if (
    typeof handler !== "function" ||
    !vault ||
    typeof vault.cachedRead !== "function"
  ) {
    throw new EngineUnavailable("engine_unavailable");
  }
  return { handler, vault };
}

/**
 * Evaluates formulas of a Base with Obsidian's engine.
 *
 * deps: { app, parseYaml, stringifyYaml, obsidianVersion }
 * request: result of parseEvaluateRequest().
 */
export function evaluateBaseFormulas(deps, request) {
  return runExclusive(() => evaluateUnlocked(deps, request));
}

async function evaluateUnlocked(deps, request) {
  try {
    return await evaluateOrThrow(deps, request);
  } catch (error) {
    if (error instanceof EngineUnavailable) return unavailableEvaluation(error.reason);
    return unavailableEvaluation("engine_unavailable");
  }
}

function resolveBaseFile(engine, path) {
  const file = engine.vault.getFileByPath?.(path) ?? engine.vault.getAbstractFileByPath?.(path);
  // The native handler resolves the Base through the vault index, so the file
  // must exist even when a candidate YAML is supplied.
  if (!file || file.extension !== "base") throw new EngineUnavailable("base_not_found");
  return file;
}

function parseBaseDocument(parseYaml, sourceText) {
  let doc;
  try {
    doc = sourceText.trim() === "" ? {} : parseYaml(sourceText);
  } catch {
    throw new EngineUnavailable("invalid_yaml");
  }
  if (doc === null || doc === undefined) doc = {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new EngineUnavailable("invalid_yaml");
  }
  return doc;
}

function declaredFormulas(doc) {
  return doc.formulas && typeof doc.formulas === "object" && !Array.isArray(doc.formulas)
    ? doc.formulas
    : {};
}

/**
 * Runs one probe candidate through the engine and proves the engine with the
 * canaries. When the probe selects no row, the canary runs on a canary-only
 * Base (no filters, one row) so an empty answer is never unverified.
 */
async function runVerifiedProbe(engine, path, stringifyYaml, probe) {
  const rows = await runProbeQuery(engine, path, stringifyYaml(probe.candidate), probe.viewName);
  if (rows.length > 0) {
    const okKey = columnKey(probe.columns, "canary_ok", null);
    const badKey = columnKey(probe.columns, "canary_bad", null);
    if (!canaryHolds(rows, okKey, badKey)) throw new EngineUnavailable("canary_failed");
    return rows;
  }
  const canaryOnly = buildProbeCandidate({}, []);
  canaryOnly.candidate.views[0].limit = 1;
  const canaryRows = await runProbeQuery(
    engine,
    path,
    stringifyYaml(canaryOnly.candidate),
    canaryOnly.viewName,
  );
  if (
    !canaryHolds(
      canaryRows,
      columnKey(canaryOnly.columns, "canary_ok", null),
      columnKey(canaryOnly.columns, "canary_bad", null),
    )
  ) {
    throw new EngineUnavailable("canary_failed");
  }
  return rows;
}

/**
 * Selects the rows of one view of a stored Base with Obsidian's engine and
 * returns every formula value of those rows.
 *
 * The engine applies the Base's global filters and the view's filters, sort
 * and limit. `text` must be the exact stored bytes the caller read, so any
 * proof derived from them describes what the engine evaluated. `viewIndex`
 * is the index of the view in `views`; a negative or missing index means no
 * view (global filters only, no limit).
 *
 * Returns { available: true, formulas: string[], rows: [{ path, values }] } or
 * { available: false, reason }. Values are the engine's text rendering of each
 * cell, null when empty.
 */
export function queryBaseViewWithEngine(deps, { path, text, viewIndex }) {
  return runExclusive(async () => {
    try {
      const engine = resolveEngine(deps.app, deps.obsidianVersion);
      resolveBaseFile(engine, path);
      const doc = parseBaseDocument(deps.parseYaml, text);
      const declared = declaredFormulas(doc);
      const names = Object.keys(declared);
      if (names.some((name) => typeof declared[name] !== "string")) {
        throw new EngineUnavailable("invalid_yaml");
      }
      const views = Array.isArray(doc.views) ? doc.views : [];
      const baseView =
        Number.isInteger(viewIndex) && viewIndex >= 0 ? (views[viewIndex] ?? null) : null;
      const probe = buildProbeCandidate(doc, names, { parseProbes: false, baseView });
      const rows = await runVerifiedProbe(engine, path, deps.stringifyYaml, probe);
      return {
        available: true,
        formulas: names,
        rows: rows.map((row) => {
          const values = {};
          for (const name of names) {
            const value = row[columnKey(probe.columns, "value", name)];
            values[name] = isNullValue(value) ? null : value;
          }
          return { path: String(row.path ?? ""), values };
        }),
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof EngineUnavailable ? error.reason : "engine_unavailable",
      };
    }
  });
}

async function evaluateOrThrow({ app, parseYaml, stringifyYaml, obsidianVersion }, request) {
  const engine = resolveEngine(app, obsidianVersion);
  const { path } = request;
  const file = resolveBaseFile(engine, path);
  const doc = parseBaseDocument(parseYaml, request.yaml ?? (await engine.vault.read(file)));
  const declared = declaredFormulas(doc);
  const requested = request.formulas ?? Object.keys(declared);
  const warnings = [];
  const evaluable = [];
  const formulas = {};
  for (const name of requested) {
    if (!Object.prototype.hasOwnProperty.call(declared, name)) {
      warnings.push(`formula_not_found:${name}`);
      formulas[name] = { status: "not_evaluated", rows: 0, errorRows: 0, nullRows: 0, samples: [] };
      continue;
    }
    if (typeof declared[name] !== "string") throw new EngineUnavailable("invalid_yaml");
    evaluable.push(name);
  }

  const probe = buildProbeCandidate(doc, evaluable);
  const rows = await runVerifiedProbe(engine, path, stringifyYaml, probe);

  for (const name of evaluable) {
    formulas[name] = classifyFormula(
      rows,
      columnKey(probe.columns, "value", name),
      columnKey(probe.columns, "parse", name),
    );
  }
  return {
    available: true,
    engine: "obsidian",
    obsidianVersion,
    canary: { ok: true },
    formulas,
    warnings,
  };
}
