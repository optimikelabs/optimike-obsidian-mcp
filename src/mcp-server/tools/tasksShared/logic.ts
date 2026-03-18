import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { config } from "../../../config/index.js";
import { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, RequestContext, requestContextService } from "../../../utils/index.js";
import { Task, parseTasks, queryTasks as filterTasks, taskToString } from "./TaskParser.js";

type StatusMap = Record<string, Task["status"]>;
type TasksPluginConfig = {
  statusMap: StatusMap;
  statusNameMap: Record<string, string>;
  statusTypeMap: Record<string, string>;
  globalFilter: string;
  removeGlobalFilter: boolean;
  presets: Record<string, string>;
  taskFormat: string;
};
type CacheEntry = { mtimeMs: number; size: number; tasks: Task[] };
type SharedCacheRow = {
  path: string;
  ctime: number;
  mtime: number;
  size: number;
  hash: string;
  content: string;
};
type SharedCacheIndexRow = Omit<SharedCacheRow, "content">;
type SharedTaskFileRow = {
  path: string;
  ctime: number;
  mtime: number;
  size: number;
  hash: string;
  parserSignature: string;
  metaCreated?: string | null;
  metaModified?: string | null;
  tasksJson: string;
};

const ListAllTasksArgsSchema = z.object({
  path: z.string().optional(),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional(),
  includeNonTasks: z.boolean().optional(),
  includeFileMetadata: z.boolean().optional(),
  includeMetaDates: z.boolean().optional(),
  metaFallbackToFile: z.boolean().optional(),
  applyGlobalFilter: z.boolean().optional(),
  responseFormat: z.enum(["json", "markdown"]).optional(),
  useCache: z.boolean().optional(),
  responseLimit: z.number().int().positive().optional(),
});

const QueryTasksArgsSchema = z.object({
  path: z.string().optional(),
  query: z.string(),
  queryFilePath: z.string().optional(),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional(),
  includeNonTasks: z.boolean().optional(),
  includeFileMetadata: z.boolean().optional(),
  includeMetaDates: z.boolean().optional(),
  metaFallbackToFile: z.boolean().optional(),
  applyGlobalFilter: z.boolean().optional(),
  responseFormat: z.enum(["json", "markdown"]).optional(),
  useCache: z.boolean().optional(),
  responseLimit: z.number().int().positive().optional(),
});

export const ListAllTasksInputSchemaShape = ListAllTasksArgsSchema.shape;
export const QueryTasksInputSchemaShape = QueryTasksArgsSchema.shape;
export type ListAllTasksInput = z.infer<typeof ListAllTasksArgsSchema>;
export type QueryTasksInput = z.infer<typeof QueryTasksArgsSchema>;

const DEFAULT_INCLUDE_PATHS = parseCsvEnv("MCP_TASKS_INCLUDE_PATHS");
const DEFAULT_EXCLUDE_PATHS = parseCsvEnv("MCP_TASKS_EXCLUDE_PATHS");
const DEFAULT_MAX_FILES = parseIntEnv("MCP_TASKS_MAX_FILES");
const DEFAULT_CONCURRENCY = parseIntEnv("MCP_TASKS_CONCURRENCY") ?? 8;
const ALWAYS_EXCLUDE_DIRS = new Set([".obsidian", ".trash", ".git"]);
const SHARED_TASK_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_file_cache (
  path TEXT PRIMARY KEY,
  ctime INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  parser_signature TEXT NOT NULL,
  meta_created TEXT,
  meta_modified TEXT,
  tasks_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_file_cache_mtime ON task_file_cache (mtime DESC);
`;

const tasksCache = new Map<string, CacheEntry>();
let cachedTasksConfig: TasksPluginConfig | null = null;
let cachedConfigMtime = 0;

function parseCsvEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function parseIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function getVaultRoot(): string {
  if (config.obsidianVaultPath) {
    return normalizePath(path.resolve(config.obsidianVaultPath));
  }
  return normalizePath(
    path.dirname(path.dirname(path.dirname(config.obsidianSharedCacheDbPath))),
  );
}

function getTasksPluginConfigPath(): string {
  return path.join(
    getVaultRoot(),
    ".obsidian",
    "plugins",
    "obsidian-tasks-plugin",
    "data.json",
  );
}

function normalizePath(inputPath: string): string {
  return path.normalize(inputPath);
}

function validateRelativePath(relativePath: string): void {
  if (relativePath.includes("..")) {
    throw new McpError(
      BaseErrorCode.FORBIDDEN,
      `Access denied - directory traversal detected in path: ${relativePath}`,
    );
  }
}

function resolveVaultPath(relativePath = ""): string {
  validateRelativePath(relativePath);
  const vaultRoot = getVaultRoot();
  return relativePath
    ? normalizePath(path.join(vaultRoot, relativePath))
    : vaultRoot;
}

function normalizeVaultRelative(relativePath: string): string {
  if (!relativePath || relativePath === ".") return "";
  return normalizePath(relativePath).replace(/\\/g, "/").replace(/^\/+/u, "");
}

function computeSharedPrefix(directoryPath: string): string {
  const relative = normalizePath(path.relative(getVaultRoot(), directoryPath));
  return normalizeVaultRelative(relative);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function computeParserSignature(
  statusMap: StatusMap,
  statusNameMap: Record<string, string>,
  statusTypeMap: Record<string, string>,
  taskFormat: string,
): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        statusMap,
        statusNameMap,
        statusTypeMap,
        taskFormat,
      }),
    )
    .digest("hex");
}

function openSharedCacheDb(readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(config.obsidianSharedCacheDbPath, { readOnly });
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SHARED_TASK_CACHE_SCHEMA_SQL);
  }
  return db;
}

async function ensureSharedCacheReady(
  vaultCacheService: VaultCacheService | undefined,
  context: RequestContext,
): Promise<void> {
  if (!existsSync(config.obsidianSharedCacheDbPath) && vaultCacheService) {
    logger.info(
      "Shared cache database missing, triggering vault cache build before tasks query.",
      { ...context, dbPath: config.obsidianSharedCacheDbPath },
    );
    await vaultCacheService.buildVaultCache();
  }
  if (!existsSync(config.obsidianSharedCacheDbPath)) {
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "Shared vault cache is unavailable. Start the main cache first before using tasks tools.",
      { ...context, dbPath: config.obsidianSharedCacheDbPath },
    );
  }
}

function buildSharedPathFilter(
  directoryPath: string,
  prefix: string,
  includePaths?: string[],
): { clause: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const normalizedPrefix = normalizeVaultRelative(prefix);

  if (normalizedPrefix) {
    clauses.push("path LIKE ? ESCAPE '\\'");
    params.push(`/${escapeLikePattern(normalizedPrefix)}%`);
  }

  const normalizedIncludes = includePaths?.map((includePath) =>
    normalizeVaultRelative(
      path.relative(getVaultRoot(), resolveIncludePath(directoryPath, includePath)),
    ),
  );

  if (normalizedIncludes && normalizedIncludes.length > 0) {
    const includeClauses = normalizedIncludes.map(
      () => "path LIKE ? ESCAPE '\\'",
    );
    clauses.push(`(${includeClauses.join(" OR ")})`);
    params.push(
      ...normalizedIncludes.map(
        (includePath) => `/${escapeLikePattern(includePath)}%`,
      ),
    );
  }

  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function loadSharedCacheIndexRows(
  db: DatabaseSync,
  directoryPath: string,
  prefix: string,
  includePaths?: string[],
): SharedCacheIndexRow[] {
  const { clause, params } = buildSharedPathFilter(
    directoryPath,
    prefix,
    includePaths,
  );
  const stmt = db.prepare(
    `SELECT path, ctime, mtime, size, hash
     FROM file_cache
     ${clause}
     ORDER BY path ASC`,
  );
  return stmt.all(...params) as unknown as SharedCacheIndexRow[];
}

function loadSharedCacheContentRows(
  db: DatabaseSync,
  paths: string[],
): SharedCacheRow[] {
  if (paths.length === 0) {
    return [];
  }
  const placeholders = paths.map(() => "?").join(", ");
  const stmt = db.prepare(
    `SELECT path, ctime, mtime, size, hash, content
     FROM file_cache
     WHERE path IN (${placeholders})`,
  );
  return stmt.all(...paths) as unknown as SharedCacheRow[];
}

function loadTaskCacheRows(
  db: DatabaseSync,
  directoryPath: string,
  prefix: string,
  includePaths?: string[],
): SharedTaskFileRow[] {
  const { clause, params } = buildSharedPathFilter(
    directoryPath,
    prefix,
    includePaths,
  );
  const stmt = db.prepare(
    `SELECT
       path,
       ctime,
       mtime,
       size,
       hash,
       parser_signature as parserSignature,
       meta_created as metaCreated,
       meta_modified as metaModified,
       tasks_json as tasksJson
     FROM task_file_cache
     ${clause}
     ORDER BY path ASC`,
  );
  return stmt.all(...params) as unknown as SharedTaskFileRow[];
}

function syncTaskFileCache(
  db: DatabaseSync,
  sharedIndexRows: SharedCacheIndexRow[],
  statusMap: StatusMap,
  statusNameMap: Record<string, string>,
  statusTypeMap: Record<string, string>,
  taskFormat: string,
): void {
  const parserSignature = computeParserSignature(
    statusMap,
    statusNameMap,
    statusTypeMap,
    taskFormat,
  );
  const existingStmt = db.prepare(
    "SELECT path, mtime, size, hash, parser_signature as parserSignature FROM task_file_cache",
  );
  const existingRows = existingStmt.all() as unknown as Array<{
    path: string;
    mtime: number;
    size: number;
    hash: string;
    parserSignature: string;
  }>;
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
  const sourcePaths = new Set(sharedIndexRows.map((row) => row.path));
  const stalePaths: string[] = [];

  for (const row of sharedIndexRows) {
    const current = existingByPath.get(row.path);
    const isFresh =
      current &&
      current.mtime === row.mtime &&
      current.size === row.size &&
      current.hash === row.hash &&
      current.parserSignature === parserSignature;

    if (!isFresh) {
      stalePaths.push(row.path);
    }
  }
  const stalePathSet = new Set(stalePaths);

  db.exec("BEGIN");
  try {
    const upsertStmt = db.prepare(`
      INSERT INTO task_file_cache (
        path, ctime, mtime, size, hash, parser_signature,
        meta_created, meta_modified, tasks_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        ctime = excluded.ctime,
        mtime = excluded.mtime,
        size = excluded.size,
        hash = excluded.hash,
        parser_signature = excluded.parser_signature,
        meta_created = excluded.meta_created,
        meta_modified = excluded.meta_modified,
        tasks_json = excluded.tasks_json,
        updated_at = excluded.updated_at
    `);
    const deleteMissingStmt = db.prepare(
      "DELETE FROM task_file_cache WHERE path NOT IN (SELECT path FROM file_cache)",
    );
    const sharedRows = loadSharedCacheContentRows(db, stalePaths);
    const sharedRowsByPath = new Map(sharedRows.map((row) => [row.path, row]));

    for (const rowIndex of sharedIndexRows) {
      if (!stalePathSet.has(rowIndex.path)) {
        continue;
      }

      const row = sharedRowsByPath.get(rowIndex.path);
      if (!row) {
        continue;
      }

      const absolutePath = normalizePath(path.join(getVaultRoot(), row.path));
      const tasks = parseTasks(row.content, absolutePath, {
        statusMap,
        statusNameMap,
        statusTypeMap,
        taskFormat,
        ignoreCodeBlocks: true,
        ignoreFrontmatter: true,
      });
      const meta = extractFrontmatterMetaDates(row.content);

      upsertStmt.run(
        row.path,
        row.ctime,
        row.mtime,
        row.size,
        row.hash,
        parserSignature,
        meta.metaCreated ?? null,
        meta.metaModified ?? null,
        JSON.stringify(tasks),
        Date.now(),
      );
    }

    if (existingRows.length > sourcePaths.size) {
      deleteMissingStmt.run();
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeForMatch(inputPath: string): string {
  return normalizePath(inputPath).toLowerCase();
}

function shouldExcludePath(
  filePath: string,
  includePaths?: string[],
  excludePaths?: string[],
): boolean {
  const normalized = normalizeForMatch(filePath);

  if (excludePaths && excludePaths.length > 0) {
    for (const excludePath of excludePaths) {
      if (normalized.includes(normalizeForMatch(excludePath))) {
        return true;
      }
    }
  }

  if (includePaths && includePaths.length > 0) {
    const match = includePaths.some((includePath) =>
      normalized.includes(normalizeForMatch(includePath)),
    );
    return !match;
  }

  return false;
}

async function loadTasksPluginConfig(): Promise<TasksPluginConfig> {
  const tasksPluginConfigPath = getTasksPluginConfigPath();
  if (!existsSync(tasksPluginConfigPath)) {
    return {
      statusMap: {},
      statusNameMap: {},
      statusTypeMap: {},
      globalFilter: "",
      removeGlobalFilter: false,
      presets: {},
      taskFormat: "",
    };
  }

  const stats = statSync(tasksPluginConfigPath);
  if (cachedTasksConfig && cachedConfigMtime === stats.mtimeMs) {
    return cachedTasksConfig;
  }

  try {
    const raw = await fs.readFile(tasksPluginConfigPath, "utf-8");
    const parsed = JSON.parse(raw);
    const statusSettings = parsed?.statusSettings;
    const combined = [
      ...(statusSettings?.coreStatuses || []),
      ...(statusSettings?.customStatuses || []),
    ];

    const map: StatusMap = {};
    const nameMap: Record<string, string> = {};
    const typeMap: Record<string, string> = {};
    for (const status of combined) {
      const symbol = status?.symbol;
      const type = status?.type;
      const name = status?.name;
      if (typeof symbol !== "string" || !symbol) continue;
      if (typeof name === "string" && name) {
        nameMap[symbol] = name;
      }
      if (typeof type === "string" && type) {
        typeMap[symbol] = type;
      }
      switch (type) {
        case "DONE":
          map[symbol] = "complete";
          break;
        case "CANCELLED":
          map[symbol] = "cancelled";
          break;
        case "IN_PROGRESS":
          map[symbol] = "in_progress";
          break;
        case "NON_TASK":
          map[symbol] = "non_task";
          break;
        case "TODO":
        default:
          map[symbol] = "incomplete";
      }
    }

    const globalFilter =
      typeof parsed?.globalFilter === "string" ? parsed.globalFilter : "";
    const removeGlobalFilter = parsed?.removeGlobalFilter === true;
    const presets =
      typeof parsed?.presets === "object" && parsed?.presets
        ? parsed.presets
        : {};
    const taskFormat =
      typeof parsed?.taskFormat === "string" ? parsed.taskFormat : "";

    cachedTasksConfig = {
      statusMap: map,
      statusNameMap: nameMap,
      statusTypeMap: typeMap,
      globalFilter,
      removeGlobalFilter,
      presets,
      taskFormat,
    };
    cachedConfigMtime = stats.mtimeMs;
    return cachedTasksConfig;
  } catch {
    return {
      statusMap: {},
      statusNameMap: {},
      statusTypeMap: {},
      globalFilter: "",
      removeGlobalFilter: false,
      presets: {},
      taskFormat: "",
    };
  }
}

function resolveIncludePath(startPath: string, includePath: string): string {
  if (includePath.includes("..")) {
    throw new McpError(
      BaseErrorCode.FORBIDDEN,
      `Access denied - directory traversal detected in include path: ${includePath}`,
    );
  }
  const absolute = path.isAbsolute(includePath)
    ? normalizePath(path.resolve(includePath))
    : normalizePath(path.resolve(startPath, includePath));
  if (!normalizePath(absolute).startsWith(normalizePath(startPath))) {
    throw new McpError(
      BaseErrorCode.FORBIDDEN,
      `Include path outside vault is not allowed: ${includePath}`,
    );
  }
  return absolute;
}

type MetaDates = { metaCreated?: string; metaModified?: string };

function pickBestCreatedMs(stats: {
  birthtimeMs: number;
  ctimeMs: number;
  mtimeMs: number;
}): number {
  const minPlausible = Date.UTC(2000, 0, 1);
  const isPlausible = (ms: number) => Number.isFinite(ms) && ms >= minPlausible;
  if (isPlausible(stats.birthtimeMs)) return stats.birthtimeMs;
  if (isPlausible(stats.ctimeMs)) return stats.ctimeMs;
  return stats.mtimeMs;
}

function extractFrontmatterMetaDates(content: string): MetaDates {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!match) return {};
  const frontmatter = match[1];
  const lines = frontmatter.split(/\r?\n/);
  const map = new Map<string, string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (!value) continue;
    map.set(key, value);
  }

  const createdKeys = [
    "création",
    "creation",
    "created",
    "date_creation",
    "date-created",
    "created_at",
  ];
  const modifiedKeys = [
    "modification",
    "modified",
    "updated",
    "date_modification",
    "date-modified",
    "updated_at",
    "modified_at",
  ];

  let metaCreated: string | undefined;
  let metaModified: string | undefined;
  for (const key of createdKeys) {
    const value = map.get(key);
    if (value) {
      metaCreated = value;
      break;
    }
  }
  for (const key of modifiedKeys) {
    const value = map.get(key);
    if (value) {
      metaModified = value;
      break;
    }
  }

  return { metaCreated, metaModified };
}

function normalizeDateValue(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hydrateTasksFromTaskFileRow(
  row: SharedTaskFileRow,
  includeFileMetadata: boolean,
  includeMetaDates: boolean,
  metaFallbackToFile: boolean,
  useCache: boolean,
): Task[] {
  const absolutePath = normalizePath(path.join(getVaultRoot(), row.path));
  const cacheKey = `${absolutePath}::task-file-cache::file=${includeFileMetadata}::meta=${includeMetaDates}::fallback=${metaFallbackToFile}`;

  if (useCache) {
    const cached = tasksCache.get(cacheKey);
    if (cached && cached.mtimeMs === row.mtime && cached.size === row.size) {
      return cached.tasks;
    }
  }

  const baseTasks = JSON.parse(row.tasksJson) as Task[];
  const tasks = baseTasks.map((task) => ({
    ...task,
    tags: [...task.tags],
  }));

  const fileCreated = new Date(
    pickBestCreatedMs({
      birthtimeMs: row.ctime,
      ctimeMs: row.ctime,
      mtimeMs: row.mtime,
    }),
  ).toISOString();
  const fileModified = new Date(row.mtime).toISOString();

  if (includeFileMetadata) {
    for (const task of tasks) {
      task.fileCreatedDate = fileCreated;
      task.fileModifiedDate = fileModified;
    }
  }

  if (includeMetaDates) {
    const metaCreated =
      normalizeDateValue(row.metaCreated ?? undefined) ??
      (metaFallbackToFile ? fileCreated : undefined);
    const metaModified =
      normalizeDateValue(row.metaModified ?? undefined) ??
      (metaFallbackToFile ? fileModified : undefined);
    for (const task of tasks) {
      task.metaCreatedDate = metaCreated;
      task.metaModifiedDate = metaModified;
    }
  }

  if (useCache) {
    tasksCache.set(cacheKey, {
      mtimeMs: row.mtime,
      size: row.size,
      tasks,
    });
  }

  return tasks;
}

async function findAllTasks(
  directoryPath: string,
  statusMap: StatusMap,
  statusNameMap: Record<string, string>,
  statusTypeMap: Record<string, string>,
  taskFormat: string,
  vaultCacheService: VaultCacheService | undefined,
  includePaths?: string[],
  excludePaths?: string[],
  includeNonTasks?: boolean,
  includeFileMetadata = false,
  includeMetaDates = false,
  metaFallbackToFile = true,
  useCache = true,
  maxTasks?: number,
  maxFiles?: number,
): Promise<Task[]> {
  const prefix = computeSharedPrefix(directoryPath);
  await ensureSharedCacheReady(
    vaultCacheService,
    requestContextService.createRequestContext({
      operation: "ensureSharedCacheReady",
    }),
  );

  const db = openSharedCacheDb(false);
  try {
    const sharedIndexRows = loadSharedCacheIndexRows(
      db,
      directoryPath,
      prefix,
      includePaths,
    );
    syncTaskFileCache(
      db,
      sharedIndexRows,
      statusMap,
      statusNameMap,
      statusTypeMap,
      taskFormat,
    );
    const taskRows = loadTaskCacheRows(db, directoryPath, prefix, includePaths);
    const rowLimit =
      typeof maxFiles === "number" && maxFiles > 0
        ? Math.min(maxFiles, taskRows.length)
        : taskRows.length;
    const rowsToProcess = taskRows.slice(0, rowLimit);
    const sharedTasks: Task[] = [];

    for (const row of rowsToProcess) {
      const absolutePath = normalizePath(path.join(getVaultRoot(), row.path));
      const parts = absolutePath.split(path.sep);
      if (parts.some((part) => ALWAYS_EXCLUDE_DIRS.has(part))) {
        continue;
      }
      if (shouldExcludePath(absolutePath, includePaths, excludePaths)) {
        continue;
      }

      const tasks = hydrateTasksFromTaskFileRow(
        row,
        includeFileMetadata,
        includeMetaDates,
        metaFallbackToFile,
        useCache,
      );
      for (const task of tasks) {
        if (!includeNonTasks && task.status === "non_task") {
          continue;
        }
        sharedTasks.push(task);
      }

      if (
        typeof maxTasks === "number" &&
        maxTasks > 0 &&
        sharedTasks.length >= maxTasks
      ) {
        return sharedTasks.slice(0, maxTasks);
      }
    }

    return sharedTasks;
  } finally {
    db.close();
  }
}

export async function warmSharedTaskCache(
  vaultCacheService: VaultCacheService | undefined,
): Promise<{
  sourceFileCount: number;
  taskFileCount: number;
}> {
  const context = requestContextService.createRequestContext({
    operation: "warmSharedTaskCache",
  });

  await ensureSharedCacheReady(vaultCacheService, context);
  const config = await loadTasksPluginConfig();
  const db = openSharedCacheDb(false);
  try {
    const directoryPath = getVaultRoot();
    const prefix = computeSharedPrefix(directoryPath);
    const sharedIndexRows = loadSharedCacheIndexRows(db, directoryPath, prefix);
    syncTaskFileCache(
      db,
      sharedIndexRows,
      config.statusMap,
      config.statusNameMap,
      config.statusTypeMap,
      config.taskFormat,
    );
    const row = db
      .prepare("SELECT COUNT(*) as count FROM task_file_cache")
      .get() as { count?: number } | undefined;
    return {
      sourceFileCount: sharedIndexRows.length,
      taskFileCount: row?.count ?? 0,
    };
  } finally {
    db.close();
  }
}

function queryTasks(tasks: Task[], queryText: string): Task[] {
  try {
    return filterTasks(tasks, queryText);
  } catch {
    return [];
  }
}

function serializeTasksToJson(tasks: Task[]): string {
  return JSON.stringify(tasks, null, 2);
}

function serializeTasksToMarkdown(tasks: Task[]): string {
  return tasks.map(taskToString).join("\n");
}

function needsFileMetadata(queryText: string): boolean {
  return /file\s+(created|modified)\s+(before|after|on)\s+\d{4}-\d{2}-\d{2}/i.test(
    queryText,
  );
}

function needsMetaDates(queryText: string): boolean {
  return /meta\s+(created|modified)\s+(before|after|on)\s+\d{4}-\d{2}-\d{2}/i.test(
    queryText,
  );
}

function mergeGlobalFilter(queryText: string, globalFilter: string): string {
  const trimmedGlobal = globalFilter.trim();
  if (!trimmedGlobal) return queryText;
  const trimmedQuery = queryText.trim();
  if (!trimmedQuery) return trimmedGlobal;
  return `${trimmedGlobal}\n${trimmedQuery}`;
}

function expandPresets(
  queryText: string,
  presets: Record<string, string>,
): string {
  let expanded = queryText;
  expanded = expanded.replace(/\{\{\s*preset\.([^}]+)\s*\}\}/gi, (match, name) => {
    const key = String(name || "").trim();
    return presets[key] ?? match;
  });

  const lines = expanded.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const presetMatch = trimmed.match(/^preset\s+(.+)$/i);
    if (presetMatch) {
      const key = presetMatch[1].trim();
      const preset = presets[key];
      if (preset) {
        output.push(...preset.split("\n"));
        continue;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

function applyQueryFilePlaceholders(
  queryText: string,
  queryFilePath?: string,
): string {
  if (!queryFilePath) return queryText;
  const vaultRoot = getVaultRoot();
  const absolute = path.isAbsolute(queryFilePath)
    ? normalizePath(queryFilePath)
    : normalizePath(path.join(vaultRoot, queryFilePath));
  let relative = absolute;
  if (normalizePath(absolute).startsWith(vaultRoot)) {
    relative = normalizePath(path.relative(vaultRoot, absolute));
  }

  const folder = path.dirname(relative).replace(/\\/g, "/");
  const root = folder.split("/").filter(Boolean)[0] || "";
  return queryText
    .replace(/\{\{\s*query\.file\.path\s*\}\}/gi, relative.replace(/\\/g, "/"))
    .replace(/\{\{\s*query\.file\.folder\s*\}\}/gi, folder === "." ? "" : folder)
    .replace(/\{\{\s*query\.file\.root\s*\}\}/gi, root);
}

export async function processListAllTasks(
  params: ListAllTasksInput,
  context: RequestContext,
  vaultCacheService: VaultCacheService | undefined,
): Promise<string> {
  const validated = ListAllTasksArgsSchema.parse(params);
  const resolvedPath = resolveVaultPath(validated.path || "");
  const pluginConfig = await loadTasksPluginConfig();
  const applyGlobalFilter = validated.applyGlobalFilter ?? false;
  const expandedGlobalFilter = expandPresets(
    pluginConfig.globalFilter || "",
    pluginConfig.presets || {},
  );
  const effectiveGlobalFilter =
    applyGlobalFilter && !pluginConfig.removeGlobalFilter
      ? expandedGlobalFilter
      : "";
  const includeMetaDates =
    validated.includeMetaDates ?? needsMetaDates(effectiveGlobalFilter);
  const metaFallbackToFile = validated.metaFallbackToFile ?? true;
  const includeFileMetadata =
    validated.includeFileMetadata ??
    (needsFileMetadata(effectiveGlobalFilter) ||
      (includeMetaDates && metaFallbackToFile));
  const includePaths = validated.includePaths ?? DEFAULT_INCLUDE_PATHS;
  const excludePaths = [
    ...(DEFAULT_EXCLUDE_PATHS ?? []),
    ...(validated.excludePaths ?? []),
  ];
  const limit = validated.responseLimit;
  const maxTasks =
    limit && limit > 0 && !effectiveGlobalFilter ? limit : undefined;

  const tasks = await findAllTasks(
    resolvedPath,
    pluginConfig.statusMap,
    pluginConfig.statusNameMap,
    pluginConfig.statusTypeMap,
    pluginConfig.taskFormat,
    vaultCacheService,
    includePaths,
    excludePaths,
    validated.includeNonTasks,
    includeFileMetadata,
    includeMetaDates,
    metaFallbackToFile,
    validated.useCache ?? true,
    maxTasks,
    DEFAULT_MAX_FILES,
  );

  const filteredTasks = effectiveGlobalFilter
    ? queryTasks(tasks, effectiveGlobalFilter)
    : tasks;
  const responseFormat = validated.responseFormat ?? "json";
  const finalTasks =
    limit && limit > 0 ? filteredTasks.slice(0, limit) : filteredTasks;
  logger.debug("Processed list_all_tasks request", {
    ...context,
    resultCount: finalTasks.length,
  });
  return responseFormat === "markdown"
    ? serializeTasksToMarkdown(finalTasks)
    : serializeTasksToJson(finalTasks);
}

export async function processQueryTasks(
  params: QueryTasksInput,
  context: RequestContext,
  vaultCacheService: VaultCacheService | undefined,
): Promise<string> {
  const validated = QueryTasksArgsSchema.parse(params);
  const resolvedPath = resolveVaultPath(validated.path || "");
  const pluginConfig = await loadTasksPluginConfig();
  const applyGlobalFilter = validated.applyGlobalFilter ?? true;
  const queryWithPresets = expandPresets(
    validated.query,
    pluginConfig.presets || {},
  );
  const queryWithFile = applyQueryFilePlaceholders(
    queryWithPresets,
    validated.queryFilePath,
  );
  const mergedQuery =
    applyGlobalFilter && !pluginConfig.removeGlobalFilter
      ? mergeGlobalFilter(queryWithFile, pluginConfig.globalFilter)
      : queryWithFile;
  const includeMetaDates =
    validated.includeMetaDates ?? needsMetaDates(mergedQuery);
  const metaFallbackToFile = validated.metaFallbackToFile ?? true;
  const includeFileMetadata =
    validated.includeFileMetadata ??
    (needsFileMetadata(mergedQuery) || (includeMetaDates && metaFallbackToFile));
  const includePaths = validated.includePaths ?? DEFAULT_INCLUDE_PATHS;
  const excludePaths = [
    ...(DEFAULT_EXCLUDE_PATHS ?? []),
    ...(validated.excludePaths ?? []),
  ];

  const allTasks = await findAllTasks(
    resolvedPath,
    pluginConfig.statusMap,
    pluginConfig.statusNameMap,
    pluginConfig.statusTypeMap,
    pluginConfig.taskFormat,
    vaultCacheService,
    includePaths,
    excludePaths,
    validated.includeNonTasks,
    includeFileMetadata,
    includeMetaDates,
    metaFallbackToFile,
    validated.useCache ?? true,
    undefined,
    DEFAULT_MAX_FILES,
  );

  const filteredTasks = queryTasks(allTasks, mergedQuery);
  const responseFormat = validated.responseFormat ?? "json";
  const limit = validated.responseLimit;
  const finalTasks =
    limit && limit > 0 ? filteredTasks.slice(0, limit) : filteredTasks;
  logger.debug("Processed query_tasks request", {
    ...context,
    resultCount: finalTasks.length,
  });
  return responseFormat === "markdown"
    ? serializeTasksToMarkdown(finalTasks)
    : serializeTasksToJson(finalTasks);
}
