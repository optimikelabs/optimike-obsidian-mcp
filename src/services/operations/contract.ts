import { createHash } from "node:crypto";
import type { FrontmatterAssessment } from "../obsidianFrontmatterFormat.js";
import { McpError } from "../../types-global/errors.js";

export const OPERATION_RUNTIME_CONTRACT_VERSION = 1 as const;
export const HEADLESS_VAULT_LOCK_BUSY = "headless_vault_lock_busy";

export function isHeadlessVaultLockBusy(error: unknown) {
  return error instanceof McpError && error.details?.reasonCode === HEADLESS_VAULT_LOCK_BUSY;
}

export type ConcurrentEditReplacement = { sha256: string; observedAt: string; modifiedAt?: string };

export type OperationPhase = "planned" | "applying" | "terminal";

export type OperationOutcome =
  | "committed"
  | "conflict"
  | "rejected"
  | "failed"
  | "outcome_unknown"
  | "compensated"
  | "expired"
  /** Closed after review: no further effect can occur; success is not claimed. */
  | "reviewed_unverified";

export type OperationProof = {
  kind: string;
  digest: string;
  details?: Record<string, boolean | number | string | null>;
};

export type OperationReceipt = {
  contractVersion: typeof OPERATION_RUNTIME_CONTRACT_VERSION;
  operationId: string;
  idempotencyKey: string;
  operationKind: string;
  planRef: string;
  planDigest: string;
  phase: OperationPhase;
  outcome: OperationOutcome | null;
  backend: {
    kind: string;
    bindingFingerprint?: string;
  };
  target: {
    kind: string;
    logicalRef: string;
  };
  beforeProof: OperationProof;
  afterProof?: OperationProof;
  replacesConcurrentEdit?: ConcurrentEditReplacement;
  postflight: {
    source?: "filesystem-reread";
    reason?: "modified_time_settlement" | "headless_atomic_exchange_unavailable" | "headless_displaced_edit" | typeof HEADLESS_VAULT_LOCK_BUSY;
    retryable?: true;
    checkAfter?: string;
    status:
      | "not_started"
      | "pending"
      | "verified"
      | "compensated"
      | "unverified";
  };
  datePreparation?: { kind: "date-manager-before-plan" | "outside-date-management"; message: string; lineEndingsNormalized?: true;
    frontmatterNormalization?: { applied: true; reason: "date_preparation"; sourceSha256: string; preparedSha256: string } };
  frontmatterFormat?: FrontmatterAssessment;
  admittedAt: string;
  updatedAt: string;
  terminalAt?: string;
  recoveryRef?: string;
  recoveryAllowed: boolean;
  applyAllowed: boolean;
};

export interface OperationAdapter<TPlanInput> {
  readonly operationKind: string;
  plan(input: TPlanInput): Promise<OperationReceipt>;
  apply(planRef: string, idempotencyKey: string): Promise<OperationReceipt>;
  status(planRef: string): Promise<OperationReceipt>;
  recover(planRef: string, idempotencyKey: string): Promise<OperationReceipt>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function operationDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}
