import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import { z } from "zod";
import { config } from "../../../config/index.js";
import { validateObsidianMarkdown } from "../../../services/obsidianFormatService.js";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import {
  type AtomicWriteBackend,
  ObsidianNoteReplaceOperationAdapter,
  type ObsidianNoteReplacePlanInput,
} from "../../../services/operations/obsidianNoteReplaceOperationAdapter.js";
import {
  ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
} from "../../../services/operations/obsidianNoteReplaceJournal.js";
import { RestAtomicWriteBackend } from "../../../services/operations/restAtomicWriteBackend.js";
import type { OperationReceipt } from "../../../services/operations/contract.js";
import {
  assertWriteAllowed,
  type WriteOperation,
} from "../../../services/writePolicy.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, requestContextService } from "../../../utils/index.js";

const PLAN_REF_PREFIX = "obsidian-note-replace:v1:";
export const PROJECTED_IDEMPOTENCY_KEY_PREFIX = "optimike:projection:v1:";

type CallContext =
  | { kind: "plan"; path: string; nextContent: string }
  | { kind: "apply" | "recover" };

type FrontmatterRecord = Record<string, unknown>;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseFrontmatter(content: string): FrontmatterRecord {
  const lines = content.split("\n");
  const line = (index: number): string =>
    (lines[index] ?? "").endsWith("\r")
      ? (lines[index] ?? "").slice(0, -1)
      : (lines[index] ?? "");
  if (line(0) !== "---") return {};

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (line(index) === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) {
    throw new Error("Frontmatter opening delimiter has no closing delimiter.");
  }

  const parsed = load(lines.slice(1, end).join("\n"));
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter must be a YAML object.");
  }
  return parsed as FrontmatterRecord;
}

function entriesForKey(
  frontmatter: FrontmatterRecord,
  normalizedKey: string,
): Array<{ key: string; value: unknown }> {
  return Object.entries(frontmatter)
    .filter(([key]) => normalizeKey(key) === normalizedKey)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

function changedProtectedKeys(
  currentContent: string,
  nextContent: string,
): string[] {
  const protectedKeys = [
    ...new Set(config.mcpProtectedFrontmatterKeys.map(normalizeKey)),
  ].filter(Boolean);
  if (protectedKeys.length === 0) return [];

  const current = parseFrontmatter(currentContent);
  const next = parseFrontmatter(nextContent);
  return protectedKeys.filter(
    (key) =>
      !isDeepStrictEqual(entriesForKey(current, key), entriesForKey(next, key)),
  );
}

function policyOperation(kind: "plan" | "apply" | "recover"): WriteOperation {
  if (kind === "plan") return "obsidian_note_replace_plan";
  if (kind === "recover") return "obsidian_note_replace_recover";
  return "obsidian_note_replace_apply";
}

function assertCurrentWritePolicy(
  kind: "plan" | "apply" | "recover",
  path: string,
  nextContent: string,
): void {
  assertWriteAllowed({
    operation: policyOperation(kind),
    action: kind,
    target: path,
    targetType: "filePath",
    contentLength: nextContent.length,
  });
}

function validateReplacement(
  currentContent: string,
  nextContent: string,
  phase: "plan" | "effect",
): void {
  let validation: ReturnType<typeof validateObsidianMarkdown>;
  try {
    validation = validateObsidianMarkdown(nextContent);
  } catch {
    throw new McpError(
      phase === "plan"
        ? BaseErrorCode.VALIDATION_ERROR
        : BaseErrorCode.FORBIDDEN,
      "The sealed next content is not valid conservative Obsidian Markdown.",
      { reason: "markdown_validation_failed" },
    );
  }
  if (!validation.ok) {
    throw new McpError(
      phase === "plan"
        ? BaseErrorCode.VALIDATION_ERROR
        : BaseErrorCode.FORBIDDEN,
      "The sealed next content is not valid conservative Obsidian Markdown.",
      {
        validationErrors: validation.errors.map(({ code, path }) => ({
          code,
          path,
        })),
      },
    );
  }

  let changed: string[];
  try {
    changed = changedProtectedKeys(currentContent, nextContent);
  } catch (error) {
    throw new McpError(
      phase === "plan"
        ? BaseErrorCode.VALIDATION_ERROR
        : BaseErrorCode.FORBIDDEN,
      "Protected frontmatter cannot be compared safely because the YAML structure is invalid.",
      {
        reason:
          error instanceof Error
            ? "frontmatter_parse_failed"
            : "frontmatter_parse_failed_unknown",
      },
    );
  }
  if (changed.length > 0) {
    throw new McpError(
      BaseErrorCode.FORBIDDEN,
      `Atomic note replacement cannot modify protected frontmatter keys: ${changed.join(", ")}`,
      { protectedKeys: changed },
    );
  }
}

class GovernedAtomicWriteBackend implements AtomicWriteBackend {
  private readonly callContext = new AsyncLocalStorage<CallContext>();

  constructor(private readonly delegate: AtomicWriteBackend) {}

  withContext<T>(
    context: CallContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.callContext.run(context, operation);
  }

  status() {
    return this.delegate.status();
  }

  async read(payload: Parameters<AtomicWriteBackend["read"]>[0]) {
    const result = await this.delegate.read(payload);
    const context = this.callContext.getStore();
    if (context?.kind === "plan") {
      if (context.path !== payload.path) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "The planning read target differs from the requested note target.",
        );
      }
      assertCurrentWritePolicy("plan", payload.path, context.nextContent);
      validateReplacement(result.content, context.nextContent, "plan");
    }
    return result;
  }

  async replace(payload: Parameters<AtomicWriteBackend["replace"]>[0]) {
    const context = this.callContext.getStore();
    if (!context || context.kind === "plan") {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Atomic note replacement requires an active governed apply or recover context.",
      );
    }

    assertCurrentWritePolicy(context.kind, payload.path, payload.nextContent);
    const current = await this.delegate.read({
      contractVersion: 1,
      path: payload.path,
    });
    if (
      current.path !== payload.path ||
      current.bindingFingerprint !== payload.bindingFingerprint
    ) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "The atomic-write backend identity or target changed before the effect.",
      );
    }
    if (current.sha256 !== payload.expectedSha256) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "The note changed after the sealed plan was admitted.",
      );
    }
    validateReplacement(current.content, payload.nextContent, "effect");
    return this.delegate.replace(payload);
  }
}

function operationIdFromRef(reference: string): string {
  if (!reference.startsWith(PLAN_REF_PREFIX)) {
    throw new Error(
      "The plan reference is not an obsidian.note.replace V1 plan.",
    );
  }
  const operationId = reference.slice(PLAN_REF_PREFIX.length);
  if (!z.string().uuid().safeParse(operationId).success) {
    throw new Error("The note-replacement plan reference is malformed.");
  }
  return operationId;
}

export type GovernedNoteReplacePlanView = {
  operationId: string;
  idempotencyKey: string;
  idempotencyIdentity?: string;
  path: string;
  beforeSha256: string;
  afterSha256: string;
  bindingFingerprint: string;
  status: ObsidianNoteReplacePlan["status"];
  projection?: ObsidianNoteReplacePlan["projection"];
};

export class GovernedNoteReplaceRuntime {
  private closed = false;
  private readonly leaseHeartbeat: NodeJS.Timeout;
  private leaseRenewalFailureReported = false;

  constructor(
    private readonly backend: GovernedAtomicWriteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly adapter: ObsidianNoteReplaceOperationAdapter,
    leaseHeartbeatMs = 5_000,
    private readonly vaultCacheService?: VaultCacheService,
  ) {
    this.leaseHeartbeat = setInterval(() => {
      try {
        this.journal.renewExecutionLease();
        this.leaseRenewalFailureReported = false;
      } catch (error) {
        if (this.leaseRenewalFailureReported) return;
        this.leaseRenewalFailureReported = true;
        logger.warning(
          `Governed note-replacement lease renewal failed; the runtime will retry: ${error instanceof Error ? error.message : String(error)}`,
          requestContextService.createRequestContext({
            operation: "governedNoteReplaceLeaseRenewal",
          }),
        );
      }
    }, leaseHeartbeatMs);
    this.leaseHeartbeat.unref();
  }

  readForProjection(path: string) {
    return this.backend.read({ contractVersion: 1, path });
  }

  findPlanByIdempotencyKey(
    idempotencyKey: string,
  ): GovernedNoteReplacePlanView | undefined {
    const plan = this.journal.getByIdempotencyKey(idempotencyKey);
    return plan ? this.view(plan) : undefined;
  }

  inspect(reference: string): GovernedNoteReplacePlanView {
    return this.view(this.required(reference));
  }

  plan(input: ObsidianNoteReplacePlanInput): Promise<OperationReceipt> {
    assertCurrentWritePolicy("plan", input.path, input.nextContent);
    return this.backend.withContext(
      { kind: "plan", path: input.path, nextContent: input.nextContent },
      () => this.adapter.plan(input),
    );
  }

  async apply(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    const plan = this.required(reference);
    if (plan.status === "planned") {
      assertCurrentWritePolicy("apply", plan.path, plan.nextContent);
    }
    const operation = this.backend.withContext({ kind: "apply" }, () =>
      this.adapter.apply(reference, idempotencyKey),
    );
    return this.refreshCacheAfterCommit(plan, operation);
  }

  planPublicDirect(
    input: ObsidianNoteReplacePlanInput,
  ): Promise<OperationReceipt> {
    if (input.idempotencyKey.startsWith(PROJECTED_IDEMPOTENCY_KEY_PREFIX)) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "The idempotency key uses a namespace reserved for internal projections.",
        { reason: "reserved_projection_idempotency_namespace" },
      );
    }
    return this.plan(input);
  }

  async applyPublicDirectPlan(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    this.requiredPublicDirectPlan(reference);
    return this.apply(reference, idempotencyKey);
  }

  async status(reference: string): Promise<OperationReceipt> {
    const plan = this.required(reference);
    return this.refreshCacheAfterCommit(plan, this.adapter.status(reference));
  }

  async statusPublicDirectPlan(reference: string): Promise<OperationReceipt> {
    this.requiredPublicDirectPlan(reference);
    return this.status(reference);
  }

  async recover(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    const plan = this.required(reference);
    if (plan.status === "outcome_unknown") {
      assertCurrentWritePolicy("recover", plan.path, plan.nextContent);
    }
    const operation = this.backend.withContext({ kind: "recover" }, () =>
      this.adapter.recover(reference, idempotencyKey),
    );
    return this.refreshCacheAfterCommit(plan, operation);
  }

  async recoverPublicDirectPlan(
    reference: string,
    idempotencyKey: string,
  ): Promise<OperationReceipt> {
    this.requiredPublicDirectPlan(reference);
    return this.recover(reference, idempotencyKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.leaseHeartbeat);
    this.journal.close();
  }

  private required(reference: string): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationIdFromRef(reference));
    if (!plan) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "The note-replacement operation plan is unknown or has expired.",
        { reason: "note_replace_plan_not_found" },
      );
    }
    return plan;
  }

  private requiredPublicDirectPlan(
    reference: string,
  ): ObsidianNoteReplacePlan {
    const plan = this.required(reference);
    if (plan.projection) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "The note-replacement operation plan is unknown or has expired.",
        { reason: "note_replace_plan_not_found" },
      );
    }
    return plan;
  }

  private view(plan: ObsidianNoteReplacePlan): GovernedNoteReplacePlanView {
    return {
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      ...(plan.idempotencyIdentity
        ? { idempotencyIdentity: plan.idempotencyIdentity }
        : {}),
      path: plan.path,
      beforeSha256: plan.beforeSha256,
      afterSha256: plan.afterSha256,
      bindingFingerprint: plan.bindingFingerprint,
      status: plan.status,
      ...(plan.projection
        ? { projection: structuredClone(plan.projection) }
        : {}),
    };
  }

  private async refreshCacheAfterCommit(
    plan: ObsidianNoteReplacePlan,
    operation: Promise<OperationReceipt>,
  ): Promise<OperationReceipt> {
    const result = await operation;
    if (result.outcome !== "committed" || !this.vaultCacheService) {
      return result;
    }

    const context = requestContextService.createRequestContext({
      operation: "governedNoteReplaceCacheRefresh",
      operationId: result.operationId,
      filePath: plan.path,
    });
    try {
      await this.vaultCacheService.updateCacheForFile(plan.path, context);
    } catch (error) {
      logger.warning(
        `Background cache refresh failed for '${plan.path}': ${error instanceof Error ? error.message : String(error)}`,
        context,
      );
    }
    return result;
  }
}

export function createGovernedNoteReplaceRuntime(
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService?: VaultCacheService,
): GovernedNoteReplaceRuntime | undefined {
  if (!obsidianService) return undefined;

  const journal = new ObsidianNoteReplaceJournal(
    config.obsidianNoteReplaceJournalPath,
    { executionLeaseMs: config.obsidianNoteReplaceExecutionLeaseMs },
  );
  const backend = new GovernedAtomicWriteBackend(
    new RestAtomicWriteBackend(obsidianService),
  );
  const adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal);
  const runtime = new GovernedNoteReplaceRuntime(
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
    vaultCacheService,
  );

  // The application lifecycle closes the runtime explicitly. This synchronous
  // exit hook is a final fail-safe for startup paths that terminate through
  // process.exit before graceful shutdown can run.
  process.once("exit", () => runtime.close());
  return runtime;
}
