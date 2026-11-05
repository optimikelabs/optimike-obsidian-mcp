import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  currentInstructionRules,
  evaluateReader,
  instructionContentSha256,
  normalizeVaultPath,
  VAULT_INSTRUCTIONS_CONTRACT_VERSION,
  VaultInstructionsReadLedger,
  vaultInstructionsRulesDigest,
  VaultInstructionsUnavailableError,
  type EvaluatedInstructionFile,
  type VaultInstructionsReader,
  type VaultInstructionsSource,
  type VaultInstructionsTarget,
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
 * - `off`, or a vault without instruction files on the target chains, leaves
 *   every call and result unchanged.
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
  /** Headless: refresh the cached copy of an instruction file before a read. */
  refreshCachedInstructionFile?: (vaultPath: string) => Promise<void>;
  probeOptions?: { concurrency?: number; probeTimeoutMs?: number };
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
      operonIds: string[];
      targets: VaultInstructionsTarget[];
    };

type Params = Record<string, any>;

const ACTIVE_FILE_HINT =
  "Call it again with targetType \"filePath\" and the vault path in targetIdentifier.";

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
      return p.operation === "list" || p.operation === "index"
        ? { kind: "read" }
        : explicit(file(p.filePath), 1);
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
      if (task.targetPath !== undefined) return explicit(file(task.targetPath), 1);
      if (task.targetFolder !== undefined) return explicit(folder(task.targetFolder), 1);
      return {
        kind: "unresolved",
        hint: "Give task.targetPath (inline task) so the note that receives the task is known.",
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
    case "operon_convert_task":
    case "operon_relocate_task":
      return typeof p.operonId === "string"
        ? {
            kind: "operon",
            operonIds: [p.operonId],
            targets: p.targetPath !== undefined ? file(p.targetPath) : [],
          }
        : { kind: "unresolved", hint: "Give the task operonId." };
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

const MESSAGES = {
  unread: (tool: string) =>
    `This vault has agent instructions that apply to this write. Nothing was planned or written. Read each file listed with state unread or changed using ${READ_TOOL}, then call ${tool} again with the same arguments.`,
  applyUnread: (tool: string) =>
    `This vault has agent instructions that apply to this plan. Nothing was applied by this call. Read each file listed with state unread or changed using ${READ_TOOL}, then call ${tool} again with the same arguments.`,
  changedSincePlan: (family: string) =>
    `The instructions that apply to this plan changed after it was made. Nothing was applied by this call. ${statusSentence(family)} read each file listed with state changed or added using ${READ_TOOL}, then plan again with ${family}_plan, reusing your previous arguments only if the new instructions do not change your intent. ${statusTail(family)}`,
  planUnsealed: (family: string) =>
    `This plan has no instruction seal (it was made before instructions were enforced for this client, with instructions off, or its seal expired). Nothing was applied by this call. ${statusSentence(family)} read the applicable instruction files with ${READ_TOOL}, then plan again with ${family}_plan. ${statusTail(family)}`,
  targetUnresolved: (hint: string) =>
    `The vault path this call would write cannot be determined, so the agent instructions that apply to it cannot be checked. Nothing was planned or written. ${hint}`,
  unavailable: () =>
    "The agent instruction files that apply to this write could not be checked right now. Nothing was planned or written. Retry the same call later.",
  adviseIncomplete: () =>
    `This vault has agent instructions for this path. Read each file listed with state unread or changed using ${READ_TOOL} before applying or writing; more local files refine the root rules.`,
  adviseChangedSincePlan: (family: string) =>
    `The instructions that apply to this plan changed after it was made. Read the files listed with state changed or added, then plan again with ${family}_plan if they change your intent.`,
  adviseUnverifiable: () =>
    "The agent instruction files that apply to this write could not be checked; read AGENTS.md and the instruction files of the parent folders of the target before writing.",
  adviseUnresolved: (hint: string) =>
    `The vault path of this write is not known, so only the root instructions are listed. ${hint}`,
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
              retryable: code !== "vault_instructions_target_unresolved",
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

async function resolveTargets(
  runtime: VaultInstructionsRuntime,
  spec: Exclude<TargetSpec, { kind: "read" }>,
): Promise<{ targets: VaultInstructionsTarget[] } | { hint: string }> {
  if (spec.kind === "unresolved") return { hint: spec.hint };
  if (spec.kind === "targets") return { targets: spec.targets };
  const targets = [...spec.targets];
  for (const operonId of spec.operonIds) {
    let resolved: string | undefined;
    try {
      resolved = await runtime.resolveOperonTaskPath?.(operonId);
    } catch {
      resolved = undefined;
    }
    const normalized = normalizeVaultPath(resolved);
    if (!normalized) {
      return {
        hint: "The note that holds this Operon task could not be resolved; check the operonId with operon_get_task, then retry.",
      };
    }
    targets.push({ path: normalized });
  }
  return { targets };
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

  const resolution = await resolveTargets(runtime, spec);
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

  let rules;
  try {
    rules = await currentInstructionRules(
      runtime.source,
      runtime.settings.names,
      targets,
      runtime.probeOptions,
    );
  } catch (error) {
    if (!(error instanceof VaultInstructionsUnavailableError)) throw error;
    if (mode === "enforce") {
      return refusal(
        "vault_instructions_unavailable",
        MESSAGES.unavailable(),
        report(mode, reader, {}),
      );
    }
    const result = await callback(...args);
    return decorateToolResult(
      result,
      report(mode, reader, { verified: false, message: MESSAGES.adviseUnverifiable() }),
    );
  }

  const files = evaluateReader(runtime.ledger, reader, rules.files);
  const complete = files.every((entry) => entry.state === "read");
  const rulesDigest = vaultInstructionsRulesDigest(
    runtime.settings.vaultId,
    runtime.settings.names,
    rules.files,
  );
  const fields = {
    files: files as ReportFile[],
    targets: targetResolved ? rules.targets : undefined,
    rulesDigest,
    complete,
    targetResolved,
  };

  if (mode === "enforce" && !complete) {
    return refusal("vault_instructions_unread", MESSAGES.unread(name), report(mode, reader, fields));
  }

  const result = await callback(...args);

  let sealed: boolean | undefined;
  if (role.kind === "plan" && result?.isError !== true && targetResolved) {
    const planRef = parsedResult(result)?.planRef;
    if (typeof planRef === "string" && (mode === "enforce" || rules.files.length > 0)) {
      try {
        runtime.seals()?.seal({
          planRef,
          planTool: `${role.family}_plan`,
          mode,
          targets,
          files: rules.files,
          rulesDigest,
        });
        sealed = true;
      } catch {
        sealed = false;
      }
    }
  }

  // No instruction file on any chain: the result stays exactly as it was.
  if (rules.files.length === 0) return result;
  return decorateToolResult(
    result,
    report(mode, reader, {
      ...fields,
      sealed,
      message: !targetResolved
        ? MESSAGES.adviseUnresolved(unresolvedHint)
        : complete
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
  let seal;
  try {
    seal = planRef ? runtime.seals()?.get(planRef) : undefined;
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

  let rules;
  try {
    rules = await currentInstructionRules(
      runtime.source,
      runtime.settings.names,
      seal.targets,
      runtime.probeOptions,
    );
  } catch (error) {
    if (!(error instanceof VaultInstructionsUnavailableError)) throw error;
    if (mode === "enforce") {
      return refusal("vault_instructions_unavailable", MESSAGES.unavailable(), report(mode, reader, {}));
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
  const baseName = requested?.split("/").at(-1);
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
    // The proof binds what the reader was served to the authoritative copy:
    // a stale or differently cased copy records nothing.
    const authoritative = await runtime.source.read(servedPath);
    const sha = instructionContentSha256(served);
    if (authoritative !== null && instructionContentSha256(authoritative) === sha) {
      runtime.ledger.record(reader.key, servedPath, sha);
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
        runtime.probeOptions,
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
