import { z } from "zod";
import { ExternalRootError } from "../externalRootsService.js";
import type { ExternalMoveCoordinator } from "../externalReferences/externalMoveCoordinator.js";
import {
  OPERATION_RUNTIME_CONTRACT_VERSION,
  operationDigest,
  type OperationAdapter,
  type OperationOutcome,
  type OperationPhase,
  type OperationReceipt,
} from "./contract.js";

const PLAN_REF_PREFIX = "external-move:v1:";
const REDACTED = "[redacted]";
const INCIDENT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const ExternalMovePlanViewSchema = z
  .object({
    planId: z.string().uuid(),
    idempotencyKey: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    status: z.enum([
      "planned",
      "applying_file",
      "file_moved",
      "applying_repairs",
      "applied",
      "rolling_back_repairs",
      "rolling_back_file",
      "rolled_back",
      "failed_compensated",
      "recovery_required",
      "applying",
      "rolling_back",
      "failed",
    ]),
    rootId: z.string().min(1),
    sourceRelativePath: z.string().min(1),
    targetRelativePath: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceSize: z.number().int().nonnegative(),
    inventoryDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    bindingVerifiable: z.literal(true),
    legacyBinding: z.literal(false),
    repairs: z.array(
      z.object({
        filePath: z.string().min(1),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    ),
    manualReview: z.array(
      z.object({ filePath: z.string().min(1), reason: z.string().min(1) }),
    ),
    readyToApply: z.boolean(),
    mutationAvailable: z.literal(false),
    mutationUnavailableReason: z.literal(
      "native_handle_relative_mutation_unavailable",
    ),
    recoveryRequired: z.boolean(),
    recoveryErrors: z.array(z.string()),
    appliedRepairCount: z.number().int().nonnegative(),
    restoredRepairCount: z.number().int().nonnegative(),
    nextAction: z.enum(["apply", "rollback", "manual_review", "none"]),
    failureCode: z.string().min(1).optional(),
    failure: z.string().optional(),
  })
  .strict();

type ExternalMovePlanView = z.infer<typeof ExternalMovePlanViewSchema>;

/**
 * A status projection is a diagnostic boundary, not a trusted journal row.
 * The coordinator deliberately emits legacy and incident projections for
 * stored data that must never be used as a continuation instruction. A
 * current, fully parsed diagnostic projection remains useful across
 * plan/status even when it requires manual review or reports a stale session;
 * those states are already non-actionable below. The discriminator only
 * rejects legacy/unsafe schema shapes and never recovers fields from them.
 */
function isTrustedCurrentProjection(view: ExternalMovePlanView): boolean {
  return view.bindingVerifiable && !view.legacyBinding;
}

export type ExternalMoveOperationPlanInput = {
  rootId: string;
  sourceRelativePath: string;
  targetRelativePath: string;
  idempotencyKey: string;
};

function planRef(planId: string): string {
  return `${PLAN_REF_PREFIX}${planId}`;
}

function planIdFromRef(reference: string): string {
  if (!reference.startsWith(PLAN_REF_PREFIX)) {
    throw new Error(
      "The operation plan reference is not an external-move V1 plan.",
    );
  }
  const planId = reference.slice(PLAN_REF_PREFIX.length);
  if (!z.string().uuid().safeParse(planId).success) {
    throw new Error("The external-move operation plan reference is malformed.");
  }
  return planId;
}

function state(view: ExternalMovePlanView): {
  phase: OperationPhase;
  outcome: OperationOutcome | null;
} {
  if (view.status === "applied")
    return { phase: "terminal", outcome: "committed" };
  if (view.status === "rolled_back" || view.status === "failed_compensated") {
    return { phase: "terminal", outcome: "compensated" };
  }
  if (view.status === "recovery_required") {
    return { phase: "terminal", outcome: "outcome_unknown" };
  }
  if (view.status === "failed") return { phase: "terminal", outcome: "failed" };
  if (view.status === "planned") return { phase: "planned", outcome: null };
  return { phase: "applying", outcome: null };
}

function redactedIncidentReceipt(
  operationId: string,
  reference: string,
): OperationReceipt {
  const planDigest = operationDigest({
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationKind: "external.move",
    operationId,
    incident: "untrusted_status_projection",
  });

  return {
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationId,
    idempotencyKey: REDACTED,
    operationKind: "external.move",
    planRef: reference,
    planDigest,
    phase: "terminal",
    outcome: "outcome_unknown",
    backend: { kind: "external-filesystem" },
    target: { kind: "same-root-file-move", logicalRef: REDACTED },
    beforeProof: {
      kind: "external-move-status-incident",
      digest: operationDigest({ planDigest, incident: true }),
    },
    postflight: { status: "unverified" },
    admittedAt: INCIDENT_TIMESTAMP,
    updatedAt: INCIDENT_TIMESTAMP,
    terminalAt: INCIDENT_TIMESTAMP,
    recoveryAllowed: false,
    applyAllowed: false,
  };
}

function receipt(
  raw: Record<string, unknown>,
  fallback?: { operationId: string; reference: string },
): OperationReceipt {
  const parsed = ExternalMovePlanViewSchema.safeParse(raw);
  if (!parsed.success) {
    if (fallback) {
      return redactedIncidentReceipt(fallback.operationId, fallback.reference);
    }
    // New plans originate from the current coordinator and must meet its
    // complete contract. Do not turn a producer/journal mismatch into either
    // a Zod issue dump (which can reflect stored data) or a plausible receipt
    // without a caller-supplied, validated plan reference.
    throw new ExternalRootError(
      "non_verifiable",
      "The external move plan could not be safely verified.",
    );
  }
  const view = parsed.data;
  if (fallback && !isTrustedCurrentProjection(view)) {
    return redactedIncidentReceipt(fallback.operationId, fallback.reference);
  }
  const currentState = state(view);
  const reference = planRef(view.planId);
  const digest = operationDigest({
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationKind: "external.move",
    operationId: view.planId,
    idempotencyKey: view.idempotencyKey,
    rootId: view.rootId,
    sourceRelativePath: view.sourceRelativePath,
    targetRelativePath: view.targetRelativePath,
    sourceSha256: view.sourceSha256,
    sourceSize: view.sourceSize,
    inventoryDigest: view.inventoryDigest,
    repairs: view.repairs,
    manualReview: view.manualReview,
  });
  const terminal = currentState.phase === "terminal";
  const recoverable = false;
  const postflight =
    currentState.outcome === "committed"
      ? "verified"
      : currentState.outcome === "compensated"
        ? "compensated"
        : terminal
          ? "unverified"
          : currentState.phase === "applying"
            ? "pending"
            : "not_started";

  return {
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationId: view.planId,
    idempotencyKey: view.idempotencyKey,
    operationKind: "external.move",
    planRef: reference,
    planDigest: digest,
    phase: currentState.phase,
    outcome: currentState.outcome,
    backend: { kind: "external-filesystem" },
    target: {
      kind: "same-root-file-move",
      logicalRef: `${view.rootId}:${view.sourceRelativePath}->${view.targetRelativePath}`,
    },
    beforeProof: {
      kind: "source-cas-and-reference-inventory",
      digest: operationDigest({
        sourceSha256: view.sourceSha256,
        sourceSize: view.sourceSize,
        inventoryDigest: view.inventoryDigest,
      }),
      details: {
        sourceSha256: view.sourceSha256,
        inventoryDigest: view.inventoryDigest,
        repairCount: view.repairs.length,
        manualReviewCount: view.manualReview.length,
      },
    },
    ...(currentState.outcome === "committed" ||
    currentState.outcome === "compensated"
      ? {
          afterProof: {
            kind:
              currentState.outcome === "committed"
                ? "move-and-repairs-verified"
                : "compensation-verified",
            digest: operationDigest({
              planDigest: digest,
              outcome: currentState.outcome,
              appliedRepairCount: view.appliedRepairCount,
              restoredRepairCount: view.restoredRepairCount,
            }),
            details: {
              appliedRepairCount: view.appliedRepairCount,
              restoredRepairCount: view.restoredRepairCount,
            },
          },
        }
      : {}),
    postflight: { status: postflight },
    admittedAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(terminal ? { terminalAt: view.updatedAt } : {}),
    ...(recoverable ? { recoveryRef: reference } : {}),
    recoveryAllowed: recoverable,
    applyAllowed: false,
  };
}

export class ExternalMoveOperationAdapter
  implements OperationAdapter<ExternalMoveOperationPlanInput>
{
  readonly operationKind = "external.move";

  constructor(private readonly coordinator: ExternalMoveCoordinator) {}

  async plan(input: ExternalMoveOperationPlanInput): Promise<OperationReceipt> {
    return receipt(await this.coordinator.plan(input));
  }

  async apply(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    const planId = planIdFromRef(reference);
    return receipt(
      await this.coordinator.apply(planId, idempotencyKey, {
        allowCompensatedReapply: false,
      }),
    );
  }

  async status(reference: string): Promise<OperationReceipt> {
    const operationId = planIdFromRef(reference);
    return receipt(this.coordinator.status(operationId), {
      operationId,
      reference,
    });
  }

  async recover(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    return receipt(
      await this.coordinator.rollback(planIdFromRef(reference), idempotencyKey),
    );
  }
}
