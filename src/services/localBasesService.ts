import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { load } from "js-yaml";
import { config } from "./../config/index.js";
import type { VaultCacheService } from "./obsidianRestAPI/vaultCache/index.js";
import type {
  BaseQueryRequest,
  BaseQueryResponse,
  BaseSchemaProperty,
  BaseSchemaResponse,
  BaseSummary,
  BasesListResponse,
} from "./obsidianRestAPI/types.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { RequestContext } from "../utils/index.js";
import {
  createVaultExclusionMatcher,
  isVaultPathExcluded,
  normalizeVaultRelativePath,
} from "./vaultExclusions.js";

type ParsedBase = {
  id: string;
  path: string;
  name: string;
  config: Record<string, unknown>;
};

type LocalBaseRow = {
  file: {
    path: string;
    name: string;
  };
  props: Record<string, unknown>;
};

async function ensureCacheReady(
  vaultCacheService: VaultCacheService,
): Promise<void> {
  if (!vaultCacheService.isReady()) {
    await vaultCacheService.buildVaultCache();
    await vaultCacheService.waitUntilReady();
  }
}

function normalizeBaseId(baseId: string): string {
  return baseId.replace(/\\/gu, "/").replace(/^\/+/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!match) return {};
  try {
    const parsed = load(match[1]);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readProperty(row: LocalBaseRow, prop: string): unknown {
  if (prop === "file.path") return row.file.path;
  if (prop === "file.name") return row.file.name;
  if (prop.startsWith("file.")) return row.props[prop];
  return row.props[prop];
}

function matchesFilter(row: LocalBaseRow, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (isRecord(expected) || Array.isArray(expected)) {
      return false;
    }
    if (readProperty(row, key) !== expected) {
      return false;
    }
  }
  return true;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export class LocalBasesService {
  private readonly vaultExclusionMatcher = createVaultExclusionMatcher(
    config.obsidianVaultExcludePatterns,
  );

  constructor(private readonly vaultCacheService: VaultCacheService) {}

  private async listParsedBases(): Promise<ParsedBase[]> {
    await ensureCacheReady(this.vaultCacheService);
    const parsedBases: ParsedBase[] = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        const relativePathForPolicy = normalizeVaultRelativePath(
          path.relative(config.obsidianVaultPath!, absolutePath),
        );
        if (isVaultPathExcluded(relativePathForPolicy, this.vaultExclusionMatcher)) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(absolutePath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".base")) continue;
        const relativePath = path
          .relative(config.obsidianVaultPath!, absolutePath)
          .replace(/\\/gu, "/");
        const content = await readFile(absolutePath, "utf8");
        const parsed = load(content);
        parsedBases.push({
          id: relativePath,
          path: relativePath,
          name: path.basename(relativePath, ".base"),
          config: isRecord(parsed) ? parsed : {},
        });
      }
    };

    if (!config.obsidianVaultPath) {
      return [];
    }
    await walk(config.obsidianVaultPath);

    return parsedBases.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async getParsedBase(baseId: string, context: RequestContext): Promise<ParsedBase> {
    const normalized = normalizeBaseId(baseId);
    const bases = await this.listParsedBases();
    const base = bases.find(
      (candidate) =>
        candidate.id === normalized ||
        candidate.path === normalized ||
        candidate.id.toLowerCase() === normalized.toLowerCase(),
    );
    if (!base) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        `Base not found in local fallback cache: ${baseId}`,
        context,
      );
    }
    return base;
  }

  async listBases(): Promise<BasesListResponse & { source: "local-fallback" }> {
    const bases: BaseSummary[] = (await this.listParsedBases()).map((base) => ({
      id: base.id,
      name: base.name,
      path: base.path,
    }));
    return {
      source: "local-fallback",
      bases,
    };
  }

  async getBaseSchema(
    baseId: string,
    context: RequestContext,
  ): Promise<BaseSchemaResponse & { source: "local-fallback"; limitations: string[] }> {
    const base = await this.getParsedBase(baseId, context);
    const propertiesConfig = isRecord(base.config.properties)
      ? base.config.properties
      : {};
    const formulasConfig = isRecord(base.config.formulas)
      ? base.config.formulas
      : {};
    const views = Array.isArray(base.config.views) ? base.config.views : [];
    const properties: BaseSchemaProperty[] = Object.entries(propertiesConfig).map(
      ([key, value]) => ({
        key,
        kind: key.startsWith("formula.") ? "formula" : key.startsWith("file.") ? "file" : "note",
        displayName: isRecord(value) ? String(value.displayName ?? key) : key,
      }),
    );
    for (const key of Object.keys(formulasConfig)) {
      properties.push({
        key: `formula.${key}`,
        kind: "formula",
        displayName: key,
      });
    }

    return {
      source: "local-fallback",
      id: base.id,
      path: base.path,
      name: base.name,
      properties,
      formulas: formulasConfig,
      filters: isRecord(base.config.filters) ? base.config.filters : undefined,
      views: views.filter(isRecord).map((view) => ({
        name: String(view.name ?? "Untitled"),
        type: String(view.type ?? "unknown"),
        limit: typeof view.limit === "number" ? view.limit : undefined,
        order: Array.isArray(view.order) ? view.order.map(String) : undefined,
        filters: isRecord(view.filters) ? view.filters : undefined,
      })),
      limitations: [
        "Local fallback parses .base YAML and cached Markdown frontmatter only.",
        "Obsidian formulas, plugin-specific filters, calculated properties, and UI view semantics are not evaluated.",
      ],
    };
  }

  async queryBase(
    baseId: string,
    request: BaseQueryRequest,
    context: RequestContext,
  ): Promise<
    Omit<BaseQueryResponse, "source" | "rows"> & {
      source: "local-fallback";
      rows: LocalBaseRow[];
      limitations: string[];
    }
  > {
    await this.getParsedBase(baseId, context);
    await ensureCacheReady(this.vaultCacheService);
    const rows: LocalBaseRow[] = [];

    for (const entry of this.vaultCacheService.getEntriesByPrefix()) {
      if (!entry.path.endsWith(".md")) continue;
      const cacheEntry = await this.vaultCacheService.getEntry(entry.path);
      if (!cacheEntry) continue;
      const frontmatter = extractFrontmatter(cacheEntry.content);
      rows.push({
        file: {
          path: entry.path,
          name: path.basename(entry.path, ".md"),
        },
        props: {
          ...frontmatter,
          "file.path": entry.path,
          "file.name": path.basename(entry.path, ".md"),
          "file.ctime": entry.ctime,
          "file.mtime": entry.mtime,
          "file.size": entry.size,
        },
      });
    }

    const filtered = request.filter
      ? rows.filter((row) => matchesFilter(row, request.filter!))
      : rows;
    const sort = request.sort ?? [];
    const sorted = [...filtered].sort((a, b) => {
      for (const item of sort) {
        const direction = item.dir === "desc" ? -1 : 1;
        const comparison = compareValues(
          readProperty(a, item.prop),
          readProperty(b, item.prop),
        );
        if (comparison !== 0) return comparison * direction;
      }
      return a.file.path.localeCompare(b.file.path);
    });

    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);
    const page = Math.max(request.page ?? 1, 1);
    const start = (page - 1) * limit;
    const paged = sorted.slice(start, start + limit);

    return {
      source: "local-fallback",
      evaluate: false,
      total: filtered.length,
      page,
      rows: paged,
      limitations: [
        "Only direct equality filters are supported in local fallback.",
        "Base-level filters, view filters, formulas, and calculated properties are not evaluated.",
      ],
    };
  }
}
