import { createHash } from "node:crypto";
import { BaseErrorCode, McpError } from "../types-global/errors.js";

export type TextPatchOperation =
  | { op: "append_body"; text: string }
  | { op: "prepend_body"; text: string }
  | {
      op: "replace_literal";
      search: string;
      replacement: string;
      occurrence?: "unique" | "all";
      intent?: "replace_all";
    };

export type TextPatchAuthorizedRange = {
  operationIndex: number;
  coordinateSpace: "operation-input-content";
  op: TextPatchOperation["op"];
  start: number;
  end: number;
  beforeSha256: string;
  afterSha256: string;
  stepBeforeBodySha256: string;
  stepAfterBodySha256: string;
  occurrenceCount?: number;
};

export type TextPatchProof = {
  contractVersion: 1;
  compilerVersion: 1;
  sourcePreservation: "byte-identical-outside-authorized-body-ranges";
  lineEnding: "lf" | "crlf" | "mixed";
  patchDigest: string;
  operationCount: number;
  authorizedRanges: TextPatchAuthorizedRange[];
  beforeContentSha256: string;
  nextContentSha256: string;
  beforeFrontmatterSha256: string;
  afterFrontmatterSha256: string;
  beforeBodySha256: string;
  afterBodySha256: string;
  preservedFrontmatterSha256: string;
};

export type CompiledTextPatch = {
  operations: TextPatchOperation[];
  nextContent: string;
  proof: TextPatchProof;
};

type ParsedMarkdown = {
  bodyStart: number;
  frontmatter: string;
  body: string;
};

const MAX_OPERATIONS = 32;
const MAX_AUTHORIZED_RANGES = 64;
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_TEXT_BYTES = 256 * 1024;
const MAX_TOTAL_OPERATION_TEXT_BYTES = 1024 * 1024;
const TASK_LINE = /^[\t ]*[-*+]\s*\[[^\]\r\n]\]/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(message: string, reason: string, details: Record<string, unknown> = {}): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, {
    reason,
    ...details,
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function detectLineEnding(content: string): "lf" | "crlf" | "mixed" {
  const crlfCount = (content.match(/\r\n/gu) ?? []).length;
  const lfCount = (content.match(/\n/gu) ?? []).length;
  if (crlfCount === 0) return "lf";
  return crlfCount === lfCount ? "crlf" : "mixed";
}

function parseMarkdown(content: string): ParsedMarkdown {
  if (typeof content !== "string" || byteLength(content) === 0) {
    fail("A non-empty existing Markdown note is required.", "markdown_note_missing");
  }
  if (byteLength(content) > MAX_NOTE_BYTES) {
    fail("The Markdown note exceeds the P4 compiler size limit.", "markdown_note_too_large", {
      maxBytes: MAX_NOTE_BYTES,
    });
  }

  const opening = content.match(/^---(?:\r\n|\n)/u);
  if (!opening) {
    return { bodyStart: 0, frontmatter: "", body: content };
  }

  let cursor = opening[0].length;
  while (cursor <= content.length) {
    const newline = content.indexOf("\n", cursor);
    const rawEnd = newline === -1 ? content.length : newline;
    const raw = content.slice(cursor, rawEnd);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "---") {
      const bodyStart = newline === -1 ? rawEnd : newline + 1;
      return {
        bodyStart,
        frontmatter: content.slice(0, bodyStart),
        body: content.slice(bodyStart),
      };
    }
    if (newline === -1) break;
    cursor = newline + 1;
  }
  fail("The Markdown frontmatter opening delimiter is not closed.", "frontmatter_unclosed");
}

function validatePath(path: unknown): void {
  if (path === undefined) return;
  if (typeof path !== "string" || !/\.md$/iu.test(path.trim())) {
    fail("The target must be an existing Markdown note path.", "markdown_path_invalid");
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (value instanceof RegExp) {
    fail("Regular expressions are not supported by literal text patches.", "regex_unsupported", { field });
  }
  if (typeof value !== "string") {
    fail("Text patch values must be strings.", "text_patch_value_invalid", { field });
  }
}

function assertOperationText(value: string, field: string): void {
  if (byteLength(value) > MAX_OPERATION_TEXT_BYTES) {
    fail("A text patch value exceeds the P4 compiler size limit.", "text_patch_value_too_large", {
      field,
      maxBytes: MAX_OPERATION_TEXT_BYTES,
    });
  }
}

function canonicalizeOperations(operations: unknown): TextPatchOperation[] {
  if (!Array.isArray(operations) || operations.length === 0) {
    fail("At least one text patch operation is required.", "empty_patch");
  }
  if (operations.length > MAX_OPERATIONS) {
    fail("The P4 compiler supports a bounded number of operations.", "too_many_patch_operations", {
      maxOperations: MAX_OPERATIONS,
    });
  }

  let totalTextBytes = 0;
  const canonical = operations.map((candidate, index): TextPatchOperation => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      fail("Each text patch operation must be an object.", "text_patch_operation_invalid", { index });
    }
    const operation = candidate as Record<string, unknown>;
    if (operation.op === "append_body" || operation.op === "prepend_body") {
      assertString(operation.text, "text");
      assertOperationText(operation.text, "text");
      if (operation.text.length === 0) {
        fail("Append and prepend text must not be empty.", "empty_patch_text", { index });
      }
      totalTextBytes += byteLength(operation.text);
      return { op: operation.op, text: operation.text };
    }
    if (operation.op === "replace_literal") {
      assertString(operation.search, "search");
      assertString(operation.replacement, "replacement");
      assertOperationText(operation.search, "search");
      assertOperationText(operation.replacement, "replacement");
      if (operation.search.length === 0) {
        fail("Literal replacement search text must not be empty.", "empty_literal_search", { index });
      }
      const occurrence = operation.occurrence ?? "unique";
      if (occurrence !== "unique" && occurrence !== "all") {
        fail("Literal replacement occurrence must be unique or all.", "literal_occurrence_invalid", { index });
      }
      if (operation.intent !== undefined && operation.intent !== "replace_all") {
        fail("Literal replacement intent is invalid.", "literal_intent_invalid", { index });
      }
      if (occurrence === "all" && operation.intent !== "replace_all") {
        fail("Replacing all occurrences requires an explicit sealed intent.", "replace_all_intent_required", { index });
      }
      if (occurrence !== "all" && operation.intent !== undefined) {
        fail("replace_all intent is only valid for an all-occurrence replacement.", "replace_all_intent_mismatch", { index });
      }
      totalTextBytes += byteLength(operation.search) + byteLength(operation.replacement);
      return {
        op: "replace_literal",
        search: operation.search,
        replacement: operation.replacement,
        occurrence,
        ...(operation.intent === "replace_all" ? { intent: "replace_all" as const } : {}),
      };
    }
    fail("The requested text patch operation is not supported.", "text_patch_operation_unsupported", { index });
  });

  if (totalTextBytes > MAX_TOTAL_OPERATION_TEXT_BYTES) {
    fail("Combined text patch values exceed the P4 compiler size limit.", "text_patch_total_too_large", {
      maxBytes: MAX_TOTAL_OPERATION_TEXT_BYTES,
    });
  }
  return canonical;
}

function taskLineRanges(body: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  while (cursor < body.length) {
    const newline = body.indexOf("\n", cursor);
    const endWithEol = newline === -1 ? body.length : newline + 1;
    const raw = body.slice(cursor, newline === -1 ? body.length : newline);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (fence) {
      const closing = new RegExp(
        `^ {0,3}${fence.marker === "`" ? "`" : "~"}{${fence.length},}[\\t ]*$`,
        "u",
      );
      if (closing.test(line)) fence = undefined;
    } else {
      const opening = FENCE_OPEN.exec(line);
      if (opening) {
        fence = {
          marker: opening[1][0] as "`" | "~",
          length: opening[1].length,
        };
      } else if (TASK_LINE.test(line)) {
        ranges.push({ start: cursor, end: endWithEol });
      }
    }
    cursor = endWithEol;
  }
  return ranges;
}

function insertedTextHasTaskLine(text: string): boolean {
  return taskLineRanges(text).length > 0;
}

function assertNoTaskRange(body: string, start: number, end: number): void {
  for (const task of taskLineRanges(body)) {
    if (start === end) {
      const insideTask = start >= task.start && start < task.end;
      const terminalTaskBoundary = task.end === body.length && start === task.end;
      if (insideTask || terminalTaskBoundary) {
        fail("P4 refuses to touch a Markdown task or Operon task line.", "task_line_touched");
      }
      continue;
    }
    if (start < task.end && end > task.start) {
      fail("P4 refuses to touch a Markdown task or Operon task line.", "task_line_touched");
    }
  }
}

function assertNoInsertedTaskLine(text: string): void {
  if (insertedTextHasTaskLine(text)) {
    fail("P4 refuses to introduce a Markdown task or Operon task line.", "task_line_touched");
  }
}

function bodyStartsWithTaskLine(body: string): boolean {
  return taskLineRanges(body).some((range) => range.start === 0);
}

function bodyEndsWithTaskLine(body: string): boolean {
  return (
    !body.endsWith("\n") &&
    taskLineRanges(body).some((range) => range.end === body.length)
  );
}

function occurrences(body: string, search: string): number[] {
  const offsets: number[] = [];
  let start = 0;
  while (start <= body.length - search.length) {
    const offset = body.indexOf(search, start);
    if (offset === -1) break;
    offsets.push(offset);
    start = offset + search.length;
  }
  return offsets;
}

function patchDigest(operations: TextPatchOperation[]): string {
  return sha256(JSON.stringify({ operations }));
}

export function compileTextPatch(
  content: string,
  operations: TextPatchOperation[],
  path?: string,
): CompiledTextPatch {
  validatePath(path);
  const markdown = parseMarkdown(content);
  const canonicalOperations = canonicalizeOperations(operations);
  let body = markdown.body;
  const authorizedRanges: TextPatchAuthorizedRange[] = [];

  for (const [operationIndex, operation] of canonicalOperations.entries()) {
    const stepBeforeBodySha256 = sha256(body);
    if (operation.op === "append_body") {
      assertNoInsertedTaskLine(operation.text);
      if (
        bodyEndsWithTaskLine(body) &&
        !operation.text.startsWith("\n") &&
        !operation.text.startsWith("\r\n")
      ) {
        fail("P4 refuses to extend a Markdown task or Operon task line.", "task_line_touched");
      }
      const start = markdown.bodyStart + body.length;
      body += operation.text;
      authorizedRanges.push({
        operationIndex,
        coordinateSpace: "operation-input-content",
        op: operation.op,
        start,
        end: start,
        beforeSha256: sha256(""),
        afterSha256: sha256(operation.text),
        stepBeforeBodySha256,
        stepAfterBodySha256: sha256(body),
      });
      continue;
    }

    if (operation.op === "prepend_body") {
      assertNoInsertedTaskLine(operation.text);
      if (
        bodyStartsWithTaskLine(body) &&
        !operation.text.endsWith("\n")
      ) {
        fail("P4 refuses to extend a Markdown task or Operon task line.", "task_line_touched");
      }
      body = operation.text + body;
      authorizedRanges.push({
        operationIndex,
        coordinateSpace: "operation-input-content",
        op: operation.op,
        start: markdown.bodyStart,
        end: markdown.bodyStart,
        beforeSha256: sha256(""),
        afterSha256: sha256(operation.text),
        stepBeforeBodySha256,
        stepAfterBodySha256: sha256(body),
      });
      continue;
    }

    const matches = occurrences(body, operation.search);
    if (matches.length === 0) {
      fail("The literal replacement target was not found in the note body.", "literal_not_found");
    }
    if (operation.occurrence !== "all" && matches.length !== 1) {
      fail("The literal replacement target must occur exactly once by default.", "literal_not_unique", {
        occurrenceCount: matches.length,
      });
    }
    const selected = operation.occurrence === "all" ? matches : [matches[0]];
    if (authorizedRanges.length + selected.length > MAX_AUTHORIZED_RANGES) {
      fail(
        "The text patch expands to too many authorized source ranges.",
        "too_many_authorized_ranges",
        { maxAuthorizedRanges: MAX_AUTHORIZED_RANGES },
      );
    }
    for (const start of selected) {
      assertNoTaskRange(body, start, start + operation.search.length);
    }
    const stepRanges = selected.map((start) => ({
      operationIndex,
      coordinateSpace: "operation-input-content" as const,
      op: operation.op,
      start: markdown.bodyStart + start,
      end: markdown.bodyStart + start + operation.search.length,
      beforeSha256: sha256(operation.search),
      afterSha256: sha256(operation.replacement),
      occurrenceCount: operation.occurrence === "all" ? matches.length : undefined,
    }));
    for (const start of [...selected].sort((left, right) => right - left)) {
      const candidate =
        body.slice(0, start) +
        operation.replacement +
        body.slice(start + operation.search.length);
      if (operation.replacement.length > 0) {
        assertNoTaskRange(
          candidate,
          start,
          start + operation.replacement.length,
        );
      }
      body = candidate;
    }
    const stepAfterBodySha256 = sha256(body);
    authorizedRanges.push(
      ...stepRanges.map((range) => ({
        ...range,
        stepBeforeBodySha256,
        stepAfterBodySha256,
      })),
    );
  }

  const nextContent = markdown.frontmatter + body;
  const beforeFrontmatterSha256 = sha256(markdown.frontmatter);
  const afterFrontmatterSha256 = sha256(nextContent.slice(0, markdown.bodyStart));
  if (beforeFrontmatterSha256 !== afterFrontmatterSha256) {
    fail("P4 cannot alter Markdown frontmatter.", "frontmatter_touched");
  }

  return {
    operations: canonicalOperations,
    nextContent,
    proof: {
      contractVersion: 1,
      compilerVersion: 1,
      sourcePreservation: "byte-identical-outside-authorized-body-ranges",
      lineEnding: detectLineEnding(content),
      patchDigest: patchDigest(canonicalOperations),
      operationCount: canonicalOperations.length,
      authorizedRanges,
      beforeContentSha256: sha256(content),
      nextContentSha256: sha256(nextContent),
      beforeFrontmatterSha256,
      afterFrontmatterSha256,
      beforeBodySha256: sha256(markdown.body),
      afterBodySha256: sha256(body),
      preservedFrontmatterSha256: beforeFrontmatterSha256,
    },
  };
}
