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
  operon_filesystem_cache_unavailable:
    "Headless Operon reads require the shared vault cache.",
  operon_filesystem_cache_partial:
    "The shared vault cache is incomplete. Retry when it is ready.",
  operon_filesystem_configuration_invalid:
    "The synchronized Operon plugin data is unreadable or uses an unsupported format.",
  operon_filesystem_configuration_missing:
    "Operon data.json is absent from this vault copy.",
  operon_filesystem_filter_unsupported:
    "This filter uses semantics unavailable in headless mode. Query it through the Desktop Bridge.",
  operon_filesystem_live_required:
    "This Operon operation or task shape requires the live Obsidian Desktop Bridge.",
  "malformed-frontmatter":
    "Operon cannot edit this file task because its YAML frontmatter is malformed or starts with a BOM.",
  operon_filesystem_mutation_snapshot_incomplete:
    "A complete Operon filesystem snapshot with valid frontmatter and workflow configuration is required to plan a mutation.",
  operon_filesystem_duplicate_id:
    "Multiple filesystem sources declare this Operon ID. Use operon_validate to inspect the duplicate.",
} as const;

export type OperonRefusalCode = keyof typeof OPERON_REFUSAL_MESSAGES;

export const OPERON_REFUSAL_CODES = Object.freeze(
  Object.keys(OPERON_REFUSAL_MESSAGES) as OperonRefusalCode[],
);

/** Bridge `error.code` values that are forwarded as public reason codes. */
export const PUBLIC_OPERON_BRIDGE_REFUSAL_CODES: ReadonlySet<string> = new Set(
  OPERON_REFUSAL_CODES.filter(
    (code) => code !== "operon_mutation_outcome_uncertain" && !code.startsWith("operon_filesystem_"),
  ),
);

export function isOperonRefusalCode(value: unknown): value is OperonRefusalCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(OPERON_REFUSAL_MESSAGES, value)
  );
}
