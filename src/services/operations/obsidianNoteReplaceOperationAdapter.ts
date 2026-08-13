import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  AtomicWriteCasRequest,
  AtomicWriteCasResponse,
  AtomicWriteReadRequest,
  AtomicWriteReadResponse,
  AtomicWriteStatusResponse,
} from "../obsidianRestAPI/types.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  OPERATION_RUNTIME_CONTRACT_VERSION,
  operationDigest,
  type OperationAdapter,
  type OperationOutcome,
  type OperationPhase,
  type OperationReceipt,
} from "./contract.js";
import {
  ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
} from "./obsidianNoteReplaceJournal.js";

const PLAN_REF_PREFIX = "obsidian-note-replace:v1:";
const SHA256 = /^[a-f0-9]{64}$/u;

const StatusSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(1),
    plugin: z.object({ id: z.string().min(1), version: z.string().min(1) }),
    backend: z.object({
      kind: z.literal("obsidian-vault-process"),
      bindingFingerprint: z.string().regex(SHA256),
      atomicCas: z.literal(true),
      writeEnabled: z.boolean(),
    }),
    limits: z.object({ markdownOnly: z.literal(true) }),
  })
  .passthrough();

const ReadSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(1),
    path: z.string().min(1),
    content: z.string(),
    sha256: z.string().regex(SHA256),
    size: z.number().int().nonnegative(),
    bindingFingerprint: z.string().regex(SHA256),
  })
  .passthrough();

const CasSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(1),
    path: z.string().min(1),
    beforeSha256: z.string().regex(SHA256),
    afterSha256: z.string().regex(SHA256),
    size: z.number().int().nonnegative(),
    bindingFingerprint: z.string().regex(SHA256),
  })
  .passthrough();

export interface AtomicWriteBackend {
  status(): Promise<AtomicWriteStatusResponse>;
  read(payload: AtomicWriteReadRequest): Promise<AtomicWriteReadResponse>;
  replace(payload: AtomicWriteCasRequest): Promise<AtomicWriteCasResponse>;
}

export type ObsidianNoteReplacePlanInput = {
  path: string;
  nextContent: string;
  idempotencyKey: string;
};

function planRef(operationId: string): string {
  return `${PLAN_REF_PREFIX}${operationId}`;
}

function operationIdFromRef(reference: string): string {
  if (!reference.startsWith(PLAN_REF_PREFIX)) {
    throw new Error(
      "The operation plan reference is not a note-replace V1 plan.",
    );
  }
  const operationId = reference.slice(PLAN_REF_PREFIX.length);
  if (!z.string().uuid().safeParse(operationId).success) {
    throw new Error("The note-replace operation plan reference is malformed.");
  }
  return operationId;
}

function state(plan: ObsidianNoteReplacePlan): {
  phase: OperationPhase;
  outcome: OperationOutcome | null;
} {
  if (plan.status === "planned") return { phase: "planned", outcome: null };
  if (plan.status === "applying") return { phase: "applying", outcome: null };
  return { phase: "terminal", outcome: plan.status };
}

function planDigest(plan: ObsidianNoteReplacePlan): string {
  return operationDigest({
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationKind: "obsidian.note.replace",
    operationId: plan.operationId,
    idempotencyKey: plan.idempotencyKey,
    backendBinding: plan.bindingFingerprint,
    path: plan.path,
    beforeSha256: plan.beforeSha256,
    afterSha256: plan.afterSha256,
    requestDigest: plan.requestDigest,
  });
}

function receipt(plan: ObsidianNoteReplacePlan): OperationReceipt {
  const current = state(plan);
  const terminal = current.phase === "terminal";
  const recoverable =
    plan.status === "applying" || plan.status === "outcome_unknown";
  const digest = planDigest(plan);
  return {
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationId: plan.operationId,
    idempotencyKey: plan.idempotencyKey,
    operationKind: "obsidian.note.replace",
    planRef: planRef(plan.operationId),
    planDigest: digest,
    phase: current.phase,
    outcome: current.outcome,
    backend: {
      kind: "obsidian-vault-process",
      bindingFingerprint: plan.bindingFingerprint,
    },
    target: { kind: "vault-markdown-note", logicalRef: plan.path },
    beforeProof: {
      kind: "note-sha256",
      digest: operationDigest({
        path: plan.path,
        sha256: plan.beforeSha256,
        bindingFingerprint: plan.bindingFingerprint,
      }),
      details: { sha256: plan.beforeSha256 },
    },
    ...(plan.status === "committed"
      ? {
          afterProof: {
            kind: "atomic-note-replacement-verified",
            digest: operationDigest({
              path: plan.path,
              sha256: plan.afterSha256,
              bindingFingerprint: plan.bindingFingerprint,
            }),
            details: { sha256: plan.afterSha256 },
          },
        }
      : {}),
    postflight: {
      status:
        plan.status === "committed"
          ? "verified"
          : plan.status === "applying"
            ? "pending"
            : terminal
              ? "unverified"
              : "not_started",
    },
    admittedAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(terminal ? { terminalAt: plan.updatedAt } : {}),
    ...(recoverable ? { recoveryRef: planRef(plan.operationId) } : {}),
    recoveryAllowed: recoverable,
    applyAllowed: plan.status === "planned",
  };
}

function validateInput(input: ObsidianNoteReplacePlanInput): void {
  if (!input.path || !input.path.toLowerCase().endsWith(".md")) {
    throw new Error("path must identify a Markdown note.");
  }
  if (!input.idempotencyKey.trim()) {
    throw new Error("idempotencyKey is required.");
  }
  if (Buffer.byteLength(input.nextContent, "utf8") > 5 * 1024 * 1024) {
    throw new Error("nextContent exceeds the bridge limit.");
  }
}

export class ObsidianNoteReplaceOperationAdapter
  implements OperationAdapter<ObsidianNoteReplacePlanInput>
{
  readonly operationKind = "obsidian.note.replace";

  constructor(
    private readonly backend: AtomicWriteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
  ) {}

  async plan(input: ObsidianNoteReplacePlanInput): Promise<OperationReceipt> {
    validateInput(input);
    const afterSha256 = createHash("sha256")
      .update(input.nextContent, "utf8")
      .digest("hex");
    const existing = this.journal.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (
        existing.path !== input.path ||
        existing.afterSha256 !== afterSha256
      ) {
        throw new Error(
          "The idempotency key is already bound to a different note replacement.",
        );
      }
      return receipt(existing);
    }
    const status = StatusSchema.parse(await this.backend.status());
    if (!status.backend.writeEnabled) {
      throw new Error(
        "Atomic note writes are disabled in the bridge settings.",
      );
    }
    const read = ReadSchema.parse(
      await this.backend.read({ contractVersion: 1, path: input.path }),
    );
    if (
      read.bindingFingerprint !== status.backend.bindingFingerprint ||
      read.path !== input.path
    ) {
      throw new Error(
        "Atomic-write backend identity or target changed during planning.",
      );
    }
    const requestDigest = operationDigest({
      operationKind: this.operationKind,
      path: input.path,
      beforeSha256: read.sha256,
      afterSha256,
      bindingFingerprint: read.bindingFingerprint,
    });
    return receipt(
      this.journal.create({
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        path: input.path,
        beforeSha256: read.sha256,
        afterSha256,
        nextContent: input.nextContent,
        bindingFingerprint: read.bindingFingerprint,
      }),
    );
  }

  async apply(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    const plan = this.required(reference, idempotencyKey);
    if (plan.status === "committed") return receipt(plan);
    if (plan.status !== "planned") {
      if (plan.status === "applying") {
        return receipt(await this.reconcileApplying(plan));
      }
      return receipt(plan);
    }
    const applying = this.journal.transition(
      plan.operationId,
      ["planned"],
      "applying",
    );
    return receipt(await this.execute(applying));
  }

  async status(reference: string): Promise<OperationReceipt> {
    const plan = this.required(reference);
    if (plan.status === "applying" || plan.status === "outcome_unknown") {
      return receipt(await this.reconcile(plan));
    }
    return receipt(plan);
  }

  async recover(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    let plan = this.required(reference, idempotencyKey);
    if (plan.status === "committed") return receipt(plan);
    if (plan.status !== "applying" && plan.status !== "outcome_unknown") {
      return receipt(plan);
    }
    plan = await this.reconcile(plan);
    if (plan.status !== "applying" && plan.status !== "outcome_unknown") {
      return receipt(plan);
    }
    const read = ReadSchema.parse(
      await this.backend.read({ contractVersion: 1, path: plan.path }),
    );
    if (
      read.bindingFingerprint !== plan.bindingFingerprint ||
      read.sha256 !== plan.beforeSha256
    ) {
      return receipt(
        this.journal.transition(
          plan.operationId,
          [plan.status],
          "conflict",
          "Recovery found a different backend instance or note hash.",
        ),
      );
    }
    const applying = this.journal.transition(
      plan.operationId,
      [plan.status],
      "applying",
    );
    return receipt(await this.execute(applying));
  }

  private required(
    reference: string,
    idempotencyKey?: string,
  ): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationIdFromRef(reference));
    if (!plan) throw new Error("Unknown note-replace operation plan.");
    if (
      idempotencyKey !== undefined &&
      plan.idempotencyKey !== idempotencyKey
    ) {
      throw new Error("The idempotency key does not match the sealed plan.");
    }
    return plan;
  }

  private async execute(
    plan: ObsidianNoteReplacePlan,
  ): Promise<ObsidianNoteReplacePlan> {
    try {
      const status = StatusSchema.parse(await this.backend.status());
      if (status.backend.bindingFingerprint !== plan.bindingFingerprint) {
        return this.journal.transition(
          plan.operationId,
          ["applying"],
          "rejected",
          "The atomic-write backend instance no longer matches the sealed plan.",
        );
      }
      if (!status.backend.writeEnabled) {
        return this.journal.transition(
          plan.operationId,
          ["applying"],
          "rejected",
          "Atomic note writes were disabled before apply.",
        );
      }
      const result = CasSchema.parse(
        await this.backend.replace({
          contractVersion: 1,
          path: plan.path,
          expectedSha256: plan.beforeSha256,
          nextContent: plan.nextContent,
        }),
      );
      if (
        result.bindingFingerprint !== plan.bindingFingerprint ||
        result.path !== plan.path ||
        result.beforeSha256 !== plan.beforeSha256 ||
        result.afterSha256 !== plan.afterSha256
      ) {
        throw new Error(
          "Atomic-write postflight did not match the sealed plan.",
        );
      }
      return this.journal.transition(
        plan.operationId,
        ["applying"],
        "committed",
      );
    } catch (error) {
      const reconciled = await this.reconcile(plan).catch(() => plan);
      if (
        reconciled.status === "committed" ||
        reconciled.status === "conflict"
      ) {
        return reconciled;
      }
      const conflict =
        error instanceof McpError && error.code === BaseErrorCode.CONFLICT;
      return this.journal.transition(
        plan.operationId,
        ["applying"],
        conflict ? "conflict" : "outcome_unknown",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async reconcileApplying(
    plan: ObsidianNoteReplacePlan,
  ): Promise<ObsidianNoteReplacePlan> {
    const reconciled = await this.reconcile(plan);
    if (reconciled.status !== "applying") return reconciled;
    return this.journal.transition(
      plan.operationId,
      ["applying"],
      "outcome_unknown",
      "A previous apply reached the backend without a durable terminal receipt.",
    );
  }

  private async reconcile(
    plan: ObsidianNoteReplacePlan,
  ): Promise<ObsidianNoteReplacePlan> {
    const read = ReadSchema.parse(
      await this.backend.read({ contractVersion: 1, path: plan.path }),
    );
    if (read.bindingFingerprint !== plan.bindingFingerprint) {
      return this.journal.transition(
        plan.operationId,
        [plan.status],
        "conflict",
        "The atomic-write backend instance changed.",
      );
    }
    if (read.sha256 === plan.afterSha256) {
      return this.journal.transition(
        plan.operationId,
        [plan.status],
        "committed",
      );
    }
    if (read.sha256 !== plan.beforeSha256) {
      return this.journal.transition(
        plan.operationId,
        [plan.status],
        "conflict",
        "The note hash matches neither the sealed before nor after proof.",
      );
    }
    return plan;
  }
}
