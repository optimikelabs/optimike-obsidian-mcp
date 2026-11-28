import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dump, load } from "js-yaml";
import { config } from "../config/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { RequestContext } from "../utils/index.js";
import { extractInlineTags } from "./markdownTags.js";
import { assertNewNotePath, assertNoFoldedSibling } from "./noteNameMcp.js";

export type VaultFileReadResult = {
  path: string;
  content: string;
  ctime: number;
  mtime: number;
  size: number;
  hash: string;
};

export type VaultFileWritePreconditions = {
  expectedHash?: string;
  expectedMtime?: number;
};

export type VaultTagLocation = "frontmatter" | "inline" | "both";

// The headless server can instantiate this service more than once per process.
const fileWriteLocks = new Map<string, Promise<void>>();
const retryLock = Symbol("retryLock");

function hasFsCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/** A Windows reader can temporarily deny rename. Recheck the sealed input
 * on every attempt so waiting cannot authorize a write over new content. */
export async function renameWithPrecondition(source: string, target: string, recheck: () => Promise<void>) {
  for (let attempt = 0; ; attempt += 1) {
    await recheck();
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (process.platform !== "win32" || attempt >= 4 ||
          (!hasFsCode(error, "EPERM") && !hasFsCode(error, "EBUSY"))) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

async function withFileLocks<T>(
  keys: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) {
      const previous = fileWriteLocks.get(key);
      let unlock!: () => void;
      const lock = new Promise<void>((resolve) => { unlock = resolve; });
      fileWriteLocks.set(key, lock);
      releases.push(() => {
        if (fileWriteLocks.get(key) === lock) fileWriteLocks.delete(key);
        unlock();
      });
      await previous;
    }
    return await operation();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  const body = match ? content.slice(match[0].length) : content;
  const parsed = match ? load(match[1]) : {};
  return {
    frontmatter:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {},
    body,
  };
}

function renderWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = dump(frontmatter, { lineWidth: -1, noRefs: true }).trim();
  return `---\n${yaml}\n---\n${body}`;
}

function normalizeTag(tag: string): string {
  return tag.replace(/^#+/u, "").trim();
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))].sort();
}

export function extractMarkdownTags(content: string): {
  frontmatterTags: string[];
  inlineTags: string[];
  allTags: string[];
} {
  const { frontmatter, body } = splitFrontmatter(content);
  const frontmatterTags = Array.isArray(frontmatter.tags)
    ? uniqueTags(frontmatter.tags.map(String))
    : [];
  const inlineTags = uniqueTags(extractInlineTags(body));
  return {
    frontmatterTags,
    inlineTags,
    allTags: uniqueTags([...frontmatterTags, ...inlineTags]),
  };
}

function removeInlineTag(body: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body
    .replace(
      new RegExp(`(^|[\\s([{])#${escaped}(?=$|[\\s\\])}.,;:!?])`, "gu"),
      "$1",
    )
    .replace(/[ \t]{2,}/g, " ");
}

function replaceInlineTag(
  body: string,
  fromTag: string,
  toTag: string,
): string {
  const escaped = fromTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(
    new RegExp(`(^|[\\s([{])#${escaped}(?=$|[\\s\\])}.,;:!?])`, "gu"),
    `$1#${toTag}`,
  );
}

export class VaultFileService {
  private readonly vaultRoot: string;

  constructor(vaultRoot = config.obsidianVaultPath) {
    if (!vaultRoot) {
      throw new McpError(
        BaseErrorCode.CONFIGURATION_ERROR,
        "OBSIDIAN_VAULT is required for VaultFileService.",
        {},
      );
    }
    this.vaultRoot = path.resolve(vaultRoot);
  }

  resolveVaultPath(filePath: string, context: RequestContext): string {
    if (!filePath || path.isAbsolute(filePath)) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Vault file path must be a non-empty vault-relative path.",
        context,
      );
    }
    const normalized = path.normalize(filePath.replace(/^[/\\]+/u, ""));
    if (normalized === "." || normalized.startsWith("..")) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Vault file path cannot escape the vault root.",
        context,
      );
    }
    const absolutePath = path.resolve(this.vaultRoot, normalized);
    const relative = path.relative(this.vaultRoot, absolutePath);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Resolved path escapes the vault root.",
        context,
      );
    }
    return absolutePath;
  }

  /**
   * A file that does not exist yet gets a NEW name: apply the shared
   * cross-platform rule and refuse a case/Unicode-folded sibling. Existing
   * files keep whatever legacy name they have.
   */
  async assertNewFileName(filePath: string, absolutePath: string): Promise<void> {
    if (await stat(absolutePath).then(() => true, () => false)) return;
    assertNewNotePath(filePath.replace(/^\/+/u, ""), { extensions: null });
    let siblings: string[];
    try { siblings = await readdir(path.dirname(absolutePath)); }
    catch { return; } // parent not created yet: nothing can collide
    assertNoFoldedSibling(path.basename(absolutePath), siblings);
  }

  private async assertRealPathInsideVault(
    absolutePath: string,
    context: RequestContext,
  ): Promise<string> {
    const [realVaultRoot, realTarget] = await Promise.all([
      realpath(this.vaultRoot),
      realpath(absolutePath),
    ]);
    const relative = path.relative(realVaultRoot, realTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Resolved real path escapes the vault root.",
        { ...context, realVaultRoot, realTarget },
      );
    }
    return realTarget;
  }

  private async resolveRealPathForWrite(
    absolutePath: string,
    context: RequestContext,
  ): Promise<string> {
    try {
      return await this.assertRealPathInsideVault(absolutePath, context);
    } catch (error) {
      if (!hasFsCode(error, "ENOENT")) {
        throw error;
      }
      if (absolutePath === this.vaultRoot) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "Unable to verify parent real path inside the vault root.",
          { ...context, absolutePath },
        );
      }
      const parent = await this.resolveRealPathForWrite(
        path.dirname(absolutePath),
        context,
      );
      return path.join(parent, path.basename(absolutePath));
    }
  }

  private async withLockedFiles<T>(
    filePaths: string[],
    context: RequestContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const absolutePaths = filePaths.map((file) =>
      this.resolveVaultPath(file, context),
    );
    const getKeys = async () => {
      const targets = await Promise.all(
        absolutePaths.map(async (absolutePath) => {
          const [target, parent] = await Promise.all([
            this.resolveRealPathForWrite(absolutePath, context),
            this.resolveRealPathForWrite(path.dirname(absolutePath), context),
          ]);
          // A rename replaces the directory entry, even when reads follow a symlink.
          return [target, path.join(parent, path.basename(absolutePath))];
        }),
      );
      const keys = targets.flat().map((target) =>
        process.platform === "win32" || process.platform === "darwin"
          ? target.normalize("NFC").toLowerCase()
          : target,
      );
      // Moves lock both paths in the same order to avoid deadlocks.
      return [...new Set(keys)].sort();
    };

    let keys = await getKeys();
    while (true) {
      const result = await withFileLocks(keys, async () => {
        // An earlier mutation can replace a symlink while this caller waits.
        const currentKeys = await getKeys();
        if (
          keys.length !== currentKeys.length ||
          keys.some((key, index) => key !== currentKeys[index])
        ) {
          keys = currentKeys;
          return retryLock;
        }
        return operation();
      });
      if (result !== retryLock) return result;
    }
  }

  private assertWritePreconditions(
    current: VaultFileReadResult,
    preconditions: VaultFileWritePreconditions | undefined,
    context: RequestContext,
  ): void {
    if (
      preconditions?.expectedHash &&
      current.hash !== preconditions.expectedHash
    ) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "File changed since the caller-provided expectedHash.",
        {
          ...context,
          expectedHash: preconditions.expectedHash,
          actualHash: current.hash,
          path: current.path,
        },
      );
    }

    if (
      typeof preconditions?.expectedMtime === "number" &&
      current.mtime !== Math.round(preconditions.expectedMtime)
    ) {
      throw new McpError(
        BaseErrorCode.CONFLICT,
        "File changed since the caller-provided expectedMtime.",
        {
          ...context,
          expectedMtime: Math.round(preconditions.expectedMtime),
          actualMtime: current.mtime,
          path: current.path,
        },
      );
    }
  }

  async read(
    filePath: string,
    context: RequestContext,
  ): Promise<VaultFileReadResult> {
    const absolutePath = this.resolveVaultPath(filePath, context);
    await this.assertRealPathInsideVault(absolutePath, context);
    const [content, fileStat] = await Promise.all([
      readFile(absolutePath, "utf8"),
      stat(absolutePath),
    ]);
    return {
      path: filePath.replace(/\\/g, "/").replace(/^\/+/u, ""),
      content,
      ctime: Math.round(fileStat.ctimeMs),
      mtime: Math.round(fileStat.mtimeMs),
      size: fileStat.size,
      hash: hashContent(content),
    };
  }

  async writeAtomic(
    filePath: string,
    content: string,
    context: RequestContext,
  ): Promise<VaultFileReadResult> {
    return this.withLockedFiles([filePath], context, async () => {
      const current = await this.readIfPresent(filePath, context);
      return this.replaceFile(filePath, content, current?.hash, context);
    });
  }

  async createIfAbsent(
    filePath: string,
    content: string,
    context: RequestContext,
  ): Promise<VaultFileReadResult> {
    return this.withLockedFiles([filePath], context, async () => {
      await this.assertUnchanged(filePath, undefined, context);
      return this.replaceFile(filePath, content, undefined, context);
    });
  }

  private async readIfPresent(filePath: string, context: RequestContext) {
    try {
      return await this.read(filePath, context);
    } catch (error) {
      if (!hasFsCode(error, "ENOENT")) throw error;
      return undefined;
    }
  }

  private async assertUnchanged(
    filePath: string,
    snapshotHash: string | undefined,
    context: RequestContext,
    rawSha256 = false,
  ): Promise<void> {
    const absolutePath = this.resolveVaultPath(filePath, context);
    try {
      if (snapshotHash === undefined) {
        await lstat(absolutePath);
      } else {
        await this.assertRealPathInsideVault(absolutePath, context);
        const observed = rawSha256
          ? createHash("sha256").update(await readFile(absolutePath)).digest("hex")
          : hashContent(await readFile(absolutePath, "utf8"));
        if (observed === snapshotHash) return;
      }
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) {
        if (snapshotHash === undefined) return;
      } else if (!hasFsCode(error, "EISDIR")) {
        throw error;
      }
    }
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "File changed before the filesystem mutation could be applied.",
      { ...context, filePath },
    );
  }

  private async replaceFile(
    filePath: string,
    content: string,
    snapshotHash: string | undefined,
    context: RequestContext,
  ): Promise<VaultFileReadResult> {
    await this.publishFile(filePath, content, snapshotHash, context);
    return this.read(filePath, context);
  }

  private async publishFile(
    filePath: string,
    content: string,
    snapshotHash: string | undefined,
    context: RequestContext,
    beforePublish?: (staged: BigIntStats) => Promise<void>,
    confirmPublication?: () => void,
  ): Promise<void> {
    const absolutePath = this.resolveVaultPath(filePath, context);
    const parent = path.dirname(absolutePath);
    await this.resolveRealPathForWrite(parent, context);
    await this.assertNewFileName(filePath, absolutePath);
    if (!beforePublish) await mkdir(parent, { recursive: true });
    await this.assertRealPathInsideVault(parent, context);
    const tempPath = beforePublish
      ? path.join(parent, `.mcp-write-${randomBytes(16).toString("hex")}.tmp`)
      : `${absolutePath}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      if (beforePublish) {
        const mode = snapshotHash === undefined ? 0o600 : (await stat(absolutePath)).mode & 0o777;
        const file = await open(tempPath, "wx", mode);
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      } else {
        await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
      }
    } catch (error) {
      if (!hasFsCode(error, "EEXIST")) await rm(tempPath, { force: true });
      throw error;
    }
    try {
      if (beforePublish) await beforePublish(await stat(tempPath, { bigint: true }));
      // This recheck narrows the race with external writers. Another process
      // can still change the target between the snapshot check and the rename.
      await this.assertRealPathInsideVault(parent, context);
      if (beforePublish && snapshotHash === undefined) {
        // Publishing via an exclusive link makes absent-only creation atomic
        // even against a writer that does not use our path lock.
        await link(tempPath, absolutePath).catch(error => {
          if (!hasFsCode(error, "EEXIST")) throw error;
          throw new McpError(BaseErrorCode.CONFLICT, "The create target appeared before publication.");
        });
      } else if (beforePublish) {
        await renameWithPrecondition(tempPath, absolutePath,
          () => this.assertUnchanged(filePath, snapshotHash, context, true));
      } else {
        await this.assertUnchanged(filePath, snapshotHash, context);
        await rename(tempPath, absolutePath);
      }
      confirmPublication?.();
      if (beforePublish && process.platform !== "win32") {
        const directory = await open(parent, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  /** Filesystem effect point used by the durable note adapter, under its
   * cross-process lock. expectedHash undefined means exclusive creation. */
  async publishSealedNote(filePath: string, content: string, expectedHash: string | undefined,
    beforePublish: (staged: BigIntStats) => Promise<void>, confirmPublication: () => void, context: RequestContext) {
    return this.withLockedFiles([filePath], context, async () => {
      await this.assertUnchanged(filePath, expectedHash, context, true);
      await this.publishFile(filePath, content, expectedHash, context, beforePublish, confirmPublication);
    });
  }

  async updateWholeFile(
    filePath: string,
    mode: "append" | "prepend" | "overwrite",
    content: string,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<VaultFileReadResult> {
    return this.withLockedFiles([filePath], context, async () => {
      const current = await this.readIfPresent(filePath, context);
      if (current) {
        this.assertWritePreconditions(current, preconditions, context);
      } else if (
        preconditions?.expectedHash ||
        typeof preconditions?.expectedMtime === "number"
      ) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Cannot satisfy write preconditions because the target file does not exist.",
          { ...context, filePath, preconditions },
        );
      }
      const existing = current?.content ?? "";
      const next =
        mode === "append"
          ? `${existing}${content}`
          : mode === "prepend"
            ? `${content}${existing}`
            : content;
      return this.replaceFile(filePath, next, current?.hash, context);
    });
  }

  async searchReplace(
    filePath: string,
    replacements: Array<{ search: string; replace: string }>,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result: VaultFileReadResult; replacementsApplied: number }> {
    return this.withLockedFiles([filePath], context, async () => {
      const current = await this.read(filePath, context);
      this.assertWritePreconditions(current, preconditions, context);
      let next = current.content;
      let replacementsApplied = 0;
      for (const replacement of replacements) {
        const before = next;
        next = next.split(replacement.search).join(replacement.replace);
        if (next !== before) {
          replacementsApplied++;
        }
      }
      return {
        result: await this.replaceFile(filePath, next, current.hash, context),
        replacementsApplied,
      };
    });
  }

  async setFrontmatterKey(
    filePath: string,
    key: string,
    value: unknown,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result: VaultFileReadResult; value: unknown }> {
    return this.withLockedFiles([filePath], context, async () => {
      const current = await this.read(filePath, context);
      this.assertWritePreconditions(current, preconditions, context);
      const { frontmatter, body } = splitFrontmatter(current.content);
      frontmatter[key] = value;
      return {
        result: await this.replaceFile(
          filePath,
          renderWithFrontmatter(frontmatter, body),
          current.hash,
          context,
        ),
        value,
      };
    });
  }

  async setFrontmatterKeys(
    filePath: string,
    values: Record<string, unknown>,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result: VaultFileReadResult; values: Record<string, unknown> }> {
    return this.withLockedFiles([filePath], context, async () => {
      const current = await this.read(filePath, context);
      this.assertWritePreconditions(current, preconditions, context);
      const { frontmatter, body } = splitFrontmatter(current.content);
      for (const [key, value] of Object.entries(values)) {
        frontmatter[key] = value;
      }
      return {
        result: await this.replaceFile(
          filePath,
          renderWithFrontmatter(frontmatter, body),
          current.hash,
          context,
        ),
        values,
      };
    });
  }

  async manageFrontmatterTags(
    filePath: string,
    operation: "add" | "remove" | "list",
    tags: string[],
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result?: VaultFileReadResult; currentTags: string[] }> {
    const manage = async () => {
      const current = await this.read(filePath, context);
      const { frontmatter, body } = splitFrontmatter(current.content);
      const currentTags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags.map(String)
        : [];
      if (operation === "list") {
        return { currentTags };
      }

      this.assertWritePreconditions(current, preconditions, context);
      const normalized = tags
        .map((tag) => tag.replace(/^#+/u, "").trim())
        .filter(Boolean);
      const nextTags =
        operation === "add"
          ? [...new Set([...currentTags, ...normalized])]
          : currentTags.filter((tag) => !normalized.includes(tag));

      if (nextTags.length > 0) {
        frontmatter.tags = nextTags;
      } else {
        delete frontmatter.tags;
      }

      return {
        result: await this.replaceFile(
          filePath,
          renderWithFrontmatter(frontmatter, body),
          current.hash,
          context,
        ),
        currentTags: nextTags,
      };
    };
    return operation === "list"
      ? manage()
      : this.withLockedFiles([filePath], context, manage);
  }

  async manageTags(
    filePath: string,
    operation: "add" | "remove" | "list",
    tags: string[],
    location: VaultTagLocation,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{
    result?: VaultFileReadResult;
    frontmatterTags: string[];
    inlineTags: string[];
    currentTags: string[];
  }> {
    const manage = async () => {
      const current = await this.read(filePath, context);
      const { frontmatter, body } = splitFrontmatter(current.content);
      const currentFrontmatterTags = Array.isArray(frontmatter.tags)
        ? uniqueTags(frontmatter.tags.map(String))
        : [];
      const currentInlineTags = extractMarkdownTags(current.content).inlineTags;

      if (operation === "list") {
        return {
          frontmatterTags: currentFrontmatterTags,
          inlineTags: currentInlineTags,
          currentTags: uniqueTags([
            ...currentFrontmatterTags,
            ...currentInlineTags,
          ]),
        };
      }

      this.assertWritePreconditions(current, preconditions, context);
      const normalized = uniqueTags(tags);
      let nextFrontmatterTags = currentFrontmatterTags;
      let nextBody = body;

      if (location === "frontmatter" || location === "both") {
        nextFrontmatterTags =
          operation === "add"
            ? uniqueTags([...currentFrontmatterTags, ...normalized])
            : currentFrontmatterTags.filter((tag) => !normalized.includes(tag));
        if (nextFrontmatterTags.length > 0) {
          frontmatter.tags = nextFrontmatterTags;
        } else {
          delete frontmatter.tags;
        }
      }

      if (location === "inline" || location === "both") {
        const currentInlineSet = new Set(currentInlineTags);
        if (operation === "add") {
          const missing = normalized.filter((tag) => !currentInlineSet.has(tag));
          if (missing.length > 0) {
            nextBody = `${nextBody.trimEnd()}\n\n${missing
              .map((tag) => `#${tag}`)
              .join(" ")}\n`;
          }
        } else {
          for (const tag of normalized) {
            nextBody = removeInlineTag(nextBody, tag);
          }
        }
      }

      const result = await this.replaceFile(
        filePath,
        renderWithFrontmatter(frontmatter, nextBody),
        current.hash,
        context,
      );
      const nextTags = extractMarkdownTags(result.content);
      return {
        result,
        frontmatterTags: nextTags.frontmatterTags,
        inlineTags: nextTags.inlineTags,
        currentTags: nextTags.allTags,
      };
    };
    return operation === "list"
      ? manage()
      : this.withLockedFiles([filePath], context, manage);
  }

  async renameTag(
    filePath: string,
    fromTag: string,
    toTag: string,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{
    result: VaultFileReadResult;
    before: ReturnType<typeof extractMarkdownTags>;
    after: ReturnType<typeof extractMarkdownTags>;
  }> {
    return this.withLockedFiles([filePath], context, async () => {
      const current = await this.read(filePath, context);
      this.assertWritePreconditions(current, preconditions, context);
      const before = extractMarkdownTags(current.content);
      const normalizedFrom = normalizeTag(fromTag);
      const normalizedTo = normalizeTag(toTag);
      const { frontmatter, body } = splitFrontmatter(current.content);
      if (Array.isArray(frontmatter.tags)) {
        frontmatter.tags = uniqueTags(
          frontmatter.tags
            .map(String)
            .map((tag) =>
              normalizeTag(tag) === normalizedFrom ? normalizedTo : tag,
            ),
        );
      }
      const nextBody = replaceInlineTag(body, normalizedFrom, normalizedTo);
      const result = await this.replaceFile(
        filePath,
        renderWithFrontmatter(frontmatter, nextBody),
        current.hash,
        context,
      );
      return { result, before, after: extractMarkdownTags(result.content) };
    });
  }

  async moveFile(
    sourcePath: string,
    targetPath: string,
    context: RequestContext,
    preconditions: VaultFileWritePreconditions,
    overwrite = false,
  ): Promise<{ previous: VaultFileReadResult; result: VaultFileReadResult }> {
    return this.withLockedFiles([sourcePath, targetPath], context, async () => {
      const previous = await this.read(sourcePath, context);
      this.assertWritePreconditions(previous, preconditions, context);
      const sourceAbsolutePath = this.resolveVaultPath(sourcePath, context);
      const targetAbsolutePath = this.resolveVaultPath(targetPath, context);
      const targetParent = path.dirname(targetAbsolutePath);
      const target = overwrite
        ? await this.readIfPresent(targetPath, context)
        : undefined;
      if (!overwrite) {
        try {
          await lstat(targetAbsolutePath);
          throw new McpError(
            BaseErrorCode.CONFLICT,
            "Target file already exists. Pass overwrite=true with a source precondition to replace it.",
            { ...context, sourcePath, targetPath },
          );
        } catch (error) {
          if (!hasFsCode(error, "ENOENT")) throw error;
        }
      }
      await this.assertNewFileName(targetPath, targetAbsolutePath);
      await this.resolveRealPathForWrite(targetParent, context);
      await mkdir(targetParent, { recursive: true });
      await this.assertRealPathInsideVault(targetParent, context);

      await this.assertUnchanged(targetPath, target?.hash, context);
      await this.assertUnchanged(sourcePath, previous.hash, context);
      await rename(sourceAbsolutePath, targetAbsolutePath);
      return { previous, result: await this.read(targetPath, context) };
    });
  }

  async deleteFile(
    filePath: string,
    context: RequestContext,
    preconditions: VaultFileWritePreconditions,
  ): Promise<VaultFileReadResult> {
    return this.withLockedFiles([filePath], context, async () => {
      const current = await this.read(filePath, context);
      this.assertWritePreconditions(current, preconditions, context);
      const absolutePath = this.resolveVaultPath(filePath, context);
      await this.assertUnchanged(filePath, current.hash, context);
      await rm(absolutePath, { force: false });
      return current;
    });
  }
}
