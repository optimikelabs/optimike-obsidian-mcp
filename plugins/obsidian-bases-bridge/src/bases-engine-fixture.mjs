// Synthetic stand-in for Obsidian's `base:query` CLI handler, for Bridge tests.
//
// Like the native handler it reads the Base through `vault.cachedRead`, keeps
// the rows matching the global and view filters, applies the view limit and
// returns rows keyed by column display name, with null for empty cells.
// Filters support `file.inFolder("X")` and `{ and: [...] }` only. Formula
// results come from a per-expression table instead of a real parser.
export const PARSE_ERRORS = new Set(['if(file.name == "x", 1', '"unterminated + file.name']);

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

function matches(filter, row) {
  if (filter === undefined || filter === null) return true;
  if (typeof filter === "string") {
    const folder = /^file\.inFolder\("(.*)"\)$/.exec(filter);
    if (!folder) throw new Error(`fixture does not support filter ${filter}`);
    return row.path.startsWith(`${folder[1]}/`);
  }
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(part, row));
  throw new Error("fixture does not support this filter shape");
}

/** Returns the handler; `calls` records every invocation. */
export function fakeBaseQueryHandler(vault, { rows, table = {}, handlerError, rejectBase, calls = [] }) {
  return async ({ path, view, format }) => {
    calls.push({ path, view, format });
    if (handlerError) throw handlerError;
    const file = vault.getFileByPath(path);
    if (!file) throw `Base file not found: ${path}`;
    const base = JSON.parse(await vault.cachedRead(file));
    // Obsidian's Base parser throws a plain Error on a schema error.
    const rejection = rejectBase?.(base);
    if (rejection) throw rejection;
    const config = base.views.find((candidate) => candidate.name === view);
    let selected = rows.filter((row) => matches(base.filters, row) && matches(config.filters, row));
    if (config.limit) selected = selected.slice(0, config.limit);
    return JSON.stringify(
      selected.map((row) => {
        const out = { path: row.path };
        for (const propertyId of config.order) {
          const display = base.properties?.[propertyId]?.displayName ?? propertyId;
          const value = evaluateExpression(base.formulas[propertyId.slice("formula.".length)], row, table);
          out[display] = value === "" ? null : value;
        }
        return out;
      }),
    );
  };
}
