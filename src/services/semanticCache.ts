import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";
import {
  logger,
  requestContextService,
  type RequestContext,
} from "../utils/index.js";
import { loadSmartEnv, type SmartVec } from "./smartEnv.js";
import {
  readSmartBlockVectors,
  readSmartEnvV3,
  smartBlockVectorFile,
  type SmartBlockRef,
} from "./smartEnvV3.js";
import { applyWalSizeLimit } from "./sqliteWal.js";
import {
  readExternalSemanticGeneration,
  type ExternalSemanticGeneration,
} from "./externalSemanticGeneration.js";

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

/**
 * Section (block) vectors of the active model, loaded only for section
 * queries. Row `i` of `vectors` (length `dimensions`) belongs to `refs[i]`.
 */
export type SemanticSectionSnapshot = {
  sourceSignature: string;
  model: string;
  dimensions: number;
  refreshedAt: number;
  refs: SmartBlockRef[];
  vectors: Float32Array;
  norms: Float32Array;
  tagsByNote: Map<string, string[]>;
};

type SemanticSectionManifestRow = {
  smart_env_dir: string;
  source_signature: string;
  model: string;
  fingerprint: string;
  dim: number;
  section_count: number;
  refreshed_at: number;
};

type SmartEnvSourceState = {
  signature: string;
  fileCount: number;
  /** Notes signature inputs plus the block vector files; scanned on request. */
  sectionSignature?: string;
};

const SUBDIRS = [
  "",
  "multi",
  "vectors",
  "cache",
  "smart_sources",
  "embedding_models",
];
const SECTION_SUBDIR = "smart_blocks";
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
CREATE TABLE IF NOT EXISTS semantic_section_manifest (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  smart_env_dir TEXT NOT NULL,
  source_signature TEXT NOT NULL,
  model TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  dim INTEGER NOT NULL,
  section_count INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS semantic_sections (
  ord INTEGER PRIMARY KEY,
  note_path TEXT NOT NULL,
  block_key TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  file_index INTEGER NOT NULL,
  read_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS semantic_section_tags (
  note_path TEXT PRIMARY KEY,
  tags_json TEXT NOT NULL
);
`;

let semanticCacheServiceSingleton: SemanticCacheService | null = null;
let externalCache: { key: string; service: SemanticCacheService } | undefined;
let externalCacheDb: DatabaseSync | undefined;

function openCacheDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  applyWalSizeLimit(db);
  db.exec(SCHEMA_SQL);
  return db;
}

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

function makeSourceSignature(
  entries: Array<{ path: string; mtimeMs: number; size: number }>,
): string {
  return (
    createHash("sha1")
      // A reader-contract change must invalidate persisted snapshots even when
      // the vault files themselves have not changed.
      .update("smart-env-v3:last-read-v1:float64le-base64-v1\n")
      .update(JSON.stringify(entries))
      .digest("hex")
  );
}

async function scanSmartEnvSourceState(
  baseDir: string,
  includeSections = false,
): Promise<SmartEnvSourceState> {
  const entries: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const paths: string[] = [];

  for (const subdir of includeSections ? [...SUBDIRS, SECTION_SUBDIR] : SUBDIRS) {
    const directory = subdir ? path.join(baseDir, subdir) : baseDir;
    let files: string[] = [];
    try {
      files = await fs.readdir(directory);
    } catch {
      continue;
    }

    for (const file of files) {
      const vectorFile =
        (subdir === "smart_sources" || subdir === SECTION_SUBDIR) &&
        /^mf_[a-z0-9]+$/i.test(file);
      if (
        !vectorFile &&
        (subdir === SECTION_SUBDIR ||
          !EXTS.some((extension) => file.toLowerCase().endsWith(extension)))
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
  // The note signature keeps its exact inputs, so existing note caches stay
  // valid; the section signature adds the block vector files (mtime, size).
  const noteEntries = entries.filter(
    (entry) => !entry.path.startsWith(`${SECTION_SUBDIR}/`),
  );
  return {
    signature: makeSourceSignature(noteEntries),
    fileCount: noteEntries.length,
    sectionSignature: includeSections
      ? createHash("sha1")
          .update("smart-env-v3:sections-v1\n")
          .update(JSON.stringify(entries))
          .digest("hex")
      : undefined,
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
    signature: string;
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
  // Start of the oldest snapshot refresh or readiness validation still in
  // flight; null when none is running.
  private loadStartedAt: number | null = null;
  // Section vectors are loaded on the first section query only: a notes-only
  // runtime never pays their memory.
  private sectionSnapshot: SemanticSectionSnapshot | null = null;
  private sectionSnapshotLoadedAt = 0;
  private pendingSections: Promise<SemanticSectionSnapshot> | null = null;
  private pendingExternalIndex?: ReturnType<typeof readExternalSemanticGeneration>;

  constructor(
    private readonly smartEnvDir: string,
    database: string | DatabaseSync,
    ttlMs: number,
    private readonly external?: ExternalSemanticGeneration,
  ) {
    this.db = typeof database === "string" ? openCacheDb(database) : database;
    this.ttlMs = Number.isFinite(ttlMs) ? Math.max(ttlMs, 0) : 60000;
  }

  private scanSource(includeSections = false): Promise<SmartEnvSourceState> {
    if (!this.external) return scanSmartEnvSourceState(this.smartEnvDir, includeSections);
    const { cacheKey, sourceFileCount } = this.external;
    return Promise.resolve({
      signature: cacheKey,
      sectionSignature: includeSections ? cacheKey : undefined,
      fileCount: sourceFileCount,
    });
  }

  private async loadExternalIndex(generation: ExternalSemanticGeneration) {
    this.pendingExternalIndex ??= readExternalSemanticGeneration(generation);
    const pending = this.pendingExternalIndex;
    try {
      return await pending;
    } finally {
      if (this.pendingExternalIndex === pending) this.pendingExternalIndex = undefined;
    }
  }

  public async getSnapshot(
    context?: RequestContext,
  ): Promise<SemanticCacheSnapshot> {
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
    this.loadStartedAt ??= now;
    const pending = this.refreshSnapshot(context);
    this.pendingSnapshot = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingSnapshot === pending) this.pendingSnapshot = null;
      this.releaseLoadMarker();
    }
  }

  private releaseLoadMarker(): void {
    if (!this.pendingSnapshot && !this.pendingReadiness)
      this.loadStartedAt = null;
  }

  /**
   * Observational view of a load still in flight, for capability inspection.
   * It never starts a load. persistedVectorCount comes from the manifest of
   * the last snapshot this cache persisted for the same Smart Env directory:
   * evidence that an index was already validated, not a new validation.
   */
  public loadInProgress(): {
    startedAt: number;
    persistedVectorCount: number;
    dominantModel?: string;
    dominantDimension?: number;
  } | null {
    if (this.loadStartedAt === null) return null;
    const manifest = this.readManifest();
    const own = manifest && manifest.smart_env_dir === this.smartEnvDir &&
      (!this.external || manifest.source_signature === this.external.cacheKey);
    return {
      startedAt: this.loadStartedAt,
      persistedVectorCount: own ? Number(manifest.vector_count) || 0 : 0,
      dominantModel: own ? (manifest.dominant_model ?? undefined) : undefined,
      dominantDimension: own ? (manifest.dominant_dim ?? undefined) : undefined,
    };
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

    const sourceState = await this.scanSource();
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
      const snapshot = this.tryLoadSnapshotFromDb(manifest, opContext);
      if (snapshot) {
        this.memorySnapshot = snapshot;
        this.memorySnapshotLoadedAt = Date.now();
        return snapshot;
      }
    }

    logger.info("Refreshing semantic cache from .smart-env", {
      ...opContext,
      smartEnvDir: this.smartEnvDir,
      sourceFileCount: sourceState.fileCount,
    });
    const items = await this.loadSource(generation, sourceState.signature);
    // A maintenance invalidation during a read must not publish its old result.
    if (generation !== this.refreshGeneration)
      return this.refreshSnapshot(context);
    const snapshot = this.persistSnapshot(items, sourceState);
    this.memorySnapshot = snapshot;
    this.memorySnapshotLoadedAt = Date.now();
    return snapshot;
  }

  /**
   * Section (block) vectors of the active model. Call it before getSnapshot:
   * when both caches are stale, the single source read made here also
   * publishes the note snapshot of the same files.
   */
  public async getSectionSnapshot(
    context?: RequestContext,
  ): Promise<SemanticSectionSnapshot> {
    if (!this.smartEnvDir) {
      throw new Error("SMART_ENV_DIR is not configured");
    }
    if (
      this.sectionSnapshot &&
      (this.ttlMs === 0 ||
        Date.now() - this.sectionSnapshotLoadedAt < this.ttlMs)
    ) {
      return this.sectionSnapshot;
    }
    if (this.pendingSections) return this.pendingSections;
    const pending = this.refreshSections(context);
    this.pendingSections = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingSections === pending) this.pendingSections = null;
    }
  }

  private async refreshSections(
    context?: RequestContext,
  ): Promise<SemanticSectionSnapshot> {
    const generation = this.refreshGeneration;
    const opContext =
      context ??
      requestContextService.createRequestContext({
        operation: "SemanticCacheService.getSectionSnapshot",
      });
    const sourceState = await this.scanSource(true);
    const signature = sourceState.sectionSignature!;
    if (generation !== this.refreshGeneration)
      return this.refreshSections(context);
    if (this.sectionSnapshot?.sourceSignature === signature) {
      this.sectionSnapshotLoadedAt = Date.now();
      return this.sectionSnapshot;
    }

    const manifest = this.readSectionManifest();
    if (
      manifest &&
      manifest.source_signature === signature &&
      manifest.smart_env_dir === this.smartEnvDir
    ) {
      const snapshot = await this.tryLoadSectionsFromDb(manifest, opContext);
      if (generation !== this.refreshGeneration)
        return this.refreshSections(context);
      if (snapshot) return this.publishSections(snapshot);
    }

    logger.info("Refreshing semantic section cache from .smart-env", {
      ...opContext,
      smartEnvDir: this.smartEnvDir,
      sourceFileCount: sourceState.fileCount,
    });
    const readStartedAt = Date.now();
    const index = await this.loadSectionSource(
      this.memorySnapshot?.sourceSignature !== sourceState.signature,
    );
    if (generation !== this.refreshGeneration)
      return this.refreshSections(context);
    if (index?.notes.length)
      this.adoptNotesFromSectionRead(index.notes, sourceState, readStartedAt);
    const blocks = index?.blocks;
    const snapshot = this.persistSections(
      signature,
      blocks?.model ?? "",
      blocks?.fingerprint ?? "",
      blocks?.dimensions ?? 0,
      blocks?.refs ?? [],
      blocks?.vectors ?? new Float32Array(0),
      blocks?.norms ?? new Float32Array(0),
      blocks?.tagsByNote ?? new Map(),
    );
    return this.publishSections(snapshot);
  }

  // The single source read of a section refresh (notes included on request).
  private loadSectionSource(includeNotes: boolean) {
    if (this.external) return this.loadExternalIndex(this.external);
    return readSmartEnvV3(this.smartEnvDir, {
      blocks: true,
      notes: includeNotes,
    });
  }

  private publishSections(
    snapshot: SemanticSectionSnapshot,
  ): SemanticSectionSnapshot {
    this.sectionSnapshot = snapshot;
    this.sectionSnapshotLoadedAt = Date.now();
    return snapshot;
  }

  /**
   * The section read parsed every current note vector of the same files: use
   * it instead of parsing the sources a second time for the note snapshot.
   * A note refresh already in flight publishes its own result instead, and a
   * note snapshot published after this read started may hold newer files.
   */
  private adoptNotesFromSectionRead(
    items: SmartVec[],
    sourceState: SmartEnvSourceState,
    readStartedAt: number,
  ): void {
    if (
      this.pendingSnapshot ||
      this.memorySnapshotLoadedAt >= readStartedAt ||
      this.memorySnapshot?.sourceSignature === sourceState.signature
    )
      return;
    const manifest = this.readManifest();
    const persisted =
      manifest?.source_signature === sourceState.signature &&
      manifest.smart_env_dir === this.smartEnvDir;
    this.memorySnapshot = persisted
      ? {
          sourceSignature: manifest.source_signature,
          sourceFileCount: manifest.source_file_count,
          vectorCount: items.length,
          dominantModel: pickDominantModel(items),
          dominantDim: pickDominantDimension(items),
          refreshedAt: manifest.refreshed_at,
          items,
        }
      : this.persistSnapshot(items, sourceState);
    this.memorySnapshotLoadedAt = Date.now();
  }

  private readSectionManifest(): SemanticSectionManifestRow | null {
    const row = this.db
      .prepare(
        `SELECT smart_env_dir, source_signature, model, fingerprint, dim, section_count, refreshed_at
         FROM semantic_section_manifest WHERE singleton = 1`,
      )
      .get() as SemanticSectionManifestRow | undefined;
    return row ?? null;
  }

  // The tables keep one persisted generation. Another server process can
  // publish between reading the manifest and reading its rows.
  private readPinnedRows<T>(
    manifest: SemanticManifestRow | SemanticSectionManifestRow,
    readManifest: () => (SemanticManifestRow | SemanticSectionManifestRow) | null,
    read: () => T,
  ): T {
    if (!this.external) return read();
    this.db.exec("BEGIN");
    try {
      const current = readManifest();
      if (current?.source_signature !== manifest.source_signature ||
          current.smart_env_dir !== manifest.smart_env_dir)
        throw new Error("The persisted semantic generation changed");
      return read();
    } finally {
      this.db.exec("ROLLBACK");
    }
  }

  /**
   * The cache keeps section references only. Vectors are read again from the
   * block vector file whose mtime and size the signature covers; a row that
   * no longer reads back means the cache is not trustworthy: rebuild.
   */
  private async tryLoadSectionsFromDb(
    manifest: SemanticSectionManifestRow,
    context: RequestContext,
  ): Promise<SemanticSectionSnapshot | null> {
    try {
      const { refs, tagsByNote } = this.readPinnedRows(
        manifest,
        () => this.readSectionManifest(),
        () => this.loadSectionRows(manifest),
      );
      const rows = refs.length
        ? await readSmartBlockVectors(
            smartBlockVectorFile(this.smartEnvDir, manifest.fingerprint),
            refs,
            manifest.dim,
          )
        : { refs, vectors: new Float32Array(0), norms: new Float32Array(0) };
      if (rows.refs.length !== refs.length)
        throw new Error("Section vectors no longer match the cache");
      return {
        sourceSignature: manifest.source_signature,
        model: manifest.model,
        dimensions: manifest.dim,
        refreshedAt: manifest.refreshed_at,
        tagsByNote,
        ...rows,
      };
    } catch {
      logger.warning(
        "Semantic section cache is unreadable; rebuilding from .smart-env.",
        { ...context },
      );
      return null;
    }
  }

  private loadSectionRows(manifest: SemanticSectionManifestRow) {
    const external = this.external?.manifest;
    const refs = (
      this.db
        .prepare(
          `SELECT note_path, block_key, line_start, line_end, file_index, read_hash
           FROM semantic_sections ORDER BY ord ASC`,
        )
        .all() as Array<{
        note_path: string;
        block_key: string;
        line_start: number;
        line_end: number;
        file_index: number;
        read_hash: string;
      }>
    ).map(
      (row): SmartBlockRef => ({
        notePath: row.note_path,
        blockKey: row.block_key,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        fileIndex: row.file_index,
        readHash: row.read_hash,
      }),
    );
    if (refs.length !== manifest.section_count ||
        (external && (refs.length !== external.vectors.sections.count ||
          manifest.fingerprint !== external.fingerprint ||
          manifest.model !== external.model.model_key ||
          manifest.dim !== external.model.dimensions ||
          refs.some((ref, i) => ref.fileIndex !== i))))
      throw new Error("Invalid cached section manifest or references");
    const tagsByNote = new Map<string, string[]>();
    for (const row of this.db
      .prepare("SELECT note_path, tags_json FROM semantic_section_tags")
      .all() as Array<{ note_path: string; tags_json: string }>)
      tagsByNote.set(row.note_path, JSON.parse(row.tags_json) as string[]);
    return { refs, tagsByNote };
  }

  private persistSections(
    signature: string,
    model: string,
    fingerprint: string,
    dimensions: number,
    refs: SmartBlockRef[],
    vectors: Float32Array,
    norms: Float32Array,
    tagsByNote: Map<string, string[]>,
  ): SemanticSectionSnapshot {
    const refreshedAt = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM semantic_sections").run();
      this.db.prepare("DELETE FROM semantic_section_tags").run();
      const insertSection = this.db.prepare(`
        INSERT INTO semantic_sections (ord, note_path, block_key, line_start, line_end, file_index, read_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      refs.forEach((ref, index) =>
        insertSection.run(
          index,
          ref.notePath,
          ref.blockKey,
          ref.lineStart,
          ref.lineEnd,
          ref.fileIndex,
          ref.readHash,
        ),
      );
      const insertTags = this.db.prepare(
        "INSERT INTO semantic_section_tags (note_path, tags_json) VALUES (?, ?)",
      );
      for (const [notePath, tags] of tagsByNote)
        insertTags.run(notePath, JSON.stringify(tags));
      this.db
        .prepare(
          `
        INSERT INTO semantic_section_manifest (
          singleton, smart_env_dir, source_signature, model, fingerprint, dim, section_count, refreshed_at
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          smart_env_dir = excluded.smart_env_dir,
          source_signature = excluded.source_signature,
          model = excluded.model,
          fingerprint = excluded.fingerprint,
          dim = excluded.dim,
          section_count = excluded.section_count,
          refreshed_at = excluded.refreshed_at
      `,
        )
        .run(
          this.smartEnvDir,
          signature,
          model,
          fingerprint,
          dimensions,
          refs.length,
          refreshedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      sourceSignature: signature,
      model,
      dimensions,
      refreshedAt,
      refs,
      vectors,
      norms,
      tagsByNote,
    };
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
    // A query already loading the snapshot (the startup prewarm, typically)
    // answers the probe too: one cache decode or source read instead of two.
    // The probe itself still writes nothing.
    if (this.pendingSnapshot) {
      const snapshot = await this.pendingSnapshot;
      return this.projectReadiness(
        snapshot.items,
        snapshot.dominantModel,
        snapshot.dominantDim,
      );
    }
    if (this.pendingReadiness) return { ...(await this.pendingReadiness) };
    this.loadStartedAt ??= now;
    const pending = this.validateReadiness();
    this.pendingReadiness = pending;
    try {
      return { ...(await pending) };
    } finally {
      if (this.pendingReadiness === pending) this.pendingReadiness = null;
      this.releaseLoadMarker();
    }
  }

  private async validateReadiness(): Promise<{
    vectorCount: number;
    dominantModel?: string;
    dominantDimension?: number;
  }> {
    const generation = this.refreshGeneration;
    const sourceState = await this.scanSource();
    const manifest = this.readManifest();
    const snapshot =
      manifest &&
      manifest.source_signature === sourceState.signature &&
      manifest.smart_env_dir === this.smartEnvDir
        ? this.tryLoadSnapshotFromDb(manifest)
        : null;
    // An unreadable derived cache falls back to the authoritative source,
    // without writing: only an actual query republishes the cache.
    const items =
      snapshot?.items ??
      (await this.loadSource(generation, sourceState.signature));
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
  // reuse an older read. Files can change without a new generation, so a read
  // is shared only by callers that observed the same source signature: a query
  // never persists an older read under a newer signature.
  private async loadSource(
    generation: number,
    signature: string,
  ): Promise<SmartVec[]> {
    if (
      this.pendingSource?.generation === generation &&
      this.pendingSource.signature === signature
    )
      return this.pendingSource.promise;
    const pending = {
      generation,
      signature,
      promise: this.external
        ? this.loadExternalIndex(this.external).then((index) => index.notes)
        : loadSmartEnv(this.smartEnvDir),
    };
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
      manifest: manifest && (!this.external || manifest.source_signature === this.external.cacheKey)
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
    this.sectionSnapshot = null;
    this.sectionSnapshotLoadedAt = 0;
  }

  private readManifest(): SemanticManifestRow | null {
    const stmt = this.db.prepare(`
      SELECT smart_env_dir, source_signature, source_file_count, vector_count, dominant_model, dominant_dim, refreshed_at
      FROM semantic_manifest
      WHERE singleton = 1
    `);
    return (stmt.get() as SemanticManifestRow | undefined) ?? null;
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
    const dominantDimension =
      knownDimension ?? pickDominantDimension([...items]);
    const dimensionItems = dominantDimension
      ? items.filter((item) => item.vec.length === dominantDimension)
      : items;
    return {
      vectorCount,
      dominantModel: knownModel ?? pickDominantModel([...dimensionItems]),
      dominantDimension,
    };
  }

  /**
   * The cache is derived data: an unreadable row (corrupt or unknown encoding)
   * must lead to a rebuild from the source, never to a permanent failure.
   * Logs only the failure kind, never paths or vector content.
   */
  private tryLoadSnapshotFromDb(
    manifest: SemanticManifestRow,
    context?: RequestContext,
  ): SemanticCacheSnapshot | null {
    try {
      return this.readPinnedRows(manifest, () => this.readManifest(), () => this.loadSnapshotFromDb(manifest));
    } catch {
      logger.warning(
        "Semantic cache rows are unreadable; rebuilding from .smart-env.",
        {
          ...(context ??
            requestContextService.createRequestContext({
              operation: "SemanticCacheService.tryLoadSnapshotFromDb",
            })),
        },
      );
      return null;
    }
  }

  private loadSnapshotFromDb(
    manifest: SemanticManifestRow,
  ): SemanticCacheSnapshot {
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
    const external = this.external?.manifest;
    if (external && (items.length !== external.vectors.notes.count ||
        manifest.dominant_model !== external.model.model_key ||
        manifest.dominant_dim !== external.model.dimensions ||
        items.some((item) => item.model !== external.model.model_key ||
          item.vec.length !== external.model.dimensions || !item.vec.every(Number.isFinite))))
      throw new Error("Cached note vectors do not match the semantic generation");

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

      this.db
        .prepare(
          `
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
      `,
        )
        .run(
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

export function getSemanticCacheService(generation?: ExternalSemanticGeneration): SemanticCacheService {
  if (generation) {
    if (externalCache?.key !== generation.cacheKey) {
      externalCacheDb ??= openCacheDb(config.obsidianSharedCacheDbPath);
      externalCache = {
        key: generation.cacheKey,
        service: new SemanticCacheService(generation.directory, externalCacheDb, 0, generation),
      };
    }
    return externalCache.service;
  }
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
