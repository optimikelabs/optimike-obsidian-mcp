import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";
import { warmSharedTaskCache } from "../mcp-server/tools/tasksShared/logic.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { RequestContext, requestContextService } from "../utils/index.js";
import { getSemanticCacheService } from "./semanticCache.js";
import { getWritePolicyStatus } from "./writePolicy.js";
import type { VaultCacheService } from "./obsidianRestAPI/vaultCache/index.js";

const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);

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

type FileFingerprint = {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
};

function safeFileFingerprint(filePath: string): FileFingerprint {
  try {
    const stats = statSync(filePath);
    return {
      path: filePath,
      exists: true,
      sizeBytes: stats.size,
      mtimeMs: Math.round(stats.mtimeMs),
    };
  } catch {
    return {
      path: filePath,
      exists: false,
    };
  }
}

function readGitSha(): { sha?: string; shortSha?: string; error?: string } {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: config.projectRoot,
      encoding: "utf-8",
      windowsHide: true,
    });
    if (result.status !== 0) {
      return {
        error: (
          result.stderr ||
          result.stdout ||
          "git rev-parse failed"
        ).trim(),
      };
    }
    const sha = result.stdout.trim();
    return {
      sha,
      shortSha: sha.slice(0, 7),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function hashRuntimeConfig(): {
  hash: string;
  fields: Record<string, unknown>;
} {
  const fields = {
    obsidianRuntimeMode: config.obsidianRuntimeMode,
    mcpTransportType: config.mcpTransportType,
    mcpHttpHost: config.mcpHttpHost,
    mcpHttpPort: config.mcpHttpPort,
    obsidianBaseUrl: config.obsidianBaseUrl,
    obsidianVaultPath: config.obsidianVaultPath,
    obsidianSharedCacheDbPath: config.obsidianSharedCacheDbPath,
    obsidianContentHotCacheLimit: config.obsidianContentHotCacheLimit,
    obsidianCacheSource: config.obsidianCacheSource,
    obsidianCacheConcurrency: config.obsidianCacheConcurrency,
    obsidianStartupBlocking: config.obsidianStartupBlocking,
    mcpWriteMode: config.mcpWriteMode,
    mcpGuardedMaxWriteChars: config.mcpGuardedMaxWriteChars,
    mcpGuardedMaxBatchOperations: config.mcpGuardedMaxBatchOperations,
    mcpProtectedFrontmatterKeys: config.mcpProtectedFrontmatterKeys,
    smartEnvDir: config.smartEnvDir,
    enableQueryEmbedding: config.enableQueryEmbedding,
    queryEmbedder: config.queryEmbedder,
    queryEmbedderModel: config.queryEmbedderModel,
    ollamaBaseUrl: config.ollamaBaseUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    smartEnvCacheTtlMs: config.smartEnvCacheTtlMs,
    semanticSearchPrewarm: config.semanticSearchPrewarm,
    semanticSearchPrewarmText: config.semanticSearchPrewarmText,
  };
  return {
    hash: createHash("sha256").update(JSON.stringify(fields)).digest("hex"),
    fields,
  };
}

function collectRuntimeFingerprint(): Record<string, unknown> {
  const configHash = hashRuntimeConfig();
  const distIndex = safeFileFingerprint(
    path.join(config.projectRoot, "dist", "index.js"),
  );
  const distStdioProxy = safeFileFingerprint(
    path.join(config.projectRoot, "dist", "stdio-proxy.js"),
  );
  const newestDistMtimeMs = Math.max(
    distIndex.mtimeMs ?? 0,
    distStdioProxy.mtimeMs ?? 0,
  );
  const distIsNewerThanProcess =
    newestDistMtimeMs > 0 && newestDistMtimeMs > PROCESS_STARTED_AT_MS + 1000;

  return {
    packageName: config.pkg.name,
    packageVersion: config.pkg.version,
    git: readGitSha(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
    processUptimeSec: Math.round(process.uptime()),
    cwd: process.cwd(),
    projectRoot: config.projectRoot,
    entrypoint: process.argv[1],
    dist: {
      index: distIndex,
      stdioProxy: distStdioProxy,
      newestMtimeMs: newestDistMtimeMs || undefined,
      isNewerThanProcess: distIsNewerThanProcess,
    },
    configHash: configHash.hash,
    configFields: configHash.fields,
  };
}

export async function collectRuntimeStatus(
  vaultCacheService: VaultCacheService | undefined,
  options: RuntimeStatusOptions = {},
): Promise<Record<string, unknown>> {
  const semanticCache = config.smartEnvDir ? getSemanticCacheService() : null;
  const sharedDb = readDbCounts();
  const integrity =
    options.includeIntegrity && vaultCacheService
      ? vaultCacheService.runIntegrityCheck()
      : undefined;

  return {
    ok: integrity ? integrity.ok : true,
    pid: process.pid,
    transport: config.mcpTransportType,
    runtimeMode: config.obsidianRuntimeMode,
    runtime: collectRuntimeFingerprint(),
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
    writePolicy: getWritePolicyStatus(),
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

  const semanticCache = config.smartEnvDir ? getSemanticCacheService() : null;

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
