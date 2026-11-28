type Scalar = string | number | boolean | null;
type ReadProperty = (key: string) => unknown;
type FilterRow = {
  read: ReadProperty;
  evaluateLiveCall?: (statement: string) => boolean;
};
type Predicate = {
  usesFormula: boolean;
  matches: (row: FilterRow, skipFormulas?: boolean) => boolean;
};

const FILE_PROPERTIES = new Set(["file.path", "file.name", "file.ctime", "file.mtime", "file.size"]);
const REFERENCE = /^(?:(?:file|note|formula)\.)?[\p{L}\p{N}_-]+$/u;
const COMPARISON = /^([^=<>!\s]+)\s*(==|!=|>=|<=|=|>|<)\s*(.+)$/u;
const LITERAL = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\p{L}\p{N}_-]+|-?\d+\.\d+)$/u;
const LOGICAL_TOKENS = [[" or ", "or"], ["||", "or"], [" and ", "and"], ["&&", "and"]] as const;

// These calls use Obsidian metadata (or the Bridge's existing expression helpers).
const LIVE_CALLS = [
  /^file\.(?:hasTag|inFolder|hasLink)\(.+\)$/u,
  /^\[.*\]\.contains\(.+\)$/su,
  /^file\.(?:path|name|folder|ext)\.(?:contains|startsWith)\(.+\)$/u,
  /^file\.tags\.contains\(.+\)$/u,
  /^(?:list\([\p{L}\p{N}_-]+\)|[\p{L}\p{N}_-]+)\.contains\(link\(.+\)\)$/u,
];

export const BASE_QUERY_FILTER_VERSION = 1;
export const BASE_QUERY_FILTER_DESCRIPTION =
  'Additional JSON object filter. Use property values ({"status":"open"}), scalar arrays, or eq/ne/in/contains/gt/gte/lt/lte operator objects. Combine with and/or arrays or a single not node. Put expression strings inside a group, for example {"and":["status == \\"open\\""]}.';
export const BASE_QUERY_FILTER_ERROR =
  "Unsupported Base query filter node. " + BASE_QUERY_FILTER_DESCRIPTION;

export class BaseQueryFilterError extends Error {
  constructor(readonly node: string) {
    super(BASE_QUERY_FILTER_ERROR);
  }
}

export function isBaseQueryFilterNode(value: string): boolean {
  return /^filter(?:\.(?:not|(?:and|or|property)\[\d{1,10}\])){0,33}(?:\.(?:and|or))?$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" ||
    typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function isScalarList(value: unknown): value is Scalar[] {
  return Array.isArray(value) && value.every(isScalar);
}

function normalizeValue(key: string, value: unknown): unknown {
  return key === "file.path" && typeof value === "string" ? value.replace(/^\/+/u, "") : value;
}

function compileProperty(key: string, expected: unknown, node: string): (value: unknown) => boolean {
  const equals = (actual: unknown, value: Scalar) => {
    const normalized = normalizeValue(key, value);
    return Array.isArray(actual)
      ? actual.some((item) => String(item) === String(normalized))
      : actual === normalized;
  };
  if (isScalar(expected)) return (actual) => equals(actual, expected);
  if (isScalarList(expected)) return (actual) => expected.some((value) => equals(actual, value));
  if (!isRecord(expected) || Object.keys(expected).length === 0) throw new BaseQueryFilterError(node);
  const conditions = Object.entries(expected).map(([operator, operand]) => {
    if (operator === "in" && isScalarList(operand)) {
      return (actual: unknown) => operand.some((value) => equals(actual, value));
    }
    if (!isScalar(operand)) throw new BaseQueryFilterError(node);
    switch (operator) {
      case "eq": return (actual: unknown) => equals(actual, operand);
      case "ne": return (actual: unknown) => !equals(actual, operand);
      case "contains": return (actual: unknown) => String(actual ?? "").includes(String(operand));
      case "gt": return (actual: unknown) => Number(actual) > Number(operand);
      case "gte": return (actual: unknown) => Number(actual) >= Number(operand);
      case "lt": return (actual: unknown) => Number(actual) < Number(operand);
      case "lte": return (actual: unknown) => Number(actual) <= Number(operand);
      default: throw new BaseQueryFilterError(node);
    }
  });
  return (actual) => conditions.every((condition) => condition(actual));
}

function splitOutsideQuotes(statement: string, token: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    if (quote && char === "\\") {
      index++;
      continue;
    }
    if (quote === char) quote = undefined;
    else if (!quote && (char === "'" || char === '"')) quote = char;
    if (!quote && statement.startsWith(token, index)) {
      parts.push(statement.slice(start, index).trim());
      index += token.length - 1;
      start = index + 1;
    }
  }
  parts.push(statement.slice(start).trim());
  return parts;
}

function parseLiteral(value: string): Scalar {
  if (value === "null") return null;
  if (/^(true|false)$/iu.test(value)) return /^true$/iu.test(value);
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  return value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
}

function compare(left: unknown, operator: string, right: unknown): boolean {
  if (left == null || right == null) {
    if (operator === "=" || operator === "==") return left == null && right == null;
    return operator === "!=" && !(left == null && right == null);
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const a = numeric ? leftNumber : String(left);
  const b = numeric ? rightNumber : String(right);
  switch (operator) {
    case "=":
    case "==": return a === b;
    case "!=": return a !== b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    default: return false;
  }
}

function isTruthy(value: unknown): boolean {
  return value === true ||
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "object" && value !== null && Object.keys(value).length > 0);
}

function predicate(usesFormula: boolean, match: (row: FilterRow) => boolean): Predicate {
  return { usesFormula, matches: (row, skipFormulas = false) => (skipFormulas && usesFormula) || match(row) };
}

function combine(operator: "and" | "or", children: Predicate[]): Predicate {
  const usesFormula = children.some((child) => child.usesFormula);
  if (operator === "and") {
    return { usesFormula, matches: (row, skip) => children.every((child) => child.matches(row, skip)) };
  }
  return predicate(usesFormula, (row) => children.some((child) => child.matches(row)));
}

/** Compile every request node before visiting rows. Stored Base filters use Obsidian's own syntax. */
export function compileBaseQueryFilter(filter: unknown, live: boolean): Predicate & { usesPropertyTable: boolean } {
  let usesPropertyTable = false;

  function property(key: string, node: string, match: (value: unknown) => boolean): Predicate {
    const usesFormula = key.startsWith("formula.");
    const unsupportedFile = key.startsWith("file.") && !FILE_PROPERTIES.has(key) &&
      !(live && (key === "file.ext" || key === "file.folder"));
    if (!key.trim() || key !== key.trim() || unsupportedFile ||
      (!live && (usesFormula || key.startsWith("note.")))) {
      throw new BaseQueryFilterError(node);
    }
    return predicate(usesFormula, (row) => match(normalizeValue(key, row.read(key))));
  }

  function negate(child: Predicate): Predicate {
    return predicate(child.usesFormula, (row) => !child.matches(row));
  }

  function statement(raw: string, node: string, depth: number): Predicate {
    if (raw.length > 1024) throw new BaseQueryFilterError(node);
    const value = raw.trim();
    for (const [token, operator] of LOGICAL_TOKENS) {
      const parts = splitOutsideQuotes(value, token);
      if (parts.length > 1) {
        return combine(operator, parts.map((part) => compile(part, node, depth + 1)));
      }
    }
    if (value.startsWith("not ") || value.startsWith("!")) {
      return negate(compile(value.slice(value.startsWith("!") ? 1 : 4), node, depth + 1));
    }
    if (live && LIVE_CALLS.some((pattern) => pattern.test(value))) {
      const usesFormula = /\]\.contains\(\s*formula\./u.test(value);
      return predicate(usesFormula, (row) => row.evaluateLiveCall!(value));
    }
    const comparison = COMPARISON.exec(value);
    if (comparison) {
      const [, key, operator, rawOperand] = comparison;
      const operand = rawOperand.trim();
      if (REFERENCE.test(key) && LITERAL.test(operand)) {
        const right = normalizeValue(key, parseLiteral(operand));
        return property(key, node, (left) => compare(left, operator, right));
      }
    }
    if (!REFERENCE.test(value)) throw new BaseQueryFilterError(node);
    return property(value, node, isTruthy);
  }

  function compile(value: unknown, node: string, depth: number): Predicate {
    if (depth > 32) throw new BaseQueryFilterError(node);
    if (depth > 0 && typeof value === "string") return statement(value, node, depth);
    if (!isRecord(value)) throw new BaseQueryFilterError(node);
    const entries = Object.entries(value);
    if (entries.length === 0 && depth > 0) throw new BaseQueryFilterError(node);
    const group = entries.find(([key]) => key === "and" || key === "or" || key === "not");
    if (group) {
      if (entries.length !== 1) throw new BaseQueryFilterError(node);
      const [operator, parts] = group;
      if (operator === "not") return negate(compile(parts, node + ".not", depth + 1));
      if (!Array.isArray(parts)) throw new BaseQueryFilterError(node + "." + operator);
      return combine(operator === "and" ? "and" : "or", parts.map((part, index) =>
        compile(part, node + "." + operator + "[" + index + "]", depth + 1),
      ));
    }
    usesPropertyTable ||= entries.length > 0;
    return combine("and", entries.map(([key, expected], index) => {
      const location = node + ".property[" + index + "]";
      return property(key, location, compileProperty(key, expected, location));
    }));
  }

  const compiled = compile(filter === undefined ? {} : filter, "filter", 0);
  return { ...compiled, usesPropertyTable };
}
