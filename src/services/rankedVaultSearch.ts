import path from "node:path/posix";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
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

function headings(lines: string[], codeLines?: Set<number>): Array<{ line: number; level: number; title: string }> {
  const result: Array<{ line: number; level: number; title: string }> = [];
  let fence: string | undefined;
  for (const [line, content] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(content);
    if (marker && !fence) {
      codeLines?.add(line);
      fence = marker[1];
      continue;
    }
    if (fence) {
      codeLines?.add(line);
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

function proseLength(lines: string[], codeLines: Set<number>): number {
  return lines.filter((_, i) => !codeLines.has(i))
    .join("\n")
    .replace(/\x60+[^\x60\n]*\x60+/gu, "")
    .replace(/!?\[\[([^\]\n]+)\]\]/gu, (_markup, label: string) => label.split("|").at(-1)!)
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/gu, "$1")
    .replace(/<https?:[^>\n]+>|https?:\/\/[^\s<>]+/gu, "")
    .trim().length;
}

function indexNote(text: string, notePath: string) {
  const { body, aliases, tags } = markdownParts(text);
  const lines = body.split(/\r?\n/u);
  const codeLines = new Set<number>();
  const outline = headings(lines, codeLines);
  const headingLines = new Set(outline.map(({ line }) => line));
  const title = path.basename(notePath, path.extname(notePath));
  return {
    metadata: {
      title,
      smartHash: smartTextHash(text),
      bodyLength: proseLength(lines, codeLines),
      tags: new Set([
        ...tags.map((tag) => tag.replace(/^#/u, "")),
        ...(body.match(/(?<![\p{L}\p{N}/])#[\p{L}_][\p{L}\p{N}_/-]*/gu) ?? [])
          .map((tag) => tag.slice(1)),
      ]),
    },
    fields: [
      lines.filter((_, line) => !headingLines.has(line)).join("\n"),
      title,
      aliases.join("\n"),
      outline.map(({ title: heading }) => heading).join("\n"),
    ],
  };
}

type IndexedNote = ReturnType<typeof indexNote>["metadata"];
export type LexicalDocument = { path: string; entry: CacheIndexEntry; note: IndexedNote };
type LexicalHit = LexicalDocument & { score: number; matchCount: number };

// Each term's postings are consecutive (document ID, term frequency) pairs.
// The offsets and all pairs for a field share two typed arrays.
type PostingField = { terms: Map<string, number>; offsets: Uint32Array; pairs: Uint32Array };
type Shard = { documents: LexicalDocument[]; lengths: Uint32Array; fields: PostingField[] };
export type LexicalIndex = { documents: Map<string, LexicalDocument>; shards: Shard[] };
type IndexState = { current?: LexicalIndex; pending?: Promise<LexicalIndex> };
const indexes = new WeakMap<VaultCacheService, IndexState>();
const shardCount = 32;
const fieldCount = 4;

function packPostings(postings: Map<string, number[]>): PostingField {
  const terms = new Map<string, number>();
  const offsets = new Uint32Array(postings.size + 1);
  let length = 0;
  for (const [term, pairs] of postings) {
    offsets[terms.size] = length;
    terms.set(term, terms.size);
    length += pairs.length;
  }
  offsets[terms.size] = length;
  const pairs = new Uint32Array(length);
  for (const [term, rows] of postings) pairs.set(rows, offsets[terms.get(term)!]!);
  return { terms, offsets, pairs };
}

async function buildShard(
  cache: VaultCacheService,
  entries: CacheIndexEntry[],
  previous: Shard | undefined,
  normalizedTerms: Map<string, string | undefined>,
): Promise<Shard> {
  if (previous?.documents.length === entries.length && entries.every((entry, i) => {
    const prev = previous.documents[i]!.entry;
    return entry.path === prev.path && entry.hash === prev.hash && entry.mtime === prev.mtime && entry.ctime === prev.ctime;
  })) return previous;

  const documents: LexicalDocument[] = [];
  const lengths = new Uint32Array(entries.length * fieldCount);
  const postings = Array.from({ length: fieldCount }, () => new Map<string, number[]>());
  for (const [i, entry] of entries.entries()) {
    if (i % 32 === 0) await yieldToEventLoop();
    const cached = await cache.getEntry(entry.path);
    if (cached?.hash !== entry.hash) continue;
    const notePath = entry.path.replace(/^\//u, "");
    const { metadata, fields } = indexNote(cached.content, notePath);
    const id = documents.length;
    documents.push({ path: notePath, entry, note: metadata });
    fields.forEach((content, field) => {
      const terms = new Map<string, number>();
      for (const raw of content.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []) {
        let term = normalizedTerms.get(raw);
        if (term === undefined && !normalizedTerms.has(raw)) {
          term = termOf(raw);
          if (normalizedTerms.size < 32768) normalizedTerms.set(raw, term);
        }
        if (term === undefined) continue;
        lengths[id * fieldCount + field]!++;
        terms.set(term, (terms.get(term) ?? 0) + 1);
      }
      for (const [term, count] of terms) {
        const rows = postings[field]!.get(term);
        if (rows) rows.push(id, count);
        else postings[field]!.set(term, [id, count]);
      }
    });
  }
  return { documents, lengths, fields: postings.map(packPostings) };
}

async function refreshIndex(cache: VaultCacheService, previous?: LexicalIndex): Promise<LexicalIndex> {
  if (!cache.isReady()) {
    await cache.buildVaultCache();
    await cache.waitUntilReady();
  }
  if (!cache.isReady()) {
    throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Ranked search requires a ready vault cache.");
  }
  const groups: CacheIndexEntry[][] = Array.from({ length: shardCount }, () => []);
  for (const entry of cache.getEntriesByPrefix()) {
    if (entry.path.toLowerCase().endsWith(".md")) {
      const shard = Number.parseInt(smartTextHash(entry.path), 36) % shardCount;
      groups[shard]!.push(entry);
    }
  }
  const normalizedTerms = new Map<string, string | undefined>();
  const shards: Shard[] = [];
  for (const [i, entries] of groups.entries()) {
    shards.push(await buildShard(cache, entries, previous?.shards[i], normalizedTerms));
  }
  if (previous && shards.every((shard, i) => shard === previous.shards[i])) return previous;
  const documents = new Map<string, LexicalDocument>();
  for (const shard of shards) for (const doc of shard.documents) documents.set(doc.path, doc);
  return { documents, shards };
}

export function getLexicalIndex(cache: VaultCacheService | undefined): Promise<LexicalIndex> {
  if (!cache) {
    return Promise.reject(new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Ranked search requires a ready vault cache."));
  }
  let state = indexes.get(cache);
  if (!state) {
    state = {};
    indexes.set(cache, state);
  }
  const indexState = state;
  return indexState.pending ??= refreshIndex(cache, indexState.current)
    .then((index) => indexState.current = index)
    .finally(() => { indexState.pending = undefined; });
}

export function queryTerms(query: string): Set<string> {
  return new Set(tokenize(query).slice(0, 64));
}

// BM25F: normalize frequency by each field's length, weight it, then
// apply BM25 saturation and inverse document frequency once per term.
const weights = [1, 3, 3, 2];
const lengthNormalization = [0.75, 0.3, 0.3, 0.5];
const saturation = 1.2;

export function rankLexical(
  index: LexicalIndex,
  query: Set<string>,
  eligible?: (doc: LexicalDocument) => boolean,
): LexicalHit[] {
  if (!query.size || !index.documents.size) return [];
  const documents: LexicalDocument[] = [];
  const allowed = new Uint8Array(index.documents.size);
  const totals = weights.map(() => 0);
  let count = 0;
  const shards = index.shards.map((shard) => {
    const offset = documents.length;
    for (const [id, doc] of shard.documents.entries()) {
      documents.push(doc);
      if (eligible && !eligible(doc)) continue;
      allowed[offset + id] = 1;
      count++;
      for (let field = 0; field < fieldCount; field++) totals[field]! += shard.lengths[id * fieldCount + field]!;
    }
    return { ...shard, offset };
  });
  if (!count) return [];

  const averages = totals.map((total) => total / count || 1);
  const scores = new Float64Array(documents.length);
  const matchCounts = new Uint32Array(documents.length);
  const frequencies = new Float64Array(documents.length);
  for (const term of query) {
    const touched: number[] = [];
    for (const { fields, lengths, offset } of shards) {
      for (const [field, { terms, offsets, pairs }] of fields.entries()) {
        const termId = terms.get(term);
        if (termId === undefined) continue;
        const b = lengthNormalization[field]!;
        for (let row = offsets[termId]!; row < offsets[termId + 1]!; row += 2) {
          const id = pairs[row]!;
          const docId = offset + id;
          if (!allowed[docId]) continue;
          if (!frequencies[docId]) touched.push(docId);
          const raw = pairs[row + 1]!;
          matchCounts[docId]! += raw;
          frequencies[docId]! += raw * weights[field]! / (1 - b + b * lengths[id * fieldCount + field]! / averages[field]!);
        }
      }
    }
    const idf = Math.log1p((count - touched.length + 0.5) / (touched.length + 0.5));
    for (const id of touched) {
      const frequency = frequencies[id]!;
      scores[id]! += idf * (saturation + 1) * frequency / (saturation + frequency);
      frequencies[id] = 0;
    }
  }
  const hits: LexicalHit[] = [];
  for (const [id, doc] of documents.entries()) {
    if (matchCounts[id]) hits.push({ ...doc, matchCount: matchCounts[id]!, score: scores[id]! });
  }
  return hits.sort((a, b) => b.score - a.score || comparePaths(a.path, b.path));
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
