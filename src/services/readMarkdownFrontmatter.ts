import { CORE_SCHEMA, load } from "js-yaml";

/** Read cached Markdown properties with the scalar types exposed by Local REST. */
export function readMarkdownFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^\uFEFF?---\r?\n((?:[^\n]*\n)*?)---(?:\r?\n|$)/u.exec(content);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const body = content.slice(match[0].length);
  try {
    // CORE_SCHEMA keeps plain dates and datetimes as written, including offsets.
    const parsed: unknown = load(match[1], { schema: CORE_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Keep the body readable when a note has invalid YAML.
  }
  return { frontmatter: {}, body };
}
