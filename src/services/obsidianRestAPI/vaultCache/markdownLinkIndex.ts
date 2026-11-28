import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FilesystemNoteLinksResponse, NoteLinkObservation, NoteLinksProjection } from "../types.js";
import { defaultLinkExtraction, extractBoundedLinkSource } from "./boundedLinkReferences.js";
import { extractMarkdownLinkReferences, type MarkdownLinkReference } from "./markdownLinkReferences.js";
import {
  isLimitedLinkSourcePath, isLinkSourceLimitReason, LIMITED_LINK_SOURCE_LIMIT,
  type LimitedLinkSources, type LinkSourceLimitReason,
} from "../../headlessLinkCoverage.js";

function markdownPath(linkPath: string): string {
  return linkPath.toLowerCase().endsWith(".md") ? linkPath : linkPath + ".md";
}

function basenameKey(linkPath: string): string {
  return path.posix.basename(markdownPath(linkPath)).toLowerCase();
}

/** A limited source can hide a syntactically plausible reference. Include
 * those destinations even when the bounded parse did not retain the link. */
function* potentialLinkPaths(content: string): IterableIterator<string> {
  for (const match of content.matchAll(
    /\[\[([^\[\]\r\n|]+)|(?:\]\(\s*|^ {0,3}\[[^\]\r\n]+\]:\s*)(?:<([^>\r\n]+)>|((?:\\.|[^\s()<>]|\([^()\r\n]*\))+))/gmu,
  )) {
    const raw = (match[1] ?? match[2] ?? match[3]).split("#", 1)[0].trim();
    if (match[1]) {
      yield raw.replace(/%%[^\r\n]*?%%/gu, "").trim();
    } else {
      try {
        yield decodeURIComponent(raw.replace(/\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/gu, "$1"));
      } catch {
        // The full extractor ignores malformed escapes too.
      }
    }
  }
}

function coverage(total: number, returned: number) {
  return { available: true as const, total, returned, truncated: total > returned };
}

type LinkCount = { link_path: string; count: number };
type Target = { path: string; ambiguous?: true };
const INDEX_REVISION = "v14:";
const MAX_CANDIDATE_PATHS = 32768;
export type LinkIndexSource = {
  path: string; hash: string; size: number; attempts: number; bounded?: true;
  skipReason?: Exclude<LinkSourceLimitReason, "cap">; skipHints?: true;
};
export class LinkParseFailure extends Error {
  constructor(readonly ordinal: number) { super("markdown_link_parse_failed"); }
}
type IndexedSource = LinkIndexSource & {
  complete: boolean;
  limitReason?: LinkSourceLimitReason;
  references: MarkdownLinkReference[];
  possible?: Set<string>;
  possibleAnywhere?: true;
  retryAttempt?: number;
};

/** Store unresolved spellings on disk; resolve against the current file set at read time.
 * Adding/removing an ambiguous destination can then affect unchanged sources. */
export class MarkdownLinkIndex {
  private readonly fileUpsert;
  private readonly refsDelete;
  private readonly refInsert;
  private readonly staleRowsAfterPath;
  private readonly staleSource;
  private readonly sourceHashes;
  private readonly currentSource;
  private readonly limitedSource;
  private readonly unboundedSources;
  private readonly retryTime;
  private readonly deferRetry;
  private readonly candidatesDelete;
  private readonly candidateInsert;
  private readonly limitedIncoming;
  private readonly targetsByFoldedPath;
  private readonly filesByBasename;
  private readonly revision;

  constructor(private readonly db: DatabaseSync, private readonly options = defaultLinkExtraction, initialize = true) {
    const { largeNoteBytes, sectionBytes, maxReferences } = options;
    this.revision = `${INDEX_REVISION}${largeNoteBytes}:${sectionBytes}:${maxReferences}:${options.parseTimeoutMs ?? 10_000}:`;
    if (initialize) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS markdown_link_files (
        path TEXT PRIMARY KEY REFERENCES file_cache(path) ON DELETE CASCADE,
        folded_path TEXT NOT NULL,
        basename TEXT NOT NULL,
        hash TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 1,
        possible_anywhere INTEGER NOT NULL DEFAULT 0,
        limit_reason TEXT,
        retry_at INTEGER,
        retry_attempt INTEGER NOT NULL DEFAULT 0
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
      CREATE TABLE IF NOT EXISTS markdown_link_candidates (
        source TEXT NOT NULL REFERENCES markdown_link_files(path) ON DELETE CASCADE,
        link_path TEXT NOT NULL,
        basename TEXT NOT NULL,
        PRIMARY KEY (source, link_path)
      );
      CREATE INDEX IF NOT EXISTS idx_markdown_link_candidates ON markdown_link_candidates(basename, source, link_path);
      CREATE TABLE IF NOT EXISTS markdown_link_excluded_targets (
        path TEXT PRIMARY KEY,
        folded_path TEXT NOT NULL,
        basename TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_excluded_link_folded_path ON markdown_link_excluded_targets(folded_path);
      CREATE INDEX IF NOT EXISTS idx_excluded_link_basename ON markdown_link_excluded_targets(basename);
    `);
    for (const [name, definition] of [
      ["complete", "INTEGER NOT NULL DEFAULT 1"],
      ["possible_anywhere", "INTEGER NOT NULL DEFAULT 0"],
      ["limit_reason", "TEXT"],
      ["retry_at", "INTEGER"],
      ["retry_attempt", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      const hasColumn = () => db.prepare("PRAGMA table_info(markdown_link_files)").all()
        .some((column) => column.name === name);
      if (!hasColumn()) {
        try {
          db.exec(`ALTER TABLE markdown_link_files ADD COLUMN ${name} ${definition}`);
        } catch (error) {
          // A second process may have upgraded the shared table first.
          if (!hasColumn()) throw error;
        }
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_markdown_link_limited
        ON markdown_link_files(path) WHERE complete = 0;
      CREATE INDEX IF NOT EXISTS idx_markdown_link_unknown
        ON markdown_link_files(path) WHERE possible_anywhere = 1;
      CREATE INDEX IF NOT EXISTS idx_markdown_link_retry
        ON markdown_link_files(retry_at) WHERE retry_at IS NOT NULL;
    `);
    }
    this.fileUpsert = db.prepare(`
      INSERT INTO markdown_link_files (path, folded_path, basename, hash, complete, possible_anywhere, limit_reason, retry_at, retry_attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, complete = excluded.complete,
        possible_anywhere = excluded.possible_anywhere, limit_reason = excluded.limit_reason,
        retry_at = excluded.retry_at, retry_attempt = excluded.retry_attempt
      WHERE markdown_link_files.hash <> excluded.hash OR markdown_link_files.retry_at IS NOT NULL
    `);
    this.refsDelete = db.prepare("DELETE FROM markdown_link_refs WHERE source = ?");
    this.refInsert = db.prepare(`
      INSERT INTO markdown_link_refs (source, ordinal, basename, link_path, link_text, reference)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.candidatesDelete = db.prepare("DELETE FROM markdown_link_candidates WHERE source = ?");
    this.candidateInsert = db.prepare("INSERT INTO markdown_link_candidates VALUES (?, ?, ?)");
    this.staleRowsAfterPath = this.db.prepare(`
      SELECT file.path, file.size FROM file_cache AS file
      LEFT JOIN markdown_link_files AS indexed USING(path)
      WHERE file.path > ? AND (indexed.hash IS NULL OR indexed.hash <> ? || file.hash OR indexed.retry_at <= ?)
      ORDER BY file.path LIMIT 64
    `);
    this.staleSource = db.prepare(`
      SELECT requested.key AS ordinal, file.path, file.hash, file.content, file.size,
        CASE WHEN indexed.hash = ? || file.hash THEN indexed.retry_attempt ELSE 0 END AS retry_attempt
      FROM json_each(?) AS requested
      CROSS JOIN file_cache AS file ON file.path = json_extract(requested.value, '$.path')
      LEFT JOIN markdown_link_files AS indexed ON indexed.path = file.path
      WHERE file.hash = json_extract(requested.value, '$.hash')
        AND (indexed.hash IS NULL OR indexed.hash <> ? || file.hash OR indexed.retry_at <= ?)
    `);
    this.sourceHashes = db.prepare(`
      SELECT file.path, file.hash, file.size,
        CASE WHEN indexed.hash = ? || file.hash THEN indexed.retry_attempt ELSE 0 END AS retry_attempt
      FROM json_each(?) AS requested
      CROSS JOIN file_cache AS file ON file.path = requested.value
      LEFT JOIN markdown_link_files AS indexed ON indexed.path = file.path
    `);
    this.currentSource = db.prepare("SELECT 1 FROM file_cache WHERE path = ? AND hash = ?");
    this.limitedSource = db.prepare("SELECT limit_reason FROM markdown_link_files WHERE path = ? AND complete = 0");
    this.unboundedSources = db.prepare("SELECT path FROM markdown_link_files WHERE possible_anywhere = 1");
    this.retryTime = db.prepare(`
      SELECT min(indexed.retry_at) AS due FROM markdown_link_files AS indexed
      JOIN file_cache AS file USING(path) WHERE indexed.retry_at IS NOT NULL AND indexed.hash = ? || file.hash
    `);
    this.deferRetry = db.prepare(`
      UPDATE markdown_link_files SET retry_at = ?, retry_attempt = ?
      WHERE path = ? AND hash = ? AND retry_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM markdown_link_refs WHERE source = markdown_link_files.path)
    `);
    this.limitedIncoming = db.prepare(`
      SELECT refs.source, refs.link_path
      FROM markdown_link_files AS source INDEXED BY idx_markdown_link_limited
      CROSS JOIN markdown_link_refs AS refs ON source.path = refs.source
      WHERE refs.basename = ? AND source.complete = 0
      UNION SELECT source, link_path FROM markdown_link_candidates WHERE basename = ?
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
    for (const row of rows.iterate(this.revision)) {
      if (acceptPath(row.path as string)) return false;
    }
    return true;
  }

  nextRetryTime(): number | undefined {
    const time = this.retryTime.get(this.revision)?.due;
    return typeof time === "number" ? time : undefined;
  }

  async reconcileBatch(
    afterPath: string,
    acceptPath: (path: string) => boolean,
    indexPaths: (paths: string[]) => Promise<void>,
  ): Promise<string | undefined> {
    const paths: string[] = [];
    let bytes = 0;
    let last: string | undefined;
    for (const row of this.staleRowsAfterPath.iterate(afterPath, this.revision, Date.now())) {
      const filePath = row.path as string;
      if (acceptPath(filePath)) {
        const size = row.size as number;
        if (paths.length && bytes + size > this.options.batchBytes) break;
        paths.push(filePath);
        bytes += size;
      }
      last = filePath;
    }
    if (paths.length) await indexPaths(paths);
    return last;
  }

  replacePathTargets(paths: readonly string[]): void {
    this.db.exec("DELETE FROM markdown_link_excluded_targets");
    const insert = this.db.prepare("INSERT INTO markdown_link_excluded_targets VALUES (?, ?, ?)");
    for (const filePath of paths) insert.run(filePath, filePath.toLowerCase(), basenameKey(filePath));
  }

  readIndexCoverage(filePath: string): FilesystemNoteLinksResponse["indexCoverage"] {
    const possibleSources = this.limitedBacklinkSources(filePath);
    const sourceComplete = !this.limitedSource.get(filePath);
    const backlinksComplete = possibleSources.size === 0;
    if (sourceComplete && backlinksComplete) return undefined;
    if (!sourceComplete) possibleSources.add(filePath);
    return {
      reason: "bounded_large_note_extraction",
      sourceComplete,
      backlinksComplete,
      ...this.describeLimitedLinkSources(possibleSources),
    };
  }

  /** Collect the full set before taking the bounded diagnostic sample. */
  limitedBacklinkSources(filePath: string): Set<string> {
    const possibleSources = new Set<string>();
    const basename = basenameKey(filePath);
    for (const row of this.limitedIncoming.iterate(basename, basename)) {
      const source = row.source as string;
      if (!possibleSources.has(source) && this.resolve(source, row.link_path as string)?.path === filePath) {
        possibleSources.add(source);
      }
    }
    for (const row of this.unboundedSources.iterate()) possibleSources.add(row.path as string);
    return possibleSources;
  }

  describeLimitedLinkSources(paths: Iterable<string>): LimitedLinkSources {
    const limitedSources: LimitedLinkSources["limitedSources"] = [];
    const indexedPaths = [...new Set(paths)].sort();
    for (const path of indexedPaths) {
      if (limitedSources.length >= LIMITED_LINK_SOURCE_LIMIT) break;
      const relative = path.slice(1);
      if (path.startsWith("/") && isLimitedLinkSourcePath(relative)) {
        const reason = this.limitedSource.get(path)?.limit_reason;
        limitedSources.push({ path: relative, reason: isLinkSourceLimitReason(reason) ? reason : "region" });
      }
    }
    return { limitedSourceCount: indexedPaths.length, limitedSources };
  }

  describeSources(paths: readonly string[]): LinkIndexSource[] {
    return this.sourceHashes.all(this.revision, JSON.stringify(paths)).map((row) => ({
      path: row.path as string,
      hash: row.hash as string,
      size: row.size as number,
      attempts: row.retry_attempt as number,
    }));
  }

  indexSources(sources: readonly LinkIndexSource[], onSource: (ordinal: number) => void): void {
    const parsed: IndexedSource[] = [];
    for (const row of this.staleSource.iterate(this.revision, JSON.stringify(sources), this.revision, Date.now())) {
      const ordinal = row.ordinal as number;
      onSource(ordinal);
      try {
        parsed.push(this.extractSource(sources[ordinal], row.content as string, row.retry_attempt as number));
      } catch {
        throw new LinkParseFailure(ordinal);
      }
    }
    onSource(-1);
    this.commitSources(parsed);
  }

  private extractSource(request: LinkIndexSource, content: string, retryAttempt: number): IndexedSource {
    const { skipReason, bounded, size, skipHints } = request;
    const result = skipReason
      ? { references: [], complete: false, limitReason: skipReason }
      : bounded
        ? extractBoundedLinkSource(content, {
            ...this.options,
            sectionBytes: Math.min(this.options.sectionBytes, 8192),
            maxReferences: size <= this.options.largeNoteBytes ? 32768 : this.options.maxReferences,
          }, true)
        : size > this.options.largeNoteBytes
          ? extractBoundedLinkSource(content, this.options)
          : { references: extractMarkdownLinkReferences(content), complete: true };
    const source: IndexedSource = { ...request, ...result };
    if (skipReason === "timeout" || (bounded && !source.complete))
      source.retryAttempt = retryAttempt + 1;
    if (skipHints) {
      source.possibleAnywhere = true;
    } else if (!source.complete) {
      source.possible = new Set();
      for (const candidate of potentialLinkPaths(content)) {
        source.possible.add(candidate);
        if (source.possible.size > MAX_CANDIDATE_PATHS || /&(?:[a-z]+|#x?[\da-f]+);/iu.test(candidate)) {
          // Hints exceed budget or an unparsed entity changes the spelling.
          source.possibleAnywhere = true;
          source.possible = undefined;
          break;
        }
      }
    }
    return source;
  }

  private commitSources(sources: readonly IndexedSource[]): void {
    if (!sources.length) return;
    // Parsing holds no write lock. Compare hashes again before publishing.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of sources) {
        if (this.currentSource.get(source.path, source.hash)) this.replaceSource(source);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceSource({ path: filePath, hash, complete, references, possible, possibleAnywhere, limitReason, retryAttempt, skipReason }: IndexedSource): void {
    const basename = basenameKey(filePath);
    const indexedHash = this.revision + hash;
    const retryAt = retryAttempt === undefined ? null : Date.now() + 60_000 * 2 ** Math.min(retryAttempt - 1, 4);
    if (skipReason && retryAt !== null &&
        this.deferRetry.run(retryAt, retryAttempt!, filePath, indexedHash).changes) return;
    if (!this.fileUpsert.run(filePath, filePath.toLowerCase(), basename, indexedHash,
      Number(complete), Number(!!possibleAnywhere), limitReason ?? null, retryAt, retryAttempt ?? 0).changes) return;
    this.refsDelete.run(filePath);
    this.candidatesDelete.run(filePath);
    for (const [ordinal, reference] of references.entries()) {
      this.refInsert.run(filePath, ordinal, reference.linkPath ? basenameKey(reference.linkPath) : basename,
        reference.linkPath, reference.linkText, JSON.stringify(reference));
    }
    for (const candidate of possible ?? []) {
      this.candidateInsert.run(filePath, candidate, candidate ? basenameKey(candidate) : basename);
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
    const sourceConfidence = (source: string) =>
      this.limitedSource.get(source) ? { confidence: "uncertain" as const } : {};
    const outgoingConfidence = sourceConfidence(filePath);

    const total = this.db.prepare("SELECT count(*) AS count FROM markdown_link_refs WHERE source = ?")
      .get(filePath)!.count as number;
    for (const row of this.db.prepare(`
      SELECT reference FROM markdown_link_refs WHERE source = ? ORDER BY ordinal LIMIT ?
    `).iterate(filePath, limit)) {
      const reference = JSON.parse(row.reference as string) as MarkdownLinkReference;
      const target = this.resolve(filePath, reference.linkPath);
      outgoing.push({
        ...reference,
        ...outgoingConfidence,
        resolution: target
          ? { status: "resolved", targetPath: target.path.slice(1), ...(target.ambiguous ? { ambiguous: true } : {}) }
          : { status: "unresolved" },
        subpathValidation: reference.subpath
          ? { status: "unknown", reason: target ? "target_cache_unavailable" : "target_file_unavailable" }
          : { status: "not_requested" },
        provenance: "filesystem",
      });
    }

    const unresolvedCounts = new Map<string, number>();
    for (const row of this.db.prepare(`
      SELECT link_path, CASE WHEN link_path = '' THEN link_text ELSE link_path END AS unresolved_key, count(*) AS count
      FROM markdown_link_refs WHERE source = ? GROUP BY link_path, unresolved_key ORDER BY unresolved_key
    `).iterate(filePath) as Iterable<LinkCount & { unresolved_key: string }>) {
      if (this.resolve(filePath, row.link_path)) continue;
      const linkText = row.link_path ? row.unresolved_key.replace(/\.md$/iu, "") : row.unresolved_key;
      unresolvedCounts.set(linkText, (unresolvedCounts.get(linkText) ?? 0) + row.count);
    }
    for (const linkText of [...unresolvedCounts.keys()].sort().slice(0, limit)) {
      unresolved.push({ linkText, count: unresolvedCounts.get(linkText)!, ...outgoingConfidence });
    }

    let backlinkTotal = 0;
    let source: string | undefined;
    let count = 0;
    const addBacklink = () => {
      if (!source || count === 0) return;
      backlinkTotal++;
      if (backlinks.length < limit) backlinks.push({ sourcePath: source.slice(1), count, ...sourceConfidence(source) });
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
        unresolved: coverage(unresolvedCounts.size, unresolved.length),
        backlinks: coverage(backlinkTotal, backlinks.length),
      },
    };
  }
}
