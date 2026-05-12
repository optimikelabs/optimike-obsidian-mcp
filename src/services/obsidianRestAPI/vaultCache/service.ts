/**
 * @module VaultCacheService
 * @description
 * Persists vault content on disk and keeps only a bounded hot cache in RAM.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
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
type CacheRefreshSource = "rest" | "filesystem";

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
CREATE TABLE IF NOT EXISTS shared_cache_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const SHARED_CACHE_SCHEMA_VERSION = "2026-03-18.1";

function computeContentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function normalizeDirPath(dirPath: string): string {
  const candidate = dirPath === "" ? "/" : dirPath;
  const normalized = path.posix.normalize(
    candidate.startsWith("/") ? candidate : `/${candidate}`,
  );
  return normalized === "." ? "/" : normalized;
}

function getVaultRoot(): string | undefined {
  return config.obsidianVaultPath
    ? path.resolve(config.obsidianVaultPath)
    : undefined;
}

function vaultRelativePathFromAbsolute(filePath: string, vaultRoot: string): string {
  return `/${path.relative(vaultRoot, filePath).replace(/\\/g, "/")}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
    async () => {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await worker(items[currentIndex]);
      }
    },
  );
  await Promise.all(workers);
  return results;
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
    this.ensureMetadata();
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

  public getStats(): Record<string, unknown> {
    return {
      dbPath: config.obsidianSharedCacheDbPath,
      refreshSource: this.readMetadataValue("last_refresh_source"),
      configuredRefreshSource: config.obsidianCacheSource,
      refreshConcurrency: config.obsidianCacheConcurrency,
      schemaVersion:
        this.readMetadataValue("schema_version") ?? SHARED_CACHE_SCHEMA_VERSION,
      ready: this.isCacheReady,
      building: this.isBuilding,
      inMemoryFileCount: this.metadataCache.size,
      cachedFileCount: this.metadataCache.size,
      hotCacheSize: this.contentHotCache.size,
      hotCacheLimit: this.hotCacheLimit,
      lastRefreshAt: this.readMetadataNumber("last_refresh_at"),
    };
  }

  public runIntegrityCheck(): { ok: boolean; result: string } {
    const row = this.db.prepare("PRAGMA integrity_check;").get() as
      | { integrity_check?: string }
      | undefined;
    const result = row?.integrity_check ?? "unknown";
    return { ok: result === "ok", result };
  }

  public runMaintenance(): { vacuum: boolean; analyze: boolean; checkpoint: string } {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.exec("VACUUM;");
    this.db.exec("ANALYZE;");
    return {
      vacuum: true,
      analyze: true,
      checkpoint: "truncate",
    };
  }

  public async rebuildFromSource(): Promise<void> {
    this.isCacheReady = false;
    this.contentHotCache.clear();
    await this.refreshCache(true);
  }

  public findMatchingPath(filePath: string): string | undefined {
    const normalizedInput = normalizeDirPath(filePath);
    if (this.metadataCache.has(normalizedInput)) {
      return normalizedInput;
    }

    const normalized = normalizedInput.toLowerCase();
    for (const candidate of this.metadataCache.keys()) {
      if (candidate.toLowerCase() === normalized) {
        return candidate;
      }
    }
    return undefined;
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
      const refreshSource = await this.pickRefreshSource();
      const remoteFiles =
        refreshSource === "filesystem"
          ? await this.listAllMarkdownFilesFromFilesystem(context)
          : await this.listAllMarkdownFiles("/", context);
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

      const processFile = async (filePath: string): Promise<"added" | "updated" | "skipped" | "failed"> => {
        try {
          const cachedEntry = this.metadataCache.get(filePath);
          if (refreshSource === "filesystem") {
            const vaultRoot = getVaultRoot();
            if (!vaultRoot) {
              return "failed";
            }
            const absolutePath = path.join(vaultRoot, filePath.replace(/^\/+/u, ""));
            const stats = await fs.stat(absolutePath);
            const remoteMtime = Math.round(stats.mtimeMs);
            const remoteSize = stats.size;
            const needsRefresh =
              !cachedEntry ||
              cachedEntry.mtime < remoteMtime ||
              cachedEntry.size !== remoteSize;

            if (!needsRefresh) {
              return "skipped";
            }

            const content = await fs.readFile(absolutePath, "utf-8");
            this.upsertRow({
              path: filePath,
              ctime: Math.round(stats.ctimeMs),
              mtime: remoteMtime,
              size: remoteSize,
              hash: computeContentHash(content),
              content,
            });
            return cachedEntry ? "updated" : "added";
          }

          const fileMetadata = await this.obsidianService.getFileMetadata(
            filePath,
            context,
          );

          if (!fileMetadata) {
            logger.warning(
              `Skipping file during cache refresh due to missing or invalid metadata: ${filePath}`,
              { ...context, filePath },
            );
            return "failed";
          }

          const remoteMtime = fileMetadata.mtime;
          const remoteSize = fileMetadata.size;
          const needsRefresh =
            !cachedEntry ||
            cachedEntry.mtime < remoteMtime ||
            cachedEntry.size !== remoteSize;

          if (!needsRefresh) {
            return "skipped";
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

          return cachedEntry ? "updated" : "added";
        } catch (error) {
          logger.error(
            `Failed to process file during cache refresh: ${filePath}. Skipping. Error: ${error instanceof Error ? error.message : String(error)}`,
            { ...context, filePath, refreshSource },
          );
          return "failed";
        }
      };

      const outcomes =
        refreshSource === "filesystem"
          ? await mapWithConcurrency(
              remoteFiles,
              config.obsidianCacheConcurrency,
              processFile,
            )
          : [];

      if (refreshSource === "rest") {
        for (const filePath of remoteFiles) {
          const outcome = await processFile(filePath);
          outcomes.push(outcome);
        }
      }

      filesAdded += outcomes.filter((outcome) => outcome === "added").length;
      filesUpdated += outcomes.filter((outcome) => outcome === "updated").length;

      const duration = (Date.now() - startTime) / 1000;
      this.isCacheReady = true;
      this.upsertMetadataValue("last_refresh_at", String(Date.now()));
      this.upsertMetadataValue("last_refresh_source", refreshSource);
      logger.info(
        `${
          isInitialBuild ? "Initial vault cache build" : "Vault cache refresh"
        } completed in ${duration.toFixed(2)}s via ${refreshSource}. Added: ${filesAdded}, Updated: ${filesUpdated}, Removed: ${filesRemoved}. Total indexed: ${this.metadataCache.size}.`,
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

  private ensureMetadata(): void {
    this.upsertMetadataValue("schema_version", SHARED_CACHE_SCHEMA_VERSION);
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

  private readMetadataValue(key: string): string | undefined {
    const stmt = this.db.prepare(
      "SELECT value FROM shared_cache_metadata WHERE key = ?",
    );
    const row = stmt.get(key) as { value?: string } | undefined;
    return row?.value;
  }

  private readMetadataNumber(key: string): number | undefined {
    const raw = this.readMetadataValue(key);
    if (!raw) {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  private upsertMetadataValue(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO shared_cache_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    stmt.run(key, value, Date.now());
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

  private async pickRefreshSource(): Promise<CacheRefreshSource> {
    if (config.obsidianCacheSource === "rest") {
      return "rest";
    }
    if (config.obsidianCacheSource === "filesystem") {
      return getVaultRoot() && existsSync(getVaultRoot()!) ? "filesystem" : "rest";
    }
    const vaultRoot = getVaultRoot();
    return vaultRoot && existsSync(vaultRoot) ? "filesystem" : "rest";
  }

  private async listAllMarkdownFilesFromFilesystem(
    context: RequestContext,
  ): Promise<string[]> {
    const vaultRoot = getVaultRoot();
    if (!vaultRoot) {
      return [];
    }

    const markdownFiles: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        logger.warning(
          `Failed to read local vault directory during cache refresh: ${directory}`,
          {
            ...context,
            operation: "listAllMarkdownFilesFromFilesystem",
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return;
      }

      for (const entry of entries) {
        if (entry.name === ".obsidian" || entry.name === ".trash" || entry.name === ".git") {
          continue;
        }
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          markdownFiles.push(vaultRelativePathFromAbsolute(fullPath, vaultRoot));
        }
      }
    };

    await walk(vaultRoot);
    markdownFiles.sort((a, b) => a.localeCompare(b));
    return markdownFiles;
  }
}
