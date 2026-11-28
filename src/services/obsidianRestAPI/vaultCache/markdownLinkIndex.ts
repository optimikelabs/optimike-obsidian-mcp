import { basenameKey, MarkdownLinkResolver } from "./markdownLinkResolver.js";
import type { DatabaseSync } from "node:sqlite";
import type { FilesystemNoteLinksResponse, NoteLinkObservation, NoteLinksProjection } from "../types.js";
import { extractLargeLinkSource, LARGE_LINK_SOURCE_BYTES } from "./boundedLinkReferences.js";
import { extractMarkdownLinkReferences, type MarkdownLinkReference } from "./markdownLinkReferences.js";

function coverage(total: number, returned: number) {
  return { available: true as const, total, returned, truncated: total > returned };
}

type LinkCount = { link_path: string; count: number };
const INDEX_REVISION = "v9:";
const BATCH_BYTES = 256 * 1024;

/** Store unresolved spellings on disk; resolve against the current file set at read time.
 * Adding/removing an ambiguous destination can then affect unchanged sources. */
export class MarkdownLinkIndex {
  private readonly fileUpsert;
  private readonly refsDelete;
  private readonly refInsert;
  private readonly staleRowsAfterPath;
  private readonly staleSource;
  private readonly currentSource;
  private readonly boundedSources;
  private readonly targetsByFoldedPath;
  private readonly filesByBasename;
  private readonly resolver: MarkdownLinkResolver;

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS markdown_link_files (
        path TEXT PRIMARY KEY REFERENCES file_cache(path) ON DELETE CASCADE,
        folded_path TEXT NOT NULL,
        basename TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_markdown_link_folded_path ON markdown_link_files(folded_path);
      CREATE INDEX IF NOT EXISTS idx_markdown_link_basename ON markdown_link_files(basename);
      CREATE TABLE IF NOT EXISTS markdown_link_refs (
        source TEXT NOT NULL REFERENCES markdown_link_files(path) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        basename TEXT NOT NULL,
        link_path TEXT NOT NULL,
        link_text TEXT NOT NULL,
        reference TEXT NOT NULL,
        PRIMARY KEY (source, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_markdown_link_incoming ON markdown_link_refs(basename, source, link_path);
      CREATE INDEX IF NOT EXISTS idx_markdown_link_text ON markdown_link_refs(source, link_text, link_path);
      CREATE INDEX IF NOT EXISTS idx_markdown_link_path ON markdown_link_refs(source, link_path, link_text);
      CREATE TABLE IF NOT EXISTS markdown_link_excluded_targets (
        path TEXT PRIMARY KEY,
        folded_path TEXT NOT NULL,
        basename TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_excluded_link_folded_path ON markdown_link_excluded_targets(folded_path);
      CREATE INDEX IF NOT EXISTS idx_excluded_link_basename ON markdown_link_excluded_targets(basename);
    `);
    this.fileUpsert = db.prepare(`
      INSERT INTO markdown_link_files (path, folded_path, basename, hash) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET hash = excluded.hash
      WHERE markdown_link_files.hash <> excluded.hash
    `);
    this.refsDelete = db.prepare("DELETE FROM markdown_link_refs WHERE source = ?");
    this.refInsert = db.prepare(`
      INSERT INTO markdown_link_refs (source, ordinal, basename, link_path, link_text, reference)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.staleRowsAfterPath = this.db.prepare(`
      SELECT file.path, file.size FROM file_cache AS file
      LEFT JOIN markdown_link_files AS indexed USING(path)
      WHERE file.path > ? AND (indexed.hash IS NULL OR indexed.hash <> ? || file.hash)
      ORDER BY file.path LIMIT 16
    `);
    this.staleSource = db.prepare(`
      SELECT file.hash, file.content, file.size FROM file_cache AS file
      LEFT JOIN markdown_link_files AS indexed USING(path)
      WHERE file.path = ? AND (indexed.hash IS NULL OR indexed.hash <> ? || file.hash)
    `);
    this.currentSource = db.prepare("SELECT 1 FROM file_cache WHERE path = ? AND hash = ?");
    this.boundedSources = db.prepare(`
      SELECT count(*) AS n, max(file.path = ?) AS sourceLimited
      FROM file_cache AS file JOIN markdown_link_files USING(path)
      WHERE file.size > ?
    `);
    this.targetsByFoldedPath = db.prepare(`
      SELECT path FROM markdown_link_files WHERE folded_path = ?
      UNION SELECT path FROM markdown_link_excluded_targets WHERE folded_path = ?
    `);
    this.filesByBasename = db.prepare(`
      SELECT path FROM markdown_link_files WHERE basename = ?
      UNION SELECT path FROM markdown_link_excluded_targets WHERE basename = ?
    `);
    this.resolver = new MarkdownLinkResolver(
      key => this.targetsByFoldedPath.iterate(key, key),
      key => this.filesByBasename.iterate(key, key),
    );
  }

  coversCache(acceptPath: (path: string) => boolean): boolean {
    const rows = this.db.prepare(`
      SELECT file.path FROM file_cache AS file
      LEFT JOIN markdown_link_files AS indexed USING(path)
      WHERE indexed.hash IS NULL OR indexed.hash <> ? || file.hash
    `);
    for (const row of rows.iterate(INDEX_REVISION)) {
      if (acceptPath(row.path as string)) return false;
    }
    return true;
  }

  async reconcileBatch(
    afterPath: string,
    acceptPath: (path: string) => boolean,
    indexPaths: (paths: string[]) => Promise<void>,
  ): Promise<string | undefined> {
    const paths: string[] = [];
    let bytes = 0;
    let last: string | undefined;
    for (const row of this.staleRowsAfterPath.iterate(afterPath, INDEX_REVISION)) {
      const filePath = row.path as string;
      if (acceptPath(filePath)) {
        const size = row.size as number;
        if (paths.length && bytes + size > BATCH_BYTES) break;
        paths.push(filePath);
        bytes += size;
      }
      last = filePath;
    }
    if (paths.length) await indexPaths(paths);
    return last;
  }

  updatePathTarget(filePath: string, present: boolean): void {
    if (present) {
      this.db.prepare("INSERT OR IGNORE INTO markdown_link_excluded_targets VALUES (?, ?, ?)")
        .run(filePath, filePath.toLowerCase(), basenameKey(filePath));
    } else {
      this.db.prepare("DELETE FROM markdown_link_excluded_targets WHERE path = ?").run(filePath);
    }
  }

  replacePathTargets(paths: readonly string[]): void {
    this.db.exec("DELETE FROM markdown_link_excluded_targets");
    const insert = this.db.prepare("INSERT INTO markdown_link_excluded_targets VALUES (?, ?, ?)");
    for (const filePath of paths) insert.run(filePath, filePath.toLowerCase(), basenameKey(filePath));
  }

  readIndexCoverage(filePath: string): FilesystemNoteLinksResponse["indexCoverage"] {
    const row = this.boundedSources.get(filePath, LARGE_LINK_SOURCE_BYTES)!;
    if (!row.n) return undefined;
    return {
      reason: "bounded_large_note_extraction",
      sourceComplete: row.sourceLimited !== 1,
      backlinksComplete: false,
      limitedSourceCount: row.n as number,
    };
  }

  indexSource(filePath: string): void {
    const row = this.staleSource.get(filePath, INDEX_REVISION) as
      { hash: string; content: string; size: number } | undefined;
    if (!row) return;
    // Parse outside the write transaction. Recheck the hash before publishing
    // so a concurrent write wins and the next pass picks up the new text.
    const references = row.size > LARGE_LINK_SOURCE_BYTES
      ? extractLargeLinkSource(row.content)
      : extractMarkdownLinkReferences(row.content);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.currentSource.get(filePath, row.hash)) this.replaceSource(filePath, row.hash, references);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceSource(filePath: string, hash: string, references: MarkdownLinkReference[]): void {
    const basename = basenameKey(filePath);
    if (!this.fileUpsert.run(filePath, filePath.toLowerCase(), basename, INDEX_REVISION + hash).changes) return;
    this.refsDelete.run(filePath);
    for (const [ordinal, reference] of references.entries()) {
      this.refInsert.run(filePath, ordinal, reference.linkPath ? basenameKey(reference.linkPath) : basename,
        reference.linkPath, reference.linkText, JSON.stringify(reference));
    }
  }

  moveInventory(target: string, destination: string | undefined, limit: number) {
    const paths = this.db.prepare(`
      SELECT path FROM markdown_link_files UNION SELECT path FROM markdown_link_excluded_targets ORDER BY path
    `).all().map(row => row.path as string);
    const sources = limit === 0 ? [] : this.db.prepare(`
      SELECT DISTINCT source FROM markdown_link_refs WHERE basename IN (?, ?) ORDER BY source LIMIT ?
    `).all(basenameKey(target), basenameKey(destination ?? target), limit + 1).map(row => row.source as string);
    return { paths, sources };
  }

  read(filePath: string, limit: number): NoteLinksProjection {
    const outgoing: NoteLinkObservation[] = [];
    const unresolved: NoteLinksProjection["unresolved"] = [];
    const backlinks: NoteLinksProjection["backlinks"] = [];

    const total = this.db.prepare("SELECT count(*) AS count FROM markdown_link_refs WHERE source = ?")
      .get(filePath)!.count as number;
    for (const row of this.db.prepare(`
      SELECT reference FROM markdown_link_refs WHERE source = ? ORDER BY ordinal LIMIT ?
    `).iterate(filePath, limit)) {
      const reference = JSON.parse(row.reference as string) as MarkdownLinkReference;
      const target = this.resolver.resolve(filePath, reference.linkPath);
      outgoing.push({
        ...reference,
        resolution: target
          ? { status: "resolved", targetPath: target.path.slice(1), ...(target.ambiguous ? { ambiguous: true } : {}) }
          : { status: "unresolved" },
        subpathValidation: reference.subpath
          ? { status: "unknown", reason: target ? "target_cache_unavailable" : "target_file_unavailable" }
          : { status: "not_requested" },
        provenance: "filesystem",
      });
    }

    let unresolvedTotal = 0;
    for (const row of this.db.prepare(`
      SELECT link_path, CASE WHEN link_path = '' THEN link_text ELSE link_path END AS unresolved_key, count(*) AS count
      FROM markdown_link_refs WHERE source = ? GROUP BY link_path, unresolved_key ORDER BY unresolved_key
    `).iterate(filePath) as Iterable<LinkCount & { unresolved_key: string }>) {
      if (this.resolver.resolve(filePath, row.link_path)) continue;
      unresolvedTotal++;
      if (unresolved.length < limit) unresolved.push({ linkText: row.unresolved_key, count: row.count });
    }

    let backlinkTotal = 0;
    let source: string | undefined;
    let count = 0;
    const addBacklink = () => {
      if (!source || count === 0) return;
      backlinkTotal++;
      if (backlinks.length < limit) backlinks.push({ sourcePath: source.slice(1), count });
    };
    for (const row of this.db.prepare(`
      SELECT source AS path, link_path, count(*) AS count FROM markdown_link_refs
      WHERE basename = ? GROUP BY source, link_path ORDER BY source, link_path
    `).iterate(basenameKey(filePath)) as Iterable<LinkCount & { path: string }>) {
      if (row.path !== source) {
        addBacklink();
        source = row.path;
        count = 0;
      }
      if (this.resolver.resolve(row.path, row.link_path)?.path === filePath) count += row.count;
    }
    addBacklink();

    return {
      outgoing, unresolved, backlinks,
      coverage: {
        outgoing: coverage(total, outgoing.length),
        unresolved: coverage(unresolvedTotal, unresolved.length),
        backlinks: coverage(backlinkTotal, backlinks.length),
      },
    };
  }
}
