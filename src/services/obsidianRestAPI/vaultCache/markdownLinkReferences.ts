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

const scheme = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const htmlTag = /^<(\/?)([a-z][\w:-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^<>"'])*>$/iu;
const markdownSyntax = gfm();
// Remove the disabled construct from dispatch as well: GFM normally
// registers it on every alphanumeric character.
const inlineConstructs = markdownSyntax.text ?? {};
for (const [character, constructs] of Object.entries(inlineConstructs)) {
  if (!constructs) continue;
  const remaining = (Array.isArray(constructs) ? constructs : [constructs])
    .filter((construct) => construct.name !== "emailAutolink");
  if (remaining.length) inlineConstructs[character] = remaining;
  else delete inlineConstructs[character];
}
const [literalAutolinks, ...otherGfmNodes] = gfmFromMarkdown();
const markdownOptions = {
  extensions: [markdownSyntax, { disable: { null: ["emailAutolink"] } }],
  // The fallback literal-autolink transform scans the AST again and emits
  // links without source positions. This index only uses positioned tokens.
  mdastExtensions: [{ ...literalAutolinks, transforms: [] }, ...otherGfmNodes],
};

type Span = { start: number; end: number };
type LocatedReference = Span & { reference: MarkdownLinkReference };
type MaskedBody = { source: string; comments: Span[] };

// Markdown links, autolinks and opaque Markdown constructs may take
// precedence over wikilinks. Plain text with only wikilinks needs no AST.
const needsMarkdownTree = /[`<$\t]| {4}|~~~|\][(:]|https?:\/\/|www\./iu;

function* wikiLinks(
  source: string,
  isBlocked?: (start: number, end: number) => boolean,
): IterableIterator<Span & { embed: boolean; target: Span; alias?: Span }> {
  const opener = /(?<!\\)(!)?\[\[([^\[\]\r\n|]+)(\]\]|\|)/gu;
  const terminator = /(?<!\\)!?\[\[|\]\]|[\r\n]/gu;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    const start = match.index;
    if (isBlocked?.(start, start + 1)) continue;
    const targetStart = start + (match[1] ? 3 : 2);
    const target = { start: targetStart, end: targetStart + match[2].length };
    let alias: Span | undefined;
    let end = opener.lastIndex;
    if (match[3] === "|") {
      terminator.lastIndex = end;
      const close = terminator.exec(source);
      if (!close) return;
      if (close[0] !== "]]") {
        // A new opener abandons the unfinished alias. Resume at that
        // opener, or just after the line break that ended the candidate.
        opener.lastIndex = close[0].endsWith("[[") ? close.index : terminator.lastIndex;
        continue;
      }
      alias = { start: end, end: close.index };
      end = terminator.lastIndex;
    }
    if (isBlocked?.(start, end)) continue;
    opener.lastIndex = end;
    yield { start, end, embed: !!match[1], target, alias };
  }
}

function parseMarkdown(source: string) {
  // Bare emails are external to the vault graph. Keep GFM URL tokenization,
  // which protects dollar signs inside bare URLs.
  return fromMarkdown(source, markdownOptions);
}

function* walk(root: Nodes): IterableIterator<{ node: Nodes; parent: Nodes }> {
  const pending = [{ node: root, parent: root }];
  while (pending.length) {
    const entry = pending.pop()!;
    const { node } = entry;
    yield entry;
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], parent: node });
    }
  }
}

function opaqueSpans(root: Nodes, source: string): Span[] {
  const spans: Span[] = [];
  const destinations: Span[] = [];
  const tagsByParent = new WeakMap<Nodes, Map<string, number[]>>();
  for (const { node, parent } of walk(root)) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (node.type === "code" || node.type === "inlineCode") {
      spans.push({ start, end });
    } else if (node.type === "link") {
      // For explicit Markdown links protect the destination. For both kinds
      // of autolinks the URL is the link text itself.
      const destinationStart = source[start] === "[" ? node.children.at(-1)?.position?.end.offset ?? start : start;
      destinations.push({ start: destinationStart, end });
    } else if (node.type === "image" || node.type === "definition") {
      destinations.push({ start, end });
    } else if (node.type === "html") {
      spans.push({ start, end });
      const tag = htmlTag.exec(node.value);
      if (!tag || node.value.endsWith("/>")) continue;
      const openTags = tagsByParent.get(parent) ?? new Map<string, number[]>();
      tagsByParent.set(parent, openTags);
      const name = tag[2].toLowerCase();
      if (tag[1]) {
        const open = openTags.get(name)?.pop();
        if (open !== undefined) spans.push({ start: open, end });
      } else {
        const offsets = openTags.get(name) ?? [];
        offsets.push(start);
        openTags.set(name, offsets);
      }
    }
  }
  const codeOrHtml = spanFilter(spans.sort((a, b) => a.start - b.start));
  if (!source.includes("$")) return spans;
  for (const { start, end } of wikiLinks(source, spanFilter(spans))) {
    destinations.push({ start, end });
  }
  const inDestination = spanFilter(destinations.sort((a, b) => a.start - b.start));
  const formulas: Span[] = [];
  let opener: { start: number; width: number } | undefined;
  let escapedAt = -1;
  for (const match of source.matchAll(/(\\+)|(\$+)|\r\n?|\n/gu)) {
    if (match[1]) {
      escapedAt = match[1].length % 2 ? match.index + match[1].length : -1;
      continue;
    }
    if (!match[2]) {
      if (opener?.width === 1) opener = undefined;
      continue;
    }
    const start = match.index;
    if (start === escapedAt) continue;
    const width = match[2].length;
    if (width > 2 || codeOrHtml(start, start + width) || inDestination(start, start + width)) continue;
    const next = source[start + width] ?? "";
    const previous = source[start - 1] ?? "";
    if (opener?.width === width && (width === 2 || (/\S/u.test(previous) && !/\d/u.test(next)))) {
      formulas.push({ start: opener.start, end: start + width });
      opener = undefined;
    } else if (!opener && (width === 2 || /\S/u.test(next))) {
      opener = { start, width };
    }
  }
  return spans.concat(formulas).sort((a, b) => a.start - b.start);
}

/** Call with increasing start offsets. */
function spanFilter(spans: readonly Span[]) {
  let cursor = 0;
  return (start: number, end: number, ignoreBefore = 0) => {
    while (cursor < spans.length && (spans[cursor].end <= start || spans[cursor].start < ignoreBefore)) cursor++;
    return cursor < spans.length && spans[cursor].start < end;
  };
}

function maskComments(body: string, opaque: readonly Span[]): MaskedBody {
  const blocksOpener = spanFilter(opaque);
  const chunks: string[] = [];
  const comments: Span[] = [];
  let open: number | undefined;
  let consumed = 0;
  for (const { index } of body.matchAll(/(?<!\\)%%/gu)) {
    if (open === undefined) {
      if (!blocksOpener(index, index + 2, consumed)) open = index;
      continue;
    }
    const end = index + 2;
    const lines = body.slice(open, end).split(/(\r\n?|\n)/u);
    const visibleSuffix = /[^\S\r\n]*[^\s]/uy;
    visibleSuffix.lastIndex = end;
    const hasTrailingText = visibleSuffix.test(body);
    if (hasTrailingText) {
      // Visible text on the closing line must not become indented code.
      lines[lines.length - 1] = "x" + " ".repeat(lines[lines.length - 1].length - 1);
    }
    for (let i = 0; i < lines.length - (hasTrailingText ? 1 : 0); i += 2) {
      lines[i] = " ".repeat(lines[i].length);
    }
    chunks.push(body.slice(consumed, open), lines.join(""));
    comments.push({ start: open, end });
    open = undefined;
    consumed = end;
  }
  if (open !== undefined) {
    chunks.push(body.slice(consumed, open), body.slice(open).replace(/[^\r\n]/g, " "));
    comments.push({ start: open, end: body.length });
    return { source: chunks.join(""), comments };
  }
  return { source: consumed ? chunks.join("") + body.slice(consumed) : body, comments };
}

/** Slice sequential link fields from the original body, excluding comments. */
function uncommentedSlice(body: string, comments: readonly Span[]) {
  let cursor = 0;
  return ({ start, end }: Span): string => {
    while (cursor < comments.length && comments[cursor].end <= start) cursor++;
    let result = "";
    let offset = start;
    while (cursor < comments.length && comments[cursor].start < end) {
      const comment = comments[cursor];
      if (comment.start > offset) result += body.slice(offset, comment.start);
      offset = comment.end;
      if (offset >= end) break;
      cursor++;
    }
    return result + (offset < end ? body.slice(offset, end) : "");
  };
}

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

function collectMarkdownLinks(body: string) {
  // Only inspect the unmasked tree if a comment delimiter might be inside
  // code, an HTML element or math. In plain Markdown we can mask before parsing.
  const needsOpaqueSpans = /[`<$\t]| {4}|~~~/u;
  const hasComments = body.includes("%%");
  const inspectBeforeMask = hasComments && needsOpaqueSpans.test(body);
  let { source, comments } = hasComments && !inspectBeforeMask
    ? maskComments(body, [])
    : { source: body, comments: [] as Span[] };
  let root = parseMarkdown(source);
  let blocked = needsOpaqueSpans.test(source) ? opaqueSpans(root, source) : [];
  if (inspectBeforeMask) {
    ({ source, comments } = maskComments(body, blocked));
    if (source !== body) {
      root = parseMarkdown(source);
      blocked = opaqueSpans(root, source);
    }
  }
  const isOpaque = spanFilter(blocked.slice());
  const located: LocatedReference[] = [];
  const definitions = new Map<string, Definition>();
  const indirectLinks: Array<Extract<Nodes, { type: "linkReference" | "imageReference" }>> = [];
  for (const { node } of walk(root)) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "link" || node.type === "image") {
        if (isOpaque(start, start + 1)) continue;
        const reference = makeReference(node.type === "image" ? "embed" : "link",
          node.url, body.slice(start, end), displayLabel(node), true);
        if (reference) located.push({ start, end, reference });
        blocked.push({ start, end });
        continue;
      }
      if (node.type === "linkReference" || node.type === "imageReference") {
        if (isOpaque(start, start + 1)) continue;
        indirectLinks.push(node);
        blocked.push({ start, end });
        continue;
      }
      if (node.type === "definition" && !isOpaque(start, start + 1) && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node);
        blocked.push({ start, end });
      }
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
  return { source, comments, blocked, located };
}

export function extractMarkdownLinkReferences(
  content: string,
  { forceMarkdownTree = false, readFrontmatter = true } = {},
): MarkdownLinkReference[] {
  const { body, frontmatter } = readFrontmatter
    ? readMarkdownFrontmatter(content)
    : { body: content, frontmatter: {} };
  const references: MarkdownLinkReference[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const pending = [value];
    const seen = new WeakSet<object>();
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string") {
        for (const { start, end, target, alias } of wikiLinks(item)) {
          const reference = makeReference("frontmatter", item.slice(target.start, target.end),
            item.slice(start, end), alias && item.slice(alias.start, alias.end));
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
  const { source, comments, blocked, located } = forceMarkdownTree || needsMarkdownTree.test(body)
    ? collectMarkdownLinks(body)
    : { ...(body.includes("%%") ? maskComments(body, []) : { source: body, comments: [] }), blocked: [], located: [] };

  const isBlocked = spanFilter(blocked.sort((a, b) => a.start - b.start));
  const slice = uncommentedSlice(body, comments);
  for (const { start, end, embed, target, alias } of wikiLinks(source, isBlocked)) {
    const reference = makeReference(embed ? "embed" : "link", slice(target), body.slice(start, end), alias && slice(alias));
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
