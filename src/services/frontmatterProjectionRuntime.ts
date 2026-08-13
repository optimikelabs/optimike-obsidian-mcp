import { z } from "zod";
import {
  compileFrontmatterPatch,
  type FrontmatterPatchOperation,
  type FrontmatterPatchProof,
} from "./frontmatterPatchCompiler.js";
import { operationDigest, type OperationReceipt } from "./operations/contract.js";
import { assertWriteAllowed } from "./writePolicy.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { GovernedNoteReplaceRuntime } from "../mcp-server/tools/governedNoteReplaceTools/runtime.js";

const FRONTMATTER_PLAN_REF_PREFIX = "obsidian-frontmatter-patch:v1:";
const NOTE_PLAN_REF_PREFIX = "obsidian-note-replace:v1:";
const INTERNAL_IDEMPOTENCY_PREFIX = "fm1:";
const SHA256 = /^[a-f0-9]{64}$/u;

export type GovernedFrontmatterPlanInput = {
  path: string;
  operations: FrontmatterPatchOperation[];
  idempotencyKey: string;
};

export type FrontmatterProjectionReceipt = OperationReceipt & {
  projection: {
    kind: "obsidian.frontmatter.patch";
    intentDigest: string;
    sourcePreservation: "byte-identical-outside-target-frontmatter-entries";
    proof?: FrontmatterPatchProof;
  };
};

function operationIdFromRef(reference: string, prefix: string): string {
  if (!reference.startsWith(prefix)) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "The plan reference does not belong to the governed frontmatter patch surface.",
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

function publicPlanRef(childReference: string): string {
  return `${FRONTMATTER_PLAN_REF_PREFIX}${operationIdFromRef(childReference, NOTE_PLAN_REF_PREFIX)}`;
}

function childPlanRef(publicReference: string): string {
  return `${NOTE_PLAN_REF_PREFIX}${operationIdFromRef(publicReference, FRONTMATTER_PLAN_REF_PREFIX)}`;
}

function intentDigest(input: GovernedFrontmatterPlanInput): string {
  return operationDigest({
    operationKind: "obsidian.frontmatter.patch",
    path: input.path,
    operations: input.operations,
  });
}

function internalIdempotencyKey(publicKey: string, requestDigest: string): string {
  if (!publicKey.trim()) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "idempotencyKey is required.");
  }
  if (!SHA256.test(requestDigest)) throw new Error("Frontmatter intent digest is invalid.");
  return `${INTERNAL_IDEMPOTENCY_PREFIX}${publicKey}:${requestDigest}`;
}

function parseInternalIdempotencyKey(value: string): {
  publicKey: string;
  intentDigest: string;
} {
  if (!value.startsWith(INTERNAL_IDEMPOTENCY_PREFIX)) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "The sealed child plan was not admitted by the governed frontmatter surface.",
    );
  }
  const payload = value.slice(INTERNAL_IDEMPOTENCY_PREFIX.length);
  const separator = payload.lastIndexOf(":");
  if (separator <= 0) {
    throw new McpError(BaseErrorCode.CONFLICT, "The sealed frontmatter idempotency binding is malformed.");
  }
  const publicKey = payload.slice(0, separator);
  const digest = payload.slice(separator + 1);
  if (!publicKey || !SHA256.test(digest)) {
    throw new McpError(BaseErrorCode.CONFLICT, "The sealed frontmatter idempotency binding is malformed.");
  }
  return { publicKey, intentDigest: digest };
}

function projectReceipt(
  receipt: OperationReceipt,
  proof?: FrontmatterPatchProof,
): FrontmatterProjectionReceipt {
  const binding = parseInternalIdempotencyKey(receipt.idempotencyKey);
  return {
    ...receipt,
    idempotencyKey: binding.publicKey,
    operationKind: "obsidian.frontmatter.patch",
    planRef: publicPlanRef(receipt.planRef),
    target: {
      kind: "vault-markdown-frontmatter",
      logicalRef: receipt.target.logicalRef,
    },
    ...(receipt.recoveryRef ? { recoveryRef: publicPlanRef(receipt.recoveryRef) } : {}),
    projection: {
      kind: "obsidian.frontmatter.patch",
      intentDigest: binding.intentDigest,
      sourcePreservation: "byte-identical-outside-target-frontmatter-entries",
      ...(proof ? { proof } : {}),
    },
  };
}

export class GovernedFrontmatterRuntime {
  constructor(private readonly noteRuntime: GovernedNoteReplaceRuntime) {}

  async plan(input: GovernedFrontmatterPlanInput): Promise<FrontmatterProjectionReceipt> {
    const digest = intentDigest(input);
    const childIdempotencyKey = internalIdempotencyKey(input.idempotencyKey, digest);
    const existing = await this.noteRuntime.statusByIdempotencyKey(childIdempotencyKey);
    if (existing) return projectReceipt(existing);

    assertWriteAllowed({
      operation: "obsidian_frontmatter_patch_plan",
      action: "plan",
      target: input.path,
      targetType: "filePath",
      batchCount: input.operations.length,
      frontmatterKeys: input.operations.map((operation) => operation.key),
    });

    const source = await this.noteRuntime.readCurrent(input.path);
    const compiled = compileFrontmatterPatch(source.content, input.operations);
    const child = await this.noteRuntime.plan({
      path: input.path,
      nextContent: compiled.nextContent,
      idempotencyKey: childIdempotencyKey,
      expectedBeforeSha256: source.sha256,
    });
    return projectReceipt(child, compiled.proof);
  }

  async apply(reference: string, idempotencyKey: string): Promise<FrontmatterProjectionReceipt> {
    const childReference = childPlanRef(reference);
    const current = await this.noteRuntime.status(childReference);
    const binding = parseInternalIdempotencyKey(current.idempotencyKey);
    if (binding.publicKey !== idempotencyKey) {
      throw new McpError(BaseErrorCode.CONFLICT, "The idempotency key does not match the sealed frontmatter plan.");
    }
    return projectReceipt(await this.noteRuntime.apply(childReference, current.idempotencyKey));
  }

  async status(reference: string): Promise<FrontmatterProjectionReceipt> {
    return projectReceipt(await this.noteRuntime.status(childPlanRef(reference)));
  }

  async recover(reference: string, idempotencyKey: string): Promise<FrontmatterProjectionReceipt> {
    const childReference = childPlanRef(reference);
    const current = await this.noteRuntime.status(childReference);
    const binding = parseInternalIdempotencyKey(current.idempotencyKey);
    if (binding.publicKey !== idempotencyKey) {
      throw new McpError(BaseErrorCode.CONFLICT, "The idempotency key does not match the sealed frontmatter plan.");
    }
    return projectReceipt(await this.noteRuntime.recover(childReference, current.idempotencyKey));
  }
}
