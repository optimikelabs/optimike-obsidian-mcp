import { extractMarkdownLinkReferences, type MarkdownLinkReference } from "./markdownLinkReferences.js";

export const LARGE_LINK_SOURCE_BYTES = 256 * 1024;
const MAX_SECTION_LENGTH = 64 * 1024;
const MAX_LARGE_SOURCE_REFERENCES = 8192;
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

/** Large notes use independent, bounded sections. Keep explicit multiline
 * literals together so a cut cannot expose their contents as links. */
export function extractLargeLinkSource(content: string): MarkdownLinkReference[] {
  const references: MarkdownLinkReference[] = [];
  let start = 0;
  let firstLine = 0;
  let end = 0;
  let endLine = 0;
  let offset = 0;
  let lineNumber = 0;
  let fence: string | undefined;
  let htmlEnd: RegExp | undefined;
  let comment = false;
  let math = false;
  let frontmatter = /^\uFEFF?---\r?\n/u.test(content);

  const flush = () => {
    if (end > start) {
      for (const reference of extractMarkdownLinkReferences(content.slice(start, end), {
        readFrontmatter: start === 0,
      })) {
        if (reference.position) {
          for (const point of [reference.position.start, reference.position.end]) {
            point.offset += start;
            point.line += firstLine;
          }
        }
        references.push(reference);
        if (references.length >= MAX_LARGE_SOURCE_REFERENCES) break;
      }
    }
    start = end;
    firstLine = endLine;
  };

  const acceptBoundary = (next: number, nextLine: number) => {
    if (next - start > MAX_SECTION_LENGTH) flush();
    end = next;
    endLine = nextLine;
    // A single oversized line or opaque block cannot enter the Markdown parser.
    if (end - start > MAX_SECTION_LENGTH) {
      start = end;
      firstLine = endLine;
    }
  };

  for (const match of content.matchAll(/\r\n?|\n|$/gu)) {
    const line = content.slice(offset, match.index);
    const isFirstLine = lineNumber === 0;
    offset = match.index + match[0].length;
    lineNumber++;
    if (frontmatter) {
      if (isFirstLine || line !== "---") continue;
      frontmatter = false;
    } else if (htmlEnd) {
      if (!htmlEnd.test(line)) continue;
      htmlEnd = undefined;
    } else {
      const marker = fenceLine.exec(line);
      if (fence) {
        if (!marker || marker[1][0] !== fence[0] || marker[1].length < fence.length || marker[2].trim()) continue;
        fence = undefined;
      } else if (marker && !comment && !math) {
        fence = marker[1];
        continue;
      } else {
        if (!comment && !math) {
          const raw = rawHtml.find(([opens]) => opens.test(line));
          htmlEnd = raw && !raw[1].test(line) ? raw[1] : undefined;
          if (htmlEnd) continue;
        }
        for (const [token] of line.matchAll(/(?<!\\)%%|(?<![\\$])\$\$(?!\$)/gu)) {
          if (token === "%%" && !math) comment = !comment;
          else if (token === "$$" && !comment) math = !math;
        }
        if (comment || math) continue;
      }
    }
    acceptBoundary(offset, lineNumber);
    if (references.length >= MAX_LARGE_SOURCE_REFERENCES) return references;
  }
  // The Markdown parser can handle an unterminated region if it fits.
  if (offset > end) acceptBoundary(offset, lineNumber);
  if (references.length < MAX_LARGE_SOURCE_REFERENCES) flush();
  return references;
}
