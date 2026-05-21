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
  return ignore().add(patterns);
}

export function isVaultPathExcluded(
  filePath: string,
  matcher: ReturnType<typeof ignore>,
): boolean {
  const normalized = normalizeVaultRelativePath(filePath);
  return normalized.length > 0 && matcher.ignores(normalized);
}
