import { createHash } from "node:crypto";
import { load } from "js-yaml";
import { isAlias, isMap, isScalar, parseDocument, Scalar, visit } from "yaml";
import { BaseErrorCode, McpError } from "../types-global/errors.js";

export type BaseFormulaPatchOperation =
  | { op: "set_formula"; name: string; expression: string }
  | { op: "delete_formula"; name: string };

export type BaseFormulaPatchProof = {
  contractVersion: 1;
  compilerVersion: 1;
  sourcePreservation: "byte-identical-outside-authorized-base-ranges";
  lineEnding: "lf" | "crlf";
  patchDigest: string;
  changedFormulas: string[];
  authorizedRanges: Array<{
    name: string;
    operation: BaseFormulaPatchOperation["op"];
    start: number;
    end: number;
    beforeSha256: string;
    afterSha256: string;
  }>;
  untouchedSourceSha256: string;
};

export type CompiledBaseFormulaPatch = {
  operations: BaseFormulaPatchOperation[];
  nextYaml: string;
  proof: BaseFormulaPatchProof;
};

type SourceLine = {
  start: number;
  end: number;
  endWithEol: number;
  text: string;
};

type FormulaEntry = {
  name: string;
  normalizedName: string;
  start: number;
  end: number;
};

type Edit = {
  name: string;
  operation: BaseFormulaPatchOperation["op"];
  start: number;
  end: number;
  replacement: string;
};

const BARE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
const TOP_LEVEL = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*):(.*)$/u;
const FORMULA_ENTRY = /^  ([\p{L}\p{N}_][\p{L}\p{N}_.-]*):(.*)$/u;
const MAX_OPERATIONS = 32;
const MAX_EXPRESSION_BYTES = 64 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, details);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function splitLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    const hasEol = newline >= 0;
    const end = hasEol ? newline : content.length;
    const raw = content.slice(cursor, end);
    lines.push({
      start: cursor,
      end,
      endWithEol: hasEol ? newline + 1 : content.length,
      text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
    });
    cursor = hasEol ? newline + 1 : content.length;
  }
  return lines;
}

function assertSupportedYamlSyntax(yaml: string): void {
  const document = parseDocument(yaml, {
    keepSourceTokens: false,
    merge: false,
    strict: true,
    uniqueKeys: false,
  });
  let hasReference = false;
  let hasExtension = false;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || node.anchor) hasReference = true;
      if (node.tag) hasExtension = true;
      if (
        isMap(node) &&
        node.items.some((pair) => isScalar(pair.key) && pair.key.value === "<<")
      ) {
        hasExtension = true;
      }
    },
  });
  if (hasReference) {
    fail("YAML anchors and aliases are outside the governed Base subset.", {
      reason: "base_yaml_reference_unsupported",
    });
  }
  if (hasExtension) {
    fail("YAML tags and merge keys are outside the governed Base subset.", {
      reason: "base_yaml_extension_unsupported",
    });
  }
  if (document.errors.length > 0) {
    fail("Base YAML is invalid.", { reason: "base_yaml_invalid" });
  }
  if (!isMap(document.contents)) return;
  const formulas = document.contents.items.find(
    (pair) =>
      isScalar(pair.key) &&
      normalizeName(String(pair.key.value)) === "formulas",
  )?.value;
  if (!isMap(formulas)) return;
  for (const pair of formulas.items) {
    const value = pair.value;
    if (!value?.range) continue;
    const source = yaml.slice(value.range[0], value.range[1]);
    const supportedBlockScalar =
      isScalar(value) &&
      (value.type === Scalar.BLOCK_LITERAL ||
        value.type === Scalar.BLOCK_FOLDED);
    if (source.includes("\n") && !supportedBlockScalar) {
      fail(
        "Multiline non-block formula scalars are outside the governed Base subset.",
        {
          reason: "base_formula_layout_unsupported",
        },
      );
    }
  }
}

function isSeparator(line: SourceLine): boolean {
  const trimmed = line.text.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function parseRoot(yaml: string): Record<string, unknown> {
  assertSupportedYamlSyntax(yaml);
  let parsed: unknown;
  try {
    parsed = load(yaml);
  } catch {
    fail("Base YAML is invalid.", { reason: "base_yaml_invalid" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("Base YAML root must be a mapping.", {
      reason: "base_yaml_root_not_mapping",
    });
  }
  return parsed as Record<string, unknown>;
}

export function canonicalizeBaseFormulaPatchOperations(
  operations: BaseFormulaPatchOperation[],
): BaseFormulaPatchOperation[] {
  if (operations.length < 1 || operations.length > MAX_OPERATIONS) {
    fail("A governed Base plan requires between 1 and 32 formula operations.", {
      reason: "base_formula_operation_count",
    });
  }
  const seen = new Set<string>();
  const canonical = operations.map((operation) => {
    const name = operation.name.trim();
    if (!BARE_NAME.test(name)) {
      fail("Formula names must be conservative bare YAML keys.", {
        reason: "base_formula_name_unsupported",
        name,
      });
    }
    const normalizedName = normalizeName(name);
    if (seen.has(normalizedName)) {
      fail("Formula operations contain duplicate or case-colliding names.", {
        reason: "duplicate_base_formula_operation",
        name,
      });
    }
    seen.add(normalizedName);
    if (operation.op === "set_formula") {
      if (
        operation.expression.length === 0 ||
        Buffer.byteLength(operation.expression, "utf8") > MAX_EXPRESSION_BYTES
      ) {
        fail(
          "Formula expression is empty or exceeds the governed size limit.",
          {
            reason: "base_formula_expression_size",
            name,
          },
        );
      }
      return { ...operation, name };
    }
    return { ...operation, name };
  });
  return canonical.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
}

function sourceModel(yaml: string): {
  eol: "\n" | "\r\n";
  entries: Map<string, FormulaEntry>;
  appendOffset: number;
} {
  const eol: "\n" | "\r\n" = yaml.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n" && /(^|[^\r])\n/u.test(yaml)) {
    fail("Mixed line endings are outside the governed Base subset.", {
      reason: "base_mixed_line_endings",
    });
  }
  const lines = splitLines(yaml);
  const topLevelStarts = lines
    .map((line, index) => ({ line, index, match: line.text.match(TOP_LEVEL) }))
    .filter(({ line, match }) => !isSeparator(line) && match);
  const formulaSections = topLevelStarts.filter(
    ({ match }) => normalizeName(match![1]) === "formulas",
  );
  if (
    formulaSections.length !== 1 ||
    formulaSections[0].match![2].trim() !== ""
  ) {
    fail("Base YAML must contain one block-style top-level formulas mapping.", {
      reason: "base_formulas_mapping_ambiguous",
    });
  }
  const section = formulaSections[0];
  const nextTopLevel = topLevelStarts.find(
    ({ index }) => index > section.index,
  );
  const sectionEndIndex = nextTopLevel?.index ?? lines.length;
  const starts: Array<{ name: string; normalizedName: string; index: number }> =
    [];
  const seen = new Set<string>();
  let active = false;
  for (let index = section.index + 1; index < sectionEndIndex; index += 1) {
    const line = lines[index];
    if (isSeparator(line)) continue;
    const match = line.text.match(FORMULA_ENTRY);
    if (match) {
      const normalizedName = normalizeName(match[1]);
      if (seen.has(normalizedName)) {
        fail("Base formulas contain duplicate or case-colliding names.", {
          reason: "duplicate_base_formula",
          name: match[1],
        });
      }
      seen.add(normalizedName);
      starts.push({ name: match[1], normalizedName, index });
      active = true;
      continue;
    }
    if (!active || !/^ {4,}\S/u.test(line.text)) {
      fail("The formulas mapping uses unsupported YAML layout.", {
        reason: "base_formula_layout_unsupported",
        line: index + 1,
      });
    }
  }
  const entries = new Map<string, FormulaEntry>();
  for (const [position, start] of starts.entries()) {
    const nextIndex = starts[position + 1]?.index ?? sectionEndIndex;
    let lastOwned = nextIndex - 1;
    while (lastOwned > start.index && isSeparator(lines[lastOwned]))
      lastOwned -= 1;
    entries.set(start.normalizedName, {
      name: start.name,
      normalizedName: start.normalizedName,
      start: lines[start.index].start,
      end: lines[lastOwned].endWithEol,
    });
  }
  let appendOffset =
    nextTopLevel?.line.start ?? lines.at(-1)?.endWithEol ?? yaml.length;
  for (let index = sectionEndIndex - 1; index > section.index; index -= 1) {
    if (!isSeparator(lines[index])) break;
    appendOffset = lines[index].start;
  }
  return { eol, entries, appendOffset };
}

function untouchedSource(yaml: string, edits: Edit[]): string {
  let cursor = 0;
  let result = "";
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    result += yaml.slice(cursor, edit.start);
    cursor = edit.end;
  }
  return result + yaml.slice(cursor);
}

export function compileBaseFormulaPatch(
  yaml: string,
  requestedOperations: BaseFormulaPatchOperation[],
): CompiledBaseFormulaPatch {
  parseRoot(yaml);
  const operations =
    canonicalizeBaseFormulaPatchOperations(requestedOperations);
  const source = sourceModel(yaml);
  const projectedFormulaNames = new Set(source.entries.keys());
  for (const operation of operations) {
    const normalizedName = normalizeName(operation.name);
    if (operation.op === "delete_formula") {
      projectedFormulaNames.delete(normalizedName);
    } else {
      projectedFormulaNames.add(normalizedName);
    }
  }
  if (projectedFormulaNames.size === 0) {
    fail("Deleting the final formula is outside the governed Base V1 subset.", {
      reason: "base_last_formula_delete_unsupported",
    });
  }
  const edits: Edit[] = [];
  const additions: string[] = [];

  for (const operation of operations) {
    const existing = source.entries.get(normalizeName(operation.name));
    if (operation.op === "delete_formula") {
      if (!existing) {
        fail("The requested formula does not exist.", {
          reason: "base_formula_not_found",
          name: operation.name,
        });
      }
      edits.push({
        name: operation.name,
        operation: operation.op,
        start: existing.start,
        end: existing.end,
        replacement: "",
      });
      continue;
    }
    // A case-insensitive lookup is used only to reject ambiguous duplicates.
    // Once a formula exists, preserve its exact source spelling as part of the
    // byte-preservation contract instead of letting a replay rename the key.
    const renderedName = existing?.name ?? operation.name;
    const rendered = `  ${renderedName}: ${JSON.stringify(operation.expression)}${source.eol}`;
    if (existing) {
      edits.push({
        name: operation.name,
        operation: operation.op,
        start: existing.start,
        end: existing.end,
        replacement: rendered,
      });
    } else {
      additions.push(rendered);
    }
  }
  if (additions.length > 0) {
    const separator =
      source.appendOffset > 0 && yaml[source.appendOffset - 1] !== "\n"
        ? source.eol
        : "";
    edits.push({
      name: "[formula-additions]",
      operation: "set_formula",
      start: source.appendOffset,
      end: source.appendOffset,
      replacement: separator + additions.join(""),
    });
  }
  const orderedEdits = [...edits].sort((a, b) => b.start - a.start);
  let nextYaml = yaml;
  for (const edit of orderedEdits) {
    nextYaml =
      nextYaml.slice(0, edit.start) +
      edit.replacement +
      nextYaml.slice(edit.end);
  }
  const parsedAfter = parseRoot(nextYaml);
  const formulasAfter = parsedAfter.formulas;
  if (
    !formulasAfter ||
    typeof formulasAfter !== "object" ||
    Array.isArray(formulasAfter)
  ) {
    fail("Compiled Base formulas are not a mapping.", {
      reason: "compiled_base_formulas_invalid",
    });
  }
  for (const operation of operations) {
    const matchingEntry = Object.entries(
      formulasAfter as Record<string, unknown>,
    ).find(([name]) => normalizeName(name) === normalizeName(operation.name));
    const postconditionFailed =
      operation.op === "delete_formula"
        ? matchingEntry !== undefined
        : matchingEntry?.[1] !== operation.expression;
    if (postconditionFailed) {
      fail("Compiled Base formula postcondition failed.", {
        reason: "compiled_base_formula_postcondition",
        name: operation.name,
      });
    }
  }
  const proofEdits = [...edits].sort((a, b) => a.start - b.start);
  return {
    operations,
    nextYaml,
    proof: {
      contractVersion: 1,
      compilerVersion: 1,
      sourcePreservation: "byte-identical-outside-authorized-base-ranges",
      lineEnding: source.eol === "\r\n" ? "crlf" : "lf",
      patchDigest: sha256(JSON.stringify({ operations })),
      changedFormulas: operations.map(({ name }) => name),
      authorizedRanges: proofEdits.map((edit) => ({
        name: edit.name,
        operation: edit.operation,
        start: edit.start,
        end: edit.end,
        beforeSha256: sha256(yaml.slice(edit.start, edit.end)),
        afterSha256: sha256(edit.replacement),
      })),
      untouchedSourceSha256: sha256(untouchedSource(yaml, proofEdits)),
    },
  };
}
