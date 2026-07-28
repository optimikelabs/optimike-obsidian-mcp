import { fileURLToPath } from "node:url";
import type {
  Content,
  Heading,
  InlineCode,
  Link,
  Parent,
  PhrasingContent,
  Root,
} from "mdast";
import type { Point, Position } from "unist";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

const ROOT_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const TOKEN_PREFIX = "external-ref:";
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c)/iu;
const PERCENT_ESCAPE_PATTERN = /%(?![0-9a-f]{2})/iu;
const EXCLUDED_HEADING_PATTERN =
  /^(?:historique|history|exemples?|examples?|changelog|journal des modifications|release notes?)\b/iu;

export type ExternalReferenceClassification =
  | "reparable"
  | "manualReview"
  | "ignored";

export interface SourcePoint {
  line: number;
  column: number;
  offset: number;
}

export interface SourceRange {
  start: SourcePoint;
  end: SourcePoint;
}

export interface CanonicalExternalReferenceToken {
  raw: string;
  rootId: string;
  relativePath: string;
  encodedRelativePath: string;
  range: SourceRange;
}

export interface ExternalFileLink {
  url: string;
  localPath: string;
  range: SourceRange;
  destinationRange: SourceRange;
}

export interface ExternalReferenceOccurrence {
  classification: ExternalReferenceClassification;
  reason:
    | "canonical_pair"
    | "excluded_section"
    | "invalid_token"
    | "invalid_file_uri"
    | "missing_file_link"
    | "missing_identity_token"
    | "multiple_identity_tokens"
    | "multiple_file_links"
    | "basename_mismatch";
  containerRange: SourceRange;
  token?: CanonicalExternalReferenceToken;
  fileLink?: ExternalFileLink;
  detail?: string;
}

export interface ExternalReferenceScanResult {
  occurrences: ExternalReferenceOccurrence[];
  reparable: ExternalReferenceOccurrence[];
  manualReview: ExternalReferenceOccurrence[];
  ignored: ExternalReferenceOccurrence[];
}

export interface CanonicalExternalReferenceRepairTarget {
  rootId: string;
  relativePath: string;
  fileUrl: string;
}

export interface CanonicalExternalReferenceTextEdit {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

interface ParsedToken {
  token?: CanonicalExternalReferenceToken;
  error?: string;
  range: SourceRange;
}

interface ParsedLink {
  link?: ExternalFileLink;
  error?: string;
  range: SourceRange;
  url: string;
}

interface ExcludedRange {
  start: number;
  end: number;
}

function requirePoint(point: Point | undefined): SourcePoint {
  if (
    point?.offset === undefined ||
    !Number.isInteger(point.line) ||
    !Number.isInteger(point.column)
  ) {
    throw new Error("Markdown node is missing an exact source position.");
  }
  return {
    line: point.line,
    column: point.column,
    offset: point.offset,
  };
}

function requireRange(position: Position | undefined): SourceRange {
  if (!position) {
    throw new Error("Markdown node is missing an exact source range.");
  }
  return {
    start: requirePoint(position.start),
    end: requirePoint(position.end),
  };
}

function pointAtOffset(source: string, offset: number): SourcePoint {
  if (offset < 0 || offset > source.length) {
    throw new Error("Source offset is outside the Markdown document.");
  }
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1, offset };
}

function sourceRangeFromOffsets(
  source: string,
  startOffset: number,
  endOffset: number,
): SourceRange {
  return {
    start: pointAtOffset(source, startOffset),
    end: pointAtOffset(source, endOffset),
  };
}

function normalizeHeading(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLowerCase();
}

function phrasingText(node: PhrasingContent): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("children" in node) {
    return node.children.map(phrasingText).join("");
  }
  return "";
}

function headingText(heading: Heading): string {
  return heading.children.map(phrasingText).join("");
}

function findFrontmatterRange(source: string): ExcludedRange | undefined {
  const bomOffset = source.startsWith("\uFEFF") ? 1 : 0;
  const firstLineEnd = source.indexOf("\n", bomOffset);
  const firstLine =
    firstLineEnd === -1
      ? source.slice(bomOffset)
      : source.slice(bomOffset, firstLineEnd).replace(/\r$/u, "");
  if (firstLine !== "---") return undefined;

  let cursor = firstLineEnd === -1 ? source.length : firstLineEnd + 1;
  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(cursor, end).replace(/\r$/u, "");
    if (line === "---" || line === "...") {
      return {
        start: 0,
        end: lineEnd === -1 ? source.length : lineEnd + 1,
      };
    }
    cursor = lineEnd === -1 ? source.length : lineEnd + 1;
  }
  return undefined;
}

function findExcludedHeadingRanges(
  root: Root,
  sourceLength: number,
): ExcludedRange[] {
  const headings = root.children.filter(
    (node): node is Heading => node.type === "heading",
  );
  const ranges: ExcludedRange[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (
      !EXCLUDED_HEADING_PATTERN.test(normalizeHeading(headingText(heading)))
    ) {
      continue;
    }
    const start = requireRange(heading.position).start.offset;
    let end = sourceLength;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].depth <= heading.depth) {
        end = requireRange(headings[next].position).start.offset;
        break;
      }
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function isExcluded(
  range: SourceRange,
  excludedRanges: ExcludedRange[],
): boolean {
  return excludedRanges.some(
    (excluded) =>
      range.start.offset >= excluded.start && range.start.offset < excluded.end,
  );
}

function parseCanonicalToken(node: InlineCode): ParsedToken {
  const range = requireRange(node.position);
  const raw = node.value;
  if (!raw.startsWith(TOKEN_PREFIX)) {
    return { range };
  }

  const identity = raw.slice(TOKEN_PREFIX.length);
  const delimiterIndex = identity.indexOf("::");
  if (
    delimiterIndex <= 0 ||
    identity.indexOf("::", delimiterIndex + 2) !== -1
  ) {
    return {
      range,
      error: "Expected external-ref:<rootId>::<encodedRelativePath>.",
    };
  }

  const rootId = identity.slice(0, delimiterIndex);
  const encodedRelativePath = identity.slice(delimiterIndex + 2);
  if (!ROOT_ID_PATTERN.test(rootId)) {
    return {
      range,
      error: "Root id is not a stable lowercase logical identifier.",
    };
  }
  if (
    encodedRelativePath.length === 0 ||
    encodedRelativePath.startsWith("/") ||
    encodedRelativePath.endsWith("/") ||
    encodedRelativePath.includes("\\") ||
    encodedRelativePath.includes("\0")
  ) {
    return {
      range,
      error: "Relative path must name one file below the logical root.",
    };
  }
  if (
    PERCENT_ESCAPE_PATTERN.test(encodedRelativePath) ||
    ENCODED_SEPARATOR_PATTERN.test(encodedRelativePath)
  ) {
    return {
      range,
      error: "Relative path contains an invalid or encoded path separator.",
    };
  }

  const encodedSegments = encodedRelativePath.split("/");
  if (encodedSegments.some((segment) => segment.length === 0)) {
    return { range, error: "Relative path contains an empty segment." };
  }

  const decodedSegments: string[] = [];
  try {
    for (const encodedSegment of encodedSegments) {
      const decoded = decodeURIComponent(encodedSegment);
      if (
        decoded.length === 0 ||
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\") ||
        decoded.includes("\0")
      ) {
        return {
          range,
          error: "Relative path contains traversal or a path separator.",
        };
      }
      decodedSegments.push(decoded);
    }
  } catch {
    return {
      range,
      error: "Relative path contains malformed percent encoding.",
    };
  }

  const canonicalPath = decodedSegments.map(encodeURIComponent).join("/");
  if (canonicalPath !== encodedRelativePath) {
    return {
      range,
      error: `Relative path is not canonically encoded (expected ${canonicalPath}).`,
    };
  }

  return {
    range,
    token: {
      raw,
      rootId,
      relativePath: decodedSegments.join("/"),
      encodedRelativePath,
      range,
    },
  };
}

export function encodeCanonicalExternalReference(
  rootId: string,
  relativePath: string,
): string {
  if (!ROOT_ID_PATTERN.test(rootId)) {
    throw new Error("Root id is not a stable lowercase logical identifier.");
  }
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new Error("Relative path must name one file below the logical root.");
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw new Error("Relative path contains traversal or a path separator.");
    }
  }
  return `${TOKEN_PREFIX}${rootId}::${segments.map(encodeURIComponent).join("/")}`;
}

function validateRawFileUri(rawUrl: string): string | undefined {
  if (!rawUrl.toLowerCase().startsWith("file:")) {
    return undefined;
  }
  if (
    !/^file:\/\/\/(?!\/)/iu.test(rawUrl) ||
    rawUrl.includes("\\") ||
    rawUrl.includes("\0") ||
    PERCENT_ESCAPE_PATTERN.test(rawUrl) ||
    ENCODED_SEPARATOR_PATTERN.test(rawUrl)
  ) {
    throw new Error("File URI contains an invalid path encoding.");
  }

  const withoutQuery = rawUrl.split(/[?#]/u, 1)[0];
  const pathPart = withoutQuery.replace(/^file:\/\/[^/]*\/?/iu, "");
  for (const segment of pathPart.split("/")) {
    if (segment.length === 0) continue;
    const decoded = decodeURIComponent(segment);
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new Error("File URI contains traversal or an unsafe segment.");
    }
  }
  return rawUrl;
}

function findLinkDestinationRange(source: string, node: Link): SourceRange {
  const range = requireRange(node.position);
  const markdown = source.slice(range.start.offset, range.end.offset);
  let relativeStart = -1;

  if (markdown.startsWith("<") && markdown.endsWith(">")) {
    relativeStart = markdown.indexOf(node.url, 1);
  } else {
    const opener = markdown.lastIndexOf("](");
    if (opener !== -1) {
      const destinationAreaStart = opener + 2;
      relativeStart = markdown.indexOf(node.url, destinationAreaStart);
    }
  }
  if (relativeStart === -1) {
    throw new Error("Could not locate the exact Markdown link destination.");
  }
  const startOffset = range.start.offset + relativeStart;
  return sourceRangeFromOffsets(
    source,
    startOffset,
    startOffset + node.url.length,
  );
}

function parseFileLink(source: string, node: Link): ParsedLink | undefined {
  const range = requireRange(node.position);
  if (!node.url.toLowerCase().startsWith("file:")) return undefined;

  try {
    validateRawFileUri(node.url);
    const url = new URL(node.url);
    if (url.protocol !== "file:") {
      return undefined;
    }
    if (url.hostname !== "") {
      throw new Error("Hosted and UNC file URIs are not supported.");
    }
    if (url.pathname.startsWith("//")) {
      throw new Error("UNC file paths are not supported.");
    }
    if (url.search || url.hash) {
      throw new Error("File URI query strings and fragments are ambiguous.");
    }
    if (url.pathname.endsWith("/")) {
      throw new Error("Canonical references can target files only.");
    }
    const localPath = fileURLToPath(url);
    const destinationRange = findLinkDestinationRange(source, node);
    return {
      range,
      url: node.url,
      link: { url: node.url, localPath, range, destinationRange },
    };
  } catch (error) {
    return {
      range,
      url: node.url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function basename(value: string): string {
  const parts = value.replace(/\\/gu, "/").split("/");
  return parts.at(-1) ?? "";
}

function visitParents(
  node: Root | Content,
  callback: (node: Parent) => void,
): void {
  if (!("children" in node)) return;
  callback(node);
  for (const child of node.children) {
    visitParents(child, callback);
  }
}

function scanContainer(
  source: string,
  container: Parent,
  excludedRanges: ExcludedRange[],
): ExternalReferenceOccurrence[] {
  const containerRange = requireRange(container.position);
  const tokens: ParsedToken[] = [];
  const links: ParsedLink[] = [];

  for (const child of container.children) {
    if (child.type === "inlineCode") {
      const parsed = parseCanonicalToken(child);
      if (parsed.token || parsed.error) tokens.push(parsed);
    } else if (child.type === "link") {
      const parsed = parseFileLink(source, child);
      if (parsed) links.push(parsed);
    }
  }
  if (tokens.length === 0 && links.length === 0) return [];

  if (isExcluded(containerRange, excludedRanges)) {
    return [
      {
        classification: "ignored",
        reason: "excluded_section",
        containerRange,
        token: tokens.length === 1 ? tokens[0].token : undefined,
        fileLink: links.length === 1 ? links[0].link : undefined,
      },
    ];
  }

  if (tokens.length > 1) {
    return [
      {
        classification: "manualReview",
        reason: "multiple_identity_tokens",
        containerRange,
        detail: `Found ${tokens.length} external identity tokens.`,
      },
    ];
  }
  if (links.length > 1) {
    return [
      {
        classification: "manualReview",
        reason: "multiple_file_links",
        containerRange,
        token: tokens[0]?.token,
        detail: `Found ${links.length} file links.`,
      },
    ];
  }

  const parsedToken = tokens[0];
  const parsedLink = links[0];
  if (parsedToken?.error) {
    return [
      {
        classification: "manualReview",
        reason: "invalid_token",
        containerRange,
        fileLink: parsedLink?.link,
        detail: parsedToken.error,
      },
    ];
  }
  if (parsedLink?.error) {
    return [
      {
        classification: "manualReview",
        reason: "invalid_file_uri",
        containerRange,
        token: parsedToken?.token,
        detail: parsedLink.error,
      },
    ];
  }
  if (!parsedToken?.token) {
    return [
      {
        classification: "manualReview",
        reason: "missing_identity_token",
        containerRange,
        fileLink: parsedLink?.link,
      },
    ];
  }
  if (!parsedLink?.link) {
    return [
      {
        classification: "manualReview",
        reason: "missing_file_link",
        containerRange,
        token: parsedToken.token,
      },
    ];
  }
  if (
    basename(parsedToken.token.relativePath) !==
    basename(parsedLink.link.localPath)
  ) {
    return [
      {
        classification: "manualReview",
        reason: "basename_mismatch",
        containerRange,
        token: parsedToken.token,
        fileLink: parsedLink.link,
      },
    ];
  }

  return [
    {
      classification: "reparable",
      reason: "canonical_pair",
      containerRange,
      token: parsedToken.token,
      fileLink: parsedLink.link,
    },
  ];
}

/**
 * Scans Markdown without resolving a logical root to a physical directory.
 *
 * A result marked `reparable` is syntactically unambiguous only. The caller
 * must still resolve the root, verify containment and revalidate the note
 * before applying a repair.
 */
export function scanCanonicalExternalReferences(
  source: string,
): ExternalReferenceScanResult {
  const root = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const excludedRanges = findExcludedHeadingRanges(root, source.length);
  const frontmatterRange = findFrontmatterRange(source);
  if (frontmatterRange) excludedRanges.push(frontmatterRange);

  const occurrences: ExternalReferenceOccurrence[] = [];
  visitParents(root, (node) => {
    if (node.type !== "paragraph") return;
    occurrences.push(...scanContainer(source, node, excludedRanges));
  });

  return {
    occurrences,
    reparable: occurrences.filter(
      (occurrence) => occurrence.classification === "reparable",
    ),
    manualReview: occurrences.filter(
      (occurrence) => occurrence.classification === "manualReview",
    ),
    ignored: occurrences.filter(
      (occurrence) => occurrence.classification === "ignored",
    ),
  };
}

/**
 * Builds exact, non-overlapping Markdown edits for an already reparable
 * occurrence. This helper deliberately does not resolve a logical root.
 * Callers must first prove that the old physical URI is the resolved
 * rootId/relativePath target, then revalidate the note before applying edits.
 */
export function buildCanonicalExternalReferenceRepairEdits(
  source: string,
  occurrence: ExternalReferenceOccurrence,
  target: CanonicalExternalReferenceRepairTarget,
): CanonicalExternalReferenceTextEdit[] {
  if (
    occurrence.classification !== "reparable" ||
    !occurrence.token ||
    !occurrence.fileLink
  ) {
    throw new Error(
      "Only a reparable canonical pair can produce repair edits.",
    );
  }
  assertRangeMatchesSource(source, occurrence.token.range);
  assertRangeMatchesSource(source, occurrence.fileLink.destinationRange);

  const encodedToken = encodeCanonicalExternalReference(
    target.rootId,
    target.relativePath,
  );
  validateRawFileUri(target.fileUrl);
  const targetUrl = new URL(target.fileUrl);
  if (
    targetUrl.protocol !== "file:" ||
    targetUrl.hostname !== "" ||
    targetUrl.search ||
    targetUrl.hash ||
    targetUrl.pathname.endsWith("/")
  ) {
    throw new Error("Repair target must be one local file URI without extras.");
  }
  const targetLocalPath = fileURLToPath(targetUrl);
  if (basename(target.relativePath) !== basename(targetLocalPath)) {
    throw new Error("Repair target token and file URI basenames do not match.");
  }

  return [
    {
      startOffset: occurrence.fileLink.destinationRange.start.offset,
      endOffset: occurrence.fileLink.destinationRange.end.offset,
      replacement: target.fileUrl,
    },
    {
      startOffset: occurrence.token.range.start.offset,
      endOffset: occurrence.token.range.end.offset,
      replacement: `\`${encodedToken}\``,
    },
  ].sort((left, right) => right.startOffset - left.startOffset);
}

function assertRangeMatchesSource(source: string, range: SourceRange): void {
  if (
    range.start.offset < 0 ||
    range.end.offset < range.start.offset ||
    range.end.offset > source.length
  ) {
    throw new Error("Occurrence range no longer matches the Markdown source.");
  }
}

export function applyCanonicalExternalReferenceRepair(
  source: string,
  occurrence: ExternalReferenceOccurrence,
  target: CanonicalExternalReferenceRepairTarget,
): string {
  const edits = buildCanonicalExternalReferenceRepairEdits(
    source,
    occurrence,
    target,
  );
  let updated = source;
  for (const edit of edits) {
    updated =
      updated.slice(0, edit.startOffset) +
      edit.replacement +
      updated.slice(edit.endOffset);
  }
  return updated;
}

export const canonicalExternalReference = {
  rootIdPattern: ROOT_ID_PATTERN,
  tokenPrefix: TOKEN_PREFIX,
};
