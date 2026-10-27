import { z } from "zod/v3";
import { createHash } from "node:crypto";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { AtomicWriteBackend } from "./operations/obsidianNoteReplaceOperationAdapter.js";
import type { OperationReceipt } from "./operations/contract.js";

const WarningSchema = z.object({
  key: z.string().max(1024),
  reason: z.enum(["untyped", "type_mismatch", "unknown_widget", "empty_value"]),
  declaredType: z.string().max(128).optional(),
  actualType: z.string().max(128).optional(),
}).strict();
const ResultSchema = z.object({
  ok: z.literal(true), contractVersion: z.literal(1), bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  canonicalYaml: z.string().max(5 * 1024 * 1024), warnings: z.array(WarningSchema).max(4096),
}).strict();
export type FrontmatterTypeWarning = z.infer<typeof WarningSchema>;
export type FrontmatterAssessment = {
  normalization: { applied: boolean; reason?: string; sourceSha256?: string; normalizedSha256?: string; beforeFrontmatterSha256?: string; afterFrontmatterSha256?: string };
  typeWarnings: FrontmatterTypeWarning[];
};

export function frontmatterAssessment(source: string, normalized: string, warnings: FrontmatterTypeWarning[]): FrontmatterAssessment {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const applied = source !== normalized;
  return { normalization: applied ? {
    applied: true, reason: "existing_frontmatter_not_obsidian_canonical",
    sourceSha256: digest(source), normalizedSha256: digest(normalized),
    beforeFrontmatterSha256: digest(frontmatterEnvelope(source)?.yaml ?? ""),
    afterFrontmatterSha256: digest(frontmatterEnvelope(normalized)?.yaml ?? ""),
  } : { applied: false }, typeWarnings: warnings };
}

/** This exception contains only a canonical representation of the caller's own input.
 * It must be projected explicitly by the two plan tools, never the generic logger. */
export class FrontmatterNotCanonical extends Error {
  constructor(readonly expectedFrontmatter: string) { super("frontmatter_not_obsidian_canonical"); }
}

export function rejectNonCanonical(result: { content: string; normalized: boolean }): void {
  if (!result.normalized) return;
  const envelope = frontmatterEnvelope(result.content);
  if (!envelope) throw unavailable();
  throw new FrontmatterNotCanonical(result.content.slice(0, envelope.end) + "---");
}

/** The dedicated field is permitted only for the caller's supplied frontmatter. */
export function canonicalRejection(error: unknown) {
  return error instanceof FrontmatterNotCanonical ? {
    code: "VALIDATION_ERROR", reason: "frontmatter_not_obsidian_canonical", expectedFrontmatter: error.expectedFrontmatter,
  } : undefined;
}

export class DatePreparationPlanFailure extends Error {
  constructor(readonly datePreparation: NonNullable<OperationReceipt["datePreparation"]>) {
    super("date_preparation_completed_plan_unverified");
  }
}

export function preparationPlanRejection(error: unknown) {
  return error instanceof DatePreparationPlanFailure ? {
    ok: false,
    error: { code: "CONFLICT", reasonCode: "date_preparation_completed_plan_unverified",
      message: "La préparation des dates a modifié la note avant l'échec du plan. Relisez la note et les opérations en attente avant toute reprise.", mutationMayHaveApplied: true },
    datePreparation: error.datePreparation,
  } : undefined;
}

export function frontmatterEnvelope(content: string): { start: number; end: number; yaml: string } | undefined {
  const opening = /^---\r?\n/u.exec(content);
  if (!opening) return undefined;
  const close = /^---(?=\r?$)/gmu;
  close.lastIndex = opening[0].length;
  const found = close.exec(content);
  if (!found) throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Invalid frontmatter envelope.", { reason: "frontmatter_envelope_invalid" });
  return { start: opening[0].length, end: found.index, yaml: content.slice(opening[0].length, found.index) };
}

export async function inspectNativeFrontmatter(backend: Pick<AtomicWriteBackend, "status" | "inspectFrontmatterFormat">, content: string, expectedBinding?: string) {
  let status;
  try { status = await backend.status(); } catch { throw unavailable(); }
  const binding = status?.backend?.bindingFingerprint;
  if (status?.frontmatterFormat?.contractVersion !== 1 || status.frontmatterFormat.supported !== true ||
      !backend.inspectFrontmatterFormat || !/^[a-f0-9]{64}$/u.test(binding ?? "") || (expectedBinding && binding !== expectedBinding)) throw unavailable();
  const envelope = frontmatterEnvelope(content);
  if (!envelope) return { content, warnings: [] as FrontmatterTypeWarning[], normalized: false, bindingFingerprint: binding };
  let result: z.infer<typeof ResultSchema>;
  try { result = ResultSchema.parse(await backend.inspectFrontmatterFormat(envelope.yaml)); } catch { throw unavailable(); }
  if (result.bindingFingerprint !== binding) throw unavailable();
  return { content: content.slice(0, envelope.start) + result.canonicalYaml + content.slice(envelope.end),
    warnings: result.warnings, normalized: result.canonicalYaml !== envelope.yaml, bindingFingerprint: binding };
}

function unavailable() {
  return new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Native frontmatter format inspection is unavailable.", { reasonCode: "frontmatter_format_capability_missing" });
}
