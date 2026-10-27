import { BaseErrorCode, McpError } from "../types-global/errors.js";
import {
  NoteNameError, assertNoteName, hasFoldedNameCollision, noteNameFixedHint, type NoteNameOptions, type NoteNameViolation,
} from "./noteNameRules.js";

/** Public, closed refusal: reasonCode + hint + optional suggestion; never the submitted path. */
export function noteNameMcpError(violation: NoteNameViolation): McpError {
  return new McpError(BaseErrorCode.VALIDATION_ERROR, "The note path is not a valid name on every platform.", {
    reasonCode: violation.reasonCode,
    hint: violation.hint,
    ...(violation.suggestedPath ? { suggestedPath: violation.suggestedPath, suggestedName: violation.suggestedName } : {}),
  });
}
/** Converts a shared-rule failure into the public McpError; any other error passes through unchanged. */
export function asNoteNameMcpError(error: unknown): unknown {
  return error instanceof NoteNameError ? noteNameMcpError(error.violation) : error;
}
/** Validates a path that is about to be created; throws the public McpError. */
export function assertNewNotePath(path: unknown, options?: NoteNameOptions): string {
  try { return assertNoteName(path, options); } catch (error) { throw asNoteNameMcpError(error); }
}
/** Refuses a leaf whose name differs from an existing sibling only by case or Unicode form. */
export function assertNoFoldedSibling(leaf: string, siblings: Iterable<string>): void {
  if (hasFoldedNameCollision(leaf, Array.from(siblings, (name) => name.replace(/\/$/u, "")))) {
    throw noteNameMcpError({ reasonCode: "note_name_case_collision", hint: noteNameFixedHint("note_name_case_collision") });
  }
}
