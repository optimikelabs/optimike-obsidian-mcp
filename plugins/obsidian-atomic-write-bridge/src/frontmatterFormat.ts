export class InvalidFrontmatter extends Error {
  constructor() { super("invalid_frontmatter"); }
}

/** Read-only adapter to Obsidian's own YAML serializer and property registry. */
export function inspectFrontmatterFormat(
  yaml: string,
  parse: (input: string) => unknown,
  stringify: (value: unknown) => string,
  types: { getAssignedWidget(key: string): string | null },
) {
  let value: unknown;
  try { value = yaml.trim() === "" ? {} : parse(yaml); }
  catch { throw new InvalidFrontmatter(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidFrontmatter();
  }
  const warnings: Array<{ key: string; reason: "untyped" | "type_mismatch" | "unknown_widget" | "empty_value"; declaredType?: string; actualType?: string }> = [];
  const known = new Set(["text", "multitext", "number", "checkbox", "date", "datetime"]);
  for (const [key, item] of Object.entries(value)) {
    const declaredType = types.getAssignedWidget(key);
    if (!declaredType) {
      warnings.push({ key, reason: "untyped" });
      continue;
    }
    if (!known.has(declaredType)) {
      warnings.push({ key, reason: "unknown_widget", declaredType });
      continue;
    }
    if (item == null || item === "" || (Array.isArray(item) && item.length === 0)) {
      warnings.push({ key, reason: "empty_value", declaredType });
      continue;
    }
    const actualType = Array.isArray(item) ? "multitext" : typeof item === "string" ? "text" :
      typeof item === "number" ? "number" : typeof item === "boolean" ? "checkbox" : "other";
    const dateValid = (kind: string, text: unknown) => {
      if (typeof text !== "string") return false;
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
      if (!match || (kind === "date" ? !!match[4] : !match[4])) return false;
      const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
      const d = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
      return d.getUTCFullYear() === +year && d.getUTCMonth() === +month - 1 && d.getUTCDate() === +day &&
        d.getUTCHours() === +hour && d.getUTCMinutes() === +minute && d.getUTCSeconds() === +second;
    };
    const matches = declaredType === "date" || declaredType === "datetime" ? dateValid(declaredType, item) :
      declaredType === "multitext" ? Array.isArray(item) && item.every(part => typeof part === "string") : declaredType === actualType;
    if (!matches) warnings.push({ key, reason: "type_mismatch", declaredType, actualType });
  }
  return { canonicalYaml: stringify(value), warnings };
}
