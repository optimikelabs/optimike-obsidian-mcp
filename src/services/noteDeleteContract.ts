import { createHash } from "node:crypto";
import { nativeNotePath } from "./nativeNoteMoveContract.js";

/**
 * Governed deletion of one Markdown note through Obsidian's trash.
 *
 * Shared by the MCP adapter and the Atomic Write Bridge. The plan seals the exact
 * content hash of the note, its incoming links and the vault's trash preference;
 * the Bridge re-reads all of it immediately before `FileManager.trashFile` and
 * refuses (`conflict`) when anything differs. A permanent-deletion preference is
 * refused: this operation never destroys a note outright.
 */
export const NOTE_DELETE_CONTRACT = 1 as const;
export const NOTE_DELETE_PREFIX = "obsidian-note-delete:v1:";
export const NOTE_DELETE_MAX_BACKLINKS = 200;
export const NOTE_DELETE_PRECONDITION_WINDOW_MS = 5000;

export const noteDeleteDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/** `system` may fall back to the vault trash when the OS trash is refused; `none` (permanent) is never admitted. */
export type NoteDeleteTrashOption = "local" | "system";
export type NoteDeleteBacklink = { sourcePath: string; count: number };

export type NoteDeletePreflight = {
  contractVersion: 1;
  bindingFingerprint: string;
  path: string;
  sha256: string;
  byteLength: number;
  backlinks: NoteDeleteBacklink[];
  acknowledgeBacklinks: boolean;
  trashOption: NoteDeleteTrashOption;
  preconditionDigest: string;
};
export type NoteDeleteApply = {
  contractVersion: 1;
  operationId: string;
  path: string;
  bindingFingerprint: string;
  preconditionDigest: string;
  /** Effect fence token recorded by the MCP journal before dispatch. */
  fence?: { contractVersion: 1; epoch: string; attemptId: string };
};
export type NoteDeleteStatusRequest = {
  contractVersion: 1;
  operationId: string;
  path: string;
  sha256: string;
  bindingFingerprint: string;
  preconditionDigest: string;
};

/**
 * `verified`: absent from its path and an exact copy of the sealed bytes newly
 * present in the vault trash. `path_absent_only`: absent from its path, but the
 * trash location cannot be observed (system trash). `pending`: still observing.
 */
export type NoteDeleteTrashPostflight =
  | "pending"
  | "verified"
  | "path_absent_only"
  | "failed"
  | "indeterminate";

export type NoteDeleteObservation = {
  contractVersion: 1;
  operationId: string;
  bindingFingerprint: string;
  preconditionDigest: string;
  outcome: "committed" | "conflict" | "rejected" | "outcome_unknown";
  reason: string;
  trashOption: NoteDeleteTrashOption;
  trashPostflight: NoteDeleteTrashPostflight;
  replayAllowed: false;
};

const HASH = /^[a-f0-9]{64}$/u;
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function sealNoteDelete(
  input: Omit<NoteDeletePreflight, "contractVersion" | "preconditionDigest">,
): NoteDeletePreflight {
  // The note keeps whatever legacy name it has; only its Markdown shape is checked.
  nativeNotePath(input.path);
  if (
    !HASH.test(input.bindingFingerprint) ||
    !HASH.test(input.sha256) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0 ||
    typeof input.acknowledgeBacklinks !== "boolean" ||
    (input.trashOption !== "local" && input.trashOption !== "system") ||
    input.backlinks.length > NOTE_DELETE_MAX_BACKLINKS
  ) {
    throw new Error("invalid_delete_snapshot");
  }
  const backlinks = [...input.backlinks]
    .map((link) => {
      nativeNotePath(link.sourcePath);
      if (!Number.isSafeInteger(link.count) || link.count < 1) {
        throw new Error("invalid_delete_snapshot");
      }
      return { sourcePath: link.sourcePath, count: link.count };
    })
    .sort((a, b) => ordinal(a.sourcePath, b.sourcePath));
  if (new Set(backlinks.map((link) => link.sourcePath)).size !== backlinks.length) {
    throw new Error("invalid_delete_snapshot");
  }
  if (backlinks.length > 0 && !input.acknowledgeBacklinks) {
    throw new Error("note_has_backlinks");
  }
  const canonical = {
    bindingFingerprint: input.bindingFingerprint,
    path: input.path,
    sha256: input.sha256,
    byteLength: input.byteLength,
    backlinks,
    acknowledgeBacklinks: input.acknowledgeBacklinks,
    trashOption: input.trashOption,
  };
  return {
    contractVersion: NOTE_DELETE_CONTRACT,
    ...canonical,
    preconditionDigest: noteDeleteDigest(canonical),
  };
}

export function verifyNoteDeletePreflight(input: unknown): NoteDeletePreflight {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_delete_preflight");
  }
  const value = input as NoteDeletePreflight;
  if (value.contractVersion !== 1 || !Array.isArray(value.backlinks)) {
    throw new Error("invalid_delete_preflight");
  }
  const sealed = sealNoteDelete({
    bindingFingerprint: value.bindingFingerprint,
    path: value.path,
    sha256: value.sha256,
    byteLength: value.byteLength,
    backlinks: value.backlinks,
    acknowledgeBacklinks: value.acknowledgeBacklinks,
    trashOption: value.trashOption,
  });
  if (value.preconditionDigest !== sealed.preconditionDigest) {
    throw new Error("delete_preflight_digest_mismatch");
  }
  return sealed;
}
