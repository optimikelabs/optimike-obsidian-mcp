import { randomInt } from "node:crypto";
import { config } from "../../config/index.js";
import type { GovernedNoteReplaceRuntime } from "../../mcp-server/tools/governedNoteReplaceTools/runtime.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { parseToolInput } from "../../utils/internal/toolInputValidation.js";
import { operationDigest, type OperationReceipt } from "../operations/contract.js";
import { atomicExchangeUnavailable } from "../operations/filesystemAtomicExchange.js";
import { FILESYSTEM_OPERON_PROJECTION } from "../operations/obsidianNoteReplaceJournal.js";
import { assertWriteAllowed } from "../writePolicy.js";
import { createVaultExclusionMatcher, isVaultPathExcluded } from "../vaultExclusions.js";
import {
  OPERON_CONTRACT_VERSION, OPERON_PUBLIC_INPUT_MESSAGES, OperonCreateTaskSchema, OperonUpdateTaskSchema, OperonTransitionTaskSchema,
  OperonPendingRecoveriesInputSchema, OperonRecoverMutationSchema, OperonTaskSchema, resolveOperonPriorityStableId,
  resolveOperonTransitionIntent, stripOperonTaskProperties, type OperonTask,
} from "./contract.js";
import { formatOperonLocalTime, parseOperonMarkdown, type FilesystemConfiguration } from "./filesystemFormat.js";
import { editTaskSource, renderInlineTask, supportsFilesystemMutationFormat, unsupportedFilesystemMutation, type SimpleTaskEdit } from "./filesystemMutationFormat.js";
import type { FilesystemOperonService } from "./filesystemService.js";

const NOTE_REF = "obsidian-note-replace:v1:";
const RECOVERY_REF = "operon-filesystem:v1:";
const journalKey = (key: string) => "optimike:projection:v1:operon:" + operationDigest(key);
const cacheExclusions = createVaultExclusionMatcher(config.obsidianVaultExcludePatterns);
type Snapshot = Awaited<ReturnType<FilesystemOperonService["mutationSnapshot"]>>;
type WriteAction = "operon_create_task" | "operon_update_task" | "operon_transition_task";
type Control = { idempotencyKey: string; dryRun: boolean; operonId?: string; expectedRevision?: string };

function conflict(message: string, reasonCode = "revision_conflict"): never {
  throw new McpError(BaseErrorCode.CONFLICT, message, { reasonCode });
}

function invalid(message: string): never {
  throw new McpError(BaseErrorCode.VALIDATION_ERROR, message);
}

function authorizePath(path: string) {
  const prefixes = config.operonMutationAllowedPathPrefixes;
  if (prefixes.length && !prefixes.some(prefix => path === prefix || path.startsWith(prefix + "/"))) {
    throw new McpError(BaseErrorCode.FORBIDDEN, "The exact Operon path is outside its configured mutation scope.");
  }
}

function requireApplyOptIn() {
  if (!config.operonMutationsEnabled) throw new McpError(BaseErrorCode.FORBIDDEN, "Operon apply requires OPERON_MUTATIONS_ENABLED=true.");
}

function checkConfiguration(view: Snapshot) {
  if (!supportsFilesystemMutationFormat(view.snapshot.operonVersion, view.configuration)) {
    unsupportedFilesystemMutation("Headless Operon writes require the supported 4.6.0 scalar storage configuration.");
  }
}

function exactTask(view: Snapshot, operonId: string, expectedRevision: string) {
  const rows = view.snapshot.tasks.filter(task => task.operonId === operonId);
  if (rows.length > 1) conflict("The Operon ID is duplicated.", "operon_filesystem_duplicate_id");
  const task = rows[0];
  if (!task) throw new McpError(BaseErrorCode.NOT_FOUND, "The exact Operon task does not exist.");
  if (task.revision !== expectedRevision) conflict("The task, its note, or Operon settings changed after the caller's read.");
  return task;
}

function ensureStandalone(view: Snapshot, task: OperonTask) {
  if (task.recurrence?.repeating || task.recurrence?.seriesId || task.recurrence?.occurrenceDate ||
      task.fields.activeTracker || view.activeTrackers.has(task.operonId) || task.parentTask || task.blocking.length || task.blockedBy.length ||
      task.fields.related ||
      view.snapshot.tasks.some(other => other.parentTask === task.operonId || other.blocking.includes(task.operonId) || other.blockedBy.includes(task.operonId))) {
    unsupportedFilesystemMutation("A repeating, tracked or related task requires Operon's native effect planning.");
  }
}

function statusFor(configuration: FilesystemConfiguration, selector: { statusId?: string; status?: string }) {
  const candidates = configuration.workflow.pipelines.filter(pipeline => pipeline.id)
    .flatMap(pipeline => pipeline.statuses.filter(status => status.id &&
      (selector.statusId ? status.id === selector.statusId : status.value === selector.status)));
  if (candidates.length !== 1 || (candidates[0].isFinished && candidates[0].isCancelled)) {
    return invalid("Provide one uniquely configured Operon status.");
  }
  return candidates[0];
}

function validDate(value: string, datetime: boolean) {
  const shape = datetime ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u : /^\d{4}-\d{2}-\d{2}$/u;
  if (!shape.test(value)) return false;
  const time = new Date(datetime ? value + "Z" : value + "T00:00:00Z");
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, value.length) === value;
}

function scalarFields(input: Record<string, unknown> | undefined, configuration: FilesystemConfiguration) {
  const fields: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (key === "priority") {
      const id = typeof value === "string" ? resolveOperonPriorityStableId(value, configuration.priorities.items) : undefined;
      const priorities = configuration.priorities.items.filter(item => id && item.id === id);
      if (value !== null && priorities.length !== 1) invalid("Provide one uniquely configured Operon priority.");
      fields.priority = value === null ? null : priorities[0].label;
    } else if (["dateDue", "dateStarted", "datetimeStart", "datetimeEnd"].includes(key)) {
      if (value !== null && (typeof value !== "string" || !validDate(value, key.startsWith("datetime")))) {
        invalid("Use a valid local Operon date or datetime.");
      }
      fields[key] = value as string | null;
    } else if (key === "estimate") {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) invalid("Use a nonnegative estimate in seconds.");
      fields.estimate = value === null ? null : String(value);
    } else {
      unsupportedFilesystemMutation("This field requires Operon's native typed writer.");
    }
  }
  return fields;
}

/** Operon only supplies a projection and exact CAS base. The shared note
 * runtime owns persistence, locking, date policy, effect proof and recovery. */
export class FilesystemOperonMutations {
  constructor(private readonly reader: FilesystemOperonService, private readonly notes: GovernedNoteReplaceRuntime,
    private readonly now = Date.now) {}

  async status(forceRefresh: boolean) {
    const status = await this.reader.status(forceRefresh);
    const [configuration, backend] = await Promise.all([
      this.reader.configurationReadiness(), this.notes.filesystemStatus().catch(() => undefined),
    ]);
    const writable = status.ok && configuration.writableFormat === true && backend?.backend.headlessReplacement === "exchange";
    const recovery = !config.operonMutationAllowedPathPrefixes.length;
    return { ...status, snapshot: { ...status.snapshot, capabilities: { ...status.snapshot.capabilities,
      create: writable, update: writable, transition: writable,
      recovery: writable && recovery && config.mcpWriteMode === "full" },
    } };
  }

  createTask(input: unknown) {
    const params = parseToolInput(OperonCreateTaskSchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    const task = params.task;
    if (task.source !== "inline" || !task.targetPath || task.fileTemplateId !== undefined ||
        task.targetFolder !== undefined || task.targetDateKey !== undefined || task.properties !== undefined) {
      return unsupportedFilesystemMutation("Headless creation requires an explicit existing inline note; configured routing, templates and file creation require Desktop.");
    }
    return this.execute("operon_create_task", params, task.targetPath, (view, content, timestamp, path) => {
      if (view.extraCreationRules) return unsupportedFilesystemMutation("Configured inline creation templates or required assignees need the native writer.");
      const { status, ...fields } = task.fields ?? {};
      if (status !== undefined && typeof status !== "string") invalid("Status must be an exact configured value.");
      const configuration = view.configuration;
      if (isVaultPathExcluded(path, cacheExclusions) || configuration.indexing.excludedFolders.some(folder => path === folder || path.startsWith(folder + "/"))) {
        return unsupportedFilesystemMutation("The inline destination is excluded from Operon indexing.");
      }
      if (view.snapshot.tasks.some(row => row.path === path && row.line === null)) {
        return unsupportedFilesystemMutation("An Operon file task container can inherit parent fields and requires native creation.");
      }
      const initial = configuration.workflow.pipelines.find(pipeline => pipeline.name === configuration.workflow.defaultPipelineName)?.statuses[0];
      const selected = statusFor(configuration, { statusId: task.statusId ?? (typeof status === "string" ? undefined : initial?.id ?? undefined), status: status as string | undefined });
      if (selected.isFinished || selected.isCancelled) return unsupportedFilesystemMutation("Creating a terminal task requires native creation effects.");
      const values = Object.fromEntries(Object.entries(scalarFields(fields, configuration)).filter((entry): entry is [string, string] => entry[1] !== null));
      if (!Object.hasOwn(fields, "priority") && configuration.priorities.defaultPriority) {
        const priorities = configuration.priorities.items.filter(item => item.id === configuration.priorities.defaultPriority);
        if (priorities.length !== 1) invalid("The default Operon priority is ambiguous.");
        values.priority = priorities[0].label;
      }
      const operonId = randomInt(36 ** 7).toString(36).padStart(7, "0");
      if (view.snapshot.tasks.some(row => row.operonId === operonId)) conflict("Generated task identity already exists.");
      const line = renderInlineTask(task.description, task.tags ?? [], {
        ...values, operonId, status: selected.value, datetimeCreated: timestamp, datetimeModified: timestamp,
      }, "open");
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const next = content.endsWith("\n") ? content + line + eol : content + (content && content !== "\uFEFF" ? eol : "") + line;
      return { content: next, operonId };
    });
  }

  updateTask(input: unknown) {
    const params = parseToolInput(OperonUpdateTaskSchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    if (params.patch.properties) return unsupportedFilesystemMutation("Unmanaged file properties require the native Operon property contract.");
    return this.edit("operon_update_task", params, view => ({
      description: params.patch.description, tags: params.patch.tags, fields: scalarFields(params.patch.fields, view.configuration),
    }));
  }

  transitionTask(input: unknown) {
    const params = parseToolInput(OperonTransitionTaskSchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    return this.edit("operon_transition_task", params, (view, task, timestamp) => {
      const taxonomy = view.configuration.workflow;
      if (view.projectSerials) return unsupportedFilesystemMutation("Configured project serial scopes require Operon's native transition transaction.");
      if (task.source === "file" && view.filePipelineRouting) {
        return unsupportedFilesystemMutation("Configured file-task pipeline destinations require Operon's native transition transaction.");
      }
      const intent = params.intent && resolveOperonTransitionIntent(taxonomy, task, params.intent);
      if (intent && "error" in intent) return invalid(intent.error);
      const selected = statusFor(view.configuration, { statusId: params.statusId ?? (intent || undefined)?.statusId, status: params.status });
      const checkbox = selected.isFinished ? "done" : selected.isCancelled ? "cancelled" : "open";
      if (checkbox !== "open" && (view.pinned?.has(task.operonId) ||
          (task.source === "file" && view.configuration.automation.fileTaskAutoArchiveEnabled))) {
        return unsupportedFilesystemMutation("This terminal transition can change pinned state or archive a file; use Desktop.");
      }
      return { checkbox, fields: { status: selected.value,
        dateCompleted: checkbox === "done" ? task.dates.completed ?? timestamp.slice(0, 10) : null,
        dateCancelled: checkbox === "cancelled" ? task.dates.cancelled ?? timestamp.slice(0, 10) : null } };
    });
  }

  private edit(action: WriteAction, params: Control & { operonId: string }, change: (view: Snapshot, task: OperonTask, timestamp: string) => SimpleTaskEdit) {
    return this.execute(action, params, undefined, (view, content, timestamp, _path, task) => {
      ensureStandalone(view, task!);
      const edit = change(view, task!, timestamp);
      const next = editTaskSource(content, task!, view.configuration, edit);
      if (next === content) return invalid("The Operon edit would leave the task unchanged.");
      edit.fields.datetimeModified = timestamp;
      return { content: editTaskSource(content, task!, view.configuration, edit), operonId: task!.operonId };
    });
  }

  private async execute(action: WriteAction, params: Control, explicitPath: string | undefined,
    compile: (view: Snapshot, content: string, timestamp: string, path: string, task?: OperonTask) => { content: string; operonId: string }) {
    if (!params.dryRun) requireApplyOptIn();
    assertWriteAllowed({ operation: action, action: params.dryRun ? "dry_run" : "apply", allowInGuarded: true, allowInReadonly: params.dryRun });
    await this.requireAtomicExchange();
    const internalKey = journalKey(params.idempotencyKey);
    const identity = operationDigest({ action, params });
    const existing = this.notes.findPlanByIdempotencyKey(internalKey);
    if (existing && existing.idempotencyIdentity !== identity) conflict("This idempotency key is already bound to an Operon request.", "idempotency_key_reused");
    let ref = existing && NOTE_REF + existing.operationId;
    if (!ref) {
      const view = await this.reader.mutationSnapshot();
      checkConfiguration(view);
      const task = params.operonId ? exactTask(view, params.operonId, params.expectedRevision!) : undefined;
      const path = task?.path ?? explicitPath!;
      authorizePath(path);
      const source = await this.notes.readForProjection(path);
      if (task && view.sourceDigests.get(task) !== source.sha256) conflict("The task note was edited after the index read.");
      const timestamp = formatOperonLocalTime(this.now(), process.env.OPTIMIKE_VAULT_TIMEZONE?.trim() || view.provenance.timeZone);
      const edit = compile(view, source.content, timestamp, path, task);
      const projected = parseOperonMarkdown(edit.content, path, view.configuration);
      if (projected.invalidFrontmatter || projected.tasks.filter(row => row.id === edit.operonId).length !== 1) {
        return unsupportedFilesystemMutation("The proposed task does not resolve to a unique indexed source.");
      }
      const receipt = await this.notes.plan({ path, nextContent: edit.content, idempotencyKey: internalKey,
        idempotencyIdentity: identity, expectedBeforeSha256: source.sha256, expectedBindingFingerprint: source.bindingFingerprint,
        projection: { contractVersion: 1, kind: FILESYSTEM_OPERON_PROJECTION, publicIdempotencyKey: params.idempotencyKey,
          intentDigest: identity, proof: { action, operonId: edit.operonId, before: task ? stripOperonTaskProperties(task) : null,
            settingsSignature: view.snapshot.settingsSignature, mutationBinding: view.mutationBinding } },
      }, source.sha256);
      ref = receipt.planRef;
    }
    const sealed = this.requirePlan(ref);
    authorizePath(sealed.path);
    const previous = await this.notes.status(ref);
    if (params.dryRun || previous.phase !== "planned") return this.result(previous, params, Boolean(existing));
    const current = await this.reader.mutationSnapshot();
    if (sealed.projection!.proof.mutationBinding !== current.mutationBinding) conflict("Operon settings or runtime state changed after planning.");
    if (params.operonId) ensureStandalone(current, exactTask(current, params.operonId, params.expectedRevision!));
    else if (current.snapshot.tasks.some(task => task.operonId === sealed.projection!.proof.operonId)) conflict("The new task identity is already in use.");
    const receipt = await this.notes.apply(ref, internalKey);
    return this.result(receipt, params, false);
  }

  private async requireAtomicExchange() {
    const atomic = await this.notes.filesystemStatus();
    if (atomic.backend.headlessReplacement !== "exchange") throw atomicExchangeUnavailable();
  }

  private requirePlan(ref: string) {
    const plan = this.notes.inspect(ref);
    if (plan.projection?.kind !== FILESYSTEM_OPERON_PROJECTION || !this.notes.ownsFilesystemBinding(plan.bindingFingerprint)) {
      throw new McpError(BaseErrorCode.NOT_FOUND, "The filesystem Operon recovery is unknown.");
    }
    return plan;
  }

  recoveryPath(recoveryRef: string) {
    const ref = this.noteRef(recoveryRef);
    return this.requirePlan(ref).path;
  }

  private noteRef(recoveryRef: string) {
    if (!recoveryRef.startsWith(RECOVERY_REF)) throw new McpError(BaseErrorCode.NOT_FOUND, "The filesystem Operon recovery is unknown.");
    return NOTE_REF + recoveryRef.slice(RECOVERY_REF.length);
  }

  async pendingRecoveries(input: unknown) {
    const params = parseToolInput(OperonPendingRecoveriesInputSchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    this.requireUnscopedRecovery();
    if (params.kind) return unsupportedFilesystemMutation("Native task-workflow recoveries require Desktop.");
    const recoveries = this.notes.listPendingOperonPlans().filter(row =>
      this.notes.ownsFilesystemBinding(this.notes.inspect(row.planRef).bindingFingerprint)).map(row => ({
      recoveryRef: RECOVERY_REF + row.operationId, createdAt: row.createdAt,
      mutationKind: String(this.requirePlan(row.planRef).projection!.proof.action),
    }));
    return { ok: true, source: "filesystem", contractVersion: OPERON_CONTRACT_VERSION, stale: false, recoveries };
  }

  async recoverMutation(input: unknown) {
    const params = parseToolInput(OperonRecoverMutationSchema, input, OPERON_PUBLIC_INPUT_MESSAGES);
    requireApplyOptIn();
    this.requireUnscopedRecovery();
    assertWriteAllowed({ operation: "operon_recover_mutation", action: "recover", destructive: true });
    if (params.recovery.kind !== "developer-api") return unsupportedFilesystemMutation("Native task-workflow recoveries require Desktop.");
    const ref = this.noteRef(params.recoveryRef);
    const sealed = this.requirePlan(ref);
    if (sealed.status === "planned") conflict("This plan has no dispatched effect to recover.");
    this.notes.bindOperonRecoveryKey(sealed.operationId, journalKey(params.idempotencyKey));
    const before = await this.notes.status(ref);
    if (before.outcome === "committed") return this.result(before, params, true);
    await this.requireAtomicExchange();
    const view = await this.reader.mutationSnapshot();
    if (view.mutationBinding !== sealed.projection!.proof.mutationBinding) conflict("Operon settings or runtime state changed since the original plan was sealed.");
    const beforeTask = OperonTaskSchema.safeParse(sealed.projection!.proof.before);
    if (beforeTask.success) ensureStandalone(view, exactTask(view, beforeTask.data.operonId, beforeTask.data.revision));
    else if (view.snapshot.tasks.some(task => task.operonId === sealed.projection!.proof.operonId)) conflict("The new task identity is already in use.");
    return this.result(await this.notes.recover(ref, sealed.idempotencyKey), params, false);
  }

  private requireUnscopedRecovery() {
    if (config.operonMutationAllowedPathPrefixes.length) throw new McpError(BaseErrorCode.FORBIDDEN,
      "Operon recovery is blocked while its path allowlist is configured.", { reasonCode: "operon_recovery_blocked_by_path_scope" });
  }

  private async result(receipt: OperationReceipt, requested: { idempotencyKey: string }, replayed: boolean) {
    const base = { contractVersion: OPERON_CONTRACT_VERSION, operationId: receipt.operationId, idempotencyKey: requested.idempotencyKey,
      source: "filesystem", stale: false, planDigest: receipt.planDigest };
    const projection = this.requirePlan(receipt.planRef).projection!;
    if (receipt.outcome === "conflict") conflict("The note changed before the sealed Operon write could commit.");
    if (receipt.postflight.reason === "headless_atomic_exchange_unavailable") throw atomicExchangeUnavailable();
    if (receipt.phase === "planned") return { ...base, ok: true, status: "planned", requested, before: projection.proof.before,
      plan: { path: receipt.target.logicalRef, beforeSha256: receipt.beforeProof.details?.sha256, operonId: projection.proof.operonId }, ...(replayed ? { replayed } : {}) };
    if (receipt.outcome === "committed" && receipt.postflight.status === "verified") {
      // A newer edit can legitimately follow a verified commit. Report an
      // after DTO only when it can still be read against that exact receipt.
      let after: OperonTask | undefined;
      try {
        const view = await this.reader.mutationSnapshot();
        const row = view.snapshot.tasks.find(task => task.operonId === projection.proof.operonId && task.path === receipt.target.logicalRef);
        if (row && view.sourceDigests.get(row) === receipt.afterProof?.details?.sha256 &&
            view.snapshot.settingsSignature === projection.proof.settingsSignature) after = stripOperonTaskProperties(OperonTaskSchema.parse(row));
      } catch { /* the durable operation proof still certifies the commit */ }
      return { ...base, ok: true, status: replayed ? "already-applied" : "applied", requested, before: projection.proof.before,
        ...(after ? { after } : {}), ...(replayed ? { replayed } : {}) };
    }
    const uncertain = receipt.phase === "applying" || receipt.outcome === "outcome_unknown";
    return { ...base, ok: false, status: uncertain ? "outcome-unknown" : "failed", requested: {}, retryable: false,
      error: { code: uncertain ? "outcome_unknown" : "filesystem_mutation_failed", message: uncertain
        ? "The sealed Operon write requires same-plan recovery." : "The sealed Operon write did not commit." },
      ...(uncertain ? { recoveryRef: RECOVERY_REF + receipt.operationId, recoveryRequired: true, mutationMayHaveApplied: true } : {}) };
  }
}
