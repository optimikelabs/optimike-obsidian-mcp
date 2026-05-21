import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
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

  async read(filePath: string, context: RequestContext): Promise<VaultFileReadResult> {
    const absolutePath = this.resolveVaultPath(filePath, context);
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
    await mkdir(path.dirname(absolutePath), { recursive: true });
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
  ): Promise<VaultFileReadResult> {
    let existing = "";
    try {
      existing = (await this.read(filePath, context)).content;
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
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
  ): Promise<{ result: VaultFileReadResult; replacementsApplied: number }> {
    const current = await this.read(filePath, context);
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
  ): Promise<{ result: VaultFileReadResult; value: unknown }> {
    const current = await this.read(filePath, context);
    const match = current.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
    const body = match ? current.content.slice(match[0].length) : current.content;
    const parsed = match ? load(match[1]) : {};
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    frontmatter[key] = value;
    const yaml = dump(frontmatter, { lineWidth: -1, noRefs: true }).trim();
    const next = `---\n${yaml}\n---\n${body}`;
    return {
      result: await this.writeAtomic(filePath, next, context),
      value,
    };
  }
}
