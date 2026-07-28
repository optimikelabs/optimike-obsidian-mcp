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

function occurrenceMentionsSource(
  occurrence: ExternalReferenceOccurrence,
  rootId: string,
  relativePath: string,
  oldFileUri: string,
  sourceAbsolutePath: string,
): boolean {
  const samePhysicalPath =
    occurrence.fileLink &&
    path.normalize(occurrence.fileLink.localPath).toLowerCase() ===
      path.normalize(sourceAbsolutePath).toLowerCase();
  return (
    (occurrence.token?.rootId === rootId &&
      occurrence.token.relativePath === relativePath) ||
    occurrence.fileLink?.url === oldFileUri ||
    Boolean(samePhysicalPath)
  );
}

function replaceOccurrence(
  content: string,
  occurrence: ExternalReferenceOccurrence,
  sourceToken: string,
  targetToken: string,
  oldFileUri: string,
  newFileUri: string,
): string {
  const start = occurrence.containerRange.start.offset;
  const end = occurrence.containerRange.end.offset;
  const original = content.slice(start, end);
  const uriCount = original.split(oldFileUri).length - 1;
  const tokenCount = original.split(sourceToken).length - 1;
  if (uriCount !== 1 || tokenCount !== 1) {
    throw new ExternalRootError(
      "non_verifiable",
      "A canonical external reference is no longer uniquely repairable.",
    );
  }
  const replacement = original
    .replace(oldFileUri, newFileUri)
    .replace(sourceToken, targetToken);
  return content.slice(0, start) + replacement + content.slice(end);
}

function publicPlan(plan: ExternalMovePlan): Record<string, unknown> {
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
    repairs: plan.repairs.map((repair) => ({
      filePath: repair.filePath,
      expectedSha256: repair.expectedSha256,
    })),
    manualReview: plan.manualReview,
    readyToApply: plan.manualReview.length === 0,
    failure: plan.failure,
  };
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
    searchInPath = "",
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.roots.inspectMoveSource(rootId, relativePath);
    return this.inventory(snapshot, searchInPath);
  }

  async plan(input: {
    rootId: string;
    sourceRelativePath: string;
    targetRelativePath: string;
    searchInPath?: string;
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
    const inventory = await this.inventoryInternal(
      snapshot,
      input.searchInPath ?? "",
      locations.sourceFileUri,
      locations.targetFileUri,
      sourceToken,
      targetToken,
    );
    const plan = this.journal.create({
      idempotencyKey: input.idempotencyKey,
      snapshot,
      sourceToken,
      targetToken,
      oldFileUri: locations.sourceFileUri,
      newFileUri: locations.targetFileUri,
      repairs: inventory.repairs,
      manualReview: inventory.manualReview,
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
    const plan = this.requirePlan(planId, idempotencyKey);
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

    for (const repair of plan.repairs) {
      const current = await this.vault.read(repair.filePath);
      if (current.sha256 !== repair.expectedSha256) {
        throw new ExternalRootError(
          "precondition_failed",
          `ÉLYSIA note changed after planning: ${repair.filePath}`,
        );
      }
    }

    this.journal.transition(
      plan.planId,
      ["planned", "rolled_back"],
      "applying",
    );
    const appliedRepairs: ExternalNoteRepair[] = [];
    let fileMoved = false;
    try {
      await this.roots.applyMove(plan.snapshot);
      fileMoved = true;
      for (const repair of plan.repairs) {
        await this.vault.conditionalReplace(
          repair.filePath,
          repair.before,
          repair.after,
          repair.expectedSha256,
        );
        appliedRepairs.push(repair);
      }
      const committed = this.journal.update(plan.planId, "applied");
      return publicPlan(committed);
    } catch (error) {
      for (const repair of appliedRepairs.reverse()) {
        await this.rollbackNoteRepair(repair).catch(() => undefined);
      }
      if (fileMoved) {
        await this.roots.rollbackMove(plan.snapshot).catch(() => undefined);
      }
      this.journal.update(
        plan.planId,
        "failed",
        error instanceof Error ? error.message : "Apply failed.",
      );
      throw error;
    }
  }

  async rollback(
    planId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const plan = this.requirePlan(planId, idempotencyKey);
    if (plan.status === "rolled_back") return publicPlan(plan);
    if (plan.status !== "applied") {
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
    const rollbackContents = new Map<
      string,
      { current: string; restored: string }
    >();
    for (const repair of plan.repairs) {
      const current = await this.vault.read(repair.filePath);
      if (
        normalizeProtectedFrontmatter(current.content) !==
        normalizeProtectedFrontmatter(repair.after)
      ) {
        throw new ExternalRootError(
          "precondition_failed",
          `ÉLYSIA note changed after the move: ${repair.filePath}`,
        );
      }
      rollbackContents.set(repair.filePath, {
        current: current.content,
        restored: preserveCurrentProtectedFrontmatter(
          repair.before,
          current.content,
        ),
      });
    }
    this.journal.transition(plan.planId, ["applied"], "rolling_back");
    await this.roots.rollbackMove(plan.snapshot);
    for (const repair of [...plan.repairs].reverse()) {
      const rollback = rollbackContents.get(repair.filePath)!;
      await this.vault.conditionalReplace(
        repair.filePath,
        rollback.current,
        rollback.restored,
        sha256Text(rollback.current),
      );
    }
    return publicPlan(this.journal.update(plan.planId, "rolled_back"));
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

  private async rollbackNoteRepair(repair: ExternalNoteRepair): Promise<void> {
    const current = await this.vault.read(repair.filePath);
    if (
      normalizeProtectedFrontmatter(current.content) !==
      normalizeProtectedFrontmatter(repair.after)
    ) {
      throw new ExternalRootError(
        "precondition_failed",
        `ÉLYSIA note changed during rollback: ${repair.filePath}`,
      );
    }
    await this.vault.conditionalReplace(
      repair.filePath,
      current.content,
      preserveCurrentProtectedFrontmatter(repair.before, current.content),
      current.sha256,
    );
  }

  private async inventory(
    snapshot: ExternalMoveSnapshot,
    searchInPath: string,
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
      searchInPath,
      location.fileUri,
      location.fileUri,
      sourceToken,
      sourceToken,
    );
    return {
      rootId: snapshot.rootId,
      relativePath: snapshot.sourceRelativePath,
      sourceSha256: snapshot.sha256,
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
    searchInPath: string,
    oldFileUri: string,
    newFileUri: string,
    sourceToken: string,
    targetToken: string,
  ): Promise<{
    repairs: ExternalNoteRepair[];
    manualReview: Array<{ filePath: string; reason: string }>;
  }> {
    const location = await this.roots.getPrivateReferenceLocation(
      snapshot.rootId,
      snapshot.sourceRelativePath,
    );
    const candidatePaths = new Set<string>();
    for (const query of [
      sourceToken,
      oldFileUri,
      location.absolutePath,
      path.basename(location.absolutePath),
    ]) {
      for (const filePath of await this.vault.searchPaths(
        query,
        searchInPath,
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
            occurrence.fileLink?.url !== oldFileUri,
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
    return { repairs, manualReview };
  }
}
