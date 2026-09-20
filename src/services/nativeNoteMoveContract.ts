import { createHash } from "node:crypto";

export const NATIVE_MOVE_CONTRACT = 1 as const;
export const NATIVE_MOVE_MAX_NEIGHBORS = 16;
export const NATIVE_MOVE_MAX_REFERENCES = 200;
export const NATIVE_MOVE_MAX_PLAN_BYTES = 256 * 1024;
export const NATIVE_MOVE_PREFIX = "obsidian-note-move:v1:";
export const nativeDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function nativeNotePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value !== value.trim()) {
    throw new Error("invalid_note_path");
  }
  const parts = value.split("/");
  if (!/\.md$/iu.test(value) || /[\\:\u0000-\u001f<>"|?*]/u.test(value) ||
      parts.some((part) => !part || part.startsWith(".") || /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) {
    throw new Error("invalid_note_path");
  }
  return value;
}

export function nativeMovePaths(source: unknown, destination: unknown) {
  const sourcePath = nativeNotePath(source);
  const destinationPath = nativeNotePath(destination);
  if (sourcePath.toLowerCase() === destinationPath.toLowerCase()) {
    throw new Error("same_or_case_only_path");
  }
  return { sourcePath, destinationPath };
}

export type NativeSemanticReference = {
  kind: "link" | "embed" | "frontmatter";
  targetPath: string | null;
  unresolvedPath: string | null;
  subpath: string;
  anchor: string;
};
export type NativeSemanticNote = {
  path: string;
  sha256: string;
  references: NativeSemanticReference[];
  backlinks: Array<{ sourcePath: string; count: number }>;
  unresolved: Array<{ linkText: string; count: number }>;
};
export type NativeMovePreflight = {
  contractVersion: 1;
  bindingFingerprint: string;
  sourcePath: string;
  destinationPath: string;
  updateLinks: boolean;
  notes: NativeSemanticNote[];
  preconditionDigest: string;
  expectedGraphDigest: string;
};
export type NativeMoveApply = {
  contractVersion: 1;
  operationId: string;
  sourcePath: string;
  destinationPath: string;
  bindingFingerprint: string;
  preconditionDigest: string;
};
export type NativeMoveObservation = {
  contractVersion: 1;
  operationId: string;
  bindingFingerprint: string;
  preconditionDigest: string;
  outcome: "committed" | "conflict" | "rejected" | "outcome_unknown";
  reason: string;
  afterSha256?: string;
  graphPostflight: "pending" | "verified" | "failed" | "indeterminate";
  observedGraphDigest?: string;
  scope: "sealed_neighborhood_only";
  replayAllowed: false;
};

const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const sortedSemantic = <T>(values: readonly T[]): T[] =>
  [...values].sort((a, b) => ordinal(JSON.stringify(a), JSON.stringify(b)));

/** Count-based semantic projection, not a Markdown renderer or graph transaction. */
export function nativeGraphDigest(
  notes: readonly NativeSemanticNote[],
  sourcePath?: string,
  destinationPath?: string,
): string {
  const remap = (path: string): string =>
    sourcePath !== undefined && path === sourcePath ? destinationPath! : path;
  return nativeDigest(sortedSemantic(notes.map((note) => ({
    path: remap(note.path),
    references: sortedSemantic(note.references.map((ref) => ({
      ...ref,
      targetPath: ref.targetPath === null ? null : remap(ref.targetPath),
    }))),
    backlinks: sortedSemantic(note.backlinks.map((ref) => ({
      sourcePath: remap(ref.sourcePath), count: ref.count,
    }))),
    unresolved: sortedSemantic(note.unresolved),
  }))));
}

export function sealNativeMove(
  input: Omit<NativeMovePreflight, "contractVersion" | "preconditionDigest" | "expectedGraphDigest">,
): NativeMovePreflight {
  nativeMovePaths(input.sourcePath, input.destinationPath);
  if (!/^[a-f0-9]{64}$/u.test(input.bindingFingerprint) ||
      typeof input.updateLinks !== "boolean" || input.notes.length < 1 ||
      input.notes.length > NATIVE_MOVE_MAX_NEIGHBORS + 1 ||
      new Set(input.notes.map((note) => note.path)).size !== input.notes.length ||
      !input.notes.some((note) => note.path === input.sourcePath)) {
    throw new Error("invalid_move_snapshot");
  }
  for (const note of input.notes) {
    nativeNotePath(note.path);
    if (!/^[a-f0-9]{64}$/u.test(note.sha256) ||
        note.references.length > NATIVE_MOVE_MAX_REFERENCES ||
        note.backlinks.length > NATIVE_MOVE_MAX_REFERENCES ||
        note.unresolved.length > NATIVE_MOVE_MAX_REFERENCES) {
      throw new Error("invalid_or_unbounded_move_snapshot");
    }
  }
  const source = input.notes.find((note) => note.path === input.sourcePath)!;
  if (!input.updateLinks && (source.references.length || source.backlinks.length || source.unresolved.length)) {
    throw new Error("update_links_disabled_for_linked_note");
  }
  const canonical = {
    bindingFingerprint: input.bindingFingerprint,
    sourcePath: input.sourcePath,
    destinationPath: input.destinationPath,
    updateLinks: input.updateLinks,
    notes: sortedSemantic(input.notes.map((note) => ({
      path: note.path,
      sha256: note.sha256,
      references: sortedSemantic(note.references),
      backlinks: sortedSemantic(note.backlinks),
      unresolved: sortedSemantic(note.unresolved),
    }))),
  };
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > NATIVE_MOVE_MAX_PLAN_BYTES) {
    throw new Error("move_snapshot_byte_limit");
  }
  return {
    contractVersion: NATIVE_MOVE_CONTRACT,
    ...canonical,
    preconditionDigest: nativeDigest(canonical),
    expectedGraphDigest: nativeGraphDigest(canonical.notes, input.sourcePath, input.destinationPath),
  };
}

export function verifyNativeMovePreflight(input: unknown): NativeMovePreflight {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_move_preflight");
  const value = input as NativeMovePreflight;
  if (value.contractVersion !== 1 || !Array.isArray(value.notes)) throw new Error("invalid_move_preflight");
  const sealed = sealNativeMove({
    sourcePath: value.sourcePath, destinationPath: value.destinationPath,
    bindingFingerprint: value.bindingFingerprint, updateLinks: value.updateLinks,
    notes: value.notes,
  });
  if (value.preconditionDigest !== sealed.preconditionDigest || value.expectedGraphDigest !== sealed.expectedGraphDigest) {
    throw new Error("move_preflight_digest_mismatch");
  }
  return sealed;
}
