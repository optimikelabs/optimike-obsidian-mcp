/**
 * Model-free reproduction of Claude Code's keyword ToolSearch ranking.
 *
 * Mirrors the scorer shipped in Claude Code 2.1.331 for deferred MCP tools, so
 * a tools/list surface (descriptions and `_meta["anthropic/searchHint"]`) can
 * be ranked without a model. The real client stays the evidence:
 * scripts/run-tool-discovery-eval.mjs replays every real ToolSearch query
 * through this function and reports where the two disagree.
 *
 * Per lowercased query word (whitespace split, first 32 words, no stopwords):
 *   name part equal +12, else contained in a part +6
 *     (parts: server name and tool name split on whitespace, `_` and `.`)
 *   whole server or tool name equal +12, else contained +4
 *   word inside the joined parts while the running score is still 0: +3
 *   whole word in the search hint (first 4096 chars) +4
 *   whole word in the description (first 4096 chars) +2
 * Tools scoring 0 are dropped. The client's deferred-tool list is sorted by
 * name and its sort is stable, so ties come out in name order. Top 5 by default.
 *
 * Several servers: give each tool its own `server` (the client's server key)
 * and `bareName`; ties then sort by the full `mcp__<server>__<tool>` name.
 */

export const CLAUDE_CODE_SEARCH_VERSION = "2.1.331";
const MAX_QUERY_WORDS = 32;
const MAX_TEXT_CHARACTERS = 4096;
const SEARCH_HINT_KEY = "anthropic/searchHint";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parsedName(serverName, toolName) {
  const coarseParts = [serverName, toolName].filter(Boolean).map((part) => part.toLowerCase());
  const parts = coarseParts.flatMap((part) => part.split(/[\s_.]+/u)).filter(Boolean);
  return { parts, coarseParts, full: parts.join(" ") };
}

export function searchHintOf(tool) {
  const hint = tool._meta?.[SEARCH_HINT_KEY];
  return typeof hint === "string" ? hint : undefined;
}

/**
 * Ranks tools the way Claude Code ToolSearch does for a keyword query.
 * `select:` queries and exact-name queries are out of scope (they bypass
 * scoring in the client too).
 */
export function rankToolsClaudeCode(tools, query, { serverName, maxResults = 5 } = {}) {
  const words = String(query).trim().split(/\s+/u);
  const truncated = words.length <= MAX_QUERY_WORDS ? query : words.slice(0, MAX_QUERY_WORDS).join(" ");
  const terms = truncated.trim().toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
  const required = [];
  const optional = [];
  for (const term of terms) {
    if (term.startsWith("+") && term.length > 1) required.push(term.slice(1));
    else optional.push(term);
  }
  const scoredTerms = required.length > 0 ? [...required, ...optional] : terms;
  const patterns = new Map(scoredTerms.map((term) => [term, new RegExp(`\\b${escapeRegExp(term)}\\b`, "u")]));
  const sortKey = (tool) => (tool.server ? `mcp__${tool.server}__${tool.bareName ?? tool.name}` : tool.name);
  const ordered = [...tools].sort((left, right) =>
    sortKey(left) < sortKey(right) ? -1 : sortKey(left) > sortKey(right) ? 1 : 0,
  );
  const documents = ordered.map((tool) => ({
    name: tool.name,
    parsed: parsedName(tool.server ?? serverName, tool.bareName ?? tool.name),
    description: (tool.description ?? "").slice(0, MAX_TEXT_CHARACTERS).toLowerCase(),
    hint: (searchHintOf(tool) ?? "").slice(0, MAX_TEXT_CHARACTERS).toLowerCase(),
  }));
  const matchesTerm = (doc, term) =>
    doc.parsed.parts.some((part) => part.includes(term)) ||
    doc.parsed.coarseParts.some((part) => part.includes(term)) ||
    (doc.description.includes(term) && patterns.get(term).test(doc.description)) ||
    (doc.hint !== "" && patterns.get(term).test(doc.hint));
  const candidates =
    required.length > 0
      ? documents.filter((doc) => required.every((term) => matchesTerm(doc, term)))
      : documents;
  return candidates
    .map((doc) => {
      let score = 0;
      for (const term of scoredTerms) {
        const pattern = patterns.get(term);
        const { parts, coarseParts, full } = doc.parsed;
        if (parts.includes(term)) score += 12;
        else if (parts.some((part) => part.includes(term))) score += 6;
        if (coarseParts.includes(term)) score += 12;
        else if (coarseParts.some((part) => part.includes(term))) score += 4;
        if (full.includes(term) && score === 0) score += 3;
        if (doc.hint && pattern.test(doc.hint)) score += 4;
        if (doc.description.includes(term) && pattern.test(doc.description)) score += 2;
      }
      return { name: doc.name, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults);
}
