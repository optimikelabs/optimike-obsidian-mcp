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

const SUBDIRS = ["", "multi", "vectors", "cache"];
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
    .update(JSON.stringify(entries))
    .digest("hex");
}

async function scanSmartEnvSourceState(baseDir: string): Promise<SmartEnvSourceState> {
  const entries: Array<{ path: string; mtimeMs: number; size: number }> = [];

  for (const subdir of SUBDIRS) {
    const directory = subdir ? path.join(baseDir, subdir) : baseDir;
    let files: string[] = [];
    try {
      files = await fs.readdir(directory);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!EXTS.some((extension) => file.toLowerCase().endsWith(extension))) {
        continue;
      }
      const fullPath = path.join(directory, file);
      try {
        const stat = await fs.stat(fullPath);
        entries.push({
          path: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        continue;
      }
    }
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

    const opContext =
      context ??
      requestContextService.createRequestContext({
        operation: "SemanticCacheService.getSnapshot",
      });

    const now = Date.now();

    if (
      this.memorySnapshot &&
      (this.ttlMs === 0 || now - this.memorySnapshotLoadedAt < this.ttlMs)
    ) {
      return this.memorySnapshot;
    }

    const sourceState = await scanSmartEnvSourceState(this.smartEnvDir);

    const manifest = this.readManifest();
    if (
      manifest &&
      manifest.source_signature === sourceState.signature &&
      manifest.smart_env_dir === this.smartEnvDir
    ) {
      const snapshot = this.loadSnapshotFromDb(manifest);
      this.memorySnapshot = snapshot;
      this.memorySnapshotLoadedAt = now;
      return snapshot;
    }

    logger.info("Refreshing semantic cache from .smart-env", {
      ...opContext,
      smartEnvDir: this.smartEnvDir,
      sourceFileCount: sourceState.fileCount,
    });
    const items = await loadSmartEnv(this.smartEnvDir);
    const snapshot = this.persistSnapshot(items, sourceState);
    this.memorySnapshot = snapshot;
    this.memorySnapshotLoadedAt = now;
    return snapshot;
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
      vec: JSON.parse(row.vec_json) as number[],
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
          JSON.stringify(item.vec),
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
