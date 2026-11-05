import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { VaultInstructionsMode } from "./vaultInstructionsNames.js";

/**
 * Vault agent instructions (the AGENTS.md cascade).
 *
 * The files that apply to a vault path are every configured instruction file
 * name that exists in the vault root and in each parent folder of that path,
 * root first. A reader proves it read one of them when `obsidian_read_note`
 * served it; the proof is bound to the exact content served (SHA-256 after
 * line-ending normalisation), so an edited file needs a new read.
 *
 * Nothing here scans the vault: one evaluation probes only the folders on the
 * chains of its targets.
 */

export const VAULT_INSTRUCTIONS_CONTRACT_VERSION = 1;

export type InstructionFileState = "read" | "unread" | "changed";

export type VaultInstructionsReaderScope =
  | "session"
  | "reader-context"
  | "identity"
  | "process";

export interface VaultInstructionsReader {
  key: string;
  scope: VaultInstructionsReaderScope;
}

/** Where the authoritative content of instruction files comes from. */
export interface VaultInstructionsSource {
  readonly kind: "rest" | "filesystem";
  /** Resolves the content, `null` when the file does not exist; throws when unknown. */
  read(vaultPath: string): Promise<string | null>;
}

export class VaultInstructionsUnavailableError extends Error {
  constructor(readonly reason: "timeout" | "source_error") {
    super("Vault instruction files could not be read.");
  }
}

/** Normalised content digest shared by proofs and evaluations. */
export function instructionContentSha256(content: string): string {
  const normalized = content.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Canonical vault-relative path: NFC, `/` separators, no leading `./` or `/`,
 * no empty, `.` or `..` segment. `""` is the vault root. `undefined` means the
 * value cannot be a vault path.
 */
export function normalizeVaultPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > 4096 || /[\u0000]/u.test(value)) return undefined;
  const segments = value
    .normalize("NFC")
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment, index, all) => {
      // Tolerate a leading "./" and trailing or repeated separators only.
      if (segment === "") return false;
      if (segment === "." && index === 0 && all.length > 1) return false;
      return true;
    });
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  if (segments.length > 64) return undefined;
  if (segments.length > 0 && /^[a-z]:$/iu.test(segments[0])) return undefined;
  return segments.join("/");
}

/** Folders whose instruction files apply to a target, root first. */
export function instructionFolders(
  target: string,
  targetIsFolder = false,
): string[] {
  const segments = target ? target.split("/") : [];
  const depth = targetIsFolder ? segments.length : segments.length - 1;
  const folders = [""];
  for (let index = 1; index <= depth; index += 1) {
    folders.push(segments.slice(0, index).join("/"));
  }
  return folders;
}

export function instructionFilePath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export interface VaultInstructionsTarget {
  /** Canonical vault path, or the folder when `folder` is true. */
  path: string;
  folder?: boolean;
}

export interface EvaluatedInstructionFile {
  path: string;
  sha256: string;
  state: InstructionFileState;
}

export interface VaultInstructionsEvaluation {
  mode: VaultInstructionsMode;
  readerScope: VaultInstructionsReaderScope;
  targets: Array<{ path: string; rules: string[] }>;
  files: EvaluatedInstructionFile[];
  rulesDigest: string;
  complete: boolean;
}

/** Bounded in-memory registry of which instruction versions each reader saw. */
export class VaultInstructionsReadLedger {
  private readonly readers = new Map<
    string,
    { proofs: Map<string, string>; lastSeen: number }
  >();

  constructor(
    private readonly options: {
      maxReaders?: number;
      maxPathsPerReader?: number;
      idleMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private entry(readerKey: string, create: boolean) {
    const now = this.now();
    const idleMs = this.options.idleMs ?? 24 * 60 * 60 * 1000;
    let entry = this.readers.get(readerKey);
    if (entry && now - entry.lastSeen > idleMs) {
      this.readers.delete(readerKey);
      entry = undefined;
    }
    if (!entry) {
      if (!create) return undefined;
      entry = { proofs: new Map(), lastSeen: now };
    } else {
      this.readers.delete(readerKey);
    }
    entry.lastSeen = now;
    this.readers.set(readerKey, entry);
    const maxReaders = this.options.maxReaders ?? 1024;
    while (this.readers.size > maxReaders) {
      const oldest = this.readers.keys().next().value as string;
      this.readers.delete(oldest);
    }
    return entry;
  }

  record(readerKey: string, vaultPath: string, sha256: string): void {
    const entry = this.entry(readerKey, true)!;
    entry.proofs.delete(vaultPath);
    entry.proofs.set(vaultPath, sha256);
    const maxPaths = this.options.maxPathsPerReader ?? 1024;
    while (entry.proofs.size > maxPaths) {
      const oldest = entry.proofs.keys().next().value as string;
      entry.proofs.delete(oldest);
    }
  }

  proof(readerKey: string, vaultPath: string): string | undefined {
    return this.entry(readerKey, false)?.proofs.get(vaultPath);
  }
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new VaultInstructionsUnavailableError("timeout")),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads instruction files once per call: deduplicated, at most `concurrency`
 * probes in flight, each bounded by `probeTimeoutMs`.
 */
export async function probeInstructionFiles(
  source: VaultInstructionsSource,
  paths: readonly string[],
  options: { concurrency?: number; probeTimeoutMs?: number } = {},
): Promise<Map<string, string | null>> {
  const unique = [...new Set(paths)];
  const results = new Map<string, string | null>();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const timeout = options.probeTimeoutMs ?? 2_500;
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const current = unique[next++];
      try {
        results.set(current, await withDeadline(source.read(current), timeout));
      } catch (error) {
        if (error instanceof VaultInstructionsUnavailableError) throw error;
        throw new VaultInstructionsUnavailableError("source_error");
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, worker),
  );
  return results;
}

export function vaultInstructionsRulesDigest(
  vaultId: string,
  names: readonly string[],
  files: ReadonlyArray<{ path: string; sha256: string }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: VAULT_INSTRUCTIONS_CONTRACT_VERSION,
        vault: vaultId,
        names,
        files: files.map((file) => [file.path, file.sha256]),
      }),
      "utf8",
    )
    .digest("hex");
}

export interface CurrentInstructionRules {
  targets: Array<{ path: string; rules: string[] }>;
  files: Array<{ path: string; sha256: string }>;
}

/**
 * Current applicable instruction files for the targets, in a deterministic
 * order: folder depth, then the configured name order.
 */
export async function currentInstructionRules(
  source: VaultInstructionsSource,
  names: readonly string[],
  targets: readonly VaultInstructionsTarget[],
  options: { concurrency?: number; probeTimeoutMs?: number } = {},
): Promise<CurrentInstructionRules> {
  const chains = targets.map((target) =>
    instructionFolders(target.path, target.folder).flatMap((folder) =>
      names.map((name) => instructionFilePath(folder, name)),
    ),
  );
  const contents = await probeInstructionFiles(source, chains.flat(), options);
  const digests = new Map<string, string>();
  for (const [filePath, content] of contents) {
    if (content !== null) digests.set(filePath, instructionContentSha256(content));
  }
  const rank = (filePath: string) => {
    const segments = filePath.split("/");
    return [segments.length, names.indexOf(segments.at(-1)!)] as const;
  };
  const files = [...digests.keys()]
    .sort((a, b) => {
      const [depthA, nameA] = rank(a);
      const [depthB, nameB] = rank(b);
      return depthA - depthB || nameA - nameB || (a < b ? -1 : a > b ? 1 : 0);
    })
    .map((filePath) => ({ path: filePath, sha256: digests.get(filePath)! }));
  return {
    targets: targets.map((target, index) => ({
      path: target.path,
      rules: chains[index].filter((filePath) => digests.has(filePath)),
    })),
    files,
  };
}

export function evaluateReader(
  ledger: VaultInstructionsReadLedger,
  reader: VaultInstructionsReader,
  files: ReadonlyArray<{ path: string; sha256: string }>,
): EvaluatedInstructionFile[] {
  return files.map((file) => {
    const proof = ledger.proof(reader.key, file.path);
    return {
      path: file.path,
      sha256: file.sha256,
      state:
        proof === undefined ? "unread" : proof === file.sha256 ? "read" : "changed",
    };
  });
}

/** REST source: a GET of the exact path; a 404 means the file does not exist. */
export function restInstructionsSource(
  getFileContent: (vaultPath: string) => Promise<unknown>,
  isNotFound: (error: unknown) => boolean,
): VaultInstructionsSource {
  return {
    kind: "rest",
    async read(vaultPath) {
      try {
        const content = await getFileContent(vaultPath);
        return typeof content === "string" ? content : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw new VaultInstructionsUnavailableError("source_error");
      }
    },
  };
}

/**
 * Filesystem source confined to the vault root. A symbolic link, a folder or
 * a path resolving outside the root counts as absent.
 */
export function filesystemInstructionsSource(
  vaultRoot: string,
): VaultInstructionsSource {
  const root = path.resolve(vaultRoot);
  return {
    kind: "filesystem",
    async read(vaultPath) {
      const absolute = path.resolve(root, ...vaultPath.split("/"));
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
      try {
        const stat = await lstat(absolute);
        if (!stat.isFile()) return null;
        const realRoot = await realpath(root);
        const realFile = await realpath(absolute);
        const realRelative = path.relative(realRoot, realFile);
        if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
          return null;
        }
        return await readFile(absolute, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw new VaultInstructionsUnavailableError("source_error");
      }
    },
  };
}
