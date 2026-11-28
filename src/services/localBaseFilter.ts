type ReadProperty = (key: string) => unknown;
type Predicate = (read: ReadProperty) => boolean;
type Scalar = string | number | boolean | null;

const FILE_PROPERTIES = new Set([
  "file.path", "file.name", "file.ctime", "file.mtime", "file.size",
]);
const FILTER_OPERATORS = new Set([
  "eq", "ne", "in", "contains", "gt", "gte", "lt", "lte",
]);
const REFERENCE = /^(?:(?:file|formula)\.)?[\p{L}\p{N}_-]+$/u;
const COMPARISON = /^([^=<>!\s]+)\s*(==|!=|>=|<=|=|>|<)\s*(.+)$/u;
const LITERAL = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?|[\p{L}\p{N}_-]+)$/u;
const MAX_DEPTH = 32;
const MAX_STATEMENT_LENGTH = 1024;

export function isLocalBaseProperty(key: string): boolean {
  return Boolean(key.trim()) && !key.startsWith("note.") &&
    (!key.startsWith("file.") || FILE_PROPERTIES.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean";
}

// Query operands and cached paths may pick up a leading slash. Filter on
// vault-relative paths without changing the path returned in the result.
function filterPropertyValue(key: string, value: unknown): unknown {
  return key === "file.path" && typeof value === "string"
    ? value.replace(/^\/+/u, "")
    : value;
}

function scalarMatches(actual: unknown, expected: unknown): boolean {
  return Array.isArray(actual)
    ? actual.some((item) => String(item) === String(expected))
    : actual === expected;
}

function compilePropertyCondition(key: string, expected: unknown): ((actual: unknown) => boolean) | undefined {
  const equals = (actual: unknown, operand: unknown) =>
    scalarMatches(actual, filterPropertyValue(key, operand));
  if (isScalar(expected)) return (actual) => equals(actual, expected);
  if (Array.isArray(expected) && expected.every(isScalar)) {
    return (actual) => expected.some((item) => equals(actual, item));
  }
  if (!isRecord(expected)) return undefined;
  const operators = Object.entries(expected);
  if (!operators.length || operators.some(([operator, value]) =>
    !FILTER_OPERATORS.has(operator) ||
    (operator === "in" ? !Array.isArray(value) || !value.every(isScalar) : !isScalar(value))
  )) return undefined;
  return (actual) => operators.every(([operator, value]) => {
    if (operator === "in") return (value as Scalar[]).some((item) => equals(actual, item));
    const scalar = filterPropertyValue(key, value);
    switch (operator) {
      case "eq": return equals(actual, value);
      case "ne": return !equals(actual, value);
      case "contains": return String(actual ?? "").includes(String(value));
      case "gt": return Number(actual) > Number(scalar);
      case "gte": return Number(actual) >= Number(scalar);
      case "lt": return Number(actual) < Number(scalar);
      case "lte": return Number(actual) <= Number(scalar);
      default: return false;
    }
  });
}

function splitOutsideQuotes(statement: string, token: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];
    if ((char === "'" || char === '"') && statement[i - 1] !== "\\") {
      if (quote === char) quote = undefined;
      else if (!quote) quote = char;
    }
    if (!quote && statement.startsWith(token, i)) {
      parts.push(statement.slice(start, i).trim());
      i += token.length - 1;
      start = i + 1;
    }
  }
  parts.push(statement.slice(start).trim());
  return parts;
}

function parseLiteral(raw: string): Scalar {
  if (raw === "null") return null;
  if (/^(true|false)$/iu.test(raw)) return /^true$/iu.test(raw);
  if (/^-?\d+(?:\.\d+)?$/u.test(raw)) return Number(raw);
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
}

// Match the Bridge's null, numeric coercion, and string comparison semantics
// for expression leaves. Legacy JSON operators retain their own comparisons.
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

export function compileLocalBaseFilter(filter: Record<string, unknown> | undefined):
  { matches: Predicate; usesFormula: boolean } | undefined {
  let usesFormula = false;

  function trackProperty(key: string): boolean {
    if (key.startsWith("formula.")) usesFormula = true;
    return isLocalBaseProperty(key);
  }

  function compileStatement(raw: string, depth: number): Predicate | undefined {
    if (raw.length > MAX_STATEMENT_LENGTH) return undefined;
    const statement = raw.trim();
    for (const [token, group] of [[" or ", "or"], ["||", "or"], [" and ", "and"], ["&&", "and"]] as const) {
      const parts = splitOutsideQuotes(statement, token);
      if (parts.length > 1) return compileGroup(group, parts, depth);
    }
    if (statement.startsWith("not ") || statement.startsWith("!")) {
      const inner = compile(statement.slice(statement.startsWith("!") ? 1 : 4), depth + 1);
      return inner && ((read) => !inner(read));
    }
    const comparison = COMPARISON.exec(statement);
    if (comparison) {
      const key = comparison[1].trim();
      const operator = comparison[2];
      const rawLiteral = comparison[3].trim();
      if (!REFERENCE.test(key) || !trackProperty(key) || !LITERAL.test(rawLiteral)) return undefined;
      const right = filterPropertyValue(key, parseLiteral(rawLiteral));
      return (read) => compare(read(key), operator, right);
    }
    if (!REFERENCE.test(statement) || !trackProperty(statement)) return undefined;
    return (read) => isTruthy(read(statement));
  }

  function compileGroup(group: "and" | "or", parts: unknown[], depth: number): Predicate | undefined {
    const children: Predicate[] = [];
    for (const part of parts) {
      const child = compile(part, depth + 1);
      if (!child) return undefined;
      children.push(child);
    }
    return group === "and"
      ? (read) => children.every((child) => child(read))
      : (read) => children.some((child) => child(read));
  }

  function compile(value: unknown, depth: number): Predicate | undefined {
    if (depth > MAX_DEPTH) return undefined;
    if (typeof value === "string") return compileStatement(value, depth);
    if (!isRecord(value)) return undefined;
    const entries = Object.entries(value);
    if (entries.length === 0 && depth !== 0) return undefined;
    const group = entries.find(([key]) => key === "and" || key === "or" || key === "not");
    if (group) {
      if (entries.length !== 1) return undefined;
      const [operator, parts] = group;
      if (operator === "not") {
        const child = compile(parts, depth + 1);
        return child && ((read) => !child(read));
      }
      return Array.isArray(parts) ? compileGroup(operator === "and" ? "and" : "or", parts, depth) : undefined;
    }
    const conditions: Predicate[] = [];
    for (const [key, expected] of entries) {
      if (!trackProperty(key)) return undefined;
      const condition = compilePropertyCondition(key, expected);
      if (!condition) return undefined;
      conditions.push((read) => condition(read(key)));
    }
    return (read) => conditions.every((condition) => condition(read));
  }

  const matches = compile(filter ?? {}, 0);
  return matches && {
    matches: (read) => matches((key) => filterPropertyValue(key, read(key))),
    usesFormula,
  };
}
