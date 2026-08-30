import { createHash } from "node:crypto";
import path from "node:path";
import {
  ExternalRootError,
  type ExternalMoveSnapshot,
  type ExternalRootErrorCode,
  ExternalRootsService,
} from "../externalRootsService.js";
import { assertWriteAllowed } from "../writePolicy.js";
import { config } from "../../config/index.js";
import {
  BackendVaultAdapter,
  BackendVaultSessionChangedError,
  type BackendVaultDestructiveSession,
  sha256Text,
} from "./backendVaultAdapter.js";
import {
  ExternalMoveJournal,
  type ExternalMovePlan,
  type ExternalNoteRepair,
} from "./externalMoveJournal.js";
import {
  encodeCanonicalExternalReference,
  scanCanonicalExternalReferences,
  type ExternalReferenceOccurrence,
} from "./canonicalReferenceParser.js";

export function externalReferenceToken(
  rootId: string,
  relativePath: string,
): string {
  return encodeCanonicalExternalReference(rootId, relativePath);
}

function samePhysicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function occurrenceMentionsSource(
  occurrence: ExternalReferenceOccurrence,
  rootId: string,
  relativePath: string,
  oldFileUri: string,
  sourceAbsolutePath: string,
): boolean {
  const physicalPathMatches =
    occurrence.fileLink &&
    samePhysicalPath(occurrence.fileLink.localPath, sourceAbsolutePath);
  return (
    (occurrence.token?.rootId === rootId &&
      occurrence.token.relativePath === relativePath) ||
    occurrence.fileLink?.url === oldFileUri ||
    Boolean(physicalPathMatches)
  );
}

function replaceOccurrence(
  content: string,
  occurrence: ExternalReferenceOccurrence,
  sourceToken: string,
  targetToken: string,
  _oldFileUri: string,
  newFileUri: string,
): string {
  const start = occurrence.containerRange.start.offset;
  const end = occurrence.containerRange.end.offset;
  const original = content.slice(start, end);
  const sourceFileUri = occurrence.fileLink?.url;
  if (!sourceFileUri) {
    throw new ExternalRootError(
      "non_verifiable",
      "A canonical external reference no longer has a file locator.",
    );
  }
  const uriCount = original.split(sourceFileUri).length - 1;
  const tokenCount = original.split(sourceToken).length - 1;
  if (uriCount !== 1 || tokenCount !== 1) {
    throw new ExternalRootError(
      "non_verifiable",
      "A canonical external reference is no longer uniquely repairable.",
    );
  }
  const replacement = original
    .replace(sourceFileUri, newFileUri)
    .replace(sourceToken, targetToken);
  return content.slice(0, start) + replacement + content.slice(end);
}

export function projectExternalMovePlanForStatus(
  plan: ExternalMovePlan,
): Record<string, unknown> {
  const recoveryErrors = safeRecoveryCodes(plan.recoveryErrors);
  const failureCode = safeStoredFailureCode(plan.failure);
  const recoveryRequired =
    plan.status === "recovery_required" || recoveryErrors.length > 0;
  const automaticRecoveryBlocked = recoveryErrors.includes(
    "backend_session_changed",
  );
  return {
    planId: plan.planId,
    idempotencyKey: plan.idempotencyKey,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    status: plan.status,
    rootId: plan.snapshot.rootId,
    sourceRelativePath: plan.snapshot.sourceRelativePath,
    targetRelativePath: plan.snapshot.targetRelativePath,
    sourceSha256: plan.snapshot.sha256,
    sourceSize: plan.snapshot.size,
    inventoryDigest: plan.inventoryDigest,
    bindingVerifiable: hasCurrentDestructiveBinding(plan),
    legacyBinding: !hasCurrentDestructiveBinding(plan),
    repairs: plan.repairs.map((repair) => ({
      filePath: repair.filePath,
      expectedSha256: repair.expectedSha256,
    })),
    manualReview: plan.manualReview,
    readyToApply: plan.manualReview.length === 0,
    recoveryRequired,
    recoveryErrors,
    appliedRepairCount: plan.appliedRepairPaths?.length ?? 0,
    restoredRepairCount: plan.restoredRepairPaths?.length ?? 0,
    nextAction:
      plan.status === "planned" || plan.status === "rolled_back"
        ? "apply"
        : plan.status === "applied"
          ? "rollback"
          : plan.status === "failed_compensated"
            ? "rollback"
            : automaticRecoveryBlocked
              ? "manual_review"
              : recoveryRequired ||
                  [
                    "applying",
                    "applying_file",
                    "file_moved",
                    "applying_repairs",
                    "rolling_back",
                    "rolling_back_repairs",
                    "rolling_back_file",
                    "failed",
                  ].includes(plan.status)
                ? "rollback"
                : "none",
    ...(failureCode
      ? {
          failureCode,
          failure: publicFailureMessage(failureCode),
        }
      : {}),
  };
}

/**
 * Journals written before backend vault attestation are intentionally
 * inspectable for incident recovery, but must never acquire a new target by
 * virtue of an upgrade. Destructive continuations require this exact schema.
 */
function hasCurrentDestructiveBinding(plan: ExternalMovePlan): boolean {
  return (
    plan.bindingIdentity?.schemaVersion === 2 &&
    plan.bindingIdentity.vaultIdentitySource ===
      "backend_destructive_vault_attestation" &&
    plan.bindingIdentity.verifiable === true &&
    typeof plan.destructiveSession?.sessionId === "string" &&
    Number.isSafeInteger(plan.destructiveSession.generation)
  );
}

type Inventory = {
  repairs: ExternalNoteRepair[];
  manualReview: Array<{ filePath: string; reason: string }>;
  candidatePaths: string[];
};

type FilePlacement = "source" | "target" | "both" | "missing_or_changed";

function inventoryDigest(inventory: Inventory): string {
  const payload = {
    candidatePaths: [...inventory.candidatePaths].sort((left, right) =>
      left.localeCompare(right),
    ),
    repairs: inventory.repairs
      .map((repair) => ({
        filePath: repair.filePath,
        expectedSha256: repair.expectedSha256,
        afterSha256: sha256Text(repair.after),
      }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath)),
    manualReview: inventory.manualReview
      .map((item) => ({ filePath: item.filePath, reason: item.reason }))
      .sort(
        (left, right) =>
          left.filePath.localeCompare(right.filePath) ||
          left.reason.localeCompare(right.reason),
      ),
  };
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function snapshotsMatch(
  left: ExternalMoveSnapshot,
  right: ExternalMoveSnapshot,
): boolean {
  return (
    left.rootId === right.rootId &&
    left.sourceRelativePath === right.sourceRelativePath &&
    left.targetRelativePath === right.targetRelativePath &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.sha256 === right.sha256
  );
}

type ExternalMoveFailureCode =
  | "backend_session_changed"
  | "backend_failure"
  | "compensation_failed"
  | "journal_missing"
  | `external_root_${ExternalRootErrorCode}`;

const EXTERNAL_ROOT_ERROR_CODES = [
  "configuration_invalid",
  "root_unknown",
  "root_unavailable",
  "capability_denied",
  "path_invalid",
  "path_outside_root",
  "path_not_allowed",
  "path_link_unsupported",
  "not_found",
  "not_a_file",
  "not_a_directory",
  "target_exists",
  "precondition_failed",
  "too_large",
  "unsupported",
  "encrypted",
  "inaccessible",
  "non_verifiable",
  "timeout",
] as const satisfies readonly ExternalRootErrorCode[];

type MissingExternalRootErrorCode = Exclude<
  ExternalRootErrorCode,
  (typeof EXTERNAL_ROOT_ERROR_CODES)[number]
>;
const EXTERNAL_ROOT_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  EXTERNAL_ROOT_ERROR_CODES.map((code) => `external_root_${code}`),
);
const EXTERNAL_ROOT_ERROR_CODES_ARE_EXHAUSTIVE: MissingExternalRootErrorCode extends never
  ? true
  : never = true;
void EXTERNAL_ROOT_ERROR_CODES_ARE_EXHAUSTIVE;

function failureCode(error: unknown): ExternalMoveFailureCode {
  if (error instanceof BackendVaultSessionChangedError) {
    return "backend_session_changed";
  }
  if (error instanceof ExternalRootError) {
    return `external_root_${error.code}`;
  }
  return "backend_failure";
}

function safeStoredFailureCode(
  value: unknown,
): ExternalMoveFailureCode | undefined {
  if (value === "backend_session_changed") return value;
  if (
    value === "backend_failure" ||
    value === "compensation_failed" ||
    value === "journal_missing"
  ) {
    return value;
  }
  if (
    typeof value === "string" &&
    EXTERNAL_ROOT_ERROR_CODE_SET.has(value)
  ) {
    return value as ExternalMoveFailureCode;
  }
  return undefined;
}

function safeRecoveryCodes(values: unknown): ExternalMoveFailureCode[] {
  if (!Array.isArray(values)) return [];
  const codes = values.map((value) => safeStoredFailureCode(value));
  return [
    ...new Set(
      codes.filter((value): value is ExternalMoveFailureCode => Boolean(value)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function publicFailureMessage(code: ExternalMoveFailureCode): string {
  if (code === "backend_session_changed") {
    return "The backend session changed after this move began. Automatic recovery is disabled; retain the plan for manual incident review.";
  }
  return "The external move did not complete. Review the stable failure code before retrying.";
}

function externalFailure(error: unknown): ExternalRootError {
  const code =
    error instanceof ExternalRootError ? error.code : "non_verifiable";
  return new ExternalRootError(
    code,
    "The external move did not complete. Review its durable status before retrying.",
  );
}

function needsSessionFence(status: ExternalMovePlan["status"]): boolean {
  return [
    "applying",
    "applying_file",
    "file_moved",
    "applying_repairs",
    "rolling_back",
    "rolling_back_repairs",
    "rolling_back_file",
    "failed",
  ].includes(status);
}

function protectedFrontmatterLines(content: string): Map<string, string> {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return new Map();
  const result = new Map<string, string>();
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") break;
    const match = /^(création|modification):(.*)$/u.exec(lines[index]);
    if (match) result.set(match[1], lines[index]);
  }
  return result;
}

function normalizeProtectedFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return content;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") break;
    if (/^(création|modification):/u.test(lines[index])) {
      lines.splice(index, 1);
      index -= 1;
    }
  }
  return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
}

function preserveCurrentProtectedFrontmatter(
  template: string,
  current: string,
): string {
  const currentLines = protectedFrontmatterLines(current);
  if (currentLines.size === 0) return template;
  const lines = template.split(/\r?\n/u);
  if (lines[0]?.replace(/^\uFEFF/u, "") !== "---") return template;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      for (const [key, value] of currentLines) {
        if (!lines.some((line) => line.startsWith(`${key}:`))) {
          lines.splice(index, 0, value);
          index += 1;
        }
      }
      break;
    }
    const match = /^(création|modification):/u.exec(lines[index]);
    if (match && currentLines.has(match[1])) {
      lines[index] = currentLines.get(match[1])!;
    }
  }
  return lines.join(template.includes("\r\n") ? "\r\n" : "\n");
}

export class ExternalMoveCoordinator {
  constructor(
    private readonly roots: ExternalRootsService,
    private readonly vault: BackendVaultAdapter,
    private readonly journal: ExternalMoveJournal,
  ) {}

  async scan(
    rootId: string,
    relativePath: string,
  ): Promise<Record<string, unknown>> {
    await this.vault.refreshInventory();
    const snapshot = await this.roots.inspectMoveSource(rootId, relativePath);
    return this.inventory(snapshot);
  }

  async plan(input: {
    rootId: string;
    sourceRelativePath: string;
    targetRelativePath: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const existing = this.journal.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      const sameRequest =
        existing.snapshot.rootId === input.rootId &&
        existing.snapshot.sourceRelativePath === input.sourceRelativePath &&
        existing.snapshot.targetRelativePath === input.targetRelativePath;
      if (!sameRequest) {
        throw new ExternalRootError(
          "precondition_failed",
          "The idempotency key is already bound to another external move.",
        );
      }
      return projectExternalMovePlanForStatus(existing);
    }

    // Re-attest before we inspect either mutable surface. A same-endpoint
    // backend swap must not be able to seal a new plan against Proxy A's root.
    const bindingIdentity = await this.vault.getBindingIdentity(true);
    if (!bindingIdentity.verifiable) {
      throw new ExternalRootError(
        "non_verifiable",
        "External move planning requires a verifiable backend vault target.",
      );
    }
    const destructiveSession =
      await this.vault.captureDestructiveSession(bindingIdentity);
    const snapshot = await this.roots.planMove(
      input.rootId,
      input.sourceRelativePath,
      input.targetRelativePath,
    );
    const locations = await this.roots.getPrivateMoveLocations(snapshot);
    const sourceToken = externalReferenceToken(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const targetToken = externalReferenceToken(
      snapshot.rootId,
      snapshot.targetRelativePath,
    );
    await this.vault.refreshInventory();
    const inventory = await this.inventoryInternal(
      snapshot,
      locations.sourceFileUri,
      locations.targetFileUri,
      sourceToken,
      targetToken,
    );
    const digest = inventoryDigest(inventory);
    const plan = this.journal.create({
      idempotencyKey: input.idempotencyKey,
      snapshot,
      bindingIdentity,
      destructiveSession,
      sourceToken,
      targetToken,
      oldFileUri: locations.sourceFileUri,
      newFileUri: locations.targetFileUri,
      repairs: inventory.repairs,
      manualReview: inventory.manualReview,
      inventoryDigest: digest,
      appliedRepairPaths: [],
      restoredRepairPaths: [],
      recoveryErrors: [],
    });
    return projectExternalMovePlanForStatus(plan);
  }

  status(planId: string): Record<string, unknown> {
    let plan = this.journal.get(planId);
    if (!plan) {
      throw new ExternalRootError("not_found", "Unknown external move plan.");
    }
    // A plan may survive a proxy restart in SQLite, but its private session
    // fence may not. Never advertise rollback against a replacement backend:
    // status itself converts that stale partial state into a durable,
    // fail-closed manual-review receipt before a caller can attempt recovery.
    if (
      needsSessionFence(plan.status) &&
      !this.vault.isDestructiveSessionCurrent(plan.destructiveSession)
    ) {
      plan = this.markRecoveryRequired(plan, "backend_session_changed");
    }
    return projectExternalMovePlanForStatus(plan);
  }

  async apply(
    planId: string,
    idempotencyKey: string,
    options: { allowCompensatedReapply?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    let plan = this.requirePlan(planId, idempotencyKey);
    if (plan.status === "applied")
      return projectExternalMovePlanForStatus(plan);
    const applicableStatuses: ExternalMovePlan["status"][] =
      options.allowCompensatedReapply === false
        ? ["planned"]
        : ["planned", "rolled_back"];
    if (!applicableStatuses.includes(plan.status)) {
      throw new ExternalRootError(
        "precondition_failed",
        `External move plan is ${plan.status}, not applicable.`,
      );
    }
    if (!config.externalMoveEnabled) {
      throw new ExternalRootError(
        "capability_denied",
        "External move apply is disabled by MCP_EXTERNAL_MOVE_ENABLED.",
      );
    }
    assertWriteAllowed({
      operation: "external_move_apply",
      action: "apply",
      destructive: true,
    });
    if (plan.manualReview.length > 0) {
      throw new ExternalRootError(
        "precondition_failed",
        "Ambiguous or historical references require manual review before apply.",
      );
    }

    if (!plan.inventoryDigest) {
      throw new ExternalRootError(
        "precondition_failed",
        "This plan predates inventory digests. Create a new plan with a new idempotency key.",
      );
    }
    const session = await this.openDestructiveSession(plan);

    const currentSnapshot = await this.roots.planMove(
      plan.snapshot.rootId,
      plan.snapshot.sourceRelativePath,
      plan.snapshot.targetRelativePath,
    );
    if (!snapshotsMatch(currentSnapshot, plan.snapshot)) {
      throw new ExternalRootError(
        "precondition_failed",
        "The external source changed after planning.",
      );
    }
    const locations = await this.roots.getPrivateMoveLocations(currentSnapshot);
    await this.vault.refreshInventory(session);
    const currentInventory = await this.inventoryInternal(
      currentSnapshot,
      locations.sourceFileUri,
      locations.targetFileUri,
      plan.sourceToken,
      plan.targetToken,
      session,
    );
    if (inventoryDigest(currentInventory) !== plan.inventoryDigest) {
      throw new ExternalRootError(
        "precondition_failed",
        "The complete ÉLYSIA reference inventory changed after planning.",
      );
    }
    await this.vault.assertConditionalWritesSupported(session);

    plan = this.journal.transition(
      plan.planId,
      applicableStatuses,
      "applying_file",
      {
        appliedRepairPaths: [],
        restoredRepairPaths: [],
        recoveryErrors: [],
      },
    );
    try {
      this.vault.assertDestructiveSession(session);
      await this.roots.applyMove(plan.snapshot);
      plan = this.journal.transition(
        plan.planId,
        ["applying_file"],
        "file_moved",
      );
      plan = this.journal.transition(
        plan.planId,
        ["file_moved"],
        "applying_repairs",
      );
      for (const repair of plan.repairs) {
        await this.vault.conditionalReplace(
          repair.filePath,
          repair.before,
          repair.after,
          repair.expectedSha256,
          session,
        );
        plan = this.journal.recordAppliedRepair(plan.planId, repair.filePath);
      }
      const committed = this.journal.update(plan.planId, "applied");
      return projectExternalMovePlanForStatus(committed);
    } catch (error) {
      const compensation = await this.compensateApply(
        plan.planId,
        error,
        session,
      );
      if (compensation.length > 0) {
        throw new ExternalRootError(
          "non_verifiable",
          "The external move requires manual incident review; automatic compensation was not completed.",
        );
      }
      throw externalFailure(error);
    }
  }

  async rollback(
    planId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    let plan = this.requirePlan(planId, idempotencyKey);
    if (plan.status === "rolled_back")
      return projectExternalMovePlanForStatus(plan);
    const recoverableStatuses: ExternalMovePlan["status"][] = [
      "planned",
      "failed_compensated",
      "applied",
      "applying",
      "applying_file",
      "file_moved",
      "applying_repairs",
      "rolling_back",
      "rolling_back_repairs",
      "rolling_back_file",
      "failed",
      "recovery_required",
    ];
    if (!recoverableStatuses.includes(plan.status)) {
      throw new ExternalRootError(
        "precondition_failed",
        `External move plan is ${plan.status}, not rollbackable.`,
      );
    }
    if (!config.externalMoveEnabled) {
      throw new ExternalRootError(
        "capability_denied",
        "External move rollback is disabled by MCP_EXTERNAL_MOVE_ENABLED.",
      );
    }
    assertWriteAllowed({
      operation: "external_move_rollback",
      action: "rollback",
      destructive: true,
    });
    const session = await this.openDestructiveSession(plan);
    if (plan.status === "planned" || plan.status === "failed_compensated") {
      return projectExternalMovePlanForStatus(
        this.journal.transition(plan.planId, [plan.status], "rolled_back", {
          recoveryErrors: [],
        }),
      );
    }
    await this.vault.assertConditionalWritesSupported(session);
    try {
      let placement = await this.inspectFilePlacement(plan.snapshot);
      if (placement === "both") {
        this.vault.assertDestructiveSession(session);
        await this.roots.recoverMoveToSource(plan.snapshot);
        placement = await this.inspectFilePlacement(plan.snapshot);
      }
      if (placement === "missing_or_changed" || placement === "both") {
        throw new ExternalRootError(
          "non_verifiable",
          `External file placement is ${placement}; automatic rollback is unsafe.`,
        );
      }
      const rollbackContents = await this.prepareRollbackContents(
        plan,
        session,
      );
      plan = this.journal.transition(
        plan.planId,
        recoverableStatuses,
        "rolling_back_repairs",
        { recoveryErrors: [] },
      );
      for (const repair of [...plan.repairs].reverse()) {
        const rollback = rollbackContents.get(repair.filePath);
        if (rollback) {
          await this.vault.conditionalReplace(
            repair.filePath,
            rollback.current,
            rollback.restored,
            sha256Text(rollback.current),
            session,
          );
        }
        plan = this.journal.recordRestoredRepair(plan.planId, repair.filePath);
      }
      plan = this.journal.transition(
        plan.planId,
        ["rolling_back_repairs"],
        "rolling_back_file",
      );
      this.vault.assertDestructiveSession(session);
      if ((await this.inspectFilePlacement(plan.snapshot)) === "target") {
        await this.roots.rollbackMove(plan.snapshot);
      }
      return projectExternalMovePlanForStatus(
        this.journal.update(plan.planId, "rolled_back"),
      );
    } catch (error) {
      const current = this.journal.get(plan.planId) ?? plan;
      const partial = current.status !== "applied";
      const code = failureCode(error);
      this.journal.update(
        current.planId,
        partial ? "recovery_required" : current.status,
        code,
        { recoveryErrors: [code] },
      );
      throw externalFailure(error);
    }
  }

  private requirePlan(
    planId: string,
    idempotencyKey: string,
  ): ExternalMovePlan {
    const plan = this.journal.get(planId);
    if (!plan || plan.idempotencyKey !== idempotencyKey) {
      throw new ExternalRootError(
        "precondition_failed",
        "External move plan and idempotency key do not match.",
      );
    }
    return plan;
  }

  private async openDestructiveSession(
    plan: ExternalMovePlan,
  ): Promise<BackendVaultDestructiveSession> {
    if (!hasCurrentDestructiveBinding(plan)) {
      throw new ExternalRootError(
        "non_verifiable",
        "This move plan predates authenticated backend vault binding. It remains available for status only; create a new plan instead of applying or rolling it back.",
      );
    }
    try {
      return await this.vault.openDestructiveSession(
        plan.bindingIdentity,
        plan.destructiveSession,
      );
    } catch (error) {
      if (error instanceof BackendVaultSessionChangedError) {
        const partial =
          needsSessionFence(plan.status) || plan.status === "recovery_required";
        if (needsSessionFence(plan.status)) {
          this.markRecoveryRequired(plan, "backend_session_changed");
        }
        throw new ExternalRootError(
          partial ? "non_verifiable" : "precondition_failed",
          "The backend session changed after planning. Automatic recovery is disabled; use the durable receipt for manual incident review.",
        );
      }
      if (error instanceof ExternalRootError) throw error;
      throw new ExternalRootError(
        "precondition_failed",
        "The backend session, vault, or external-root configuration changed after planning.",
      );
    }
  }

  private markRecoveryRequired(
    plan: ExternalMovePlan,
    code: ExternalMoveFailureCode,
  ): ExternalMovePlan {
    const current = this.journal.get(plan.planId) ?? plan;
    if (current.status === "recovery_required") return current;
    if (!needsSessionFence(current.status)) return current;
    return this.journal.update(current.planId, "recovery_required", code, {
      recoveryErrors: [...safeRecoveryCodes(current.recoveryErrors), code],
    });
  }

  private async inspectFilePlacement(
    snapshot: ExternalMoveSnapshot,
  ): Promise<FilePlacement> {
    const matches = async (
      relativePath: string,
      targetRelativePath: string,
    ): Promise<boolean> => {
      try {
        const current = await this.roots.inspectMoveSource(
          snapshot.rootId,
          relativePath,
          targetRelativePath,
        );
        return (
          current.size === snapshot.size && current.sha256 === snapshot.sha256
        );
      } catch (error) {
        if (error instanceof ExternalRootError && error.code === "not_found") {
          return false;
        }
        throw error;
      }
    };
    const source = await matches(
      snapshot.sourceRelativePath,
      snapshot.targetRelativePath,
    );
    const target = await matches(
      snapshot.targetRelativePath,
      snapshot.sourceRelativePath,
    );
    if (source && target) return "both";
    if (source) return "source";
    if (target) return "target";
    return "missing_or_changed";
  }

  private async prepareRollbackContents(
    plan: ExternalMovePlan,
    session: BackendVaultDestructiveSession,
  ): Promise<Map<string, { current: string; restored: string }>> {
    const contents = new Map<string, { current: string; restored: string }>();
    for (const repair of plan.repairs) {
      const current = await this.vault.read(repair.filePath, session);
      const normalized = normalizeProtectedFrontmatter(current.content);
      if (normalized === normalizeProtectedFrontmatter(repair.before)) {
        continue;
      }
      if (normalized !== normalizeProtectedFrontmatter(repair.after)) {
        throw new ExternalRootError(
          "precondition_failed",
          `ÉLYSIA note changed outside protected runtime frontmatter: ${repair.filePath}`,
        );
      }
      contents.set(repair.filePath, {
        current: current.content,
        restored: preserveCurrentProtectedFrontmatter(
          repair.before,
          current.content,
        ),
      });
    }
    return contents;
  }

  private async compensateApply(
    planId: string,
    originalError: unknown,
    session: BackendVaultDestructiveSession,
  ): Promise<string[]> {
    const errors: string[] = [];
    let plan = this.journal.get(planId);
    if (!plan) return ["journal_missing"];
    try {
      // Compensation is deliberately all-or-nothing with the originating
      // backend generation. A replacement connection must never repair or
      // roll back a vault it did not attest for this operation.
      this.vault.assertDestructiveSession(session);
      const placement = await this.inspectFilePlacement(plan.snapshot);
      if (placement === "both" || placement === "missing_or_changed") {
        throw new Error(`External file placement is ${placement}.`);
      }
      const rollbackContents = await this.prepareRollbackContents(
        plan,
        session,
      );
      plan = this.journal.transition(
        plan.planId,
        [plan.status],
        "rolling_back_repairs",
        { recoveryErrors: [] },
      );
      for (const repair of [...plan.repairs].reverse()) {
        const rollback = rollbackContents.get(repair.filePath);
        if (rollback) {
          await this.vault.conditionalReplace(
            repair.filePath,
            rollback.current,
            rollback.restored,
            sha256Text(rollback.current),
            session,
          );
        }
        plan = this.journal.recordRestoredRepair(plan.planId, repair.filePath);
      }
      plan = this.journal.transition(
        plan.planId,
        ["rolling_back_repairs"],
        "rolling_back_file",
      );
      this.vault.assertDestructiveSession(session);
      if ((await this.inspectFilePlacement(plan.snapshot)) === "target") {
        await this.roots.rollbackMove(plan.snapshot);
      }
      this.journal.update(
        plan.planId,
        "failed_compensated",
        failureCode(originalError),
        { recoveryErrors: [] },
      );
    } catch (compensationError) {
      errors.push(failureCode(compensationError));
      const current = this.journal.get(planId);
      if (current) {
        const originalCode = failureCode(originalError);
        this.journal.update(current.planId, "recovery_required", originalCode, {
          recoveryErrors: [
            ...safeRecoveryCodes(current.recoveryErrors),
            ...errors,
          ],
        });
      }
    }
    return errors;
  }

  private async inventory(
    snapshot: ExternalMoveSnapshot,
  ): Promise<Record<string, unknown>> {
    const location = await this.roots.getPrivateReferenceLocation(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const sourceToken = externalReferenceToken(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const inventory = await this.inventoryInternal(
      snapshot,
      location.fileUri,
      location.fileUri,
      sourceToken,
      sourceToken,
    );
    return {
      rootId: snapshot.rootId,
      relativePath: snapshot.sourceRelativePath,
      sourceSha256: snapshot.sha256,
      inventoryDigest: inventoryDigest(inventory),
      reparable: inventory.repairs.map((item) => ({
        filePath: item.filePath,
        expectedSha256: item.expectedSha256,
      })),
      manualReview: inventory.manualReview,
      completeForCanonicalContract: true,
    };
  }

  private async inventoryInternal(
    snapshot: ExternalMoveSnapshot,
    oldFileUri: string,
    newFileUri: string,
    sourceToken: string,
    targetToken: string,
    session?: BackendVaultDestructiveSession,
  ): Promise<Inventory> {
    const location = await this.roots.getPrivateReferenceLocation(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const candidatePaths = new Set<string>();
    for (const candidate of [
      { query: sourceToken, caseSensitive: true },
      { query: oldFileUri, caseSensitive: false },
      { query: location.absolutePath, caseSensitive: false },
      { query: path.basename(location.absolutePath), caseSensitive: false },
    ]) {
      for (const filePath of await this.vault.searchPaths(
        candidate.query,
        "",
        candidate.caseSensitive,
        session,
      )) {
        candidatePaths.add(filePath);
      }
    }

    const repairs: ExternalNoteRepair[] = [];
    const manualReview: Array<{ filePath: string; reason: string }> = [];
    for (const filePath of [...candidatePaths].sort((a, b) =>
      a.localeCompare(b),
    )) {
      const note = await this.vault.read(filePath, session);
      const scan = scanCanonicalExternalReferences(note.content);
      const mentioned = scan.occurrences.filter((occurrence) =>
        occurrenceMentionsSource(
          occurrence,
          snapshot.rootId,
          snapshot.sourceRelativePath,
          oldFileUri,
          location.absolutePath,
        ),
      );
      if (mentioned.length === 0) {
        if (
          note.content.includes(oldFileUri) ||
          note.content
            .toLowerCase()
            .includes(location.absolutePath.toLowerCase())
        ) {
          manualReview.push({
            filePath,
            reason:
              "Legacy or unsupported occurrence contains the physical path.",
          });
        }
        continue;
      }
      if (
        mentioned.some(
          (occurrence) =>
            occurrence.classification !== "reparable" ||
            occurrence.token?.rootId !== snapshot.rootId ||
            occurrence.token.relativePath !== snapshot.sourceRelativePath ||
            !occurrence.fileLink ||
            (occurrence.fileLink.url !== oldFileUri &&
              !samePhysicalPath(
                occurrence.fileLink.localPath,
                location.absolutePath,
              )),
        )
      ) {
        manualReview.push({
          filePath,
          reason:
            "Reference is ambiguous, historical, or not an exact canonical pair.",
        });
        continue;
      }
      let after = note.content;
      const descending = [...mentioned].sort(
        (a, b) => b.containerRange.start.offset - a.containerRange.start.offset,
      );
      for (const occurrence of descending) {
        after = replaceOccurrence(
          after,
          occurrence,
          sourceToken,
          targetToken,
          oldFileUri,
          newFileUri,
        );
      }
      repairs.push({
        filePath,
        expectedSha256: note.sha256,
        before: note.content,
        after,
      });
    }
    return {
      repairs,
      manualReview,
      candidatePaths: [...candidatePaths].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  }
}
