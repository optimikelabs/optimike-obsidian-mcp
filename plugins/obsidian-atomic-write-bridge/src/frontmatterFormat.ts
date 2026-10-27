/** Read-only adapter to Obsidian's own YAML serializer and property registry. */
export function inspectFrontmatterFormat(
  yaml: string,
  parse: (input: string) => unknown,
  stringify: (value: unknown) => string,
  types: { getAssignedWidget(key: string): string | null },
) {
  const value = parse(yaml);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_frontmatter");
  }
  const warnings: Array<{ key: string; reason: "untyped" | "type_mismatch"; declaredType?: string; actualType?: string }> = [];
  for (const [key, item] of Object.entries(value)) {
    const declaredType = types.getAssignedWidget(key);
    if (!declaredType) {
      warnings.push({ key, reason: "untyped" });
      continue;
    }
    if (item == null) continue;
    const actualType = Array.isArray(item) ? "multitext" : typeof item === "string" ? "text" :
      typeof item === "number" ? "number" : typeof item === "boolean" ? "checkbox" : "other";
    // Date and datetime widgets store strings. Do not report those as text mismatches.
    if ((declaredType === "date" || declaredType === "datetime") && actualType === "text") continue;
    if (declaredType !== actualType) warnings.push({ key, reason: "type_mismatch", declaredType, actualType });
  }
  return { canonicalYaml: stringify(value), warnings };
}
