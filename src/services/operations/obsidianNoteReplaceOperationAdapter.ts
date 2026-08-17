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
  ObsidianNoteReplaceConcurrencyError,
  ObsidianNoteReplaceJournal,
  noteReplaceIdempotencyConflict,
  type ObsidianNoteReplacePlan,
  type ObsidianNoteReplaceProjection,
} from "./obsidianNoteReplaceJournal.js";
import {
  resolveModifiedTimeSettlement,
  type ModifiedTimeSettlementEvidence,
  type ModifiedTimeSettlementPolicy,
} from "./modifiedTimeSettlement.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const DatePluginIdSchema = z.enum([
  "update-time-on-edit",
  "frontmatter-date-manager",
  "update-time",
]);
const FrontmatterPropertyNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}_](?:[\p{L}\p{M}\p{N}_. -]*[\p{L}\p{M}\p{N}_.-])?$/u)
  .refine((value) => value.trim() === value)
  .refine((value) => !/[,:\r\n]/u.test(value))
  .refine((value) => !/^(?:null|true|false|yes|no|on|off)$/iu.test(value));

export type AtomicResourceProfile = {
  operationKind: string;
  planRefPrefix: string;
  targetKind: string;
  beforeProofKind: string;
  afterProofKind: string;
  backendKind: string;
  requiredExtension: string;
  targetLabel: string;
};

const NOTE_PROFILE: AtomicResourceProfile = {
  operationKind: "obsidian.note.replace",
  planRefPrefix: "obsidian-note-replace:v1:",
  targetKind: "vault-markdown-note",
  beforeProofKind: "note-sha256",
  afterProofKind: "atomic-note-replacement-verified",
  backendKind: "obsidian-vault-process",
  requiredExtension: ".md",
  targetLabel: "Markdown note",
};

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
    settlement: z
      .object({
        contractVersion: z.literal(1),
        modifiedTimeFrontmatter: z.object({
          integrations: z
            .array(
              z.object({
                pluginId: DatePluginIdSchema,
                propertyName: FrontmatterPropertyNameSchema,
                settlementObservationDelayMs: z
                  .number()
                  .int()
                  .min(0)
                  .max(4 * 60 * 1000)
                  .optional(),
              }),
            )
            .max(3),
          utcOffsetMinutes: z
            .number()
            .int()
            .min(-14 * 60)
            .max(14 * 60),
        }),
      })
      .optional(),
    protection: z
      .object({
        contractVersion: z.literal(1),
        frontmatterDateProperties: z.object({
          integrations: z
            .array(
              z
                .object({
                  pluginId: DatePluginIdSchema,
                  createdPropertyName: FrontmatterPropertyNameSchema.optional(),
                  modifiedPropertyName:
                    FrontmatterPropertyNameSchema.optional(),
                  viewedPropertyName: FrontmatterPropertyNameSchema.optional(),
                })
                .refine(
                  (integration) =>
                    integration.createdPropertyName !== undefined ||
                    integration.modifiedPropertyName !== undefined ||
                    integration.viewedPropertyName !== undefined,
                ),
            )
            .max(3),
        }),
      })
      .optional(),
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
  expectedBeforeSha256?: string;
  expectedBindingFingerprint?: string;
  idempotencyIdentity?: string;
  projection?: ObsidianNoteReplaceProjection;
};

export type ObsidianNoteReplaceAdapterOptions = {
  modifiedTimeProtectedKeys?: readonly string[];
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

function normalizedKey(value: string): string {
  return value.trim().toLowerCase();
}

function hasSettlementObservationDelay<
  T extends { settlementObservationDelayMs?: number },
>(value: T): value is T & { settlementObservationDelayMs: number } {
  return value.settlementObservationDelayMs !== undefined;
}

function effectiveProtectedFrontmatterKeysFromStatus(
  status: z.infer<typeof StatusSchema>,
  configuredKeys: readonly string[],
): string[] {
  const keys = new Map<string, string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    const normalized = normalizedKey(value);
    if (normalized && !keys.has(normalized)) keys.set(normalized, value);
  };
  configuredKeys.forEach(add);
  status.settlement?.modifiedTimeFrontmatter.integrations.forEach(
    (integration) => add(integration.propertyName),
  );
  status.protection?.frontmatterDateProperties.integrations.forEach(
    (integration) => {
      add(integration.createdPropertyName);
      add(integration.modifiedPropertyName);
      add(integration.viewedPropertyName);
    },
  );
  return [...keys.values()];
}

export function effectiveAtomicWriteProtectedFrontmatterKeys(
  status: unknown,
  configuredKeys: readonly string[],
): string[] {
  return effectiveProtectedFrontmatterKeysFromStatus(
    StatusSchema.parse(status),
    configuredKeys,
  );
}

export type AtomicWriteDateProtection = {
  createdPropertyNames: string[];
  unsupportedModifiedPropertyNames: string[];
};

export function effectiveAtomicWriteDateProtection(
  status: unknown,
): AtomicWriteDateProtection {
  const parsed = StatusSchema.parse(status);
  const settlementIntegrations = new Set(
    (parsed.settlement?.modifiedTimeFrontmatter.integrations ?? [])
      .filter(hasSettlementObservationDelay)
      .map(
        (integration) =>
          `${integration.pluginId}\u0000${normalizedKey(integration.propertyName)}`,
      ),
  );
  const created = new Map<string, string>();
  const unsupportedModified = new Map<string, string>();
  for (const integration of parsed.protection?.frontmatterDateProperties
    .integrations ?? []) {
    if (integration.createdPropertyName) {
      created.set(
        normalizedKey(integration.createdPropertyName),
        integration.createdPropertyName,
      );
    }
    if (
      integration.modifiedPropertyName &&
      !settlementIntegrations.has(
        `${integration.pluginId}\u0000${normalizedKey(integration.modifiedPropertyName)}`,
      )
    ) {
      unsupportedModified.set(
        normalizedKey(integration.modifiedPropertyName),
        integration.modifiedPropertyName,
      );
    }
  }
  return {
    createdPropertyNames: [...created.values()],
    unsupportedModifiedPropertyNames: [...unsupportedModified.values()],
  };
}

function settlementPolicy(
  status: z.infer<typeof StatusSchema>,
  protectedKeys: readonly string[],
): ModifiedTimeSettlementPolicy | undefined {
  const advertised = status.settlement?.modifiedTimeFrontmatter;
  if (!advertised) return undefined;
  if (
    advertised.integrations.some(
      (integration) => integration.settlementObservationDelayMs === undefined,
    )
  ) {
    throw new McpError(
      BaseErrorCode.FORBIDDEN,
      "The Atomic Write Bridge does not advertise a bounded settlement observation delay. Upgrade the Bridge to 0.3.0 or later before governed writes.",
      { reason: "atomic_write_settlement_delay_missing" },
    );
  }
  const protectedSet = new Set(
    effectiveProtectedFrontmatterKeysFromStatus(status, protectedKeys)
      .map(normalizedKey)
      .filter(Boolean),
  );
  const integrations = advertised.integrations
    .filter(hasSettlementObservationDelay)
    .filter((integration) =>
      protectedSet.has(normalizedKey(integration.propertyName)),
    );
  if (integrations.length === 0) return undefined;
  return {
    contractVersion: 1,
    integrations,
    utcOffsetMinutes: advertised.utcOffsetMinutes,
  };
}

function sameSettlementPolicy(
  left: ModifiedTimeSettlementPolicy | undefined,
  right: ModifiedTimeSettlementPolicy | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasBoundedSettlementObservationDelays(
  policy: ModifiedTimeSettlementPolicy | undefined,
): boolean {
  return (
    policy === undefined ||
    policy.integrations.every((integration) => {
      const delay: unknown = integration.settlementObservationDelayMs;
      return (
        typeof delay === "number" &&
        Number.isInteger(delay) &&
        delay >= 0 &&
        delay <= 4 * 60 * 1000
      );
    })
  );
}

function sameBackendTarget(
  plan: ObsidianNoteReplacePlan,
  read: z.infer<typeof ReadSchema>,
): boolean {
  return (
    read.bindingFingerprint === plan.bindingFingerprint &&
    read.path === plan.path
  );
}

function planRef(profile: AtomicResourceProfile, operationId: string): string {
  return `${profile.planRefPrefix}${operationId}`;
}

function operationIdFromRef(
  profile: AtomicResourceProfile,
  reference: string,
): string {
  if (!reference.startsWith(profile.planRefPrefix)) {
    throw new Error(
      `The operation plan reference is not a ${profile.operationKind} plan.`,
    );
  }
  const operationId = reference.slice(profile.planRefPrefix.length);
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

function planDigest(
  profile: AtomicResourceProfile,
  plan: ObsidianNoteReplacePlan,
): string {
  return operationDigest({
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationKind: profile.operationKind,
    operationId: plan.operationId,
    idempotencyKey: plan.idempotencyKey,
    backendBinding: plan.bindingFingerprint,
    path: plan.path,
    beforeSha256: plan.beforeSha256,
    afterSha256: plan.afterSha256,
    requestDigest: plan.requestDigest,
    ...(plan.idempotencyIdentity
      ? { idempotencyIdentity: plan.idempotencyIdentity }
      : {}),
    ...(plan.projection
      ? { projectionDigest: operationDigest(plan.projection) }
      : {}),
  });
}

function receipt(
  profile: AtomicResourceProfile,
  plan: ObsidianNoteReplacePlan,
): OperationReceipt {
  const current = state(plan);
  const terminal = current.phase === "terminal";
  const recoverable =
    plan.status === "applying" || plan.status === "outcome_unknown";
  const digest = planDigest(profile, plan);
  const committedSha256 =
    plan.modifiedTimeSettlementEvidence?.observedSha256 ?? plan.afterSha256;
  return {
    contractVersion: OPERATION_RUNTIME_CONTRACT_VERSION,
    operationId: plan.operationId,
    idempotencyKey: plan.idempotencyKey,
    operationKind: profile.operationKind,
    planRef: planRef(profile, plan.operationId),
    planDigest: digest,
    phase: current.phase,
    outcome: current.outcome,
    backend: {
      kind: profile.backendKind,
      bindingFingerprint: plan.bindingFingerprint,
    },
    target: { kind: profile.targetKind, logicalRef: plan.path },
    beforeProof: {
      kind: profile.beforeProofKind,
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
            kind: profile.afterProofKind,
            digest: operationDigest({
              path: plan.path,
              sha256: committedSha256,
              bindingFingerprint: plan.bindingFingerprint,
            }),
            details: {
              sha256: committedSha256,
              ...(plan.modifiedTimeSettlementEvidence
                ? {
                    sealedSha256: plan.afterSha256,
                    settlementKind: plan.modifiedTimeSettlementEvidence.kind,
                    settlementPropertyName:
                      plan.modifiedTimeSettlementEvidence.propertyName,
                    settlementPluginId:
                      plan.modifiedTimeSettlementEvidence.pluginId,
                    settlementObservedAt:
                      plan.modifiedTimeSettlementEvidence.observedAt,
                  }
                : {}),
            },
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
    ...(recoverable ? { recoveryRef: planRef(profile, plan.operationId) } : {}),
    recoveryAllowed: recoverable,
    applyAllowed: plan.status === "planned",
  };
}

function validateInput(
  profile: AtomicResourceProfile,
  input: ObsidianNoteReplacePlanInput,
): void {
  if (
    !input.path ||
    !input.path.toLowerCase().endsWith(profile.requiredExtension)
  ) {
    throw new Error(`path must identify a ${profile.targetLabel}.`);
  }
  if (!input.idempotencyKey.trim()) {
    throw new Error("idempotencyKey is required.");
  }
  if (Buffer.byteLength(input.nextContent, "utf8") > 5 * 1024 * 1024) {
    throw new Error("nextContent exceeds the bridge limit.");
  }
  for (const [name, value] of [
    ["expectedBeforeSha256", input.expectedBeforeSha256],
    ["expectedBindingFingerprint", input.expectedBindingFingerprint],
    ["idempotencyIdentity", input.idempotencyIdentity],
  ] as const) {
    if (value !== undefined && !SHA256.test(value)) {
      throw new Error(name + " must be a lowercase SHA-256 digest.");
    }
  }
  if (input.projection) {
    if (
      input.projection.contractVersion !== 1 ||
      !input.projection.kind ||
      input.projection.kind.length > 128 ||
      !input.projection.publicIdempotencyKey ||
      input.projection.publicIdempotencyKey.length > 256 ||
      !SHA256.test(input.projection.intentDigest) ||
      input.projection.intentDigest !== input.idempotencyIdentity
    ) {
      throw new Error(
        "projection metadata is malformed or not bound to the idempotency identity.",
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(input.projection), "utf8") >
      128 * 1024
    ) {
      throw new Error("projection metadata exceeds the private journal limit.");
    }
  }
}

export class ObsidianNoteReplaceOperationAdapter
  implements OperationAdapter<ObsidianNoteReplacePlanInput>
{
  readonly operationKind: string;

  constructor(
    private readonly backend: AtomicWriteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly profile: AtomicResourceProfile = NOTE_PROFILE,
    private readonly options: ObsidianNoteReplaceAdapterOptions = {},
  ) {
    this.operationKind = profile.operationKind;
  }

  private replayIfDurableWinner(
    input: ObsidianNoteReplacePlanInput,
    afterSha256: string,
  ): OperationReceipt | undefined {
    const existing = this.journal.getByIdempotencyKey(input.idempotencyKey);
    if (!existing) return undefined;
    const identityBound =
      existing.idempotencyIdentity !== undefined ||
      input.idempotencyIdentity !== undefined;
    const matches = identityBound
      ? existing.path === input.path &&
        existing.idempotencyIdentity !== undefined &&
        existing.idempotencyIdentity === input.idempotencyIdentity
      : existing.path === input.path && existing.afterSha256 === afterSha256;
    if (!matches) throw noteReplaceIdempotencyConflict();
    return receipt(this.profile, existing);
  }

  async plan(input: ObsidianNoteReplacePlanInput): Promise<OperationReceipt> {
    validateInput(this.profile, input);
    const afterSha256 = createHash("sha256")
      .update(input.nextContent, "utf8")
      .digest("hex");
    const initialReplay = this.replayIfDurableWinner(input, afterSha256);
    if (initialReplay) return initialReplay;
    let status;
    try {
      status = StatusSchema.parse(await this.backend.status());
    } catch (error) {
      const replay = this.replayIfDurableWinner(input, afterSha256);
      if (replay) return replay;
      throw error;
    }
    const statusReplay = this.replayIfDurableWinner(input, afterSha256);
    if (statusReplay) return statusReplay;
    if (!status.backend.writeEnabled) {
      const replay = this.replayIfDurableWinner(input, afterSha256);
      if (replay) return replay;
      throw new Error(
        "Atomic note writes are disabled in the bridge settings.",
      );
    }
    let read;
    try {
      read = ReadSchema.parse(
        await this.backend.read({ contractVersion: 1, path: input.path }),
      );
    } catch (error) {
      const replay = this.replayIfDurableWinner(input, afterSha256);
      if (replay) return replay;
      throw error;
    }
    const readReplay = this.replayIfDurableWinner(input, afterSha256);
    if (readReplay) return readReplay;
    if (
      read.bindingFingerprint !== status.backend.bindingFingerprint ||
      read.path !== input.path
    ) {
      const replay = this.replayIfDurableWinner(input, afterSha256);
      if (replay) return replay;
      throw new Error(
        "Atomic-write backend identity or target changed during planning.",
      );
    }
    if (
      input.expectedBeforeSha256 !== undefined &&
      read.sha256 !== input.expectedBeforeSha256
    ) {
      const replay = this.replayIfDurableWinner(input, afterSha256);
      if (replay) return replay;
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "The note changed after the domain projection was compiled.",
      );
    }
    if (
      input.expectedBindingFingerprint !== undefined &&
      read.bindingFingerprint !== input.expectedBindingFingerprint
    ) {
      const replay = this.replayIfDurableWinner(input, afterSha256);
      if (replay) return replay;
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "The atomic-write backend changed after the domain projection was compiled.",
      );
    }
    const modifiedTimeSettlementPolicy = settlementPolicy(
      status,
      this.options.modifiedTimeProtectedKeys ?? [],
    );
    const requestDigest = operationDigest({
      operationKind: this.operationKind,
      path: input.path,
      beforeSha256: read.sha256,
      afterSha256,
      bindingFingerprint: read.bindingFingerprint,
      ...(input.idempotencyIdentity
        ? { idempotencyIdentity: input.idempotencyIdentity }
        : {}),
      ...(input.projection
        ? { projectionDigest: operationDigest(input.projection) }
        : {}),
      ...(modifiedTimeSettlementPolicy
        ? {
            modifiedTimeSettlementPolicy,
          }
        : {}),
    });
    return receipt(
      this.profile,
      this.journal.create({
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        ...(input.idempotencyIdentity
          ? { idempotencyIdentity: input.idempotencyIdentity }
          : {}),
        ...(input.projection ? { projection: input.projection } : {}),
        path: input.path,
        beforeSha256: read.sha256,
        afterSha256,
        nextContent: input.nextContent,
        bindingFingerprint: read.bindingFingerprint,
        ...(modifiedTimeSettlementPolicy
          ? { modifiedTimeSettlementPolicy }
          : {}),
      }),
    );
  }

  async apply(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    const plan = this.required(reference, idempotencyKey);
    if (plan.status === "committed") return receipt(this.profile, plan);
    if (plan.status !== "planned") {
      if (plan.status === "applying") {
        // A second caller may be observing a live executor. Reconcile only
        // terminal proof; never classify an in-flight apply as interrupted.
        return receipt(this.profile, await this.reconcile(plan));
      }
      return receipt(this.profile, plan);
    }
    let applying: ObsidianNoteReplacePlan;
    try {
      applying = this.journal.transition(
        plan.operationId,
        ["planned"],
        "applying",
      );
    } catch (error) {
      if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
      const current = this.journal.get(plan.operationId);
      if (!current) throw error;
      return receipt(this.profile, current);
    }
    return receipt(this.profile, await this.execute(applying, false));
  }

  async status(reference: string): Promise<OperationReceipt> {
    const plan = this.required(reference);
    if (plan.status === "applying" || plan.status === "outcome_unknown") {
      return receipt(this.profile, await this.reconcile(plan));
    }
    return receipt(this.profile, plan);
  }

  async recover(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    let plan = this.required(reference, idempotencyKey);
    if (plan.status === "committed") return receipt(this.profile, plan);
    if (plan.status !== "applying" && plan.status !== "outcome_unknown") {
      return receipt(this.profile, plan);
    }
    if (
      !hasBoundedSettlementObservationDelays(plan.modifiedTimeSettlementPolicy)
    ) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "The sealed plan predates bounded settlement observation delays and cannot be recovered safely. Re-plan with Atomic Write Bridge 0.3.0 or later.",
        { reason: "sealed_settlement_delay_missing" },
      );
    }
    plan = await this.reconcile(plan);
    if (plan.status === "applying") {
      // A live executor still owns this plan. Only a persisted interruption
      // marker (outcome_unknown) authorizes exact-plan re-execution.
      return receipt(this.profile, plan);
    }
    if (plan.status !== "outcome_unknown") {
      return receipt(this.profile, plan);
    }
    plan = this.beginModifiedTimeSettlementObservationOrReload(plan);
    if (plan.status !== "outcome_unknown") {
      return receipt(this.profile, plan);
    }
    await this.awaitModifiedTimeSettlementObservation(plan);
    const read = ReadSchema.parse(
      await this.backend.read({ contractVersion: 1, path: plan.path }),
    );
    if (!sameBackendTarget(plan, read)) {
      return receipt(
        this.profile,
        this.transitionOrReload(
          plan,
          [plan.status],
          "conflict",
          "Recovery found a different backend instance or logical target.",
        ),
      );
    }
    if (read.sha256 === plan.afterSha256) {
      return receipt(
        this.profile,
        this.transitionOrReload(plan, [plan.status], "committed"),
      );
    }
    const settlement = this.modifiedTimeSettlement(plan, read.content);
    if (settlement) {
      return receipt(
        this.profile,
        this.commitWithModifiedTimeSettlementOrReload(plan, settlement),
      );
    }
    if (read.sha256 !== plan.beforeSha256) {
      return receipt(
        this.profile,
        this.uncertain(
          plan,
          "Recovery found a hash matching neither sealed proof after the original request may have been sent.",
        ),
      );
    }
    let applying: ObsidianNoteReplacePlan;
    try {
      applying = this.journal.transition(
        plan.operationId,
        [plan.status],
        "applying",
      );
    } catch (error) {
      if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
      const current = this.journal.get(plan.operationId);
      if (!current) throw error;
      return receipt(this.profile, current);
    }
    return receipt(this.profile, await this.execute(applying, true));
  }

  private required(
    reference: string,
    idempotencyKey?: string,
  ): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationIdFromRef(this.profile, reference));
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
    recoveredFromUnknown: boolean,
  ): Promise<ObsidianNoteReplacePlan> {
    const executionAttemptId = this.requiredExecutionAttemptId(plan);
    let casDispatched = false;
    try {
      const status = StatusSchema.parse(await this.backend.status());
      if (status.backend.bindingFingerprint !== plan.bindingFingerprint) {
        return this.transitionOrReload(
          plan,
          ["applying"],
          "rejected",
          "The atomic-write backend instance no longer matches the sealed plan.",
          executionAttemptId,
        );
      }
      if (!status.backend.writeEnabled) {
        return this.transitionOrReload(
          plan,
          ["applying"],
          "rejected",
          "Atomic note writes were disabled before apply.",
          executionAttemptId,
        );
      }
      if (
        !sameSettlementPolicy(
          plan.modifiedTimeSettlementPolicy,
          settlementPolicy(
            status,
            this.options.modifiedTimeProtectedKeys ?? [],
          ),
        )
      ) {
        return this.transitionOrReload(
          plan,
          ["applying"],
          "rejected",
          "The configured modified-time settlement policy changed after planning.",
          executionAttemptId,
        );
      }
      casDispatched = true;
      const rawResult = await this.backend.replace({
        contractVersion: 1,
        path: plan.path,
        bindingFingerprint: plan.bindingFingerprint,
        expectedSha256: plan.beforeSha256,
        nextContent: plan.nextContent,
      });
      plan = this.beginModifiedTimeSettlementObservationOrReload(
        plan,
        executionAttemptId,
      );
      if (
        plan.status !== "applying" ||
        plan.executionOwner?.attemptId !== executionAttemptId
      ) {
        return plan;
      }
      const result = CasSchema.parse(rawResult);
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
      if (plan.modifiedTimeSettlementPolicy) {
        await this.awaitModifiedTimeSettlementObservation(plan);
        const reconciled = await this.reconcile(plan, executionAttemptId);
        if (reconciled.status !== "applying") return reconciled;
        return this.uncertain(
          plan,
          "The post-write observation did not reach either sealed proof.",
          executionAttemptId,
        );
      }
      return this.transitionOrReload(
        plan,
        ["applying"],
        "committed",
        undefined,
        executionAttemptId,
      );
    } catch (error) {
      if (
        casDispatched &&
        plan.modifiedTimeSettlementPolicy &&
        plan.settlementObservationStartedAtEpochMs === undefined
      ) {
        plan = this.beginModifiedTimeSettlementObservationOrReload(
          plan,
          executionAttemptId,
        );
        if (
          plan.status !== "applying" ||
          plan.executionOwner?.attemptId !== executionAttemptId
        ) {
          return plan;
        }
      }
      const conflict =
        error instanceof McpError && error.code === BaseErrorCode.CONFLICT;
      if (conflict) {
        if (!casDispatched) {
          return this.transitionOrReload(
            plan,
            ["applying"],
            "conflict",
            error.message,
            executionAttemptId,
          );
        }
        let reconciled: ObsidianNoteReplacePlan;
        try {
          await this.awaitModifiedTimeSettlementObservation(plan);
          reconciled = await this.reconcileCasConflict(
            plan,
            executionAttemptId,
            recoveredFromUnknown,
          );
        } catch (reconciliationError) {
          return this.uncertain(
            plan,
            `CAS conflict reconciliation failed: ${reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)}`,
            executionAttemptId,
          );
        }
        if (reconciled.status !== "applying") return reconciled;
        return this.transitionOrReload(
          plan,
          ["applying"],
          "conflict",
          error.message,
          executionAttemptId,
        );
      }
      const rejected =
        error instanceof McpError && error.code === BaseErrorCode.FORBIDDEN;
      if (rejected) {
        return this.transitionOrReload(
          plan,
          ["applying"],
          "rejected",
          error.message,
          executionAttemptId,
        );
      }
      if (casDispatched) {
        await this.awaitModifiedTimeSettlementObservation(plan);
        const reconciled = await this.reconcile(plan, executionAttemptId).catch(
          () => plan,
        );
        if (reconciled.status !== "applying") {
          return reconciled;
        }
      }
      return this.uncertain(
        plan,
        error instanceof Error ? error.message : String(error),
        executionAttemptId,
      );
    }
  }

  private async reconcileCasConflict(
    plan: ObsidianNoteReplacePlan,
    executionAttemptId: string,
    recoveredFromUnknown: boolean,
  ): Promise<ObsidianNoteReplacePlan> {
    const read = ReadSchema.parse(
      await this.backend.read({ contractVersion: 1, path: plan.path }),
    );
    const matchesTarget = sameBackendTarget(plan, read);
    if (
      matchesTarget &&
      this.modifiedTimeSettlementObservationRemainingMs(plan) > 0
    ) {
      return plan;
    }
    if (matchesTarget && read.sha256 === plan.afterSha256) {
      return this.transitionOrReload(
        plan,
        ["applying"],
        "committed",
        undefined,
        executionAttemptId,
      );
    }
    const settlement = matchesTarget
      ? this.modifiedTimeSettlement(plan, read.content)
      : undefined;
    if (settlement) {
      return this.commitWithModifiedTimeSettlementOrReload(
        plan,
        settlement,
        executionAttemptId,
      );
    }
    if (
      recoveredFromUnknown &&
      matchesTarget &&
      read.sha256 !== plan.beforeSha256
    ) {
      return this.uncertain(
        plan,
        "CAS conflict reconciliation found neither sealed hash after an earlier uncertain attempt.",
        executionAttemptId,
      );
    }
    return plan;
  }

  private async reconcile(
    plan: ObsidianNoteReplacePlan,
    executionAttemptId?: string,
  ): Promise<ObsidianNoteReplacePlan> {
    const read = ReadSchema.parse(
      await this.backend.read({ contractVersion: 1, path: plan.path }),
    );
    const observesLiveExecutor =
      plan.status === "applying" && executionAttemptId === undefined;
    if (!sameBackendTarget(plan, read)) {
      if (observesLiveExecutor) return plan;
      return this.transitionOrReload(
        plan,
        [plan.status],
        "conflict",
        "The atomic-write backend instance or logical target changed.",
        executionAttemptId,
      );
    }
    if (
      plan.modifiedTimeSettlementPolicy &&
      this.modifiedTimeSettlementObservationRemainingMs(plan) > 0
    ) {
      return plan;
    }
    if (read.sha256 === plan.afterSha256) {
      if (observesLiveExecutor) {
        return this.commitAfterVerifiedProofOrReload(plan);
      }
      return this.transitionOrReload(
        plan,
        [plan.status],
        "committed",
        undefined,
        executionAttemptId,
      );
    }
    const settlement = this.modifiedTimeSettlement(plan, read.content);
    if (settlement) {
      if (observesLiveExecutor) {
        return this.commitWithModifiedTimeSettlementOrReload(plan, settlement);
      }
      return this.commitWithModifiedTimeSettlementOrReload(
        plan,
        settlement,
        executionAttemptId,
      );
    }
    if (read.sha256 !== plan.beforeSha256) {
      if (observesLiveExecutor) return plan;
      return this.uncertain(
        plan,
        "The note hash matches neither the sealed before nor after proof.",
        executionAttemptId,
      );
    }
    return plan;
  }

  private modifiedTimeSettlement(
    plan: ObsidianNoteReplacePlan,
    observedContent: string,
  ): ModifiedTimeSettlementEvidence | undefined {
    if (
      !plan.modifiedTimeSettlementPolicy ||
      !hasBoundedSettlementObservationDelays(
        plan.modifiedTimeSettlementPolicy,
      ) ||
      plan.executionStartedAtEpochMs === undefined ||
      !plan.nextContent
    ) {
      return undefined;
    }
    return resolveModifiedTimeSettlement(
      plan.nextContent,
      observedContent,
      plan.modifiedTimeSettlementPolicy,
      {
        applyStartedAtEpochMs: plan.executionStartedAtEpochMs,
        settlementObservedAtEpochMs: (this.options.now ?? Date.now)(),
      },
    );
  }

  private async awaitModifiedTimeSettlementObservation(
    plan: ObsidianNoteReplacePlan,
  ): Promise<void> {
    const remainingMs = this.modifiedTimeSettlementObservationRemainingMs(plan);
    if (!Number.isFinite(remainingMs)) {
      throw new Error(
        "Modified-time settlement observation was not started after the CAS attempt.",
      );
    }
    if (remainingMs <= 0) return;
    const sleep =
      this.options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    await sleep(remainingMs);
  }

  private modifiedTimeSettlementObservationRemainingMs(
    plan: ObsidianNoteReplacePlan,
  ): number {
    if (!plan.modifiedTimeSettlementPolicy) {
      return 0;
    }
    if (
      !hasBoundedSettlementObservationDelays(plan.modifiedTimeSettlementPolicy)
    ) {
      return Number.POSITIVE_INFINITY;
    }
    if (plan.settlementObservationStartedAtEpochMs === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    const observationDelayMs = Math.max(
      0,
      ...plan.modifiedTimeSettlementPolicy.integrations.map(
        (integration) => integration.settlementObservationDelayMs,
      ),
    );
    const now = this.options.now ?? Date.now;
    return Math.max(
      0,
      plan.settlementObservationStartedAtEpochMs + observationDelayMs - now(),
    );
  }

  private beginModifiedTimeSettlementObservationOrReload(
    plan: ObsidianNoteReplacePlan,
    expectedExecutionAttemptId?: string,
  ): ObsidianNoteReplacePlan {
    if (!plan.modifiedTimeSettlementPolicy) return plan;
    if (plan.settlementObservationStartedAtEpochMs !== undefined) return plan;
    if (plan.status !== "applying" && plan.status !== "outcome_unknown") {
      return this.journal.get(plan.operationId) ?? plan;
    }
    try {
      return this.journal.beginModifiedTimeSettlementObservation(
        plan.operationId,
        [plan.status],
        expectedExecutionAttemptId,
      );
    } catch (error) {
      if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
      return this.journal.get(plan.operationId) ?? plan;
    }
  }

  private commitWithModifiedTimeSettlementOrReload(
    plan: ObsidianNoteReplacePlan,
    evidence: ModifiedTimeSettlementEvidence,
    expectedExecutionAttemptId?: string,
  ): ObsidianNoteReplacePlan {
    if (plan.status !== "applying" && plan.status !== "outcome_unknown") {
      return this.journal.get(plan.operationId) ?? plan;
    }
    try {
      return this.journal.commitWithModifiedTimeSettlement(
        plan.operationId,
        [plan.status],
        evidence,
        expectedExecutionAttemptId,
      );
    } catch (error) {
      if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
      return this.journal.get(plan.operationId) ?? plan;
    }
  }

  private uncertain(
    plan: ObsidianNoteReplacePlan,
    failure: string,
    executionAttemptId?: string,
  ): ObsidianNoteReplacePlan {
    if (plan.status === "outcome_unknown") return plan;
    if (plan.status === "applying" && executionAttemptId === undefined) {
      return plan;
    }
    return this.transitionOrReload(
      plan,
      ["applying"],
      "outcome_unknown",
      failure,
      executionAttemptId,
    );
  }

  private transitionOrReload(
    observed: ObsidianNoteReplacePlan,
    expected: ObsidianNoteReplacePlan["status"][],
    next: ObsidianNoteReplacePlan["status"],
    failure?: string,
    expectedExecutionAttemptId?: string,
  ): ObsidianNoteReplacePlan {
    try {
      return this.journal.transition(
        observed.operationId,
        expected,
        next,
        failure,
        expectedExecutionAttemptId,
      );
    } catch (error) {
      if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
      const current = this.journal.get(observed.operationId);
      if (!current) throw error;
      return current;
    }
  }

  private commitAfterVerifiedProofOrReload(
    observed: ObsidianNoteReplacePlan,
  ): ObsidianNoteReplacePlan {
    try {
      return this.journal.commitAfterVerifiedProof(observed.operationId, [
        "applying",
        "outcome_unknown",
      ]);
    } catch (error) {
      if (!(error instanceof ObsidianNoteReplaceConcurrencyError)) throw error;
      const current = this.journal.get(observed.operationId);
      if (!current) throw error;
      return current;
    }
  }

  private requiredExecutionAttemptId(plan: ObsidianNoteReplacePlan): string {
    const executionAttemptId = plan.executionOwner?.attemptId;
    if (plan.status !== "applying" || !executionAttemptId) {
      throw new ObsidianNoteReplaceConcurrencyError();
    }
    return executionAttemptId;
  }
}
