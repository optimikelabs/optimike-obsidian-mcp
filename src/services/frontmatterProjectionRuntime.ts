import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalizeFrontmatterPatchOperations,
  compileFrontmatterPatch,
  frontmatterCanonicalDigest,
  type FrontmatterPatchOperation,
  type FrontmatterPatchProof,
} from "./frontmatterPatchCompiler.js";
import {
  operationDigest,
  type OperationReceipt,
} from "./operations/contract.js";
import { assertWriteAllowed } from "./writePolicy.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import {
  PROJECTED_IDEMPOTENCY_KEY_PREFIX,
  type GovernedNoteReplacePlanView,
  type GovernedNoteReplaceRuntime,
} from "../mcp-server/tools/governedNoteReplaceTools/runtime.js";

const OPERATION_KIND = "obsidian.frontmatter.patch" as const;
const PUBLIC_PLAN_REF_PREFIX = "obsidian-frontmatter-patch:v1:";
const CHILD_PLAN_REF_PREFIX = "obsidian-note-replace:v1:";
const INTERNAL_KEY_DOMAIN = "obsidian.frontmatter.patch:v1\0";
const SHA256 = /^[a-f0-9]{64}$/u;

const AuthorizedRangeSchema = z.object({
  key: z.string().max(1024),
  operation: z.enum(["set", "delete"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  beforeSha256: z.string().regex(SHA256),
  afterSha256: z.string().regex(SHA256),
});

const FrontmatterPatchProofSchema = z.object({
  contractVersion: z.literal(1),
  compilerVersion: z.literal(1),
  sourcePreservation: z.literal(
    "byte-identical-outside-authorized-frontmatter-ranges",
  ),
  lineEnding: z.enum(["lf", "crlf"]),
  patchDigest: z.string().regex(SHA256),
  changedKeys: z.array(z.string().max(1024)).max(64),
  authorizedRanges: z.array(AuthorizedRangeSchema).max(64),
  bodySha256: z.string().regex(SHA256),
  beforeFrontmatterSha256: z.string().regex(SHA256),
  afterFrontmatterSha256: z.string().regex(SHA256),
  untouchedSourceSha256: z.string().regex(SHA256),
});

const StoredProjectionSchema = z.object({
  contractVersion: z.literal(1),
  kind: z.literal(OPERATION_KIND),
  publicIdempotencyKey: z.string().min(1).max(256),
  intentDigest: z.string().regex(SHA256),
  proof: FrontmatterPatchProofSchema,
});

type StoredProjection = z.infer<typeof StoredProjectionSchema>;

export type GovernedFrontmatterPlanInput = {
  path: string;
  operations: FrontmatterPatchOperation[];
  idempotencyKey: string;
};

export type FrontmatterProjectionReceipt = OperationReceipt & {
  projection: {
    kind: typeof OPERATION_KIND;
    intentDigest: string;
    sourcePreservation: FrontmatterPatchProof["sourcePreservation"];
    proof: FrontmatterPatchProof;
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
  if (
    !value ||
    value.trim() !== value ||
    value.length > 256 ||
    !wellFormed
  ) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "idempotencyKey must be a non-empty, unpadded, well-formed Unicode string of at most 256 characters.",
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
      "The plan reference does not belong to the governed frontmatter surface.",
    );
  }
  const operationId = reference.slice(prefix.length);
  if (!z.string().uuid().safeParse(operationId).success) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "The governed frontmatter plan reference is malformed.",
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

function canonicalIntent(
  path: string,
  operations: FrontmatterPatchOperation[],
): { operations: FrontmatterPatchOperation[]; intentDigest: string } {
  const canonicalOperations =
    canonicalizeFrontmatterPatchOperations(operations);
  return {
    operations: canonicalOperations,
    intentDigest: frontmatterCanonicalDigest({
      contractVersion: 1,
      operationKind: OPERATION_KIND,
      path,
      operations: canonicalOperations,
    }),
  };
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
      "The child plan was not admitted by the governed frontmatter projection.",
      { reason: "frontmatter_projection_missing_or_invalid" },
    );
  }
  if (
    view.idempotencyIdentity !== parsed.data.intentDigest ||
    (expectedPublicKey !== undefined &&
      parsed.data.publicIdempotencyKey !== expectedPublicKey) ||
    (expectedIntentDigest !== undefined &&
      parsed.data.intentDigest !== expectedIntentDigest)
  ) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "The public idempotency key is already bound to a different frontmatter intent.",
      { reason: "frontmatter_idempotency_conflict" },
    );
  }
  return parsed.data;
}

function assertDomainWritePolicy(
  action: "plan" | "apply" | "recover",
  view: Pick<GovernedNoteReplacePlanView, "path">,
  projection: Pick<StoredProjection, "proof">,
): void {
  assertWriteAllowed({
    operation:
      action === "plan"
        ? "obsidian_frontmatter_patch_plan"
        : action === "recover"
          ? "obsidian_frontmatter_patch_recover"
          : "obsidian_frontmatter_patch_apply",
    action,
    target: view.path,
    targetType: "filePath",
    batchCount: projection.proof.changedKeys.length,
    frontmatterKeys: projection.proof.changedKeys,
  });
}

function projectedReceipt(
  child: OperationReceipt,
  view: GovernedNoteReplacePlanView,
): FrontmatterProjectionReceipt {
  const projection = storedProjection(view);
  return {
    ...child,
    idempotencyKey: projection.publicIdempotencyKey,
    operationKind: OPERATION_KIND,
    planRef: publicReference(child.planRef),
    planDigest: operationDigest({
      contractVersion: 1,
      operationKind: OPERATION_KIND,
      childPlanDigest: child.planDigest,
      intentDigest: projection.intentDigest,
      proof: projection.proof,
    }),
    target: {
      kind: "vault-markdown-frontmatter",
      logicalRef: child.target.logicalRef,
    },
    ...(child.recoveryRef
      ? { recoveryRef: publicReference(child.recoveryRef) }
      : { recoveryRef: undefined }),
    projection: {
      kind: OPERATION_KIND,
      intentDigest: projection.intentDigest,
      sourcePreservation: projection.proof.sourcePreservation,
      proof: projection.proof,
    },
  };
}

export class GovernedFrontmatterRuntime {
  constructor(private readonly noteRuntime: GovernedNoteReplaceRuntime) {}

  async plan(
    input: GovernedFrontmatterPlanInput,
  ): Promise<FrontmatterProjectionReceipt> {
    const publicKey = normalizedPublicKey(input.idempotencyKey);
    const { operations, intentDigest } = canonicalIntent(
      input.path,
      input.operations,
    );
    const internalKey = internalIdempotencyKey(publicKey);
    assertWriteAllowed({
      operation: "obsidian_frontmatter_patch_plan",
      action: "plan",
      target: input.path,
      targetType: "filePath",
      batchCount: operations.length,
      frontmatterKeys: operations.map((operation) => operation.key),
    });
    const existing = this.noteRuntime.findPlanByIdempotencyKey(internalKey);
    if (existing) {
      storedProjection(existing, publicKey, intentDigest);
      const child = await this.noteRuntime.status(
        `${CHILD_PLAN_REF_PREFIX}${existing.operationId}`,
      );
      return projectedReceipt(child, this.noteRuntime.inspect(child.planRef));
    }

    const source = await this.noteRuntime.readForProjection(input.path);
    const compiled = compileFrontmatterPatch(source.content, operations);
    const projection: StoredProjection = {
      contractVersion: 1,
      kind: OPERATION_KIND,
      publicIdempotencyKey: publicKey,
      intentDigest,
      proof: compiled.proof,
    };
    const child = await this.noteRuntime.plan({
      path: input.path,
      nextContent: compiled.nextContent,
      idempotencyKey: internalKey,
      expectedBeforeSha256: source.sha256,
      expectedBindingFingerprint: source.bindingFingerprint,
      idempotencyIdentity: intentDigest,
      projection,
    });
    const view = this.noteRuntime.inspect(child.planRef);
    storedProjection(view, publicKey, intentDigest);
    return projectedReceipt(child, view);
  }

  async apply(
    reference: string,
    idempotencyKey: string,
  ): Promise<FrontmatterProjectionReceipt> {
    const publicKey = normalizedPublicKey(idempotencyKey);
    const childPlanRef = childReference(reference);
    const before = this.noteRuntime.inspect(childPlanRef);
    const projection = storedProjection(before, publicKey);
    assertDomainWritePolicy("apply", before, projection);
    const child = await this.noteRuntime.apply(
      childPlanRef,
      before.idempotencyKey,
    );
    return projectedReceipt(child, this.noteRuntime.inspect(child.planRef));
  }

  async status(reference: string): Promise<FrontmatterProjectionReceipt> {
    const childPlanRef = childReference(reference);
    storedProjection(this.noteRuntime.inspect(childPlanRef));
    const child = await this.noteRuntime.status(childPlanRef);
    return projectedReceipt(child, this.noteRuntime.inspect(child.planRef));
  }

  async recover(
    reference: string,
    idempotencyKey: string,
  ): Promise<FrontmatterProjectionReceipt> {
    const publicKey = normalizedPublicKey(idempotencyKey);
    const childPlanRef = childReference(reference);
    const before = this.noteRuntime.inspect(childPlanRef);
    const projection = storedProjection(before, publicKey);
    assertDomainWritePolicy("recover", before, projection);
    const child = await this.noteRuntime.recover(
      childPlanRef,
      before.idempotencyKey,
    );
    return projectedReceipt(child, this.noteRuntime.inspect(child.planRef));
  }
}
