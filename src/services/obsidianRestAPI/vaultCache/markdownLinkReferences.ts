import type { Definition, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { readMarkdownFrontmatter } from "../../readMarkdownFrontmatter.js";
import type { NoteLinkObservation } from "../types.js";

export type MarkdownLinkReference = Pick<
  NoteLinkObservation,
  "kind" | "linkText" | "linkPath" | "subpath" | "original" | "displayText" | "frontmatterKey" | "position"
>;

const wikiLink = /(?<!\\)(!)?\[\[([^\]\r\n|]+)(?:\|([^\]\r\n]*))?\]\]/gu;
const scheme = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

function makeReference(
  kind: MarkdownLinkReference["kind"],
  target: string,
  original: string,
  displayText?: string,
  markdown = false,
): MarkdownLinkReference | undefined {
  const hash = target.indexOf("#");
  let linkPath = (hash === -1 ? target : target.slice(0, hash)).trim();
  let subpath = hash === -1 ? "" : target.slice(hash);
  if (markdown) {
    try {
      linkPath = decodeURIComponent(linkPath);
      subpath = decodeURIComponent(subpath);
    } catch {
      return undefined;
    }
    if (linkPath && !linkPath.toLowerCase().endsWith(".md")) return undefined;
  }
  if (scheme.test(linkPath) || (!linkPath && !subpath)) return undefined;
  return {
    kind, original, linkText: linkPath + subpath, linkPath, subpath,
    ...(displayText ? { displayText } : {}),
  };
}

function displayLabel(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(displayLabel).join("");
  return "alt" in node ? node.alt ?? "" : "";
}

export function extractMarkdownLinkReferences(content: string): MarkdownLinkReference[] {
  const { body, frontmatter } = readMarkdownFrontmatter(content);
  const references: MarkdownLinkReference[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const pending = [value];
    const seen = new WeakSet<object>();
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string") {
        for (const match of item.matchAll(wikiLink)) {
          const reference = makeReference("frontmatter", match[2], match[0], match[3]);
          if (reference) references.push({ ...reference, frontmatterKey: key });
        }
      } else if (item && typeof item === "object" && !seen.has(item)) {
        seen.add(item);
        const values = Object.values(item);
        for (let i = values.length - 1; i >= 0; i--) pending.push(values[i]);
      }
    }
  }

  if (!body.includes("[")) return references;
  // Blanking Obsidian comments keeps the parser's offsets in the original note.
  const source = body.replace(/%%[\s\S]*?%%/gu, (comment) => comment.replace(/[^\r\n]/gu, " "));
  const root = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const blocked: Array<{ start: number; end: number }> = [];
  const located: Array<{ start: number; end: number; reference: MarkdownLinkReference }> = [];
  const definitions = new Map<string, Definition>();
  const indirectLinks: Array<Extract<Nodes, { type: "linkReference" | "imageReference" }>> = [];
  const pending: Nodes[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "link" || node.type === "image") {
        const reference = makeReference(node.type === "image" ? "embed" : "link",
          node.url, body.slice(start, end), displayLabel(node), true);
        if (reference) located.push({ start, end, reference });
        blocked.push({ start, end });
        continue;
      }
      if (node.type === "linkReference" || node.type === "imageReference") {
        indirectLinks.push(node);
        blocked.push({ start, end });
        continue;
      }
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node);
      }
      if (node.type === "code" || node.type === "inlineCode" || node.type === "html" || node.type === "definition") {
        blocked.push({ start, end });
        continue;
      }
    }
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
    }
  }
  for (const node of indirectLinks) {
    const start = node.position!.start.offset!;
    const end = node.position!.end.offset!;
    const definition = definitions.get(node.identifier);
    if (!definition) continue;
    const reference = makeReference(node.type === "imageReference" ? "embed" : "link",
      definition.url, body.slice(start, end), displayLabel(node), true);
    if (reference) located.push({ start, end, reference });
  }

  let blockedIndex = 0;
  for (const match of source.matchAll(wikiLink)) {
    const start = match.index;
    const end = start + match[0].length;
    while (blockedIndex < blocked.length && blocked[blockedIndex].end <= start) blockedIndex++;
    if (blockedIndex < blocked.length && blocked[blockedIndex].start < end) continue;
    const reference = makeReference(match[1] ? "embed" : "link", match[2], body.slice(start, end), match[3]);
    if (reference) located.push({ start, end, reference });
  }

  const bodyOffset = content.length - body.length;
  const lineBreaks = content.matchAll(/\r\n?|\n/gu);
  let nextBreak = lineBreaks.next();
  let line = 0;
  let lineStart = 0;
  const point = (offset: number) => {
    while (!nextBreak.done && nextBreak.value.index + nextBreak.value[0].length <= offset) {
      line++;
      lineStart = nextBreak.value.index + nextBreak.value[0].length;
      nextBreak = lineBreaks.next();
    }
    return { offset, line, col: offset - lineStart };
  };
  for (const { start, end, reference } of located.sort((a, b) => a.start - b.start)) {
    references.push({ ...reference, position: { start: point(start + bodyOffset), end: point(end + bodyOffset) } });
  }
  return references;
}
