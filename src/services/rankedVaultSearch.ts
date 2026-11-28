import path from "node:path/posix";
import { CORE_SCHEMA, load } from "js-yaml";
import type { CacheIndexEntry, VaultCacheService } from "./obsidianRestAPI/vaultCache/index.js";
import { smartTextHash } from "./smartEnvV3.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";

const stopWords = new Set((
  "a ai aux au avec ce ces cet cette cela celui comme comment dans de des du elle en est et eux il ils je la le les leur lui mais me moi mon ne nos notre nous on ou par pas pour quand que quel quelle quels quelles qui sa se ses si son sont sur tes ton tu un une vos votre vous " +
  "an and are as at be by can do does for from had has have how i in is it its of on or our that the their them these they this to was were what when where which who will with you your"
).split(" "));

function fold(word: string): string {
  return word.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("œ", "oe").replaceAll("æ", "ae");
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("eaux")) return word.slice(0, -1);
  if (word.length > 4 && /[sx]$/u.test(word) && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function termOf(word: string): string | undefined {
  const folded = fold(word);
  if (folded.length < 2 || stopWords.has(folded)) return undefined;
  return stem(folded);
}

function tokenize(text: string): string[] {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [])
    .map(termOf).filter((term): term is string => term !== undefined);
}

function field(text: string) {
  const terms = new Map<string, number>();
  const words = tokenize(text);
  for (const term of words) terms.set(term, (terms.get(term) ?? 0) + 1);
  return { terms, length: words.length };
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
}

function markdownParts(text: string) {
  const frontmatter = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/mu.exec(text);
  if (frontmatter?.index !== 0) return { body: text, offset: 0, aliases: [], tags: [] };
  let metadata: { aliases?: unknown; alias?: unknown; tags?: unknown; tag?: unknown } | undefined;
  try {
    const parsed = load(frontmatter[1]!, { schema: CORE_SCHEMA });
    if (parsed && typeof parsed === "object") metadata = parsed;
  } catch {
    // A broken metadata block cannot make the Markdown unsearchable.
  }
  return {
    body: text.slice(frontmatter[0].length),
    offset: (frontmatter[0].match(/\n/gu) ?? []).length,
    aliases: [...strings(metadata?.aliases), ...strings(metadata?.alias)],
    tags: [...strings(metadata?.tags), ...strings(metadata?.tag)],
  };
}

function headings(lines: string[]): Array<{ line: number; level: number; title: string }> {
  const result: Array<{ line: number; level: number; title: string }> = [];
  let fence: string | undefined;
  for (const [line, content] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(content);
    if (marker && !fence) {
      fence = marker[1];
      continue;
    }
    if (fence) {
      if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+)/u.exec(content);
    if (heading) result.push({
      line, level: heading[1]!.length, title: heading[2]!.trimEnd().replace(/\s+#+$/u, ""),
    });
  }
  return result;
}

function indexNote(text: string, notePath: string) {
  const { body, aliases, tags } = markdownParts(text);
  const lines = body.split(/\r?\n/u);
  const outline = headings(lines);
  const headingLines = new Set(outline.map(({ line }) => line));
  return {
    title: path.basename(notePath, path.extname(notePath)),
    smartHash: smartTextHash(text),
    bodyLength: body.trim().length,
    tags: new Set([
      ...tags.map((tag) => tag.replace(/^#/u, "")),
      ...(body.match(/(?<![\p{L}\p{N}/])#[\p{L}_][\p{L}\p{N}_/-]*/gu) ?? [])
        .map((tag) => tag.slice(1)),
    ]),
    fields: [
      field(lines.filter((_, line) => !headingLines.has(line)).join("\n")),
      field(path.basename(notePath, path.extname(notePath))),
      field(aliases.join("\n")),
      field(outline.map(({ title }) => title).join("\n")),
    ],
  };
}

type IndexedNote = ReturnType<typeof indexNote>;
export type LexicalDocument = { path: string; entry: CacheIndexEntry; note: IndexedNote };
type LexicalHit = LexicalDocument & { score: number; matchCount: number };
const indexes = new WeakMap<VaultCacheService, Map<string, LexicalDocument>>();

export async function getLexicalDocuments(cache: VaultCacheService | undefined) {
  if (cache && !cache.isReady()) {
    await cache.buildVaultCache();
    await cache.waitUntilReady();
  }
  if (!cache?.isReady()) {
    throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Ranked search requires a ready vault cache.");
  }
  const previous = indexes.get(cache);
  const next = new Map<string, LexicalDocument>();
  for (const entry of cache.getEntriesByPrefix()) {
    if (!entry.path.toLowerCase().endsWith(".md")) continue;
    const notePath = entry.path.replace(/^\//u, "");
    const existing = previous?.get(notePath);
    if (existing?.entry.hash === entry.hash) {
      next.set(notePath, { path: notePath, entry, note: existing.note });
      continue;
    }
    const cached = await cache.getEntry(entry.path);
    if (cached?.hash === entry.hash)
      next.set(notePath, { path: notePath, entry, note: indexNote(cached.content, notePath) });
  }
  indexes.set(cache, next);
  return next;
}

export function queryTerms(query: string): Set<string> {
  return new Set(tokenize(query).slice(0, 64));
}

// BM25F: normalize frequency by each field's length, weight it, then
// apply BM25 saturation and inverse document frequency once per term.
const weights = [1, 3, 3, 2];
const lengthNormalization = [0.75, 0.3, 0.3, 0.5];
const saturation = 1.2;

export function rankLexical(documents: LexicalDocument[], query: Set<string>): LexicalHit[] {
  if (!query.size || !documents.length) return [];
  const totals = weights.map(() => 0);
  const counts = new Map([...query].map((term) => [term, 0]));
  const hits: Array<LexicalDocument & { frequencies: number[][] }> = [];

  for (const doc of documents) {
    doc.note.fields.forEach((field, i) => { totals[i]! += field.length; });
    const frequencies = [...query].map((term) => {
      const byField = doc.note.fields.map((field) => field.terms.get(term) ?? 0);
      if (byField.some(Boolean)) counts.set(term, counts.get(term)! + 1);
      return byField;
    });
    if (frequencies.some((byField) => byField.some(Boolean))) hits.push({ ...doc, frequencies });
  }

  const averages = totals.map((total) => total / documents.length || 1);
  const idf = [...counts.values()].map((count) => Math.log1p((documents.length - count + 0.5) / (count + 0.5)));
  return hits.map(({ frequencies, ...doc }) => {
    let matchCount = 0;
    let score = 0;
    for (const [termIndex, byField] of frequencies.entries()) {
      let frequency = 0;
      for (const [i, raw] of byField.entries()) {
        matchCount += raw;
        const b = lengthNormalization[i]!;
        frequency += raw * weights[i]! / (1 - b + b * doc.note.fields[i]!.length / averages[i]!);
      }
      score += idf[termIndex]! * (saturation + 1) * frequency / (saturation + frequency);
    }
    return { ...doc, matchCount, score };
  }).sort((a, b) => b.score - a.score || comparePaths(a.path, b.path));
}

export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function bestLexicalSection(text: string, query: Set<string>, withSnippet: boolean) {
  const { body, offset } = markdownParts(text);
  const lines = body.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const outline = headings(lines);
  const parents: typeof outline = [];
  const sections = [{ start: 0, end: outline[0]?.line ?? lines.length, headings: [] as string[] }];
  for (const [i, heading] of outline.entries()) {
    while (parents.length && parents.at(-1)!.level >= heading.level) parents.pop();
    parents.push(heading);
    sections.push({
      start: heading.line,
      end: outline[i + 1]?.line ?? lines.length,
      headings: parents.map(({ title }) => title),
    });
  }
  let best = sections.find((section) => section.start < section.end);
  let bestMatches = 0;
  for (const section of sections) {
    const terms = new Set(tokenize(lines.slice(section.start, section.end).join("\n")));
    const matches = [...query].filter((term) => terms.has(term)).length;
    if (matches <= bestMatches) continue;
    best = section;
    bestMatches = matches;
  }
  if (!best || !body.trim()) return undefined;
  return {
    headings: best.headings,
    lines: [offset + best.start + 1, offset + best.end] as [number, number],
    snippet: withSnippet ? lines.slice(best.start, best.end).join("\n").slice(0, 1200) : undefined,
  };
}

export function lexicalSnippets(text: string, query: Set<string>, limit: number, context: number) {
  const snippets = [];
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)) {
    if (!query.has(termOf(match[0]) ?? "")) continue;
    const start = Math.max(0, match.index - context);
    snippets.push({
      context: text.slice(start, match.index + match[0].length + context),
      matchText: match[0],
      position: match.index - start,
    });
    if (snippets.length >= limit) break;
  }
  return snippets;
}
