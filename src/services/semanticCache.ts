import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";
import { logger, requestContextService, type RequestContext } from "../utils/index.js";
import { loadSmartEnv, type SmartVec } from "./smartEnv.js";

type SemanticManifestRow = {
  smart_env_dir: string;
  source_signature: string;
  source_file_count: number;
  vector_count: number;
  dominant_model: string | null;
  dominant_dim: number | null;
  refreshed_at: number;
};

type SemanticVectorRow = {
  note_path: string;
  title: string | null;
  tags_json: string | null;
  model: string | null;
  dim: number;
  vec_json: string;
  source_id: string;
};

export type SemanticCacheSnapshot = {
  sourceSignature: string;
  sourceFileCount: number;
  vectorCount: number;
  dominantModel?: string;
  dominantDim?: number;
  refreshedAt: number;
  items: SmartVec[];
};

type SmartEnvSourceState = {
  signature: string;
  fileCount: number;
};

const SUBDIRS = ["", "multi", "vectors", "cache", "smart_sources", "embedding_models"];
const EXTS = [".ajson", ".json", ".jsonl", ".ndjson"];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS semantic_manifest (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  smart_env_dir TEXT NOT NULL,
  source_signature TEXT NOT NULL,
  source_file_count INTEGER NOT NULL,
  vector_count INTEGER NOT NULL,
  dominant_model TEXT,
  dominant_dim INTEGER,
  refreshed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS semantic_vectors (
  note_path TEXT PRIMARY KEY,
  title TEXT,
  tags_json TEXT,
  model TEXT,
  dim INTEGER NOT NULL,
  vec_json TEXT NOT NULL,
  source_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_dim ON semantic_vectors (dim);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_model ON semantic_vectors (model);
`;

let semanticCacheServiceSingleton: SemanticCacheService | null = null;

// The cache is derived data. Version its source signature with the row encoding
// so an older release rebuilds from the source rather than reading an encoding
// it cannot interpret. No source or public vector representation is changed.
const VECTOR_CACHE_ENCODING = "float64le-base64-v1";
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function encodeCachedVector(vec: readonly number[]): string {
  // Native typed-array conversion avoids formatting millions of decimals.
  const bytes = LITTLE_ENDIAN
    ? Buffer.from(new Float64Array(vec).buffer)
    : Buffer.allocUnsafe(vec.length * 8);
  if (!LITTLE_ENDIAN)
    for (let i = 0; i < vec.length; i++) bytes.writeDoubleLE(vec[i]!, i * 8);
  return JSON.stringify({ encoding: VECTOR_CACHE_ENCODING, length: vec.length, data: bytes.toString("base64") });
}
function decodeCachedVector(json: string, dimension: number): number[] {
  const value: unknown = JSON.parse(json);
  // Compatibility with an existing cache, including historical numeric arrays.
  if (Array.isArray(value)) return value as number[];
  if (!value || typeof value !== "object") throw new Error("Invalid semantic vector cache encoding");
  const row = value as Record<string, unknown>;
  if (row.encoding !== VECTOR_CACHE_ENCODING || !Number.isSafeInteger(row.length) ||
      row.length !== dimension || dimension < 0 || typeof row.data !== "string")
    throw new Error("Invalid semantic vector cache encoding");
  const bytes = Buffer.from(row.data, "base64");
  if (bytes.length !== dimension * 8 || bytes.toString("base64") !== row.data)
    throw new Error("Invalid semantic vector cache byte length or base64 encoding");
  if (LITTLE_ENDIAN && bytes.byteOffset % 8 === 0)
    return Array.from(new Float64Array(bytes.buffer, bytes.byteOffset, dimension));
  const vec: number[] = [];
  for (let i = 0; i < dimension; i++) vec.push(bytes.readDoubleLE(i * 8));
  return vec;
}

function pickDominantDimension(items: SmartVec[]): number | undefined {
  const counts = new Map<number, number>();
  for (const item of items) {
    const dim = item.vec.length;
    if (!dim) continue;
    counts.set(dim, (counts.get(dim) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0];
}

function pickDominantModel(items: SmartVec[]): string | undefined {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.model) continue;
    counts.set(item.model, (counts.get(item.model) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0];
}

function makeSourceSignature(entries: Array<{ path: string; mtimeMs: number; size: number }>): string {
  return createHash("sha1")
    // A reader-contract change must invalidate persisted snapshots even when
    // the vault files themselves have not changed.
    .update("smart-env-v3:last-read-v1:float64le-base64-v1\n")
    .update(JSON.stringify(entries))
    .digest("hex");
}

async function scanSmartEnvSourceState(baseDir: string): Promise<SmartEnvSourceState> {
  const entries: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const paths: string[] = [];

  for (const subdir of SUBDIRS) {
    const directory = subdir ? path.join(baseDir, subdir) : baseDir;
    let files: string[] = [];
    try {
      files = await fs.readdir(directory);
    } catch {
      continue;
    }

    for (const file of files) {
      if (
        !EXTS.some((extension) => file.toLowerCase().endsWith(extension)) &&
        !(subdir === "smart_sources" && /^mf_[a-z0-9]+$/i.test(file))
      ) {
        continue;
      }
      paths.push(path.join(directory, file));
    }
  }

  // Bound filesystem concurrency instead of serializing thousands of stat calls.
  for (let offset = 0; offset < paths.length; offset += 32) {
    await Promise.all(
      paths.slice(offset, offset + 32).map(async (fullPath) => {
        try {
          const stat = await fs.stat(fullPath);
          entries.push({
            path: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
          // A vanished file is handled just as in the sequential scan.
        }
      }),
    );
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    signature: makeSourceSignature(entries),
    fileCount: entries.length,
  };
}

export class SemanticCacheService {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;
  private memorySnapshot: SemanticCacheSnapshot | null = null;
  private memorySnapshotLoadedAt = 0;
  private pendingSnapshot: Promise<SemanticCacheSnapshot> | null = null;
  private refreshGeneration = 0;
  private pendingSource: {
    generation: number;
    promise: Promise<SmartVec[]>;
  } | null = null;
  private readiness: {
    value: {
      vectorCount: number;
      dominantModel?: string;
      dominantDimension?: number;
    };
    observedAt: number;
  } | null = null;
  private pendingReadiness: Promise<{
    vectorCount: number;
    dominantModel?: string;
    dominantDimension?: number;
  }> | null = null;

  constructor(
    private readonly smartEnvDir: string,
    dbPath: string,
    ttlMs: number,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA_SQL);
    this.ttlMs = Number.isFinite(ttlMs) ? Math.max(ttlMs, 0) : 60000;
  }

  public async getSnapshot(context?: RequestContext): Promise<SemanticCacheSnapshot> {
    if (!this.smartEnvDir) {
      throw new Error("SMART_ENV_DIR is not configured");
    }

    const now = Date.now();

    if (
      this.memorySnapshot &&
      (this.ttlMs === 0 || now - this.memorySnapshotLoadedAt < this.ttlMs)
    ) {
      return this.memorySnapshot;
    }

    // All concurrent callers share one refresh, including its failure.
    if (this.pendingSnapshot) return this.pendingSnapshot;
    const pending = this.refreshSnapshot(context);
    this.pendingSnapshot = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingSnapshot === pending) this.pendingSnapshot = null;
    }
  }

  private async refreshSnapshot(
    context?: RequestContext,
  ): Promise<SemanticCacheSnapshot> {
    const generation = this.refreshGeneration;
    const opContext =
      context ??
      requestContextService.createRequestContext({
        operation: "SemanticCacheService.getSnapshot",
      });

    const sourceState = await scanSmartEnvSourceState(this.smartEnvDir);
    if (generation !== this.refreshGeneration)
      return this.refreshSnapshot(context);

    if (this.memorySnapshot?.sourceSignature === sourceState.signature) {
      this.memorySnapshotLoadedAt = Date.now();
      return this.memorySnapshot;
    }

    const manifest = this.readManifest();
    if (
      manifest &&
      manifest.source_signature === sourceState.signature &&
      manifest.smart_env_dir === this.smartEnvDir
    ) {
      const snapshot = this.loadSnapshotFromDb(manifest);
      this.memorySnapshot = snapshot;
      this.memorySnapshotLoadedAt = Date.now();
      return snapshot;
    }

    logger.info("Refreshing semantic cache from .smart-env", {
      ...opContext,
      smartEnvDir: this.smartEnvDir,
      sourceFileCount: sourceState.fileCount,
    });
    const items = await this.loadSource(generation);
    // A maintenance invalidation during a read must not publish its old result.
    if (generation !== this.refreshGeneration)
      return this.refreshSnapshot(context);
    const snapshot = this.persistSnapshot(items, sourceState);
    this.memorySnapshot = snapshot;
    this.memorySnapshotLoadedAt = Date.now();
    return snapshot;
  }

  /**
   * Validates the semantic source that a query would use without refreshing or
   * persisting the cache. Capability inspection must remain observational.
   */
  public async probeReadiness(): Promise<{
    vectorCount: number;
    dominantModel?: string;
    dominantDimension?: number;
  }> {
    if (!this.smartEnvDir) {
      throw new Error("SMART_ENV_DIR is not configured");
    }

    const now = Date.now();
    if (
      this.memorySnapshot &&
      (this.ttlMs === 0 || now - this.memorySnapshotLoadedAt < this.ttlMs)
    ) {
      return this.projectReadiness(
        this.memorySnapshot.items,
        this.memorySnapshot.dominantModel,
        this.memorySnapshot.dominantDim,
      );
    }

    // Observational cache only: no DB writes, no query snapshot publication.
    // A late successful probe can answer the next bounded health request.
    if (
      this.readiness &&
      now - this.readiness.observedAt < Math.min(this.ttlMs || 60_000, 60_000)
    )
      return { ...this.readiness.value };
    if (this.pendingReadiness) return { ...(await this.pendingReadiness) };
    const pending = this.validateReadiness();
    this.pendingReadiness = pending;
    try {
      return { ...(await pending) };
    } finally {
      if (this.pendingReadiness === pending) this.pendingReadiness = null;
    }
  }

  private async validateReadiness(): Promise<{
    vectorCount: number;
    dominantModel?: string;
    dominantDimension?: number;
  }> {
    const generation = this.refreshGeneration;
    const sourceState = await scanSmartEnvSourceState(this.smartEnvDir);
    const manifest = this.readManifest();
    const snapshot =
      manifest &&
      manifest.source_signature === sourceState.signature &&
      manifest.smart_env_dir === this.smartEnvDir
        ? this.loadSnapshotFromDb(manifest)
        : null;
    const items = snapshot?.items ?? (await this.loadSource(generation));
    if (generation !== this.refreshGeneration) return this.validateReadiness();
    const value = this.projectReadiness(
      items,
      snapshot?.dominantModel,
      snapshot?.dominantDim,
    );
    this.readiness = { value, observedAt: Date.now() };
    return value;
  }

  // Share only an in-flight read of authoritative sources. A probe never starts
  // persistence or retains a query snapshot, and invalidated generations cannot
  // reuse an older read. Both callers keep their existing publication fences.
  private async loadSource(generation: number): Promise<SmartVec[]> {
    if (this.pendingSource?.generation === generation)
      return this.pendingSource.promise;
    const pending = { generation, promise: loadSmartEnv(this.smartEnvDir) };
    this.pendingSource = pending;
    try {
      return await pending.promise;
    } finally {
      if (this.pendingSource === pending) this.pendingSource = null;
    }
  }

  public getStats(): Record<string, unknown> {
    const manifest = this.readManifest();
    return {
      enabled: Boolean(this.smartEnvDir),
      smartEnvDir: this.smartEnvDir,
      ttlMs: this.ttlMs,
      manifest: manifest
        ? {
            sourceSignature: manifest.source_signature,
            sourceFileCount: manifest.source_file_count,
            vectorCount: manifest.vector_count,
            dominantModel: manifest.dominant_model ?? undefined,
            dominantDim: manifest.dominant_dim ?? undefined,
            refreshedAt: manifest.refreshed_at,
          }
        : null,
      memorySnapshotLoadedAt: this.memorySnapshotLoadedAt || undefined,
    };
  }

  public runIntegrityCheck(): { ok: boolean; result: string } {
    const row = this.db.prepare("PRAGMA integrity_check;").get() as
      | { integrity_check?: string }
      | undefined;
    const result = row?.integrity_check ?? "unknown";
    return { ok: result === "ok", result };
  }

  public runMaintenance(): { vacuum: boolean; analyze: boolean } {
    this.db.exec("VACUUM;");
    this.db.exec("ANALYZE;");
    return { vacuum: true, analyze: true };
  }

  public forceRefresh(): void {
    this.refreshGeneration += 1;
    this.readiness = null;
    this.memorySnapshot = null;
    this.memorySnapshotLoadedAt = 0;
  }

  private readManifest(): SemanticManifestRow | null {
    const stmt = this.db.prepare(`
      SELECT smart_env_dir, source_signature, source_file_count, vector_count, dominant_model, dominant_dim, refreshed_at
      FROM semantic_manifest
      WHERE singleton = 1
    `);
    return ((stmt.get() as SemanticManifestRow | undefined) ?? null);
  }

  private countValidVectors(items: readonly SmartVec[]): number {
    return items.filter(
      (item) =>
        Array.isArray(item.vec) &&
        item.vec.length > 0 &&
        item.vec.every((value) => Number.isFinite(value)),
    ).length;
  }

  private projectReadiness(
    items: readonly SmartVec[],
    knownModel?: string,
    knownDimension?: number,
  ): {
    vectorCount: number;
    dominantModel?: string;
    dominantDimension?: number;
  } {
    const vectorCount = this.countValidVectors(items);
    if (vectorCount === 0) {
      throw new Error("Semantic index contains no valid vectors");
    }
    const dominantDimension = knownDimension ?? pickDominantDimension([...items]);
    const dimensionItems = dominantDimension
      ? items.filter((item) => item.vec.length === dominantDimension)
      : items;
    return {
      vectorCount,
      dominantModel: knownModel ?? pickDominantModel([...dimensionItems]),
      dominantDimension,
    };
  }

  private loadSnapshotFromDb(manifest: SemanticManifestRow): SemanticCacheSnapshot {
    const stmt = this.db.prepare(`
      SELECT note_path, title, tags_json, model, dim, vec_json, source_id
      FROM semantic_vectors
      ORDER BY note_path ASC
    `);
    const rows = stmt.all() as unknown as SemanticVectorRow[];
    const items: SmartVec[] = rows.map((row) => ({
      id: row.source_id,
      notePath: row.note_path,
      title: row.title ?? undefined,
      tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : undefined,
      model: row.model ?? undefined,
      vec: decodeCachedVector(row.vec_json, row.dim),
    }));

    return {
      sourceSignature: manifest.source_signature,
      sourceFileCount: manifest.source_file_count,
      vectorCount: manifest.vector_count,
      dominantModel: manifest.dominant_model ?? undefined,
      dominantDim: manifest.dominant_dim ?? undefined,
      refreshedAt: manifest.refreshed_at,
      items,
    };
  }

  private persistSnapshot(
    items: SmartVec[],
    sourceState: SmartEnvSourceState,
  ): SemanticCacheSnapshot {
    const dominantModel = pickDominantModel(items);
    const dominantDim = pickDominantDimension(items);
    const refreshedAt = Date.now();

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM semantic_vectors").run();
      const insertStmt = this.db.prepare(`
        INSERT INTO semantic_vectors (
          note_path, title, tags_json, model, dim, vec_json, source_id, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        insertStmt.run(
          item.notePath,
          item.title ?? null,
          item.tags ? JSON.stringify(item.tags) : null,
          item.model ?? null,
          item.vec.length,
          encodeCachedVector(item.vec),
          item.id,
          refreshedAt,
        );
      }

      this.db.prepare(`
        INSERT INTO semantic_manifest (
          singleton, smart_env_dir, source_signature, source_file_count, vector_count, dominant_model, dominant_dim, refreshed_at
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          smart_env_dir = excluded.smart_env_dir,
          source_signature = excluded.source_signature,
          source_file_count = excluded.source_file_count,
          vector_count = excluded.vector_count,
          dominant_model = excluded.dominant_model,
          dominant_dim = excluded.dominant_dim,
          refreshed_at = excluded.refreshed_at
      `).run(
        this.smartEnvDir,
        sourceState.signature,
        sourceState.fileCount,
        items.length,
        dominantModel ?? null,
        dominantDim ?? null,
        refreshedAt,
      );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      sourceSignature: sourceState.signature,
      sourceFileCount: sourceState.fileCount,
      vectorCount: items.length,
      dominantModel,
      dominantDim,
      refreshedAt,
      items,
    };
  }
}

export function getSemanticCacheService(): SemanticCacheService {
  if (!config.smartEnvDir) {
    throw new Error("SMART_ENV_DIR is not configured");
  }
  if (!semanticCacheServiceSingleton) {
    semanticCacheServiceSingleton = new SemanticCacheService(
      config.smartEnvDir,
      config.obsidianSharedCacheDbPath,
      config.smartEnvCacheTtlMs,
    );
  }
  return semanticCacheServiceSingleton;
}
