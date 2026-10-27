import { z } from "zod/v3";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { assertWriteAllowed } from "../writePolicy.js";
import {
  NOTE_DELETE_PREFIX, noteDeleteDigest, verifyNoteDeletePreflight,
  type NoteDeleteApply, type NoteDeleteObservation, type NoteDeletePreflight,
} from "../noteDeleteContract.js";
import { nativeNotePath } from "../nativeNoteMoveContract.js";
import {
  ObsidianNoteReplaceConcurrencyError, ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
} from "./obsidianNoteReplaceJournal.js";

const KIND = "obsidian.note.delete";
const KEY_PREFIX = "optimike:projection:v1:note-delete:";
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Snapshot = z.object({
  contractVersion: z.literal(1), bindingFingerprint: Hash, path: z.string().max(1024),
  sha256: Hash, byteLength: z.number().int().nonnegative().safe(),
  backlinks: z.array(z.object({ sourcePath: z.string().max(1024), count: z.number().int().positive().safe() }).strict()).max(200),
  acknowledgeBacklinks: z.boolean(), trashOption: z.enum(["local", "system"]), preconditionDigest: Hash,
}).strict();
const Observation = z.object({
  contractVersion: z.literal(1), operationId: z.string().uuid(), bindingFingerprint: Hash,
  preconditionDigest: Hash, outcome: z.enum(["committed", "conflict", "rejected", "outcome_unknown"]),
  reason: z.string().regex(/^[a-z_]{1,96}$/u), trashOption: z.enum(["local", "system"]),
  trashPostflight: z.enum(["pending", "verified", "path_absent_only", "failed", "indeterminate"]),
  replayAllowed: z.literal(false),
}).strict();

export interface NoteDeleteBackend {
  preflight(path: string, acknowledgeBacklinks: boolean): Promise<unknown>;
  apply(request: NoteDeleteApply): Promise<unknown>;
  status(operationId: string, preconditionDigest: string): Promise<unknown>;
}
export type NoteDeletePlanInput = { path: string; acknowledgeBacklinks?: boolean; idempotencyKey: string };

function bad(reason: string, code: BaseErrorCode = BaseErrorCode.CONFLICT): never {
  throw new McpError(code, "The note deletion request or its durable identity is invalid.", { reasonCode: reason });
}
function key(value: string): string {
  if (!z.string().min(1).max(256).safeParse(value).success) bad("invalid_delete_key", BaseErrorCode.VALIDATION_ERROR);
  return KEY_PREFIX + noteDeleteDigest(value);
}
function preflight(value: unknown): NoteDeletePreflight {
  const result = Snapshot.safeParse(value);
  if (!result.success) bad("delete_preflight_invalid");
  try { return verifyNoteDeletePreflight(result.data); }
  catch { return bad("delete_preflight_invalid"); }
}

/** The Bridge refusals that mean something to the caller, mapped to closed public reason codes. */
const BRIDGE_REFUSALS: Readonly<Record<string, readonly [BaseErrorCode, string]>> = {
  note_has_backlinks: [BaseErrorCode.VALIDATION_ERROR, "delete_note_has_backlinks"],
  trash_preference_permanent: [BaseErrorCode.FORBIDDEN, "delete_trash_preference_permanent"],
  trash_preference_unavailable: [BaseErrorCode.SERVICE_UNAVAILABLE, "delete_trash_preference_unavailable"],
  note_delete_disabled: [BaseErrorCode.FORBIDDEN, "delete_bridge_grant_disabled"],
  delete_backlink_limit: [BaseErrorCode.VALIDATION_ERROR, "delete_backlink_limit"],
  note_not_found: [BaseErrorCode.NOT_FOUND, "delete_note_not_found"],
  physical_path_unsupported: [BaseErrorCode.VALIDATION_ERROR, "delete_physical_path_unsupported"],
  invalid_note_path: [BaseErrorCode.VALIDATION_ERROR, "delete_path_invalid"],
};
function bridgeReason(error: unknown): string | undefined {
  const reasonCode = (error as { details?: { reasonCode?: unknown }; reasonCode?: unknown } | undefined);
  for (const value of [reasonCode?.details?.reasonCode, reasonCode?.reasonCode]) {
    if (typeof value === "string" && Object.hasOwn(BRIDGE_REFUSALS, value)) return value;
  }
  return undefined;
}

/** Reuses the process-owned SQLite journal; never calls the replacement CAS adapter. */
export class NoteDeleteOperationAdapter {
  constructor(
    private readonly backend: NoteDeleteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly authorize: (phase: "plan" | "apply", path: string) => void = (phase, path) =>
      assertWriteAllowed({ operation: phase === "plan" ? "obsidian_note_delete_plan" : "obsidian_note_delete_apply",
        action: phase, target: path, targetType: "filePath", destructive: true }),
  ) {}

  private sealed(row: ObsidianNoteReplacePlan): NoteDeletePreflight {
    if (row.projection?.kind !== KIND || row.projection.contractVersion !== 1) bad("delete_domain_mismatch");
    const plan = preflight(row.projection.proof.preflight);
    if (row.path !== plan.path || row.bindingFingerprint !== plan.bindingFingerprint ||
        row.requestDigest !== plan.preconditionDigest || row.beforeSha256 !== plan.sha256 ||
        row.afterSha256 !== row.beforeSha256) bad("delete_seal_mismatch");
    return plan;
  }
  private require(reference: string, idempotencyKey?: string): ObsidianNoteReplacePlan {
    if (!reference.startsWith(NOTE_DELETE_PREFIX)) bad("delete_reference_invalid");
    const id = reference.slice(NOTE_DELETE_PREFIX.length);
    if (!z.string().uuid().safeParse(id).success) bad("delete_reference_invalid");
    const row = this.journal.get(id);
    if (!row) bad("delete_reference_unavailable", BaseErrorCode.NOT_FOUND);
    this.sealed(row);
    if (idempotencyKey !== undefined && (row.idempotencyKey !== key(idempotencyKey) ||
        row.projection!.publicIdempotencyKey !== idempotencyKey)) bad("delete_key_mismatch");
    return row;
  }
  private lookup(internalKey: string, identity: string): ObsidianNoteReplacePlan | undefined {
    const row = this.journal.getByIdempotencyKey(internalKey);
    if (!row) return undefined;
    this.sealed(row);
    if (row.idempotencyIdentity !== identity) bad("delete_key_intent_conflict");
    return row;
  }

  async plan(input: NoteDeletePlanInput) {
    let path: string;
    try { path = nativeNotePath(input.path); }
    catch { return bad("delete_path_invalid", BaseErrorCode.VALIDATION_ERROR); }
    const acknowledge = input.acknowledgeBacklinks === true;
    const internalKey = key(input.idempotencyKey);
    const identity = noteDeleteDigest({ path, acknowledgeBacklinks: acknowledge });
    const existing = this.lookup(internalKey, identity);
    if (existing) return this.receipt(existing);
    this.authorize("plan", path);
    let observed: NoteDeletePreflight;
    try {
      observed = preflight(await this.backend.preflight(path, acknowledge));
      if (observed.path !== path || observed.acknowledgeBacklinks !== acknowledge) bad("delete_target_mismatch");
    } catch (error) {
      const winner = this.lookup(internalKey, identity);
      if (winner) return this.receipt(winner);
      const refusal = bridgeReason(error);
      if (refusal) {
        const [code, reasonCode] = BRIDGE_REFUSALS[refusal];
        throw new McpError(code, "The note deletion was refused by the Bridge policy.", { reasonCode });
      }
      throw error;
    }
    const winner = this.lookup(internalKey, identity);
    if (winner) return this.receipt(winner);
    this.authorize("plan", path);
    const row = this.journal.create({
      idempotencyKey: internalKey, idempotencyIdentity: identity, path,
      beforeSha256: observed.sha256,
      // Legacy storage envelope: not an expected post-delete content hash. All delete
      // proofs live in the typed projection; replacement tools reject this domain.
      afterSha256: observed.sha256, nextContent: "", bindingFingerprint: observed.bindingFingerprint,
      requestDigest: observed.preconditionDigest,
      projection: { contractVersion: 1, kind: KIND, publicIdempotencyKey: input.idempotencyKey,
        intentDigest: identity, proof: { preflight: observed } },
    });
    return this.receipt(row);
  }

  private observation(value: unknown, row: ObsidianNoteReplacePlan): NoteDeleteObservation {
    const result = Observation.safeParse(value);
    if (!result.success) bad("delete_observation_invalid");
    const observed = result.data;
    const plan = this.sealed(row);
    if (observed.operationId !== row.operationId || observed.bindingFingerprint !== row.bindingFingerprint ||
        observed.preconditionDigest !== row.requestDigest || observed.trashOption !== plan.trashOption ||
        (observed.trashPostflight === "verified" && observed.outcome !== "committed") ||
        (observed.trashPostflight === "path_absent_only" && observed.outcome !== "committed")) {
      bad("delete_observation_identity_mismatch");
    }
    return observed;
  }

  async apply(reference: string, idempotencyKey: string) {
    let row = this.require(reference, idempotencyKey);
    if (row.status !== "planned") return this.status(reference);
    this.authorize("apply", row.path);
    try { row = this.journal.transition(row.operationId, ["planned"], "applying"); }
    catch (error) {
      if (error instanceof ObsidianNoteReplaceConcurrencyError) return this.status(reference);
      throw error;
    }
    const attemptId = row.executionOwner!.attemptId;
    let observed: NoteDeleteObservation | undefined;
    try {
      this.authorize("apply", row.path);
      const plan = this.sealed(row);
      observed = this.observation(await this.backend.apply({ contractVersion: 1, operationId: row.operationId,
        path: plan.path, bindingFingerprint: row.bindingFingerprint, preconditionDigest: row.requestDigest }), row);
      row = this.journal.transition(row.operationId, ["applying"], observed.outcome,
        observed.outcome === "committed" ? undefined : "note_delete_not_committed", attemptId);
    } catch {
      try { row = this.journal.transition(row.operationId, ["applying"], "outcome_unknown", "note_delete_reply_unavailable", attemptId); }
      catch (error) {
        if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
        row = this.require(reference, idempotencyKey);
      }
    }
    return this.receipt(row, observed);
  }

  async status(reference: string) {
    let row = this.require(reference);
    if (!["applying", "outcome_unknown", "committed"].includes(row.status)) return this.receipt(row);
    let observed: NoteDeleteObservation | undefined;
    try {
      observed = this.observation(await this.backend.status(row.operationId, row.requestDigest), row);
      if (observed.outcome === "committed" && row.status !== "committed") {
        row = this.journal.commitAfterVerifiedProof(row.operationId, ["applying", "outcome_unknown"]);
      } else if (observed.outcome === "conflict" && ["applying", "outcome_unknown"].includes(row.status)) {
        // The identity-checked backend receipt proves rejection before dispatch.
        row = this.journal.transition(row.operationId, ["applying", "outcome_unknown"],
          "conflict", "note_delete_precondition_conflict", row.executionOwner?.attemptId);
      }
    } catch {
      row = this.require(reference);
      observed = undefined;
    }
    return this.receipt(row, observed);
  }

  private receipt(row: ObsidianNoteReplacePlan, observed?: NoteDeleteObservation) {
    const sealed = this.sealed(row);
    const committed = row.status === "committed";
    const postflight = committed && observed?.outcome === "committed" ? observed.trashPostflight : "indeterminate";
    return {
      contractVersion: 1, operationKind: KIND, operationId: row.operationId,
      planRef: NOTE_DELETE_PREFIX + row.operationId, planDigest: row.requestDigest,
      phase: row.status === "planned" ? "planned" : row.status === "applying" ? "applying" : "terminal",
      outcome: row.status === "planned" || row.status === "applying" ? null : row.status,
      target: { path: sealed.path },
      beforeProof: { sha256: row.beforeSha256, byteLength: sealed.byteLength, preconditionDigest: row.requestDigest },
      incomingLinks: { acknowledged: sealed.acknowledgeBacklinks, sources: sealed.backlinks },
      trash: { preference: sealed.trashOption, destination: sealed.trashOption === "local" ? "vault_trash_folder" : "system_trash_or_vault_trash" },
      postflight: { status: postflight, reason: observed?.reason ?? null },
      limitations: ["native_trash_is_not_source_content_CAS_but_hash_rechecked_before_effect", "backend_acknowledgements_are_process_local",
        "links_to_the_note_are_left_unresolved_not_rewritten", "system_trash_location_is_not_observable"],
      applyAllowed: row.status === "planned", recoveryAllowed: false,
      nextAction: row.status === "planned" ? "apply" : ["applying", "outcome_unknown"].includes(row.status) ? "status" : "none",
      admittedAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
}
