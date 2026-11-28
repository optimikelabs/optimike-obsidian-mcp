/**
 * @module ObsidianApiUtils
 * @description
 * Internal utilities for the Obsidian REST API service.
 */

export function normalizeVaultSlashes(filePath: string): string {
  return filePath.replace(/[\\/]+/gu, "/").replace(/^\/|\/$/gu, "");
}

/**
 * Matches Obsidian's vault path spelling for read lookups, without
 * interpreting dot segments or validating a new write target.
 */
export function toVaultPath(filePath: string): string {
  return normalizeVaultSlashes(filePath)
    .replace(/[\u00a0\u202f]/gu, " ")
    .normalize("NFC");
}

/**
 * Encodes a vault-relative file path correctly for API URLs.
 * Ensures path separators '/' are not encoded, but individual components are.
 * Handles leading slashes correctly.
 *
 * @param filePath - The raw vault-relative file path (e.g., "/Notes/My File.md" or "Notes/My File.md").
 * @returns The URL-encoded path suitable for appending to `/vault`.
 */
export function encodeVaultPath(
  filePath: string,
  pathEncoding?: "literal",
): string {
  // Legacy callers trim input, while read aliases preserve filename whitespace.
  const trimmedPath = (pathEncoding === "literal" ? filePath : filePath.trim())
    .replace(/^\/+|\/+$/g, "");

  // 2. If the original path was just '/' or empty, return an empty string (represents root for files).
  if (trimmedPath === "") {
    // For file operations, the API expects /vault/filename.md at the root,
    // so an empty encoded path segment is correct here.
    // For listFiles, we handle the root case separately.
    return "";
  }

  // 3. Split into components, encode each component, then rejoin with literal '/'.
  const encodedComponents = trimmedPath.split("/").map(encodeURIComponent);
  const encodedPath = encodedComponents.join("/");

  // 4. Prepend the leading slash.
  return `/${encodedPath}`;
}
