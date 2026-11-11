/**
 * Closed, content-free Operon refusal codes that may reach MCP clients (#152).
 *
 * Each code tells the agent what to fix. Without it, a refusal arrived as a
 * generic CONFLICT and agents blamed the runtime (06/11/2026: a dry-run
 * idempotencyKey reused for the apply was read as a Bridge/Operon
 * incompatibility). Codes come from the Operon Bridge HTTP payload
 * (`error.code`) or from the MCP mutation journal; unknown codes stay masked.
 */
export const OPERON_REFUSAL_MESSAGES = {
  idempotency_key_reused:
    "This call was refused and applied nothing: its idempotencyKey was already used for a different request (the dry-run of this mutation, or an earlier or still running apply). If that earlier request was only the dry-run, run the apply with a new idempotencyKey. Otherwise check its result first (operon_get_task or operon_find_tasks): it may already have created or changed the task.",
  operon_mutation_outcome_uncertain:
    "The outcome of this Operon mutation could not be proven and it may have applied. Read the live task with operon_get_task and check operon_list_pending_recoveries before deciding; do not retry it with a new key.",
  revision_conflict:
    "The task changed since it was read: expectedRevision is stale. Re-read the task, then plan again with its current revision.",
  source_line_conflict:
    "The task source line changed since it was read: expectedLine does not match. Re-read the task, then plan again.",
  capability_pending_approval:
    "Pin capability approval is pending. Approve the Bridge tasks.pinned.preview and tasks.pinned.apply capabilities in Operon settings, then retry the same request and idempotencyKey.",
  consent_required:
    "Operon needs a fresh confirmation in the Obsidian window for this plan. Ask the vault owner to bring the window to the front, then apply again and confirm within 45 seconds.",
  consent_denied:
    "The vault owner declined this plan in Obsidian. Do not retry it without a new decision.",
  operon_index_not_settled:
    "Operon's index is still settling. Wait a few seconds, then retry the same request.",
} as const;

export type OperonRefusalCode = keyof typeof OPERON_REFUSAL_MESSAGES;

export const OPERON_REFUSAL_CODES = Object.freeze(
  Object.keys(OPERON_REFUSAL_MESSAGES) as OperonRefusalCode[],
);

/** Bridge `error.code` values that are forwarded as public reason codes. */
export const PUBLIC_OPERON_BRIDGE_REFUSAL_CODES: ReadonlySet<string> = new Set(
  OPERON_REFUSAL_CODES.filter(
    (code) => code !== "operon_mutation_outcome_uncertain",
  ),
);

export function isOperonRefusalCode(value: unknown): value is OperonRefusalCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(OPERON_REFUSAL_MESSAGES, value)
  );
}
