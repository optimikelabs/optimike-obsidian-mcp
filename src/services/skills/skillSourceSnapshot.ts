import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";

export type SkillSourceFile = { path: string; bytes: Buffer };
export type SkillSourceSnapshot = { path: string; files: SkillSourceFile[] };
export type SkillDirectoryErrorCode = "source_denied" | "source_changed" | "source_limit" | "source_unavailable";
export class SkillDirectoryError extends Error {
  constructor(readonly code: SkillDirectoryErrorCode) {
    super("The skill source cannot be published safely.");
    this.name = "SkillDirectoryError";
  }
}

/** Internal access is supplied only after the existing root capability checks.
 * resolve and read delegate to the original confined/opened-file verifier.
 * No path returned by resolve is ever included in the resulting snapshot.
 */
export interface SkillSourceAccess {
  resolve(relativePath: string): Promise<string>;
  read(relativePath: string, maxBytes: number): Promise<Buffer>;
  limits: { maxDepth: number; maxFileBytes: number; maxListEntries: number };
}
const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fingerprint = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");

function allowedMember(name: string): boolean {
  // Publication policy, not an extension to the Agent Skills format. Reject a
  // whole directory rather than silently omit a sensitive/ambiguous member.
  // .gitattributes is the sole dotfile exception, as passive regular-file bytes;
  // root include/exclude/readable checks still apply before any read.
  return name.length > 0 && name !== "." && name !== ".." &&
    (!name.startsWith(".") || name === ".gitattributes") && !/[\\:\x00-\x1f]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) &&
    !/^(?:credentials|secrets)(?:\.|$)/iu.test(name) &&
    !/\.(?:key|pem|p12|pfx)$/iu.test(name);
}

/** Read one bounded, complete static skill, with before/after membership and
 * identity checks. This creates no files, caches, approvals or protocol state.
 * An unreadable/excluded/linked member invalidates the entire publication.
 */
export async function readCompleteSkillDirectory(
  directory: string,
  access: SkillSourceAccess,
): Promise<SkillSourceSnapshot> {
  if (!directory || directory.split("/").some(part => !allowedMember(part)))
    throw new SkillDirectoryError("source_denied");
  const entryLimit = Math.min(MAX_ENTRIES, access.limits.maxListEntries);
  type Member = { path: string; relative: string; type: "file" | "directory"; size: number; identity: string };
  async function scan(): Promise<{ root: string; members: Member[] }> {
    const rootPath = await access.resolve("");
    const root = await lstat(rootPath, { bigint: true });
    if (root.isSymbolicLink() || !root.isDirectory()) throw new SkillDirectoryError("source_denied");
    const members: Member[] = [];
    const queue = [{ relative: directory, depth: 0 }];
    let entries = 0, files = 0, bytes = 0;
    while (queue.length) {
      const current = queue.shift()!;
      const absolute = await access.resolve(current.relative);
      const before = await lstat(absolute, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory()) throw new SkillDirectoryError("source_denied");
      members.push({ path: current.relative.slice(directory.length), relative: current.relative,
        type: "directory", size: 0, identity: fingerprint(before) });
      const handle = await opendir(absolute);
      for await (const entry of handle) {
        if (++entries > entryLimit) throw new SkillDirectoryError("source_limit");
        if (!allowedMember(entry.name)) throw new SkillDirectoryError("source_denied");
        const relative = `${current.relative}/${entry.name}`;
        const target = await access.resolve(relative);
        const s = await lstat(target, { bigint: true });
        if (s.isSymbolicLink()) throw new SkillDirectoryError("source_denied");
        if (entry.name === ".gitattributes" && !s.isFile()) throw new SkillDirectoryError("source_denied");
        if (s.isDirectory()) {
          if (current.depth >= access.limits.maxDepth) throw new SkillDirectoryError("source_limit");
          queue.push({ relative, depth: current.depth + 1 });
        } else {
          if (!s.isFile() || s.nlink !== 1n) throw new SkillDirectoryError("source_denied");
          if (++files > MAX_FILES || s.size > BigInt(Math.min(MAX_BYTES, access.limits.maxFileBytes)))
            throw new SkillDirectoryError("source_limit");
          bytes += Number(s.size);
          if (bytes > MAX_BYTES) throw new SkillDirectoryError("source_limit");
          members.push({ path: relative.slice(directory.length + 1), relative,
            type: "file", size: Number(s.size), identity: fingerprint(s) });
        }
      }
      const after = await lstat(await access.resolve(current.relative), { bigint: true });
      if (fingerprint(before) !== fingerprint(after)) throw new SkillDirectoryError("source_changed");
    }
    members.sort((a, b) => compare(a.relative, b.relative));
    return { root: `${root.dev}:${root.ino}`, members };
  }
  try {
    const before = await scan();
    const files: SkillSourceFile[] = [];
    let total = 0;
    for (const member of before.members) {
      if (member.type !== "file") continue;
      const bytes = await access.read(member.relative, MAX_BYTES - total);
      total += bytes.length;
      if (bytes.length !== member.size || total > MAX_BYTES) throw new SkillDirectoryError("source_changed");
      files.push({ path: member.path, bytes });
    }
    const after = await scan();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new SkillDirectoryError("source_changed");
    return { path: directory, files: files.sort((a, b) => compare(a.path, b.path)) };
  } catch (error) {
    if (error instanceof SkillDirectoryError) throw error;
    // FS and external-root failures can contain physical paths. They are not
    // public diagnostics and must not become a registry/protocol error message.
    throw new SkillDirectoryError("source_unavailable");
  }
}
