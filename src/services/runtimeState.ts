import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";
import { warmSharedTaskCache } from "../mcp-server/tools/tasksShared/logic.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { RequestContext, requestContextService } from "../utils/index.js";
import { getSemanticCacheService } from "./semanticCache.js";
import type { VaultCacheService } from "./obsidianRestAPI/vaultCache/index.js";

export type RuntimeMaintenanceAction =
  | "integrity_check"
  | "run_maintenance"
  | "refresh_vault_cache"
  | "refresh_semantic_cache"
  | "refresh_tasks_cache"
  | "refresh_all";

type RuntimeStatusOptions = {
  includeIntegrity?: boolean;
  context?: RequestContext;
};

function readDbCounts() {
  if (!existsSync(config.obsidianSharedCacheDbPath)) {
    return {
      dbExists: false,
      dbSizeBytes: 0,
      dbFileCount: 0,
      dbTaskCacheFileCount: 0,
      dbSemanticVectorCount: 0,
    };
  }

  const stats = statSync(config.obsidianSharedCacheDbPath);
  const db = new DatabaseSync(config.obsidianSharedCacheDbPath, {
    readOnly: true,
  });
  try {
    const readCount = (table: string) => {
      try {
        const row = db
          .prepare(`SELECT COUNT(*) as count FROM ${table}`)
          .get() as { count?: number } | undefined;
        return row?.count ?? 0;
      } catch {
        return 0;
      }
    };

    return {
      dbExists: true,
      dbSizeBytes: stats.size,
      dbFileCount: readCount("file_cache"),
      dbTaskCacheFileCount: readCount("task_file_cache"),
      dbSemanticVectorCount: readCount("semantic_vectors"),
    };
  } finally {
    db.close();
  }
}

export async function collectRuntimeStatus(
  vaultCacheService: VaultCacheService | undefined,
  options: RuntimeStatusOptions = {},
): Promise<Record<string, unknown>> {
  const semanticCache = config.smartEnvDir
    ? getSemanticCacheService()
    : null;
  const sharedDb = readDbCounts();
  const integrity =
    options.includeIntegrity && vaultCacheService
      ? vaultCacheService.runIntegrityCheck()
      : undefined;

  return {
    ok: integrity ? integrity.ok : true,
    pid: process.pid,
    transport: config.mcpTransportType,
    sharedCache: {
      ...(vaultCacheService?.getStats() ?? {
        dbPath: config.obsidianSharedCacheDbPath,
        ready: false,
        building: false,
      }),
      ...sharedDb,
      integrity,
    },
    semanticCache: semanticCache
      ? semanticCache.getStats()
      : {
          enabled: false,
          smartEnvDir: config.smartEnvDir,
        },
    degradedMode: {
      readOnlyWhenRestUnavailable: [
        "obsidian_read_note",
        "obsidian_list_notes",
        "obsidian_global_search",
        "smart_semantic_search",
        "list_all_tasks",
        "query_tasks",
      ],
      writeToolsRequireApi: true,
    },
  };
}

export async function runRuntimeMaintenance(
  action: RuntimeMaintenanceAction,
  vaultCacheService: VaultCacheService | undefined,
): Promise<Record<string, unknown>> {
  const context = requestContextService.createRequestContext({
    operation: "runRuntimeMaintenance",
    action,
  });

  if (!vaultCacheService && action !== "integrity_check") {
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "Vault cache service is disabled; runtime maintenance is unavailable.",
      context,
    );
  }

  const semanticCache = config.smartEnvDir
    ? getSemanticCacheService()
    : null;

  switch (action) {
    case "integrity_check":
      return collectRuntimeStatus(vaultCacheService, {
        includeIntegrity: true,
        context,
      });
    case "run_maintenance":
      return {
        action,
        sharedCache: vaultCacheService?.runMaintenance(),
        semanticCache: semanticCache
          ? semanticCache.getStats()
          : {
              enabled: false,
            },
      };
    case "refresh_vault_cache":
      await vaultCacheService!.rebuildFromSource();
      return {
        action,
        sharedCache: vaultCacheService!.getStats(),
      };
    case "refresh_semantic_cache":
      if (!semanticCache) {
        throw new McpError(
          BaseErrorCode.SERVICE_UNAVAILABLE,
          "SMART_ENV_DIR is not configured; semantic cache is unavailable.",
          context,
        );
      }
      semanticCache.forceRefresh();
      await semanticCache.getSnapshot(context);
      return {
        action,
        semanticCache: semanticCache.getStats(),
      };
    case "refresh_tasks_cache":
      return {
        action,
        tasksCache: await warmSharedTaskCache(vaultCacheService),
      };
    case "refresh_all":
      await vaultCacheService!.rebuildFromSource();
      if (semanticCache) {
        semanticCache.forceRefresh();
        await semanticCache.getSnapshot(context);
      }
      return {
        action,
        sharedCache: vaultCacheService!.getStats(),
        semanticCache: semanticCache
          ? semanticCache.getStats()
          : {
              enabled: false,
            },
        tasksCache: await warmSharedTaskCache(vaultCacheService),
      };
    default:
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Unsupported runtime maintenance action: ${String(action)}`,
        context,
      );
  }
}
