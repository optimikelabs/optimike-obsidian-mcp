import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../config/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { logger, requestContextService } from "../utils/index.js";
import {
  canonicalizeCanvasPatchOperations,
  compileCanvasPatch,
  type CanvasPatchOperation,
  type CanvasPatchProof,
} from "./canvasPatchCompiler.js";
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
} from "./operations/obsidianNoteReplaceJournal.js";
import { RestCanvasAtomicWriteBackend } from "./operations/restCanvasAtomicWriteBackend.js";
import { assertWriteAllowed } from "./writePolicy.js";

const OPERATION_KIND = "obsidian.canvas.patch" as const;
const PLAN_REF_PREFIX = "obsidian-canvas-patch:v1:";
const INTERNAL_KEY_PREFIX = "optimike:canvas-projection:v1:";
const INTERNAL_KEY_DOMAIN = "obsidian.canvas.patch:v1\0";
const SHA256 = /^[a-f0-9]{64}$/u;

const CanvasPatchProofSchema = z.object({
  contractVersion: z.literal(1),
  compilerVersion: z.literal(1),
  sourcePreservation: z.literal(
    "unknown-json-values-preserved-outside-authorized-canvas-entities",
  ),
  lineEnding: z.enum(["lf", "crlf"]),
  patchDigest: z.string().regex(SHA256),
  changedNodes: z.array(z.string().min(1).max(256)).max(64),
  changedEdges: z.array(z.string().min(1).max(256)).max(128),
  removedIncidentEdges: z.array(z.string().min(1).max(256)).max(128),
  rootUnknownBeforeSha256: z.string().regex(SHA256),
  rootUnknownAfterSha256: z.string().regex(SHA256),
  untouchedEntitiesBeforeSha256: z.string().regex(SHA256),
  untouchedEntitiesAfterSha256: z.string().regex(SHA256),
  graphBefore: z.object({
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
  }),
  graphAfter: z.object({
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
  }),
});

const StoredProjectionSchema = z.object({
  contractVersion: z.literal(1),
  kind: z.literal(OPERATION_KIND),
  publicIdempotencyKey: z.string().min(1).max(256),
  intentDigest: z.string().regex(SHA256),
  proof: CanvasPatchProofSchema,
});

export const CANVAS_ATOMIC_PROFILE: AtomicResourceProfile = {
  operationKind: OPERATION_KIND,
  planRefPrefix: PLAN_REF_PREFIX,
  targetKind: "vault-obsidian-canvas",
  beforeProofKind: "canvas-json-sha256",
  afterProofKind: "atomic-canvas-graph-patch-verified",
  backendKind: "obsidian-vault-process-canvas",
  requiredExtension: ".canvas",
  targetLabel: "Canvas file",
};

export type GovernedCanvasPlanInput = {
  path: string;
  operations: CanvasPatchOperation[];
  idempotencyKey: string;
};

export type GovernedCanvasReceipt = Omit<OperationReceipt, "idempotencyKey"> & {
  idempotencyKey?: string;
  projection: {
    kind: typeof OPERATION_KIND;
    intentDigest: string;
    sourcePreservation: CanvasPatchProof["sourcePreservation"];
    proof: CanvasPatchProof;
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
      "idempotencyKey must be a non-empty, unpadded, well-formed Unicode string of at most 256 characters.",
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
      "The plan reference does not belong to the governed Canvas surface.",
    );
  }
  const value = reference.slice(PLAN_REF_PREFIX.length);
  if (!z.string().uuid().safeParse(value).success) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "The governed Canvas plan reference is malformed.",
    );
  }
  return value;
}

function intent(path: string, operations: CanvasPatchOperation[]) {
  const canonical = canonicalizeCanvasPatchOperations(operations);
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
  proof: CanvasPatchProof;
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
      "The durable plan is not bound to this governed Canvas intent.",
      { reason: "canvas_projection_conflict" },
    );
  }
  return parsed.data as ObsidianNoteReplaceProjection & {
    kind: typeof OPERATION_KIND;
    proof: CanvasPatchProof;
  };
}

function exposed(
  receipt: OperationReceipt,
  plan: ObsidianNoteReplacePlan,
  exposePublicKey: boolean,
): GovernedCanvasReceipt {
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
        ? "obsidian_canvas_patch_plan"
        : action === "recover"
          ? "obsidian_canvas_patch_recover"
          : "obsidian_canvas_patch_apply",
    action,
    target: path,
    targetType: "filePath",
    batchCount: count,
    contentLength,
  });
}

export class GovernedCanvasRuntime {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly backend: RestCanvasAtomicWriteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly adapter: ObsidianNoteReplaceOperationAdapter,
    heartbeatMs: number,
  ) {
    this.heartbeat = setInterval(() => {
      try {
        this.journal.renewExecutionLease();
      } catch (error) {
        logger.warning(
          `Governed Canvas lease renewal failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
          requestContextService.createRequestContext({
            operation: "governedCanvasLeaseRenewal",
          }),
        );
      }
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  async plan(input: GovernedCanvasPlanInput): Promise<GovernedCanvasReceipt> {
    const key = publicKey(input.idempotencyKey);
    const canonical = intent(input.path, input.operations);
    const durableKey = internalKey(key);
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
    const compiled = compileCanvasPatch(source.content, canonical.operations);
    assertPolicy(
      "plan",
      input.path,
      canonical.operations.length,
      compiled.nextContent.length,
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
      nextContent: compiled.nextContent,
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
      stored.proof.changedNodes.length + stored.proof.changedEdges.length,
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
      stored.proof.changedNodes.length + stored.proof.changedEdges.length,
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
        "The governed Canvas plan is unknown or has expired.",
        { reason: "canvas_plan_not_found" },
      );
    }
    return plan;
  }
}

export function createGovernedCanvasRuntime(
  service: ObsidianRestApiService | undefined,
): GovernedCanvasRuntime | undefined {
  if (!service) return undefined;
  const journal = new ObsidianNoteReplaceJournal(
    config.obsidianCanvasJournalPath,
    {
      executionLeaseMs: config.obsidianNoteReplaceExecutionLeaseMs,
    },
  );
  const backend = new RestCanvasAtomicWriteBackend(service);
  const adapter = new ObsidianNoteReplaceOperationAdapter(
    backend,
    journal,
    CANVAS_ATOMIC_PROFILE,
  );
  const runtime = new GovernedCanvasRuntime(
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
