// Extracts the Bases formula function registry from Obsidian's running bundle.
//
// The registry is module-scoped inside `app.js` and absent from the public API.
// Every built-in function is registered on one receiver, either as
// `<id>.addGlobal(new class extends ...{...})` or as
// `<id>.addForType(<TypeId>,new class extends ...{...})`. Minified identifiers
// change between releases, so none is hardcoded: the receiver, the parameter
// helpers and the type names are all discovered from the bundle text with
// bounded regular-expression passes (no object-graph crawling).

export const REGISTRY_SOURCE = "obsidian-app-bundle";
export const REGISTRY_MIN_FUNCTIONS = 60;
export const REGISTRY_REQUIRED_GLOBALS = ["if", "now", "link"];

const SEGMENT_MAX_CHARS = 4000;
const TYPE_RESOLUTION_PASSES = 3;
// Doc keys whose type segment differs from Obsidian's type name.
const DOC_TYPE_ALIASES = { Value: "Any" };

export class RegistryUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function kebabDocKey(docKey) {
  return docKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function typeFromDocKey(docKey) {
  const match = /^label(RegExp|[A-Z][a-z]+)/.exec(docKey ?? "");
  if (!match) return null;
  return DOC_TYPE_ALIASES[match[1]] ?? match[1];
}

/** Finds the parameter helper definitions, e.g. `function fe(o,...t){return{name:o,type:t}}`. */
function findParamHelpers(bundle) {
  const helpers = new Map();
  const re =
    /function ([\w$]+)\(([\w$]+)(?:,([\w$]+))?,\.\.\.([\w$]+)\)\{return(\[)?\{name:([\w$]+),type:([\w$]+)((?:,\w+:[\w$!]+)*)\}\]?\}/g;
  let match;
  while ((match = re.exec(bundle))) {
    const [, helper, nameVar, widgetVar, typesVar, , nameRef, typeRef, rawFlags] = match;
    if (nameRef !== nameVar || typeRef !== typesVar) continue;
    const spec = { optional: false, variadic: false, widget: Boolean(widgetVar) };
    let valid = true;
    for (const flag of rawFlags.split(",").filter(Boolean)) {
      const [key, value] = flag.split(":");
      if (key === "optional" && value === "!0") spec.optional = true;
      else if (key === "variadic" && value === "!0") spec.variadic = true;
      else if (key === "customWidget" && value === widgetVar) continue;
      else valid = false;
    }
    if (valid) helpers.set(helper, spec);
  }
  return helpers;
}

/** Splits `fe("self",te),...Wv("inputs",ge)` into helper calls. */
function parseParamCalls(paramsText, helpers) {
  const callPattern = /(\.\.\.)?([\w$]+)\(([^()]*)\)/g;
  // Everything except the calls and their separators must be understood.
  if (paramsText.replace(callPattern, "").replace(/,/g, "").trim() !== "") return null;
  const calls = [];
  const re = new RegExp(callPattern.source, "g");
  let match;
  while ((match = re.exec(paramsText))) {
    const helper = helpers.get(match[2]);
    if (!helper) return null;
    const args = match[3].split(",");
    const name = /^"(\w+)"$/.exec(args.shift() ?? "");
    if (!name) return null;
    if (helper.widget && !/^"[^"]*"$/.test(args.shift() ?? "")) return null;
    if (args.some((arg) => !/^[\w$]+$/.test(arg))) return null;
    calls.push({
      name: name[1],
      typeIds: args,
      optional: helper.optional,
      variadic: helper.variadic,
    });
  }
  return calls;
}

/** Locates every registration; all must share one receiver. */
function findRegistrations(bundle) {
  // Anchor on the literal call (fast scan), then read the receiver backwards.
  const re = /\.(?:addGlobal\(new class|addForType\(([\w$]+),new class)/g;
  const found = [];
  let match;
  while ((match = re.exec(bundle))) {
    let start = match.index;
    while (start > 0 && /[\w$]/.test(bundle[start - 1])) start--;
    const receiver = bundle.slice(start, match.index);
    if (!receiver) continue;
    found.push({ index: start, receiver, typeId: match[1] ?? null });
  }
  return found;
}

function inheritedParams(bundle, parentId, cache) {
  if (cache.has(parentId)) return cache.get(parentId);
  const re = new RegExp(
    `(?<![\\w$.])${escapeRegExp(parentId)}=class extends [\\w$]+\\{constructor\\(\\)\\{super\\(\\.\\.\\.arguments\\);this\\.params=\\[([^\\]]*)\\]`,
  );
  const match = re.exec(bundle);
  const params = match ? match[1] : null;
  cache.set(parentId, params);
  return params;
}

/** Resolves minified type ids missing from the doc-key map to Obsidian type names. */
function resolveTypeNames(bundle, ids, known) {
  const names = new Map(known);
  let pending = new Map([...ids].filter((id) => !names.has(id)).map((id) => [id, [id]]));
  for (let pass = 0; pass < TYPE_RESOLUTION_PASSES && pending.size > 0; pass++) {
    const lookups = new Set([...pending.values()].map((chain) => chain[chain.length - 1]));
    const pattern = [...lookups].map(escapeRegExp).join("|");
    const re = new RegExp(
      `(?<![\\w$.])(${pattern})(?:\\.type="([A-Z][A-Za-z]*)"|=class(?: [\\w$]+)? extends ([\\w$]+)\\{|=([\\w$]+)[,;])`,
      "g",
    );
    const facts = new Map();
    let match;
    while ((match = re.exec(bundle))) {
      const fact = facts.get(match[1]) ?? {};
      if (match[2] && !fact.type) fact.type = match[2];
      if (match[3] && !fact.parent) fact.parent = match[3];
      if (match[4] && !fact.alias) fact.alias = match[4];
      facts.set(match[1], fact);
    }
    const next = new Map();
    for (const [id, chain] of pending) {
      const tail = chain[chain.length - 1];
      const fact = facts.get(tail) ?? {};
      const viaKnown = (ref) => (ref && names.has(ref) ? names.get(ref) : null);
      const resolved = fact.type ?? viaKnown(fact.parent) ?? viaKnown(fact.alias);
      if (resolved) {
        names.set(id, resolved);
        continue;
      }
      const hop = fact.parent ?? fact.alias;
      if (hop && !chain.includes(hop)) next.set(id, [...chain, hop]);
    }
    pending = next;
  }
  return names;
}

/**
 * Extracts the function registry from the bundle text.
 *
 * translate(key) returns Obsidian's localized string for an i18n key, or a
 * falsy value / the key itself when missing.
 * Returns { functions, warnings }; throws RegistryUnavailable("canary_failed")
 * when the bundle does not have the expected shape.
 */
export function extractFunctionRegistry(bundle, translate) {
  if (typeof bundle !== "string" || bundle.length === 0) {
    throw new RegistryUnavailable("engine_unavailable");
  }
  const registrations = findRegistrations(bundle);
  const receivers = new Set(registrations.map((entry) => entry.receiver));
  if (receivers.size !== 1) throw new RegistryUnavailable("canary_failed");
  const helpers = findParamHelpers(bundle);
  const parentParams = new Map();
  const warnings = [];

  const raw = [];
  for (let k = 0; k < registrations.length; k++) {
    const { index, typeId } = registrations[k];
    const end = Math.min(
      k + 1 < registrations.length ? registrations[k + 1].index : bundle.length,
      index + SEGMENT_MAX_CHARS,
    );
    const segment = bundle.slice(index, end);
    const name = /this\.name="(\w+)"/.exec(segment)?.[1];
    if (!name) continue;
    const docKey = /this\.docString=[\w$]+\.(\w+)/.exec(segment)?.[1] ?? null;
    let paramsText = /this\.params=\[([^\]]*)\]/.exec(segment)?.[1];
    if (paramsText === undefined) {
      const parent = /new class extends ([\w$]+)\{/.exec(segment)?.[1];
      paramsText = parent ? (inheritedParams(bundle, parent, parentParams) ?? undefined) : undefined;
    }
    raw.push({ name, typeId, docKey, paramsText });
  }

  const docTypes = new Map();
  for (const entry of raw) {
    if (!entry.typeId || docTypes.has(entry.typeId)) continue;
    const type = typeFromDocKey(entry.docKey);
    if (type) docTypes.set(entry.typeId, type);
  }

  const parsed = raw.map((entry) => {
    const calls = entry.paramsText === undefined ? null : parseParamCalls(entry.paramsText, helpers);
    if (!calls) warnings.push(`params_unparsed:${entry.name}`);
    return { ...entry, calls: calls ?? [] };
  });
  const typeIds = new Set();
  for (const entry of parsed) {
    if (entry.typeId) typeIds.add(entry.typeId);
    for (const call of entry.calls) for (const id of call.typeIds) typeIds.add(id);
  }
  const typeNames = resolveTypeNames(bundle, typeIds, docTypes);
  const typeName = (id) => {
    const resolved = typeNames.get(id);
    if (resolved) return resolved;
    warnings.push(`type_unresolved:${id}`);
    return "Unknown";
  };

  const functions = parsed.map((entry) => {
    const isGlobal = entry.typeId === null;
    // Instance functions receive their value as the first ("self") parameter;
    // Obsidian's autocomplete hides it.
    const calls = isGlobal ? entry.calls : entry.calls.slice(1);
    let doc = null;
    if (entry.docKey && typeof translate === "function") {
      const key = `formulas.funcs.${kebabDocKey(entry.docKey)}`;
      let text = null;
      try {
        text = translate(key);
      } catch {
        text = null;
      }
      doc = typeof text === "string" && text && text !== key && !text.startsWith("formulas.") ? text : null;
    }
    return {
      name: entry.name,
      on: isGlobal ? "Global" : typeName(entry.typeId),
      params: calls.map((call) => ({
        name: call.name,
        types: call.typeIds.map(typeName),
        optional: call.optional,
        variadic: call.variadic,
      })),
      doc,
    };
  });

  const globals = new Set(functions.filter((fn) => fn.on === "Global").map((fn) => fn.name));
  if (
    functions.length < REGISTRY_MIN_FUNCTIONS ||
    REGISTRY_REQUIRED_GLOBALS.some((name) => !globals.has(name))
  ) {
    throw new RegistryUnavailable("canary_failed");
  }
  return { functions, warnings: Array.from(new Set(warnings)) };
}

export function unavailableRegistry(reason) {
  return { available: false, reason, functions: [] };
}

/**
 * Caches one extraction per Obsidian version.
 *
 * deps: { obsidianVersion, fetchBundle: () => Promise<string>, translate }
 */
export function createFunctionRegistry(deps) {
  const cache = new Map();
  return async function listFunctions(on) {
    const version = deps.obsidianVersion;
    if (typeof version !== "string" || version === "") {
      return unavailableRegistry("unsupported_obsidian");
    }
    let pending = cache.get(version);
    if (!pending) {
      pending = (async () => {
        let bundle;
        try {
          bundle = await deps.fetchBundle();
        } catch {
          throw new RegistryUnavailable("engine_unavailable");
        }
        return extractFunctionRegistry(bundle, deps.translate);
      })();
      cache.set(version, pending);
      // Failures are not cached: a later call may succeed once the app is ready.
      pending.catch(() => {
        if (cache.get(version) === pending) cache.delete(version);
      });
    }
    let result;
    try {
      result = await pending;
    } catch (error) {
      return unavailableRegistry(
        error instanceof RegistryUnavailable ? error.reason : "engine_unavailable",
      );
    }
    const filter = typeof on === "string" && on.trim() !== "" ? on.trim().toLowerCase() : null;
    return {
      available: true,
      obsidianVersion: version,
      source: REGISTRY_SOURCE,
      functions: filter
        ? result.functions.filter((fn) => fn.on.toLowerCase() === filter)
        : result.functions,
      warnings: result.warnings,
    };
  };
}
