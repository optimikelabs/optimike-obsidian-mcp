import { z } from "zod/v3";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { assertWriteAllowed } from "../writePolicy.js";
import { HEADLESS_VAULT_LOCK_BUSY, isHeadlessVaultLockBusy, operationDigest, type OperationReceipt, type OperationOutcome } from "./contract.js";
import { FILESYSTEM_AUTHORITY, type FilesystemNoteBackend } from "./filesystemNoteBackend.js";
import { ObsidianNoteReplaceConcurrencyError, displacedFilesystemEdit, replacedConcurrentEdit, type ObsidianNoteReplacePlan, type ObsidianNoteReplaceJournal } from "./obsidianNoteReplaceJournal.js";

const KIND = "obsidian.operation.revert";
const PREFIX = "obsidian-operation-revert:v1:";
const SOURCES = new Map([
  ["obsidian-note-replace:v1:", undefined],
  ["obsidian-note-create:v1:", "obsidian.note.create"],
  ["obsidian-text-patch:v1:", "obsidian.text.patch"],
  ["obsidian-frontmatter-patch:v1:", "obsidian.frontmatter.patch"],
  [PREFIX, KIND],
]);

function refuse(message: string): never {
  throw new McpError(BaseErrorCode.CONFLICT, message);
}

function operationId(ref: string, prefix: string) {
  const parsed = z.string().uuid().safeParse(ref.slice(prefix.length));
  if (!ref.startsWith(prefix) || !parsed.success) refuse("The operation reference is invalid.");
  return parsed.data;
}

export class FilesystemRevert {
  constructor(private readonly backend: FilesystemNoteBackend, private readonly journal: ObsidianNoteReplaceJournal) {}

  private require(ref: string, key?: string) {
    const row = this.journal.get(operationId(ref, PREFIX));
    if (!row?.filesystem || row.projection?.kind !== KIND ||
        (key !== undefined && row.projection.publicIdempotencyKey !== key)) refuse("The revert plan or idempotency key does not match.");
    return row;
  }

  private authorize(phase: "plan" | "apply" | "recover", path: string, destructive: boolean, length?: number) {
    assertWriteAllowed({ operation: phase === "plan" ? "obsidian_operation_revert_plan" : "obsidian_operation_revert_apply",
      action: phase, target: path, targetType: "filePath", destructive, contentLength: length });
  }

  async plan(input: { path: string; operationRef: string; idempotencyKey: string }) {
    const prefix = [...SOURCES.keys()].find(prefix => input.operationRef.startsWith(prefix));
    if (!prefix) refuse("A headless note operation reference is required.");
    const source = this.journal.get(operationId(input.operationRef, prefix));
    if (!source?.filesystem || source.path !== input.path ||
        source.projection?.kind !== SOURCES.get(prefix)) refuse("The headless operation does not match the target.");
    const divergent = source.status === "outcome_unknown" ? source.filesystem.divergentObservation : undefined;
    const displaced = displacedFilesystemEdit(source);
    const undoConcurrentRestore = prefix === PREFIX && source.status === "committed" &&
      source.projection?.proof.restoreDisplaced === true && source.projection.proof.displacedEditVerified === true;
    const restoreDisplaced = displaced !== undefined || undoConcurrentRestore;
    if (divergent !== undefined && source.filesystem.localStageMode === "exchange" && !restoreDisplaced) {
      refuse("The exchange has no verified displaced edit eligible for restoration.");
    }
    if (prefix === PREFIX && !restoreDisplaced) refuse("This revert has no retained concurrent edit to restore.");
    const before = displaced
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(displaced.bytesBase64, "base64"))
      : source.filesystem.beforeContent;
    const afterSha256 = source.status === "committed" ? source.filesystem.stagedSha256 : divergent?.sha256;
    if (!afterSha256) refuse("The filesystem has no after proof against which to seal the revert.");
    const restoreAbsence = source.projection?.kind === "obsidian.note.create";
    if (!restoreAbsence && before === undefined) refuse("The operation has no retained before image.");
    const key = "optimike:projection:v1:revert:" + operationDigest(input.idempotencyKey);
    const identity = operationDigest({ path: input.path, sourceOperationId: source.operationId });
    const replay = this.journal.getByIdempotencyKey(key);
    if (replay) {
      if (replay.idempotencyIdentity !== identity) refuse("The idempotency key belongs to another revert.");
      return this.status(PREFIX + replay.operationId);
    }
    const restoresAfterDivergence = divergent !== undefined || undoConcurrentRestore;
    this.authorize("plan", source.path, restoreAbsence || restoresAfterDivergence, before?.length);
    const sealed = await this.backend.sealRevert(source.path, restoreAbsence ? undefined : before, afterSha256, restoreDisplaced);
    if (sealed.bindingFingerprint !== source.bindingFingerprint) refuse("The vault differs from the original operation.");
    if (sealed.policyDigest !== source.filesystem.policyDigest) refuse("The protected date policy differs from the original operation.");
    const replacesConcurrentEdit = undoConcurrentRestore || (displaced && replacedConcurrentEdit(source))
      ? { sha256: afterSha256, modifiedAt: sealed.beforeModifiedAt, observedAt: sealed.beforeObservedAt } : undefined;
    const row = this.journal.create({
      path: source.path, idempotencyKey: key, idempotencyIdentity: identity,
      beforeSha256: afterSha256, afterSha256: sealed.afterSha256, nextContent: sealed.content,
      bindingFingerprint: sealed.bindingFingerprint,
      filesystem: { policyDigest: sealed.policyDigest, beforeContent: sealed.before, replacesConcurrentEdit },
      requestDigest: operationDigest({ identity, before: afterSha256, after: sealed.afterSha256,
        policy: sealed.policyDigest, binding: sealed.bindingFingerprint }),
      projection: { contractVersion: 1, kind: KIND, publicIdempotencyKey: input.idempotencyKey, intentDigest: identity,
        proof: { restoreAbsence, restoresAfterDivergence, restoreDisplaced,
          displacedEditVerified: restoreDisplaced } },
    });
    return this.receipt(row);
  }

  async status(ref: string) {
    let row = this.require(ref);
    if (row.status === "applying" || row.status === "outcome_unknown") {
      if (await this.backend.revertPublished(row)) {
        try { row = this.journal.commitAfterVerifiedProof(row.operationId, ["applying", "outcome_unknown"]); }
        catch (error) { if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error; row = this.require(ref); }
      }
    }
    if (row.status === "committed") await this.backend.clearRevertWitness(row);
    return this.receipt(row);
  }

  async apply(ref: string, key: string, recovery = false) {
    let row = this.require(ref, key);
    if (recovery) {
      await this.status(ref);
      row = this.require(ref, key);
      // An effect whose publication point was reached is reconciled only.
      if (row.filesystem?.stagedIdentity) return this.receipt(row);
    }
    if (row.status !== (recovery ? "outcome_unknown" : "planned")) return this.status(ref);
    const proof = row.projection!.proof;
    if (proof.restoreDisplaced === true && proof.displacedEditVerified !== true) {
      refuse("The revert was sealed before displaced edits were verified.");
    }
    this.authorize(recovery ? "recover" : "apply", row.path,
      proof.restoreAbsence === true || proof.restoresAfterDivergence === true, row.nextContent.length);
    await this.backend.status();
    try { row = this.journal.transition(row.operationId, [row.status], "applying"); }
    catch (error) {
      if (error instanceof ObsidianNoteReplaceConcurrencyError) return this.status(ref);
      throw error;
    }
    const attempt = row.executionOwner!.attemptId;
    try {
      row = this.journal.recordEffectAttempt(row.operationId, attempt, undefined);
      await this.backend.applyRevert(row);
    } catch (error) {
      if (isHeadlessVaultLockBusy(error)) throw error;
      try {
        this.journal.transition(row.operationId, ["applying"],
          error instanceof McpError && error.code === BaseErrorCode.CONFLICT ? "conflict"
            : error instanceof McpError && error.code === BaseErrorCode.FORBIDDEN ? "rejected" : "outcome_unknown",
          "headless_revert_effect_unverified", attempt);
      } catch (race) { if (!(race instanceof ObsidianNoteReplaceConcurrencyError)) throw race; }
    }
    return this.status(ref);
  }

  private receipt(row: ObsidianNoteReplacePlan): OperationReceipt {
    const committed = row.status === "committed";
    const phase = row.status === "planned" || row.status === "applying" ? row.status : "terminal";
    const concurrentEdit = replacedConcurrentEdit(row);
    return {
      contractVersion: 1, operationKind: KIND, operationId: row.operationId,
      idempotencyKey: row.projection!.publicIdempotencyKey, planRef: PREFIX + row.operationId, planDigest: row.requestDigest,
      target: { kind: "vault-markdown-note", logicalRef: row.path },
      backend: { kind: FILESYSTEM_AUTHORITY, bindingFingerprint: row.bindingFingerprint },
      beforeProof: { kind: "note-sha256", digest: row.beforeSha256 },
      ...(committed ? { afterProof: { kind: row.projection!.proof.restoreAbsence ? "observed-path-absence" : "note-sha256",
        digest: row.filesystem?.stagedSha256 ?? row.afterSha256 } } : {}),
      ...(concurrentEdit ? { replacesConcurrentEdit: concurrentEdit } : {}),
      phase, outcome: phase === "terminal" ? row.status as OperationOutcome : null,
      admittedAt: row.createdAt, updatedAt: row.updatedAt,
      ...(phase === "terminal" ? { terminalAt: row.updatedAt } : {}),
      applyAllowed: phase === "planned",
      recoveryAllowed: row.status === "applying" || (row.status === "outcome_unknown" && !row.filesystem?.stagedIdentity),
      postflight: { status: committed ? "verified" : phase === "planned" ? "not_started" : "unverified",
        ...(row.failure === "headless_atomic_exchange_unavailable" ? { reason: row.failure } : {}),
        ...(row.failure === HEADLESS_VAULT_LOCK_BUSY ? { reason: HEADLESS_VAULT_LOCK_BUSY, retryable: true as const } : {}),
        ...(displacedFilesystemEdit(row) ? { reason: "headless_displaced_edit" as const } : {}),
        ...(committed ? { source: "filesystem-reread" as const } : {}) },
    };
  }
}
