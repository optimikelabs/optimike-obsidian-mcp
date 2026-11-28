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
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import ignore from "ignore";
import { config } from "../../../config/index.js";
import {
  createVaultExclusionMatcher,
  DEFAULT_VAULT_EXCLUDE_PATTERNS,
  isVaultPathExcluded,
  normalizeVaultRelativePath,
} from "../../vaultExclusions.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
  retryWithDelay,
} from "../../../utils/index.js";
import { NoteJson, ObsidianRestApiService } from "../index.js";
import type { FilesystemNoteLinksResponse } from "../types.js";
import { CacheEventSupervisor } from "./eventSupervisor.js";
import { MarkdownLinkIndex } from "./markdownLinkIndex.js";
import { foldedPath, readVaultAppSettings } from "../../operations/headlessVaultFiles.js";
import {
  applyWalSizeLimit,
  checkpointWal,
  type WalCheckpointResult,
} from "../../sqliteWal.js";

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
type CacheReadinessStatus = "empty" | "building" | "ready" | "error";
export type CacheUpdateResult =
  | { ok: true; disposition: "updated" | "absent" | "excluded" }
  | {
      ok: false;
      reason: "invalid_path" | "read_failed" | "queue_full" | "closed";
    };

/** Decoded vault paths only; never normalize a traversal into an allowed path. */
export function normalizedCacheFilePath(input: string): string | null {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    /[\u0000-\u001f]/u.test(input)
  )
    return null;
  const value = input.replace(/\\/gu, "/").replace(/^\//u, "");
  const parts = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value) ||
    parts.some((part) => !part || part === "." || part === "..") ||
    !value.toLowerCase().endsWith(".md")
  )
    return null;
  return "/" + value;
}

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
const LINK_CACHE_REFRESH_REASONS = new Map([
  ["building", "headless_link_cache_refreshing"],
  ["pending-events", "headless_link_cache_events_pending"],
  ["uncertain", "headless_link_cache_uncertain"],
  ["incomplete", "headless_link_cache_uncertain"],
]);

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

function vaultRelativePathFromAbsolute(
  filePath: string,
  vaultRoot: string,
): string {
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
  private readonly obsidianService: ObsidianRestApiService | undefined;
  private readonly db: DatabaseSync;
  private readonly fileUpsert;
  private readonly dataVersion;
  private readonly markdownLinks?: MarkdownLinkIndex;
  private readonly filesystemIndexScope?: string;
  private readonly technicalExclusions = ignore().add(DEFAULT_VAULT_EXCLUDE_PATTERNS);
  private readonly linkReinclusions = config.obsidianVaultExcludePatterns.some((rule) => rule.startsWith("!"))
    ? ignore().add(config.obsidianVaultExcludePatterns)
    : undefined;
  private checkedFilesystemVersion?: number;
  private hotCacheDataVersion?: number;
  private linkIndexRun?: Promise<void>;
  private readonly vaultExclusionMatcher = createVaultExclusionMatcher(
    config.obsidianVaultExcludePatterns,
  );
  private isCacheReady = false;
  private isBuilding = false;
  private lastRefreshStartedAt: number | null = null;
  private lastRefreshCompletedAt: number | null = null;
  private lastRefreshDurationMs: number | null = null;
  private lastRefreshError: string | null = null;
  private lastRefreshFileCount = 0;
  private refreshIntervalId: NodeJS.Timeout | null = null;
  private cacheWriteTail: Promise<void> = Promise.resolve();
  private queuedCacheWrites = 0;
  private refreshRequested = false;
  private forceRefreshRequested = false;
  private refreshRun: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  private incrementalFailures = 0;
  private uncertaintyGeneration = 0;
  private eventWorkPending = false;
  private lastRefreshFailedFiles = 0;
  private eventSupervisor: CacheEventSupervisor | null = null;
  private eventStop: Promise<void> = Promise.resolve();

  constructor(obsidianService?: ObsidianRestApiService) {
    this.obsidianService = obsidianService;
    this.db = this.initializeDatabase();
    this.dataVersion = this.db.prepare("PRAGMA data_version");
    this.fileUpsert = this.db.prepare(`
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
    if (!obsidianService && config.obsidianRuntimeMode.startsWith("headless-")) {
      this.markdownLinks = new MarkdownLinkIndex(this.db);
      this.filesystemIndexScope = createHash("sha256").update(JSON.stringify([
        "path-targets-v3", getVaultRoot(), config.obsidianVaultExcludePatterns,
      ])).digest("hex");
    }
    this.ensureMetadata();
    this.loadMetadataSnapshot();
    if (this.markdownLinks && this.isCacheReady) {
      this.isCacheReady = this.hasFilesystemIndexScope();
    }
    logger.info(
      "VaultCacheService initialized with persistent shared store.",
      requestContextService.createRequestContext({
        operation: "VaultCacheServiceInit",
        cachePath: config.obsidianSharedCacheDbPath,
      }),
    );
  }

  public startPeriodicRefresh(): void {
    if (this.closing || this.closed) return;
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
    if (
      config.obsidianCacheEventsEnabled &&
      this.obsidianService &&
      (config.obsidianRuntimeMode === "live" ||
        config.obsidianRuntimeMode === "hybrid")
    ) {
      this.eventSupervisor ??= new CacheEventSupervisor(this.obsidianService, {
        accepts: (candidate, folder) =>
          this.acceptsEventPath(candidate, folder),
        update: (candidate) =>
          this.updateFileVerified(
            candidate,
            requestContextService.createRequestContext({
              operation: "eventCacheRefresh",
            }),
          ),
        reconcile: async () => {
          await this.refreshCache(true);
          return this.lastRefreshError === null && this.isCacheReady;
        },
        uncertain: () => this.markFreshnessUncertain(),
        pending: () => this.markEventWorkPending(),
        settled: () => this.settleEventWork(),
      });
      this.eventSupervisor.start();
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
    this.eventStop = this.eventSupervisor?.stop() ?? Promise.resolve();
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

  private isPubliclyReady(): boolean {
    return this.isCacheReady &&
      !this.isBuilding &&
      !this.refreshRun &&
      !this.refreshRequested &&
      !this.eventWorkPending &&
      !this.lastRefreshError;
  }

  public isReady(): boolean {
    return this.isPubliclyReady();
  }

  public getIsBuilding(): boolean {
    return this.isBuilding;
  }

  public getReadinessStatus(): CacheReadinessStatus {
    if (this.lastRefreshError) return "error";
    if (this.isBuilding || this.refreshRun || this.refreshRequested || this.eventWorkPending) return "building";
    if (this.isPubliclyReady()) return "ready";
    return "empty";
  }

  public async waitUntilReady(timeoutMs = 60000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isPubliclyReady()) {
        return true;
      }
      if (!this.isBuilding && !this.refreshRun && !this.refreshRequested && !this.eventWorkPending && this.lastRefreshError) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.isPubliclyReady();
  }

  public getCachedFileCount(): number {
    return this.metadataCache.size;
  }

  public getStats(): Record<string, unknown> {
    const eventCache = this.eventSupervisor?.snapshot() ?? {
      state: config.obsidianCacheEventsEnabled ? "not_applicable" : "disabled",
    };
    return {
      eventCache,
      dbPath: config.obsidianSharedCacheDbPath,
      refreshSource: this.readMetadataValue("last_refresh_source"),
      configuredRefreshSource: config.obsidianCacheSource,
      refreshConcurrency: config.obsidianCacheConcurrency,
      vaultExcludePatterns: config.obsidianVaultExcludePatterns,
      schemaVersion:
        this.readMetadataValue("schema_version") ?? SHARED_CACHE_SCHEMA_VERSION,
      status: this.getReadinessStatus(),
      ready: this.isPubliclyReady(),
      building: this.isBuilding,
      inMemoryFileCount: this.metadataCache.size,
      cachedFileCount: this.metadataCache.size,
      hotCacheSize: this.contentHotCache.size,
      hotCacheLimit: this.hotCacheLimit,
      lastRefreshAt: this.readMetadataNumber("last_refresh_at"),
      lastRefreshStartedAt: this.lastRefreshStartedAt,
      lastRefreshCompletedAt: this.lastRefreshCompletedAt,
      lastRefreshDurationMs: this.lastRefreshDurationMs,
      lastRefreshError: this.lastRefreshError,
      lastRefreshFileCount: this.lastRefreshFileCount,
      lastRefreshFailedFiles: this.lastRefreshFailedFiles,
      incrementalFailures: this.incrementalFailures,
      pendingCacheWrites: this.queuedCacheWrites,
      freshness:
        this.lastRefreshError ||
        this.eventWorkPending ||
        this.refreshRun ||
        this.refreshRequested ||
        this.isBuilding
          ? "uncertain"
          : this.isCacheReady
            ? "observed"
            : "unknown",
    };
  }

  public runIntegrityCheck(): { ok: boolean; result: string } {
    const row = this.db.prepare("PRAGMA integrity_check;").get() as
      | { integrity_check?: string }
      | undefined;
    const result = row?.integrity_check ?? "unknown";
    return { ok: result === "ok", result };
  }

  public runMaintenance(): {
    vacuum: boolean;
    analyze: boolean;
    checkpoint: string;
  } {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.exec("VACUUM;");
    this.db.exec("ANALYZE;");
    return {
      vacuum: true,
      analyze: true,
      checkpoint: "truncate",
    };
  }

  /** Non-destructive WAL checkpoint; see `checkpointWal`. */
  public runWalCheckpoint(): WalCheckpointResult {
    return checkpointWal(this.db, config.obsidianSharedCacheDbPath);
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
    if (
      !normalizedCacheFilePath(filePath) ||
      isVaultPathExcluded(filePath, this.vaultExclusionMatcher)
    )
      return undefined;
    if (this.markdownLinks) {
      // This version changes for commits from another connection. Local
      // writes invalidate their own entries in upsertRow and deleteRow.
      const version = this.readDataVersion();
      if (version !== this.hotCacheDataVersion) {
        this.contentHotCache.clear();
        this.hotCacheDataVersion = version;
      }
    }
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

  private findFilesystemNote(normalized: string, context: RequestContext): string {
    if (!this.acceptFilesystemSource(normalized)) {
      throw new McpError(BaseErrorCode.NOT_FOUND, "Markdown note not found in the shared filesystem cache.", context);
    }
    const exact = this.db.prepare("SELECT path FROM file_cache WHERE path = ?").get(normalized);
    let matched = exact ? normalized : undefined;
    if (!matched) {
      const folded = normalized.toLowerCase();
      for (const row of this.db.prepare("SELECT path FROM file_cache").iterate()) {
        const candidate = row.path as string;
        if (candidate.toLowerCase() !== folded || !this.acceptFilesystemSource(candidate)) continue;
        if (matched) {
          matched = undefined;
          break;
        }
        matched = candidate;
      }
    }
    if (!matched) throw new McpError(BaseErrorCode.NOT_FOUND, "Markdown note not found in the shared filesystem cache.", context);
    return matched;
  }

  private async readFilesystemSnapshot<T>(
    filePath: string,
    context: RequestContext,
    project: (matched: string, mtime: number) => T,
    checkSnapshot?: () => void,
  ): Promise<T> {
    const normalized = normalizedCacheFilePath(filePath);
    if (!normalized) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Expected a vault-relative Markdown note path.", context);
    }
    if (this.refreshRun) await this.refreshRun;
    if (!this.isReady()) await this.buildVaultCache();
    this.db.exec("BEGIN");
    try {
      checkSnapshot?.();
      if (!this.isReady()) {
        throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Shared filesystem cache reconciliation is incomplete.", context);
      }
      const matched = this.findFilesystemNote(normalized, context);
      const note = this.db.prepare("SELECT mtime FROM file_cache WHERE path = ?").get(matched) as
        { mtime: number };
      return project(matched, note.mtime);
    } finally {
      this.db.exec("ROLLBACK");
    }
  }

  public async readFilesystemNoteContent(filePath: string, context: RequestContext): Promise<string> {
    return this.readFilesystemSnapshot(filePath, context, (matched) =>
      this.db.prepare("SELECT content FROM file_cache WHERE path = ?").get(matched)!.content as string,
    );
  }

  public async readFilesystemNoteLinks(filePath: string, limit: number, context: RequestContext): Promise<FilesystemNoteLinksResponse> {
    const vaultRoot = getVaultRoot();
    const links = this.markdownLinks;
    if (!links || !vaultRoot) {
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Shared filesystem link index is unavailable.", context);
    }
    return this.readFilesystemSnapshot(filePath, context, (matched, mtime) => {
      if (this.linkIndexRun || !this.verifyFilesystemIndex(false)) {
        this.scheduleFilesystemLinkIndex();
        throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "The headless link index is building. Retry later.", {
          ...context, reasonCode: "headless_link_index_building", retryable: true,
        });
      }
      return {
        ok: true,
        contractVersion: 1,
        path: matched.slice(1),
        backend: { kind: "filesystem", bindingFingerprint: createHash("sha256").update(vaultRoot).digest("hex") },
        cache: {
          available: true, consistency: "best_effort_non_atomic_snapshot",
          freshness: {
            status: "unknown", observedAt: new Date().toISOString(), observedFileMtimeMs: mtime,
            reason: "filesystem_cache_may_lag_disk",
          },
        },
        provenance: {
          sourceMetadata: "filesystem", resolution: "filesystem", subpath: "unavailable",
          backlinks: "filesystem", unresolved: "filesystem",
        },
        ...links.read(matched, limit),
      };
    }, () => this.assertFilesystemLinkCacheReady(context));
  }

  private assertFilesystemLinkCacheReady(context: RequestContext): void {
    const reasonCode = LINK_CACHE_REFRESH_REASONS.get(this.readMetadataValue("refresh_state") ?? "");
    if (reasonCode) {
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "The shared note cache is not settled.", {
        ...context, reasonCode, retryable: true,
      });
    }
  }

  private readDataVersion(): number {
    return this.dataVersion.get()!.data_version as number;
  }

  /** Refresh from disk before using the index to admit a filesystem mutation. */
  public async readFilesystemMoveInventory(filePath: string, destination: string | undefined, limit: number) {
    await this.refreshCache();
    return this.filesystemMoveInventory(filePath, destination, limit);
  }

  private async filesystemMoveInventory(filePath: string, destination: string | undefined, limit: number) {
    await this.linkIndexRun;
    if (!this.markdownLinks || !this.verifyFilesystemIndex(false)) {
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "The filesystem link inventory is incomplete.");
    }
    this.db.exec("BEGIN");
    try {
      if (!this.verifyFilesystemIndex(false)) {
        throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "The filesystem link inventory is changing.");
      }
      const inventory = this.markdownLinks.moveInventory("/" + filePath, destination ? "/" + destination : undefined, limit);
      this.db.exec("COMMIT");
      return inventory;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public async readFilesystemResolutionTargets(): Promise<string[]> {
    const targets: string[] = [];
    const context = requestContextService.createRequestContext({ operation: "readFilesystemResolutionTargets" });
    const markdown = await this.listAllMarkdownFilesFromFilesystem(context, targets);
    return markdown.concat(targets);
  }

  public async refreshFilesystemMovePaths(paths: readonly string[], trashFolder: string): Promise<void> {
    const root = getVaultRoot();
    const links = this.markdownLinks;
    if (!root || !links) throw new Error("filesystem_index_unavailable");
    const context = requestContextService.createRequestContext({ operation: "refreshFilesystemMovePaths" });
    await this.serializeCacheWrite(async () => {
      for (const relative of new Set(paths)) {
        const filePath = "/" + relative;
        const trash = foldedPath(relative).startsWith(foldedPath(trashFolder) + "/");
        const markdown = relative.toLowerCase().endsWith(".md");
        if (markdown && !trash) {
          try {
            const row = await this.readCacheRow(filePath, "filesystem", context);
            this.writeLinkIndexBatch(() => {
              this.upsertRow(row);
              links.update(filePath, row.hash, row.content);
            });
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" &&
                !(error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND)) throw error;
          }
        }
        const present = !markdown && !trash && await fs.lstat(path.join(root, relative))
          .then(stat => stat.isFile(), (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          });
        this.writeLinkIndexBatch(() => {
          if (markdown) this.deleteRow(filePath);
          links.updatePathTarget(filePath, present);
        });
      }
      this.checkedFilesystemVersion = undefined;
    });
  }

  public allowsHeadlessOperationSource(relativePath: string): boolean {
    return this.allowsHiddenLinkPath(relativePath) &&
      !this.technicalExclusions.ignores(relativePath) &&
      !isVaultPathExcluded(relativePath, this.vaultExclusionMatcher);
  }

  private verifyFilesystemIndex(remember = true): boolean {
    if (!this.markdownLinks) return false;
    // SQLite advances this value for other connections' commits, including
    // incremental REST upserts that leave last_refresh_source untouched.
    const version = this.readDataVersion();
    if (version === this.checkedFilesystemVersion) return true;
    if (this.readMetadataValue("refresh_state") !== "complete" ||
        !this.hasFilesystemIndexScope() ||
        !this.markdownLinks.coversCache(this.acceptFilesystemSource)) return false;
    if (remember) this.checkedFilesystemVersion = version;
    return true;
  }

  private hasFilesystemIndexScope(): boolean {
    return this.filesystemIndexScope !== undefined &&
      this.readMetadataValue("filesystem_link_inventory") === this.filesystemIndexScope;
  }

  private readonly acceptFilesystemSource = (filePath: string): boolean =>
    !!normalizedCacheFilePath(filePath) &&
    this.allowsHiddenLinkPath(normalizeVaultRelativePath(filePath)) &&
    !this.technicalExclusions.ignores(normalizeVaultRelativePath(filePath)) &&
    !isVaultPathExcluded(filePath, this.vaultExclusionMatcher);

  private allowsHiddenLinkPath(relativePath: string, isDirectory = false): boolean {
    const parts = relativePath.split("/");
    if (!parts.some((part) => part.startsWith("."))) return true;
    const reinclusions = this.linkReinclusions;
    if (!reinclusions) return false;
    // A negation can name a descendant without naming the directory itself.
    if (isDirectory || reinclusions.test(relativePath).unignored) return true;
    return parts.every((part, index) => !part.startsWith(".") ||
      (index < parts.length - 1 && reinclusions.test(parts.slice(0, index + 1).join("/") + "/").unignored));
  }

  private scheduleFilesystemLinkIndex(): void {
    if (!this.markdownLinks || this.closing || this.linkIndexRun || !this.isReady()) return;
    // Scheduling can happen inside the read snapshot. Perform writes only
    // after yielding, when that snapshot and any current writers have finished.
    this.linkIndexRun = this.buildFilesystemLinkIndex(this.markdownLinks)
      .catch(() => {
        this.checkedFilesystemVersion = undefined;
        logger.warning("Headless link indexing was interrupted. The link tool can retry.",
          requestContextService.createRequestContext({ operation: "buildFilesystemLinkIndex" }));
      })
      .finally(() => { this.linkIndexRun = undefined; });
  }

  private async buildFilesystemLinkIndex(links: MarkdownLinkIndex): Promise<void> {
    await yieldToEventLoop();
    if (this.closing || !this.isReady()) return;
    if (this.verifyFilesystemIndex()) return;
    let afterPath = "";
    while (!this.closing) {
      if (this.refreshRun) await this.refreshRun;
      if (this.closing || !this.isReady() || !this.hasFilesystemIndexScope() ||
          this.readMetadataValue("refresh_state") !== "complete") return;
      const last = this.writeLinkIndexBatch(() => links.reconcileBatch(afterPath, this.acceptFilesystemSource));
      if (last === undefined && this.verifyFilesystemIndex()) return;
      afterPath = last ?? "";
      await yieldToEventLoop();
    }
  }

  private writeLinkIndexBatch<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Legacy post-write callers do not reinterpret a cache failure as a failed mutation. */
  public async updateCacheForFile(
    filePath: string,
    context: RequestContext,
  ): Promise<void> {
    await this.updateFileVerified(filePath, context);
  }

  private async serializeCacheWrite<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) throw new Error("cache_closed");
    if (this.queuedCacheWrites >= 1024) throw new Error("cache_queue_full");
    this.queuedCacheWrites++;
    const run = this.cacheWriteTail.then(work);
    this.cacheWriteTail = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.queuedCacheWrites--;
    }
  }

  /** Only finite reason codes are retained; no source path or upstream payload. */
  public markFreshnessUncertain(): void {
    this.uncertaintyGeneration++;
    this.lastRefreshError = "cache_freshness_uncertain";
    if (!this.closed) this.upsertMetadataValue("refresh_state", "uncertain");
  }

  public markEventWorkPending(): void {
    // Repeated hints share a durable pending epoch; no full scan per event.
    if (this.closed || this.closing) return;
    if (!this.eventWorkPending) {
      this.upsertMetadataValue("refresh_state", "pending-events");
      this.eventWorkPending = true;
    }
  }

  public settleEventWork(): void {
    this.eventWorkPending = false;
    if (!this.closed && !this.closing && !this.isBuilding && !this.refreshRun &&
        this.isCacheReady && this.lastRefreshError === null) {
      this.upsertMetadataValue("refresh_state", "complete");
    }
  }

  public async updateFileVerified(
    filePath: string,
    context: RequestContext,
  ): Promise<CacheUpdateResult> {
    const normalizedPath = normalizedCacheFilePath(filePath);
    if (!normalizedPath) return { ok: false, reason: "invalid_path" };
    if (this.closing || this.closed) return { ok: false, reason: "closed" };
    if (this.queuedCacheWrites >= 1024) {
      this.markFreshnessUncertain();
      return { ok: false, reason: "queue_full" };
    }
    try {
      return await this.serializeCacheWrite(
        async (): Promise<CacheUpdateResult> => {
          if (isVaultPathExcluded(normalizedPath, this.vaultExclusionMatcher)) {
            this.deleteRow(normalizedPath);
            return { ok: true, disposition: "excluded" };
          }
          try {
            const source = await this.pickRefreshSource();
            // Local REST can briefly miss a just-written file before indexing.
            // Preserve the legacy bounded retries; never retry arbitrary failures.
            const read = () => this.readCacheRow(normalizedPath, source, context);
            const row = source === "rest"
              ? await retryWithDelay(read, {
                  operationName: "proactiveCacheUpdate",
                  context,
                  maxRetries: 3,
                  delayMs: 300,
                  shouldRetry: (error: unknown) => error instanceof McpError &&
                    (error.code === BaseErrorCode.NOT_FOUND ||
                     error.code === BaseErrorCode.SERVICE_UNAVAILABLE),
                })
              : await read();
            this.upsertRow(row);
            return { ok: true, disposition: "updated" };
          } catch (error) {
            const missing =
              (error instanceof McpError &&
                error.code === BaseErrorCode.NOT_FOUND) ||
              (error as NodeJS.ErrnoException)?.code === "ENOENT";
            if (missing) {
              this.deleteRow(normalizedPath);
              return { ok: true, disposition: "absent" };
            }
            this.incrementalFailures++;
            this.markFreshnessUncertain();
            return { ok: false, reason: "read_failed" };
          }
        },
      );
    } catch {
      this.incrementalFailures++;
      this.markFreshnessUncertain();
      return {
        ok: false,
        reason: this.closing || this.closed ? "closed" : "queue_full",
      };
    }
  }

  private async readCacheRow(
    filePath: string,
    source: CacheRefreshSource,
    context: RequestContext,
  ): Promise<CacheRow> {
    if (source === "filesystem") {
      const root = getVaultRoot();
      if (!root) throw new Error("filesystem_unavailable");
      const absolutePath = path.join(root, filePath.slice(1));
      const [realRoot, realFile] = await Promise.all([
        fs.realpath(root),
        fs.realpath(absolutePath),
      ]);
      const relative = path.relative(realRoot, realFile);
      if (
        relative.startsWith(".." + path.sep) ||
        relative === ".." ||
        path.isAbsolute(relative)
      ) {
        throw new Error("filesystem_outside_vault");
      }
      // Reject static symlinks/junctions in the read path. This is not a native
      // handle-relative mutation primitive and confers no write authorization.
      let component = root;
      for (const segment of filePath.slice(1).split("/")) {
        component = path.join(component, segment);
        if ((await fs.lstat(component)).isSymbolicLink())
          throw new Error("filesystem_link_refused");
      }
      const handle = await fs.open(absolutePath, "r");
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error("not_a_file");
        const content = await handle.readFile("utf8");
        const [after, current] = await Promise.all([
          handle.stat(),
          fs.stat(absolutePath),
        ]);
        if (
          before.ino !== current.ino ||
          before.dev !== current.dev ||
          before.mtimeMs !== after.mtimeMs ||
          before.size !== after.size ||
          after.mtimeMs !== current.mtimeMs ||
          after.size !== current.size
        ) {
          throw new Error("read_changed");
        }
        return {
          path: filePath,
          ctime: Math.round(after.ctimeMs),
          mtime: Math.round(after.mtimeMs),
          size: after.size,
          hash: computeContentHash(content),
          content,
        };
      } finally {
        await handle.close();
      }
    }
    if (!this.obsidianService) throw new Error("rest_unavailable");
    const note = (await this.obsidianService.getFileContent(
      filePath,
      "json",
      context,
    )) as NoteJson;
    if (
      !note ||
      typeof note.content !== "string" ||
      !note.stat ||
      ![note.stat.ctime, note.stat.mtime, note.stat.size].every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    ) {
      throw new Error("invalid_note_response");
    }
    if (
      typeof (note as { path?: unknown }).path === "string" &&
      normalizedCacheFilePath((note as { path: string }).path) !== filePath
    )
      throw new Error("note_identity_mismatch");
    return {
      path: filePath,
      content: note.content,
      hash: computeContentHash(note.content),
      ctime: note.stat.ctime,
      mtime: note.stat.mtime,
      size: note.stat.size,
    };
  }

  private acceptsEventPath(candidate: string, folder: boolean): boolean {
    const probe = normalizedCacheFilePath(
      folder ? candidate + "/__cache_probe__.md" : candidate,
    );
    return (
      !!probe &&
      !isVaultPathExcluded(
        folder ? candidate + "/" : candidate,
        this.vaultExclusionMatcher,
      )
    );
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.stopPeriodicRefresh();
    this.closing = true;
    await this.eventStop;
    await this.refreshRun?.catch(() => undefined);
    await this.linkIndexRun;
    await this.cacheWriteTail;
    if (!this.closed) {
      this.db.close();
      this.closed = true;
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
    if (this.isCacheReady && this.lastRefreshError === null) {
      logger.info("Cache already built. Skipping.", initialBuildContext);
      this.scheduleFilesystemLinkIndex();
      return;
    }
    await this.refreshCache(true);
  }

  public refreshCache(forceContentRead = false): Promise<void> {
    if (this.closing || this.closed) return Promise.resolve();
    this.refreshRequested = true;
    this.forceRefreshRequested ||= forceContentRead;
    if (!this.refreshRun) {
      this.refreshRun = (async () => {
        while (this.refreshRequested && !this.closing) {
          const force = this.forceRefreshRequested;
          this.refreshRequested = false;
          this.forceRefreshRequested = false;
          try {
            await this.serializeCacheWrite(() => this.performRefresh(force));
          } catch {
            this.markFreshnessUncertain();
          }
        }
      })().finally(() => {
        this.refreshRun = null;
        // A request may arrive between loop completion and this microtask.
        // Chain it into the same returned promise rather than dropping it.
        if (this.refreshRequested && !this.closing)
          return this.refreshCache(this.forceRefreshRequested);
        this.scheduleFilesystemLinkIndex();
      });
    }
    return this.refreshRun;
  }

  private async performRefresh(isInitialBuild = false): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: "refreshCache",
      isInitialBuild,
    });

    if (this.isBuilding) {
      logger.warning("Cache refresh already in progress. Skipping.", context);
      return;
    }

    if (this.markdownLinks) {
      isInitialBuild ||= !this.hasFilesystemIndexScope();
      this.checkedFilesystemVersion = undefined;
    }

    // Existing uncertainty cannot be discharged by an mtime/size-only scan.
    // Promote just that scan to content reproof; healthy periodic scans keep
    // their metadata optimization and SSE coverage remains a separate signal.
    const previousState = this.readMetadataValue("refresh_state");
    isInitialBuild ||= this.lastRefreshError !== null || !this.isCacheReady ||
      (previousState !== "complete" && previousState !== "pending-events");
    this.isBuilding = true;
    const uncertaintyAtStart = this.uncertaintyGeneration;
    this.lastRefreshStartedAt = Date.now();
    this.lastRefreshCompletedAt = null;
    this.lastRefreshDurationMs = null;
    this.lastRefreshError = null;
    this.lastRefreshFailedFiles = 0;
    if (isInitialBuild) {
      this.isCacheReady = false;
    }

    logger.info("Starting persistent vault cache refresh process...", context);

    try {
      this.upsertMetadataValue("refresh_state", "building");
      const startTime = Date.now();
      const refreshSource = await this.pickRefreshSource();
      const pathTargets = this.markdownLinks ? [] as string[] : undefined;
      const remoteFiles =
        refreshSource === "filesystem"
          ? await this.listAllMarkdownFilesFromFilesystem(context, pathTargets)
          : await this.listAllMarkdownFiles("/", context);
      const remoteFileSet = new Set(remoteFiles);
      const cachedFileSet = new Set(this.metadataCache.keys());
      if (this.markdownLinks) {
        for (const row of this.db.prepare("SELECT path FROM file_cache").iterate()) {
          cachedFileSet.add(row.path as string);
        }
      }

      let filesAdded = 0;
      let filesUpdated = 0;
      let filesRemoved = 0;

      for (const cachedFile of cachedFileSet) {
        if (!remoteFileSet.has(cachedFile)) {
          this.deleteRow(cachedFile);
          filesRemoved++;
        }
      }

      const processFile = async (
        filePath: string,
      ): Promise<"added" | "updated" | "skipped" | "failed"> => {
        try {
          const cachedEntry = this.metadataCache.get(filePath);
          if (refreshSource === "filesystem") {
            if (!isInitialBuild && cachedEntry) {
              const vaultRoot = getVaultRoot();
              if (!vaultRoot) return "failed";
              const stats = await fs.stat(path.join(vaultRoot, filePath.slice(1)));
              if (cachedEntry.mtime === Math.round(stats.mtimeMs) && cachedEntry.size === stats.size &&
                  (config.obsidianRuntimeMode !== "headless-filesystem" || cachedEntry.ctime === Math.round(stats.ctimeMs))) {
                return "skipped";
              }
            }

            this.upsertRow(
              await this.readCacheRow(filePath, refreshSource, context),
            );
            return cachedEntry ? "updated" : "added";
          }

          if (!this.obsidianService) {
            throw new McpError(
              BaseErrorCode.SERVICE_UNAVAILABLE,
              "Obsidian REST API service is unavailable for REST cache refresh.",
              context,
            );
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
            isInitialBuild ||
            !cachedEntry ||
            cachedEntry.mtime !== remoteMtime ||
            cachedEntry.size !== remoteSize;

          if (!needsRefresh) {
            return "skipped";
          }

          this.upsertRow(
            await this.readCacheRow(filePath, refreshSource, context),
          );

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
      filesUpdated += outcomes.filter(
        (outcome) => outcome === "updated",
      ).length;

      const duration = (Date.now() - startTime) / 1000;
      this.lastRefreshFailedFiles = outcomes.filter(
        (outcome) => outcome === "failed",
      ).length;
      this.lastRefreshError = this.lastRefreshFailedFiles
        ? "cache_refresh_incomplete"
        : this.uncertaintyGeneration !== uncertaintyAtStart
          ? "cache_freshness_uncertain"
          : null;
      this.isCacheReady = this.lastRefreshError === null;
      this.lastRefreshCompletedAt = Date.now();
      this.lastRefreshDurationMs = Math.round(duration * 1000);
      this.lastRefreshFileCount = this.metadataCache.size;
      // Commit completeness with its evidence. An interrupted scan retains
      // 'building'; partial work never advances the last successful checkpoint.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.upsertMetadataValue("last_refresh_failed_files", String(this.lastRefreshFailedFiles));
        this.upsertMetadataValue("refresh_state", this.isCacheReady
          ? (this.eventWorkPending ? "pending-events" : "complete") : "incomplete");
        if (this.isCacheReady) {
          if (this.markdownLinks && pathTargets && this.filesystemIndexScope && refreshSource === "filesystem") {
            this.markdownLinks.replacePathTargets(pathTargets);
            this.upsertMetadataValue("filesystem_link_inventory", this.filesystemIndexScope);
          }
          this.upsertMetadataValue("last_refresh_at", String(Date.now()));
          this.upsertMetadataValue("last_refresh_source", refreshSource);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      logger.info(
        `${
          isInitialBuild ? "Initial vault cache build" : "Vault cache refresh"
        } completed in ${duration.toFixed(2)}s via ${refreshSource}. Added: ${filesAdded}, Updated: ${filesUpdated}, Removed: ${filesRemoved}. Total indexed: ${this.metadataCache.size}.`,
        context,
      );
    } catch (error) {
      this.lastRefreshError = "cache_refresh_failed";
      this.isCacheReady = false;
      this.upsertMetadataValue("refresh_state", "incomplete");
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
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    applyWalSizeLimit(db);
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
      if (
        !normalizedCacheFilePath(row.path) ||
        isVaultPathExcluded(row.path, this.vaultExclusionMatcher)
      ) {
        // Direct SQLite readers must not see content hidden only in memory.
        this.deleteRow(row.path);
        continue;
      }
      this.metadataCache.set(row.path, row);
    }
    const state = this.readMetadataValue("refresh_state");
    this.lastRefreshFailedFiles = Math.max(0, this.readMetadataNumber("last_refresh_failed_files") ?? 0);
    this.lastRefreshError = state && state !== "complete"
      ? "cache_refresh_unverified"
      : null;
    // Existing stores without a marker remain usable; once this version has
    // observed uncertainty, a new process cannot silently erase that evidence.
    this.isCacheReady = !this.lastRefreshError &&
      (this.metadataCache.size > 0 || state === "complete");
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
    this.fileUpsert.run(row.path, row.ctime, row.mtime, row.size, row.hash, row.content, Date.now());

    const indexEntry: CacheIndexEntry = {
      path: row.path,
      ctime: row.ctime,
      mtime: row.mtime,
      size: row.size,
      hash: row.hash,
    };
    this.metadataCache.set(row.path, indexEntry);
    this.contentHotCache.delete(row.path);
    if (this.markdownLinks) {
      this.checkedFilesystemVersion = undefined;
      if (!this.isBuilding) this.scheduleFilesystemLinkIndex();
    }
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
      const entries = await this.obsidianService!.listFiles(
        normalizedPath,
        opContext,
      );
      for (const entry of entries) {
        if (
          typeof entry !== "string" ||
          entry.startsWith("/") ||
          entry
            .replace(/\\/gu, "/")
            .split("/")
            .some((part) => part === ".." || part === ".")
        ) {
          throw new Error("invalid_inventory_entry");
        }
        const fullPath = path.posix.join(normalizedPath, entry);
        if (isVaultPathExcluded(fullPath, this.vaultExclusionMatcher)) continue;
        if (entry.endsWith("/")) {
          const subDirFiles = await this.listAllMarkdownFiles(
            fullPath,
            opContext,
            visitedDirs,
          );
          markdownFiles = markdownFiles.concat(subDirFiles);
        } else if (entry.toLowerCase().endsWith(".md")) {
          if (!normalizedCacheFilePath(fullPath))
            throw new Error("invalid_inventory_entry");
          markdownFiles.push(fullPath);
        }
      }
      return markdownFiles;
    } catch (error) {
      const errMsg = `Failed to list directory during cache build scan: ${normalizedPath}`;
      const err = error as McpError | Error;
      if (err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND) {
        throw new Error("inventory_incomplete");
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
      return getVaultRoot() && existsSync(getVaultRoot()!)
        ? "filesystem"
        : "rest";
    }
    const vaultRoot = getVaultRoot();
    if (vaultRoot && existsSync(vaultRoot)) {
      return "filesystem";
    }
    if (!this.obsidianService) {
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "No vault filesystem path is available and Obsidian REST API service is disabled.",
        requestContextService.createRequestContext({
          operation: "pickRefreshSource",
        }),
      );
    }
    return "rest";
  }

  private async listAllMarkdownFilesFromFilesystem(
    context: RequestContext,
    pathTargets?: string[],
  ): Promise<string[]> {
    const vaultRoot = getVaultRoot();
    if (!vaultRoot) {
      return [];
    }

    const markdownFiles: string[] = [];
    let trashFolder: string | undefined;
    if (config.obsidianRuntimeMode === "headless-filesystem") {
      try { trashFolder = foldedPath(readVaultAppSettings(vaultRoot).trashFolder); }
      catch { /* Mutation planning checks app.json separately and fails closed. */ }
    }
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
        throw new Error("inventory_incomplete");
      }

      for (const entry of entries) {
        const relativePath = normalizeVaultRelativePath(
          path.relative(vaultRoot, path.join(directory, entry.name)),
        );
        if (trashFolder && foldedPath(relativePath) === trashFolder) continue;
        if (pathTargets && !this.allowsHiddenLinkPath(relativePath, entry.isDirectory())) continue;
        const excluded = isVaultPathExcluded(relativePath, this.vaultExclusionMatcher);
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const technical = this.technicalExclusions.ignores(relativePath + "/__cache_probe__.md");
          if (pathTargets ? !technical : !excluded) await walk(fullPath);
        } else if (entry.isFile()) {
          const filePath = vaultRelativePathFromAbsolute(fullPath, vaultRoot);
          if (pathTargets && this.technicalExclusions.ignores(relativePath)) continue;
          if (!excluded && entry.name.toLowerCase().endsWith(".md")) markdownFiles.push(filePath);
          else pathTargets?.push(filePath);
        }
      }
    };

    await walk(vaultRoot);
    markdownFiles.sort((a, b) => a.localeCompare(b));
    return markdownFiles;
  }
}
