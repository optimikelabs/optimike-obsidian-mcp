import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  currentInstructionRules,
  evaluateReader,
  instructionContentSha256,
  InstructionProbeLimiter,
  normalizeVaultPath,
  probeInstructionFiles,
  VAULT_INSTRUCTIONS_CONTRACT_VERSION,
  VAULT_INSTRUCTIONS_LIMITS,
  VaultInstructionsReadLedger,
  vaultInstructionsRulesDigest,
  VaultInstructionsUnavailableError,
  withDeadline,
  type EvaluatedInstructionFile,
  type InstructionProbeOptions,
  type VaultInstructionsReader,
  type VaultInstructionsSource,
  type VaultInstructionsTarget,
  type VaultInstructionsUnavailableReason,
} from "../services/vaultInstructions.js";
import {
  parseVaultInstructionsMode,
  stricterVaultInstructionsMode,
  type VaultInstructionsMode,
} from "../services/vaultInstructionsNames.js";
import type { VaultInstructionsSealJournal } from "../services/vaultInstructionsSeal.js";
import {
  activeHttpRequestId,
  activeHttpVaultInstructionsHints,
} from "./transports/httpRequestState.js";

/**
 * Vault instructions gate (AGENTS.md cascade) around the public tool callbacks.
 *
 * - `obsidian_read_note` of a configured instruction file records a read proof.
 * - A write plan or direct write is evaluated against the instruction files
 *   that apply to its target paths. `advise` annotates the result with
 *   `vaultInstructions`; `enforce` refuses before the tool runs while a file is
 *   unread or changed since it was read.
 * - A governed plan is sealed with its rules; its apply or recover re-checks
 *   the seal (`enforce` refuses, before the tool runs, if the rules changed).
 * - Targets are the paths the backend really writes: exact spellings (every
 *   Unicode form checked), Operon destinations resolved by read-only
 *   preflights, and the notes a native move rewrites (from its sealed plan).
 * - `off` leaves every call and result unchanged. A vault without instruction
 *   files on the target chains keeps its results unchanged, except the
 *   documented cautious refusals of `enforce` (unknown target, seal journal
 *   unavailable, plan not sealed).
 */

export interface VaultInstructionsSettings {
  defaultMode: VaultInstructionsMode;
  minimumMode: VaultInstructionsMode;
  names: readonly string[];
  vaultId: string;
}

export interface VaultInstructionsRuntime {
  settings: VaultInstructionsSettings;
  source?: VaultInstructionsSource;
  ledger: VaultInstructionsReadLedger;
  /** Lazily opened durable seal journal; `undefined` when unavailable. */
  seals: () => VaultInstructionsSealJournal | undefined;
  assetFolder?: string;
  resolveOperonTaskPath?: (operonId: string) => Promise<string | undefined>;
  /**
   * Read-only preflight: the folder Operon routes new file tasks to (`""`
   * when none is configured). Throws when it cannot be read.
   */
  resolveOperonFileTaskFolder?: () => Promise<string | undefined>;
  /** Headless: refresh the cached copy of an instruction file before a read. */
  refreshCachedInstructionFile?: (vaultPath: string) => Promise<void>;
  probeOptions?: Omit<InstructionProbeOptions, "limiter">;
  /** Process-wide probe budget; one is created per runtime when absent. */
  probeLimiter?: InstructionProbeLimiter;
  /** Deadline of the Operon resolutions made before the probes. */
  resolutionTimeoutMs?: number;
  now?: () => number;
}

type Callback = (...args: any[]) => any;
type Registrar = (...args: any[]) => any;

const GOVERNED_FAMILIES = new Set([
  "obsidian_text_patch",
  "obsidian_frontmatter_patch",
  "obsidian_note_replace",
  "obsidian_note_create",
  "obsidian_note_delete",
  "obsidian_note_move",
  "bases_rows_patch",
  "bases_formula_patch",
  "bases_config_patch",
  "bases_create",
  "obsidian_canvas_patch",
  "obsidian_canvas_create",
  "asset_import",
]);

type TargetSpec =
  | { kind: "read" }
  | { kind: "targets"; targets: VaultInstructionsTarget[] }
  | { kind: "unresolved"; hint: string }
  | {
      kind: "operon";
      /** Tasks whose note is written. */
      operonIds: string[];
      targets: VaultInstructionsTarget[];
      /** Tasks whose note folder may receive a new file task (parent task). */
      parentFolderOf?: string[];
      /** The configured Operon file-task folder receives the new file. */
      configuredFileTaskFolder?: boolean;
    };

type Params = Record<string, any>;

const ACTIVE_FILE_HINT =
  "Call it again with targetType \"filePath\" and the vault path in targetIdentifier.";

const TAG_RENAME_HINT =
  "A vault-wide tag rename writes notes that are only known when it runs. Run it with dryRun true to list them, then change each note with operation add or remove and its filePath.";

function file(value: unknown): VaultInstructionsTarget[] {
  const normalized = normalizeVaultPath(value);
  return normalized === undefined || normalized === "" ? [] : [{ path: normalized }];
}

function folder(value: unknown): VaultInstructionsTarget[] {
  const normalized = normalizeVaultPath(value);
  return normalized === undefined ? [] : [{ path: normalized, folder: true }];
}

function explicit(
  targets: VaultInstructionsTarget[],
  expected: number,
  hint = "Use the form of this tool that names an explicit vault path.",
): TargetSpec {
  return targets.length >= expected && targets.length > 0
    ? { kind: "targets", targets }
    : { kind: "unresolved", hint };
}

function planTargets(
  family: string,
  p: Params,
  runtime: VaultInstructionsRuntime,
): TargetSpec {
  switch (family) {
    case "obsidian_note_move":
      return explicit([...file(p.sourcePath), ...file(p.destinationPath)], 2);
    case "asset_import":
      return runtime.assetFolder
        ? explicit(folder(runtime.assetFolder), 1)
        : {
            kind: "unresolved",
            hint: "The asset destination folder is not configured on this server.",
          };
    default:
      return explicit(file(p.path), 1);
  }
}

function directTargets(
  name: string,
  p: Params,
  runtime: VaultInstructionsRuntime,
): TargetSpec | undefined {
  switch (name) {
    case "obsidian_update_note":
    case "obsidian_search_replace":
      return p.targetType === "filePath"
        ? explicit(file(p.targetIdentifier), 1, ACTIVE_FILE_HINT)
        : { kind: "unresolved", hint: ACTIVE_FILE_HINT };
    case "obsidian_manage_frontmatter":
      return p.operation === "get" ? { kind: "read" } : explicit(file(p.filePath), 1);
    case "obsidian_manage_tags":
      // list, index and audit only read; a rename preview writes nothing.
      if (["list", "index", "audit"].includes(p.operation)) return { kind: "read" };
      if (p.operation === "rename") {
        return p.dryRun === false
          ? { kind: "unresolved", hint: TAG_RENAME_HINT }
          : { kind: "read" };
      }
      return explicit(file(p.filePath), 1);
    case "obsidian_delete_note":
      return explicit(file(p.filePath), 1);
    case "obsidian_move_note":
      return explicit([...file(p.sourcePath), ...file(p.targetPath)], 2);
    case "obsidian_batch_frontmatter": {
      const items = Array.isArray(p.operations) ? p.operations : [];
      return explicit(items.flatMap((item: Params) => file(item?.filePath)), items.length);
    }
    case "obsidian_manage_canvas":
      return p.operation === "validate" ? { kind: "read" } : explicit(file(p.filePath), 1);
    case "obsidian_admin_filesystem": {
      const items = Array.isArray(p.items) ? p.items : [];
      const targets = items.flatMap((item: Params) => [
        ...file(item?.sourcePath),
        ...(item?.targetPath !== undefined ? file(item.targetPath) : []),
      ]);
      if (p.operation === "archive") {
        targets.push(...folder(p.archiveDir ?? "Archive"));
      }
      return explicit(targets, items.length);
    }
    case "bases_create":
      return p.validateOnly === true ? { kind: "read" } : explicit(file(p.path), 1);
    case "bases_upsert_config":
      return p.validateOnly === true ? { kind: "read" } : explicit(file(p.base_id), 1);
    case "bases_upsert_rows": {
      const items = Array.isArray(p.operations) ? p.operations : [];
      return explicit(items.flatMap((item: Params) => file(item?.file)), items.length);
    }
    case "operon_adopt_task":
      return explicit(file(p.adoption?.targetPath), 1);
    case "operon_create_periodic_task":
      return {
        kind: "unresolved",
        hint: "Operon does not expose the periodic note path before creating the task, so its instructions cannot be checked; ask the vault owner to lower MCP_VAULT_INSTRUCTIONS for this client to create periodic tasks.",
      };
    case "operon_create_task": {
      const task = p.task ?? {};
      if (task.source === "file") {
        // Legacy engine: an explicit targetFolder. Official API V1: its
        // configured file-task folder (read by a preflight). A parent task may
        // also route the new file next to its parent note.
        const parent =
          typeof task.fields?.parentTask === "string" && task.fields.parentTask.trim()
            ? [task.fields.parentTask.trim()]
            : [];
        if (task.targetFolder !== undefined) {
          const targets = folder(task.targetFolder);
          return targets.length === 0
            ? { kind: "unresolved", hint: "task.targetFolder is not a vault folder path." }
            : { kind: "operon", operonIds: [], targets, parentFolderOf: parent };
        }
        return {
          kind: "operon",
          operonIds: [],
          targets: [],
          parentFolderOf: parent,
          configuredFileTaskFolder: true,
        };
      }
      if (task.targetPath !== undefined) return explicit(file(task.targetPath), 1);
      return {
        kind: "unresolved",
        hint: "Give task.targetPath, the note that receives this inline task: the default inline destination of Operon is not known before creation.",
      };
    }
    case "operon_update_task":
    case "operon_transition_task":
    case "operon_set_relationships":
    case "operon_update_recurrence":
    case "operon_update_periodic_scheduling":
      return typeof p.operonId === "string"
        ? { kind: "operon", operonIds: [p.operonId], targets: [] }
        : { kind: "unresolved", hint: "Give the task operonId." };
    case "operon_convert_task": {
      if (typeof p.operonId !== "string") {
        return { kind: "unresolved", hint: "Give the task operonId." };
      }
      if (p.target === "file") {
        // The task note (source) and the folder that receives the new file.
        if (p.targetFolder !== undefined) {
          const targets = folder(p.targetFolder);
          return targets.length === 0
            ? { kind: "unresolved", hint: "targetFolder is not a vault folder path." }
            : { kind: "operon", operonIds: [p.operonId], targets };
        }
        return {
          kind: "operon",
          operonIds: [p.operonId],
          targets: [],
          configuredFileTaskFolder: true,
        };
      }
      const destination = p.targetPath !== undefined ? file(p.targetPath) : [];
      return destination.length > 0
        ? { kind: "operon", operonIds: [p.operonId], targets: destination }
        : {
            kind: "unresolved",
            hint: "Give targetPath, the note that receives the inline task.",
          };
    }
    case "operon_relocate_task": {
      if (typeof p.operonId !== "string") {
        return { kind: "unresolved", hint: "Give the task operonId." };
      }
      const destination = p.targetPath !== undefined ? file(p.targetPath) : [];
      return destination.length > 0
        ? { kind: "operon", operonIds: [p.operonId], targets: destination }
        : { kind: "unresolved", hint: "Give targetPath, the note that receives the task." };
    }
    default:
      return undefined;
  }
}

type ToolRole =
  | { kind: "read-proof" }
  | { kind: "plan"; family: string }
  | { kind: "direct" }
  | { kind: "apply"; family: string };

const DIRECT_TOOLS = new Set([
  "obsidian_update_note",
  "obsidian_search_replace",
  "obsidian_manage_frontmatter",
  "obsidian_manage_tags",
  "obsidian_delete_note",
  "obsidian_move_note",
  "obsidian_batch_frontmatter",
  "obsidian_manage_canvas",
  "obsidian_admin_filesystem",
  "bases_create",
  "bases_upsert_config",
  "bases_upsert_rows",
  "operon_adopt_task",
  "operon_create_periodic_task",
  "operon_create_task",
  "operon_update_task",
  "operon_transition_task",
  "operon_set_relationships",
  "operon_update_recurrence",
  "operon_update_periodic_scheduling",
  "operon_convert_task",
  "operon_relocate_task",
]);

export function vaultInstructionsToolRole(name: string): ToolRole | undefined {
  if (name === "obsidian_read_note") return { kind: "read-proof" };
  if (DIRECT_TOOLS.has(name)) return { kind: "direct" };
  const lifecycle = /^(.*)_(plan|apply|recover)$/u.exec(name);
  if (lifecycle && GOVERNED_FAMILIES.has(lifecycle[1])) {
    return lifecycle[2] === "plan"
      ? { kind: "plan", family: lifecycle[1] }
      : { kind: "apply", family: lifecycle[1] };
  }
  return undefined;
}

/** Mode and reader of the current call. */
export function currentVaultInstructionsCall(
  settings: VaultInstructionsSettings,
  ctx?: { sessionId?: unknown },
): { mode: VaultInstructionsMode; reader: VaultInstructionsReader } {
  const hints = activeHttpVaultInstructionsHints();
  const requested =
    parseVaultInstructionsMode(hints?.vaultInstructionsMode) ?? settings.defaultMode;
  const mode = stricterVaultInstructionsMode(settings.minimumMode, requested);
  const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined;
  let reader: VaultInstructionsReader;
  if (sessionId) {
    reader = { key: `session:${sessionId}`, scope: "session" };
  } else if (hints) {
    const identity = hints.identityKey ?? "unverified";
    reader = hints.readerContext
      ? { key: `identity:${identity}:reader:${hints.readerContext}`, scope: "reader-context" }
      : { key: `identity:${identity}`, scope: "identity" };
  } else {
    reader = { key: "process", scope: "process" };
  }
  return { mode, reader };
}

// ---------------------------------------------------------------------------
// Messages

const READ_TOOL = "obsidian_read_note";

function statusSentence(family: string): string {
  return `First call ${family}_status with this planRef. Only if it reports phase planned:`;
}

function statusTail(family: string): string {
  return `If it reports applying or an unknown outcome, reconcile it with ${family}_status and do not plan it again.`;
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`;
}

const MESSAGES = {
  unread: (tool: string) =>
    `This vault has agent instructions that apply to this write. Nothing was planned or written. Read each file listed with state unread or changed using ${READ_TOOL}, then call ${tool} again with the same arguments.`,
  applyUnread: (tool: string) =>
    `This vault has agent instructions that apply to this plan. Nothing was applied by this call. Read each file listed with state unread or changed using ${READ_TOOL}, then call ${tool} again with the same arguments.`,
  planNeighborhoodUnread: (family: string) =>
    `This move would also rewrite links in notes covered by agent instructions you have not read in their current version. The plan was recorded but not sealed, so it cannot be applied; nothing was moved. Read each file listed with state unread or changed using ${READ_TOOL}, then call ${family}_plan again with the same arguments (the same idempotencyKey returns the same plan, which is then sealed).`,
  planNeighborhoodUnknown: (family: string) =>
    `The notes this move would rewrite could not be determined from its plan, so their agent instructions cannot be checked. The plan was not sealed and cannot be applied while instructions are enforced; nothing was moved. Check it with ${family}_status.`,
  changedSincePlan: (family: string) =>
    `The instructions that apply to this plan changed after it was made. Nothing was applied by this call. ${statusSentence(family)} read each file listed with state changed or added using ${READ_TOOL}, then plan again with ${family}_plan, reusing your previous arguments only if the new instructions do not change your intent. ${statusTail(family)}`,
  planUnsealed: (family: string) =>
    `This plan has no instruction seal (it was made with instructions off for this client, its seal could not be written, or its seal expired). Nothing was applied by this call. ${statusSentence(family)} read the applicable instruction files with ${READ_TOOL}, then plan again with ${family}_plan. ${statusTail(family)}`,
  sealJournalUnavailable: () =>
    "The journal that seals plans with their agent instructions cannot be opened on this server, so a plan made now could never be applied while instructions are enforced. Nothing was planned. Ask the vault owner to check MCP_VAULT_INSTRUCTIONS_JOURNAL_PATH (an absolute, writable path outside the vault).",
  sealJournalUnavailableApply: (family: string) =>
    `The journal that seals plans with their agent instructions cannot be opened on this server, so this plan cannot be checked. Nothing was applied by this call. Ask the vault owner to check MCP_VAULT_INSTRUCTIONS_JOURNAL_PATH, then call ${family}_status before planning again.`,
  sealNotWritten: (family: string) =>
    `This plan was recorded but its instruction seal could not be written, so its apply will be refused while instructions are enforced. Call ${family}_plan again with the same arguments to seal it.`,
  targetUnresolved: (hint: string) =>
    `The vault path this call would write cannot be determined, so the agent instructions that apply to it cannot be checked. Nothing was planned or written. ${hint}`,
  unavailable: (
    reason: VaultInstructionsUnavailableReason,
    limits: { maxFileBytes: number; maxEvaluationBytes: number },
    nothing = "Nothing was planned or written.",
  ) =>
    reason === "too_large"
      ? `An agent instruction file that applies to this write is larger than this server reads (${kib(limits.maxFileBytes)} per file, ${kib(limits.maxEvaluationBytes)} per check), so it cannot be checked. ${nothing} Ask the vault owner to shorten it or to split it between folders.`
      : reason === "invalid_response"
        ? `The vault backend returned an agent instruction file in an unexpected form, so it cannot be checked. ${nothing} Retry later; if it persists, ask the vault owner to check the Local REST API.`
        : `The agent instruction files that apply to this write could not be checked right now. ${nothing} Retry the same call later.`,
  adviseIncomplete: () =>
    `This vault has agent instructions for this path. Read each file listed with state unread or changed using ${READ_TOOL} before applying or writing; more local files refine the root rules.`,
  adviseChangedSincePlan: (family: string) =>
    `The instructions that apply to this plan changed after it was made. Read the files listed with state changed or added, then plan again with ${family}_plan if they change your intent.`,
  adviseUnverifiable: () =>
    "The agent instruction files that apply to this write could not be checked; read AGENTS.md and the instruction files of the parent folders of the target before writing.",
  adviseUnresolved: (hint: string) =>
    `The vault path of this write is not known, so only the root instructions are listed. ${hint}`,
  adviseNeighborhoodUnknown: () =>
    "The notes this move would rewrite could not be determined, so only the instructions of its source and destination are listed. Read the instruction files of the folders of the notes that link to it before applying.",
};

type RefusalCode =
  | "vault_instructions_unread"
  | "vault_instructions_changed_since_plan"
  | "vault_instructions_plan_unsealed"
  | "vault_instructions_target_unresolved"
  | "vault_instructions_unavailable";

export const VAULT_INSTRUCTIONS_REASON_CODES: readonly RefusalCode[] = [
  "vault_instructions_unread",
  "vault_instructions_changed_since_plan",
  "vault_instructions_plan_unsealed",
  "vault_instructions_target_unresolved",
  "vault_instructions_unavailable",
];

type ReportFile = {
  path: string;
  sha256?: string;
  state: "read" | "unread" | "changed" | "added" | "removed";
};

function readActions(files: ReportFile[]) {
  return files
    .filter((entry) => entry.state === "unread" || entry.state === "changed" || entry.state === "added")
    .map((entry) => ({ tool: READ_TOOL, arguments: { filePath: entry.path } }));
}

function report(
  mode: VaultInstructionsMode,
  reader: VaultInstructionsReader,
  fields: {
    files?: ReportFile[];
    targets?: Array<{ path: string; rules: string[] }>;
    rulesDigest?: string;
    complete?: boolean;
    targetResolved?: boolean;
    verified?: boolean;
    unavailableReason?: VaultInstructionsUnavailableReason | "seal_journal";
    changedSincePlan?: boolean;
    sealed?: boolean;
    message?: string;
    nextActions?: Array<{ tool: string; arguments: Record<string, unknown> }>;
  },
): Record<string, unknown> {
  const actions = fields.nextActions ?? readActions(fields.files ?? []);
  return {
    contractVersion: VAULT_INSTRUCTIONS_CONTRACT_VERSION,
    mode,
    readerScope: reader.scope,
    ...(fields.targetResolved === false ? { targetResolved: false } : {}),
    ...(fields.verified === false ? { verified: false } : {}),
    ...(fields.unavailableReason ? { unavailableReason: fields.unavailableReason } : {}),
    ...(fields.rulesDigest ? { rulesDigest: fields.rulesDigest } : {}),
    ...(fields.complete !== undefined ? { complete: fields.complete } : {}),
    ...(fields.changedSincePlan ? { changedSincePlan: true } : {}),
    ...(fields.sealed !== undefined ? { sealed: fields.sealed } : {}),
    ...(fields.files ? { files: fields.files } : {}),
    ...(fields.targets ? { targets: fields.targets } : {}),
    ...(actions.length > 0 ? { nextActions: actions } : {}),
    ...(fields.message ? { message: fields.message } : {}),
  };
}

function refusal(
  code: RefusalCode,
  message: string,
  vaultInstructions: Record<string, unknown>,
  retryable = code !== "vault_instructions_target_unresolved",
) {
  const errorCode =
    code === "vault_instructions_unavailable" ? "SERVICE_UNAVAILABLE" : "FORBIDDEN";
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          requestId: activeHttpRequestId() ?? randomUUID(),
          error: {
            code: errorCode,
            message,
            details: {
              reasonCode: code,
              retryable,
            },
          },
          vaultInstructions,
        }),
      },
    ],
    isError: true,
  };
}

/** Adds `vaultInstructions` to a successful JSON tool result. */
export function decorateToolResult(result: any, field: Record<string, unknown>): any {
  if (!result || typeof result !== "object" || result.isError === true) return result;
  const content = Array.isArray(result.content) ? result.content : undefined;
  const first = content?.[0];
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      const parsed = JSON.parse(first.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const indented = /^\{\s*\n/u.test(first.text);
        const next = {
          ...result,
          content: [
            {
              ...first,
              text: JSON.stringify(
                { ...parsed, vaultInstructions: field },
                null,
                indented ? 2 : undefined,
              ),
            },
            ...content!.slice(1),
          ],
        };
        if (
          result.structuredContent &&
          typeof result.structuredContent === "object" &&
          !Array.isArray(result.structuredContent)
        ) {
          next.structuredContent = { ...result.structuredContent, vaultInstructions: field };
        }
        return next;
      }
    } catch {
      /* not JSON: add a separate block below */
    }
  }
  return {
    ...result,
    content: [
      ...(content ?? []),
      { type: "text", text: JSON.stringify({ vaultInstructions: field }) },
    ],
  };
}

function parsedResult(result: any): Record<string, any> | undefined {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Gate

const limiters = new WeakMap<VaultInstructionsRuntime, InstructionProbeLimiter>();

function probeOptions(runtime: VaultInstructionsRuntime): InstructionProbeOptions {
  let limiter = runtime.probeLimiter ?? limiters.get(runtime);
  if (!limiter) {
    limiter = new InstructionProbeLimiter(VAULT_INSTRUCTIONS_LIMITS.globalConcurrency);
    limiters.set(runtime, limiter);
  }
  return { ...runtime.probeOptions, limiter };
}

function limitsOf(runtime: VaultInstructionsRuntime) {
  return {
    maxFileBytes: runtime.probeOptions?.maxFileBytes ?? VAULT_INSTRUCTIONS_LIMITS.maxFileBytes,
    maxEvaluationBytes:
      runtime.probeOptions?.maxEvaluationBytes ?? VAULT_INSTRUCTIONS_LIMITS.maxEvaluationBytes,
  };
}

function rulesFor(runtime: VaultInstructionsRuntime, targets: readonly VaultInstructionsTarget[]) {
  return currentInstructionRules(
    runtime.source!,
    runtime.settings.names,
    targets,
    probeOptions(runtime),
  );
}

/** The seal journal, or `undefined` when it cannot be opened. */
function sealJournal(runtime: VaultInstructionsRuntime): VaultInstructionsSealJournal | undefined {
  try {
    return runtime.seals();
  } catch {
    return undefined;
  }
}

/** True only when the seal was written to the journal. */
function persistSeal(
  runtime: VaultInstructionsRuntime,
  record: Parameters<VaultInstructionsSealJournal["seal"]>[0],
): boolean {
  const journal = sealJournal(runtime);
  if (!journal) return false;
  try {
    journal.seal(record);
    return true;
  } catch {
    return false;
  }
}

function uniqueTargets(targets: readonly VaultInstructionsTarget[]): VaultInstructionsTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.folder ? "d" : "f"}:${target.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parentFolder(vaultPath: string): VaultInstructionsTarget {
  const slash = vaultPath.lastIndexOf("/");
  return { path: slash < 0 ? "" : vaultPath.slice(0, slash), folder: true };
}

type Resolution =
  | { targets: VaultInstructionsTarget[] }
  | { hint: string }
  | { unavailable: VaultInstructionsUnavailableReason };

const FILE_TASK_FOLDER_HINT =
  "Operon has no configured file-task folder (operon_get_configuration: creation.fileTasksFolder), so the folder that would receive this file task is not known. Configure one in Operon, or ask the vault owner to lower MCP_VAULT_INSTRUCTIONS for this client to create file tasks.";

async function resolveTargets(
  runtime: VaultInstructionsRuntime,
  spec: Exclude<TargetSpec, { kind: "read" }>,
): Promise<Resolution> {
  if (spec.kind === "unresolved") return { hint: spec.hint };
  if (spec.kind === "targets") return { targets: spec.targets };
  const timeout = runtime.resolutionTimeoutMs ?? VAULT_INSTRUCTIONS_LIMITS.evaluationTimeoutMs;
  const targets = [...spec.targets];
  const taskNote = async (operonId: string): Promise<string | Resolution> => {
    let resolved: string | undefined;
    try {
      resolved = runtime.resolveOperonTaskPath
        ? await withDeadline(runtime.resolveOperonTaskPath(operonId), timeout)
        : undefined;
    } catch (error) {
      if (error instanceof VaultInstructionsUnavailableError) return { unavailable: error.reason };
      resolved = undefined;
    }
    const normalized = normalizeVaultPath(resolved);
    return normalized
      ? normalized
      : {
          hint: "The note that holds this Operon task could not be resolved; check the operonId with operon_get_task, then retry.",
        };
  };
  for (const operonId of spec.operonIds) {
    const note = await taskNote(operonId);
    if (typeof note !== "string") return note;
    targets.push({ path: note });
  }
  const parentFolders = spec.parentFolderOf ?? [];
  for (const operonId of parentFolders) {
    const note = await taskNote(operonId);
    if (typeof note !== "string") return note;
    targets.push(parentFolder(note));
  }
  if (spec.configuredFileTaskFolder) {
    if (!runtime.resolveOperonFileTaskFolder) return { hint: FILE_TASK_FOLDER_HINT };
    let configured: string | undefined;
    try {
      configured = await withDeadline(runtime.resolveOperonFileTaskFolder(), timeout);
    } catch (error) {
      return {
        unavailable:
          error instanceof VaultInstructionsUnavailableError ? error.reason : "source_error",
      };
    }
    const normalized = normalizeVaultPath(configured?.trim());
    if (normalized) targets.push({ path: normalized, folder: true });
    // No configured folder: Operon routes the file by its parent task, whose
    // folder is already a target; without a parent the destination is unknown.
    else if (configured?.trim() || parentFolders.length === 0) {
      return { hint: FILE_TASK_FOLDER_HINT };
    }
  }
  return { targets: uniqueTargets(targets) };
}

/**
 * Extra targets a plan reveals once made: the notes a native move rewrites
 * (`affectedPaths` of its sealed neighbourhood). `"indeterminate"` when the
 * plan does not state them in a usable form.
 */
function planRevealedTargets(
  family: string,
  receipt: Record<string, any> | undefined,
): VaultInstructionsTarget[] | "indeterminate" {
  if (family !== "obsidian_note_move") return [];
  const affected = receipt?.affectedPaths;
  if (!Array.isArray(affected)) return "indeterminate";
  const targets: VaultInstructionsTarget[] = [];
  for (const entry of affected) {
    const normalized = normalizeVaultPath(entry);
    if (!normalized) return "indeterminate";
    targets.push({ path: normalized });
  }
  return targets;
}

async function gateWrite(
  runtime: VaultInstructionsRuntime,
  name: string,
  role: Extract<ToolRole, { kind: "plan" | "direct" }>,
  args: any[],
  callback: Callback,
) {
  const params: Params = args[0] && typeof args[0] === "object" ? args[0] : {};
  const { mode, reader } = currentVaultInstructionsCall(runtime.settings, args[1]);
  if (mode === "off" || !runtime.source) return callback(...args);
  const spec =
    role.kind === "plan"
      ? planTargets(role.family, params, runtime)
      : directTargets(name, params, runtime);
  if (!spec || spec.kind === "read") return callback(...args);
  const limits = limitsOf(runtime);

  const unavailable = async (reason: VaultInstructionsUnavailableReason) => {
    if (mode === "enforce") {
      return refusal(
        "vault_instructions_unavailable",
        MESSAGES.unavailable(reason, limits),
        report(mode, reader, { unavailableReason: reason }),
        reason !== "too_large",
      );
    }
    const result = await callback(...args);
    return decorateToolResult(
      result,
      report(mode, reader, {
        verified: false,
        unavailableReason: reason,
        message: MESSAGES.adviseUnverifiable(),
      }),
    );
  };

  const resolution = await resolveTargets(runtime, spec);
  if ("unavailable" in resolution) return unavailable(resolution.unavailable);
  let targets: VaultInstructionsTarget[];
  let targetResolved = true;
  let unresolvedHint = "";
  if ("hint" in resolution) {
    if (mode === "enforce") {
      return refusal(
        "vault_instructions_target_unresolved",
        MESSAGES.targetUnresolved(resolution.hint),
        report(mode, reader, { targetResolved: false }),
      );
    }
    targets = [{ path: "", folder: true }];
    targetResolved = false;
    unresolvedHint = resolution.hint;
  } else {
    targets = resolution.targets;
  }

  // Enforce: a plan that cannot be sealed could never be applied.
  if (role.kind === "plan" && mode === "enforce" && !sealJournal(runtime)) {
    return refusal(
      "vault_instructions_unavailable",
      MESSAGES.sealJournalUnavailable(),
      report(mode, reader, { sealed: false, unavailableReason: "seal_journal" }),
      false,
    );
  }

  const evaluate = async (current: VaultInstructionsTarget[]) => {
    const rules = await rulesFor(runtime, current);
    const files = evaluateReader(runtime.ledger, reader, rules.files);
    const complete = files.every((entry) => entry.state === "read");
    const rulesDigest = vaultInstructionsRulesDigest(
      runtime.settings.vaultId,
      runtime.settings.names,
      rules.files,
    );
    return {
      rules,
      complete,
      fields: {
        files: files as ReportFile[],
        targets: targetResolved ? rules.targets : undefined,
        rulesDigest,
        complete,
        targetResolved,
      },
    };
  };

  let evaluation;
  try {
    evaluation = await evaluate(targets);
  } catch (error) {
    if (!(error instanceof VaultInstructionsUnavailableError)) throw error;
    return unavailable(error.reason);
  }

  if (mode === "enforce" && !evaluation.complete) {
    return refusal(
      "vault_instructions_unread",
      MESSAGES.unread(name),
      report(mode, reader, evaluation.fields),
    );
  }

  const result = await callback(...args);

  let sealed: boolean | undefined;
  if (role.kind === "plan" && result?.isError !== true && targetResolved) {
    const receipt = parsedResult(result);
    // A plan may reveal more notes it will write (a move rewrites links).
    const revealed = planRevealedTargets(role.family, receipt);
    if (revealed === "indeterminate") {
      if (mode === "enforce") {
        return refusal(
          "vault_instructions_target_unresolved",
          MESSAGES.planNeighborhoodUnknown(role.family),
          report(mode, reader, { ...evaluation.fields, targetResolved: false, sealed: false }),
        );
      }
      return decorateToolResult(
        result,
        report(mode, reader, {
          ...evaluation.fields,
          sealed: false,
          message: MESSAGES.adviseNeighborhoodUnknown(),
        }),
      );
    }
    const known = new Set(targets.map((target) => target.path));
    const extra = revealed.filter((target) => !known.has(target.path));
    if (extra.length > 0) {
      targets = uniqueTargets([...targets, ...extra]);
      try {
        evaluation = await evaluate(targets);
      } catch (error) {
        if (!(error instanceof VaultInstructionsUnavailableError)) throw error;
        const unavailableReport = report(mode, reader, {
          sealed: false,
          unavailableReason: error.reason,
        });
        if (mode === "enforce") {
          return refusal(
            "vault_instructions_unavailable",
            MESSAGES.unavailable(
              error.reason,
              limits,
              "The plan was recorded but not sealed, so it cannot be applied; nothing was written.",
            ),
            unavailableReport,
            error.reason !== "too_large",
          );
        }
        return decorateToolResult(
          result,
          report(mode, reader, {
            sealed: false,
            verified: false,
            unavailableReason: error.reason,
            message: MESSAGES.adviseUnverifiable(),
          }),
        );
      }
      if (mode === "enforce" && !evaluation.complete) {
        return refusal(
          "vault_instructions_unread",
          MESSAGES.planNeighborhoodUnread(role.family),
          report(mode, reader, { ...evaluation.fields, sealed: false }),
        );
      }
    }
    const planRef = receipt?.planRef;
    if (typeof planRef === "string") {
      // Sealed in advise too, so the plan stays applicable if this client
      // later moves to enforce.
      sealed = persistSeal(runtime, {
        planRef,
        planTool: `${role.family}_plan`,
        mode,
        targets,
        files: evaluation.rules.files,
        rulesDigest: evaluation.fields.rulesDigest,
      });
    }
  }

  const sealMissingUnderEnforce = mode === "enforce" && sealed === false;
  // No instruction file on any chain: the result stays exactly as it was,
  // unless an enforced plan could not be sealed (its apply would be refused).
  if (evaluation.rules.files.length === 0 && !sealMissingUnderEnforce) return result;
  return decorateToolResult(
    result,
    report(mode, reader, {
      ...evaluation.fields,
      sealed,
      message: sealMissingUnderEnforce
        ? MESSAGES.sealNotWritten((role as { family: string }).family)
        : !targetResolved
          ? MESSAGES.adviseUnresolved(unresolvedHint)
          : evaluation.complete
            ? undefined
            : MESSAGES.adviseIncomplete(),
    }),
  );
}

function sealDiff(
  sealed: ReadonlyArray<{ path: string; sha256: string }>,
  current: ReadonlyArray<{ path: string; sha256: string }>,
): ReportFile[] {
  const before = new Map(sealed.map((entry) => [entry.path, entry.sha256]));
  const after = new Map(current.map((entry) => [entry.path, entry.sha256]));
  const files: ReportFile[] = [];
  for (const entry of current) {
    const previous = before.get(entry.path);
    if (previous === undefined) files.push({ path: entry.path, sha256: entry.sha256, state: "added" });
    else if (previous !== entry.sha256) files.push({ path: entry.path, sha256: entry.sha256, state: "changed" });
  }
  for (const entry of sealed) {
    if (!after.has(entry.path)) files.push({ path: entry.path, state: "removed" });
  }
  return files;
}

async function gateApply(
  runtime: VaultInstructionsRuntime,
  name: string,
  family: string,
  args: any[],
  callback: Callback,
) {
  const params: Params = args[0] && typeof args[0] === "object" ? args[0] : {};
  const { mode, reader } = currentVaultInstructionsCall(runtime.settings, args[1]);
  if (mode === "off" || !runtime.source) return callback(...args);
  const planRef = typeof params.planRef === "string" ? params.planRef : undefined;
  const journal = sealJournal(runtime);
  if (!journal && mode === "enforce") {
    return refusal(
      "vault_instructions_unavailable",
      MESSAGES.sealJournalUnavailableApply(family),
      report(mode, reader, {
        sealed: false,
        unavailableReason: "seal_journal",
        nextActions: [{ tool: `${family}_status`, arguments: { planRef } }],
      }),
      false,
    );
  }
  let seal;
  try {
    seal = planRef ? journal?.get(planRef) : undefined;
  } catch {
    seal = undefined;
  }
  if (!seal || seal.planTool !== `${family}_plan`) {
    if (mode === "enforce") {
      return refusal(
        "vault_instructions_plan_unsealed",
        MESSAGES.planUnsealed(family),
        report(mode, reader, { sealed: false, nextActions: [{ tool: `${family}_status`, arguments: { planRef } }] }),
      );
    }
    return callback(...args);
  }

  const limits = limitsOf(runtime);
  let rules;
  try {
    rules = await rulesFor(runtime, seal.targets);
  } catch (error) {
    if (!(error instanceof VaultInstructionsUnavailableError)) throw error;
    if (mode === "enforce") {
      return refusal(
        "vault_instructions_unavailable",
        MESSAGES.unavailable(error.reason, limits, "Nothing was applied by this call."),
        report(mode, reader, { unavailableReason: error.reason }),
        error.reason !== "too_large",
      );
    }
    return callback(...args);
  }
  const rulesDigest = vaultInstructionsRulesDigest(
    runtime.settings.vaultId,
    runtime.settings.names,
    rules.files,
  );
  if (rulesDigest !== seal.rulesDigest) {
    const files = sealDiff(seal.files, rules.files);
    if (mode === "enforce") {
      return refusal(
        "vault_instructions_changed_since_plan",
        MESSAGES.changedSincePlan(family),
        report(mode, reader, {
          files,
          rulesDigest,
          changedSincePlan: true,
          nextActions: [
            { tool: `${family}_status`, arguments: { planRef } },
            ...readActions(files),
          ],
        }),
      );
    }
    const result = await callback(...args);
    return decorateToolResult(
      result,
      report(mode, reader, {
        files,
        rulesDigest,
        changedSincePlan: true,
        message: MESSAGES.adviseChangedSincePlan(family),
      }),
    );
  }

  const files = evaluateReader(runtime.ledger, reader, rules.files);
  const complete = files.every((entry) => entry.state === "read");
  if (mode === "enforce" && !complete) {
    return refusal(
      "vault_instructions_unread",
      MESSAGES.applyUnread(name),
      report(mode, reader, { files: files as ReportFile[], rulesDigest, complete }),
    );
  }
  const result = await callback(...args);
  if (rules.files.length === 0) return result;
  return decorateToolResult(
    result,
    report(mode, reader, {
      files: files as ReportFile[],
      rulesDigest,
      complete,
      message: complete ? undefined : MESSAGES.adviseIncomplete(),
    }),
  );
}

async function recordReadProof(
  runtime: VaultInstructionsRuntime,
  args: any[],
  callback: Callback,
) {
  const params: Params = args[0] && typeof args[0] === "object" ? args[0] : {};
  const { mode, reader } = currentVaultInstructionsCall(runtime.settings, args[1]);
  const requested = normalizeVaultPath(params.filePath);
  const baseName = requested?.split("/").at(-1)?.normalize("NFC");
  if (
    mode === "off" ||
    !runtime.source ||
    !requested ||
    !baseName ||
    !runtime.settings.names.includes(baseName)
  ) {
    return callback(...args);
  }
  if (runtime.refreshCachedInstructionFile) {
    await runtime.refreshCachedInstructionFile(requested).catch(() => undefined);
  }
  const result = await callback(...args);
  if (result?.isError === true) return result;
  const parsed = parsedResult(result);
  const served =
    typeof parsed?.content === "string"
      ? parsed.content
      : typeof parsed?.content?.content === "string"
        ? parsed.content.content
        : undefined;
  if (served === undefined) return result;
  const servedPath =
    typeof parsed?.content?.path === "string"
      ? normalizeVaultPath(parsed.content.path) ?? requested
      : requested;
  try {
    // The proof binds what the reader was served to the authoritative copy,
    // under the path requested and the path the backend reports serving: a
    // stale or differently cased copy records nothing.
    const candidates = [...new Set([requested, servedPath])];
    const authoritative = await probeInstructionFiles(
      runtime.source,
      candidates,
      probeOptions(runtime),
    );
    const sha = instructionContentSha256(served);
    for (const candidate of candidates) {
      const content = authoritative.get(candidate);
      if (typeof content === "string" && instructionContentSha256(content) === sha) {
        runtime.ledger.record(reader.key, candidate, sha);
      }
    }
  } catch {
    /* no proof when the authoritative copy cannot be read */
  }
  return result;
}

const installed = new WeakSet<McpServer>();

/**
 * Wraps the callbacks of the gated tools. Install after the public error
 * boundary and before any tool registration.
 */
export function installVaultInstructionsGate(
  server: McpServer,
  runtime: VaultInstructionsRuntime | undefined,
): void {
  if (!runtime || installed.has(server)) return;
  const register = server.registerTool.bind(server) as Registrar;
  server.registerTool = ((name: string, configuration: unknown, callback: Callback) => {
    const role = vaultInstructionsToolRole(name);
    if (!role || typeof callback !== "function") {
      return register(name, configuration, callback);
    }
    return register(name, configuration, async (...args: any[]) => {
      switch (role.kind) {
        case "read-proof":
          return recordReadProof(runtime, args, callback);
        case "apply":
          return gateApply(runtime, name, role.family, args, callback);
        default:
          return gateWrite(runtime, name, role, args, callback);
      }
    });
  }) as typeof server.registerTool;
  installed.add(server);
}

// ---------------------------------------------------------------------------
// Server instructions

const rootPresence = new WeakMap<
  VaultInstructionsRuntime,
  { at: number; promise: Promise<string[]> }
>();

async function rootInstructionFiles(runtime: VaultInstructionsRuntime): Promise<string[]> {
  const now = runtime.now?.() ?? Date.now();
  const cached = rootPresence.get(runtime);
  if (cached && now - cached.at < 60_000) return cached.promise;
  const promise = (async () => {
    if (!runtime.source) return [];
    try {
      const rules = await currentInstructionRules(
        runtime.source,
        runtime.settings.names,
        [{ path: "", folder: true }],
        probeOptions(runtime),
      );
      return rules.files.map((entry) => entry.path);
    } catch {
      return [];
    }
  })();
  rootPresence.set(runtime, { at: now, promise });
  return promise;
}

/**
 * MCP server instructions: pointers to the instruction files, never their
 * content. `undefined` when the mode is off or the vault root has none.
 */
export async function vaultInstructionsServerText(
  runtime: VaultInstructionsRuntime | undefined,
): Promise<string | undefined> {
  if (!runtime) return undefined;
  const { mode } = currentVaultInstructionsCall(runtime.settings);
  if (mode === "off") return undefined;
  const rootFiles = await rootInstructionFiles(runtime);
  if (rootFiles.length === 0) return undefined;
  const names = runtime.settings.names.join(" or ");
  const lines = [
    `This Obsidian vault defines rules for agents in instruction files (${names}).`,
    `Before planning or making any write, read ${rootFiles.join(" and ")} at the vault root with ${READ_TOOL}, then the ${names} file of every parent folder of the path you will write, when it exists (for Projects/Client/Note.md: Projects/${runtime.settings.names[0]}, then Projects/Client/${runtime.settings.names[0]}). More local files refine the root rules.`,
    "Every write plan and direct write lists the applicable files in vaultInstructions and marks those you have not read in their current version.",
  ];
  if (mode === "enforce") {
    lines.push(
      "Writes are refused with reasonCode vault_instructions_unread until each applicable file has been read with obsidian_read_note in its current version; the refusal lists the exact files to read.",
    );
  }
  return lines.join(" ");
}

export type { EvaluatedInstructionFile };
