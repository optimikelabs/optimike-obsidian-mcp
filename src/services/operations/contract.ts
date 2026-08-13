import { createHash } from "node:crypto";

export const OPERATION_RUNTIME_CONTRACT_VERSION = 1 as const;

export type OperationPhase = "planned" | "applying" | "terminal";

export type OperationOutcome =
  | "committed"
  | "conflict"
  | "rejected"
  | "failed"
  | "outcome_unknown"
  | "compensated"
  | "expired";

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
  postflight: {
    status:
      | "not_started"
      | "pending"
      | "verified"
      | "compensated"
      | "unverified";
  };
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
