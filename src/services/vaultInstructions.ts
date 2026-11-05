import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
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
 * Paths are kept exactly as the caller wrote them (the backend writes that
 * exact name). A path whose Unicode forms differ (NFC/NFD) is checked under
 * every form, because a backend or a file system may resolve either one.
 *
 * Nothing here scans the vault: one evaluation probes only the folders on the
 * chains of its targets, with bounded bytes, time and concurrency.
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

export interface InstructionReadOptions {
  /** Aborted when the probe or the evaluation runs out of time. */
  signal?: AbortSignal;
  /** Largest accepted file, in UTF-8 bytes. */
  maxBytes: number;
}

/** Where the authoritative content of instruction files comes from. */
export interface VaultInstructionsSource {
  readonly kind: "rest" | "filesystem";
  /**
   * Resolves the text content, `null` only when the file does not exist;
   * throws `VaultInstructionsUnavailableError` when it cannot be known.
   */
  read(vaultPath: string, options?: InstructionReadOptions): Promise<string | null>;
}

export type VaultInstructionsUnavailableReason =
  | "timeout"
  | "source_error"
  | "too_large"
  | "invalid_response";

export class VaultInstructionsUnavailableError extends Error {
  constructor(readonly reason: VaultInstructionsUnavailableReason) {
    super("Vault instruction files could not be read.");
  }
}

/** Default bounds of one evaluation (documented in docs/vault-instructions.md). */
export const VAULT_INSTRUCTIONS_LIMITS = {
  /** One instruction file. */
  maxFileBytes: 256 * 1024,
  /** All instruction files read by one evaluation. */
  maxEvaluationBytes: 1024 * 1024,
  /** One probe (one file). */
  probeTimeoutMs: 2_500,
  /** One evaluation, queueing included. */
  evaluationTimeoutMs: 5_000,
  /** Probes in flight for one evaluation. */
  concurrency: 4,
  /** Probes in flight for the whole backend process. */
  globalConcurrency: 8,
} as const;

export interface InstructionProbeOptions {
  concurrency?: number;
  probeTimeoutMs?: number;
  evaluationTimeoutMs?: number;
  maxFileBytes?: number;
  maxEvaluationBytes?: number;
  /** Process-wide budget shared by every evaluation of a runtime. */
  limiter?: InstructionProbeLimiter;
}

/** Normalised content digest shared by proofs and evaluations. */
export function instructionContentSha256(content: string): string {
  const normalized = content.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Canonical vault-relative path: `/` separators, no leading `./` or `/`, no
 * empty, `.` or `..` segment. The characters are kept as written: no Unicode
 * normalisation, so the path is the one the backend writes. `""` is the vault
 * root. `undefined` means the value cannot be a vault path.
 */
export function normalizeVaultPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > 4096 || /[\u0000]/u.test(value)) return undefined;
  const segments = value
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

/**
 * Every spelling a backend may resolve for this path: the exact one first,
 * then its NFC and NFD forms when they differ. Each one is checked.
 */
export function vaultPathAliases(vaultPath: string): string[] {
  return [
    ...new Set([vaultPath, vaultPath.normalize("NFC"), vaultPath.normalize("NFD")]),
  ];
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

/**
 * Process-wide budget of probes in flight. A slot is released only when the
 * underlying read settles, so a read that ignores its abort signal keeps
 * counting against the budget instead of piling up behind it.
 */
export class InstructionProbeLimiter {
  private active = 0;
  private readonly waiting: Array<{ grant: () => void }> = [];

  constructor(readonly max: number = VAULT_INSTRUCTIONS_LIMITS.globalConcurrency) {}

  get inFlight(): number {
    return this.active;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    const release = () => {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next.grant();
    };
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(once(release));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          this.active += 1;
          resolve(once(release));
        },
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

function abortReason(signal: AbortSignal): VaultInstructionsUnavailableError {
  return signal.reason instanceof VaultInstructionsUnavailableError
    ? signal.reason
    : new VaultInstructionsUnavailableError("timeout");
}

/** Rejects with `timeout` after `ms`; the work itself is not cancelled. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
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

function abortableTimer(
  controller: AbortController,
  ms: number,
): NodeJS.Timeout {
  const timer = setTimeout(
    () => controller.abort(new VaultInstructionsUnavailableError("timeout")),
    ms,
  );
  timer.unref?.();
  return timer;
}

/** Rejects as soon as the signal aborts, whether or not `work` honours it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function asUnavailable(error: unknown): VaultInstructionsUnavailableError {
  return error instanceof VaultInstructionsUnavailableError
    ? error
    : new VaultInstructionsUnavailableError("source_error");
}

/**
 * Reads instruction files once per call: deduplicated, at most `concurrency`
 * probes of this call and `limiter.max` probes of the process in flight, each
 * bounded in time and bytes, the whole call bounded too. The first failure or
 * the deadline aborts every probe still running.
 */
export async function probeInstructionFiles(
  source: VaultInstructionsSource,
  paths: readonly string[],
  options: InstructionProbeOptions = {},
): Promise<Map<string, string | null>> {
  const unique = [...new Set(paths)];
  const results = new Map<string, string | null>();
  if (unique.length === 0) return results;
  const concurrency = Math.max(1, options.concurrency ?? VAULT_INSTRUCTIONS_LIMITS.concurrency);
  const probeTimeout = options.probeTimeoutMs ?? VAULT_INSTRUCTIONS_LIMITS.probeTimeoutMs;
  const maxFileBytes = options.maxFileBytes ?? VAULT_INSTRUCTIONS_LIMITS.maxFileBytes;
  const maxEvaluationBytes =
    options.maxEvaluationBytes ?? VAULT_INSTRUCTIONS_LIMITS.maxEvaluationBytes;
  const evaluation = new AbortController();
  const evaluationTimer = abortableTimer(
    evaluation,
    options.evaluationTimeoutMs ??
      Math.max(VAULT_INSTRUCTIONS_LIMITS.evaluationTimeoutMs, probeTimeout),
  );
  let totalBytes = 0;
  let next = 0;
  const probe = async (current: string) => {
    const release = options.limiter
      ? await options.limiter.acquire(evaluation.signal)
      : () => undefined;
    const controller = new AbortController();
    const onEvaluationAbort = () => controller.abort(evaluation.signal.reason);
    evaluation.signal.addEventListener("abort", onEvaluationAbort, { once: true });
    const timer = abortableTimer(controller, probeTimeout);
    let work: Promise<string | null>;
    try {
      work = Promise.resolve(
        source.read(current, { signal: controller.signal, maxBytes: maxFileBytes }),
      );
    } catch (error) {
      work = Promise.reject(error);
    }
    work.then(release, release);
    try {
      const content = await untilAborted(work, controller.signal);
      if (content !== null) {
        if (typeof content !== "string") {
          throw new VaultInstructionsUnavailableError("invalid_response");
        }
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > maxFileBytes) throw new VaultInstructionsUnavailableError("too_large");
        totalBytes += bytes;
        if (totalBytes > maxEvaluationBytes) {
          throw new VaultInstructionsUnavailableError("too_large");
        }
      }
      results.set(current, content);
    } finally {
      clearTimeout(timer);
      evaluation.signal.removeEventListener("abort", onEvaluationAbort);
    }
  };
  const worker = async () => {
    while (next < unique.length && !evaluation.signal.aborted) {
      const current = unique[next++];
      try {
        await probe(current);
      } catch (error) {
        const failure = asUnavailable(error);
        // Stop every other probe of this evaluation, including queued ones.
        if (!evaluation.signal.aborted) evaluation.abort(failure);
        throw failure;
      }
    }
  };
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, unique.length) }, worker),
    );
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failed) throw asUnavailable(failed.reason);
    if (evaluation.signal.aborted) throw abortReason(evaluation.signal);
    return results;
  } finally {
    clearTimeout(evaluationTimer);
  }
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
 * order: folder depth, then the configured name order. Each target is checked
 * under every Unicode spelling of its path (see `vaultPathAliases`).
 */
export async function currentInstructionRules(
  source: VaultInstructionsSource,
  names: readonly string[],
  targets: readonly VaultInstructionsTarget[],
  options: InstructionProbeOptions = {},
): Promise<CurrentInstructionRules> {
  const chains = targets.map((target) => [
    ...new Set(
      vaultPathAliases(target.path).flatMap((alias) =>
        instructionFolders(alias, target.folder).flatMap((folder) =>
          names.flatMap((name) =>
            vaultPathAliases(name).map((spelling) => instructionFilePath(folder, spelling)),
          ),
        ),
      ),
    ),
  ]);
  const contents = await probeInstructionFiles(source, chains.flat(), options);
  const digests = new Map<string, string>();
  for (const [filePath, content] of contents) {
    if (content !== null) digests.set(filePath, instructionContentSha256(content));
  }
  const rank = (filePath: string) => {
    const segments = filePath.split("/");
    const base = segments.at(-1)!.normalize("NFC");
    return [segments.length, names.findIndex((name) => name.normalize("NFC") === base)] as const;
  };
  // Spellings of one path that answer with the same content are one file (a
  // folder stored in NFD that Obsidian indexes in NFC answers under both),
  // listed under its NFC spelling when it answers: the one obsidian_read_note
  // serves. Different contents remain distinct files.
  const listedAs = new Map<string, string>();
  const kept = new Map<string, string>();
  const notComposed = (filePath: string) => Number(filePath !== filePath.normalize("NFC"));
  for (const filePath of [...digests.keys()].sort(
    (a, b) => notComposed(a) - notComposed(b) || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const key = `${filePath.normalize("NFC")}|${digests.get(filePath)}`;
    if (!kept.has(key)) kept.set(key, filePath);
    listedAs.set(filePath, kept.get(key)!);
  }
  const files = [...kept.values()]
    .sort((a, b) => {
      const [depthA, nameA] = rank(a);
      const [depthB, nameB] = rank(b);
      return depthA - depthB || nameA - nameB || (a < b ? -1 : a > b ? 1 : 0);
    })
    .map((filePath) => ({ path: filePath, sha256: digests.get(filePath)! }));
  return {
    targets: targets.map((target, index) => {
      const listed = new Set(chains[index].map((filePath) => listedAs.get(filePath)));
      return {
        path: target.path,
        rules: files.map((entry) => entry.path).filter((filePath) => listed.has(filePath)),
      };
    }),
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
    // A read under another spelling of the same path counts when what it
    // served is the current authoritative content of this one.
    const read =
      proof === file.sha256 ||
      vaultPathAliases(file.path).some(
        (alias) => ledger.proof(reader.key, alias) === file.sha256,
      );
    return {
      path: file.path,
      sha256: file.sha256,
      state: read ? "read" : proof === undefined ? "unread" : "changed",
    };
  });
}

/**
 * REST source: a GET of the exact path, read as raw text. A 404 means the
 * file does not exist; any other answer that is not text (a body parsed as
 * JSON, for instance) is an invalid response, never an absent file.
 */
export function restInstructionsSource(
  getFileText: (vaultPath: string, options: InstructionReadOptions) => Promise<unknown>,
  isNotFound: (error: unknown) => boolean,
): VaultInstructionsSource {
  return {
    kind: "rest",
    async read(vaultPath, options) {
      const bounded = options ?? { maxBytes: VAULT_INSTRUCTIONS_LIMITS.maxFileBytes };
      let content: unknown;
      try {
        content = await getFileText(vaultPath, bounded);
      } catch (error) {
        if (error instanceof VaultInstructionsUnavailableError) throw error;
        if (isNotFound(error)) return null;
        if (bounded.signal?.aborted) throw abortReason(bounded.signal);
        throw new VaultInstructionsUnavailableError("source_error");
      }
      if (typeof content !== "string") {
        throw new VaultInstructionsUnavailableError("invalid_response");
      }
      if (Buffer.byteLength(content, "utf8") > bounded.maxBytes) {
        throw new VaultInstructionsUnavailableError("too_large");
      }
      return content;
    },
  };
}

/**
 * Filesystem source confined to the vault root. A symbolic link, a folder or
 * a path resolving outside the root counts as absent. At most `maxBytes + 1`
 * bytes are ever read.
 */
export function filesystemInstructionsSource(
  vaultRoot: string,
): VaultInstructionsSource {
  const root = path.resolve(vaultRoot);
  return {
    kind: "filesystem",
    async read(vaultPath, options) {
      const maxBytes = options?.maxBytes ?? VAULT_INSTRUCTIONS_LIMITS.maxFileBytes;
      const signal = options?.signal;
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
        if (stat.size > maxBytes) throw new VaultInstructionsUnavailableError("too_large");
        if (signal?.aborted) throw abortReason(signal);
        const handle = await open(absolute, "r");
        try {
          const buffer = Buffer.alloc(maxBytes + 1);
          let total = 0;
          while (total < buffer.length) {
            if (signal?.aborted) throw abortReason(signal);
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          if (total > maxBytes) throw new VaultInstructionsUnavailableError("too_large");
          return buffer.toString("utf8", 0, total);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof VaultInstructionsUnavailableError) throw error;
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw new VaultInstructionsUnavailableError("source_error");
      }
    },
  };
}
