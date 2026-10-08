import type { SettlementCompletionMode } from "./operations/obsidianNoteReplaceOperationAdapter.js";
import { FrontmatterPatchProofSchema } from "./frontmatterProjectionRuntime.js";
import {
  compileFrontmatterPatch,
  canonicalizeFrontmatterPatchOperations,
  type FrontmatterPatchOperation,
  type FrontmatterPatchProof,
} from "./frontmatterPatchCompiler.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PROJECTED_IDEMPOTENCY_KEY_PREFIX,
  type GovernedNoteReplacePlanView,
  type GovernedNoteReplaceRuntime,
} from "../mcp-server/tools/governedNoteReplaceTools/runtime.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import {
  compileTextPatch,
  type TextPatchOperation,
  type TextPatchProof,
} from "./textPatchCompiler.js";
import {
  operationDigest,
  type OperationReceipt,
} from "./operations/contract.js";
import { assertWriteAllowed, type WriteOperation } from "./writePolicy.js";

const OPERATION_KIND = "obsidian.text.patch" as const;
const PUBLIC_PLAN_REF_PREFIX = "obsidian-text-patch:v1:";
const CHILD_PLAN_REF_PREFIX = "obsidian-note-replace:v1:";
const INTERNAL_KEY_DOMAIN = "obsidian.text.patch:v1\0";
const SHA256 = /^[a-f0-9]{64}$/u;

const TextPatchProofSchema = z.object({
  contractVersion: z.literal(1),
  compilerVersion: z.literal(1),
  sourcePreservation: z.literal(
    "byte-identical-outside-authorized-body-ranges",
  ),
  lineEnding: z.enum(["lf", "crlf", "mixed"]),
  patchDigest: z.string().regex(SHA256),
  operationCount: z.number().int().positive().max(32),
  authorizedRanges: z
    .array(
      z.object({
        operationIndex: z.number().int().nonnegative().max(31),
        coordinateSpace: z.literal("operation-input-content"),
        op: z.enum(["append_body", "prepend_body", "replace_literal"]),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        beforeSha256: z.string().regex(SHA256),
        afterSha256: z.string().regex(SHA256),
        stepBeforeBodySha256: z.string().regex(SHA256),
        stepAfterBodySha256: z.string().regex(SHA256),
        occurrenceCount: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(64),
  beforeContentSha256: z.string().regex(SHA256),
  nextContentSha256: z.string().regex(SHA256),
  beforeFrontmatterSha256: z.string().regex(SHA256),
  afterFrontmatterSha256: z.string().regex(SHA256),
  beforeBodySha256: z.string().regex(SHA256),
  afterBodySha256: z.string().regex(SHA256),
  preservedFrontmatterSha256: z.string().regex(SHA256),
});

const StoredProjectionSchema = z.object({
  contractVersion: z.literal(1),
  kind: z.literal(OPERATION_KIND),
  publicIdempotencyKey: z.string().min(1).max(256),
  intentDigest: z.string().regex(SHA256),
  proof: TextPatchProofSchema,
  frontmatterProof: FrontmatterPatchProofSchema.optional(),
  composition: z
    .object({
      frontmatterInput: z.literal("body-patch-output"),
      intermediateContentSha256: z.string().regex(SHA256),
      finalContentSha256: z.string().regex(SHA256),
    })
    .optional(),
  nextContentLength: z.number().int().nonnegative(),
});

type StoredProjection = z.infer<typeof StoredProjectionSchema>;

export type GovernedTextPatchPlanInput = {
  path: string;
  operations: TextPatchOperation[];
  frontmatterOperations?: FrontmatterPatchOperation[];
  idempotencyKey: string;
};

export type TextPatchProjectionReceipt = Omit<
  OperationReceipt,
  "idempotencyKey"
> & {
  idempotencyKey?: string;
  projection: {
    kind: typeof OPERATION_KIND;
    sourcePreservation:
      | TextPatchProof["sourcePreservation"]
      | "byte-identical-outside-authorized-body-and-frontmatter-ranges";
    frontmatterProof?: FrontmatterPatchProof;
    composition?: StoredProjection["composition"];
    proof: Omit<TextPatchProof, "patchDigest">;
  };
};

function normalizedPublicKey(value: string): string {
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
      { reason: "text_patch_idempotency_key_invalid" },
    );
  }
  return value;
}

function markdownPath(value: string): string {
  if (
    !value ||
    value.trim() !== value ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    !value.toLowerCase().endsWith(".md") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    value.split("/")[0]?.toLowerCase() === ".obsidian"
  ) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "path must be an unpadded vault-relative existing .md path using valid forward-slash segments.",
      { reason: "text_patch_path_invalid" },
    );
  }
  return value;
}

function internalIdempotencyKey(publicKey: string): string {
  const digest = createHash("sha256")
    .update(`${INTERNAL_KEY_DOMAIN}${publicKey}`, "utf8")
    .digest("hex");
  return `${PROJECTED_IDEMPOTENCY_KEY_PREFIX}${digest}`;
}

function operationIdFromRef(reference: string, prefix: string): string {
  if (!reference.startsWith(prefix)) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "The plan reference does not belong to the governed text patch surface.",
      { reason: "text_patch_plan_reference_invalid" },
    );
  }
  const operationId = reference.slice(prefix.length);
  if (!z.string().uuid().safeParse(operationId).success) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "The governed text patch plan reference is malformed.",
      { reason: "text_patch_plan_reference_malformed" },
    );
  }
  return operationId;
}

function childReference(publicReference: string): string {
  return `${CHILD_PLAN_REF_PREFIX}${operationIdFromRef(publicReference, PUBLIC_PLAN_REF_PREFIX)}`;
}

function publicReference(childPlanReference: string): string {
  return `${PUBLIC_PLAN_REF_PREFIX}${operationIdFromRef(childPlanReference, CHILD_PLAN_REF_PREFIX)}`;
}

function canonicalIntentOperations(
  operations: TextPatchOperation[],
): TextPatchOperation[] {
  return operations.map((operation) => {
    if (operation.op !== "replace_literal") return { ...operation };
    const occurrence = operation.occurrence ?? "unique";
    return {
      op: "replace_literal",
      search: operation.search,
      replacement: operation.replacement,
      occurrence,
      ...(operation.intent === "replace_all"
        ? { intent: "replace_all" as const }
        : {}),
    };
  });
}

function canonicalIntent(
  path: string,
  operations: TextPatchOperation[],
  frontmatterOperations?: FrontmatterPatchOperation[],
): string {
  return operationDigest({
    contractVersion: 1,
    operationKind: OPERATION_KIND,
    path,
    operations: canonicalIntentOperations(operations),
    ...(frontmatterOperations
      ? {
          frontmatterOperations: canonicalizeFrontmatterPatchOperations(
            frontmatterOperations,
          ),
        }
      : {}),
  });
}

function storedProjection(
  view: GovernedNoteReplacePlanView,
  expectedPublicKey?: string,
  expectedIntentDigest?: string,
): StoredProjection {
  const parsed = StoredProjectionSchema.safeParse(view.projection);
  if (!parsed.success) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "The child plan was not admitted by the governed text patch projection.",
      { reason: "text_patch_projection_missing_or_invalid" },
    );
  }
  const composed = parsed.data;
  if (
    Boolean(composed.frontmatterProof) !== Boolean(composed.composition) ||
    (composed.frontmatterProof &&
      composed.composition &&
      (composed.frontmatterProof.bodySha256 !==
        composed.proof.afterBodySha256 ||
        composed.composition.intermediateContentSha256 !==
          composed.proof.nextContentSha256 ||
        composed.composition.finalContentSha256 !== view.afterSha256 ||
        composed.proof.beforeContentSha256 !== view.beforeSha256))
  )
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "The combined source-preservation proof does not match its sealed child.",
      { reason: "text_patch_composition_invalid" },
    );
  if (
    view.idempotencyIdentity !== parsed.data.intentDigest ||
    (expectedPublicKey !== undefined &&
      parsed.data.publicIdempotencyKey !== expectedPublicKey) ||
    (expectedIntentDigest !== undefined &&
      parsed.data.intentDigest !== expectedIntentDigest)
  ) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "The public idempotency key is already bound to a different text patch intent.",
      { reason: "text_patch_idempotency_conflict" },
    );
  }
  return parsed.data;
}

function policyOperation(action: "plan" | "apply" | "recover"): WriteOperation {
  return action === "plan"
    ? "obsidian_text_patch_plan"
    : action === "apply"
      ? "obsidian_text_patch_apply"
      : "obsidian_text_patch_recover";
}

function assertDomainWritePolicy(
  action: "plan" | "apply" | "recover",
  view: Pick<GovernedNoteReplacePlanView, "path">,
  projection: Pick<
    StoredProjection,
    "proof" | "frontmatterProof" | "nextContentLength"
  >,
): void {
  assertWriteAllowed({
    operation: policyOperation(action),
    action,
    target: view.path,
    targetType: "filePath",
    batchCount: projection.proof.operationCount,
    contentLength: projection.nextContentLength,
  });
  if (projection.frontmatterProof) {
    assertWriteAllowed({
      operation:
        action === "plan"
          ? "obsidian_frontmatter_patch_plan"
          : action === "apply"
            ? "obsidian_frontmatter_patch_apply"
            : "obsidian_frontmatter_patch_recover",
      action,
      target: view.path,
      targetType: "filePath",
      batchCount: projection.frontmatterProof.changedKeys.length,
      frontmatterKeys: projection.frontmatterProof.changedKeys,
    });
  }
}

function projectedReceipt(
  child: OperationReceipt,
  view: GovernedNoteReplacePlanView,
  exposePublicIdempotencyKey: boolean,
): TextPatchProjectionReceipt {
  const projection = storedProjection(view);
  const { idempotencyKey: childIdempotencyKey, ...redactedChild } = child;
  const { patchDigest: privatePatchDigest, ...publicProof } = projection.proof;
  void childIdempotencyKey;
  void privatePatchDigest;
  return {
    ...redactedChild,
    ...(exposePublicIdempotencyKey
      ? { idempotencyKey: projection.publicIdempotencyKey }
      : {}),
    operationKind: OPERATION_KIND,
    planRef: publicReference(child.planRef),
    planDigest: operationDigest({
      contractVersion: 1,
      operationKind: OPERATION_KIND,
      childPlanDigest: child.planDigest,
      intentDigest: projection.intentDigest,
      proof: projection.proof,
      ...(projection.frontmatterProof
        ? {
            frontmatterProof: projection.frontmatterProof,
            composition: projection.composition,
          }
        : {}),
    }),
    target: {
      kind: projection.frontmatterProof
        ? "vault-markdown-body-and-frontmatter"
        : "vault-markdown-text-body",
      logicalRef: child.target.logicalRef,
    },
    ...(child.recoveryRef
      ? { recoveryRef: publicReference(child.recoveryRef) }
      : { recoveryRef: undefined }),
    projection: {
      kind: OPERATION_KIND,
      sourcePreservation: projection.frontmatterProof
        ? "byte-identical-outside-authorized-body-and-frontmatter-ranges"
        : projection.proof.sourcePreservation,
      ...(projection.frontmatterProof
        ? {
            frontmatterProof: projection.frontmatterProof,
            composition: projection.composition,
          }
        : {}),
      proof: publicProof,
    },
  };
}

export class GovernedTextPatchRuntime {
  constructor(private readonly noteRuntime: GovernedNoteReplaceRuntime) {}

  private async replayExisting(
    internalKey: string,
    publicKey: string,
    intentDigest: string,
  ): Promise<TextPatchProjectionReceipt | undefined> {
    const existing = this.noteRuntime.findPlanByIdempotencyKey(internalKey);
    if (!existing) return undefined;
    const projection = storedProjection(existing, publicKey, intentDigest);
    assertDomainWritePolicy("plan", existing, projection);
    const child = await this.noteRuntime.status(
      `${CHILD_PLAN_REF_PREFIX}${existing.operationId}`,
    );
    return projectedReceipt(
      child,
      this.noteRuntime.inspect(child.planRef),
      true,
    );
  }

  async plan(
    input: GovernedTextPatchPlanInput,
  ): Promise<TextPatchProjectionReceipt> {
    const path = markdownPath(input.path);
    const publicKey = normalizedPublicKey(input.idempotencyKey);
    const internalKey = internalIdempotencyKey(publicKey);
    const requestedIntentDigest = canonicalIntent(
      path,
      input.operations,
      input.frontmatterOperations,
    );
    const replay = await this.replayExisting(
      internalKey,
      publicKey,
      requestedIntentDigest,
    );
    if (replay) return replay;

    const source = await this.noteRuntime.readForProjection(path);
    let compiled;
    let frontmatter;
    try {
      compiled = compileTextPatch(source.content, input.operations, path);
      if (input.frontmatterOperations) {
        assertWriteAllowed({
          operation: "obsidian_frontmatter_patch_plan",
          action: "plan",
          target: path,
          targetType: "filePath",
          batchCount: input.frontmatterOperations.length,
          frontmatterKeys: input.frontmatterOperations.map(
            (operation) => operation.key,
          ),
        });
        frontmatter = compileFrontmatterPatch(
          compiled.nextContent,
          input.frontmatterOperations,
        );
      }
    } catch (error) {
      const concurrentWinner = await this.replayExisting(
        internalKey,
        publicKey,
        requestedIntentDigest,
      );
      if (concurrentWinner) return concurrentWinner;
      throw error;
    }
    const intentDigest = canonicalIntent(
      path,
      compiled.operations,
      frontmatter?.operations,
    );
    const nextContent = frontmatter?.nextContent ?? compiled.nextContent;
    const projection: StoredProjection = {
      contractVersion: 1,
      kind: OPERATION_KIND,
      publicIdempotencyKey: publicKey,
      intentDigest,
      proof: compiled.proof,
      ...(frontmatter
        ? {
            frontmatterProof: frontmatter.proof,
            composition: {
              frontmatterInput: "body-patch-output" as const,
              intermediateContentSha256: compiled.proof.nextContentSha256,
              finalContentSha256: createHash("sha256")
                .update(nextContent, "utf8")
                .digest("hex"),
            },
          }
        : {}),
      nextContentLength: nextContent.length,
    };
    assertDomainWritePolicy("plan", { path }, projection);
    const child = await this.noteRuntime.plan({
      path,
      nextContent,
      idempotencyKey: internalKey,
      expectedBeforeSha256: source.sha256,
      expectedBindingFingerprint: source.bindingFingerprint,
      idempotencyIdentity: intentDigest,
      projection,
    });
    const view = this.noteRuntime.inspect(child.planRef);
    storedProjection(view, publicKey, intentDigest);
    return projectedReceipt(child, view, true);
  }

  async apply(
    reference: string,
    idempotencyKey: string,
    completionMode: SettlementCompletionMode = "deferred",
  ): Promise<TextPatchProjectionReceipt> {
    const publicKey = normalizedPublicKey(idempotencyKey);
    const childPlanRef = childReference(reference);
    const before = this.noteRuntime.inspect(childPlanRef);
    const projection = storedProjection(before, publicKey);
    assertDomainWritePolicy("apply", before, projection);
    const child = await this.noteRuntime.apply(
      childPlanRef,
      before.idempotencyKey,
      completionMode,
    );
    return projectedReceipt(
      child,
      this.noteRuntime.inspect(child.planRef),
      true,
    );
  }

  async status(reference: string): Promise<TextPatchProjectionReceipt> {
    const childPlanRef = childReference(reference);
    storedProjection(this.noteRuntime.inspect(childPlanRef));
    const child = await this.noteRuntime.status(childPlanRef);
    return projectedReceipt(
      child,
      this.noteRuntime.inspect(child.planRef),
      false,
    );
  }

  async recover(
    reference: string,
    idempotencyKey: string,
    completionMode: SettlementCompletionMode = "deferred",
  ): Promise<TextPatchProjectionReceipt> {
    const publicKey = normalizedPublicKey(idempotencyKey);
    const childPlanRef = childReference(reference);
    const before = this.noteRuntime.inspect(childPlanRef);
    const projection = storedProjection(before, publicKey);
    assertDomainWritePolicy("recover", before, projection);
    const child = await this.noteRuntime.recover(
      childPlanRef,
      before.idempotencyKey,
      completionMode,
    );
    return projectedReceipt(
      child,
      this.noteRuntime.inspect(child.planRef),
      true,
    );
  }
}
