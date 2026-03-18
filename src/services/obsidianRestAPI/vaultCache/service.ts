/**
 * @module VaultCacheService
 * @description
 * Persists vault content on disk and keeps only a bounded hot cache in RAM.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../../../config/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
  retryWithDelay,
} from "../../../utils/index.js";
import { NoteJson, ObsidianRestApiService } from "../index.js";

export interface CacheEntry {
  content: string;
  ctime: number;
  mtime: number;
  size: number;
  hash: string;
}

export interface CacheIndexEntry {
  path: string;
  ctime: number;
  mtime: number;
  size: number;
  hash: string;
}

type CacheRow = CacheIndexEntry & { content: string };

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_cache (
  path TEXT PRIMARY KEY,
  ctime INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_cache_mtime ON file_cache (mtime DESC);
`;

function computeContentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function normalizeDirPath(dirPath: string): string {
  const normalized = path.posix.normalize(dirPath === "" ? "/" : dirPath);
  return normalized === "." ? "/" : normalized;
}

/**
 * Disk-backed vault cache with a bounded in-memory hot set.
 */
export class VaultCacheService {
  private readonly metadataCache = new Map<string, CacheIndexEntry>();
  private readonly contentHotCache = new Map<string, CacheEntry>();
  private readonly hotCacheLimit = config.obsidianContentHotCacheLimit;
  private readonly obsidianService: ObsidianRestApiService;
  private readonly db: DatabaseSync;
  private isCacheReady = false;
  private isBuilding = false;
  private refreshIntervalId: NodeJS.Timeout | null = null;

  constructor(obsidianService: ObsidianRestApiService) {
    this.obsidianService = obsidianService;
    this.db = this.initializeDatabase();
    this.loadMetadataSnapshot();
    logger.info(
      "VaultCacheService initialized with persistent shared store.",
      requestContextService.createRequestContext({
        operation: "VaultCacheServiceInit",
        cachePath: config.obsidianSharedCacheDbPath,
      }),
    );
  }

  public startPeriodicRefresh(): void {
    const refreshIntervalMs =
      config.obsidianCacheRefreshIntervalMin * 60 * 1000;
    if (this.refreshIntervalId) {
      logger.warning(
        "Periodic refresh is already running.",
        requestContextService.createRequestContext({
          operation: "startPeriodicRefresh",
        }),
      );
      return;
    }
    this.refreshIntervalId = setInterval(
      () => this.refreshCache().catch(() => undefined),
      refreshIntervalMs,
    );
    logger.info(
      `Vault cache periodic refresh scheduled every ${config.obsidianCacheRefreshIntervalMin} minutes.`,
      requestContextService.createRequestContext({
        operation: "startPeriodicRefresh",
      }),
    );
  }

  public stopPeriodicRefresh(): void {
    const context = requestContextService.createRequestContext({
      operation: "stopPeriodicRefresh",
    });
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
      logger.info("Stopped periodic cache refresh.", context);
      return;
    }
    logger.info("Periodic cache refresh was not running.", context);
  }

  public isReady(): boolean {
    return this.isCacheReady;
  }

  public getIsBuilding(): boolean {
    return this.isBuilding;
  }

  public getCachedFileCount(): number {
    return this.metadataCache.size;
  }

  public getEntriesByPrefix(prefix?: string): CacheIndexEntry[] {
    const normalizedPrefix = prefix ? normalizeDirPath(prefix) : undefined;
    return [...this.metadataCache.values()].filter((entry) => {
      if (!normalizedPrefix || normalizedPrefix === "/") {
        return true;
      }
      return entry.path.startsWith(normalizedPrefix);
    });
  }

  public async getEntry(filePath: string): Promise<CacheEntry | undefined> {
    const cached = this.contentHotCache.get(filePath);
    if (cached) {
      this.touchHotCache(filePath, cached);
      return cached;
    }

    const stmt = this.db.prepare(
      "SELECT path, ctime, mtime, size, hash, content FROM file_cache WHERE path = ?",
    );
    const row = stmt.get(filePath) as CacheRow | undefined;
    if (!row) {
      return undefined;
    }

    const entry: CacheEntry = {
      content: row.content,
      ctime: row.ctime,
      mtime: row.mtime,
      size: row.size,
      hash: row.hash,
    };
    this.touchHotCache(filePath, entry);
    return entry;
  }

  public async updateCacheForFile(
    filePath: string,
    context: RequestContext,
  ): Promise<void> {
    const opContext = { ...context, operation: "updateCacheForFile", filePath };
    logger.debug(`Proactively updating cache for file: ${filePath}`, opContext);
    try {
      const noteJson = await retryWithDelay(
        () =>
          this.obsidianService.getFileContent(
            filePath,
            "json",
            opContext,
          ) as Promise<NoteJson>,
        {
          operationName: "proactiveCacheUpdate",
          context: opContext,
          maxRetries: 3,
          delayMs: 300,
          shouldRetry: (err: unknown) =>
            err instanceof McpError &&
            (err.code === BaseErrorCode.NOT_FOUND ||
              err.code === BaseErrorCode.SERVICE_UNAVAILABLE),
        },
      );

      if (!noteJson || !noteJson.content || !noteJson.stat) {
        logger.warning(
          `Proactive cache update for ${filePath} received invalid data, skipping update.`,
          opContext,
        );
        return;
      }

      this.upsertRow({
        path: filePath,
        ctime: noteJson.stat.ctime,
        mtime: noteJson.stat.mtime,
        size: noteJson.stat.size,
        hash: computeContentHash(noteJson.content),
        content: noteJson.content,
      });
      logger.info(`Proactively updated cache for: ${filePath}`, opContext);
    } catch (error) {
      if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
        this.deleteRow(filePath);
        logger.info(
          `Proactively removed deleted file from cache: ${filePath}`,
          opContext,
        );
        return;
      }
      logger.error(
        `Failed to proactively update cache for ${filePath}. Error: ${error instanceof Error ? error.message : String(error)}`,
        opContext,
      );
    }
  }

  public async buildVaultCache(): Promise<void> {
    const initialBuildContext = requestContextService.createRequestContext({
      operation: "buildVaultCache.initialCheck",
    });
    if (this.isBuilding) {
      logger.warning(
        "Cache build already in progress. Skipping.",
        initialBuildContext,
      );
      return;
    }
    if (this.isCacheReady) {
      logger.info("Cache already built. Skipping.", initialBuildContext);
      return;
    }
    await this.refreshCache(true);
  }

  public async refreshCache(isInitialBuild = false): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: "refreshCache",
      isInitialBuild,
    });

    if (this.isBuilding) {
      logger.warning("Cache refresh already in progress. Skipping.", context);
      return;
    }

    this.isBuilding = true;
    if (isInitialBuild) {
      this.isCacheReady = false;
    }

    logger.info("Starting persistent vault cache refresh process...", context);

    try {
      const startTime = Date.now();
      const remoteFiles = await this.listAllMarkdownFiles("/", context);
      const remoteFileSet = new Set(remoteFiles);
      const cachedFileSet = new Set(this.metadataCache.keys());

      let filesAdded = 0;
      let filesUpdated = 0;
      let filesRemoved = 0;

      for (const cachedFile of cachedFileSet) {
        if (!remoteFileSet.has(cachedFile)) {
          this.deleteRow(cachedFile);
          filesRemoved++;
        }
      }

      for (const filePath of remoteFiles) {
        try {
          const fileMetadata = await this.obsidianService.getFileMetadata(
            filePath,
            context,
          );

          if (!fileMetadata) {
            logger.warning(
              `Skipping file during cache refresh due to missing or invalid metadata: ${filePath}`,
              { ...context, filePath },
            );
            continue;
          }

          const cachedEntry = this.metadataCache.get(filePath);
          const remoteMtime = fileMetadata.mtime;
          const remoteSize = fileMetadata.size;
          const needsRefresh =
            !cachedEntry ||
            cachedEntry.mtime < remoteMtime ||
            cachedEntry.size !== remoteSize;

          if (!needsRefresh) {
            continue;
          }

          const noteJson = (await this.obsidianService.getFileContent(
            filePath,
            "json",
            context,
          )) as NoteJson;
          const hash = computeContentHash(noteJson.content);
          this.upsertRow({
            path: filePath,
            ctime: noteJson.stat.ctime,
            mtime: noteJson.stat.mtime,
            size: noteJson.stat.size,
            hash,
            content: noteJson.content,
          });

          if (!cachedEntry) {
            filesAdded++;
          } else {
            filesUpdated++;
          }
        } catch (error) {
          logger.error(
            `Failed to process file during cache refresh: ${filePath}. Skipping. Error: ${error instanceof Error ? error.message : String(error)}`,
            { ...context, filePath },
          );
        }
      }

      const duration = (Date.now() - startTime) / 1000;
      this.isCacheReady = true;
      logger.info(
        `${
          isInitialBuild ? "Initial vault cache build" : "Vault cache refresh"
        } completed in ${duration.toFixed(2)}s. Added: ${filesAdded}, Updated: ${filesUpdated}, Removed: ${filesRemoved}. Total indexed: ${this.metadataCache.size}.`,
        context,
      );
    } catch (error) {
      logger.error(
        `Critical error during vault cache refresh. Cache may be incomplete. Error: ${error instanceof Error ? error.message : String(error)}`,
        context,
      );
      if (isInitialBuild) {
        this.isCacheReady = false;
      }
    } finally {
      this.isBuilding = false;
    }
  }

  private initializeDatabase(): DatabaseSync {
    const dbPath = config.obsidianSharedCacheDbPath;
    const dirPath = path.dirname(dbPath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(CREATE_SCHEMA_SQL);
    return db;
  }

  private loadMetadataSnapshot(): void {
    const stmt = this.db.prepare(
      "SELECT path, ctime, mtime, size, hash FROM file_cache ORDER BY path ASC",
    );
    const rows = stmt.all() as unknown as CacheIndexEntry[];
    this.metadataCache.clear();
    for (const row of rows) {
      this.metadataCache.set(row.path, row);
    }
    this.isCacheReady = rows.length > 0;
  }

  private touchHotCache(filePath: string, entry: CacheEntry): void {
    this.contentHotCache.delete(filePath);
    this.contentHotCache.set(filePath, entry);
    if (this.contentHotCache.size <= this.hotCacheLimit) {
      return;
    }

    const firstKey = this.contentHotCache.keys().next().value;
    if (firstKey) {
      this.contentHotCache.delete(firstKey);
    }
  }

  private upsertRow(row: CacheRow): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO file_cache (path, ctime, mtime, size, hash, content, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        ctime = excluded.ctime,
        mtime = excluded.mtime,
        size = excluded.size,
        hash = excluded.hash,
        content = excluded.content,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      row.path,
      row.ctime,
      row.mtime,
      row.size,
      row.hash,
      row.content,
      now,
    );

    const indexEntry: CacheIndexEntry = {
      path: row.path,
      ctime: row.ctime,
      mtime: row.mtime,
      size: row.size,
      hash: row.hash,
    };
    this.metadataCache.set(row.path, indexEntry);
    this.touchHotCache(row.path, {
      content: row.content,
      ctime: row.ctime,
      mtime: row.mtime,
      size: row.size,
      hash: row.hash,
    });
  }

  private deleteRow(filePath: string): void {
    const stmt = this.db.prepare("DELETE FROM file_cache WHERE path = ?");
    stmt.run(filePath);
    this.metadataCache.delete(filePath);
    this.contentHotCache.delete(filePath);
  }

  private async listAllMarkdownFiles(
    dirPath: string,
    context: RequestContext,
    visitedDirs: Set<string> = new Set(),
  ): Promise<string[]> {
    const operation = "listAllMarkdownFiles";
    const opContext = { ...context, operation, dirPath };
    const normalizedPath = normalizeDirPath(dirPath);

    if (visitedDirs.has(normalizedPath)) {
      logger.warning(
        `Cycle detected or directory already visited during cache build: ${normalizedPath}. Skipping.`,
        opContext,
      );
      return [];
    }
    visitedDirs.add(normalizedPath);

    let markdownFiles: string[] = [];
    try {
      const entries = await this.obsidianService.listFiles(
        normalizedPath,
        opContext,
      );
      for (const entry of entries) {
        const fullPath = path.posix.join(normalizedPath, entry);
        if (entry.endsWith("/")) {
          const subDirFiles = await this.listAllMarkdownFiles(
            fullPath,
            opContext,
            visitedDirs,
          );
          markdownFiles = markdownFiles.concat(subDirFiles);
        } else if (entry.toLowerCase().endsWith(".md")) {
          markdownFiles.push(fullPath);
        }
      }
      return markdownFiles;
    } catch (error) {
      const errMsg = `Failed to list directory during cache build scan: ${normalizedPath}`;
      const err = error as McpError | Error;
      if (err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND) {
        logger.warning(`${errMsg} - Directory not found, skipping.`, opContext);
        return [];
      }
      if (err instanceof Error) {
        logger.error(errMsg, err, opContext);
      } else {
        logger.error(errMsg, opContext);
      }
      const errorCode =
        err instanceof McpError ? err.code : BaseErrorCode.INTERNAL_ERROR;
      throw new McpError(
        errorCode,
        `${errMsg}: ${err instanceof Error ? err.message : String(err)}`,
        opContext,
      );
    }
  }
}
