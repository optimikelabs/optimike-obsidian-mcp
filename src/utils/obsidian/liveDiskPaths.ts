import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { normalizeVaultSlashes, toVaultPath } from "./obsidianApiUtils.js";

interface DirectoryNames {
  exact: Map<string, Dirent>;
  aliases: Map<string, Dirent | null>;
}

async function readDirectoryNames(root: string, parent: string): Promise<DirectoryNames | undefined> {
  try {
    const directory = await realpath(path.join(root, parent));
    const relative = path.relative(root, directory);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      return undefined;
    }

    const exact = new Map<string, Dirent>();
    const aliases = new Map<string, Dirent | null>();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      exact.set(entry.name, entry);
      const alias = toVaultPath(entry.name);
      aliases.set(alias, aliases.has(alias) ? null : entry);
    }
    return { exact, aliases };
  } catch {
    // A missing or unreadable local directory does not invalidate REST results.
    return undefined;
  }
}

/** Enrich a page of REST results with verified vault-relative disk spellings. */
export async function addLiveDiskPaths(
  vaultRoot: string | undefined,
  entries: Array<{ path: string; diskPath?: string }>,
): Promise<void> {
  if (!vaultRoot) return;
  const directories = new Map<string, Promise<DirectoryNames | undefined>>();
  let canonicalRoot: Promise<string | undefined> | undefined;

  await Promise.all(entries.map(async (entry) => {
    const relativePath = normalizeVaultSlashes(entry.path);
    const segments = relativePath.split("/");
    // REST usually exposes the non-breaking spaces as regular spaces.
    const firstCandidate = segments.findIndex((segment) => /[ \u00a0\u202f]/u.test(segment));
    if (firstCandidate === -1 || segments.some((segment) =>
      segment === "." || segment === ".." || (process.platform === "win32" && segment.includes(":"))
    )) return;

    canonicalRoot ??= realpath(vaultRoot).catch(() => undefined);
    const root = await canonicalRoot;
    if (!root) return;

    const isDirectory = entry.path.endsWith("/");
    let diskPath = segments.slice(0, firstCandidate).join("/");
    for (let index = firstCandidate; index < segments.length; index++) {
      let names = directories.get(diskPath);
      if (!names) {
        names = readDirectoryNames(root, diskPath);
        directories.set(diskPath, names);
      }
      const directory = await names;
      const name = segments[index]!;
      const match = directory?.exact.get(name) ?? directory?.aliases.get(toVaultPath(name));
      const needsDirectory = isDirectory || index < segments.length - 1;
      if (!match || (needsDirectory ? !match.isDirectory() : !match.isFile())) {
        return;
      }
      diskPath = diskPath ? diskPath + "/" + match.name : match.name;
    }
    if (diskPath !== relativePath && /[\u00a0\u202f]/u.test(diskPath)) {
      entry.diskPath = diskPath + (isDirectory ? "/" : "");
    }
  }));
}
