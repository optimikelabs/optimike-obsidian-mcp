import { z } from "zod/v3";

/**
 * Closed, content-free sub-causes of `date_preparation_unverified`. They name
 * which verification of an executed date preparation failed; never a path,
 * a value or a YAML diagnostic.
 */
export const DATE_PREPARATION_CHECKS = [
  "fresh_read_mismatch",
  "non_date_drift",
  "created_drift",
  "created_missing_or_duplicate",
  "created_provenance_mismatch",
  "modified_provenance_mismatch",
  "provenance_missing_or_invalid",
  "format_unqualified",
  "unclassified",
] as const;
export type DatePreparationCheck = (typeof DATE_PREPARATION_CHECKS)[number];
const CHECKS = new Set<string>(DATE_PREPARATION_CHECKS);
export function isDatePreparationCheck(value: unknown): value is DatePreparationCheck {
  return typeof value === "string" && CHECKS.has(value);
}

/**
 * FDM reads numeric epochs below 1e11 as seconds (FDM `epochNumberToDate`);
 * a qualified date line has a four-digit year. Outside this range the file
 * stat cannot prove a date value and the proof is invalid.
 */
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999) - 14 * 60 * 60_000;
const EpochMs = z.number().finite().min(MIN_EPOCH_MS).max(MAX_EPOCH_MS);
const UtcOffsetMinutes = z.number().int().min(-14 * 60).max(14 * 60);

/** `datePreparation.fileStat` of Atomic Write Bridge 0.9.2 (contract version 1). */
export const DatePreparationFileStatSchema = z.object({
  contractVersion: z.literal(1),
  ctimeMs: EpochMs,
  mtimeMs: EpochMs,
  ctimeUtcOffsetMinutes: UtcOffsetMinutes,
  mtimeUtcOffsetMinutes: UtcOffsetMinutes,
  observedAtMs: EpochMs,
});
export type DatePreparationFileStat = z.infer<typeof DatePreparationFileStatSchema>;

/**
 * `/status.datePreparation`. Tolerant on purpose: an unknown shape must never
 * make the whole status unreadable; it only means that no qualified
 * file-stat provenance is advertised.
 */
export const DatePreparationStatusSchema = z
  .object({
    contractVersion: z.number().int().optional(),
    supported: z.boolean().optional(),
    fileStatProvenance: z.object({ contractVersion: z.number().int() }).passthrough().optional(),
  })
  .passthrough();

/** Local `yyyy-MM-dd'T'HH:mm[:ss]` of an instant, with the offset of that instant. */
export function localDateValue(ms: number, utcOffsetMinutes: number, length: 16 | 19): string {
  return new Date(ms + utcOffsetMinutes * 60_000).toISOString().slice(0, length);
}

/** True only when the date line is exactly the local rendering of the observed timestamp. */
export function dateMatchesFileTime(value: string, ms: number, utcOffsetMinutes: number): boolean {
  return (value.length === 16 || value.length === 19) && value === localDateValue(ms, utcOffsetMinutes, value.length);
}
