import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../config/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { logger, requestContextService } from "../utils/index.js";
import {
  canonicalizeBaseFormulaPatchOperations,
  compileBaseFormulaPatch,
  type BaseFormulaPatchOperation,
  type BaseFormulaPatchProof,
} from "./baseConfigPatchCompiler.js";
import type { ObsidianRestApiService } from "./obsidianRestAPI/service.js";
import {
  operationDigest,
  type OperationReceipt,
} from "./operations/contract.js";
import {
  ObsidianNoteReplaceOperationAdapter,
  type AtomicResourceProfile,
} from "./operations/obsidianNoteReplaceOperationAdapter.js";
import {
  ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
  type ObsidianNoteReplaceProjection,
  type PendingOperationRowsInput,
  type PendingOperationRowsPage,
} from "./operations/obsidianNoteReplaceJournal.js";
import { RestBaseAtomicWriteBackend } from "./operations/restBaseAtomicWriteBackend.js";
import { assertWriteAllowed } from "./writePolicy.js";

const OPERATION_KIND = "obsidian.base.formula.patch" as const;
const PLAN_REF_PREFIX = "obsidian-base-formula-patch:v1:";
const INTERNAL_KEY_PREFIX = "optimike:base-formula-projection:v1:";
const INTERNAL_KEY_DOMAIN = "obsidian.base.formula.patch:v1\0";
const SHA256 = /^[a-f0-9]{64}$/u;

const BaseFormulaProofSchema = z.object({
  contractVersion: z.literal(1),
  compilerVersion: z.literal(1),
  sourcePreservation: z.literal(
    "byte-identical-outside-authorized-base-ranges",
  ),
  lineEnding: z.enum(["lf", "crlf"]),
  patchDigest: z.string().regex(SHA256),
  changedFormulas: z.array(z.string().min(1).max(256)).min(1).max(32),
  authorizedRanges: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        operation: z.enum(["set_formula", "delete_formula"]),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        beforeSha256: z.string().regex(SHA256),
        afterSha256: z.string().regex(SHA256),
      }),
    )
    .min(1)
    .max(33),
  untouchedSourceSha256: z.string().regex(SHA256),
});

const StoredProjectionSchema = z.object({
  contractVersion: z.literal(1),
  kind: z.literal(OPERATION_KIND),
  publicIdempotencyKey: z.string().min(1).max(256),
  intentDigest: z.string().regex(SHA256),
  proof: BaseFormulaProofSchema,
});

export const BASE_FORMULA_ATOMIC_PROFILE: AtomicResourceProfile = {
  operationKind: OPERATION_KIND,
  planRefPrefix: PLAN_REF_PREFIX,
  targetKind: "vault-obsidian-base-formulas",
  beforeProofKind: "base-yaml-sha256",
  afterProofKind: "atomic-base-formula-patch-verified",
  backendKind: "obsidian-vault-process-base",
  requiredExtension: ".base",
  targetLabel: "vault-relative Obsidian Base file",
};

export type GovernedBaseFormulaPlanInput = {
  path: string;
  operations: BaseFormulaPatchOperation[];
  idempotencyKey: string;
};

export type GovernedBaseFormulaReceipt = Omit<
  OperationReceipt,
  "idempotencyKey"
> & {
  idempotencyKey?: string;
  projection: {
    kind: typeof OPERATION_KIND;
    intentDigest: string;
    sourcePreservation: BaseFormulaPatchProof["sourcePreservation"];
    proof: BaseFormulaPatchProof;
  };
};

function publicKey(value: string): string {
  let wellFormed = true;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        wellFormed = false;
        break;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormed = false;
      break;
    }
  }
  if (!value || value.trim() !== value || value.length > 256 || !wellFormed) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "idempotencyKey must be non-empty, unpadded, and at most 256 characters.",
    );
  }
  return value;
}

function internalKey(value: string): string {
  return `${INTERNAL_KEY_PREFIX}${createHash("sha256")
    .update(`${INTERNAL_KEY_DOMAIN}${value}`, "utf8")
    .digest("hex")}`;
}

function operationId(reference: string): string {
  if (!reference.startsWith(PLAN_REF_PREFIX)) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "The plan reference does not belong to the governed Base formula surface.",
    );
  }
  const value = reference.slice(PLAN_REF_PREFIX.length);
  if (!z.string().uuid().safeParse(value).success) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "The governed Base formula plan reference is malformed.",
    );
  }
  return value;
}

function intent(path: string, operations: BaseFormulaPatchOperation[]) {
  const canonical = canonicalizeBaseFormulaPatchOperations(operations);
  return {
    operations: canonical,
    digest: operationDigest({
      contractVersion: 1,
      operationKind: OPERATION_KIND,
      path,
      operations: canonical,
    }),
  };
}

function projection(
  plan: ObsidianNoteReplacePlan,
  expectedPublicKey?: string,
  expectedIntentDigest?: string,
): ObsidianNoteReplaceProjection & {
  kind: typeof OPERATION_KIND;
  proof: BaseFormulaPatchProof;
} {
  const parsed = StoredProjectionSchema.safeParse(plan.projection);
  if (
    !parsed.success ||
    plan.idempotencyIdentity !== parsed.data.intentDigest ||
    (expectedPublicKey !== undefined &&
      parsed.data.publicIdempotencyKey !== expectedPublicKey) ||
    (expectedIntentDigest !== undefined &&
      parsed.data.intentDigest !== expectedIntentDigest)
  ) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "The durable plan is not bound to this governed Base formula intent.",
      { reason: "base_formula_projection_conflict" },
    );
  }
  return parsed.data as ObsidianNoteReplaceProjection & {
    kind: typeof OPERATION_KIND;
    proof: BaseFormulaPatchProof;
  };
}

function exposed(
  receipt: OperationReceipt,
  plan: ObsidianNoteReplacePlan,
  exposePublicKey: boolean,
): GovernedBaseFormulaReceipt {
  const stored = projection(plan);
  const { idempotencyKey: _internalKey, ...redacted } = receipt;
  return {
    ...redacted,
    ...(exposePublicKey ? { idempotencyKey: stored.publicIdempotencyKey } : {}),
    planDigest: operationDigest({
      contractVersion: 1,
      operationKind: OPERATION_KIND,
      atomicPlanDigest: receipt.planDigest,
      intentDigest: stored.intentDigest,
      proof: stored.proof,
    }),
    projection: {
      kind: OPERATION_KIND,
      intentDigest: stored.intentDigest,
      sourcePreservation: stored.proof.sourcePreservation,
      proof: stored.proof,
    },
  };
}

function assertPolicy(
  action: "plan" | "apply" | "recover",
  path: string,
  count: number,
  contentLength?: number,
): void {
  assertWriteAllowed({
    operation:
      action === "plan"
        ? "bases_formula_patch_plan"
        : action === "recover"
          ? "bases_formula_patch_recover"
          : "bases_formula_patch_apply",
    action,
    target: path,
    targetType: "filePath",
    batchCount: count,
    contentLength,
  });
}

export class GovernedBaseFormulaRuntime {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly backend: RestBaseAtomicWriteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly adapter: ObsidianNoteReplaceOperationAdapter,
    heartbeatMs: number,
  ) {
    this.heartbeat = setInterval(() => {
      try {
        this.journal.renewExecutionLease();
      } catch (error) {
        logger.warning(
          `Governed Base lease renewal failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
          requestContextService.createRequestContext({
            operation: "governedBaseFormulaLeaseRenewal",
          }),
        );
      }
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  listPendingOperationRows(
    input: Omit<
      PendingOperationRowsInput,
      | "fallbackOperationKind"
      | "admittedProjectionKinds"
      | "allowUnprojectedFallback"
    >,
  ): PendingOperationRowsPage {
    return this.journal.listPendingOperationRows({
      ...input,
      fallbackOperationKind: OPERATION_KIND,
      admittedProjectionKinds: [OPERATION_KIND],
      allowUnprojectedFallback: false,
    });
  }

  async plan(
    input: GovernedBaseFormulaPlanInput,
  ): Promise<GovernedBaseFormulaReceipt> {
    const key = publicKey(input.idempotencyKey);
    const canonical = intent(input.path, input.operations);
    const durableKey = internalKey(key);
    // Reject readonly mode before touching the backend. The sealed size is
    // enforced below once a durable replay or compiled projection is known.
    assertPolicy("plan", input.path, canonical.operations.length);
    const existing = this.journal.getByIdempotencyKey(durableKey);
    if (existing) {
      projection(existing, key, canonical.digest);
      assertPolicy(
        "plan",
        existing.path,
        canonical.operations.length,
        existing.nextContent.length,
      );
      return exposed(
        await this.adapter.status(`${PLAN_REF_PREFIX}${existing.operationId}`),
        existing,
        true,
      );
    }
    const source = await this.backend.read({
      contractVersion: 1,
      path: input.path,
    });
    const compiled = compileBaseFormulaPatch(
      source.content,
      canonical.operations,
    );
    assertPolicy(
      "plan",
      input.path,
      canonical.operations.length,
      compiled.nextYaml.length,
    );
    const storedProjection: ObsidianNoteReplaceProjection = {
      contractVersion: 1,
      kind: OPERATION_KIND,
      publicIdempotencyKey: key,
      intentDigest: canonical.digest,
      proof: compiled.proof as unknown as Record<string, unknown>,
    };
    const child = await this.adapter.plan({
      path: input.path,
      nextContent: compiled.nextYaml,
      idempotencyKey: durableKey,
      expectedBeforeSha256: source.sha256,
      expectedBindingFingerprint: source.bindingFingerprint,
      idempotencyIdentity: canonical.digest,
      projection: storedProjection,
    });
    const plan = this.required(child.planRef);
    projection(plan, key, canonical.digest);
    return exposed(child, plan, true);
  }

  async apply(reference: string, idempotencyKey: string) {
    const plan = this.required(reference);
    const stored = projection(plan, publicKey(idempotencyKey));
    assertPolicy(
      "apply",
      plan.path,
      stored.proof.changedFormulas.length,
      plan.nextContent.length,
    );
    const result = await this.adapter.apply(reference, plan.idempotencyKey);
    return exposed(result, this.required(reference), true);
  }

  async status(reference: string) {
    const plan = this.required(reference);
    projection(plan);
    const result = await this.adapter.status(reference);
    return exposed(result, this.required(reference), false);
  }

  async recover(reference: string, idempotencyKey: string) {
    const plan = this.required(reference);
    const stored = projection(plan, publicKey(idempotencyKey));
    assertPolicy(
      "recover",
      plan.path,
      stored.proof.changedFormulas.length,
      plan.nextContent.length,
    );
    const result = await this.adapter.recover(reference, plan.idempotencyKey);
    return exposed(result, this.required(reference), true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.journal.close();
  }

  private required(reference: string): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationId(reference));
    if (!plan) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "The governed Base formula plan is unknown or has expired.",
        { reason: "base_formula_plan_not_found" },
      );
    }
    return plan;
  }
}

export function createGovernedBaseFormulaRuntime(
  service: ObsidianRestApiService | undefined,
): GovernedBaseFormulaRuntime | undefined {
  if (!service) return undefined;
  const journal = new ObsidianNoteReplaceJournal(
    config.obsidianBaseFormulaJournalPath,
    { executionLeaseMs: config.obsidianNoteReplaceExecutionLeaseMs },
  );
  const backend = new RestBaseAtomicWriteBackend(service);
  const adapter = new ObsidianNoteReplaceOperationAdapter(
    backend,
    journal,
    BASE_FORMULA_ATOMIC_PROFILE,
  );
  const runtime = new GovernedBaseFormulaRuntime(
    backend,
    journal,
    adapter,
    Math.max(
      250,
      Math.min(
        5_000,
        Math.floor(config.obsidianNoteReplaceExecutionLeaseMs / 4),
      ),
    ),
  );
  process.once("exit", () => runtime.close());
  return runtime;
}
