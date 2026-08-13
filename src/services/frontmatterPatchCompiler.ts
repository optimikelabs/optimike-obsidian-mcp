import { createHash } from "node:crypto";
import { load } from "js-yaml";
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

export type FrontmatterPatchProof = {
  contractVersion: 1;
  sourcePreservation: "byte-identical-outside-target-frontmatter-entries";
  lineEnding: "lf" | "crlf";
  changedKeys: string[];
  bodySha256: string;
  beforeFrontmatterSha256: string;
  afterFrontmatterSha256: string;
};

export type CompiledFrontmatterPatch = {
  nextContent: string;
  proof: FrontmatterPatchProof;
};

type Line = {
  start: number;
  end: number;
  endWithEol: number;
  text: string;
};

type Entry = {
  key: string;
  normalizedKey: string;
  start: number;
  end: number;
  startLineIndex: number;
};

type FrontmatterSource = {
  eol: "\n" | "\r\n";
  contentStart: number;
  contentEnd: number;
  closingEnd: number;
  body: string;
  lines: Line[];
  entries: Map<string, Entry>;
  appendOffset: number;
};

const BARE_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
const TOP_LEVEL_ENTRY = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*):(.*)$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, details);
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function splitLines(content: string, start: number, end: number): Line[] {
  const lines: Line[] = [];
  let cursor = start;
  while (cursor < end) {
    const newline = content.indexOf("\n", cursor);
    const endWithEol = newline >= 0 && newline < end ? newline + 1 : end;
    const rawEnd = newline >= 0 && newline < end ? newline : end;
    const raw = content.slice(cursor, rawEnd);
    lines.push({
      start: cursor,
      end: rawEnd,
      endWithEol,
      text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
    });
    cursor = endWithEol;
  }
  return lines;
}

function isTopLevelSeparator(line: Line): boolean {
  return line.text.trim() === "" || line.text.startsWith("#");
}

function parseFrontmatterSource(content: string): FrontmatterSource {
  const open = content.match(/^---(\r?\n)/u);
  if (!open) {
    fail(
      "P1 frontmatter patching requires an existing frontmatter block with a standard opening delimiter.",
      { reason: "frontmatter_missing" },
    );
  }
  const eol = open[1] as "\n" | "\r\n";
  const contentStart = open[0].length;

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

  const lines = splitLines(content, contentStart, closingStart);
  const starts: Array<{ key: string; normalizedKey: string; lineIndex: number }> = [];
  let activeEntry = false;
  const seen = new Set<string>();

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

  const entries = new Map<string, Entry>();
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
      startLineIndex: start.lineIndex,
    });
  }

  let appendOffset = closingStart;
  let trailing = lines.length - 1;
  while (trailing >= 0 && isTopLevelSeparator(lines[trailing])) {
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
  };
}

function renderJsonValue(value: FrontmatterJsonValue): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined || rendered.includes("\n") || rendered.includes("\r")) {
    fail("Frontmatter values must be JSON-serializable as one YAML line.", {
      reason: "unsupported_frontmatter_value",
    });
  }
  return rendered;
}

function validateOperations(operations: FrontmatterPatchOperation[]): void {
  if (operations.length === 0) {
    fail("At least one frontmatter patch operation is required.", {
      reason: "empty_patch",
    });
  }
  const seen = new Set<string>();
  for (const operation of operations) {
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
    if (operation.op === "set") renderJsonValue(operation.value);
  }
}

export function compileFrontmatterPatch(
  content: string,
  operations: FrontmatterPatchOperation[],
): CompiledFrontmatterPatch {
  validateOperations(operations);
  const source = parseFrontmatterSource(content);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const additions: string[] = [];
  const changedKeys: string[] = [];

  for (const operation of operations) {
    const normalized = normalizeKey(operation.key);
    const entry = source.entries.get(normalized);
    changedKeys.push(entry?.key ?? operation.key);

    if (operation.op === "delete") {
      if (!entry) {
        fail("Cannot delete a frontmatter key that does not exist.", {
          reason: "frontmatter_key_missing",
          key: operation.key,
        });
      }
      edits.push({ start: entry.start, end: entry.end, replacement: "" });
      continue;
    }

    const rendered = renderJsonValue(operation.value);
    if (entry) {
      edits.push({
        start: entry.start,
        end: entry.end,
        replacement: `${entry.key}: ${rendered}${source.eol}`,
      });
    } else {
      additions.push(`${operation.key}: ${rendered}${source.eol}`);
    }
  }

  if (additions.length > 0) {
    edits.push({
      start: source.appendOffset,
      end: source.appendOffset,
      replacement: additions.join(""),
    });
  }

  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index - 1].start < edits[index].end) {
      fail("Compiled frontmatter edits overlap unexpectedly.", {
        reason: "overlapping_patch_ranges",
      });
    }
  }

  let nextContent = content;
  for (const edit of edits) {
    nextContent = `${nextContent.slice(0, edit.start)}${edit.replacement}${nextContent.slice(edit.end)}`;
  }

  const after = parseFrontmatterSource(nextContent);
  if (after.body !== source.body) {
    fail("Frontmatter projection changed Markdown body bytes.", {
      reason: "body_drift",
    });
  }

  return {
    nextContent,
    proof: {
      contractVersion: 1,
      sourcePreservation: "byte-identical-outside-target-frontmatter-entries",
      lineEnding: source.eol === "\r\n" ? "crlf" : "lf",
      changedKeys,
      bodySha256: sha256(source.body),
      beforeFrontmatterSha256: sha256(
        content.slice(source.contentStart, source.contentEnd),
      ),
      afterFrontmatterSha256: sha256(
        nextContent.slice(after.contentStart, after.contentEnd),
      ),
    },
  };
}
