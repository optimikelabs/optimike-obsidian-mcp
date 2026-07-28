import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const ExternalRootCapabilitySchema = z.enum([
  "visible",
  "readable",
  "handoff",
  "move",
]);

const ExternalRootLimitsSchema = z
  .object({
    maxDepth: z.number().int().min(0).max(20).default(6),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .max(200 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    maxListEntries: z.number().int().positive().max(5000).default(500),
    maxTextChars: z.number().int().positive().max(2_000_000).default(200_000),
  })
  .strict()
  .default({});

export const ExternalRootSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u,
        "Root id must be a stable lowercase logical identifier.",
      ),
    path: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), "Root path must be absolute.")
      .refine(
        (value) => !value.startsWith("\\\\") && !value.startsWith("//"),
        "UNC and network roots are not supported.",
      ),
    capabilities: z
      .array(ExternalRootCapabilitySchema)
      .min(1)
      .transform((values) => [...new Set(values)]),
    include: z.array(z.string().min(1)).default(["**"]),
    exclude: z
      .array(z.string().min(1))
      .default(["**/.git/**", "**/node_modules/**"]),
    limits: ExternalRootLimitsSchema,
  })
  .strict()
  .superRefine((root, context) => {
    if (
      root.capabilities.includes("handoff") &&
      !root.capabilities.includes("readable")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "The handoff capability requires readable.",
      });
    }
  });

export const ExternalRootsConfigSchema = z
  .object({
    version: z.literal(1),
    roots: z.array(ExternalRootSchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const root of value.roots) {
      if (seen.has(root.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roots"],
          message: `Duplicate external root id: ${root.id}`,
        });
      }
      seen.add(root.id);
    }
  });

export type ExternalRootCapability = z.infer<
  typeof ExternalRootCapabilitySchema
>;
export type ExternalRootConfig = z.infer<typeof ExternalRootSchema>;
export type ExternalRootsConfig = z.infer<typeof ExternalRootsConfigSchema>;

export type ExternalRootErrorCode =
  | "configuration_invalid"
  | "root_unknown"
  | "root_unavailable"
  | "capability_denied"
  | "path_invalid"
  | "path_outside_root"
  | "path_not_allowed"
  | "path_link_unsupported"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "target_exists"
  | "precondition_failed"
  | "too_large"
  | "unsupported"
  | "encrypted"
  | "inaccessible"
  | "non_verifiable"
  | "timeout";

export class ExternalRootError extends Error {
  constructor(
    public readonly code: ExternalRootErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExternalRootError";
  }
}

type RootRuntime = {
  config: ExternalRootConfig;
  canonicalPath?: string;
};

export type ExternalEntry = {
  path: string;
  name: string;
  type: "file" | "directory" | "link";
  size?: number;
  modifiedAt?: string;
};

export type ExternalMoveSnapshot = {
  rootId: string;
  sourceRelativePath: string;
  targetRelativePath: string;
  size: number;
  modifiedAt: string;
  sha256: string;
};

const textExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".log",
]);

const HANDOFF_DIRECTORY_PREFIX = "optimike-external-handoff-";
const HANDOFF_OWNER_FILE = ".owner.json";
const HANDOFF_OWNER_KIND = "optimike-external-handoff";
const HANDOFF_MAX_FILES = 16;
const HANDOFF_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const HANDOFF_TTL_MS = 60 * 60 * 1000;
const HANDOFF_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const HANDOFF_OWNER_HEARTBEAT_GRACE_MS = 20 * 60 * 1000;

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!trimmed || trimmed === ".") return "";
  if (path.posix.isAbsolute(trimmed) || /^[a-z]:\//iu.test(trimmed)) {
    throw new ExternalRootError(
      "path_invalid",
      "External paths must be relative to a configured root.",
    );
  }
  const segments = trimmed.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ExternalRootError(
      "path_invalid",
      "External paths cannot contain empty, '.' or '..' segments.",
    );
  }
  return segments.join("/");
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => path.matchesGlob(relativePath, pattern));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function decodeUtf8(buffer: Buffer): string {
  if (buffer.includes(0)) {
    throw new ExternalRootError(
      "unsupported",
      "The file contains binary data and cannot be returned as UTF-8 text.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ExternalRootError(
      "non_verifiable",
      "The file is not valid UTF-8 text.",
    );
  }
}

export class ExternalRootsService {
  private readonly roots: Map<string, RootRuntime>;
  private handoffDirectory?: string;
  private handoffLock: Promise<void> = Promise.resolve();
  private handoffSweepTimer?: ReturnType<typeof setInterval>;
  private readonly startupScavenge: Promise<void>;

  private constructor(config: ExternalRootsConfig) {
    this.roots = new Map(
      config.roots.map((root) => [root.id, { config: root }]),
    );
    this.startupScavenge = this.scavengeStaleHandoffDirectories().catch(
      () => undefined,
    );
  }

  static fromConfig(config: unknown): ExternalRootsService {
    const parsed = ExternalRootsConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new ExternalRootError(
        "configuration_invalid",
        `Invalid external roots configuration: ${parsed.error.message}`,
      );
    }
    return new ExternalRootsService(parsed.data);
  }

  static async fromConfigFile(filePath: string): Promise<ExternalRootsService> {
    if (!path.isAbsolute(filePath)) {
      throw new ExternalRootError(
        "configuration_invalid",
        "MCP_EXTERNAL_ROOTS_FILE must be an absolute path.",
      );
    }
    try {
      const raw = await readFile(filePath, "utf8");
      return ExternalRootsService.fromConfig(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ExternalRootError) throw error;
      throw new ExternalRootError(
        "configuration_invalid",
        `Unable to load external roots configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async listRoots(): Promise<
    Array<{
      id: string;
      capabilities: ExternalRootCapability[];
      available: boolean;
      limits: ExternalRootConfig["limits"];
    }>
  > {
    await this.startupScavenge;
    const result = [];
    for (const runtime of this.roots.values()) {
      let available = false;
      try {
        const canonical = await this.canonicalRoot(runtime);
        available = (await stat(canonical)).isDirectory();
      } catch {
        available = false;
      }
      result.push({
        id: runtime.config.id,
        capabilities: runtime.config.capabilities,
        available,
        limits: runtime.config.limits,
      });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  async list(
    rootId: string,
    requestedPath = "",
    requestedDepth = 1,
    requestedMaxEntries?: number,
  ): Promise<{
    rootId: string;
    path: string;
    entries: ExternalEntry[];
    truncated: boolean;
  }> {
    const runtime = this.requireCapability(rootId, "visible");
    const relativePath = normalizeRelativePath(requestedPath);
    const depth = Math.min(
      Math.max(0, requestedDepth),
      runtime.config.limits.maxDepth,
    );
    const maxEntries = Math.min(
      requestedMaxEntries ?? runtime.config.limits.maxListEntries,
      runtime.config.limits.maxListEntries,
    );
    const directory = await this.resolvePath(runtime, relativePath);
    if (!(await stat(directory)).isDirectory()) {
      throw new ExternalRootError(
        "not_a_directory",
        "The requested external path is not a directory.",
      );
    }

    const entries: ExternalEntry[] = [];
    const queue: Array<{
      absolutePath: string;
      relativePath: string;
      depth: number;
    }> = [{ absolutePath: directory, relativePath, depth: 0 }];
    let truncated = false;

    while (queue.length > 0 && !truncated) {
      const current = queue.shift()!;
      const children = (
        await readdir(current.absolutePath, {
          withFileTypes: true,
        })
      ).sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        const childRelative = [current.relativePath, child.name]
          .filter(Boolean)
          .join("/")
          .replace(/\\/gu, "/");
        if (matchesAny(childRelative, runtime.config.exclude)) continue;

        const childAbsolute = path.join(current.absolutePath, child.name);
        const childStat = await lstat(childAbsolute);
        const isLink = childStat.isSymbolicLink();
        const isDirectory = childStat.isDirectory();
        const included =
          isLink ||
          isDirectory ||
          matchesAny(childRelative, runtime.config.include);

        if (included) {
          entries.push({
            path: childRelative,
            name: child.name,
            type: isLink ? "link" : isDirectory ? "directory" : "file",
            size: isDirectory ? undefined : childStat.size,
            modifiedAt: childStat.mtime.toISOString(),
          });
        }

        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }

        if (isDirectory && !isLink && current.depth < depth) {
          await this.resolvePath(runtime, childRelative);
          queue.push({
            absolutePath: childAbsolute,
            relativePath: childRelative,
            depth: current.depth + 1,
          });
        }
      }
    }

    return { rootId, path: relativePath, entries, truncated };
  }

  async getStat(
    rootId: string,
    requestedPath: string,
    includeHash = false,
  ): Promise<{
    rootId: string;
    path: string;
    type: "file" | "directory";
    size: number;
    modifiedAt: string;
    sha256?: string;
  }> {
    const runtime = this.requireCapability(rootId, "visible");
    const relativePath = normalizeRelativePath(requestedPath);
    const absolutePath = await this.resolvePath(runtime, relativePath);
    const fileStat = await stat(absolutePath);
    const type = fileStat.isDirectory() ? "directory" : "file";
    const response: {
      rootId: string;
      path: string;
      type: "file" | "directory";
      size: number;
      modifiedAt: string;
      sha256?: string;
    } = {
      rootId,
      path: relativePath,
      type,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
    if (includeHash) {
      this.assertCapability(runtime, "readable");
      if (type !== "file") {
        throw new ExternalRootError("not_a_file", "Only files can be hashed.");
      }
      response.sha256 = sha256(await this.readBuffer(runtime, relativePath));
    }
    return response;
  }

  async readText(
    rootId: string,
    requestedPath: string,
    requestedMaxChars?: number,
  ): Promise<{
    rootId: string;
    path: string;
    text: string;
    chars: number;
    truncated: boolean;
    sha256: string;
  }> {
    const runtime = this.requireCapability(rootId, "readable");
    const relativePath = normalizeRelativePath(requestedPath);
    const extension = path.extname(relativePath).toLowerCase();
    if (!textExtensions.has(extension)) {
      throw new ExternalRootError(
        "unsupported",
        "external_read supports UTF-8 text files. A local stdio client can request external_handoff and use its own document tools for supported binary documents.",
      );
    }
    const buffer = await this.readBuffer(runtime, relativePath);
    const fullText = decodeUtf8(buffer);
    const maxChars = Math.min(
      requestedMaxChars ?? runtime.config.limits.maxTextChars,
      runtime.config.limits.maxTextChars,
    );
    const text = fullText.slice(0, maxChars);
    return {
      rootId,
      path: relativePath,
      text,
      chars: text.length,
      truncated: text.length < fullText.length,
      sha256: sha256(buffer),
    };
  }

  async handoff(
    rootId: string,
    requestedPath: string,
    includeHash = true,
    maxBytesOverride?: number,
  ): Promise<{
    rootId: string;
    path: string;
    localPath: string;
    size: number;
    modifiedAt: string;
    sha256?: string;
  }> {
    const runtime = this.requireCapability(rootId, "handoff");
    this.assertCapability(runtime, "readable");
    const relativePath = normalizeRelativePath(requestedPath);
    return this.withHandoffLock(async () => {
      // Keep the verified read inside the same lock as allocation and copy so
      // concurrent handoffs cannot accumulate multiple max-sized buffers.
      const verified = await this.readVerifiedBuffer(
        runtime,
        relativePath,
        maxBytesOverride,
      );
      const localPath = await this.createHandoffCopy(
        relativePath,
        verified.buffer,
      );
      const response: {
        rootId: string;
        path: string;
        localPath: string;
        size: number;
        modifiedAt: string;
        sha256?: string;
      } = {
        rootId,
        path: relativePath,
        localPath,
        size: verified.buffer.length,
        modifiedAt: verified.modifiedAt,
      };
      if (includeHash) {
        response.sha256 = sha256(verified.buffer);
      }
      return response;
    });
  }

  async planMove(
    rootId: string,
    requestedSourcePath: string,
    requestedTargetPath: string,
  ): Promise<ExternalMoveSnapshot> {
    const runtime = this.requireCapability(rootId, "move");
    const sourceRelativePath = normalizeRelativePath(requestedSourcePath);
    const targetRelativePath = normalizeRelativePath(requestedTargetPath);
    if (!sourceRelativePath || !targetRelativePath) {
      throw new ExternalRootError(
        "path_invalid",
        "External move paths must identify regular files.",
      );
    }
    if (sourceRelativePath === targetRelativePath) {
      throw new ExternalRootError(
        "path_invalid",
        "External move source and target must be different.",
      );
    }

    const sourcePath = await this.resolvePath(runtime, sourceRelativePath);
    const sourceStat = await stat(sourcePath, { bigint: true });
    if (!sourceStat.isFile()) {
      throw new ExternalRootError(
        "not_a_file",
        "Only regular external files can be moved.",
      );
    }
    this.assertAllowed(runtime, targetRelativePath);
    const rootPath = await this.canonicalRoot(runtime);
    const targetPath = path.join(rootPath, ...targetRelativePath.split("/"));
    if (!isInsideRoot(rootPath, targetPath)) {
      throw new ExternalRootError(
        "path_outside_root",
        "The target path is outside the configured external root.",
      );
    }
    const parentPath = path.dirname(targetPath);
    const parentRealPath = await realpath(parentPath).catch(() => undefined);
    if (!parentRealPath || !isInsideRoot(rootPath, parentRealPath)) {
      throw new ExternalRootError(
        "not_a_directory",
        "The target parent directory must already exist inside the root.",
      );
    }
    const parentStat = await lstat(parentRealPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new ExternalRootError(
        "path_link_unsupported",
        "The target parent must be a real directory, not a link or junction.",
      );
    }
    try {
      await lstat(targetPath);
      throw new ExternalRootError(
        "target_exists",
        "The external move target already exists.",
      );
    } catch (error) {
      if (error instanceof ExternalRootError) throw error;
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") {
        throw new ExternalRootError(
          "non_verifiable",
          "The external move target could not be verified.",
        );
      }
    }

    return this.inspectMoveSource(
      rootId,
      sourceRelativePath,
      targetRelativePath,
    );
  }

  async inspectMoveSource(
    rootId: string,
    requestedSourcePath: string,
    targetRelativePath = "",
  ): Promise<ExternalMoveSnapshot> {
    const runtime = this.requireCapability(rootId, "move");
    const sourceRelativePath = normalizeRelativePath(requestedSourcePath);
    if (!sourceRelativePath) {
      throw new ExternalRootError(
        "path_invalid",
        "The external source must identify a regular file.",
      );
    }
    const verified = await this.readVerifiedBuffer(runtime, sourceRelativePath);
    return {
      rootId,
      sourceRelativePath,
      targetRelativePath,
      size: verified.buffer.length,
      modifiedAt: verified.modifiedAt,
      sha256: sha256(verified.buffer),
    };
  }

  async applyMove(snapshot: ExternalMoveSnapshot): Promise<void> {
    const current = await this.planMove(
      snapshot.rootId,
      snapshot.sourceRelativePath,
      snapshot.targetRelativePath,
    );
    if (
      current.size !== snapshot.size ||
      current.modifiedAt !== snapshot.modifiedAt ||
      current.sha256 !== snapshot.sha256
    ) {
      throw new ExternalRootError(
        "precondition_failed",
        "The external source changed after the move was planned.",
      );
    }
    const runtime = this.requireCapability(snapshot.rootId, "move");
    const rootPath = await this.canonicalRoot(runtime);
    const sourcePath = await this.resolvePath(
      runtime,
      snapshot.sourceRelativePath,
    );
    const targetPath = path.join(
      rootPath,
      ...snapshot.targetRelativePath.split("/"),
    );
    try {
      // link() is no-clobber and keeps the operation on one filesystem. The
      // source is removed only after the target identity is verified.
      await link(sourcePath, targetPath);
      const sourceStat = await stat(sourcePath, { bigint: true });
      const targetStat = await stat(targetPath, { bigint: true });
      if (
        sourceStat.dev !== targetStat.dev ||
        sourceStat.ino !== targetStat.ino
      ) {
        throw new ExternalRootError(
          "non_verifiable",
          "The external move target is not the verified source object.",
        );
      }
      await unlink(sourcePath);
    } catch (error) {
      if (error instanceof ExternalRootError) {
        await unlink(targetPath).catch(() => undefined);
        throw error;
      }
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (code === "EEXIST") {
        throw new ExternalRootError(
          "target_exists",
          "The external move target already exists.",
        );
      }
      await unlink(targetPath).catch(() => undefined);
      throw new ExternalRootError(
        code === "EXDEV" || code === "ENOTSUP"
          ? "unsupported"
          : "non_verifiable",
        "The filesystem cannot complete a verified no-clobber move.",
      );
    }
  }

  async rollbackMove(snapshot: ExternalMoveSnapshot): Promise<void> {
    const runtime = this.requireCapability(snapshot.rootId, "move");
    const rootPath = await this.canonicalRoot(runtime);
    const sourcePath = path.join(
      rootPath,
      ...snapshot.sourceRelativePath.split("/"),
    );
    const targetPath = await this.resolvePath(
      runtime,
      snapshot.targetRelativePath,
    );
    try {
      await lstat(sourcePath);
      throw new ExternalRootError(
        "target_exists",
        "The original external source path is already occupied.",
      );
    } catch (error) {
      if (error instanceof ExternalRootError) throw error;
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") {
        throw new ExternalRootError(
          "non_verifiable",
          "The original external source path could not be verified.",
        );
      }
    }
    const verified = await this.readVerifiedBuffer(
      runtime,
      snapshot.targetRelativePath,
    );
    if (
      verified.buffer.length !== snapshot.size ||
      sha256(verified.buffer) !== snapshot.sha256
    ) {
      throw new ExternalRootError(
        "precondition_failed",
        "The moved external file changed and cannot be rolled back safely.",
      );
    }
    await link(targetPath, sourcePath);
    await unlink(targetPath);
  }

  async getPrivateReferenceLocation(
    rootId: string,
    requestedPath: string,
  ): Promise<{ absolutePath: string; fileUri: string }> {
    const runtime = this.requireCapability(rootId, "move");
    const relativePath = normalizeRelativePath(requestedPath);
    const absolutePath = await this.resolvePath(runtime, relativePath);
    return {
      absolutePath,
      fileUri: pathToFileURL(absolutePath).href,
    };
  }

  async getPrivateMoveLocations(
    snapshot: ExternalMoveSnapshot,
  ): Promise<{ sourceFileUri: string; targetFileUri: string }> {
    const runtime = this.requireCapability(snapshot.rootId, "move");
    const rootPath = await this.canonicalRoot(runtime);
    const sourcePath = await this.resolvePath(
      runtime,
      snapshot.sourceRelativePath,
    );
    const targetPath = path.join(
      rootPath,
      ...snapshot.targetRelativePath.split("/"),
    );
    return {
      sourceFileUri: pathToFileURL(sourcePath).href,
      targetFileUri: pathToFileURL(targetPath).href,
    };
  }

  private async withHandoffLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.handoffLock;
    let release: () => void = () => undefined;
    this.handoffLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async createHandoffCopy(
    relativePath: string,
    buffer: Buffer,
  ): Promise<string> {
    if (buffer.length > HANDOFF_MAX_TOTAL_BYTES) {
      throw new ExternalRootError(
        "too_large",
        "The verified handoff copy exceeds the aggregate handoff budget.",
      );
    }
    const directory = await this.getHandoffDirectory();
    await this.pruneHandoffDirectory(directory, buffer.length, true);
    const sourceExtension = path.extname(relativePath);
    const boundedExtension =
      Buffer.byteLength(sourceExtension, "utf8") <= 32 ? sourceExtension : "";
    const localPath = path.join(
      directory,
      `${randomUUID()}${boundedExtension}`,
    );
    await writeFile(localPath, buffer, {
      flag: "wx",
      mode: 0o600,
    });
    return localPath;
  }

  private async getHandoffDirectory(): Promise<string> {
    await this.startupScavenge;
    if (this.handoffDirectory) {
      try {
        if ((await stat(this.handoffDirectory)).isDirectory()) {
          return this.handoffDirectory;
        }
      } catch {
        this.handoffDirectory = undefined;
      }
    }

    const directory = await mkdtemp(
      path.join(os.tmpdir(), HANDOFF_DIRECTORY_PREFIX),
    );
    await this.writeHandoffOwner(directory);
    this.handoffDirectory = directory;
    this.handoffSweepTimer = setInterval(() => {
      void this.withHandoffLock(async () => {
        if (this.handoffDirectory) {
          await this.writeHandoffOwner(this.handoffDirectory);
          await this.pruneHandoffDirectory(this.handoffDirectory, 0, false);
        }
      }).catch(() => undefined);
    }, HANDOFF_SWEEP_INTERVAL_MS);
    this.handoffSweepTimer.unref();
    process.once("exit", () => {
      if (this.handoffSweepTimer) clearInterval(this.handoffSweepTimer);
      rmSync(directory, { recursive: true, force: true });
    });
    return directory;
  }

  private async writeHandoffOwner(directory: string): Promise<void> {
    const ownerPath = path.join(directory, HANDOFF_OWNER_FILE);
    const temporaryOwnerPath = path.join(
      directory,
      `.owner-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(
        temporaryOwnerPath,
        JSON.stringify({
          kind: HANDOFF_OWNER_KIND,
          version: 1,
          pid: process.pid,
          startedAt: new Date(
            Date.now() - process.uptime() * 1000,
          ).toISOString(),
          heartbeatAt: new Date().toISOString(),
        }),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(temporaryOwnerPath, ownerPath);
    } finally {
      await rm(temporaryOwnerPath, { force: true }).catch(() => undefined);
    }
  }

  private async pruneHandoffDirectory(
    directory: string,
    incomingBytes: number,
    reserveIncomingFile: boolean,
  ): Promise<void> {
    const now = Date.now();
    const files: Array<{
      path: string;
      size: number;
      modifiedAt: number;
    }> = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === HANDOFF_OWNER_FILE) continue;
      const filePath = path.join(directory, entry.name);
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs >= HANDOFF_TTL_MS) {
        await rm(filePath, { force: true });
        continue;
      }
      files.push({
        path: filePath,
        size: fileStat.size,
        modifiedAt: fileStat.mtimeMs,
      });
    }

    files.sort((a, b) => a.modifiedAt - b.modifiedAt);
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    while (
      files.length + (reserveIncomingFile ? 1 : 0) > HANDOFF_MAX_FILES ||
      totalBytes + incomingBytes > HANDOFF_MAX_TOTAL_BYTES
    ) {
      const oldest = files.shift();
      if (!oldest) break;
      await rm(oldest.path, { force: true });
      totalBytes -= oldest.size;
    }
  }

  private async scavengeStaleHandoffDirectories(): Promise<void> {
    const temporaryRoot = os.tmpdir();
    const now = Date.now();
    let entries;
    try {
      entries = await readdir(temporaryRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith(HANDOFF_DIRECTORY_PREFIX)
      ) {
        continue;
      }
      const directory = path.join(temporaryRoot, entry.name);
      const owner = await this.readHandoffOwner(directory);
      if (!owner) {
        // A matching prefix alone is not proof that this process owns the
        // directory. Leave unowned or partially written directories untouched.
        continue;
      }
      if (
        this.isProcessAlive(owner.pid) &&
        now - Date.parse(owner.heartbeatAt) < HANDOFF_OWNER_HEARTBEAT_GRACE_MS
      ) {
        continue;
      }
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async readHandoffOwner(
    directory: string,
  ): Promise<{ pid: number; heartbeatAt: string } | undefined> {
    try {
      const value = JSON.parse(
        await readFile(path.join(directory, HANDOFF_OWNER_FILE), "utf8"),
      ) as {
        kind?: unknown;
        version?: unknown;
        pid?: unknown;
        startedAt?: unknown;
        heartbeatAt?: unknown;
      };
      if (
        value.kind !== HANDOFF_OWNER_KIND ||
        value.version !== 1 ||
        typeof value.pid !== "number" ||
        !Number.isInteger(value.pid) ||
        typeof value.startedAt !== "string" ||
        !Number.isFinite(Date.parse(value.startedAt)) ||
        typeof value.heartbeatAt !== "string" ||
        !Number.isFinite(Date.parse(value.heartbeatAt))
      ) {
        return undefined;
      }
      return { pid: value.pid, heartbeatAt: value.heartbeatAt };
    } catch {
      return undefined;
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPERM"
      );
    }
  }

  private getRoot(rootId: string): RootRuntime {
    const runtime = this.roots.get(rootId);
    if (!runtime) {
      throw new ExternalRootError(
        "root_unknown",
        `Unknown external root id: ${rootId}`,
      );
    }
    return runtime;
  }

  private requireCapability(
    rootId: string,
    capability: ExternalRootCapability,
  ): RootRuntime {
    const runtime = this.getRoot(rootId);
    this.assertCapability(runtime, capability);
    return runtime;
  }

  private assertCapability(
    runtime: RootRuntime,
    capability: ExternalRootCapability,
  ): void {
    if (!runtime.config.capabilities.includes(capability)) {
      throw new ExternalRootError(
        "capability_denied",
        `External root '${runtime.config.id}' does not allow '${capability}'.`,
      );
    }
  }

  private async canonicalRoot(runtime: RootRuntime): Promise<string> {
    if (runtime.canonicalPath) return runtime.canonicalPath;
    try {
      const canonical = await realpath(runtime.config.path);
      if (!(await stat(canonical)).isDirectory()) {
        throw new ExternalRootError(
          "root_unavailable",
          `External root '${runtime.config.id}' is not a directory.`,
        );
      }
      runtime.canonicalPath = canonical;
      return canonical;
    } catch (error) {
      if (error instanceof ExternalRootError) throw error;
      throw new ExternalRootError(
        "root_unavailable",
        `External root '${runtime.config.id}' is unavailable.`,
      );
    }
  }

  private async resolvePath(
    runtime: RootRuntime,
    relativePath: string,
  ): Promise<string> {
    const rootPath = await this.canonicalRoot(runtime);
    const segments = relativePath ? relativePath.split("/") : [];
    let lexicalPath = rootPath;
    try {
      for (const segment of segments) {
        lexicalPath = path.join(lexicalPath, segment);
        const segmentStat = await lstat(lexicalPath);
        if (segmentStat.isSymbolicLink()) {
          throw new ExternalRootError(
            "path_link_unsupported",
            "Symbolic links and junctions are not supported in external roots.",
          );
        }
      }
      const canonicalPath = await realpath(lexicalPath);
      if (!isInsideRoot(rootPath, canonicalPath)) {
        throw new ExternalRootError(
          "path_outside_root",
          "The requested path resolves outside the configured external root.",
        );
      }
      if (relativePath && (await stat(canonicalPath)).isFile()) {
        this.assertAllowed(runtime, relativePath);
      }
      return canonicalPath;
    } catch (error) {
      if (error instanceof ExternalRootError) throw error;
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (code === "ENOENT") {
        throw new ExternalRootError(
          "not_found",
          "The requested external path does not exist.",
        );
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new ExternalRootError(
          "inaccessible",
          "The requested external path is inaccessible.",
        );
      }
      throw new ExternalRootError(
        "non_verifiable",
        "The requested external path could not be verified.",
      );
    }
  }

  private assertAllowed(runtime: RootRuntime, relativePath: string): void {
    if (
      matchesAny(relativePath, runtime.config.exclude) ||
      !matchesAny(relativePath, runtime.config.include)
    ) {
      throw new ExternalRootError(
        "path_not_allowed",
        "The requested external path is excluded by root policy.",
      );
    }
  }

  private async readBuffer(
    runtime: RootRuntime,
    relativePath: string,
  ): Promise<Buffer> {
    return (await this.readVerifiedBuffer(runtime, relativePath)).buffer;
  }

  private async readOpenedFile(
    handle: FileHandle,
    size: number,
  ): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) {
      throw new ExternalRootError(
        "non_verifiable",
        "The file could not be read completely.",
      );
    }
    return buffer;
  }

  private async readVerifiedBuffer(
    runtime: RootRuntime,
    relativePath: string,
    maxBytesOverride?: number,
  ): Promise<{ buffer: Buffer; modifiedAt: string }> {
    const maxFileBytes = Math.min(
      runtime.config.limits.maxFileBytes,
      maxBytesOverride ?? Number.MAX_SAFE_INTEGER,
    );
    const absolutePath = await this.resolvePath(runtime, relativePath);
    const preOpenStat = await stat(absolutePath);
    if (!preOpenStat.isFile()) {
      throw new ExternalRootError(
        "not_a_file",
        "The requested external path is not a regular file.",
      );
    }
    if (preOpenStat.size > maxFileBytes) {
      throw new ExternalRootError(
        "too_large",
        `The file exceeds the configured ${maxFileBytes}-byte limit.`,
      );
    }
    const handle = await open(absolutePath, "r");
    try {
      const openedStat = await handle.stat({ bigint: true });
      if (!openedStat.isFile()) {
        throw new ExternalRootError(
          "not_a_file",
          "The requested external path is not a file.",
        );
      }
      if (
        openedStat.size > BigInt(maxFileBytes) ||
        openedStat.size > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new ExternalRootError(
          "too_large",
          `The file exceeds the configured ${maxFileBytes}-byte limit.`,
        );
      }

      // Re-resolve every path component after opening, then bind the opened
      // handle to the currently confined object by filesystem identity. If an
      // ancestor was swapped between validation and open, the identities differ
      // even if size and timestamps happen to match.
      const revalidatedPath = await this.resolvePath(runtime, relativePath);
      const revalidatedStat = await stat(revalidatedPath, { bigint: true });
      if (
        !revalidatedStat.isFile() ||
        openedStat.dev !== revalidatedStat.dev ||
        openedStat.ino !== revalidatedStat.ino
      ) {
        throw new ExternalRootError(
          "non_verifiable",
          "The file identity changed while it was being verified.",
        );
      }

      const buffer = await this.readOpenedFile(handle, Number(openedStat.size));
      const postReadStat = await handle.stat({ bigint: true });
      const finalPath = await this.resolvePath(runtime, relativePath);
      const finalPathStat = await stat(finalPath, { bigint: true });
      if (
        !postReadStat.isFile() ||
        !finalPathStat.isFile() ||
        postReadStat.dev !== openedStat.dev ||
        postReadStat.ino !== openedStat.ino ||
        postReadStat.size !== openedStat.size ||
        postReadStat.mtimeNs !== openedStat.mtimeNs ||
        postReadStat.ctimeNs !== openedStat.ctimeNs ||
        finalPathStat.dev !== postReadStat.dev ||
        finalPathStat.ino !== postReadStat.ino
      ) {
        throw new ExternalRootError(
          "non_verifiable",
          "The file changed while it was being read.",
        );
      }
      return {
        buffer,
        modifiedAt: new Date(Number(openedStat.mtimeMs)).toISOString(),
      };
    } finally {
      await handle.close();
    }
  }
}
