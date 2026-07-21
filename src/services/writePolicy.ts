import { config } from "../config/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { RequestContext } from "../utils/index.js";

export type WriteOperation =
  | "obsidian_delete_note"
  | "obsidian_move_note"
  | "obsidian_admin_filesystem"
  | "obsidian_manage_canvas"
  | "obsidian_update_note"
  | "obsidian_search_replace"
  | "obsidian_manage_frontmatter"
  | "obsidian_batch_frontmatter"
  | "obsidian_manage_tags"
  | "bases_create"
  | "bases_upsert_config"
  | "bases_upsert_rows"
	| "operon_adopt_task"
  | "operon_create_task"
  | "operon_update_task"
  | "operon_transition_task"
  | "operon_convert_task";

type GuardCheck = {
  operation: WriteOperation;
  action: string;
  target?: string;
  destructive?: boolean;
  targetType?: string;
  contentLength?: number;
  batchCount?: number;
  frontmatterKeys?: string[];
  allowInReadonly?: boolean;
  allowInGuarded?: boolean;
  guardedReason?: string;
  context?: RequestContext;
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function protectedKeyMatches(keys: string[] | undefined): string[] {
  if (!keys?.length) return [];
  const protectedKeys = new Set(
    config.mcpProtectedFrontmatterKeys.map((key) => normalizeKey(key)),
  );
  return keys.filter((key) => protectedKeys.has(normalizeKey(key)));
}

function reject(check: GuardCheck, reason: string): never {
  throw new McpError(
    BaseErrorCode.FORBIDDEN,
    `${check.operation} blocked by MCP_WRITE_MODE=${config.mcpWriteMode}: ${reason}`,
    {
      ...(check.context ?? {}),
      writeMode: config.mcpWriteMode,
      operation: check.operation,
      action: check.action,
      target: check.target,
    },
  );
}

export function assertWriteAllowed(check: GuardCheck): void {
  if (config.mcpWriteMode === "full") {
    return;
  }

  if (config.mcpWriteMode === "readonly") {
    if (check.allowInReadonly) return;
    reject(check, "server is running in read-only mode");
  }

  if (check.allowInGuarded) {
    return;
  }

  if (check.destructive) {
    reject(check, "destructive operations require MCP_WRITE_MODE=full");
  }

  if (check.targetType && check.targetType !== "filePath") {
    reject(
      check,
      "guarded mode requires an explicit vault-relative filePath target",
    );
  }

  if (
    typeof check.contentLength === "number" &&
    check.contentLength > config.mcpGuardedMaxWriteChars
  ) {
    reject(
      check,
      `write content is ${check.contentLength} characters, above MCP_GUARDED_MAX_WRITE_CHARS=${config.mcpGuardedMaxWriteChars}`,
    );
  }

  if (
    typeof check.batchCount === "number" &&
    check.batchCount > config.mcpGuardedMaxBatchOperations
  ) {
    reject(
      check,
      `batch contains ${check.batchCount} operations, above MCP_GUARDED_MAX_BATCH_OPERATIONS=${config.mcpGuardedMaxBatchOperations}`,
    );
  }

  const blockedKeys = protectedKeyMatches(check.frontmatterKeys);
  if (blockedKeys.length > 0) {
    reject(
      check,
      `protected frontmatter keys cannot be modified in guarded mode: ${blockedKeys.join(", ")}`,
    );
  }

  if (check.guardedReason) {
    reject(check, check.guardedReason);
  }
}

export function getWritePolicyStatus(): Record<string, unknown> {
  return {
    mode: config.mcpWriteMode,
    guardedMaxWriteChars: config.mcpGuardedMaxWriteChars,
    guardedMaxBatchOperations: config.mcpGuardedMaxBatchOperations,
    protectedFrontmatterKeys: config.mcpProtectedFrontmatterKeys,
  };
}
