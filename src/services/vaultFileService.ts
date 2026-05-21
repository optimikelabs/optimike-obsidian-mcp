import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import { config } from "../config/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { RequestContext } from "../utils/index.js";

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

  private async assertRealPathInsideVault(
    absolutePath: string,
    context: RequestContext,
  ): Promise<void> {
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
  }

  private async assertParentRealPathInsideVault(
    absolutePath: string,
    context: RequestContext,
  ): Promise<void> {
    let current = path.dirname(absolutePath);
    while (true) {
      try {
        await this.assertRealPathInsideVault(current, context);
        return;
      } catch (error) {
        if (
          error instanceof McpError &&
          error.code === BaseErrorCode.VALIDATION_ERROR
        ) {
          throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw new McpError(
            BaseErrorCode.VALIDATION_ERROR,
            "Unable to verify parent real path inside the vault root.",
            { ...context, absolutePath },
          );
        }
        current = parent;
      }
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

  async read(filePath: string, context: RequestContext): Promise<VaultFileReadResult> {
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
    const absolutePath = this.resolveVaultPath(filePath, context);
    await this.assertParentRealPathInsideVault(absolutePath, context);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await this.assertRealPathInsideVault(path.dirname(absolutePath), context);
    const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, absolutePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return this.read(filePath, context);
  }

  async updateWholeFile(
    filePath: string,
    mode: "append" | "prepend" | "overwrite",
    content: string,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<VaultFileReadResult> {
    let existing = "";
    try {
      const current = await this.read(filePath, context);
      this.assertWritePreconditions(current, preconditions, context);
      existing = current.content;
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      if (
        preconditions?.expectedHash ||
        typeof preconditions?.expectedMtime === "number"
      ) {
        throw new McpError(
          BaseErrorCode.CONFLICT,
          "Cannot satisfy write preconditions because the target file does not exist.",
          { ...context, filePath, preconditions },
        );
      }
      existing = "";
    }
    const next =
      mode === "append"
        ? `${existing}${content}`
        : mode === "prepend"
          ? `${content}${existing}`
          : content;
    return this.writeAtomic(filePath, next, context);
  }

  async searchReplace(
    filePath: string,
    replacements: Array<{ search: string; replace: string }>,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result: VaultFileReadResult; replacementsApplied: number }> {
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
      result: await this.writeAtomic(filePath, next, context),
      replacementsApplied,
    };
  }

  async setFrontmatterKey(
    filePath: string,
    key: string,
    value: unknown,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result: VaultFileReadResult; value: unknown }> {
    const current = await this.read(filePath, context);
    this.assertWritePreconditions(current, preconditions, context);
    const { frontmatter, body } = splitFrontmatter(current.content);
    frontmatter[key] = value;
    return {
      result: await this.writeAtomic(
        filePath,
        renderWithFrontmatter(frontmatter, body),
        context,
      ),
      value,
    };
  }

  async setFrontmatterKeys(
    filePath: string,
    values: Record<string, unknown>,
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result: VaultFileReadResult; values: Record<string, unknown> }> {
    const current = await this.read(filePath, context);
    this.assertWritePreconditions(current, preconditions, context);
    const { frontmatter, body } = splitFrontmatter(current.content);
    for (const [key, value] of Object.entries(values)) {
      frontmatter[key] = value;
    }
    return {
      result: await this.writeAtomic(
        filePath,
        renderWithFrontmatter(frontmatter, body),
        context,
      ),
      values,
    };
  }

  async manageFrontmatterTags(
    filePath: string,
    operation: "add" | "remove" | "list",
    tags: string[],
    context: RequestContext,
    preconditions?: VaultFileWritePreconditions,
  ): Promise<{ result?: VaultFileReadResult; currentTags: string[] }> {
    const current = await this.read(filePath, context);
    const { frontmatter, body } = splitFrontmatter(current.content);
    const currentTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.map(String)
      : [];
    if (operation === "list") {
      return { currentTags };
    }

    this.assertWritePreconditions(current, preconditions, context);
    const normalized = tags.map((tag) => tag.replace(/^#+/u, "").trim()).filter(Boolean);
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
      result: await this.writeAtomic(
        filePath,
        renderWithFrontmatter(frontmatter, body),
        context,
      ),
      currentTags: nextTags,
    };
  }

  async deleteFile(
    filePath: string,
    context: RequestContext,
    preconditions: VaultFileWritePreconditions,
  ): Promise<VaultFileReadResult> {
    const current = await this.read(filePath, context);
    this.assertWritePreconditions(current, preconditions, context);
    const absolutePath = this.resolveVaultPath(filePath, context);
    await this.assertRealPathInsideVault(absolutePath, context);
    await rm(absolutePath, { force: false });
    return current;
  }
}
