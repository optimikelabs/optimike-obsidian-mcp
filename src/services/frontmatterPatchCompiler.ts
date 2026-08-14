import { createHash } from "node:crypto";
import { load } from "js-yaml";
import { operationDigest } from "./operations/contract.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";

export type FrontmatterJsonValue =
  | null
  | boolean
  | number
  | string
  | FrontmatterJsonValue[]
  | { [key: string]: FrontmatterJsonValue };

export type FrontmatterPatchOperation =
  | { op: "set"; key: string; value: FrontmatterJsonValue }
  | { op: "delete"; key: string };

export type FrontmatterAuthorizedRange = {
  key: string;
  operation: "set" | "delete";
  start: number;
  end: number;
  beforeSha256: string;
  afterSha256: string;
};

export type FrontmatterPatchProof = {
  contractVersion: 1;
  compilerVersion: 1;
  sourcePreservation: "byte-identical-outside-authorized-frontmatter-ranges";
  lineEnding: "lf" | "crlf";
  patchDigest: string;
  changedKeys: string[];
  authorizedRanges: FrontmatterAuthorizedRange[];
  bodySha256: string;
  beforeFrontmatterSha256: string;
  afterFrontmatterSha256: string;
  untouchedSourceSha256: string;
};

export type CompiledFrontmatterPatch = {
  operations: FrontmatterPatchOperation[];
  nextContent: string;
  proof: FrontmatterPatchProof;
};

type SourceLine = {
  start: number;
  end: number;
  endWithEol: number;
  text: string;
};

type SourceEntry = {
  key: string;
  normalizedKey: string;
  start: number;
  end: number;
};

type FrontmatterSource = {
  eol: "\n" | "\r\n";
  contentStart: number;
  contentEnd: number;
  closingEnd: number;
  body: string;
  lines: SourceLine[];
  entries: Map<string, SourceEntry>;
  appendOffset: number;
  trailingCommentIsAmbiguous: boolean;
};

type Edit = {
  key: string;
  operation: "set" | "delete";
  start: number;
  end: number;
  replacement: string;
};

const BARE_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
const TOP_LEVEL_ENTRY = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*):(.*)$/u;
const MAX_OPERATIONS = 64;
const MAX_VALUE_DEPTH = 24;
const MAX_RENDERED_VALUE_BYTES = 256 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, details);
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function splitLines(content: string, start: number, end: number): SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = start;
  while (cursor < end) {
    const newline = content.indexOf("\n", cursor);
    const hasEol = newline >= 0 && newline < end;
    const rawEnd = hasEol ? newline : end;
    const raw = content.slice(cursor, rawEnd);
    lines.push({
      start: cursor,
      end: rawEnd,
      endWithEol: hasEol ? newline + 1 : end,
      text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
    });
    cursor = hasEol ? newline + 1 : end;
  }
  return lines;
}

function isTopLevelSeparator(line: SourceLine): boolean {
  return line.text.trim() === "" || line.text.startsWith("#");
}

function stripQuotedAndComment(text: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of text) {
    if (quote === '"') {
      if (escaped) {
        escaped = false;
        result += " ";
        continue;
      }
      if (character === "\\") {
        escaped = true;
        result += " ";
        continue;
      }
      if (character === '"') quote = undefined;
      result += " ";
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      result += " ";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += " ";
      continue;
    }
    if (character === "#") break;
    result += character;
  }
  return result;
}

function rejectUnsupportedYamlFeatures(lines: SourceLine[]): void {
  for (const [index, line] of lines.entries()) {
    const code = stripQuotedAndComment(line.text);
    if (/^\s*<<\s*:/u.test(code)) {
      fail("YAML merge keys are outside the P1 source-preserving subset.", {
        reason: "yaml_merge_key_unsupported",
        line: index + 2,
      });
    }
    if (/(^|[\s[{:,-])&[\p{L}\p{N}_-]+/u.test(code)) {
      fail("YAML anchors are outside the P1 source-preserving subset.", {
        reason: "yaml_anchor_unsupported",
        line: index + 2,
      });
    }
    if (/(^|[\s[{:,-])\*[\p{L}\p{N}_-]+/u.test(code)) {
      fail("YAML aliases are outside the P1 source-preserving subset.", {
        reason: "yaml_alias_unsupported",
        line: index + 2,
      });
    }
    if (/(^|[\s[{:,-])![^\s,[\]{}]+/u.test(code)) {
      fail("Explicit YAML tags are outside the P1 source-preserving subset.", {
        reason: "yaml_tag_unsupported",
        line: index + 2,
      });
    }
    if (code.trim() === "...") {
      fail("Multi-document YAML is outside the P1 source-preserving subset.", {
        reason: "yaml_multi_document_unsupported",
        line: index + 2,
      });
    }
  }
}

function parseFrontmatterSource(content: string): FrontmatterSource {
  const opening = content.match(/^---(\r?\n)/u);
  if (!opening) {
    fail(
      "Governed frontmatter patching requires an existing standard frontmatter block.",
      { reason: "frontmatter_missing" },
    );
  }
  const eol = opening[1] as "\n" | "\r\n";
  const contentStart = opening[0].length;

  let closingStart = -1;
  let closingEnd = -1;
  let cursor = contentStart;
  while (cursor <= content.length) {
    const newline = content.indexOf("\n", cursor);
    const rawEnd = newline >= 0 ? newline : content.length;
    const raw = content.slice(cursor, rawEnd);
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "---") {
      closingStart = cursor;
      closingEnd = newline >= 0 ? newline + 1 : rawEnd;
      break;
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  if (closingStart < 0) {
    fail("Frontmatter opening delimiter has no closing delimiter.", {
      reason: "frontmatter_unclosed",
    });
  }

  const source = content.slice(contentStart, closingStart);
  const lines = splitLines(content, contentStart, closingStart);
  rejectUnsupportedYamlFeatures(lines);

  let parsed: unknown;
  try {
    parsed = load(source);
  } catch (error) {
    fail("Frontmatter YAML is not safe to patch structurally.", {
      reason: "frontmatter_yaml_invalid",
      parserMessage: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    parsed !== undefined &&
    parsed !== null &&
    (typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    fail("Frontmatter must be a YAML mapping.", {
      reason: "frontmatter_not_mapping",
    });
  }

  const starts: Array<{
    key: string;
    normalizedKey: string;
    lineIndex: number;
  }> = [];
  const seen = new Set<string>();
  let activeEntry = false;

  for (const [lineIndex, line] of lines.entries()) {
    if (isTopLevelSeparator(line)) continue;
    if (/^[ \t]/u.test(line.text)) {
      if (!activeEntry) {
        fail("Indented YAML appeared before any supported top-level key.", {
          reason: "unsupported_yaml_layout",
          line: lineIndex + 2,
        });
      }
      continue;
    }
    const match = line.text.match(TOP_LEVEL_ENTRY);
    if (!match) {
      fail(
        "P1 only patches conservative top-level bare-key YAML. Unsupported top-level syntax was found.",
        { reason: "unsupported_top_level_yaml", line: lineIndex + 2 },
      );
    }
    const key = match[1];
    const normalizedKey = normalizeKey(key);
    if (seen.has(normalizedKey)) {
      fail("Duplicate or case-colliding frontmatter keys are not patchable.", {
        reason: "duplicate_frontmatter_key",
        key,
      });
    }
    seen.add(normalizedKey);
    starts.push({ key, normalizedKey, lineIndex });
    activeEntry = true;
  }

  const entries = new Map<string, SourceEntry>();
  for (const [index, start] of starts.entries()) {
    const startLine = lines[start.lineIndex];
    const nextStartLineIndex = starts[index + 1]?.lineIndex ?? lines.length;
    let lastOwnedLineIndex = nextStartLineIndex - 1;
    while (
      lastOwnedLineIndex > start.lineIndex &&
      isTopLevelSeparator(lines[lastOwnedLineIndex])
    ) {
      lastOwnedLineIndex -= 1;
    }
    const end = lines[lastOwnedLineIndex]?.endWithEol ?? startLine.endWithEol;
    entries.set(start.normalizedKey, {
      key: start.key,
      normalizedKey: start.normalizedKey,
      start: startLine.start,
      end,
    });
  }

  let appendOffset = closingStart;
  let trailing = lines.length - 1;
  let trailingCommentIsAmbiguous = false;
  while (trailing >= 0 && isTopLevelSeparator(lines[trailing])) {
    if (lines[trailing].text.startsWith("#")) {
      trailingCommentIsAmbiguous = true;
    }
    appendOffset = lines[trailing].start;
    trailing -= 1;
  }

  return {
    eol,
    contentStart,
    contentEnd: closingStart,
    closingEnd,
    body: content.slice(closingEnd),
    lines,
    entries,
    appendOffset,
    trailingCommentIsAmbiguous,
  };
}

function canonicalizeValue(
  value: FrontmatterJsonValue,
  depth = 0,
): FrontmatterJsonValue {
  if (depth > MAX_VALUE_DEPTH) {
    fail("Frontmatter value exceeds the supported nesting depth.", {
      reason: "frontmatter_value_too_deep",
    });
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    fail("Frontmatter numbers must be finite.", {
      reason: "frontmatter_number_non_finite",
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeValue(item, depth + 1)]),
    );
  }
  return value;
}

function renderJsonValue(value: FrontmatterJsonValue): string {
  const rendered = JSON.stringify(canonicalizeValue(value));
  if (rendered === undefined || rendered.includes("\n") || rendered.includes("\r")) {
    fail("Frontmatter values must be JSON-compatible and render on one YAML line.", {
      reason: "unsupported_frontmatter_value",
    });
  }
  if (Buffer.byteLength(rendered, "utf8") > MAX_RENDERED_VALUE_BYTES) {
    fail("Frontmatter value exceeds the P1 compiler size limit.", {
      reason: "frontmatter_value_too_large",
    });
  }
  return rendered;
}

export function canonicalizeFrontmatterPatchOperations(
  operations: FrontmatterPatchOperation[],
): FrontmatterPatchOperation[] {
  if (operations.length === 0) {
    fail("At least one frontmatter patch operation is required.", {
      reason: "empty_patch",
    });
  }
  if (operations.length > MAX_OPERATIONS) {
    fail(`A P1 patch supports at most ${MAX_OPERATIONS} operations.`, {
      reason: "too_many_patch_operations",
      maxOperations: MAX_OPERATIONS,
    });
  }
  const seen = new Set<string>();
  const canonical = operations.map((operation) => {
    if (!BARE_KEY.test(operation.key)) {
      fail(
        "P1 only supports top-level bare frontmatter keys made of letters, digits, underscore, dot, or hyphen.",
        { reason: "unsupported_frontmatter_key", key: operation.key },
      );
    }
    const normalized = normalizeKey(operation.key);
    if (seen.has(normalized)) {
      fail("A P1 patch may target each frontmatter key at most once.", {
        reason: "duplicate_patch_target",
        key: operation.key,
      });
    }
    seen.add(normalized);
    return operation.op === "set"
      ? {
          op: "set" as const,
          key: operation.key,
          value: canonicalizeValue(operation.value),
        }
      : { op: "delete" as const, key: operation.key };
  });
  return canonical.sort((left, right) => {
    const normalized = normalizeKey(left.key).localeCompare(normalizeKey(right.key));
    return normalized || left.key.localeCompare(right.key);
  });
}

function applyEdits(
  content: string,
  edits: Edit[],
): { nextContent: string; untouchedSource: string } {
  const ascending = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let cursor = 0;
  let nextContent = "";
  let untouchedSource = "";
  for (const edit of ascending) {
    if (edit.start < cursor) {
      fail("Compiled frontmatter edits overlap unexpectedly.", {
        reason: "overlapping_patch_ranges",
      });
    }
    const untouched = content.slice(cursor, edit.start);
    untouchedSource += untouched;
    nextContent += untouched;
    nextContent += edit.replacement;
    cursor = edit.end;
  }
  const tail = content.slice(cursor);
  untouchedSource += tail;
  nextContent += tail;
  return { nextContent, untouchedSource };
}

export function compileFrontmatterPatch(
  content: string,
  operations: FrontmatterPatchOperation[],
): CompiledFrontmatterPatch {
  const canonicalOperations = canonicalizeFrontmatterPatchOperations(operations);
  const source = parseFrontmatterSource(content);
  const edits: Edit[] = [];
  const additions: string[] = [];

  for (const operation of canonicalOperations) {
    const normalized = normalizeKey(operation.key);
    const entry = source.entries.get(normalized);
    if (operation.op === "delete") {
      if (!entry) {
        fail("Cannot delete a frontmatter key that does not exist.", {
          reason: "frontmatter_key_missing",
          key: operation.key,
        });
      }
      edits.push({
        key: entry.key,
        operation: "delete",
        start: entry.start,
        end: entry.end,
        replacement: "",
      });
      continue;
    }

    const rendered = renderJsonValue(operation.value);
    if (entry) {
      edits.push({
        key: entry.key,
        operation: "set",
        start: entry.start,
        end: entry.end,
        replacement: `${entry.key}: ${rendered}${source.eol}`,
      });
    } else {
      additions.push(`${operation.key}: ${rendered}${source.eol}`);
    }
  }

  if (additions.length > 0) {
    if (source.trailingCommentIsAmbiguous) {
      fail(
        "Cannot insert a new key while trailing frontmatter comments have ambiguous ownership.",
        { reason: "ambiguous_trailing_comment" },
      );
    }
    edits.push({
      key: canonicalOperations
        .filter((operation) =>
          operation.op === "set" && !source.entries.has(normalizeKey(operation.key)),
        )
        .map((operation) => operation.key)
        .join(","),
      operation: "set",
      start: source.appendOffset,
      end: source.appendOffset,
      replacement: additions.join(""),
    });
  }

  const { nextContent, untouchedSource } = applyEdits(content, edits);
  const after = parseFrontmatterSource(nextContent);
  if (after.body !== source.body) {
    fail("Frontmatter projection changed Markdown body bytes.", {
      reason: "body_drift",
    });
  }

  const authorizedRanges = edits
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((edit) => ({
      key: edit.key,
      operation: edit.operation,
      start: edit.start,
      end: edit.end,
      beforeSha256: sha256(content.slice(edit.start, edit.end)),
      afterSha256: sha256(edit.replacement),
    }));

  return {
    operations: canonicalOperations,
    nextContent,
    proof: {
      contractVersion: 1,
      compilerVersion: 1,
      sourcePreservation:
        "byte-identical-outside-authorized-frontmatter-ranges",
      lineEnding: source.eol === "\r\n" ? "crlf" : "lf",
      patchDigest: operationDigest({ operations: canonicalOperations }),
      changedKeys: canonicalOperations.map((operation) => operation.key),
      authorizedRanges,
      bodySha256: sha256(source.body),
      beforeFrontmatterSha256: sha256(
        content.slice(source.contentStart, source.contentEnd),
      ),
      afterFrontmatterSha256: sha256(
        nextContent.slice(after.contentStart, after.contentEnd),
      ),
      untouchedSourceSha256: sha256(untouchedSource),
    },
  };
}
