import { z } from "zod/v3";
import { load } from "js-yaml";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { validateObsidianBase } from "../obsidianFormatService.js";
import { validateCanvasForCreate } from "../canvasPatchCompiler.js";
import { assertWriteAllowed, type WriteOperation } from "../writePolicy.js";
import { assertNewNotePath } from "../noteNameMcp.js";
import {
  VAULT_FILE_CREATE_MAX_BYTES, VAULT_FILE_CREATE_PROFILES, validateVaultFileCreateContent, vaultFileCreateHash, vaultFileCreatePath,
  type VaultFileCreateApply, type VaultFileCreateKind, type VaultFileCreatePreflight, type VaultFileCreateProfile,
} from "../vaultFileCreateContract.js";
import { operationDigest } from "./contract.js";
import { effectFenceEpoch, type AtomicWriteBackend } from "./obsidianNoteReplaceOperationAdapter.js";
import { ObsidianNoteReplaceJournal, ObsidianNoteReplaceConcurrencyError, type ObsidianNoteReplacePlan } from "./obsidianNoteReplaceJournal.js";

const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const KIND = z.enum(["base", "canvas"]);
const Preflight = z.object({ contractVersion: z.literal(1), kind: KIND, path: z.string().max(1024), bindingFingerprint: HASH,
  vaultBindingFingerprint: HASH.optional(), absent: z.literal(true), enabled: z.literal(true) }).strict();
const WirePreflight = Preflight.omit({ vaultBindingFingerprint: true }).strict();
const Inspection = z.object({ contractVersion: z.literal(1), kind: KIND, path: z.string().max(1024), bindingFingerprint: HASH,
  exists: z.boolean(), content: z.string().max(VAULT_FILE_CREATE_MAX_BYTES).optional(), sha256: HASH.optional() }).strict();
const Result = z.object({ contractVersion: z.literal(1), kind: KIND, operationId: z.string().uuid(), path: z.string().max(1024),
  bindingFingerprint: HASH, contentSha256: HASH,
  outcome: z.enum(["created", "conflict", "outcome_unknown"]), reason: z.string().regex(/^[a-z_]{1,96}$/u) }).strict();

export interface VaultFileCreateBackend extends Pick<AtomicWriteBackend, "status"> {
  readonly kind: VaultFileCreateKind;
  preflight(path: string): Promise<unknown>;
  create(request: VaultFileCreateApply): Promise<unknown>;
  inspect(path: string): Promise<unknown>;
}
export type VaultFileCreatePlanInput = { path: string; content: string; idempotencyKey: string };
type FormatIssue = { code: string; path?: string };

const VALIDATION_REASONS = new Set(["create_content_invalid", "create_format_invalid", "invalid_create_key", "invalid_create_reference"]);
function bad(reason: string, details: Record<string, unknown> = {}): never {
  throw new McpError(VALIDATION_REASONS.has(reason) ? BaseErrorCode.VALIDATION_ERROR : BaseErrorCode.CONFLICT,
    "The sealed creation could not be admitted or verified.", { reasonCode: reason, ...details });
}

/**
 * Format admission before sealing. Only issue codes and locations are
 * returned; the submitted content and parser messages are not echoed.
 */
export function vaultFileCreateFormat(kind: VaultFileCreateKind, content: string): { warnings: FormatIssue[] } {
  if (kind === "canvas") {
    try { validateCanvasForCreate(content); }
    catch (error) {
      const reason = error instanceof McpError && typeof error.details?.reasonCode === "string" ? error.details.reasonCode : "canvas_graph_invalid";
      bad("create_format_invalid", { issues: [{ code: reason }] });
    }
    return { warnings: [] };
  }
  const result = validateObsidianBase(content);
  const issue = (item: { code: string; path?: string }): FormatIssue => ({ code: item.code, ...(item.path ? { path: item.path } : {}) });
  if (!result.ok) bad("create_format_invalid", { issues: result.errors.map(issue) });
  // An empty or comment-only document parses without error but is not a Base.
  let root: unknown;
  try { root = load(content); } catch { root = undefined; }
  if (!root || typeof root !== "object" || Array.isArray(root) || Object.keys(root).length === 0) {
    bad("create_format_invalid", { issues: [{ code: "base-not-object" }] });
  }
  return { warnings: result.warnings.map(issue) };
}

/** Durable control is shared with the other governed note operations; effects use exclusive create only. */
export class VaultFileCreateOperationAdapter {
  private readonly profile: VaultFileCreateProfile;
  private readonly authorize: (phase: "plan" | "apply", path: string, content: string) => void;
  constructor(private readonly backend: VaultFileCreateBackend, private readonly journal: ObsidianNoteReplaceJournal,
    private readonly now = Date.now,
    authorize?: (phase: "plan" | "apply", path: string, content: string) => void,
  ) {
    const profile = this.profile = VAULT_FILE_CREATE_PROFILES[backend.kind];
    this.authorize = authorize ?? ((phase, path, content) =>
      assertWriteAllowed({ operation: (phase === "plan" ? profile.tools.plan : profile.tools.apply) as WriteOperation,
        action: phase, target: path, targetType: "filePath", contentLength: content.length }));
  }
  get kind(): VaultFileCreateKind { return this.backend.kind; }
  private internalKey(value: string): string {
    if (!z.string().min(1).max(256).safeParse(value).success) bad("invalid_create_key");
    return `optimike:projection:v1:${this.profile.route}:` + vaultFileCreateHash(value);
  }
  private intent(path: string, hash: string) { return operationDigest({ kind: this.kind, path, contentSha256: hash }); }
  private absence(p: Pick<VaultFileCreatePreflight, "path" | "bindingFingerprint">) {
    return operationDigest({ kind: "observed-absence", fileKind: this.kind, path: p.path, bindingFingerprint: p.bindingFingerprint });
  }
  private sealed(row: ObsidianNoteReplacePlan): VaultFileCreatePreflight {
    if (row.projection?.kind !== this.profile.operationKind || row.projection.contractVersion !== 1) bad("create_domain_mismatch");
    const plan = Preflight.parse(row.projection.proof.preflight);
    vaultFileCreatePath(this.kind, plan.path);
    if (plan.kind !== this.kind || row.path !== plan.path || row.bindingFingerprint !== plan.bindingFingerprint ||
        row.idempotencyIdentity !== this.intent(row.path, row.afterSha256) || row.projection.intentDigest !== row.idempotencyIdentity ||
        row.beforeSha256 !== this.absence(row) ||
        row.requestDigest !== operationDigest({ ...plan, contentSha256: row.afterSha256, formatWarnings: row.projection.proof.formatWarnings ?? [] }) ||
        (["planned", "applying", "outcome_unknown"].includes(row.status) && vaultFileCreateHash(row.nextContent) !== row.afterSha256)) bad("create_seal_mismatch");
    return plan;
  }
  private require(ref: string, key?: string): ObsidianNoteReplacePlan {
    const prefix = this.profile.planRefPrefix;
    if (!ref.startsWith(prefix) || !z.string().uuid().safeParse(ref.slice(prefix.length)).success) bad("invalid_create_reference");
    const row = this.journal.get(ref.slice(prefix.length));
    if (!row) bad("create_plan_unavailable");
    this.sealed(row);
    if (key !== undefined && (row.idempotencyKey !== this.internalKey(key) || row.projection!.publicIdempotencyKey !== key)) bad("create_key_mismatch");
    return row;
  }
  private async vaultBindingForCreate(expectedCreateBinding: string): Promise<string> {
    const status = await this.backend.status() as unknown as Record<string, any> | null;
    const vault = HASH.safeParse(status?.backend?.bindingFingerprint);
    const grant = status?.[this.profile.statusField];
    if (!grant || grant.supported !== true) bad("create_bridge_unsupported");
    if (!vault.success || grant.enabled !== true || grant.bindingFingerprint !== expectedCreateBinding) bad("create_preflight_identity_mismatch");
    return vault.data;
  }
  async plan(input: VaultFileCreatePlanInput) {
    assertNewNotePath(input.path, { extensions: [this.profile.extension] });
    try { validateVaultFileCreateContent(input.content); } catch { bad("create_content_invalid"); }
    const format = vaultFileCreateFormat(this.kind, input.content);
    const key = this.internalKey(input.idempotencyKey), hash = vaultFileCreateHash(input.content), identity = this.intent(input.path, hash);
    const winner = () => {
      const row = this.journal.getByIdempotencyKey(key);
      if (row) { this.sealed(row); if (row.idempotencyIdentity !== identity) bad("create_idempotency_conflict"); }
      return row;
    };
    const old = winner(); if (old) return this.receipt(old);
    this.authorize("plan", input.path, input.content);
    // An older Bridge has no route for this kind: say so instead of a bare 404.
    const capability = (await this.backend.status() as unknown as Record<string, any> | null)?.[this.profile.statusField];
    if (!capability || capability.supported !== true) bad("create_bridge_unsupported");
    let plan: VaultFileCreatePreflight;
    try { plan = WirePreflight.parse(await this.backend.preflight(input.path)); }
    catch (error) { const existing = winner(); if (existing) return this.receipt(existing); throw error; }
    if (plan.path !== input.path || plan.kind !== this.kind) bad("create_preflight_identity_mismatch");
    plan = { ...plan, vaultBindingFingerprint: await this.vaultBindingForCreate(plan.bindingFingerprint) };
    this.authorize("plan", input.path, input.content);
    const row = this.journal.create({ idempotencyKey: key, idempotencyIdentity: identity, path: input.path,
      nextContent: input.content, beforeSha256: this.absence(plan), afterSha256: hash,
      bindingFingerprint: plan.bindingFingerprint, requestDigest: operationDigest({ ...plan, contentSha256: hash, formatWarnings: format.warnings }),
      projection: { contractVersion: 1, kind: this.profile.operationKind, publicIdempotencyKey: input.idempotencyKey, intentDigest: identity,
        proof: { preflight: plan, formatWarnings: format.warnings } } });
    return this.receipt(row);
  }
  async apply(ref: string, key: string) {
    let row = this.require(ref, key);
    if (row.status !== "planned") return this.status(ref);
    const admitted = this.sealed(row);
    this.authorize("apply", row.path, row.nextContent);
    if (!admitted.vaultBindingFingerprint) bad("create_preflight_identity_mismatch");
    if (await this.vaultBindingForCreate(admitted.bindingFingerprint) !== admitted.vaultBindingFingerprint) bad("create_preflight_identity_mismatch");
    try { row = this.journal.transition(row.operationId, ["planned"], "applying"); }
    catch (error) { if (error instanceof ObsidianNoteReplaceConcurrencyError) return this.status(ref); throw error; }
    const attempt = row.executionOwner!.attemptId;
    let dispatched = false;
    try {
      this.sealed(row);
      this.authorize("apply", row.path, row.nextContent);
      // Durable effect-fence token before the request exists; a stale owner stops here.
      const fenceEpoch = effectFenceEpoch(await this.backend.status());
      row = this.journal.recordEffectAttempt(row.operationId, attempt, fenceEpoch);
      dispatched = true;
      const result = Result.parse(await this.backend.create({ contractVersion: 1, operationId: row.operationId, path: row.path,
        content: row.nextContent, contentSha256: row.afterSha256, bindingFingerprint: row.bindingFingerprint,
        ...(fenceEpoch ? { fence: { contractVersion: 1 as const, epoch: fenceEpoch, attemptId: attempt } } : {}) }));
      if (result.kind !== this.kind || result.operationId !== row.operationId || result.path !== row.path ||
          result.bindingFingerprint !== row.bindingFingerprint || result.contentSha256 !== row.afterSha256) bad("create_result_identity_mismatch");
      if (result.outcome !== "created") {
        row = this.journal.transition(row.operationId, ["applying"], result.outcome, "create_not_acknowledged", attempt);
      }
    } catch {
      try { row = this.journal.transition(row.operationId, ["applying"], dispatched ? "outcome_unknown" : "rejected", "create_dispatch_unverified", attempt); }
      catch (error) { if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error; }
    }
    return this.status(ref);
  }
  async status(ref: string) {
    let row = this.require(ref);
    if (!["applying", "outcome_unknown", "committed"].includes(row.status)) return this.receipt(row);
    let postflight: "verified" | "unverified" = "unverified";
    try {
      this.sealed(row);
      const observation = Inspection.parse(await this.backend.inspect(row.path));
      if (observation.kind !== this.kind || observation.path !== row.path || observation.bindingFingerprint !== row.bindingFingerprint ||
          (observation.exists && (observation.content === undefined || vaultFileCreateHash(observation.content) !== observation.sha256))) bad("create_observation_invalid");
      if (row.status === "committed") {
        postflight = observation.exists && observation.sha256 === row.effectProof?.digest ? "verified" : "unverified";
      } else if (observation.exists) {
        // No automatic field is excused for these kinds: only the exact sealed bytes reconcile.
        if (observation.content === row.nextContent) {
          row = this.journal.commitAfterVerifiedProof(row.operationId, ["applying", "outcome_unknown"], {
            kind: `${this.profile.route}-observed-state`, digest: observation.sha256!,
            details: { match: "exact", authorAttribution: "not_proven", observedAt: new Date(this.now()).toISOString() },
          });
          postflight = "verified";
        } else if (row.status === "applying") {
          row = this.journal.transition(row.operationId, ["applying"], "outcome_unknown",
            "create_postflight_unverified", row.executionOwner?.attemptId);
        }
      }
    } catch { row = this.require(ref); }
    return this.receipt(row, postflight);
  }
  private receipt(row: ObsidianNoteReplacePlan, postflight: "verified" | "unverified" = "unverified") {
    this.sealed(row);
    return { contractVersion: 1, operationKind: this.profile.operationKind, fileKind: this.kind, operationId: row.operationId,
      planRef: this.profile.planRefPrefix + row.operationId,
      planDigest: row.requestDigest, path: row.path, phase: row.status === "planned" ? "planned" : row.status === "applying" ? "applying" : "terminal",
      outcome: ["planned", "applying"].includes(row.status) ? null : row.status,
      beforeProof: { kind: "observed-path-absence", digest: row.beforeSha256 },
      expectedContentSha256: row.afterSha256, effectProof: row.effectProof ?? null, postflight,
      formatWarnings: row.projection?.proof.formatWarnings ?? [],
      applyAllowed: row.status === "planned", recoveryAllowed: false,
      nextAction: row.status === "planned" ? "apply" : ["applying", "outcome_unknown"].includes(row.status) ? "status" : "none",
      indexing: "not_certified", authorAttribution: "not_proven", admittedAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
}
