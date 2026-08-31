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
const TASK_LINE = /^[\s\t>]*(?:[-*+]|[0-9]+[.)])[ \t]*\[(.)\]/u;
const COMMONMARK_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

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

function assertNoBareCarriageReturns(value: string): void {
  if (/\r(?!\n)/u.test(value)) {
    fail("P4 does not support bare carriage-return line endings.", "markdown_line_ending_unsupported");
  }
}

function assertSupportedMarkdownEnvelope(value: string): void {
  assertNoBareCarriageReturns(value);
  if (value.startsWith("\uFEFF")) {
    fail("P4 does not support UTF-8 byte order marks.", "markdown_bom_unsupported");
  }
}

function detectLineEnding(content: string): "lf" | "crlf" | "mixed" {
  const crlfCount = (content.match(/\r\n/gu) ?? []).length;
  const lfCount = (content.match(/\n/gu) ?? []).length;
  if (crlfCount === 0) return "lf";
  return crlfCount === lfCount ? "crlf" : "mixed";
}

function parseMarkdownStructure(content: string): ParsedMarkdown {
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

function parseMarkdown(content: string): ParsedMarkdown {
  if (typeof content !== "string") {
    fail("An existing Markdown note is required.", "markdown_note_missing");
  }
  assertSupportedMarkdownEnvelope(content);
  if (byteLength(content) > MAX_NOTE_BYTES) {
    fail("The Markdown note exceeds the P4 compiler size limit.", "markdown_note_too_large", {
      maxBytes: MAX_NOTE_BYTES,
    });
  }
  return parseMarkdownStructure(content);
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
  assertNoBareCarriageReturns(value);
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

type TaskLine = {
  start: number;
  end: number;
  normalizedText: string;
  commonMarkReal: boolean;
  operonReal: boolean;
};

type SourceEdit = {
  start: number;
  end: number;
  replacement: string;
};

type CommonMarkFence = {
  marker: "`" | "~";
  length: number;
};

function commonMarkFenceOpen(line: string): CommonMarkFence | undefined {
  const opening = COMMONMARK_FENCE_OPEN.exec(line);
  if (!opening) return undefined;
  const marker = opening[1][0] as CommonMarkFence["marker"];
  // CommonMark rejects a backtick-fence opener whose info string itself has a backtick.
  if (marker === "`" && opening[2].includes("`")) return undefined;
  return { marker, length: opening[1].length };
}

function isCommonMarkFenceClose(line: string, fence: CommonMarkFence): boolean {
  return new RegExp(
    `^ {0,3}${fence.marker === "`" ? "`" : "~"}{${fence.length},}[\\t ]*$`,
    "u",
  ).test(line);
}

function isOperonFenceDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function taskLines(body: string): TaskLine[] {
  const ranges: TaskLine[] = [];
  let cursor = 0;
  let commonMarkFence: CommonMarkFence | undefined;
  let operonFence = false;
  while (cursor < body.length) {
    const newline = body.indexOf("\n", cursor);
    const endWithEol = newline === -1 ? body.length : newline + 1;
    const raw = body.slice(cursor, newline === -1 ? body.length : newline);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // P4 protects any task real under CommonMark-like parsing OR Operon's toggle parser.
    // Model-specific states are part of identity, so a fence edit cannot reclassify one model.
    const commonMarkReal = !commonMarkFence;
    const operonReal = !operonFence;
    if ((commonMarkReal || operonReal) && TASK_LINE.test(line)) {
      ranges.push({
        start: cursor,
        end: endWithEol,
        normalizedText: line.replace(/\r$/u, ""),
        commonMarkReal,
        operonReal,
      });
    }
    if (commonMarkFence) {
      if (isCommonMarkFenceClose(line, commonMarkFence)) commonMarkFence = undefined;
    } else {
      commonMarkFence = commonMarkFenceOpen(line);
    }
    if (isOperonFenceDelimiter(line)) operonFence = !operonFence;
    cursor = endWithEol;
  }
  return ranges;
}

function taskLineRanges(body: string): Array<{ start: number; end: number }> {
  return taskLines(body).map(({ start, end }) => ({ start, end }));
}

function mappedTaskStart(start: number, edits: SourceEdit[]): number {
  return edits.reduce((mappedStart, edit) => {
    if (edit.end <= start) {
      return mappedStart + edit.replacement.length - (edit.end - edit.start);
    }
    return mappedStart;
  }, start);
}

function assertSourceEditsDoNotOverlapTasks(body: string, edits: SourceEdit[]): void {
  for (const edit of edits) {
    for (const task of taskLineRanges(body)) {
      const insertionInsideTask =
        edit.start === edit.end && edit.start > task.start && edit.start < task.end;
      const rangeOverlapsTask =
        edit.start !== edit.end && edit.start < task.end && edit.end > task.start;
      if (insertionInsideTask || rangeOverlapsTask) {
        fail("P4 refuses to touch a Markdown task or Operon task line.", "task_line_touched");
      }
    }
  }
}

function assertTaskIdentityPreserved(
  beforeBody: string,
  afterBody: string,
  edits: SourceEdit[],
): void {
  const before = taskLines(beforeBody);
  assertSourceEditsDoNotOverlapTasks(beforeBody, edits);
  const after = taskLines(afterBody);
  if (before.length !== after.length) {
    fail("P4 refuses to change the parsed Markdown task lines.", "task_line_touched");
  }
  for (const [index, task] of before.entries()) {
    const mappedStart = mappedTaskStart(task.start, edits);
    const nextTask = after[index];
    if (
      nextTask.start !== mappedStart ||
      nextTask.normalizedText !== task.normalizedText ||
      nextTask.commonMarkReal !== task.commonMarkReal ||
      nextTask.operonReal !== task.operonReal
    ) {
      fail("P4 refuses to reclassify or reorder parsed Markdown task lines.", "task_line_touched");
    }
  }
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
    const stepBeforeBody = body;
    const stepBeforeBodySha256 = sha256(body);
    if (operation.op === "append_body") {
      if (
        bodyEndsWithTaskLine(body) &&
        !operation.text.startsWith("\n") &&
        !operation.text.startsWith("\r\n")
      ) {
        fail("P4 refuses to extend a Markdown task or Operon task line.", "task_line_touched");
      }
      const start = markdown.bodyStart + body.length;
      const candidate = body + operation.text;
      if (
        !operation.text.startsWith("\n") &&
        !operation.text.startsWith("\r\n")
      ) {
        assertNoTaskRange(candidate, body.length, body.length);
      }
      assertTaskIdentityPreserved(body, candidate, [{
        start: body.length,
        end: body.length,
        replacement: operation.text,
      }]);
      body = candidate;
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
      if (
        bodyStartsWithTaskLine(body) &&
        !operation.text.endsWith("\n")
      ) {
        fail("P4 refuses to extend a Markdown task or Operon task line.", "task_line_touched");
      }
      const candidate = operation.text + body;
      if (!operation.text.endsWith("\n")) {
        assertNoTaskRange(candidate, operation.text.length, operation.text.length);
      }
      assertTaskIdentityPreserved(body, candidate, [{
        start: 0,
        end: 0,
        replacement: operation.text,
      }]);
      body = candidate;
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
    const sourceEdits = selected.map((start) => ({
      start,
      end: start + operation.search.length,
      replacement: operation.replacement,
    }));
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
    assertTaskIdentityPreserved(stepBeforeBody, body, sourceEdits);
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
  assertSupportedMarkdownEnvelope(nextContent);
  const beforeFrontmatterSha256 = sha256(markdown.frontmatter);
  let nextMarkdown: ParsedMarkdown;
  try {
    // Reparse structure without path/type admission; existing and resulting
    // Markdown notes may both contain zero bytes.
    nextMarkdown = parseMarkdownStructure(nextContent);
  } catch {
    fail("P4 cannot alter Markdown frontmatter.", "frontmatter_touched");
  }
  const afterFrontmatterSha256 = sha256(nextMarkdown.frontmatter);
  if (
    nextMarkdown.bodyStart !== markdown.bodyStart ||
    nextMarkdown.frontmatter !== markdown.frontmatter ||
    beforeFrontmatterSha256 !== afterFrontmatterSha256
  ) {
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
