import path from "node:path";
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

/** Store unresolved spellings on disk; resolve against the current file set at read time.
 * Adding/removing an ambiguous destination can then affect unchanged sources. */
export class MarkdownLinkIndex {
  private readonly fileUpsert;
  private readonly refsDelete;
  private readonly refInsert;
  private readonly fileByFoldedPath;
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
    this.fileByFoldedPath = db.prepare("SELECT path FROM markdown_link_files WHERE folded_path = ?");
    this.filesByBasename = db.prepare("SELECT path FROM markdown_link_files WHERE basename = ?");
  }

  coversCache(): boolean {
    return !this.db.prepare(`
      SELECT 1 FROM file_cache AS file
      LEFT JOIN markdown_link_files AS indexed USING(path)
      WHERE indexed.hash IS NULL OR indexed.hash <> file.hash LIMIT 1
    `).get();
  }

  update(filePath: string, hash: string, content: string): void {
    const basename = basenameKey(filePath);
    if (!this.fileUpsert.run(filePath, filePath.toLowerCase(), basename, hash).changes) return;
    this.refsDelete.run(filePath);
    for (const [ordinal, reference] of extractMarkdownLinkReferences(content).entries()) {
      this.refInsert.run(filePath, ordinal, reference.linkPath ? basenameKey(reference.linkPath) : basename,
        reference.linkPath, reference.linkText, JSON.stringify(reference));
    }
  }

  private uniquePath(candidates: Iterable<Record<string, unknown>>, wanted: string, suffix = false): string | undefined {
    const foldedWanted = wanted.toLowerCase();
    let foldedMatch: string | undefined;
    let exactMatch: string | undefined;
    let foldedCount = 0;
    let exactCount = 0;
    for (const row of candidates) {
      const candidate = row.path as string;
      if (suffix && !candidate.toLowerCase().endsWith(foldedWanted)) continue;
      foldedMatch = candidate;
      foldedCount++;
      if (suffix ? candidate.endsWith(wanted) : candidate === wanted) {
        exactMatch = candidate;
        exactCount++;
        if (exactCount === 2) return undefined;
      }
    }
    if (exactCount === 1) return exactMatch;
    if (foldedCount === 1) return foldedMatch;
    return undefined;
  }

  findNotePath(wanted: string): string | undefined {
    return this.uniquePath(this.fileByFoldedPath.iterate(wanted.toLowerCase()), wanted);
  }

  private resolve(source: string, linkPath: string): string | undefined {
    if (!linkPath) return source;
    const target = markdownPath(linkPath);
    if (target.startsWith("/")) return this.findNotePath(path.posix.normalize(target));
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(source).slice(1), target));
    if (!relative.startsWith("../")) {
      const match = this.findNotePath("/" + relative);
      if (match) return match;
    }
    const normalized = path.posix.normalize(target);
    if (target.startsWith("./") || target.startsWith("../") || normalized.startsWith("../")) return undefined;
    const suffix = "/" + normalized;
    return this.findNotePath(suffix) ?? this.uniquePath(this.filesByBasename.iterate(basenameKey(normalized)), suffix, true);
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
        resolution: target ? { status: "resolved", targetPath: target.slice(1) } : { status: "unresolved" },
        subpathValidation: reference.subpath
          ? { status: "unknown", reason: target ? "target_cache_unavailable" : "target_file_unavailable" }
          : { status: "not_requested" },
        provenance: "filesystem",
      });
    }

    let unresolvedTotal = 0;
    for (const row of this.db.prepare(`
      SELECT link_path, link_text, count(*) AS count FROM markdown_link_refs
      WHERE source = ? GROUP BY link_text, link_path ORDER BY link_text, link_path
    `).iterate(filePath) as Iterable<LinkCount & { link_text: string }>) {
      if (this.resolve(filePath, row.link_path)) continue;
      unresolvedTotal++;
      if (unresolved.length < limit) unresolved.push({ linkText: row.link_text, count: row.count });
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
      if (this.resolve(row.path, row.link_path) === filePath) count += row.count;
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
