import { createHash } from "node:crypto";
import path from "node:path";
import {
  ExternalRootError,
  type ExternalMoveSnapshot,
  ExternalRootsService,
} from "../externalRootsService.js";
import { assertWriteAllowed } from "../writePolicy.js";
import { config } from "../../config/index.js";
import { BackendVaultAdapter, sha256Text } from "./backendVaultAdapter.js";
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

function publicPlan(plan: ExternalMovePlan): Record<string, unknown> {
  const recoveryRequired =
    plan.status === "recovery_required" ||
    (plan.recoveryErrors?.length ?? 0) > 0;
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
    bindingFingerprint: plan.bindingIdentity?.bindingFingerprint,
    bindingVerifiable: plan.bindingIdentity?.verifiable ?? false,
    repairs: plan.repairs.map((repair) => ({
      filePath: repair.filePath,
      expectedSha256: repair.expectedSha256,
    })),
    manualReview: plan.manualReview,
    readyToApply: plan.manualReview.length === 0,
    recoveryRequired,
    recoveryErrors: plan.recoveryErrors ?? [],
    appliedRepairCount: plan.appliedRepairPaths?.length ?? 0,
    restoredRepairCount: plan.restoredRepairPaths?.length ?? 0,
    nextAction:
      plan.status === "planned" || plan.status === "rolled_back"
        ? "apply"
        : plan.status === "applied"
          ? "rollback"
          : plan.status === "failed_compensated"
            ? "rollback"
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
    failure: plan.failure,
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      return publicPlan(existing);
    }

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
    const bindingIdentity = await this.vault.getBindingIdentity(true);
    if (!bindingIdentity.verifiable) {
      throw new ExternalRootError(
        "non_verifiable",
        "External move planning requires a verifiable vault identity. Configure MCP_EXTERNAL_MOVE_PROFILE_ID.",
      );
    }
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
    return publicPlan(plan);
  }

  status(planId: string): Record<string, unknown> {
    const plan = this.journal.get(planId);
    if (!plan) {
      throw new ExternalRootError("not_found", "Unknown external move plan.");
    }
    return publicPlan(plan);
  }

  async apply(
    planId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    let plan = this.requirePlan(planId, idempotencyKey);
    if (plan.status === "applied") return publicPlan(plan);
    if (plan.status !== "planned" && plan.status !== "rolled_back") {
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
    await this.assertCurrentBinding(plan);

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
    await this.vault.refreshInventory();
    const currentInventory = await this.inventoryInternal(
      currentSnapshot,
      locations.sourceFileUri,
      locations.targetFileUri,
      plan.sourceToken,
      plan.targetToken,
    );
    if (inventoryDigest(currentInventory) !== plan.inventoryDigest) {
      throw new ExternalRootError(
        "precondition_failed",
        "The complete ÉLYSIA reference inventory changed after planning.",
      );
    }
    await this.vault.assertConditionalWritesSupported();

    plan = this.journal.transition(
      plan.planId,
      ["planned", "rolled_back"],
      "applying_file",
      {
        appliedRepairPaths: [],
        restoredRepairPaths: [],
        recoveryErrors: [],
      },
    );
    try {
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
        );
        plan = this.journal.recordAppliedRepair(plan.planId, repair.filePath);
      }
      const committed = this.journal.update(plan.planId, "applied");
      return publicPlan(committed);
    } catch (error) {
      const compensation = await this.compensateApply(plan.planId, error);
      if (compensation.length > 0) {
        throw new ExternalRootError(
          "non_verifiable",
          `External move apply failed and recovery is required: ${compensation.join(" | ")}`,
        );
      }
      if (error instanceof ExternalRootError) {
        throw new ExternalRootError(
          error.code,
          `${error.message} All partial effects were compensated and journaled.`,
        );
      }
      throw new Error(
        `${errorMessage(error)} All partial effects were compensated and journaled.`,
      );
    }
  }

  async rollback(
    planId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    let plan = this.requirePlan(planId, idempotencyKey);
    if (plan.status === "rolled_back") return publicPlan(plan);
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
    await this.assertCurrentBinding(plan);
    if (plan.status === "planned" || plan.status === "failed_compensated") {
      return publicPlan(
        this.journal.transition(plan.planId, [plan.status], "rolled_back", {
          recoveryErrors: [],
        }),
      );
    }
    await this.vault.assertConditionalWritesSupported();
    try {
      const placement = await this.inspectFilePlacement(plan.snapshot);
      if (placement === "both" || placement === "missing_or_changed") {
        throw new ExternalRootError(
          "non_verifiable",
          `External file placement is ${placement}; automatic rollback is unsafe.`,
        );
      }
      const rollbackContents = await this.prepareRollbackContents(plan);
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
          );
        }
        plan = this.journal.recordRestoredRepair(plan.planId, repair.filePath);
      }
      plan = this.journal.transition(
        plan.planId,
        ["rolling_back_repairs"],
        "rolling_back_file",
      );
      if ((await this.inspectFilePlacement(plan.snapshot)) === "target") {
        await this.roots.rollbackMove(plan.snapshot);
      }
      return publicPlan(this.journal.update(plan.planId, "rolled_back"));
    } catch (error) {
      const message = errorMessage(error);
      const current = this.journal.get(plan.planId) ?? plan;
      const partial = current.status !== "applied";
      this.journal.update(
        current.planId,
        partial ? "recovery_required" : current.status,
        message,
        { recoveryErrors: [message] },
      );
      throw error;
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

  private async assertCurrentBinding(plan: ExternalMovePlan): Promise<void> {
    if (!plan.bindingIdentity?.verifiable) {
      throw new ExternalRootError(
        "non_verifiable",
        "The move plan has no verifiable backend/vault/root binding.",
      );
    }
    const current = await this.vault.getBindingIdentity(true);
    if (
      !current.verifiable ||
      current.bindingFingerprint !== plan.bindingIdentity.bindingFingerprint
    ) {
      throw new ExternalRootError(
        "precondition_failed",
        "The backend, vault, or external-root configuration changed after planning.",
      );
    }
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
  ): Promise<Map<string, { current: string; restored: string }>> {
    const contents = new Map<string, { current: string; restored: string }>();
    for (const repair of plan.repairs) {
      const current = await this.vault.read(repair.filePath);
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
  ): Promise<string[]> {
    const errors: string[] = [];
    let plan = this.journal.get(planId);
    if (!plan) return ["The transaction journal entry disappeared."];
    try {
      const placement = await this.inspectFilePlacement(plan.snapshot);
      if (placement === "both" || placement === "missing_or_changed") {
        throw new Error(`External file placement is ${placement}.`);
      }
      const rollbackContents = await this.prepareRollbackContents(plan);
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
          );
        }
        plan = this.journal.recordRestoredRepair(plan.planId, repair.filePath);
      }
      plan = this.journal.transition(
        plan.planId,
        ["rolling_back_repairs"],
        "rolling_back_file",
      );
      if ((await this.inspectFilePlacement(plan.snapshot)) === "target") {
        await this.roots.rollbackMove(plan.snapshot);
      }
      this.journal.update(
        plan.planId,
        "failed_compensated",
        errorMessage(originalError),
        { recoveryErrors: [] },
      );
    } catch (compensationError) {
      errors.push(errorMessage(compensationError));
      const current = this.journal.get(planId);
      if (current) {
        this.journal.update(
          current.planId,
          "recovery_required",
          errorMessage(originalError),
          { recoveryErrors: errors },
        );
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
      )) {
        candidatePaths.add(filePath);
      }
    }

    const repairs: ExternalNoteRepair[] = [];
    const manualReview: Array<{ filePath: string; reason: string }> = [];
    for (const filePath of [...candidatePaths].sort((a, b) =>
      a.localeCompare(b),
    )) {
      const note = await this.vault.read(filePath);
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
            !samePhysicalPath(
              occurrence.fileLink.localPath,
              location.absolutePath,
            ),
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
