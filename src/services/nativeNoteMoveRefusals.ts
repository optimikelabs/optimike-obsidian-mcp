import { BaseErrorCode } from "../types-global/errors.js";

/** Bridge native-move refusals that mean something to the caller: [public code, reasonCode, fixed hint]. */
const REFUSALS = {
  destination_not_free: [BaseErrorCode.CONFLICT, "move_destination_not_free",
    "The destination exists, differs from an existing file only by case or Unicode form, or its parent folder is missing. Choose another name or create the folder first."],
  move_neighborhood_limit: [BaseErrorCode.VALIDATION_ERROR, "move_neighborhood_limit",
    "More than 16 notes link to the source; a governed move only seals small neighborhoods. Inspect them with obsidian_note_links; the vault owner can still move the note in Obsidian."],
  move_reference_limit: [BaseErrorCode.VALIDATION_ERROR, "move_reference_limit",
    "The source or a note linking to it has more than 200 links, unresolved links or backlinks, so the move neighborhood cannot be sealed completely. Find it with obsidian_note_links; the vault owner can still move the note in Obsidian."],
  move_snapshot_byte_limit: [BaseErrorCode.VALIDATION_ERROR, "move_snapshot_byte_limit",
    "The sealed move neighborhood exceeds the plan size limit. The vault owner can still move the note in Obsidian."],
  metadata_snapshot_unavailable: [BaseErrorCode.CONFLICT, "move_metadata_unavailable",
    "Obsidian could not give a stable metadata snapshot of the source or of a note linking to it (note missing, cache not ready or vault changing). Check the source path, wait a moment, then replan."],
  native_moves_disabled: [BaseErrorCode.FORBIDDEN, "move_bridge_grant_disabled",
    "Native moves are not enabled in the Atomic Write Bridge settings. Ask the vault owner to enable them."],
  native_preference_unavailable: [BaseErrorCode.SERVICE_UNAVAILABLE, "move_preference_unavailable",
    "Obsidian's Automatically update internal links preference could not be read, and a move never assumes it. Retry once Obsidian is fully loaded."],
  update_links_disabled_for_linked_note: [BaseErrorCode.FORBIDDEN, "move_update_links_disabled",
    "The note is linked from other notes and Obsidian's Automatically update internal links preference is off, so moving it would break those links. Ask the vault owner to turn it on."],
  physical_path_unsupported: [BaseErrorCode.VALIDATION_ERROR, "move_physical_path_unsupported",
    "The source or destination crosses a symbolic link, a hard link or a non-regular file; native moves refuse such paths."],
  invalid_note_path: [BaseErrorCode.VALIDATION_ERROR, "move_path_invalid",
    "The source or destination is not an accepted vault Markdown path."],
  same_or_case_only_path: [BaseErrorCode.VALIDATION_ERROR, "move_same_or_case_only_path",
    "Source and destination are the same or differ only by case or Unicode form; that rename is not supported."],
} as const satisfies Record<string, readonly [BaseErrorCode, string, string]>;

type BridgeReason = keyof typeof REFUSALS;

/** Bridge reason codes the REST client may keep from a native-move 400 body. */
export const NATIVE_MOVE_BRIDGE_REASONS: readonly string[] = Object.keys(REFUSALS);
/** Public reason codes of refused native moves. */
export const NATIVE_MOVE_PUBLIC_REASON_CODES: readonly string[] = Object.values(REFUSALS).map(([, code]) => code);
const HINTS = new Set<string>(Object.values(REFUSALS).map(([, , hint]) => hint));

/** True only for one of the fixed native-move hints; never a caller-derived string. */
export function isNativeMoveHint(value: unknown): boolean {
  return typeof value === "string" && HINTS.has(value);
}

/** Maps a Bridge refusal carried by an error to its public [code, reasonCode, hint], if it is one. */
export function nativeMoveBridgeRefusal(error: unknown): readonly [BaseErrorCode, string, string] | undefined {
  const carrier = error as { details?: { reasonCode?: unknown }; reasonCode?: unknown } | undefined;
  for (const value of [carrier?.details?.reasonCode, carrier?.reasonCode]) {
    if (typeof value === "string" && Object.hasOwn(REFUSALS, value)) return REFUSALS[value as BridgeReason];
  }
  return undefined;
}
