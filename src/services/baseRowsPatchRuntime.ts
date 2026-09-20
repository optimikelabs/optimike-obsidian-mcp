import { createHash } from "node:crypto";
import { z } from "zod";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { BaseRowSelectionSchema, baseRowTarget, type BaseRowSelectionReader, type BaseRowTarget } from "./baseRowSelection.js";
import { canonicalizeFrontmatterPatchOperations, compileFrontmatterPatch, frontmatterCanonicalDigest, type FrontmatterPatchOperation } from "./frontmatterPatchCompiler.js";
import { operationDigest, type OperationReceipt } from "./operations/contract.js";
import { assertWriteAllowed } from "./writePolicy.js";
import type { GovernedNoteReplacePlanView, GovernedNoteReplaceRuntime } from "../mcp-server/tools/governedNoteReplaceTools/runtime.js";

export const BASE_ROWS_KIND = "obsidian.base.rows.patch" as const;
export const BASE_ROWS_PREFIX = "obsidian-base-rows-patch:v1:";
const CHILD_PREFIX = "obsidian-note-replace:v1:";
const KEY_DOMAIN = "optimike:projection:v1:base-rows:";
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Stored = z.object({
  contractVersion: z.literal(1), kind: z.literal(BASE_ROWS_KIND),
  publicIdempotencyKey: z.string().min(1).max(256), intentDigest: Hash,
  proof: z.object({
    selection: BaseRowSelectionSchema,
    patchDigest: Hash, bodySha256: Hash,
    beforeNoteSha256: Hash, afterNoteSha256: Hash,
    changedKeys: z.array(z.string().min(1).max(1024)).max(64),
    sourcePreservation: z.literal("byte-identical-outside-authorized-frontmatter-ranges"),
  }).strict(),
}).strict();
export type BaseRowsPatchInput = BaseRowTarget & { operations: FrontmatterPatchOperation[]; idempotencyKey: string };
function fail(reason: string): never {
  throw new McpError(BaseErrorCode.CONFLICT, "The governed Base row plan or its selection is invalid or changed; replan is required.", { reason });
}
function privateKey(value: string) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 256 ||
      Buffer.from(value, "utf8").toString("utf8") !== value) fail("invalid_row_key");
  return KEY_DOMAIN + frontmatterCanonicalDigest(value);
}
function childRef(reference: string) {
  if (typeof reference !== "string" || !reference.startsWith(BASE_ROWS_PREFIX)) fail("row_reference_domain_mismatch");
  const id = reference.slice(BASE_ROWS_PREFIX.length);
  if (!z.string().uuid().safeParse(id).success) fail("row_reference_invalid");
  return CHILD_PREFIX + id;
}
function stored(view: GovernedNoteReplacePlanView, key?: string, intent?: string) {
  const result = Stored.safeParse(view.projection);
  if (!result.success) fail("row_projection_invalid");
  const p = result.data;
  baseRowTarget({ baseId: p.proof.selection.baseId, view: p.proof.selection.view, path: p.proof.selection.path });
  if (view.path !== p.proof.selection.path || view.idempotencyIdentity !== p.intentDigest ||
      view.idempotencyKey !== privateKey(p.publicIdempotencyKey) || view.beforeSha256 !== p.proof.beforeNoteSha256 ||
      view.afterSha256 !== p.proof.afterNoteSha256 || (key !== undefined && key !== p.publicIdempotencyKey) ||
      (intent !== undefined && intent !== p.intentDigest)) fail("row_identity_mismatch");
  return p;
}
function authorize(phase: "plan" | "apply", path: string, keys: string[]) {
  if (keys.some(key => /^(?:file|formula|computed)\./iu.test(key) || /^(?:__proto__|prototype|constructor)$/iu.test(key))) fail("row_virtual_property");
  assertWriteAllowed({ operation: phase === "plan" ? "bases_rows_patch_plan" : "bases_rows_patch_apply",
    action: phase, target: path, targetType: "filePath", frontmatterKeys: keys, batchCount: keys.length });
}

/** Domain projection over the existing durable CAS runtime; owns no separate journal. */
export class BaseRowsPatchRuntime {
  constructor(private readonly notes: GovernedNoteReplaceRuntime, private readonly selection: BaseRowSelectionReader) {}
  private receipt(child: OperationReceipt, view: GovernedNoteReplacePlanView) {
    const p = stored(view);
    const { idempotencyKey, recoveryRef, ...rest } = child;
    void idempotencyKey; void recoveryRef;
    return { ...rest, operationKind: BASE_ROWS_KIND, planRef: BASE_ROWS_PREFIX + view.operationId,
      planDigest: operationDigest({ childPlanDigest: child.planDigest, intentDigest: p.intentDigest, proof: p.proof }),
      target: { kind: "vault-base-row", logicalRef: view.path },
      selection: p.proof.selection, changedKeys: p.proof.changedKeys,
      sourcePreservation: p.proof.sourcePreservation, bodySha256: p.proof.bodySha256,
      recoveryAllowed: false, nextAction: view.status === "planned" ? "apply" : "status",
      limitations: ["one_existing_markdown_row", "base_guard_and_note_CAS_are_not_one_transaction", "selection_cache_freshness_unknown", "postpatch_view_membership_not_certified"] };
  }
  async plan(input: BaseRowsPatchInput) {
    const target = baseRowTarget({ baseId: input.baseId, view: input.view, path: input.path });
    const internalKey = privateKey(input.idempotencyKey);
    const operations = canonicalizeFrontmatterPatchOperations(input.operations);
    const intentDigest = frontmatterCanonicalDigest({ kind: BASE_ROWS_KIND, ...target, operations });
    const existing = this.notes.findPlanByIdempotencyKey(internalKey);
    if (existing) {
      stored(existing, input.idempotencyKey, intentDigest);
      return this.status(BASE_ROWS_PREFIX + existing.operationId);
    }
    authorize("plan", target.path, operations.map(op => op.key));
    const selection = await this.selection.select(target);
    const source = await this.notes.readForProjection(target.path);
    const compiled = compileFrontmatterPatch(source.content, operations);
    const projection = Stored.parse({ contractVersion: 1, kind: BASE_ROWS_KIND,
      publicIdempotencyKey: input.idempotencyKey, intentDigest,
      proof: { selection, patchDigest: compiled.proof.patchDigest, bodySha256: compiled.proof.bodySha256,
        beforeNoteSha256: source.sha256, afterNoteSha256: createHash("sha256").update(compiled.nextContent, "utf8").digest("hex"),
        changedKeys: compiled.proof.changedKeys, sourcePreservation: compiled.proof.sourcePreservation } });
    const child = await this.notes.plan({ path: target.path, nextContent: compiled.nextContent,
      idempotencyKey: internalKey, idempotencyIdentity: intentDigest,
      expectedBeforeSha256: source.sha256, expectedBindingFingerprint: source.bindingFingerprint, projection });
    const view = this.notes.inspect(child.planRef);
    stored(view, input.idempotencyKey, intentDigest);
    return this.receipt(child, view);
  }
  async apply(reference: string, key: string) {
    privateKey(key);
    const ref = childRef(reference), before = this.notes.inspect(ref), p = stored(before, key);
    if (before.status !== "planned") return this.status(reference);
    authorize("apply", before.path, p.proof.changedKeys);
    const { baseId, view, path } = p.proof.selection;
    try {
      const current = await this.selection.select({ baseId, view, path });
      if (operationDigest(current) !== operationDigest(p.proof.selection)) fail("base_or_selection_changed");
    } catch (error) {
      // Another process may have won after this caller observed `planned`.
      // Its committed patch can legitimately remove the row from the sealed
      // view, making this caller's revalidation fail. Prefer the durable child
      // state over that now-stale validation error, but only once ownership has
      // actually advanced beyond `planned`.
      const winner = this.notes.inspect(ref);
      stored(winner, key);
      if (winner.status !== "planned") return this.status(reference);
      throw error;
    }
    // This read guard is intentionally separate from the existing note-content CAS.
    // No Base file is written and no cross-file atomicity is promised.
    const child = await this.notes.apply(ref, before.idempotencyKey);
    return this.receipt(child, this.notes.inspect(ref));
  }
  async status(reference: string) {
    const ref = childRef(reference);
    stored(this.notes.inspect(ref));
    const child = await this.notes.status(ref);
    return this.receipt(child, this.notes.inspect(ref));
  }
}
