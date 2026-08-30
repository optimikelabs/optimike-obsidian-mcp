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
import { attestVaultFilesystemTarget } from "./externalReferences/backendVaultAdapter.js";
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

type PublicRuntimeStatus = {
  ok: boolean;
  transport: string;
  runtimeMode: string;
  runtime: {
    packageVersion: string;
    nodeVersion: string;
    git: {
      available: boolean;
      revision?: string;
    };
    processUptimeSec: number;
    dist: {
      index: PublicFileFingerprint;
      stdioProxy: PublicFileFingerprint;
      newestMtimeMs?: number;
      isNewerThanProcess: boolean;
    };
    configuration: {
      destructiveVaultIdentityVerified?: boolean;
      destructiveVaultAttestationSchemeVersion?: 2;
      vaultConfigured: boolean;
      semanticCacheConfigured: boolean;
      queryEmbeddingEnabled: boolean;
      cacheSource: string;
      writeMode: string;
      protectedFrontmatterKeyCount: number;
    };
  };
  sharedCache: PublicSharedCacheStatus;
  semanticCache: PublicSemanticCacheStatus;
  degradedMode: {
    readOnlyToolCount: number;
    writeToolsRequireApi: boolean;
  };
  writePolicy: {
    mode: string;
    guardedMaxWriteChars: number;
    guardedMaxBatchOperations: number;
    protectedFrontmatterKeyCount: number;
  };
};

type PublicFileFingerprint = {
  exists: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
};

type PublicSharedCacheStatus = {
  dbExists: boolean;
  dbSizeBytes: number;
  dbFileCount: number;
  dbTaskCacheFileCount: number;
  dbSemanticVectorCount: number;
  status?: string;
  ready: boolean;
  building: boolean;
  refreshSource?: string;
  configuredRefreshSource?: string;
  refreshConcurrency?: number;
  schemaVersion?: string | number;
  inMemoryFileCount?: number;
  cachedFileCount?: number;
  hotCacheSize?: number;
  hotCacheLimit?: number;
  lastRefreshAt?: number;
  lastRefreshStartedAt?: number;
  lastRefreshCompletedAt?: number;
  lastRefreshDurationMs?: number;
  lastRefreshFileCount?: number;
  lastRefreshFailed: boolean;
  integrity: {
    checked: boolean;
    ok?: boolean;
  };
};

type PublicSemanticCacheStatus = {
  enabled: boolean;
  ttlMs?: number;
  manifest: null | {
    sourceFileCount: number;
    vectorCount: number;
    dominantDimension?: number;
    refreshedAt?: number;
  };
  memorySnapshotLoadedAt?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numberOr(value: unknown, fallback = 0): number {
  return optionalNumber(value) ?? fallback;
}

function booleanOr(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const PUBLIC_TRANSPORTS = ["stdio", "http"] as const;
const PUBLIC_RUNTIME_MODES = [
  "live",
  "hybrid",
  "headless-readonly",
  "headless-guarded",
  "headless-filesystem",
] as const;
const PUBLIC_CACHE_SOURCES = ["auto", "rest", "filesystem"] as const;
const PUBLIC_WRITE_MODES = ["readonly", "guarded", "full"] as const;
const PUBLIC_CACHE_STATUSES = ["empty", "building", "ready", "error"] as const;

function allowedValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value)
    ? (value as T[number])
    : undefined;
}

function publicVersion(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : undefined;
}

function publicGitRevision(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{7,40}$/iu.test(value)
    ? value
    : undefined;
}

function publicSchemaVersion(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}\.\d+$/u.test(value)
    ? value
    : undefined;
}

function projectPublicFileFingerprint(value: unknown): PublicFileFingerprint {
  const fingerprint = asRecord(value);
  return {
    exists: booleanOr(fingerprint.exists),
    sizeBytes: optionalNumber(fingerprint.sizeBytes),
    mtimeMs: optionalNumber(fingerprint.mtimeMs),
  };
}

function projectPublicSharedCacheStatus(
  value: unknown,
): PublicSharedCacheStatus {
  const sharedCache = asRecord(value);
  const integrity = asRecord(sharedCache.integrity);
  const integrityPresent = sharedCache.integrity !== undefined;

  return {
    dbExists: booleanOr(sharedCache.dbExists),
    dbSizeBytes: numberOr(sharedCache.dbSizeBytes),
    dbFileCount: numberOr(sharedCache.dbFileCount),
    dbTaskCacheFileCount: numberOr(sharedCache.dbTaskCacheFileCount),
    dbSemanticVectorCount: numberOr(sharedCache.dbSemanticVectorCount),
    status: allowedValue(sharedCache.status, PUBLIC_CACHE_STATUSES),
    ready: booleanOr(sharedCache.ready),
    building: booleanOr(sharedCache.building),
    refreshSource: allowedValue(
      sharedCache.refreshSource,
      PUBLIC_CACHE_SOURCES,
    ),
    configuredRefreshSource: allowedValue(
      sharedCache.configuredRefreshSource,
      PUBLIC_CACHE_SOURCES,
    ),
    refreshConcurrency: optionalNumber(sharedCache.refreshConcurrency),
    schemaVersion: publicSchemaVersion(sharedCache.schemaVersion),
    inMemoryFileCount: optionalNumber(sharedCache.inMemoryFileCount),
    cachedFileCount: optionalNumber(sharedCache.cachedFileCount),
    hotCacheSize: optionalNumber(sharedCache.hotCacheSize),
    hotCacheLimit: optionalNumber(sharedCache.hotCacheLimit),
    lastRefreshAt: optionalNumber(sharedCache.lastRefreshAt),
    lastRefreshStartedAt: optionalNumber(sharedCache.lastRefreshStartedAt),
    lastRefreshCompletedAt: optionalNumber(sharedCache.lastRefreshCompletedAt),
    lastRefreshDurationMs: optionalNumber(sharedCache.lastRefreshDurationMs),
    lastRefreshFileCount: optionalNumber(sharedCache.lastRefreshFileCount),
    lastRefreshFailed: Boolean(sharedCache.lastRefreshError),
    integrity: {
      checked: integrityPresent,
      ok: integrityPresent ? booleanOr(integrity.ok) : undefined,
    },
  };
}

function projectPublicSemanticCacheStatus(
  value: unknown,
): PublicSemanticCacheStatus {
  const semanticCache = asRecord(value);
  const manifestValue = semanticCache.manifest;
  const manifest = asRecord(manifestValue);

  return {
    enabled: booleanOr(semanticCache.enabled),
    ttlMs: optionalNumber(semanticCache.ttlMs),
    manifest:
      manifestValue && typeof manifestValue === "object"
        ? {
            sourceFileCount: numberOr(manifest.sourceFileCount),
            vectorCount: numberOr(manifest.vectorCount),
            dominantDimension: optionalNumber(manifest.dominantDim),
            refreshedAt: optionalNumber(manifest.refreshedAt),
          }
        : null,
    memorySnapshotLoadedAt: optionalNumber(
      semanticCache.memorySnapshotLoadedAt,
    ),
  };
}

/**
 * Projects internal runtime diagnostics onto the stable public MCP contract.
 * Internal records intentionally retain local paths and detailed diagnostics;
 * this boundary must never return those values to a tool caller.
 */
export function projectPublicRuntimeStatus(
  value: Record<string, unknown>,
  options: { expectedDestructiveVaultAttestation?: string } = {},
): PublicRuntimeStatus {
  const runtime = asRecord(value.runtime);
  const runtimeGit = asRecord(runtime.git);
  const dist = asRecord(runtime.dist);
  const degradedMode = asRecord(value.degradedMode);
  const writePolicy = asRecord(value.writePolicy);
  const readOnlyTools = Array.isArray(degradedMode.readOnlyWhenRestUnavailable)
    ? degradedMode.readOnlyWhenRestUnavailable
    : [];

  return {
    ok: booleanOr(value.ok, true),
    transport: allowedValue(value.transport, PUBLIC_TRANSPORTS) ?? "unknown",
    runtimeMode:
      allowedValue(value.runtimeMode, PUBLIC_RUNTIME_MODES) ?? "unknown",
    runtime: {
      packageVersion: publicVersion(runtime.packageVersion) ?? "unknown",
      nodeVersion: publicVersion(runtime.nodeVersion) ?? "unknown",
      git: {
        available: typeof runtimeGit.sha === "string",
        revision: publicGitRevision(runtimeGit.shortSha),
      },
      processUptimeSec: numberOr(runtime.processUptimeSec),
      dist: {
        index: projectPublicFileFingerprint(dist.index),
        stdioProxy: projectPublicFileFingerprint(dist.stdioProxy),
        newestMtimeMs: optionalNumber(dist.newestMtimeMs),
        isNewerThanProcess: booleanOr(dist.isNewerThanProcess),
      },
      configuration: {
        ...(options.expectedDestructiveVaultAttestation
          ? {
              // The backend recomputes the opaque filesystem proof locally,
              // but never returns it. A caller receives only whether its
              // supplied 64-hex challenge names this exact target.
              destructiveVaultIdentityVerified:
                config.obsidianRuntimeMode === "headless-filesystem" &&
                attestVaultFilesystemTarget(config.obsidianVaultPath) ===
                  options.expectedDestructiveVaultAttestation,
              destructiveVaultAttestationSchemeVersion: 2 as const,
            }
          : {}),
        vaultConfigured: Boolean(config.obsidianVaultPath),
        semanticCacheConfigured: Boolean(config.smartEnvDir),
        queryEmbeddingEnabled: config.enableQueryEmbedding,
        cacheSource: config.obsidianCacheSource,
        writeMode: config.mcpWriteMode,
        protectedFrontmatterKeyCount: config.mcpProtectedFrontmatterKeys.length,
      },
    },
    sharedCache: projectPublicSharedCacheStatus(value.sharedCache),
    semanticCache: projectPublicSemanticCacheStatus(value.semanticCache),
    degradedMode: {
      readOnlyToolCount: readOnlyTools.length,
      writeToolsRequireApi: booleanOr(degradedMode.writeToolsRequireApi),
    },
    writePolicy: {
      mode: allowedValue(writePolicy.mode, PUBLIC_WRITE_MODES) ?? "unknown",
      guardedMaxWriteChars: numberOr(writePolicy.guardedMaxWriteChars),
      guardedMaxBatchOperations: numberOr(
        writePolicy.guardedMaxBatchOperations,
      ),
      protectedFrontmatterKeyCount: Array.isArray(
        writePolicy.protectedFrontmatterKeys,
      )
        ? writePolicy.protectedFrontmatterKeys.length
        : 0,
    },
  };
}

/** Projects every runtime-maintenance response through the same public DTO. */
export function projectPublicRuntimeMaintenanceResult(
  action: RuntimeMaintenanceAction,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (action === "integrity_check") {
    return projectPublicRuntimeStatus(value);
  }

  const sharedCache = asRecord(value.sharedCache);
  const semanticCache = asRecord(value.semanticCache);
  const tasksCache = asRecord(value.tasksCache);

  return {
    action,
    ...(value.sharedCache === undefined
      ? {}
      : action === "run_maintenance"
        ? {
            sharedCache: {
              vacuum: booleanOr(sharedCache.vacuum),
              analyze: booleanOr(sharedCache.analyze),
              checkpoint:
                sharedCache.checkpoint === "truncate" ? "truncate" : undefined,
            },
          }
        : { sharedCache: projectPublicSharedCacheStatus(sharedCache) }),
    ...(value.semanticCache === undefined
      ? {}
      : { semanticCache: projectPublicSemanticCacheStatus(semanticCache) }),
    ...(value.tasksCache === undefined
      ? {}
      : {
          tasksCache: {
            sourceFileCount: numberOr(tasksCache.sourceFileCount),
            taskFileCount: numberOr(tasksCache.taskFileCount),
          },
        }),
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
