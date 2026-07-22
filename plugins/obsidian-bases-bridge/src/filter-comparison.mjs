export function parseComparisonLiteral(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (raw === "null") return null;
  if (/^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

export function compareFilterValues(left, operator, right) {
  if (left == null || right == null) {
    if (operator === "=" || operator === "==") return left == null && right == null;
    if (operator === "!=") return !(left == null && right == null);
    return false;
  }

  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const leftComparable = bothNumeric ? leftNumber : String(left);
  const rightComparable = bothNumeric ? rightNumber : String(right);

  switch (operator) {
    case "=":
    case "==":
      return leftComparable === rightComparable;
    case "!=":
      return leftComparable !== rightComparable;
    case ">":
      return leftComparable > rightComparable;
    case "<":
      return leftComparable < rightComparable;
    case ">=":
      return leftComparable >= rightComparable;
    case "<=":
      return leftComparable <= rightComparable;
    default:
      return false;
  }
}

export function isTruthyFilterReference(rawValue) {
  const raw = String(rawValue ?? "").trim();
  return (
    /^[\p{L}\p{N}_-]+$/u.test(raw) ||
    /^(?:file|note|formula)\.[\p{L}\p{N}_-]+$/u.test(raw)
  );
}

export function isTruthyFilterValue(value) {
  return (
    value === true ||
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.length > 0) ||
    Boolean(value && typeof value === "object" && Object.keys(value).length > 0)
  );
}
