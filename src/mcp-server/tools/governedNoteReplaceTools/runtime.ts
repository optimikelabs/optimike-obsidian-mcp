import { measureGovernedPhase } from "../../../services/governedResponse.js";
import { AssetImportOperationAdapter } from "../../../services/assets/assetImportOperation.js";
import { runAssetJob } from "../../../services/assets/workerClient.js";
import type { AssetInspection } from "../../../services/assets/assetImportContract.js";
import {
  ImageProcessingError,
  probeImageProcessingDependencies,
} from "../../../services/assets/imageProcessing.js";
import {
  AssetFileError,
  WindowsAssetFiles,
  type AssetFileReason,
} from "../../../services/assets/windowsAssetFiles.js";
import {
  NoteCreateOperationAdapter,
  type NoteCreateBackend,
} from "../../../services/operations/noteCreateOperationAdapter.js";
import { RestNoteCreateBackend } from "../../../services/operations/restNoteCreateBackend.js";
import {
  NativeNoteMoveOperationAdapter,
  type NativeNoteMoveBackend,
} from "../../../services/operations/nativeNoteMoveOperationAdapter.js";
import { RestNativeNoteMoveBackend } from "../../../services/operations/restNativeNoteMoveBackend.js";
import type { SettlementCompletionMode } from "../../../services/operations/obsidianNoteReplaceOperationAdapter.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import { operationDigest } from "../../../services/operations/contract.js";
import { compileFrontmatterPatch, nativeFrontmatterPatchKeys, type FrontmatterPatchOperation } from "../../../services/frontmatterPatchCompiler.js";
import { DatePreparationPlanFailure, frontmatterEnvelope, inspectNativeFrontmatter, rejectNonCanonical } from "../../../services/obsidianFrontmatterFormat.js";
import { z } from "zod";
import { config } from "../../../config/index.js";
import { validateObsidianMarkdown } from "../../../services/obsidianFormatService.js";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import {
  type AtomicWriteBackend,
  markAtomicWritePreDispatchError,
  effectiveAtomicWriteDateProtection,
  effectiveAtomicWriteProtectedFrontmatterKeys,
  ObsidianNoteReplaceOperationAdapter,
  type ObsidianNoteReplacePlanInput,
} from "../../../services/operations/obsidianNoteReplaceOperationAdapter.js";
import {
  ObsidianNoteReplaceJournal,
  type ObsidianNoteReplacePlan,
  type PendingOperationRowsInput,
  type PendingOperationRowsPage,
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
  | {
      kind: "plan";
      path: string;
      nextContent: string;
      requireNativeFormat?: boolean;
      atomicWriteStatus?: unknown;
    }
  | { kind: "apply" | "recover"; path: string; requireNativeFormat?: boolean; atomicWriteStatus?: unknown };

type FrontmatterRecord = Record<string, unknown>;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function assertSupportedMarkdownEnvelope(
  content: string,
  phase: "plan" | "effect",
): void {
  const reason = content.startsWith("\uFEFF")
    ? "markdown_bom_unsupported"
    : /\r(?!\n)/u.test(content)
      ? "markdown_line_ending_unsupported"
      : undefined;
  if (!reason) return;

  throw new McpError(
    phase === "plan" ? BaseErrorCode.VALIDATION_ERROR : BaseErrorCode.FORBIDDEN,
    "The sealed note uses an unsupported Markdown encoding or line ending.",
    { reason },
  );
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

/** Compare the actual preparation against the native serialization of the
 * original, allowing only the manager's simple date lines and its already
 * reported editor line-ending conversion. */
function preparationNonDateBytes(content: string, dateKeys: readonly string[], allowLineEndingConversion: boolean): string {
  const envelope = frontmatterEnvelope(content);
  if (!envelope) return `\0${allowLineEndingConversion ? content.replace(/\r\n/g, "\n") : content}`;
  const body = content.slice(envelope.end + 3).replace(/^\r?\n/u, "");
  const names = new Set(dateKeys.map(normalizeKey));
  const kept: string[] = [];
  for (const line of envelope.yaml.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    const key = /^([^\s:#][^:]*):(?:\s*(.*))?$/u.exec(clean);
    if (key && names.has(normalizeKey(key[1]))) {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(key[2] ?? "");
      const parts = match?.slice(1).map(part => Number(part ?? "0"));
      const candidate = parts && new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
      if (!parts || !candidate || candidate.getUTCFullYear() !== parts[0] || candidate.getUTCMonth() !== parts[1] - 1 ||
          candidate.getUTCDate() !== parts[2] || candidate.getUTCHours() !== parts[3] || candidate.getUTCMinutes() !== parts[4] || candidate.getUTCSeconds() !== parts[5])
        throw new McpError(BaseErrorCode.CONFLICT, "The date preparation produced an unsupported date line.", { reason: "date_preparation_unqualified" });
      continue;
    }
    kept.push(line);
  }
  const yaml = kept.join("\n");
  const comparable = `${yaml}\0${body}`;
  return allowLineEndingConversion ? comparable.replace(/\r\n/g, "\n") : comparable;
}

function preparationDelimiters(content: string, allowLineEndingConversion: boolean): string | undefined {
  const envelope = frontmatterEnvelope(content);
  if (!envelope) return undefined;
  const opening = content.slice(0, envelope.start);
  const ending = /^(---(?:\r?\n|$))/u.exec(content.slice(envelope.end))?.[1] ?? "";
  const result = opening + "\0" + ending;
  return allowLineEndingConversion ? result.replace(/\r\n/g, "\n") : result;
}

function preparationDateValue(content: string, name: string): string | undefined {
  const yaml = frontmatterEnvelope(content)?.yaml ?? "";
  const values = yaml.split(/\r?\n/u).flatMap(line => {
    const match = /^([^\s:#][^:]*):(?:\s*(.*))?$/u.exec(line);
    return match && normalizeKey(match[1]) === normalizeKey(name) ? [match[2] ?? ""] : [];
  });
  if (values.length > 1) throw new Error("duplicate_date");
  return values[0];
}

function preparationDateInWindow(value: string, start: number, end: number, offsetMinutes: number): boolean {
  const local = (ms: number) => new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const length = value.length === 16 ? 16 : 19;
  return value.length === length && value >= local(start).slice(0, length) && value <= local(end).slice(0, length);
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
  effectiveProtectedKeys: readonly string[] = config.mcpProtectedFrontmatterKeys,
): string[] {
  const protectedKeys = [
    ...new Set(effectiveProtectedKeys.map(normalizeKey)),
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
  effectiveProtectedKeys: readonly string[] = config.mcpProtectedFrontmatterKeys,
  dateProtection: ReturnType<typeof effectiveAtomicWriteDateProtection> = {
    createdPropertyNames: [],
    unsupportedModifiedPropertyNames: [],
    unsupportedIntegrations: [],
  },
): void {
  // Frontmatter and settlement comparisons are line-structural. Reject inputs
  // that those parsers cannot interpret unambiguously before any policy or CAS
  // decision, even when the configured protected-key set happens to be empty.
  assertSupportedMarkdownEnvelope(currentContent, phase);
  assertSupportedMarkdownEnvelope(nextContent, phase);

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
    if (dateProtection.unsupportedIntegrations.length > 0) {
      const summaries = dateProtection.unsupportedIntegrations.map(
        ({ pluginId, activeRoles }) =>
          `${pluginId} (${activeRoles.join(", ")})`,
      );
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Atomic note replacement cannot safely represent active date-property settings for: ${summaries.join("; ")}`,
        {
          reason: "unsupported_date_property_configuration",
          unsupportedDatePluginConfigurations:
            dateProtection.unsupportedIntegrations,
        },
      );
    }
    const currentFrontmatter = parseFrontmatter(currentContent);
    const missingCreated = dateProtection.createdPropertyNames.filter(
      (key) =>
        entriesForKey(currentFrontmatter, normalizeKey(key)).length !== 1,
    );
    if (missingCreated.length > 0) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Cette note n'a pas encore de date de création. Ouvrez-la dans Obsidian et enregistrez-la une fois, puis réessayez.",
        {
          reasonCode: "atomic_write_creation_property_missing",
          missingCreatedProperties: missingCreated,
        },
      );
    }
    if (dateProtection.unsupportedModifiedPropertyNames.length > 0) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Atomic note replacement cannot safely settle the active modified-time configuration for: ${dateProtection.unsupportedModifiedPropertyNames.join(", ")}`,
        {
          unsupportedModifiedProperties:
            dateProtection.unsupportedModifiedPropertyNames,
        },
      );
    }
    changed = changedProtectedKeys(
      currentContent,
      nextContent,
      effectiveProtectedKeys,
    );
  } catch (error) {
    if (error instanceof McpError) throw error;
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
  private readonly preparationFences = new WeakMap<object, { key: string; attempt: string }>();

  constructor(private readonly delegate: AtomicWriteBackend, private readonly journal: ObsidianNoteReplaceJournal) {}

  withContext<T>(
    context: CallContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.callContext.run(context, operation);
  }

  async status() {
    let status = await measureGovernedPhase("bridgeStatus", () => this.delegate.status());
    const context = this.callContext.getStore();
    if (context) {
      const scope = await this.delegate.read({ contractVersion: 1, path: context.path });
      if (scope.dateManagement?.managed === false) status = { ...status, protection: undefined, settlement: undefined };
    }
    if (context) context.atomicWriteStatus = status;
    return status;
  }

  inspectFrontmatterFormat(yaml: string) {
    if (!this.delegate.inspectFrontmatterFormat) throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Native frontmatter format inspection is unavailable.", { reasonCode: "frontmatter_format_capability_missing" });
    return this.delegate.inspectFrontmatterFormat(yaml);
  }

  async read(payload: Parameters<AtomicWriteBackend["read"]>[0]) {
    const result = await measureGovernedPhase("noteRead", () => this.delegate.read(payload));
    const context = this.callContext.getStore();
    if (context?.kind === "plan") {
      if (context.path !== payload.path) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "The planning read target differs from the requested note target.",
        );
      }
      assertCurrentWritePolicy("plan", payload.path, context.nextContent);
      if (!context.atomicWriteStatus) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Atomic-write status was not sealed before validating protected frontmatter.",
          { reason: "atomic_write_status_not_sealed" },
        );
      }
      const comparison = context.requireNativeFormat ? (await inspectNativeFrontmatter(this.delegate, result.content, result.bindingFingerprint)).content : result.content;
      validateReplacement(
        comparison,
        context.nextContent,
        "plan",
        effectiveAtomicWriteProtectedFrontmatterKeys(
          context.atomicWriteStatus,
          config.mcpProtectedFrontmatterKeys,
        ),
        result.dateManagement?.managed === false ? undefined : effectiveAtomicWriteDateProtection(context.atomicWriteStatus),
      );
    }
    return result;
  }

  async prepareForPlan(path: string, expectedSource?: { sha256: string; bindingFingerprint: string }, requireNativeFormat = false) {
    const source = await this.delegate.read({ contractVersion: 1, path });
    if (source.path !== path || source.sha256 !== createHash("sha256").update(source.content, "utf8").digest("hex") ||
        source.size !== Buffer.byteLength(source.content, "utf8"))
      throw new McpError(BaseErrorCode.CONFLICT, "The planning read could not be verified.", { reason: "note_source_proof_invalid" });
    const fenceKey = operationDigest({ domain: "obsidian-date-preparation-v1", path, bindingFingerprint: source.bindingFingerprint });
    const unverified = () => new McpError(BaseErrorCode.CONFLICT,
      "La préparation des dates a pu modifier ou normaliser la note. Une revue administrative est nécessaire avant reprise.",
      { reasonCode: "date_preparation_unverified", mutationMayHaveApplied: true });
    if (this.journal.hasDatePreparationFence(fenceKey)) throw unverified();
    if (expectedSource && (source.sha256 !== expectedSource.sha256 || source.bindingFingerprint !== expectedSource.bindingFingerprint))
      throw new McpError(BaseErrorCode.CONFLICT, "The note changed before date preparation.");
    const originalFormat = requireNativeFormat ? await inspectNativeFrontmatter(this.delegate, source.content, source.bindingFingerprint) : undefined;
    if (source.dateManagement?.managed === false) return { ...source, datePreparation: { kind: "outside-date-management" as const, message: "Note hors gestion des dates." } };
    const status = await this.delegate.status();
    const protection = effectiveAtomicWriteDateProtection(status);
    const created = [...new Set([...protection.createdPropertyNames,
      ...(protection.createdPropertyNames.length || !status.datePreparation?.supported ? [] : config.mcpProtectedFrontmatterKeys.filter(key => /^(création|creation|created)$/iu.test(key)))])];
    const fm = parseFrontmatter(source.content);
    if (!created.some(key => entriesForKey(fm, normalizeKey(key)).length === 0)) return source;
    if (requireNativeFormat && frontmatterEnvelope(originalFormat!.content)?.yaml.trim() === "{}")
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "An empty frontmatter mapping cannot be verified with automatic dates.", { reasonCode: "frontmatter_empty_mapping_date_management" });
    assertCurrentWritePolicy("plan", path, source.content);
    const fail = () => new McpError(BaseErrorCode.FORBIDDEN,
      "Cette note n'a pas encore de date de création. Ouvrez-la dans Obsidian et enregistrez-la une fois, puis réessayez.",
      { reasonCode: "atomic_write_creation_property_missing" });
    const offset = status.settlement?.modifiedTimeFrontmatter.utcOffsetMinutes;
    if (!status.backend.writeEnabled || !this.delegate.prepareDate || protection.unsupportedIntegrations.length || !protection.createdPropertyNames.length ||
        !Number.isInteger(offset) || Math.abs(offset!) > 840) throw fail();
    let prepared;
    const attempt = this.journal.acquireDatePreparationFence(fenceKey);
    if (!attempt) throw unverified();
    const dispatchedAt = Date.now();
    try {
      prepared = await this.delegate.prepareDate({ contractVersion: 1, path, expectedSha256: source.sha256, bindingFingerprint: source.bindingFingerprint });
    } catch { throw unverified(); }
    if (prepared.datePreparation?.kind !== "date-manager-before-plan") throw unverified();
    // Seal only a fresh read, never the preparation response or the old projection.
    let current;
    try { current = await this.delegate.read({ contractVersion: 1, path }); } catch { throw unverified(); }
    if (current.path !== path || current.bindingFingerprint !== source.bindingFingerprint || current.sha256 !== prepared.sha256 ||
        current.sha256 !== createHash("sha256").update(current.content, "utf8").digest("hex") || current.size !== Buffer.byteLength(current.content, "utf8"))
      throw unverified();
    try {
      if (originalFormat) {
      const preparedFormat = await inspectNativeFrontmatter(this.delegate, current.content, current.bindingFingerprint);
      const dateKeys = (status.protection?.frontmatterDateProperties.integrations ?? []).flatMap(item => [item.createdPropertyName, item.modifiedPropertyName].filter((key): key is string => !!key));
      const lineEndingsNormalized = prepared.datePreparation?.lineEndingsNormalized === true;
      const observedAt = Date.now();
      const beforeDates = parseFrontmatter(originalFormat.content);
      const afterDates = parseFrontmatter(current.content);
      for (const key of created) {
        const beforeEntries = entriesForKey(beforeDates, normalizeKey(key));
        if (beforeEntries.length > 0 && !isDeepStrictEqual(beforeEntries, entriesForKey(afterDates, normalizeKey(key))))
          throw new McpError(BaseErrorCode.CONFLICT, "An existing creation date changed during preparation.", { reason: "date_preparation_created_drift" });
      }
      const originalDelimiters = preparationDelimiters(originalFormat.content, lineEndingsNormalized);
      if (preparedFormat.normalized || (originalDelimiters !== undefined && originalDelimiters !== preparationDelimiters(current.content, lineEndingsNormalized)) ||
          preparationNonDateBytes(originalFormat.content, dateKeys, lineEndingsNormalized) !== preparationNonDateBytes(current.content, dateKeys, lineEndingsNormalized))
        throw new McpError(BaseErrorCode.CONFLICT, "The note changed outside the qualified date preparation.", { reason: "date_preparation_non_date_drift" });
      for (const key of dateKeys) {
        const beforeDate = preparationDateValue(originalFormat.content, key);
        const afterDate = preparationDateValue(current.content, key);
        if (beforeDate !== afterDate && (!afterDate || !preparationDateInWindow(afterDate, dispatchedAt, observedAt, offset!)))
          throw new McpError(BaseErrorCode.CONFLICT, "The date preparation is outside its observation window.", { reason: "date_preparation_unqualified" });
      }
      }
      if (created.some(key => entriesForKey(parseFrontmatter(current.content), normalizeKey(key)).length !== 1)) throw fail();
    } catch { throw unverified(); }
    const result = { ...current, ...(prepared.datePreparation?.kind === "date-manager-before-plan" ? { datePreparation: {
      kind: "date-manager-before-plan" as const, message: "Note datée par le gestionnaire de dates avant le plan." + (prepared.datePreparation.lineEndingsNormalized === true
        ? " fins de ligne normalisées par Obsidian pendant la datation." : ""),
      ...(prepared.datePreparation.lineEndingsNormalized === true ? { lineEndingsNormalized: true as const } : {}),
      ...(originalFormat?.normalized ? { frontmatterNormalization: { applied: true as const, reason: "date_preparation" as const, sourceSha256: source.sha256, preparedSha256: current.sha256 } } : {})
    }} : {}) };
    if (requireNativeFormat) this.preparationFences.set(result, { key: fenceKey, attempt });
    else {
      try { if (!this.journal.releaseVerifiedDatePreparationFence(fenceKey, attempt)) throw unverified(); }
      catch { throw unverified(); }
    }
    return result;
  }

  releasePreparation(source: { datePreparation?: OperationReceipt["datePreparation"] }): void {
    const fence = this.preparationFences.get(source);
    if (!fence) return;
    try {
      if (!this.journal.releaseVerifiedDatePreparationFence(fence.key, fence.attempt)) throw new Error("fence_release_failed");
      this.preparationFences.delete(source);
    } catch {
      throw new DatePreparationPlanFailure(source.datePreparation!);
    }
  }

  async replace(payload: Parameters<AtomicWriteBackend["replace"]>[0]) {
    try {
      const context = this.callContext.getStore();
      if (!context || context.kind === "plan") {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          "Atomic note replacement requires an active governed apply or recover context.",
        );
      }

      assertCurrentWritePolicy(context.kind, payload.path, payload.nextContent);
      const current = await measureGovernedPhase("preDispatchRead", () => this.delegate.read({
        contractVersion: 1,
        path: payload.path,
      }));
      const fenceKey = operationDigest({ domain: "obsidian-date-preparation-v1", path: payload.path, bindingFingerprint: current.bindingFingerprint });
      if (this.journal.hasDatePreparationFence(fenceKey)) {
        throw new McpError(BaseErrorCode.CONFLICT, "La préparation des dates a pu modifier ou normaliser la note. Une revue administrative est nécessaire avant reprise.",
          { reasonCode: "date_preparation_unverified", mutationMayHaveApplied: true });
      }
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
      if (!context.atomicWriteStatus) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Atomic-write status was not sealed before validating protected frontmatter.",
          { reason: "atomic_write_status_not_sealed" },
        );
      }
      const comparison = context.requireNativeFormat ? (await inspectNativeFrontmatter(this.delegate, current.content, current.bindingFingerprint)).content : current.content;
      if (context.requireNativeFormat && (await inspectNativeFrontmatter(this.delegate, payload.nextContent, current.bindingFingerprint)).normalized)
        throw new McpError(BaseErrorCode.CONFLICT, "The sealed note no longer matches the native frontmatter format.", { reasonCode: "frontmatter_format_changed" });
      validateReplacement(
        comparison,
        payload.nextContent,
        "effect",
        effectiveAtomicWriteProtectedFrontmatterKeys(
          context.atomicWriteStatus,
          config.mcpProtectedFrontmatterKeys,
        ),
        current.dateManagement?.managed === false ? undefined : effectiveAtomicWriteDateProtection(context.atomicWriteStatus),
      );
    } catch (error) {
      throw markAtomicWritePreDispatchError(error);
    }
    return measureGovernedPhase("atomicCas", () => this.delegate.replace(payload));
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
  frontmatterFormat?: ObsidianNoteReplacePlan["frontmatterFormat"];
};

export class GovernedNoteReplaceRuntime {
  readonly noteCreate: NoteCreateOperationAdapter | undefined;
  readonly assetImport: AssetImportOperationAdapter | undefined;
  readonly assetImportBackendReason?:
    | AssetFileReason
    | ImageProcessingError["reason"];
  readonly nativeMove: NativeNoteMoveOperationAdapter | undefined;
  private closed = false;
  private readonly leaseHeartbeat: NodeJS.Timeout;
  private leaseRenewalFailureReported = false;

  constructor(
    private readonly backend: GovernedAtomicWriteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly adapter: ObsidianNoteReplaceOperationAdapter,
    leaseHeartbeatMs = 5_000,
    private readonly vaultCacheService?: VaultCacheService,
    nativeMoveBackend?: NativeNoteMoveBackend,
    noteCreateBackend?: NoteCreateBackend,
  ) {
    this.noteCreate = noteCreateBackend ? new NoteCreateOperationAdapter(noteCreateBackend, journal) : undefined;
    this.nativeMove = nativeMoveBackend ? new NativeNoteMoveOperationAdapter(nativeMoveBackend, journal) : undefined;
    if (
      config.assetImportEnabled &&
      config.assetFolder &&
      config.obsidianVaultPath
    ) {
      const policy = {
        vaultRoot: config.obsidianVaultPath,
        assetFolder: config.assetFolder,
        quality: config.assetWebpQuality,
      };
      try {
new WindowsAssetFiles(policy.vaultRoot, policy.assetFolder).probe();
        probeImageProcessingDependencies();
        this.assetImport = new AssetImportOperationAdapter(
          {
            inspect: (filename, binding) =>
              runAssetJob<AssetInspection>({
                kind: "inspect",
                ...policy,
                filename,
                binding,
              }),
            create: (filename, bytes, binding) =>
              runAssetJob({
                kind: "create",
                ...policy,
                filename,
                bytes,
                binding,
              }),
          },
          journal,
          policy,
        );
      } catch (error) {
        this.assetImportBackendReason =
          error instanceof AssetFileError
            ? error.reason
            : error instanceof ImageProcessingError
              ? error.reason
              : "native_backend_unavailable";
      }
    }
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

  readForProjection(path: string, requireNativeFormat = false) {
    return this.backend.prepareForPlan ? this.backend.prepareForPlan(path, undefined, requireNativeFormat) : this.backend.read({ contractVersion: 1, path });
  }

  releasePreparation(source: { datePreparation?: OperationReceipt["datePreparation"] }) {
    this.backend.releasePreparation?.(source);
  }

  inspectFrontmatter(content: string, bindingFingerprint: string) {
    return inspectNativeFrontmatter(this.backend, content, bindingFingerprint);
  }

  async renderFrontmatterEntries(content: string, operations: FrontmatterPatchOperation[], bindingFingerprint: string) {
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const entry of nativeFrontmatterPatchKeys(content, operations)) {
      const json = JSON.stringify({ [entry.key]: entry.value });
      const formatted = await this.inspectFrontmatter(`---\n${json}\n---\n`, bindingFingerprint);
      const envelope = frontmatterEnvelope(formatted.content);
      if (!envelope || !envelope.yaml.startsWith(`${entry.key}:`)) {
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, "The key cannot be represented in the supported native frontmatter patch subset.", { reason: "frontmatter_native_render_invalid" });
      }
      result[entry.normalized] = envelope.yaml;
    }
    return result;
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
      fallbackOperationKind: "obsidian.note.replace",
      admittedProjectionKinds: [
        "obsidian.frontmatter.patch",
        "obsidian.text.patch",
        "obsidian.note.move",
        "obsidian.note.create",
        "obsidian.base.rows.patch",
        "obsidian.asset.import",
      ],
      allowUnprojectedFallback: true,
    });
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
      { kind: "plan", path: input.path, nextContent: input.nextContent, requireNativeFormat: !!input.frontmatterFormat },
      () => this.adapter.plan(input),
    );
  }

  async apply(
    reference: string,
    idempotencyKey: string,
    completionMode: SettlementCompletionMode = "verified",
  ): Promise<OperationReceipt> {
    const plan = this.required(reference);
    if (plan.status === "planned") {
      assertCurrentWritePolicy("apply", plan.path, plan.nextContent);
    }
    const operation = this.backend.withContext({ kind: "apply", path: plan.path, requireNativeFormat: !!plan.frontmatterFormat }, () =>
      this.adapter.apply(reference, idempotencyKey, completionMode),
    );
    return this.refreshCacheAfterCommit(plan, operation, true);
  }

  async planPublicDirect(
    input: ObsidianNoteReplacePlanInput,
  ): Promise<OperationReceipt> {
    if (input.idempotencyKey.startsWith(PROJECTED_IDEMPOTENCY_KEY_PREFIX)) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "The idempotency key uses a namespace reserved for internal projections.",
        { reason: "reserved_projection_idempotency_namespace" },
      );
    }
    assertCurrentWritePolicy("plan", input.path, input.nextContent);
    const identity = operationDigest({ path: input.path, nextContent: input.nextContent });
    const existing = this.findPlanByIdempotencyKey(input.idempotencyKey);
    if (existing?.idempotencyIdentity === identity) return this.status(`${PLAN_REF_PREFIX}${existing.operationId}`);
    if (existing) return this.plan(existing.idempotencyIdentity ? { ...input, idempotencyIdentity: identity } : input);
    assertSupportedMarkdownEnvelope(input.nextContent, "plan");
    if (!validateObsidianMarkdown(input.nextContent).ok) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "The sealed next content is not valid conservative Obsidian Markdown.", { reason: "markdown_validation_failed" });
    }
    const before = await this.backend.read({ contractVersion: 1, path: input.path });
    const status = await this.backend.status();
    const keys = effectiveAtomicWriteProtectedFrontmatterKeys(status, config.mcpProtectedFrontmatterKeys);
    const beforeFormat = await inspectNativeFrontmatter(this.backend, before.content, before.bindingFingerprint);
    const format = await inspectNativeFrontmatter(this.backend, input.nextContent, before.bindingFingerprint);
    rejectNonCanonical(format);
    validateReplacement(beforeFormat.content, input.nextContent, "plan", keys);
    const source = await this.backend.prepareForPlan(input.path, before, true);
    try {
    let nextContent = input.nextContent;
    if (source.datePreparation?.kind === "date-manager-before-plan") {
      const fm = parseFrontmatter(source.content);
      const dateKeys = effectiveAtomicWriteDateProtection(status).createdPropertyNames.concat(
        (status.protection?.frontmatterDateProperties.integrations ?? []).flatMap(i => i.modifiedPropertyName ? [i.modifiedPropertyName] : []));
      const operations = dateKeys.flatMap(key => entriesForKey(fm, normalizeKey(key)).map(({key, value}) => {
        if (typeof value !== "string") throw new McpError(BaseErrorCode.CONFLICT, "The date manager returned an unsupported date value.");
        return {op: "set" as const, key, value};
      }));
      if (operations.length) nextContent = compileFrontmatterPatch(nextContent, operations).nextContent;
      // The date manager owns these inserted fields; render them using the
      // same native serializer after preserving the caller's canonical input.
      nextContent = (await inspectNativeFrontmatter(this.backend, nextContent, source.bindingFingerprint)).content;
    }
    const result = await this.plan({ ...input, nextContent, idempotencyIdentity: identity,
      frontmatterFormat: { normalization: { applied: false }, typeWarnings: format.warnings },
      expectedBeforeSha256: source.sha256, expectedBindingFingerprint: source.bindingFingerprint, datePreparation: source.datePreparation });
    if (source.datePreparation?.kind === "date-manager-before-plan" && this.inspect(result.planRef).beforeSha256 !== source.sha256) throw new DatePreparationPlanFailure(source.datePreparation);
    return result;
    } catch (error) {
      if (source.datePreparation?.kind === "date-manager-before-plan") throw new DatePreparationPlanFailure(source.datePreparation);
      throw error;
    } finally { this.backend.releasePreparation(source); }
  }

  async applyPublicDirectPlan(
    reference: string,
    idempotencyKey: string,
    completionMode: SettlementCompletionMode = "deferred",
  ): Promise<OperationReceipt> {
    this.requiredPublicDirectPlan(reference);
    return this.apply(reference, idempotencyKey, completionMode);
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
    completionMode: SettlementCompletionMode = "verified",
  ): Promise<OperationReceipt> {
    const plan = this.required(reference);
    if (plan.status === "outcome_unknown") {
      assertCurrentWritePolicy("recover", plan.path, plan.nextContent);
    }
    const operation = this.backend.withContext({ kind: "recover", path: plan.path, requireNativeFormat: !!plan.frontmatterFormat }, () =>
      this.adapter.recover(reference, idempotencyKey, completionMode),
    );
    return this.refreshCacheAfterCommit(plan, operation, true);
  }

  async recoverPublicDirectPlan(
    reference: string,
    idempotencyKey: string,
    completionMode: SettlementCompletionMode = "deferred",
  ): Promise<OperationReceipt> {
    this.requiredPublicDirectPlan(reference);
    return this.recover(reference, idempotencyKey, completionMode);
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

  private requiredPublicDirectPlan(reference: string): ObsidianNoteReplacePlan {
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
      ...(plan.frontmatterFormat ? { frontmatterFormat: plan.frontmatterFormat } : {}),
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
    refreshPendingAttempt = false,
  ): Promise<OperationReceipt> {
    const result = await operation;
    const mayHaveWritten =
      refreshPendingAttempt &&
      result.postflight.checkAfter !== undefined &&
      (plan.status === "planned" ||
        (plan.status === "outcome_unknown" &&
          this.required(result.planRef).executionStartedAtEpochMs !==
            plan.executionStartedAtEpochMs));
    if (
      (result.outcome !== "committed" && !mayHaveWritten) ||
      !this.vaultCacheService
    ) {
      return result;
    }

    const context = requestContextService.createRequestContext({
      operation: "governedNoteReplaceCacheRefresh",
      operationId: result.operationId,
      filePath: plan.path,
    });
    try {
      await measureGovernedPhase("cacheRefresh", () => this.vaultCacheService!.updateCacheForFile(plan.path, context));
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
    journal,
  );
  const adapter = new ObsidianNoteReplaceOperationAdapter(
    backend,
    journal,
    undefined,
    { modifiedTimeProtectedKeys: config.mcpProtectedFrontmatterKeys },
  );
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
    new RestNativeNoteMoveBackend(obsidianService),
    new RestNoteCreateBackend(obsidianService),
  );

  // The application lifecycle closes the runtime explicitly. This synchronous
  // exit hook is a final fail-safe for startup paths that terminate through
  // process.exit before graceful shutdown can run.
  process.once("exit", () => runtime.close());
  return runtime;
}
