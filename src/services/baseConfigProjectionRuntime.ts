import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import {
  canonicalizeBaseConfigPatchOperations,
  compileBaseConfigPatch,
  type BaseConfigPatchOperation,
  type BaseConfigPatchProof,
} from "./baseFullConfigCompiler.js";
import { operationDigest, type OperationReceipt } from "./operations/contract.js";
import {
  ObsidianNoteReplaceOperationAdapter,
  type AtomicResourceProfile,
} from "./operations/obsidianNoteReplaceOperationAdapter.js";
import type {
  ObsidianNoteReplaceJournal,
  ObsidianNoteReplacePlan,
  ObsidianNoteReplaceProjection,
} from "./operations/obsidianNoteReplaceJournal.js";
import type { RestBaseAtomicWriteBackend } from "./operations/restBaseAtomicWriteBackend.js";
import { assertWriteAllowed } from "./writePolicy.js";

export const BASE_CONFIG_OPERATION_KIND = "obsidian.base.config.patch" as const;
export const BASE_CONFIG_PLAN_REF_PREFIX = "obsidian-base-config-patch:v1:";
const INTERNAL_KEY_PREFIX = "optimike:base-config-projection:v1:";
const INTERNAL_KEY_DOMAIN = "obsidian.base.config.patch:v1\0";
const SHA256 = /^[a-f0-9]{64}$/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const ProofSchema = z.object({
  contractVersion: z.literal(1),
  compilerVersion: z.literal(1),
  sourcePreservation: z.literal("semantic-identical-outside-authorized-paths"),
  formattingPreserved: z.boolean(),
  lineEnding: z.enum(["lf", "crlf"]),
  patchDigest: z.string().regex(SHA256),
  changedPaths: z.array(z.string().min(1).max(1024)).min(1).max(64),
  commentsDropped: z.number().int().nonnegative(),
  beforeSha256: z.string().regex(SHA256),
  afterSha256: z.string().regex(SHA256),
  warnings: z.array(z.string().max(128)).max(32),
}).strict();

const StoredProjectionSchema = z.object({
  contractVersion: z.literal(1),
  kind: z.literal(BASE_CONFIG_OPERATION_KIND),
  publicIdempotencyKey: z.string().min(1).max(256),
  intentDigest: z.string().regex(SHA256),
  proof: ProofSchema,
});

/** Same Bases Bridge Atomic V1 CAS as formulas; a distinct operation kind and plan prefix. */
export const BASE_CONFIG_ATOMIC_PROFILE: AtomicResourceProfile = {
  operationKind: BASE_CONFIG_OPERATION_KIND,
  planRefPrefix: BASE_CONFIG_PLAN_REF_PREFIX,
  targetKind: "vault-obsidian-base-config",
  beforeProofKind: "base-yaml-sha256",
  afterProofKind: "atomic-base-config-patch-verified",
  backendKind: "obsidian-vault-process-base",
  requiredExtension: ".base",
  targetLabel: "vault-relative Obsidian Base file",
};

export type GovernedBaseConfigPlanInput = {
  path: string;
  operations: BaseConfigPatchOperation[];
  idempotencyKey: string;
};

export type GovernedBaseConfigReceipt = Omit<OperationReceipt, "idempotencyKey"> & {
  idempotencyKey?: string;
  projection: {
    kind: typeof BASE_CONFIG_OPERATION_KIND;
    intentDigest: string;
    sourcePreservation: BaseConfigPatchProof["sourcePreservation"];
    proof: BaseConfigPatchProof;
  };
};

function publicKey(value: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 256 || LONE_SURROGATE.test(value)) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR,
      "idempotencyKey must be non-empty, unpadded, and at most 256 characters.");
  }
  return value;
}

const internalKey = (value: string) =>
  INTERNAL_KEY_PREFIX + createHash("sha256").update(INTERNAL_KEY_DOMAIN + value, "utf8").digest("hex");

function operationId(reference: string): string {
  const value = reference.startsWith(BASE_CONFIG_PLAN_REF_PREFIX) ? reference.slice(BASE_CONFIG_PLAN_REF_PREFIX.length) : "";
  if (!z.string().uuid().safeParse(value).success) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR,
      "The plan reference does not belong to the governed Base configuration surface.", { reasonCode: "base_config_reference_invalid" });
  }
  return value;
}

function intent(path: string, operations: BaseConfigPatchOperation[]) {
  const canonical = canonicalizeBaseConfigPatchOperations(operations);
  return {
    operations: canonical,
    digest: operationDigest({ contractVersion: 1, operationKind: BASE_CONFIG_OPERATION_KIND, path, operations: canonical }),
  };
}

function projection(plan: ObsidianNoteReplacePlan, expectedPublicKey?: string, expectedIntentDigest?: string) {
  const parsed = StoredProjectionSchema.safeParse(plan.projection);
  if (!parsed.success || plan.idempotencyIdentity !== parsed.data.intentDigest ||
      (expectedPublicKey !== undefined && parsed.data.publicIdempotencyKey !== expectedPublicKey) ||
      (expectedIntentDigest !== undefined && parsed.data.intentDigest !== expectedIntentDigest)) {
    throw new McpError(BaseErrorCode.CONFLICT,
      "The durable plan is not bound to this governed Base configuration intent.", { reasonCode: "base_config_projection_conflict" });
  }
  return parsed.data;
}

function exposed(receipt: OperationReceipt, plan: ObsidianNoteReplacePlan, exposePublicKey: boolean): GovernedBaseConfigReceipt {
  const stored = projection(plan);
  const { idempotencyKey: _internal, ...redacted } = receipt;
  return {
    ...redacted,
    ...(exposePublicKey ? { idempotencyKey: stored.publicIdempotencyKey } : {}),
    planDigest: operationDigest({ contractVersion: 1, operationKind: BASE_CONFIG_OPERATION_KIND,
      atomicPlanDigest: receipt.planDigest, intentDigest: stored.intentDigest, proof: stored.proof }),
    projection: { kind: BASE_CONFIG_OPERATION_KIND, intentDigest: stored.intentDigest,
      sourcePreservation: stored.proof.sourcePreservation, proof: stored.proof },
  };
}

function assertPolicy(action: "plan" | "apply" | "recover", path: string, count: number, contentLength?: number): void {
  assertWriteAllowed({
    operation: action === "plan" ? "bases_config_patch_plan" : action === "recover" ? "bases_config_patch_recover" : "bases_config_patch_apply",
    action, target: path, targetType: "filePath", batchCount: count, contentLength,
  });
}

/** Whole-Base governed edits; shares the formula runtime's journal, lease and backend. */
export class GovernedBaseConfigRuntime {
  private readonly adapter: ObsidianNoteReplaceOperationAdapter;
  constructor(private readonly backend: RestBaseAtomicWriteBackend, private readonly journal: ObsidianNoteReplaceJournal) {
    this.adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal, BASE_CONFIG_ATOMIC_PROFILE);
  }

  async plan(input: GovernedBaseConfigPlanInput): Promise<GovernedBaseConfigReceipt> {
    const key = publicKey(input.idempotencyKey);
    const canonical = intent(input.path, input.operations);
    const durableKey = internalKey(key);
    assertPolicy("plan", input.path, canonical.operations.length);
    const existing = this.journal.getByIdempotencyKey(durableKey);
    if (existing) {
      projection(existing, key, canonical.digest);
      assertPolicy("plan", existing.path, canonical.operations.length, existing.nextContent.length);
      return exposed(await this.adapter.status(BASE_CONFIG_PLAN_REF_PREFIX + existing.operationId), existing, true);
    }
    const source = await this.backend.read({ contractVersion: 1, path: input.path });
    const compiled = compileBaseConfigPatch(source.content, canonical.operations);
    // Refuse before sealing: a proof the receipt schema rejects would strand the plan.
    if (!ProofSchema.safeParse(compiled.proof).success) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "The Base edit cannot be represented in a receipt.", { reasonCode: "base_config_value_invalid" });
    }
    assertPolicy("plan", input.path, canonical.operations.length, compiled.nextYaml.length);
    const storedProjection: ObsidianNoteReplaceProjection = {
      contractVersion: 1, kind: BASE_CONFIG_OPERATION_KIND, publicIdempotencyKey: key,
      intentDigest: canonical.digest, proof: compiled.proof as unknown as Record<string, unknown>,
    };
    const child = await this.adapter.plan({
      path: input.path, nextContent: compiled.nextYaml, idempotencyKey: durableKey,
      expectedBeforeSha256: source.sha256, expectedBindingFingerprint: source.bindingFingerprint,
      idempotencyIdentity: canonical.digest, projection: storedProjection,
    });
    const plan = this.required(child.planRef);
    projection(plan, key, canonical.digest);
    return exposed(child, plan, true);
  }

  async apply(reference: string, idempotencyKey: string) {
    const plan = this.required(reference);
    const stored = projection(plan, publicKey(idempotencyKey));
    assertPolicy("apply", plan.path, stored.proof.changedPaths.length, plan.nextContent.length);
    const result = await this.adapter.apply(reference, plan.idempotencyKey);
    return exposed(result, this.required(reference), true);
  }

  async status(reference: string) {
    projection(this.required(reference));
    const result = await this.adapter.status(reference);
    return exposed(result, this.required(reference), false);
  }

  async recover(reference: string, idempotencyKey: string) {
    const plan = this.required(reference);
    const stored = projection(plan, publicKey(idempotencyKey));
    assertPolicy("recover", plan.path, stored.proof.changedPaths.length, plan.nextContent.length);
    const result = await this.adapter.recover(reference, plan.idempotencyKey);
    return exposed(result, this.required(reference), true);
  }

  private required(reference: string): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationId(reference));
    if (!plan) {
      throw new McpError(BaseErrorCode.NOT_FOUND, "The governed Base configuration plan is unknown or has expired.",
        { reasonCode: "base_config_plan_not_found" });
    }
    return plan;
  }
}
