import { beginsBlockComment, extractMarkdownLinkReferences, markdownHtmlSpans, type MarkdownLinkReference } from "./markdownLinkReferences.js";
import type { LinkSourceLimitReason } from "../../headlessLinkCoverage.js";

export type LinkExtractionOptions = {
  largeNoteBytes: number;
  sectionBytes: number;
  maxReferences: number;
  batchBytes: number;
  parseTimeoutMs?: number;
};

export const LARGE_LINK_SOURCE_BYTES = 256 * 1024;

export const defaultLinkExtraction: LinkExtractionOptions = {
  largeNoteBytes: LARGE_LINK_SOURCE_BYTES,
  sectionBytes: 64 * 1024,
  maxReferences: 8192,
  batchBytes: 256 * 1024,
  parseTimeoutMs: 10_000,
};

type Boundary = { offset: number; bytes: number; line: number; listPrefix?: string };
type Region = { start: Boundary; end: Boundary; omit?: boolean };
type LinkSection = { start: Boundary; end: Boundary; safe: boolean };
export type BoundedLinkExtraction = { references: MarkdownLinkReference[] } & (
  { complete: true; limitReason?: never } | { complete: false; limitReason: LinkSourceLimitReason }
);

const fenceLine = /^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u;
const rawHtml = [
  [/^[ \t>]*<pre(?=[ \t>])/iu, /<\/pre[ \t]*>/iu],
  [/^[ \t>]*<script(?=[ \t>])/iu, /<\/script[ \t]*>/iu],
  [/^[ \t>]*<style(?=[ \t>])/iu, /<\/style[ \t]*>/iu],
  [/^[ \t>]*<textarea(?=[ \t>])/iu, /<\/textarea[ \t]*>/iu],
  [/^[ \t>]*<!--/u, /-->/u],
  [/^[ \t>]*<!\[CDATA\[/u, /\]\]>/u],
  [/^[ \t>]*<\?/u, /\?>/u],
] as const;
const startsContainer = /^(?:\s|>|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/u;
const startOfSource: Boundary = { offset: 0, bytes: 0, line: 0 };

function* lines(content: string) {
  let start = startOfSource;
  for (const match of content.matchAll(/\r\n?|\n|$/gu)) {
    if (match.index === content.length && match[0] === "" && start.offset === content.length) break;
    const text = content.slice(start.offset, match.index);
    const end = {
      offset: match.index + match[0].length,
      bytes: start.bytes + Buffer.byteLength(text) + match[0].length,
      line: start.line + Number(!!match[0]),
    };
    yield { start, end, text };
    start = end;
  }
}

function escapedAt(text: string, offset: number): boolean {
  let slash = offset;
  while (text[slash - 1] === "\\") slash--;
  return (offset - slash) % 2 === 1;
}

/** Backtick runs pair only at equal widths. Work backwards to find the next
 * run in linear time even when a note has many unmatched tick widths. */
function* inlineCode(content: string, hardLimit: number) {
  const paired = function* (start: number, end: number) {
    const text = content.slice(start, end);
    if (!text.includes("`") || !/%%|\$/u.test(text)) return;
    const runs = Array.from(text.matchAll(/`+/gu));
    const byWidth = new Map<number, number>();
    const next = runs.map(() => -1);
    for (let i = runs.length - 1; i >= 0; i--) {
      const width = runs[i][0].length;
      next[i] = byWidth.get(width) ?? -1;
      byWidth.set(width, i);
    }
    for (let i = 0; i < runs.length; i++) {
      const close = next[i];
      const offset = runs[i].index;
      if (close === -1 || escapedAt(text, offset)) continue;
      yield [start + offset, start + runs[close].index + runs[close][0].length] as const;
      i = close;
    }
  };
  let start = 0;
  let end = 0;
  for (const line of lines(content)) {
    end = line.end.offset;
    const fence = fenceLine.test(line.text);
    if (line.start.offset - start >= hardLimit || /^\s*$/u.test(line.text) || fence) {
      yield* paired(start, line.start.offset);
      start = fence ? end : line.start.offset;
    }
  }
  yield* paired(start, end);
}

/** Protection for cut selection only. The full parser still decides which
 * links are visible. */
function* boundaryTokens(line: string) {
  const delimiters = /%%|\$+/gu;
  if (!/%{2}|\$/u.test(line)) return;
  const literals = Array.from(line.matchAll(
    /!?\[\[[^\[\]\r\n]*\]\]|\]\((?:\\.|[^)\\\r\n])*\)|<?(?:https?:\/\/|www\.)[^\s<>]+>?|<[^<>\r\n]*>/giu,
  ));
  let cursor = 0;
  for (const match of line.matchAll(delimiters)) {
    const offset = match.index;
    while (literals[cursor] && literals[cursor].index + literals[cursor][0].length <= offset) cursor++;
    const literal = literals[cursor];
    const inLiteral = !!literal && literal.index <= offset;
    const token = match[0];
    if (token === "%%") {
      if (line[offset - 1] !== "\\") yield { token, offset, inLiteral };
    } else if (!inLiteral && token.length <= 2) {
      if (!escapedAt(line, offset)) yield { token, offset };
    }
  }
}

/** Ask the same Markdown parser about HTML in paragraphs containing a
 * comment delimiter. Avoid parsing the entire note just to classify HTML. */
function* htmlSpans(content: string, budget: number) {
  let start = startOfSource;
  let end = start;
  function* spans() {
    if (end.bytes - start.bytes > budget) return;
    const paragraph = content.slice(start.offset, end.offset);
    if (!paragraph.includes("<") || !paragraph.includes("%%")) return;
    for (const span of markdownHtmlSpans(paragraph)) {
      yield { start: start.offset + span.start, end: start.offset + span.end };
    }
  }
  for (const line of lines(content)) {
    if (/^[ \t]*$/u.test(line.text)) {
      yield* spans();
      start = line.end;
    }
    end = line.end;
  }
  yield* spans();
}

function protectedRegions(content: string, hardLimit: number) {
  const regions: Region[] = [];
  const hasDelimiters = content.includes("%%") || content.includes("$");
  const code = inlineCode(content, hardLimit);
  const htmlTokens = htmlSpans(content, hardLimit);
  let inline = hasDelimiters && content.includes("`") ? code.next().value : undefined;
  let htmlToken = content.includes("%%") && content.includes("<") ? htmlTokens.next().value : undefined;
  let previousBlank = true;
  let fence: { start: Boundary; marker: string; topLevel: boolean } | undefined;
  let html: { start: Boundary; close: RegExp } | undefined;
  let frontmatter = /^\uFEFF?---(?:\r\n?|\n)/u.test(content);
  let comment: { start: Boundary; offset: number } | undefined;
  let formula: { start: Boundary; width: number } | undefined;
  let last = startOfSource;
  for (const { start, end, text } of lines(content)) {
    const afterBlank = previousBlank;
    previousBlank = /^[ \t]*$/u.test(text);
    last = end;
    if (frontmatter) {
      if (start.offset > 0 && text === "---") {
        regions.push({ start: startOfSource, end });
        frontmatter = false;
      }
      continue;
    }
    if (html) {
      if (html.close.test(text)) {
        regions.push({ start: html.start, end });
        html = undefined;
      }
      continue;
    }
    const marker = fenceLine.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        const omit = fence.topLevel && !startsContainer.test(text) && end.bytes - fence.start.bytes > hardLimit;
        regions.push({ start: fence.start, end, omit });
        fence = undefined;
      }
      continue;
    }
    if (!comment) {
      if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
        fence = { start, marker: marker[1], topLevel: afterBlank && text.startsWith(marker[1]) };
        continue;
      }
      const raw = rawHtml.find(([opens]) => opens.test(text));
      if (raw) {
        if (!raw[1].test(text)) html = { start, close: raw[1] };
        continue;
      }
    }
    if (!hasDelimiters) continue;
    for (const marker of boundaryTokens(text)) {
      const { token, offset } = marker;
      const absolute = start.offset + offset;
      if (comment && token === "%%") {
        regions.push({ start: comment.start, end });
        comment = undefined;
        continue;
      }
      while (inline && inline[1] <= absolute) inline = code.next().value;
      if (inline && inline[0] <= absolute) continue;
      if (token === "%%") {
        while (htmlToken && htmlToken.end <= absolute) htmlToken = htmlTokens.next().value;
        if (!marker.inLiteral && (!htmlToken || htmlToken.start > absolute) && beginsBlockComment(text.slice(0, offset))) {
          comment = { start, offset: absolute };
        }
        continue;
      }
      const width = token.length;
      const usableClose = width === 2 || (/\S/u.test(text[offset - 1] ?? "") && !/\d/u.test(text[offset + width] ?? ""));
      if (formula?.width === width && usableClose) {
        if (width === 2) regions.push({ start: formula.start, end });
        formula = undefined;
        // A comment opener inside a paired formula is literal.
        comment = undefined;
      } else if (!comment && !formula && (width === 2 || /\S/u.test(text[offset + width] ?? ""))) {
        formula = { start, width };
      }
    }
    if (formula?.width === 1) formula = undefined;
  }
  // Cutting inside an unclosed comment would let a later section reparse its
  // hidden tail as Markdown. Truncating at the opener preserves prefix offsets.
  const unclosed = frontmatter ? startOfSource : fence?.start ?? html?.start;
  if (unclosed) {
    regions.push({ start: unclosed, end: last, omit: fence?.topLevel && last.bytes - unclosed.bytes > hardLimit });
  }
  regions.sort((a, b) => a.start.offset - b.start.offset || b.end.offset - a.end.offset);
  return { regions, visibleEnd: comment?.offset };
}

function* sections(content: string, sectionSize: number, hardLimit: number, regions: Region[], recoverLists: boolean): IterableIterator<LinkSection> {
  let start = startOfSource;
  let prior: Boundary | undefined;
  let safe: Boundary | undefined;
  let region = 0;
  let opaqueEnd = 0;
  let skippedUntil = 0;
  let previousBlank = true;
  let end = start;
  let listMarker: string | undefined;
  for (const line of lines(content)) {
    const at = line.start;
    if (recoverLists) {
      const marker = /^(?: {0,3})([-+*]|\d{1,9}[.)])([ \t]+)\S/u.exec(line.text);
      if (marker) listMarker = marker[0].slice(0, -1) + "x\n";
      else if (listMarker && /^(?: {4}|\t)/u.test(line.text)) at.listPrefix = listMarker;
      else if (/^\S/u.test(line.text)) listMarker = undefined;
    }
    end = line.end;
    const afterBlank = previousBlank;
    previousBlank = /^[ \t]*$/u.test(line.text);
    if (at.offset < skippedUntil) continue;
    while (regions[region]?.start.offset <= at.offset) {
      const span = regions[region++];
      if (span.omit && at.offset >= opaqueEnd) {
        if (at.offset > start.offset) yield { start, end: at, safe: true };
        start = span.end;
        prior = safe = undefined;
        skippedUntil = span.end.offset;
      }
      opaqueEnd = Math.max(opaqueEnd, span.end.offset);
    }
    if (at.offset <= start.offset) continue;

    const safeHere = afterBlank && !previousBlank && !startsContainer.test(line.text) && at.offset >= opaqueEnd;
    const distance = at.bytes - start.bytes;
    if (safeHere && distance <= hardLimit) safe = at;
    if (distance >= sectionSize && safe) {
      yield { start, end: safe, safe: true };
      start = safe;
      prior = safe = undefined;
    } else if (distance >= hardLimit) {
      // A cut inside an oversized opaque region is deliberately approximate.
      // End on a line boundary whenever there is one within the hard budget.
      const cut = prior && distance > hardLimit ? prior : at;
      yield { start, end: cut, safe: false };
      start = cut;
      prior = safe = undefined;
    }
    if (at.offset > start.offset) prior = at;
  }
  if (end.offset > start.offset) yield { start, end, safe: true };
}

/** The hard ceiling also bounds parser amplification for notes with a very
 * long line or no independent paragraphs. The fallback retains wikilinks and
 * emits their original offsets, including when a line exceeds that ceiling. */
export function extractBoundedLinkSource(
  content: string,
  { sectionBytes, maxReferences }: LinkExtractionOptions = defaultLinkExtraction,
  recoverLists = false,
): BoundedLinkExtraction {
  const references: MarkdownLinkReference[] = [];
  const hardLimit = 4 * sectionBytes;
  const protectedSource = protectedRegions(content, hardLimit);
  let complete = true;
  if (protectedSource.visibleEnd !== undefined) content = content.slice(0, protectedSource.visibleEnd);
  let sectionCount = 0;
  for (const { start, end, safe } of sections(content, sectionBytes, hardLimit, protectedSource.regions, recoverLists)) {
    sectionCount++;
    const wikiOnly = end.bytes - start.bytes > hardLimit;
    if (!safe || wikiOnly) complete = false;
    const prefix = wikiOnly ? "" : start.listPrefix ?? "";
    const parsed = extractMarkdownLinkReferences(prefix + content.slice(start.offset, end.offset), {
      readFrontmatter: start.offset === 0 && !wikiOnly,
      wikiOnly,
      maxReferences: maxReferences - references.length + 1,
    });
    for (const reference of parsed) {
      if (references.length === maxReferences) return { references, complete: false, limitReason: "cap" };
      if (reference.position) {
        for (const point of [reference.position.start, reference.position.end]) {
          point.offset += start.offset - prefix.length;
          point.line += start.line - Number(!!prefix);
        }
      }
      references.push(reference);
    }
  }
  // Reference-style Markdown may depend on a definition in another section.
  if (sectionCount > 1 && /^ {0,3}\[[^\]\r\n]+\]:/mu.test(content)) complete = false;
  return complete ? { references, complete: true } : { references, complete: false, limitReason: "region" };
}

export function extractLargeLinkSource(content: string): MarkdownLinkReference[] {
  return extractBoundedLinkSource(content).references;
}
