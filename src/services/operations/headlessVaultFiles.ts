import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const foldedPath = (value: string) => value.normalize("NFC").toLowerCase();
export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export function filesystemConflict(message: string, reasonCode = "headless_plan_stale"): never {
  throw new McpError(BaseErrorCode.CONFLICT, message, { reasonCode });
}

export function safeRelativePath(value: string, hidden = false): string {
  if (value.length > 1024 || /[\\:\u0000-\u001f<>"|?*]/u.test(value) || value.split("/").some(part =>
    !part || part !== part.trim() || /[. ]$/u.test(part) || (!hidden && part.startsWith(".")) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Expected an ordinary vault-relative file path.");
  }
  return value;
}

export function readVaultAppSettings(root: string) {
  let settings: Record<string, unknown> = {};
  const file = path.join(root, ".obsidian", "app.json");
  try {
    if (lstatSync(path.dirname(file)).isSymbolicLink() || !lstatSync(file).isFile()) {
      filesystemConflict("Cannot verify the vault's app.json file.");
    }
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_app_settings");
    }
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if (!missing(error)) {
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Cannot read the vault's app.json settings.");
    }
  }
  const format = settings.newLinkFormat === "relative" || settings.newLinkFormat === "absolute"
    ? settings.newLinkFormat : "shortest";
  const configuredTrash = settings.trashFolder ?? settings.trashFolderPath;
  const trashFolder = typeof configuredTrash === "string" && configuredTrash
    ? safeRelativePath(configuredTrash, true) : ".trash";
  if (trashFolder.split("/").some(part => part.toLowerCase() === ".obsidian")) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Trash cannot be placed in Obsidian's configuration directory.");
  }
  return {
    updateLinks: settings.alwaysUpdateLinks !== false,
    useMarkdownLinks: typeof settings.useMarkdownLinks === "boolean" ? settings.useMarkdownLinks : undefined,
    format,
    trashFolder,
    trashPreference: settings.trashOption === "none" || settings.trashOption === "system"
      ? settings.trashOption : "local",
  };
}

export function vaultBinding(root: string) {
  const canonical = realpathSync(root);
  const { dev, ino } = lstatSync(canonical, { bigint: true });
  return { canonical, fingerprint: sha256(JSON.stringify([foldedPath(canonical), String(dev), String(ino)])) };
}

function hashFile(fd: number): string {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(128 * 1024);
  let bytesRead: number;
  while ((bytesRead = readSync(fd, chunk)) > 0) digest.update(chunk.subarray(0, bytesRead));
  return digest.digest("hex");
}

function syncParent(file: string): void {
  // Windows does not provide directory fsync through Node's file API.
  if (process.platform === "win32") return;
  const fd = openSync(path.dirname(file), "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function hardLinkUnavailable(error: unknown): boolean {
  return ["EPERM", "EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EACCES"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

function hardLinksUnsupported(): never {
  throw new McpError(BaseErrorCode.CONFLICT, "The destination does not support exclusive hard-link publication.",
    { reasonCode: "hard_links_unsupported" });
}

const probeName = /^\.optimike-probe-(?:(\d+)-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(-(source|link))?\.tmp$/u;
const activeProbes = new Set<string>();
const startupSweeps = new Map<string, Promise<void>>();

function probeOwnerActive(pid: string | undefined): boolean {
  if (!pid || Number(pid) === process.pid) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ESRCH"; }
}

function removeProbe(file: string): void {
  try {
    if (realpathSync(path.dirname(file)) === path.dirname(file) && lstatSync(file).isFile()) unlinkSync(file);
  } catch { /* A busy probe remains eligible for the next sweep. */ }
}

async function sweepProbes(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      if (realpathSync(directory) !== directory) continue;
      entries = await readdir(directory, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && foldedPath(entry.name) !== ".obsidian") {
        pending.push(file);
      } else if (entry.isFile()) {
        const match = probeName.exec(entry.name);
        if (match && Boolean(match[1]) === Boolean(match[2]) && !activeProbes.has(file) && !probeOwnerActive(match[1])) {
          removeProbe(file);
        }
      }
    }
  }
}

export function startProbeCleanup(root: string): Promise<void> {
  let canonical: string;
  try { canonical = realpathSync(root); }
  catch { return Promise.resolve(); }
  let cleanup = startupSweeps.get(canonical);
  if (!cleanup) {
    cleanup = sweepProbes(canonical);
    startupSweeps.set(canonical, cleanup);
  }
  return cleanup;
}

export class HeadlessVaultFiles {
  private directories = new Map<string, { signature: string; entries: Map<string, string[]> }>();
  constructor(readonly root: string) {}

  private siblings(directory: string, name: string): string[] {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) filesystemConflict("The parent directory changed.");
    const signature = [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":");
    let cached = this.directories.get(directory);
    if (cached?.signature !== signature) {
      const entries = new Map<string, string[]>();
      for (const entry of readdirSync(directory)) {
        const key = foldedPath(entry);
        const group = entries.get(key) ?? [];
        group.push(entry);
        entries.set(key, group);
      }
      cached = { signature, entries };
      this.directories.set(directory, cached);
    }
    return cached.entries.get(foldedPath(name)) ?? [];
  }

  probeHardLinks(source: string, destination: string, allowMissingParents: boolean): void {
    const original = this.locate(source);
    let parent = path.dirname(this.locate(destination, allowMissingParents));
    while (allowMissingParents) {
      try { lstatSync(parent); break; }
      catch (error) {
        if (!missing(error)) throw error;
        parent = path.dirname(parent);
      }
    }
    if (lstatSync(original, { bigint: true }).dev !== lstatSync(parent, { bigint: true }).dev) hardLinksUnsupported();
    const probe = path.join(parent, `.optimike-probe-${process.pid}-${randomUUID()}`);
    const probeSource = probe + "-source.tmp";
    const probeLink = probe + "-link.tmp";
    activeProbes.add(probeSource);
    activeProbes.add(probeLink);
    let created = false;
    let linked = false;
    try {
      const fd = openSync(probeSource, "wx", 0o600);
      created = true;
      try { writeFileSync(fd, "hard link probe\n"); }
      finally { closeSync(fd); }
      linkSync(probeSource, probeLink);
      linked = true;
    } catch (error) {
      if (hardLinkUnavailable(error)) hardLinksUnsupported();
      throw error;
    } finally {
      if (linked) removeProbe(probeLink);
      if (created) removeProbe(probeSource);
      activeProbes.delete(probeLink);
      activeProbes.delete(probeSource);
    }
  }

  async cleanProbes(): Promise<void> {
    await startProbeCleanup(this.root);
    await sweepProbes(this.root);
  }

  private staging(relative: string, operationId: string): string {
    const target = this.locate(relative);
    return path.join(path.dirname(target), `.optimike-${operationId}-${sha256(relative).slice(0, 16)}.tmp`);
  }

  cleanStage(relative: string, operationId: string): void {
    const temporary = this.staging(relative, operationId);
    try {
      if (!lstatSync(temporary).isFile()) filesystemConflict("An operation staging path was replaced.");
      unlinkSync(temporary);
    } catch (error) { if (!missing(error)) throw error; }
  }

  // Check every component and its exact spelling, including Windows junctions.
  // Reject folded siblings rather than relying on OS-specific case behavior.
  locate(relative: string, allowMissingParents = false): string {
    const parts = safeRelativePath(relative, true).split("/");
    let current = this.root;
    for (const [index, name] of parts.entries()) {
      let variants: string[];
      try { variants = this.siblings(current, name); }
      catch (error) {
        if (allowMissingParents && missing(error)) return path.join(current, ...parts.slice(index));
        throw error;
      }
      current = path.join(current, name);
      if (!variants.length) {
        if (index === parts.length - 1 || allowMissingParents) return path.join(current, ...parts.slice(index + 1));
        throw new McpError(BaseErrorCode.NOT_FOUND, "The parent folder must already exist.",
          { reasonCode: "headless_parent_missing" });
      }
      if (variants.length !== 1 || variants[0] !== name) filesystemConflict("The vault path has a case or Unicode collision.");
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        filesystemConflict("The vault path is not a regular file in ordinary directories.");
      }
    }
    return current;
  }

  state(relative: string, options: { allowMissingParents?: boolean; readBytes?: boolean } = {}) {
    const absolute = this.locate(relative, options.allowMissingParents);
    let fd: number;
    try {
      fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) filesystemConflict("The vault path is not a regular file.");
      const bytes = options.readBytes ? readFileSync(fd) : undefined;
      const hash = bytes ? sha256(bytes) : hashFile(fd);
      const current = lstatSync(absolute, { bigint: true });
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeNs !== stat.mtimeNs ||
          current.ctimeNs !== stat.ctimeNs || current.size !== stat.size) {
        filesystemConflict("A file changed while its bytes were being verified.");
      }
      return { absolute, bytes, hash, identity: `${stat.dev}:${stat.ino}`,
        mode: Number(stat.mode & 0o777n), size: Number(stat.size) };
    } finally {
      closeSync(fd);
    }
  }

  createTrashParents(relative: string): void {
    const destination = this.locate(relative, true);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    this.locate(relative);
  }

  replace(relative: string, expected: string, next: Buffer, operationId: string): void {
    const current = this.state(relative);
    if (current?.hash !== expected) filesystemConflict("A file changed during the move.");
    const temporary = this.staging(relative, operationId);
    const fd = openSync(temporary, "wx", current.mode);
    try {
      try {
        writeFileSync(fd, next);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (this.state(relative)?.hash !== expected) filesystemConflict("A file changed during the move.");
      renameSync(temporary, current.absolute);
      syncParent(current.absolute);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if (!missing(error)) throw error; }
    }
  }

  // Portable exclusive publication. A crash between link/unlink leaves two
  // names for one inode; recovery can prove that it owns both names.
  relocate(source: string, destination: string, before: string, identity: string, markPublished: () => void): void {
    const original = this.state(source);
    if (original?.hash !== before || original.identity !== identity) filesystemConflict("The source changed during the move.");
    const target = this.state(destination);
    if (!target) {
      try { linkSync(original.absolute, this.locate(destination)); }
      catch (error) {
        if (hardLinkUnavailable(error)) hardLinksUnsupported();
        throw error;
      }
    }
    const published = this.state(destination);
    const current = this.state(source);
    if (published?.identity !== identity || published.hash !== before ||
        current?.identity !== identity || current.hash !== before) {
      filesystemConflict("The destination could not be verified before removing the original name.");
    }
    syncParent(published.absolute);
    markPublished();
    unlinkSync(original.absolute);
    syncParent(original.absolute);
  }
}
