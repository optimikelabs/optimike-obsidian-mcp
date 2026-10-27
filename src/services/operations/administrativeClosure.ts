import { z } from "zod/v3";
import type {
  EffectFenceResolveRequest,
  EffectFenceResolveResponse,
} from "../obsidianRestAPI/types.js";
import { operationDigest } from "./contract.js";
import {
  ObsidianNoteReplaceConcurrencyError,
  type AdministrativeClosureEvidence,
  type ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
} from "./obsidianNoteReplaceJournal.js";
import { effectFenceEpoch } from "./obsidianNoteReplaceOperationAdapter.js";

/**
 * Administrative closure of uncertain governed writes.
 *
 * Closing never writes a note and never claims success. It is allowed only when
 * the Atomic Write Bridge proves, at its effect point, that no attempt of the
 * operation can still produce an effect:
 * - recorded token: revoked before its effect, or effect settled long enough
 *   ago, or its epoch no longer exists in the Obsidian realm;
 * - attempt dispatched without token (older builds): the Bridge has refused
 *   every unfenced write for a continuous quiescence window and none is running.
 * Anything else (Bridge unreachable or too old, effect in progress, binding
 * changed, state changed concurrently) refuses the closure without change.
 */
export const ADMINISTRATIVE_CLOSURE_REASON_CODES = [
  "operator_review",
  "historical_cleanup",
] as const;
export type AdministrativeClosureReasonCode =
  (typeof ADMINISTRATIVE_CLOSURE_REASON_CODES)[number];

/** Minimum quiet time after a settled effect, beyond the sealed date-settlement delay. */
export const CLOSURE_MIN_SETTLED_QUIET_MS = 60_000;

export type ClosureRefusalReason =
  | "closure_plan_ref_invalid"
  | "closure_operation_kind_unsupported"
  | "closure_plan_not_found"
  | "closure_operation_still_applying"
  | "closure_not_applicable"
  | "closure_bridge_unavailable"
  | "closure_fence_capability_missing"
  | "closure_binding_mismatch"
  | "closure_effect_in_progress"
  | "closure_effect_settling"
  | "closure_legacy_requires_fence_requirement"
  | "closure_legacy_quiescence_pending"
  | "closure_state_changed"
  | "closure_path_invalid"
  | "date_preparation_not_locked";

const RETRYABLE = new Set<ClosureRefusalReason>([
  "closure_operation_still_applying",
  "closure_bridge_unavailable",
  "closure_effect_in_progress",
  "closure_effect_settling",
  "closure_legacy_quiescence_pending",
  "closure_state_changed",
]);

export type ClosureTarget =
  | { kind: "operation"; planRef: string; operationKind?: string }
  | { kind: "date_preparation_lock"; path: string };

export type ClosureItemResult = {
  target: ClosureTarget;
  result: "closed" | "already_closed" | "would_close" | "not_needed" | "refused";
  reasonCode?: ClosureRefusalReason;
  retryable?: boolean;
  outcome?: string;
  evidence?: unknown;
  nextAction: "none" | "retry_later" | "manual_review";
};

export type DatePreparationReviewEvidence = Omit<
  AdministrativeClosureEvidence,
  "previousOutcome"
> & { previousState: "date_preparation_unverified" };

export interface ClosureBridge {
  status(): Promise<unknown>;
  resolveEffectFence(
    payload: EffectFenceResolveRequest,
  ): Promise<EffectFenceResolveResponse>;
  read(payload: { contractVersion: 1; path: string }): Promise<{
    path: string;
    sha256: string;
    content: string;
  }>;
}

export type ClosureKindProfile = {
  operationKind: string;
  planRefPrefix: string;
  /** Status reconciliation only: journal transitions, never a note write. */
  reconcile(operationId: string): Promise<unknown>;
  /** The Bridge binding this kind seals in its rows. */
  binding(status: unknown): string | undefined;
  observe(row: ObsidianNoteReplacePlan): Promise<AdministrativeClosureEvidence["observation"]>;
};

const UUID = z.string().uuid();
const Verdict = z.enum([
  "not_reached",
  "revoked_before_effect",
  "effect_in_progress",
  "effect_settled",
  "epoch_unknown",
]);
const ResolveResponse = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(1),
    bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    epoch: UUID,
    mode: z.enum(["inspect", "revoke"]),
    results: z.array(
      z
        .object({
          epoch: UUID,
          attemptId: UUID,
          verdict: Verdict,
          settledAgoMs: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
    legacy: z
      .object({
        requireFence: z.boolean(),
        strictForMs: z.number().int().nonnegative().nullable(),
        unfencedInFlight: z.number().int().nonnegative(),
        quiescent: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

type StatusView = {
  pluginVersion: string;
  bindingFingerprint: string;
  epoch: string;
  settlementDelayMs: number;
};

function statusView(status: unknown): StatusView | undefined {
  const value = status as {
    plugin?: { version?: unknown };
    backend?: { bindingFingerprint?: unknown };
    settlement?: { modifiedTimeFrontmatter?: { integrations?: Array<{ settlementObservationDelayMs?: unknown }> } };
  } | null;
  const epoch = effectFenceEpoch(status);
  const binding = value?.backend?.bindingFingerprint;
  if (!epoch || typeof binding !== "string" || !/^[a-f0-9]{64}$/u.test(binding)) return undefined;
  const delays = (value?.settlement?.modifiedTimeFrontmatter?.integrations ?? [])
    .map((item) => item.settlementObservationDelayMs)
    .filter((delay): delay is number => typeof delay === "number" && Number.isFinite(delay));
  return {
    pluginVersion: typeof value?.plugin?.version === "string" ? value.plugin.version.slice(0, 64) : "unknown",
    bindingFingerprint: binding,
    epoch,
    settlementDelayMs: Math.max(0, ...delays),
  };
}

/** True when an attempt of this plan may have been dispatched without a token. */
export function legacyDispatchPossible(row: ObsidianNoteReplacePlan): boolean {
  const tracking = row.effectTracking;
  if (row.executionStartedAtEpochMs === undefined && !tracking?.attempts.length) return false;
  if (!tracking || tracking.untracked) return true;
  if (row.executionStartedAtEpochMs !== tracking.lastExecutionStartedAtEpochMs) return true;
  return tracking.attempts.some((attempt) => !attempt.epoch);
}

function sealedSettlementDelayMs(row: ObsidianNoteReplacePlan): number {
  const delays: number[] = [];
  for (const integration of row.modifiedTimeSettlementPolicy?.integrations ?? []) {
    if (Number.isFinite(integration.settlementObservationDelayMs)) delays.push(integration.settlementObservationDelayMs);
  }
  const fields = (row.projection?.proof as { preflight?: { policy?: { fields?: Array<{ delayMs?: unknown }> } } } | undefined)
    ?.preflight?.policy?.fields;
  for (const field of Array.isArray(fields) ? fields : []) {
    if (typeof field?.delayMs === "number" && Number.isFinite(field.delayMs)) delays.push(field.delayMs);
  }
  return Math.max(0, ...delays);
}

type FenceEvaluation =
  | { ok: true; priorEffect: AdministrativeClosureEvidence["priorEffect"]; attempts: AdministrativeClosureEvidence["attempts"]; legacy?: AdministrativeClosureEvidence["legacy"] }
  | { ok: false; reasonCode: ClosureRefusalReason; attempts: AdministrativeClosureEvidence["attempts"] };

function evaluateFence(
  requested: Array<{ epoch: string; attemptId: string }>,
  raw: unknown,
  expectedBinding: string,
  mode: "inspect" | "revoke",
  needsLegacy: boolean,
  quietMs: number,
): FenceEvaluation {
  const parsed = ResolveResponse.safeParse(raw);
  if (!parsed.success || parsed.data.bindingFingerprint !== expectedBinding || parsed.data.mode !== mode ||
      parsed.data.results.length !== requested.length ||
      parsed.data.results.some((item, index) => item.epoch !== requested[index]!.epoch || item.attemptId !== requested[index]!.attemptId) ||
      (needsLegacy && !parsed.data.legacy)) {
    return { ok: false, reasonCode: "closure_bridge_unavailable", attempts: [] };
  }
  const response = parsed.data;
  const attempts = response.results.map((item) => ({
    attemptId: item.attemptId,
    epoch: item.epoch,
    verdict: item.verdict,
    ...(item.settledAgoMs !== undefined ? { settledAgoMs: item.settledAgoMs } : {}),
  }));
  let priorEffect: AdministrativeClosureEvidence["priorEffect"] = needsLegacy ? "unknown" : "none";
  const raise = (next: AdministrativeClosureEvidence["priorEffect"]) => {
    const rank = { none: 0, unknown: 1, may_have_occurred: 2 } as const;
    if (rank[next] > rank[priorEffect]) priorEffect = next;
  };
  for (const item of response.results) {
    if (item.verdict === "effect_in_progress") return { ok: false, reasonCode: "closure_effect_in_progress", attempts };
    if (item.verdict === "not_reached" && mode === "revoke") return { ok: false, reasonCode: "closure_bridge_unavailable", attempts };
    if (item.verdict === "effect_settled") {
      if ((item.settledAgoMs ?? 0) < quietMs) return { ok: false, reasonCode: "closure_effect_settling", attempts };
      raise("may_have_occurred");
    }
    if (item.verdict === "epoch_unknown") raise("unknown");
  }
  if (needsLegacy) {
    const legacy = response.legacy!;
    if (!legacy.requireFence) return { ok: false, reasonCode: "closure_legacy_requires_fence_requirement", attempts };
    if (!legacy.quiescent || legacy.strictForMs === null || legacy.unfencedInFlight !== 0) {
      return { ok: false, reasonCode: "closure_legacy_quiescence_pending", attempts };
    }
    return { ok: true, priorEffect, attempts, legacy: { requireFence: true, strictForMs: legacy.strictForMs, unfencedInFlight: 0 } };
  }
  return { ok: true, priorEffect, attempts };
}

function refused(target: ClosureTarget, reasonCode: ClosureRefusalReason, extra: Partial<ClosureItemResult> = {}): ClosureItemResult {
  return {
    target,
    result: "refused",
    reasonCode,
    retryable: RETRYABLE.has(reasonCode),
    nextAction: RETRYABLE.has(reasonCode) ? "retry_later" : "manual_review",
    ...extra,
  };
}

export function datePreparationLockKey(path: string, bindingFingerprint: string): string {
  return operationDigest({ domain: "obsidian-date-preparation-v1", path, bindingFingerprint });
}

function validVaultNotePath(path: string): boolean {
  if (!path || path.length > 1024 || path !== path.trim() || path.startsWith("/") || path.includes("\\")) return false;
  if (!path.toLowerCase().endsWith(".md")) return false;
  const parts = path.split("/");
  return !parts.some((part) => !part || part === "." || part === "..") && parts[0]!.toLowerCase() !== ".obsidian";
}

export class AdministrativeClosureService {
  constructor(
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly bridge: ClosureBridge,
    private readonly kinds: readonly ClosureKindProfile[],
    private readonly unsupportedPrefixes: readonly string[] = [],
    private readonly now: () => number = Date.now,
  ) {}

  async closeOperation(
    planRef: string,
    options: { dryRun: boolean; reasonCode: AdministrativeClosureReasonCode },
  ): Promise<ClosureItemResult> {
    const target: ClosureTarget = { kind: "operation", planRef };
    const profile = this.kinds.find((kind) => planRef.startsWith(kind.planRefPrefix));
    if (!profile) {
      return refused(target, this.unsupportedPrefixes.some((prefix) => planRef.startsWith(prefix))
        ? "closure_operation_kind_unsupported" : "closure_plan_ref_invalid");
    }
    target.operationKind = profile.operationKind;
    const operationId = planRef.slice(profile.planRefPrefix.length);
    if (!UUID.safeParse(operationId).success) return refused(target, "closure_plan_ref_invalid");
    let row = this.journal.get(operationId);
    if (!row) return refused(target, "closure_plan_not_found");
    if ((row.projection?.kind ?? "obsidian.note.replace") !== profile.operationKind) {
      return refused(target, "closure_plan_ref_invalid");
    }
    if (row.status === "reviewed_unverified") return this.alreadyClosed(target, row);
    if (row.status === "applying" || row.status === "outcome_unknown") {
      // A qualified observation can still settle the operation; it never writes the note.
      try { await profile.reconcile(operationId); } catch { /* the fence decides below */ }
      row = this.journal.get(operationId) ?? row;
    }
    if (row.status === "reviewed_unverified") return this.alreadyClosed(target, row);
    if (row.status === "applying") return refused(target, "closure_operation_still_applying", { outcome: "applying" });
    if (row.status !== "outcome_unknown") {
      return { target, result: "not_needed", reasonCode: "closure_not_applicable", outcome: row.status, nextAction: "none" };
    }

    let status: unknown;
    try { status = await this.bridge.status(); }
    catch { return refused(target, "closure_bridge_unavailable", { outcome: row.status }); }
    const view = statusView(status);
    if (!view) return refused(target, "closure_fence_capability_missing", { outcome: row.status });
    if (profile.binding(status) !== row.bindingFingerprint) {
      return refused(target, "closure_binding_mismatch", { outcome: row.status });
    }
    const mode = options.dryRun ? "inspect" : "revoke";
    const attempts = (row.effectTracking?.attempts ?? [])
      .filter((attempt): attempt is typeof attempt & { epoch: string } => !!attempt.epoch)
      .map((attempt) => ({ epoch: attempt.epoch, attemptId: attempt.attemptId }));
    const needsLegacy = legacyDispatchPossible(row);
    let raw: unknown;
    try {
      raw = await this.bridge.resolveEffectFence({
        contractVersion: 1, bindingFingerprint: view.bindingFingerprint, mode, attempts, includeLegacy: needsLegacy,
      });
    } catch {
      return refused(target, "closure_bridge_unavailable", { outcome: row.status });
    }
    const quietMs = Math.max(CLOSURE_MIN_SETTLED_QUIET_MS, sealedSettlementDelayMs(row), view.settlementDelayMs);
    const evaluation = evaluateFence(attempts, raw, view.bindingFingerprint, mode, needsLegacy, quietMs);
    if (!evaluation.ok) {
      return refused(target, evaluation.reasonCode, { outcome: row.status, evidence: { attempts: evaluation.attempts } });
    }
    const evidence: AdministrativeClosureEvidence = {
      contractVersion: 1,
      closedAt: new Date(this.now()).toISOString(),
      reasonCode: options.reasonCode,
      previousOutcome: "outcome_unknown",
      guarantee: "no_further_effect",
      priorEffect: evaluation.priorEffect,
      bridge: { pluginVersion: view.pluginVersion, bindingFingerprint: view.bindingFingerprint, epoch: view.epoch },
      attempts: evaluation.attempts,
      ...(evaluation.legacy ? { legacy: evaluation.legacy } : {}),
      observation: await profile.observe(row).catch(() => ({ kind: "unavailable" as const })),
    };
    if (options.dryRun) {
      return { target, result: "would_close", outcome: row.status, evidence, nextAction: "none" };
    }
    try {
      row = this.journal.closeAdministratively(row, evidence);
    } catch (error) {
      if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
      const current = this.journal.get(operationId);
      if (current?.status === "reviewed_unverified") return this.alreadyClosed(target, current);
      return refused(target, "closure_state_changed", { outcome: current?.status });
    }
    return { target, result: "closed", outcome: row.status, evidence, nextAction: "none" };
  }

  async releaseDatePreparationLock(
    path: string,
    options: { dryRun: boolean; reasonCode: AdministrativeClosureReasonCode },
  ): Promise<ClosureItemResult> {
    const target: ClosureTarget = { kind: "date_preparation_lock", path };
    if (!validVaultNotePath(path)) return refused(target, "closure_path_invalid");
    let status: unknown;
    try { status = await this.bridge.status(); }
    catch { return refused(target, "closure_bridge_unavailable"); }
    const view = statusView(status);
    if (!view) return refused(target, "closure_fence_capability_missing");
    const key = datePreparationLockKey(path, view.bindingFingerprint);
    const lock = this.journal.getDatePreparationFence(key);
    if (!lock) {
      const review = this.journal.getDatePreparationFenceReview(key);
      return review
        ? { target, result: "already_closed", evidence: review.evidence, nextAction: "none" }
        : { target, result: "not_needed", reasonCode: "date_preparation_not_locked", nextAction: "none" };
    }
    const mode = options.dryRun ? "inspect" : "revoke";
    const attempts = lock.fenceEpoch ? [{ epoch: lock.fenceEpoch, attemptId: lock.attemptId }] : [];
    const needsLegacy = !lock.fenceEpoch;
    let raw: unknown;
    try {
      raw = await this.bridge.resolveEffectFence({
        contractVersion: 1, bindingFingerprint: view.bindingFingerprint, mode, attempts, includeLegacy: needsLegacy,
      });
    } catch {
      return refused(target, "closure_bridge_unavailable");
    }
    const quietMs = Math.max(CLOSURE_MIN_SETTLED_QUIET_MS, view.settlementDelayMs);
    const evaluation = evaluateFence(attempts, raw, view.bindingFingerprint, mode, needsLegacy, quietMs);
    if (!evaluation.ok) return refused(target, evaluation.reasonCode, { evidence: { attempts: evaluation.attempts } });
    let observation: AdministrativeClosureEvidence["observation"];
    try {
      const read = await this.bridge.read({ contractVersion: 1, path });
      observation = read.path === path && /^[a-f0-9]{64}$/u.test(read.sha256)
        ? { kind: "note-sha256", sha256: read.sha256 } : { kind: "unavailable" };
    } catch { observation = { kind: "unavailable" }; }
    const evidence: DatePreparationReviewEvidence = {
      contractVersion: 1,
      closedAt: new Date(this.now()).toISOString(),
      reasonCode: options.reasonCode,
      previousState: "date_preparation_unverified",
      guarantee: "no_further_effect",
      priorEffect: evaluation.priorEffect,
      bridge: { pluginVersion: view.pluginVersion, bindingFingerprint: view.bindingFingerprint, epoch: view.epoch },
      attempts: evaluation.attempts,
      ...(evaluation.legacy ? { legacy: evaluation.legacy } : {}),
      observation,
    };
    if (options.dryRun) return { target, result: "would_close", evidence, nextAction: "none" };
    if (!this.journal.resolveDatePreparationFence(key, lock.attemptId, evidence)) {
      const review = this.journal.getDatePreparationFenceReview(key);
      return review?.attemptId === lock.attemptId
        ? { target, result: "already_closed", evidence: review.evidence, nextAction: "none" }
        : refused(target, "closure_state_changed");
    }
    return { target, result: "closed", evidence, nextAction: "none" };
  }

  private alreadyClosed(target: ClosureTarget, row: ObsidianNoteReplacePlan): ClosureItemResult {
    return { target, result: "already_closed", outcome: row.status, evidence: row.administrativeClosure, nextAction: "none" };
  }
}
