import path from "node:path";

function markdownPath(linkPath: string): string {
  return linkPath.toLowerCase().endsWith(".md") ? linkPath : linkPath + ".md";
}

export function basenameKey(linkPath: string): string {
  return path.posix.basename(markdownPath(linkPath)).toLowerCase();
}

type Target = { path: string; ambiguous?: true };
type Lookup = (key: string) => Iterable<Record<string, unknown>>;

/** Shared resolution for the SQLite index and a projected move. Paths start with "/". */
export class MarkdownLinkResolver {
  constructor(private readonly byFoldedPath: Lookup, private readonly byBasename: Lookup) {}

  static fromPaths(paths: readonly string[]): MarkdownLinkResolver {
    const index = (key: (path: string) => string) => {
      const rows = new Map<string, { path: string }[]>();
      for (const path of paths) {
        const value = key(path);
        const bucket = rows.get(value) ?? [];
        bucket.push({ path });
        rows.set(value, bucket);
      }
      return (value: string) => rows.get(value) ?? [];
    };
    return new MarkdownLinkResolver(index(path => path.toLowerCase()), index(basenameKey));
  }

  private explicitTarget(wanted: string): Target | undefined {
    const folded = wanted.toLowerCase();
    return this.chooseTarget(this.byFoldedPath(folded), wanted);
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

  resolve(source: string, linkPath: string): Target | undefined {
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
    return this.chooseTarget(this.byBasename(basename), local, "/" + normalized.toLowerCase());
  }

}
