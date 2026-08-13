import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import nodePath from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import { z } from "zod";
import { config } from "../../../config/index.js";
import { validateObsidianMarkdown } from "../../../services/obsidianFormatService.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
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

const PLAN_REF_PREFIX = "obsidian-note-replace:v1:";

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
  const validation = validateObsidianMarkdown(nextContent);
  if (!validation.ok) {
    throw new McpError(
      phase === "plan" ? BaseErrorCode.VALIDATION_ERROR : BaseErrorCode.FORBIDDEN,
      "The sealed next content is not valid conservative Obsidian Markdown.",
      {
        validationErrors: validation.errors.map(({ code, message, path }) => ({
          code,
          message,
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
      phase === "plan" ? BaseErrorCode.VALIDATION_ERROR : BaseErrorCode.FORBIDDEN,
      `Protected frontmatter cannot be compared safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
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

  withContext<T>(context: CallContext, operation: () => Promise<T>): Promise<T> {
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
    throw new Error("The plan reference is not an obsidian.note.replace V1 plan.");
  }
  const operationId = reference.slice(PLAN_REF_PREFIX.length);
  if (!z.string().uuid().safeParse(operationId).success) {
    throw new Error("The note-replacement plan reference is malformed.");
  }
  return operationId;
}

function machineStateRoot(): string {
  return (
    process.env.LOCALAPPDATA ||
    process.env.XDG_STATE_HOME ||
    nodePath.join(os.homedir(), ".local", "state")
  );
}

function journalPath(): string {
  const configured =
    process.env.MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH?.trim();
  if (configured) {
    if (!nodePath.isAbsolute(configured)) {
      throw new McpError(
        BaseErrorCode.CONFIGURATION_ERROR,
        "MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH must be absolute.",
      );
    }
    return configured;
  }
  return nodePath.join(
    machineStateRoot(),
    "optimike-obsidian-mcp",
    "obsidian-note-replace.sqlite",
  );
}

export class GovernedNoteReplaceRuntime {
  private closed = false;

  constructor(
    private readonly backend: GovernedAtomicWriteBackend,
    private readonly journal: ObsidianNoteReplaceJournal,
    private readonly adapter: ObsidianNoteReplaceOperationAdapter,
  ) {}

  plan(input: ObsidianNoteReplacePlanInput): Promise<OperationReceipt> {
    assertCurrentWritePolicy("plan", input.path, input.nextContent);
    return this.backend.withContext(
      { kind: "plan", path: input.path, nextContent: input.nextContent },
      () => this.adapter.plan(input),
    );
  }

  apply(reference: string, idempotencyKey: string): Promise<OperationReceipt> {
    const plan = this.required(reference);
    assertCurrentWritePolicy("apply", plan.path, plan.nextContent);
    return this.backend.withContext({ kind: "apply" }, () =>
      this.adapter.apply(reference, idempotencyKey),
    );
  }

  status(reference: string): Promise<OperationReceipt> {
    return this.adapter.status(reference);
  }

  recover(reference: string, idempotencyKey: string): Promise<OperationReceipt> {
    const plan = this.required(reference);
    assertCurrentWritePolicy("recover", plan.path, plan.nextContent);
    return this.backend.withContext({ kind: "recover" }, () =>
      this.adapter.recover(reference, idempotencyKey),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.journal.close();
  }

  private required(reference: string): ObsidianNoteReplacePlan {
    const plan = this.journal.get(operationIdFromRef(reference));
    if (!plan) throw new Error("Unknown note-replacement operation plan.");
    return plan;
  }
}

let singleton: GovernedNoteReplaceRuntime | undefined;
let exitHookInstalled = false;

function runtimeEnabled(): boolean {
  return (
    config.obsidianRuntimeMode === "live" ||
    (config.obsidianRuntimeMode === "hybrid" && Boolean(config.obsidianApiKey))
  );
}

export function getGovernedNoteReplaceRuntime():
  | GovernedNoteReplaceRuntime
  | undefined {
  if (!runtimeEnabled()) return undefined;
  if (singleton) return singleton;

  const journal = new ObsidianNoteReplaceJournal(journalPath());
  const backend = new GovernedAtomicWriteBackend(
    new RestAtomicWriteBackend(new ObsidianRestApiService()),
  );
  const adapter = new ObsidianNoteReplaceOperationAdapter(backend, journal);
  singleton = new GovernedNoteReplaceRuntime(backend, journal, adapter);

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => singleton?.close());
  }
  return singleton;
}
