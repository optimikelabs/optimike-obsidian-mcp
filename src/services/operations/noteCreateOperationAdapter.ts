import { z } from "zod";
import { load } from "js-yaml";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { validateObsidianMarkdown } from "../obsidianFormatService.js";
import { assertWriteAllowed } from "../writePolicy.js";
import { nativeNotePath } from "../nativeNoteMoveContract.js";
import { NOTE_CREATE_PREFIX, NOTE_CREATE_MAX_BYTES, createPolicyDigest, noteCreateHash, observeCreateContent, validateCreatePolicy, validateNoteCreate,
  type NoteCreateApply, type NoteCreatePreflight } from "../noteCreateContract.js";
import { operationDigest } from "./contract.js";
import { ObsidianNoteReplaceJournal, ObsidianNoteReplaceConcurrencyError, type ObsidianNoteReplacePlan } from "./obsidianNoteReplaceJournal.js";

/** Newly created user-authored frontmatter is a change from the empty document.
 * Parse YAML, including quoted and merged keys, instead of a regex key scan.
 */
export function noteCreateFrontmatterKeys(content: string): string[] {
  if (!/^---\r?\n/u.test(content)) return [];
  const lines = content.split(/\r?\n/u);
  const end = lines.findIndex((line, i) => i > 0 && line === "---");
  if (end < 0) throw new Error("invalid_create_frontmatter");
  const value: unknown = load(lines.slice(1, end).join("\n"));
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_create_frontmatter");
  return Object.keys(value);
}

const KIND = "obsidian.note.create";
const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const Policy = z.object({ version: z.literal(1), utcOffsetMinutes: z.number().int().min(-840).max(840),
  fields: z.array(z.object({ pluginId: z.enum(["update-time-on-edit", "frontmatter-date-manager", "update-time"]),
    propertyName: z.string().min(1).max(128), role: z.enum(["created", "modified"]), delayMs: z.number().int().min(0).max(240000),
  }).strict()).max(6) }).strict();
const Preflight = z.object({ contractVersion: z.literal(1), path: z.string().max(1024), bindingFingerprint: HASH,
  absent: z.literal(true), enabled: z.literal(true), policy: Policy, policyDigest: HASH }).strict();
const Inspection = z.object({ contractVersion: z.literal(1), path: z.string().max(1024), bindingFingerprint: HASH,
  policyDigest: HASH, exists: z.boolean(), content: z.string().max(NOTE_CREATE_MAX_BYTES).optional(), sha256: HASH.optional() }).strict();
const Result = z.object({ contractVersion: z.literal(1), operationId: z.string().uuid(), path: z.string().max(1024),
  bindingFingerprint: HASH, policyDigest: HASH, contentSha256: HASH,
  outcome: z.enum(["created", "conflict", "outcome_unknown"]), reason: z.string().regex(/^[a-z_]{1,96}$/u) }).strict();
export interface NoteCreateBackend {
  preflight(path: string): Promise<unknown>;
  create(request: NoteCreateApply): Promise<unknown>;
  inspect(path: string): Promise<unknown>;
}
export type NoteCreatePlanInput = { path: string; content: string; idempotencyKey: string };
function bad(reason: string): never { throw new McpError(BaseErrorCode.CONFLICT, "The sealed creation could not be admitted or verified.", { reason }); }
function internalKey(value: string): string {
  if (!z.string().min(1).max(256).safeParse(value).success) bad("invalid_create_key");
  return "optimike:projection:v1:note-create:" + noteCreateHash(value);
}
const intent = (path: string, hash: string) => operationDigest({ path, contentSha256: hash });
const absence = (p: Pick<NoteCreatePreflight, "path" | "bindingFingerprint">) => operationDigest({ kind: "observed-absence", ...p });

/** Durable control is shared with other governed note operations; effects use exclusive create only. */
export class NoteCreateOperationAdapter {
  constructor(private readonly backend: NoteCreateBackend, private readonly journal: ObsidianNoteReplaceJournal,
    private readonly now = Date.now,
    private readonly authorize: (phase: "plan" | "apply", path: string, content: string) => void = (phase, path, content) =>
      assertWriteAllowed({ operation: phase === "plan" ? "obsidian_note_create_plan" : "obsidian_note_create_apply",
        action: phase, target: path, targetType: "filePath", contentLength: content.length, frontmatterKeys: noteCreateFrontmatterKeys(content) }),
  ) {}
  private sealed(row: ObsidianNoteReplacePlan): NoteCreatePreflight {
    if (row.projection?.kind !== KIND || row.projection.contractVersion !== 1) bad("create_domain_mismatch");
    const plan = Preflight.parse(row.projection.proof.preflight);
    nativeNotePath(plan.path); validateCreatePolicy(plan.policy);
    if (createPolicyDigest(plan.policy) !== plan.policyDigest || row.path !== plan.path || row.bindingFingerprint !== plan.bindingFingerprint ||
        row.idempotencyIdentity !== intent(row.path, row.afterSha256) || row.projection.intentDigest !== row.idempotencyIdentity ||
        row.beforeSha256 !== absence({ path: row.path, bindingFingerprint: row.bindingFingerprint }) ||
        row.requestDigest !== operationDigest({ ...plan, contentSha256: row.afterSha256 }) ||
        (["planned", "applying", "outcome_unknown"].includes(row.status) && noteCreateHash(row.nextContent) !== row.afterSha256)) bad("create_seal_mismatch");
    return plan;
  }
  private require(ref: string, key?: string): ObsidianNoteReplacePlan {
    if (!ref.startsWith(NOTE_CREATE_PREFIX) || !z.string().uuid().safeParse(ref.slice(NOTE_CREATE_PREFIX.length)).success) bad("invalid_create_reference");
    const row = this.journal.get(ref.slice(NOTE_CREATE_PREFIX.length));
    if (!row) bad("create_plan_unavailable");
    this.sealed(row);
    if (key !== undefined && (row.idempotencyKey !== internalKey(key) || row.projection!.publicIdempotencyKey !== key)) bad("create_key_mismatch");
    return row;
  }
  async plan(input: NoteCreatePlanInput) {
    nativeNotePath(input.path);
    validateNoteCreate(input.path, input.content, { version: 1, utcOffsetMinutes: 0, fields: [] });
    if (!validateObsidianMarkdown(input.content).ok) bad("create_markdown_invalid");
    const key = internalKey(input.idempotencyKey), hash = noteCreateHash(input.content), identity = intent(input.path, hash);
    const winner = () => {
      const row = this.journal.getByIdempotencyKey(key);
      if (row) { this.sealed(row); if (row.idempotencyIdentity !== identity) bad("create_idempotency_conflict"); }
      return row;
    };
    const old = winner(); if (old) return this.receipt(old);
    this.authorize("plan", input.path, input.content);
    let plan: NoteCreatePreflight;
    try { plan = Preflight.parse(await this.backend.preflight(input.path)); }
    catch (error) { const existing = winner(); if (existing) return this.receipt(existing); throw error; }
    if (plan.path !== input.path || createPolicyDigest(plan.policy) !== plan.policyDigest) bad("create_preflight_identity_mismatch");
    validateNoteCreate(input.path, input.content, plan.policy);
    this.authorize("plan", input.path, input.content);
    const row = this.journal.create({ idempotencyKey: key, idempotencyIdentity: identity, path: input.path,
      nextContent: input.content, beforeSha256: absence({ path: input.path, bindingFingerprint: plan.bindingFingerprint }), afterSha256: hash,
      bindingFingerprint: plan.bindingFingerprint, requestDigest: operationDigest({ ...plan, contentSha256: hash }),
      projection: { contractVersion: 1, kind: KIND, publicIdempotencyKey: input.idempotencyKey, intentDigest: identity, proof: { preflight: plan } } });
    return this.receipt(row);
  }
  async apply(ref: string, key: string) {
    let row = this.require(ref, key);
    if (row.status !== "planned") return this.status(ref);
    this.authorize("apply", row.path, row.nextContent);
    try { row = this.journal.transition(row.operationId, ["planned"], "applying"); }
    catch (error) { if (error instanceof ObsidianNoteReplaceConcurrencyError) return this.status(ref); throw error; }
    const attempt = row.executionOwner!.attemptId;
    let dispatched = false;
    try {
      this.authorize("apply", row.path, row.nextContent);
      const plan = this.sealed(row);
      dispatched = true;
      const result = Result.parse(await this.backend.create({ contractVersion: 1, operationId: row.operationId, path: row.path,
        content: row.nextContent, contentSha256: row.afterSha256, bindingFingerprint: row.bindingFingerprint, policyDigest: plan.policyDigest }));
      if (result.operationId !== row.operationId || result.path !== row.path || result.bindingFingerprint !== row.bindingFingerprint ||
          result.contentSha256 !== row.afterSha256 || result.policyDigest !== plan.policyDigest) bad("create_result_identity_mismatch");
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
    let postflight: "pending" | "verified" | "unverified" = "unverified";
    try {
      const plan = this.sealed(row), observation = Inspection.parse(await this.backend.inspect(row.path));
      if (observation.path !== row.path || observation.bindingFingerprint !== row.bindingFingerprint || observation.policyDigest !== plan.policyDigest ||
          (observation.exists && (observation.content === undefined || noteCreateHash(observation.content) !== observation.sha256))) bad("create_observation_invalid");
      if (row.status === "committed") {
        postflight = observation.exists && observation.sha256 === row.effectProof?.digest ? "verified" : "unverified";
      } else if (observation.exists) {
        const start = row.executionStartedAtEpochMs;
        if (start === undefined) bad("create_execution_timestamp_missing");
        if (row.settlementObservationStartedAtEpochMs === undefined) {
          row = this.journal.beginModifiedTimeSettlementObservation(row.operationId,
            ["applying", "outcome_unknown"], row.executionOwner?.attemptId);
        }
        const observationDelay = Math.max(0, ...plan.policy.fields.map(field => field.delayMs));
        const settled = this.now() - row.settlementObservationStartedAtEpochMs! >= observationDelay;
        const match = settled ? observeCreateContent(row.nextContent, observation.content!, plan.policy, start, this.now()) : undefined;
        if (match) {
          row = this.journal.commitAfterVerifiedProof(row.operationId, ["applying", "outcome_unknown"], {
            kind: "note-create-observed-state", digest: match.sha256,
            details: { match: match.kind, authorAttribution: "not_proven", observedAt: new Date(this.now()).toISOString() },
          });
          postflight = "verified";
        } else if (!settled) postflight = "pending";
      }
    } catch { row = this.require(ref); }
    return this.receipt(row, postflight);
  }
  private receipt(row: ObsidianNoteReplacePlan, postflight: "pending" | "verified" | "unverified" = "unverified") {
    const plan = this.sealed(row);
    return { contractVersion: 1, operationKind: KIND, operationId: row.operationId, planRef: NOTE_CREATE_PREFIX + row.operationId,
      planDigest: row.requestDigest, path: row.path, phase: row.status === "planned" ? "planned" : row.status === "applying" ? "applying" : "terminal",
      outcome: ["planned", "applying"].includes(row.status) ? null : row.status,
      beforeProof: { kind: "observed-path-absence", digest: row.beforeSha256 },
      expectedContentSha256: row.afterSha256, effectProof: row.effectProof ?? null, postflight,
      automaticDateFields: plan.policy.fields.map(field => ({ propertyName: field.propertyName, role: field.role })),
      applyAllowed: row.status === "planned", recoveryAllowed: false, nextAction: row.status === "planned" ? "apply" : "status",
      indexing: "not_certified", authorAttribution: "not_proven", admittedAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
}
