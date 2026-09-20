import { z } from "zod";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { assertWriteAllowed } from "../writePolicy.js";
import {
  NATIVE_MOVE_PREFIX, nativeDigest, nativeMovePaths, verifyNativeMovePreflight,
  type NativeMoveApply, type NativeMoveObservation, type NativeMovePreflight,
} from "../nativeNoteMoveContract.js";
import {
  ObsidianNoteReplaceConcurrencyError, ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
} from "./obsidianNoteReplaceJournal.js";

const KIND = "obsidian.note.move";
const KEY_PREFIX = "optimike:projection:v1:native-move:";
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Ref = z.object({
  kind: z.enum(["link", "embed", "frontmatter"]),
  targetPath: z.string().max(1024).nullable(),
  unresolvedPath: z.string().max(4096).nullable(), subpath: z.string().max(4096),
  anchor: z.enum(["valid:heading", "valid:block", "valid:footnote", "not_requested", "invalid", "unknown"]),
}).strict();
const Snapshot = z.object({
  contractVersion: z.literal(1), bindingFingerprint: Hash,
  sourcePath: z.string().max(1024), destinationPath: z.string().max(1024), updateLinks: z.boolean(),
  notes: z.array(z.object({ path: z.string().max(1024), sha256: Hash,
    references: z.array(Ref).max(200),
    backlinks: z.array(z.object({ sourcePath: z.string().max(1024), count: z.number().int().positive().safe() }).strict()).max(200),
    unresolved: z.array(z.object({ linkText: z.string().max(4096), count: z.number().int().positive().safe() }).strict()).max(200),
  }).strict()).min(1).max(17),
  preconditionDigest: Hash, expectedGraphDigest: Hash,
}).strict();
const Observation = z.object({
  contractVersion: z.literal(1), operationId: z.string().uuid(), bindingFingerprint: Hash,
  preconditionDigest: Hash, outcome: z.enum(["committed", "conflict", "rejected", "outcome_unknown"]),
  reason: z.string().regex(/^[a-z_]{1,96}$/u), afterSha256: Hash.optional(),
  graphPostflight: z.enum(["pending", "verified", "failed", "indeterminate"]),
  observedGraphDigest: Hash.optional(), scope: z.literal("sealed_neighborhood_only"), replayAllowed: z.literal(false),
}).strict();
export interface NativeNoteMoveBackend {
  preflight(sourcePath: string, destinationPath: string): Promise<unknown>;
  apply(request: NativeMoveApply): Promise<unknown>;
  status(operationId: string, preconditionDigest: string): Promise<unknown>;
}
export type NativeMovePlanInput = { sourcePath: string; destinationPath: string; idempotencyKey: string };

function bad(reason: string): never {
  throw new McpError(BaseErrorCode.CONFLICT, "The native move request or its durable identity is invalid.", { reason });
}
function key(value: string): string {
  if (!z.string().min(1).max(256).safeParse(value).success) bad("invalid_native_move_key");
  return KEY_PREFIX + nativeDigest(value);
}
function preflight(value: unknown): NativeMovePreflight {
  const result = Snapshot.safeParse(value);
  if (!result.success) bad("native_move_preflight_invalid");
  return verifyNativeMovePreflight(result.data);
}

/** Reuses the process-owned SQLite journal; never calls the replacement CAS adapter. */
export class NativeNoteMoveOperationAdapter {
  constructor(
    private readonly backend: NativeNoteMoveBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly authorize: (phase: "plan" | "apply", sourcePath: string) => void = (phase, sourcePath) =>
      assertWriteAllowed({ operation: phase === "plan" ? "obsidian_note_move_plan" : "obsidian_note_move_apply",
        action: phase, target: sourcePath, targetType: "filePath", destructive: true }),
  ) {}

  private sealed(row: ObsidianNoteReplacePlan): NativeMovePreflight {
    if (row.projection?.kind !== KIND || row.projection.contractVersion !== 1) bad("native_move_domain_mismatch");
    const plan = preflight(row.projection.proof.preflight);
    if (row.path !== plan.sourcePath || row.bindingFingerprint !== plan.bindingFingerprint ||
        row.requestDigest !== plan.preconditionDigest || row.beforeSha256 !== plan.notes.find(n => n.path === plan.sourcePath)!.sha256 ||
        row.afterSha256 !== row.beforeSha256) bad("native_move_seal_mismatch");
    return plan;
  }
  private require(reference: string, idempotencyKey?: string): ObsidianNoteReplacePlan {
    if (!reference.startsWith(NATIVE_MOVE_PREFIX)) bad("native_move_reference_invalid");
    const id = reference.slice(NATIVE_MOVE_PREFIX.length);
    if (!z.string().uuid().safeParse(id).success) bad("native_move_reference_invalid");
    const row = this.journal.get(id);
    if (!row) bad("native_move_reference_unavailable");
    this.sealed(row);
    if (idempotencyKey !== undefined && (row.idempotencyKey !== key(idempotencyKey) ||
        row.projection!.publicIdempotencyKey !== idempotencyKey)) bad("native_move_key_mismatch");
    return row;
  }
  private lookup(internalKey: string, identity: string): ObsidianNoteReplacePlan | undefined {
    const row = this.journal.getByIdempotencyKey(internalKey);
    if (!row) return undefined;
    this.sealed(row);
    if (row.idempotencyIdentity !== identity) bad("native_move_key_intent_conflict");
    return row;
  }
  async plan(input: NativeMovePlanInput) {
    const paths = nativeMovePaths(input.sourcePath, input.destinationPath);
    const internalKey = key(input.idempotencyKey);
    const identity = nativeDigest(paths);
    const existing = this.lookup(internalKey, identity);
    if (existing) return this.receipt(existing);
    this.authorize("plan", paths.sourcePath);
    let observed: NativeMovePreflight;
    try {
      observed = preflight(await this.backend.preflight(paths.sourcePath, paths.destinationPath));
      if (observed.sourcePath !== paths.sourcePath || observed.destinationPath !== paths.destinationPath) bad("native_move_target_mismatch");
    } catch (error) {
      const winner = this.lookup(internalKey, identity);
      if (winner) return this.receipt(winner);
      throw error;
    }
    const winner = this.lookup(internalKey, identity);
    if (winner) return this.receipt(winner);
    this.authorize("plan", paths.sourcePath);
    const sourceHash = observed.notes.find(note => note.path === paths.sourcePath)!.sha256;
    const row = this.journal.create({
      idempotencyKey: internalKey, idempotencyIdentity: identity, path: paths.sourcePath,
      beforeSha256: sourceHash,
      // Legacy storage envelope: this is NOT an expected post-rename content hash.
      // All move proofs live in the typed projection; replacement tools reject this domain.
      afterSha256: sourceHash, nextContent: "", bindingFingerprint: observed.bindingFingerprint,
      requestDigest: observed.preconditionDigest,
      projection: { contractVersion: 1, kind: KIND, publicIdempotencyKey: input.idempotencyKey,
        intentDigest: identity, proof: { preflight: observed } },
    });
    return this.receipt(row);
  }
  private observation(value: unknown, row: ObsidianNoteReplacePlan): NativeMoveObservation {
    const result = Observation.safeParse(value);
    if (!result.success) bad("native_move_observation_invalid");
    const observed = result.data;
    const plan = this.sealed(row);
    if (observed.operationId !== row.operationId || observed.bindingFingerprint !== row.bindingFingerprint ||
        observed.preconditionDigest !== row.requestDigest ||
        (observed.outcome === "committed" && !observed.afterSha256) ||
        (observed.graphPostflight === "verified" && (observed.outcome !== "committed" ||
          observed.observedGraphDigest !== plan.expectedGraphDigest))) bad("native_move_observation_identity_mismatch");
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
    let observed: NativeMoveObservation | undefined;
    try {
      this.authorize("apply", row.path);
      const plan = this.sealed(row);
      observed = this.observation(await this.backend.apply({ contractVersion: 1, operationId: row.operationId,
        sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, bindingFingerprint: row.bindingFingerprint,
        preconditionDigest: row.requestDigest }), row);
      row = this.journal.transition(row.operationId, ["applying"], observed.outcome,
        observed.outcome === "committed" ? undefined : "native_move_not_committed", attemptId);
    } catch {
      try { row = this.journal.transition(row.operationId, ["applying"], "outcome_unknown", "native_move_reply_unavailable", attemptId); }
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
    let observed: NativeMoveObservation | undefined;
    try {
      observed = this.observation(await this.backend.status(row.operationId, row.requestDigest), row);
      if (observed.outcome === "committed" && row.status !== "committed") {
        row = this.journal.commitAfterVerifiedProof(row.operationId, ["applying", "outcome_unknown"]);
      } else if (observed.outcome === "conflict" && ["applying", "outcome_unknown"].includes(row.status)) {
        // The identity-checked backend receipt proves rejection before dispatch.
        // This is status reconciliation, not a second execution or recovery attempt.
        row = this.journal.transition(row.operationId, ["applying", "outcome_unknown"],
          "conflict", "native_move_precondition_conflict", row.executionOwner?.attemptId);
      }
    } catch {
      row = this.require(reference);
      observed = undefined;
    }
    return this.receipt(row, observed);
  }
  private receipt(row: ObsidianNoteReplacePlan, observed?: NativeMoveObservation) {
    const sealed = this.sealed(row);
    const committed = row.status === "committed";
    return {
      contractVersion: 1, operationKind: KIND, operationId: row.operationId,
      planRef: NATIVE_MOVE_PREFIX + row.operationId, planDigest: row.requestDigest,
      phase: row.status === "planned" ? "planned" : row.status === "applying" ? "applying" : "terminal",
      outcome: row.status === "planned" || row.status === "applying" ? null : row.status,
      target: { sourcePath: sealed.sourcePath, destinationPath: sealed.destinationPath },
      beforeProof: { sourceSha256: row.beforeSha256, neighborhoodDigest: row.requestDigest },
      expectedGraphDigest: sealed.expectedGraphDigest,
      graph_postflight: committed && observed?.outcome === "committed" ? observed.graphPostflight : "indeterminate",
      scope: "sealed_neighborhood_only", updateLinks: sealed.updateLinks,
      affectedPaths: sealed.notes.map(note => note.path),
      limitations: ["no_global_graph_transaction", "native_rename_is_not_source_content_CAS", "backend_acknowledgements_are_process_local"],
      applyAllowed: row.status === "planned", recoveryAllowed: false,
      nextAction: row.status === "planned" ? "apply" : "status",
      admittedAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
}
