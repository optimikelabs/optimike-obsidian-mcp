import ignore from "ignore";

export const DEFAULT_VAULT_EXCLUDE_PATTERNS = [
  ".obsidian/**",
  ".trash/**",
  ".git/**",
  ".tmp/**",
  "tmp/**",
  "node_modules/**",
  "**/.obsidian/**",
  "**/.trash/**",
  "**/.git/**",
  "**/.tmp/**",
  "**/tmp/**",
  "**/node_modules/**",
  "**/screenshots/**",
  "**/*screenshots*/**",
  "**/coverage/**",
  "**/dist/**",
  "**/build/**",
  "**/.cache/**",
  "**/__pycache__/**",
  "**/*.sqlite",
  "**/*.sqlite-*",
  "**/*.db",
  "**/*.log",
];

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/gu, "/").replace(/^\/+/u, "");
}

export function parseVaultExcludePatterns(value?: string): string[] {
  const explicit = (value ?? "")
    .split(/[\n,]/u)
    .map(normalizePattern)
    .filter(Boolean);
  return [...DEFAULT_VAULT_EXCLUDE_PATTERNS, ...explicit];
}

export function normalizeVaultRelativePath(filePath: string): string {
  return filePath.replace(/\\/gu, "/").replace(/^\/+/u, "");
}

export function createVaultExclusionMatcher(patterns: string[]) {
  return {
    rules: ignore().add(patterns),
    hasReinclusions: patterns.some((pattern) => pattern.startsWith("!")),
  };
}

export function isVaultPathExcluded(
  filePath: string,
  matcher: ReturnType<typeof createVaultExclusionMatcher>,
  isDirectory = false,
): boolean {
  const normalized = normalizeVaultRelativePath(filePath);
  if (!normalized) return false;

  const match = matcher.rules.test(normalized);
  if (match.ignored || match.unignored) return match.ignored;

  // A negation may name a descendant without naming its parent. In that case
  // leave directory traversal open and apply the default to each file instead.
  if (isDirectory && matcher.hasReinclusions) return false;

  const segments = normalized.split("/");
  return segments.some((segment, index) => {
    if (!segment.startsWith(".")) return false;
    if (!matcher.hasReinclusions || index === segments.length - 1) return true;
    const directory = segments.slice(0, index + 1).join("/") + "/";
    return !matcher.rules.test(directory).unignored;
  });
}
