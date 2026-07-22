export function normalizeLinkish(value) {
  let normalized = String(value ?? "").trim();
  const wikiLink = normalized.match(/^\[\[(.*)\]\]$/);
  if (wikiLink) normalized = wikiLink[1];
  normalized = normalized.split("|")[0] ?? normalized;
  normalized = normalized.split("#")[0] ?? normalized;
  normalized = normalized.replace(/\.md$/i, "");
  return normalized.trim();
}
