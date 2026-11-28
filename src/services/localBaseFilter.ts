const FILE_PROPERTIES = new Set([
  "file.path", "file.name", "file.ctime", "file.mtime", "file.size",
]);

export function isLocalBaseProperty(key: string): boolean {
  return Boolean(key.trim()) && !key.startsWith("note.") &&
    (!key.startsWith("file.") || FILE_PROPERTIES.has(key));
}
