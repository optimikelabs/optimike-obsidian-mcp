import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { NoteLinkObservation, NoteLinksProjection } from "../types.js";
import { extractMarkdownLinkReferences, type MarkdownLinkReference } from "./markdownLinkReferences.js";

function markdownPath(linkPath: string): string {
  return linkPath.toLowerCase().endsWith(".md") ? linkPath : linkPath + ".md";
}

function basenameKey(linkPath: string): string {
  return path.posix.basename(markdownPath(linkPath)).toLowerCase();
}

function coverage(total: number, returned: number) {
  return { available: true as const, total, returned, truncated: total > returned };
}

type LinkCount = { link_path: string; count: number };
type Target = { path: string; ambiguous?: true };
const INDEX_REVISION = "v6:";

/** Store unresolved spellings on disk; resolve against the current file set at read time.
 * Adding/removing an ambiguous destination can then affect unchanged sources. */
export class MarkdownLinkIndex {
  private readonly fileUpsert;
  private readonly refsDelete;
  private readonly refInsert;
  private readonly staleRowsAfterPath;
  private readonly targetsByFoldedPath;
  private readonly filesByBasename;

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
      SELECT file.path, file.hash, file.content FROM file_cache AS file
      LEFT JOIN markdown_link_files AS indexed USING(path)
      WHERE file.path > ? AND (indexed.hash IS NULL OR indexed.hash <> ? || file.hash)
      ORDER BY file.path LIMIT 16
    `);
    this.targetsByFoldedPath = db.prepare(`
      SELECT path FROM markdown_link_files WHERE folded_path = ?
      UNION SELECT path FROM markdown_link_excluded_targets WHERE folded_path = ?
    `);
    this.filesByBasename = db.prepare(`
      SELECT path FROM markdown_link_files WHERE basename = ?
      UNION SELECT path FROM markdown_link_excluded_targets WHERE basename = ?
    `);
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

  reconcileBatch(afterPath: string, acceptPath: (path: string) => boolean): string | undefined {
    const deadline = performance.now() + 8;
    let last: string | undefined;
    for (const row of this.staleRowsAfterPath.iterate(afterPath, INDEX_REVISION)) {
      last = row.path as string;
      if (acceptPath(last)) this.update(last, row.hash as string, row.content as string);
      if (performance.now() >= deadline) break;
    }
    return last;
  }

  replacePathTargets(paths: readonly string[]): void {
    this.db.exec("DELETE FROM markdown_link_excluded_targets");
    const insert = this.db.prepare("INSERT INTO markdown_link_excluded_targets VALUES (?, ?, ?)");
    for (const filePath of paths) insert.run(filePath, filePath.toLowerCase(), basenameKey(filePath));
  }

  update(filePath: string, hash: string, content: string): void {
    const basename = basenameKey(filePath);
    if (!this.fileUpsert.run(filePath, filePath.toLowerCase(), basename, INDEX_REVISION + hash).changes) return;
    this.refsDelete.run(filePath);
    for (const [ordinal, reference] of extractMarkdownLinkReferences(content).entries()) {
      this.refInsert.run(filePath, ordinal, reference.linkPath ? basenameKey(reference.linkPath) : basename,
        reference.linkPath, reference.linkText, JSON.stringify(reference));
    }
  }

  private explicitTarget(wanted: string): Target | undefined {
    const folded = wanted.toLowerCase();
    return this.chooseTarget(this.targetsByFoldedPath.iterate(folded, folded), wanted);
  }

  private chooseTarget(candidates: Iterable<Record<string, unknown>>, preferred?: string, suffix?: string): Target | undefined {
    let best: string | undefined;
    let bestRank = Infinity;
    let matches = 0;
    for (const row of candidates) {
      const candidate = row.path as string;
      if (suffix && !candidate.toLowerCase().endsWith(suffix)) continue;
      const rank = candidate === preferred ? 0 : candidate.toLowerCase() === preferred?.toLowerCase() ? 1 : 2;
      matches++;
      if (!best || rank < bestRank || (rank === bestRank &&
          (candidate.length < best.length || (candidate.length === best.length && candidate < best)))) {
        best = candidate;
        bestRank = rank;
      }
    }
    return best ? { path: best, ...(matches > 1 ? { ambiguous: true as const } : {}) } : undefined;
  }

  private resolve(source: string, linkPath: string): Target | undefined {
    if (!linkPath) return { path: source };
    const basename = basenameKey(linkPath);
    const extension = path.posix.extname(linkPath).toLowerCase();
    if (extension && extension !== ".md") {
      const attachment = this.resolvePath(source, linkPath, basename);
      if (attachment) return attachment;
    }
    return this.resolvePath(source, markdownPath(linkPath), basename);
  }

  private resolvePath(source: string, target: string, basename: string): Target | undefined {
    if (target.startsWith("/")) return this.explicitTarget(path.posix.normalize(target));
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(source).slice(1), target));
    const local = relative.startsWith("../") ? undefined : "/" + relative;
    if (target.startsWith("./") || target.startsWith("../")) return local ? this.explicitTarget(local) : undefined;
    const normalized = path.posix.normalize(target);
    if (normalized.startsWith("../")) return local ? this.explicitTarget(local) : undefined;
    return this.chooseTarget(this.filesByBasename.iterate(basename, basename), local, "/" + normalized.toLowerCase());
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
      const target = this.resolve(filePath, reference.linkPath);
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
      if (this.resolve(filePath, row.link_path)) continue;
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
      if (this.resolve(row.path, row.link_path)?.path === filePath) count += row.count;
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
