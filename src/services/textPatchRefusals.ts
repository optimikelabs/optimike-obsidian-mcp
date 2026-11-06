/**
 * Closed, content-free refusal codes of the governed text patch compiler that
 * may reach MCP clients. Without them every compiler refusal arrived as a bare
 * "The request could not be validated." (06/11/2026: a replace_literal on a
 * "- [ ]" line, read by the agent as a malformed plan). Values are literal
 * codes from textPatchCompiler.ts; the sealed text itself is never echoed.
 */
export const TEXT_PATCH_REFUSAL_MESSAGES = {
  task_line_touched:
    "Text patches never create, edit, reorder or extend a Markdown task line (- [ ] …) or an Operon task line. Change tasks with the operon_* tools (for example operon_transition_task to complete one), and patch only the surrounding text.",
  literal_not_found:
    "The search text does not occur in the note body (frontmatter is excluded). Re-read the note with obsidian_read_note and copy the exact text, including spaces and accents.",
  literal_not_unique:
    "The search text occurs more than once in the body. Add surrounding text to make it unique, or set occurrence=all with intent=replace_all to replace every occurrence.",
  frontmatter_touched:
    "Body operations cannot change the frontmatter. Use frontmatterOperations in the same plan instead.",
  replace_all_intent_required:
    "Replacing every occurrence requires occurrence=all together with intent=replace_all.",
  replace_all_intent_mismatch:
    "intent=replace_all is only valid with occurrence=all.",
  literal_occurrence_invalid: "occurrence must be unique or all.",
  literal_intent_invalid: "intent must be replace_all when present.",
  empty_literal_search: "replace_literal needs a non-empty search text.",
  empty_patch_text: "append_body and prepend_body need a non-empty text.",
  regex_unsupported:
    "Text patches match literal text only; regular expressions are not supported.",
  too_many_authorized_ranges:
    "This plan would change too many separate ranges. Split it into several smaller plans.",
  markdown_note_missing:
    "The note does not exist. Create it with obsidian_note_create_plan instead.",
  markdown_path_invalid:
    "The target must be an existing vault-relative .md path.",
  markdown_note_too_large:
    "The note exceeds the text patch size limit. Use obsidian_note_replace_plan for this note.",
  // Also raised by the governed note replace runtime: keep these neutral.
  markdown_bom_unsupported:
    "The note starts with a UTF-8 byte order mark, which governed writes do not support. Ask the vault owner to remove it.",
  markdown_line_ending_unsupported:
    "The note uses bare carriage-return line endings, which governed writes do not support. Ask the vault owner to normalize them.",
} as const;

export type TextPatchRefusalCode = keyof typeof TEXT_PATCH_REFUSAL_MESSAGES;

export const TEXT_PATCH_REFUSAL_CODES = Object.freeze(
  Object.keys(TEXT_PATCH_REFUSAL_MESSAGES) as TextPatchRefusalCode[],
);

export function isTextPatchRefusalCode(
  value: unknown,
): value is TextPatchRefusalCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TEXT_PATCH_REFUSAL_MESSAGES, value)
  );
}
