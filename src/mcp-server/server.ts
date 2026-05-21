/**
 * @fileoverview Main entry point for the MCP (Model Context Protocol) server.
 * This file orchestrates the server's lifecycle:
 * 1. Initializes the core `McpServer` instance (from `@modelcontextprotocol/sdk`) with its identity and capabilities.
 * 2. Registers available resources and tools, making them discoverable and usable by clients.
 * 3. Selects and starts the appropriate communication transport (stdio or Streamable HTTP)
 *    based on configuration.
 * 4. Handles top-level error management during startup.
 *
 * MCP Specification References:
 * - Lifecycle: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/lifecycle.mdx
 * - Overview (Capabilities): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/index.mdx
 * - Transports: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/transports.mdx
 * @module src/mcp-server/server
 */

import { ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dump, load } from "js-yaml";
import path from "node:path";
import { z } from "zod";
// Import validated configuration and environment details.
import { config, environment } from "../config/index.js";
// Import core utilities: ErrorHandler, logger, requestContextService.
import { ErrorHandler, logger, requestContextService } from "../utils/index.js";
// Import the Obsidian service
import { ObsidianRestApiService } from "../services/obsidianRestAPI/index.js";
// Import the Vault Cache service
import { VaultCacheService } from "../services/obsidianRestAPI/vaultCache/index.js";
import { LocalBasesService } from "../services/localBasesService.js";
import {
  extractMarkdownTags,
  VaultFileService,
  type VaultTagLocation,
} from "../services/vaultFileService.js";
import { assertWriteAllowed } from "../services/writePolicy.js";
// Import registration functions for specific resources and tools.
import { registerObsidianDeleteNoteTool } from "./tools/obsidianDeleteNoteTool/index.js";
import { registerObsidianGlobalSearchTool } from "./tools/obsidianGlobalSearchTool/index.js";
import { registerObsidianListNotesTool } from "./tools/obsidianListNotesTool/index.js";
import { registerObsidianReadNoteTool } from "./tools/obsidianReadNoteTool/index.js";
import { registerObsidianSearchReplaceTool } from "./tools/obsidianSearchReplaceTool/index.js";
import { registerObsidianUpdateNoteTool } from "./tools/obsidianUpdateNoteTool/index.js";
import { registerObsidianManageFrontmatterTool } from "./tools/obsidianManageFrontmatterTool/index.js";
import { registerObsidianManageTagsTool } from "./tools/obsidianManageTagsTool/index.js";
import { registerSemanticSearchTool } from "./tools/semanticSearchTool/index.js";
import { registerBasesListTool } from "./tools/basesListTool/index.js";
import { registerBasesGetSchemaTool } from "./tools/basesGetSchemaTool/index.js";
import { registerBasesQueryTool } from "./tools/basesQueryTool/index.js";
import { registerBasesUpsertRowsTool } from "./tools/basesUpsertRowsTool/index.js";
import { registerBasesCreateTool } from "./tools/basesCreateTool/index.js";
import { registerBasesUpsertConfigTool } from "./tools/basesUpsertConfigTool/index.js";
import { registerListAllTasksTool } from "./tools/listAllTasksTool/index.js";
import { registerQueryTasksTool } from "./tools/queryTasksTool/index.js";
import { registerRuntimeTools } from "./tools/runtimeTools/index.js";
// Import transport setup functions.
import { startHttpTransport } from "./transports/httpTransport.js";
import { connectStdioTransport } from "./transports/stdioTransport.js";

async function updateCacheAfterGuardedWrite(
  vaultCacheService: VaultCacheService | undefined,
  filePath: string,
  context: ReturnType<typeof requestContextService.createRequestContext>,
): Promise<void> {
  if (vaultCacheService) {
    await vaultCacheService.updateCacheForFile(filePath, context);
  }
}

function registerHeadlessGuardedWriteTools(
  server: McpServer,
  vaultCacheService: VaultCacheService | undefined,
  includeFilesystemFeatures = false,
): void {
  const vaultFileService = new VaultFileService();

  server.tool(
    "obsidian_update_note",
    "Headless-guarded filesystem note update. Supports filePath targets with append or prepend. Uses atomic writes and vault path safety.",
    {
      targetType: z.literal("filePath"),
      targetIdentifier: z.string().min(1),
      modificationType: z.literal("wholeFile"),
      wholeFileMode: z.enum(["append", "prepend"]),
      content: z.string(),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
      returnContent: z.boolean().optional().default(false),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedUpdateNote",
        toolName: "obsidian_update_note",
        target: params.targetIdentifier,
      });
      assertWriteAllowed({
        operation: "obsidian_update_note",
        action: params.wholeFileMode,
        target: params.targetIdentifier,
        context,
      });
      const result = await vaultFileService.updateWholeFile(
        params.targetIdentifier,
        params.wholeFileMode,
        params.content,
        context,
        {
          expectedHash: params.expectedHash,
          expectedMtime: params.expectedMtime,
        },
      );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        result.path,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                mode: "headless-guarded",
                path: result.path,
                stats: {
                  ctime: result.ctime,
                  mtime: result.mtime,
                  size: result.size,
                  hash: result.hash,
                },
                content: params.returnContent ? result.content : undefined,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "obsidian_search_replace",
    "Headless-guarded filesystem exact search/replace for filePath targets.",
    {
      targetType: z.literal("filePath"),
      targetIdentifier: z.string().min(1),
      replacements: z
        .array(z.object({ search: z.string().min(1), replace: z.string() }))
        .min(1),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
      returnContent: z.boolean().optional().default(false),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedSearchReplace",
        toolName: "obsidian_search_replace",
        target: params.targetIdentifier,
      });
      assertWriteAllowed({
        operation: "obsidian_search_replace",
        action: "replace",
        target: params.targetIdentifier,
        context,
      });
      const { result, replacementsApplied } =
        await vaultFileService.searchReplace(
          params.targetIdentifier,
          params.replacements,
          context,
          {
            expectedHash: params.expectedHash,
            expectedMtime: params.expectedMtime,
          },
        );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        result.path,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                mode: "headless-guarded",
                path: result.path,
                replacementsApplied,
                stats: {
                  ctime: result.ctime,
                  mtime: result.mtime,
                  size: result.size,
                  hash: result.hash,
                },
                content: params.returnContent ? result.content : undefined,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "obsidian_manage_frontmatter",
    "Headless-guarded filesystem frontmatter setter for a single key.",
    {
      filePath: z.string().min(1),
      operation: z.literal("set"),
      key: z.string().min(1),
      value: z.any(),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedManageFrontmatter",
        toolName: "obsidian_manage_frontmatter",
        target: params.filePath,
      });
      assertWriteAllowed({
        operation: "obsidian_manage_frontmatter",
        action: "set",
        target: params.filePath,
        frontmatterKeys: [params.key],
        context,
      });
      const { result, value } = await vaultFileService.setFrontmatterKey(
        params.filePath,
        params.key,
        params.value,
        context,
        {
          expectedHash: params.expectedHash,
          expectedMtime: params.expectedMtime,
        },
      );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        result.path,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                mode: "headless-guarded",
                path: result.path,
                key: params.key,
                value,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  if (!includeFilesystemFeatures) {
    return;
  }

  server.tool(
    "obsidian_delete_note",
    "Headless-guarded filesystem delete for explicit filePath targets. Requires expectedHash or expectedMtime.",
    {
      filePath: z.string().min(1),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedDeleteNote",
        toolName: "obsidian_delete_note",
        target: params.filePath,
      });
      if (!params.expectedHash && typeof params.expectedMtime !== "number") {
        throw new Error(
          "headless-guarded delete requires expectedHash or expectedMtime.",
        );
      }
      assertWriteAllowed({
        operation: "obsidian_delete_note",
        action: "delete",
        target: params.filePath,
        destructive: true,
        allowInGuarded: true,
        context,
      });
      const deleted = await vaultFileService.deleteFile(
        params.filePath,
        context,
        {
          expectedHash: params.expectedHash,
          expectedMtime: params.expectedMtime,
        },
      );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        deleted.path,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                mode: "headless-guarded",
                path: deleted.path,
                deletedHash: deleted.hash,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "obsidian_manage_tags",
    "Headless-filesystem tag management for YAML frontmatter tags, inline Markdown tags, and local tag index.",
    {
      filePath: z.string().min(1).optional(),
      operation: z.enum(["add", "remove", "list", "index"]),
      tags: z.array(z.string()).default([]),
      location: z
        .enum(["frontmatter", "inline", "both"])
        .default("frontmatter"),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedManageTags",
        toolName: "obsidian_manage_tags",
        target: params.filePath,
      });
      if (params.operation === "index") {
        const entries = vaultCacheService?.getEntriesByPrefix("") ?? [];
        const counts = new Map<string, { files: number; paths: string[] }>();
        for (const entry of entries) {
          if (path.extname(entry.path).toLowerCase() !== ".md") {
            continue;
          }
          const content =
            (await vaultCacheService?.getEntry(entry.path))?.content ?? "";
          for (const tag of extractMarkdownTags(content).allTags) {
            const current = counts.get(tag) ?? { files: 0, paths: [] };
            current.files += 1;
            current.paths.push(entry.path);
            counts.set(tag, current);
          }
        }
        const tags = [...counts.entries()]
          .map(([tag, value]) => ({
            tag,
            files: value.files,
            paths: value.paths.sort(),
          }))
          .sort((left, right) => left.tag.localeCompare(right.tag));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  mode: "headless-filesystem",
                  source: "filesystem-cache",
                  tags,
                  limitations: [
                    "The index is built from Markdown files in the shared cache.",
                    "It does not evaluate Obsidian plugin-specific tag behavior.",
                  ],
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }
      if (!params.filePath) {
        throw new Error("filePath is required unless operation=index.");
      }
      if (params.operation !== "list") {
        assertWriteAllowed({
          operation: "obsidian_manage_tags",
          action: params.operation,
          target: params.filePath,
          batchCount: params.tags.length,
          allowInGuarded: true,
          context,
        });
      }
      const { result, currentTags, frontmatterTags, inlineTags } =
        await vaultFileService.manageTags(
          params.filePath,
          params.operation,
          params.tags,
          params.location as VaultTagLocation,
          context,
          {
            expectedHash: params.expectedHash,
            expectedMtime: params.expectedMtime,
          },
        );
      if (result) {
        await updateCacheAfterGuardedWrite(
          vaultCacheService,
          result.path,
          context,
        );
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                mode: "headless-filesystem",
                path: params.filePath,
                location: params.location,
                frontmatterTags,
                inlineTags,
                currentTags,
                stats: result
                  ? {
                      ctime: result.ctime,
                      mtime: result.mtime,
                      size: result.size,
                      hash: result.hash,
                    }
                  : undefined,
                limitations: [
                  "Headless tag management edits Markdown/YAML text only.",
                  "It does not evaluate Obsidian's plugin-specific tag behavior.",
                ],
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "obsidian_move_note",
    "Headless-filesystem move/rename for explicit filePath targets. Requires expectedHash or expectedMtime.",
    {
      sourcePath: z.string().min(1),
      targetPath: z.string().min(1),
      overwrite: z.boolean().default(false),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
      dryRun: z.boolean().default(false),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessFilesystemMoveNote",
        toolName: "obsidian_move_note",
        target: params.sourcePath,
      });
      if (!params.expectedHash && typeof params.expectedMtime !== "number") {
        throw new Error(
          "headless-filesystem move requires expectedHash or expectedMtime.",
        );
      }
      assertWriteAllowed({
        operation: "obsidian_move_note",
        action: params.dryRun ? "dryRun" : "move",
        target: `${params.sourcePath} -> ${params.targetPath}`,
        destructive: params.overwrite,
        allowInReadonly: params.dryRun,
        allowInGuarded: true,
        context,
      });
      if (params.dryRun) {
        const current = await vaultFileService.read(params.sourcePath, context);
        if (params.expectedHash && current.hash !== params.expectedHash) {
          throw new Error(
            "File changed since the caller-provided expectedHash.",
          );
        }
        if (
          typeof params.expectedMtime === "number" &&
          current.mtime !== Math.round(params.expectedMtime)
        ) {
          throw new Error(
            "File changed since the caller-provided expectedMtime.",
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  dryRun: true,
                  source: "filesystem-guarded",
                  sourcePath: current.path,
                  targetPath: params.targetPath,
                  sourceHash: current.hash,
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }
      const { previous, result } = await vaultFileService.moveFile(
        params.sourcePath,
        params.targetPath,
        context,
        {
          expectedHash: params.expectedHash,
          expectedMtime: params.expectedMtime,
        },
        params.overwrite,
      );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        previous.path,
        context,
      );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        result.path,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                source: "filesystem-guarded",
                from: previous.path,
                to: result.path,
                previousHash: previous.hash,
                stats: {
                  mtime: result.mtime,
                  size: result.size,
                  hash: result.hash,
                },
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "obsidian_batch_frontmatter",
    "Headless-filesystem batch frontmatter set with dry-run support. Protected keys remain blocked by write policy.",
    {
      operations: z
        .array(
          z.object({
            filePath: z.string().min(1),
            set: z.record(z.any()).default({}),
            expectedHash: z.string().optional(),
            expectedMtime: z.number().optional(),
          }),
        )
        .min(1),
      dryRun: z.boolean().default(true),
      continueOnError: z.boolean().default(false),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessFilesystemBatchFrontmatter",
        toolName: "obsidian_batch_frontmatter",
        target: "batch",
      });
      const keys = params.operations.flatMap((operation) =>
        Object.keys(operation.set ?? {}),
      );
      assertWriteAllowed({
        operation: "obsidian_batch_frontmatter",
        action: params.dryRun ? "dryRun" : "set",
        batchCount: params.operations.length,
        frontmatterKeys: keys,
        allowInReadonly: params.dryRun,
        allowInGuarded: true,
        context,
      });
      const results = [];
      for (const operation of params.operations) {
        try {
          if (Object.keys(operation.set ?? {}).length === 0) {
            throw new Error(
              "obsidian_batch_frontmatter supports non-empty set only.",
            );
          }
          if (params.dryRun) {
            const current = await vaultFileService.read(
              operation.filePath,
              context,
            );
            results.push({
              file: current.path,
              dryRun: true,
              setKeys: Object.keys(operation.set),
              currentHash: current.hash,
            });
            continue;
          }
          const { result } = await vaultFileService.setFrontmatterKeys(
            operation.filePath,
            operation.set,
            context,
            {
              expectedHash: operation.expectedHash,
              expectedMtime: operation.expectedMtime,
            },
          );
          await updateCacheAfterGuardedWrite(
            vaultCacheService,
            result.path,
            context,
          );
          results.push({
            file: result.path,
            setKeys: Object.keys(operation.set),
            mtime: result.mtime,
            hash: result.hash,
          });
        } catch (error) {
          results.push({
            file: operation.filePath,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
          if (!params.continueOnError) {
            break;
          }
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: results.every((result) => !("error" in result)),
                dryRun: params.dryRun,
                source: "filesystem-guarded",
                results,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "bases_create",
    "Headless-guarded filesystem .base create/validate. Writes YAML directly and does not evaluate Obsidian Bases semantics.",
    {
      path: z.string().min(1),
      spec: z.record(z.any()),
      overwrite: z.boolean().default(false),
      validateOnly: z.boolean().default(false),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedBasesCreate",
        toolName: "bases_create",
        target: params.path,
      });
      const target = params.path.endsWith(".base")
        ? params.path
        : `${params.path}.base`;
      const yaml = `${dump(params.spec, { lineWidth: -1, noRefs: true }).trim()}\n`;
      load(yaml);
      assertWriteAllowed({
        operation: "bases_create",
        action: params.validateOnly ? "validateOnly" : "create",
        target,
        allowInReadonly: params.validateOnly,
        allowInGuarded: true,
        destructive: params.overwrite,
        contentLength: yaml.length,
        context,
      });
      if (params.validateOnly) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, validateOnly: true, path: target },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }
      const result = await vaultFileService.updateWholeFile(
        target,
        "overwrite",
        yaml,
        context,
        params.overwrite
          ? {
              expectedHash: params.expectedHash,
              expectedMtime: params.expectedMtime,
            }
          : undefined,
      );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        result.path,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                source: "filesystem-guarded",
                path: result.path,
                stats: {
                  mtime: result.mtime,
                  size: result.size,
                  hash: result.hash,
                },
                limitations: [
                  "Writes .base YAML only; Obsidian UI formulas and views are not evaluated headlessly.",
                ],
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "bases_upsert_config",
    "Headless-guarded filesystem .base config replacement/validation.",
    {
      base_id: z.string().min(1),
      yaml: z.string().optional(),
      json: z.record(z.any()).optional(),
      validateOnly: z.boolean().default(false),
      expectedHash: z.string().optional(),
      expectedMtime: z.number().optional(),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedBasesUpsertConfig",
        toolName: "bases_upsert_config",
        target: params.base_id,
      });
      if (!params.yaml && !params.json) {
        throw new Error("Provide yaml or json for bases_upsert_config.");
      }
      const content =
        params.yaml ?? dump(params.json, { lineWidth: -1, noRefs: true });
      load(content);
      assertWriteAllowed({
        operation: "bases_upsert_config",
        action: params.validateOnly ? "validateOnly" : "upsert_config",
        target: params.base_id,
        allowInReadonly: params.validateOnly,
        allowInGuarded: true,
        contentLength: content.length,
        context,
      });
      if (params.validateOnly) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, validateOnly: true, path: params.base_id },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }
      const result = await vaultFileService.updateWholeFile(
        params.base_id,
        "overwrite",
        content.endsWith("\n") ? content : `${content}\n`,
        context,
        {
          expectedHash: params.expectedHash,
          expectedMtime: params.expectedMtime,
        },
      );
      await updateCacheAfterGuardedWrite(
        vaultCacheService,
        result.path,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                source: "filesystem-guarded",
                path: result.path,
                stats: {
                  mtime: result.mtime,
                  size: result.size,
                  hash: result.hash,
                },
                limitations: [
                  "Replaces .base YAML only; Obsidian UI formulas and views are not evaluated headlessly.",
                ],
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );

  server.tool(
    "bases_upsert_rows",
    "Headless-guarded filesystem frontmatter set operations for notes referenced by a .base. Unset is not supported.",
    {
      base_id: z.string().min(1),
      operations: z
        .array(
          z.object({
            file: z.string().min(1),
            set: z.record(z.any()).optional(),
            expectedHash: z.string().optional(),
            expected_mtime: z.number().optional(),
          }),
        )
        .min(1),
      continueOnError: z.boolean().default(false),
    },
    async (params) => {
      const context = requestContextService.createRequestContext({
        operation: "headlessGuardedBasesUpsertRows",
        toolName: "bases_upsert_rows",
        target: params.base_id,
      });
      const keys = params.operations.flatMap((operation) =>
        Object.keys(operation.set ?? {}),
      );
      assertWriteAllowed({
        operation: "bases_upsert_rows",
        action: "upsert_rows",
        target: params.base_id,
        batchCount: params.operations.length,
        frontmatterKeys: keys,
        allowInGuarded: true,
        context,
      });
      const results = [];
      for (const operation of params.operations) {
        try {
          if (!operation.set || Object.keys(operation.set).length === 0) {
            throw new Error(
              "headless-guarded bases_upsert_rows supports set only.",
            );
          }
          const { result } = await vaultFileService.setFrontmatterKeys(
            operation.file,
            operation.set,
            context,
            {
              expectedHash: operation.expectedHash,
              expectedMtime: operation.expected_mtime,
            },
          );
          await updateCacheAfterGuardedWrite(
            vaultCacheService,
            result.path,
            context,
          );
          results.push({
            file: result.path,
            mtime: result.mtime,
            hash: result.hash,
          });
        } catch (error) {
          const item = {
            file: operation.file,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          };
          results.push(item);
          if (!params.continueOnError) {
            break;
          }
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: results.every((result) => !("error" in result)),
                source: "filesystem-guarded",
                results,
                limitations: [
                  "Headless rows update Markdown frontmatter only.",
                  "Unset, formulas, calculated properties, and Obsidian UI semantics are not supported.",
                ],
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
  );
}

/**
 * Creates and configures a new instance of the `McpServer`.
 *
 * This function is central to defining the server's identity and functionality
 * as presented to connecting clients during the MCP initialization phase.
 * It uses pre-instantiated shared services like Obsidian API and Vault Cache.
 *
 * MCP Spec Relevance:
 * - Server Identity (`serverInfo`): The `name` and `version` provided here are part
 *   of the `ServerInformation` object returned in the `InitializeResult` message.
 * - Capabilities Declaration: Declares supported features (logging, dynamic resources/tools).
 * - Resource/Tool Registration: Calls registration functions, passing necessary service instances.
 *
 * Design Note: This factory is called once for 'stdio' transport and per session for 'http' transport.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance.
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance, which may be undefined if disabled.
 * @returns {Promise<McpServer>} A promise resolving with the configured `McpServer` instance.
 * @throws {Error} If any resource or tool registration fails.
 * @private
 */
async function createMcpServerInstance(
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService: VaultCacheService | undefined,
): Promise<McpServer> {
  const context = requestContextService.createRequestContext({
    operation: "createMcpServerInstance",
  });
  logger.info("Initializing MCP server instance with shared services", context);

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

  logger.debug("Instantiating McpServer with capabilities", {
    ...context,
    serverInfo: {
      name: config.mcpServerName,
      version: config.mcpServerVersion,
    },
    capabilities: {
      logging: {},
      resources: { listChanged: true },
      tools: { listChanged: true },
    },
  });
  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    {
      capabilities: {
        logging: {}, // Server can receive logging/setLevel and send notifications/message
        resources: { listChanged: true }, // Server supports dynamic resource lists
        tools: { listChanged: true }, // Server supports dynamic tool lists
      },
    },
  );

  try {
    logger.debug(
      "Registering resources and tools using shared services...",
      context,
    );
    const isHeadlessReadonly =
      config.obsidianRuntimeMode === "headless-readonly";
    const isHeadlessGuarded = config.obsidianRuntimeMode === "headless-guarded";
    const isHeadlessFilesystem =
      config.obsidianRuntimeMode === "headless-filesystem";
    const localBasesService = vaultCacheService
      ? new LocalBasesService(vaultCacheService)
      : undefined;

    // Register read/cache-friendly tools first. In headless-readonly, the REST
    // service is intentionally absent and these tools must use the shared cache.
    await registerObsidianListNotesTool(
      server,
      obsidianService,
      vaultCacheService,
    );
    await registerObsidianReadNoteTool(
      server,
      obsidianService,
      vaultCacheService,
    );
    if (vaultCacheService) {
      await registerObsidianGlobalSearchTool(
        server,
        obsidianService,
        vaultCacheService,
      );
    } else {
      logger.warning(
        "Skipping registration of 'obsidian_global_search' because the Vault Cache Service is disabled.",
        context,
      );
    }
    await registerSemanticSearchTool(
      server,
      obsidianService,
      vaultCacheService,
    );
    await registerListAllTasksTool(server, vaultCacheService);
    await registerQueryTasksTool(server, vaultCacheService);
    await registerRuntimeTools(server, vaultCacheService);

    if (isHeadlessGuarded || isHeadlessFilesystem) {
      registerHeadlessGuardedWriteTools(
        server,
        vaultCacheService,
        isHeadlessFilesystem,
      );
      await registerBasesListTool(server, undefined, localBasesService);
      await registerBasesGetSchemaTool(server, undefined, localBasesService);
      await registerBasesQueryTool(server, undefined, localBasesService);
    } else if (!isHeadlessReadonly && obsidianService) {
      await registerObsidianDeleteNoteTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerObsidianSearchReplaceTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerObsidianUpdateNoteTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerObsidianManageFrontmatterTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerObsidianManageTagsTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerBasesListTool(server, obsidianService);
      await registerBasesGetSchemaTool(server, obsidianService);
      await registerBasesQueryTool(server, obsidianService);
      await registerBasesUpsertRowsTool(server, obsidianService);
      await registerBasesCreateTool(server, obsidianService);
      await registerBasesUpsertConfigTool(server, obsidianService);
    } else if (isHeadlessReadonly && localBasesService) {
      await registerBasesListTool(server, undefined, localBasesService);
      await registerBasesGetSchemaTool(server, undefined, localBasesService);
      await registerBasesQueryTool(server, undefined, localBasesService);
    } else {
      logger.info(
        "Skipping live/write/Bases tools because runtime mode is headless-readonly or Obsidian REST is unavailable.",
        { ...context, runtimeMode: config.obsidianRuntimeMode },
      );
    }

    logger.info("Resources and tools registered successfully", context);

    if (vaultCacheService) {
      logger.info(
        "Triggering background vault cache build (if not already built/building)...",
        context,
      );
      // Intentionally not awaiting this promise to allow server startup to proceed.
      // Errors are logged within the catch block.
      vaultCacheService.buildVaultCache().catch((cacheBuildError) => {
        logger.error("Error occurred during background vault cache build", {
          ...context, // Use the initial context for correlation
          subOperation: "BackgroundVaultCacheBuild", // Add sub-operation for clarity
          error:
            cacheBuildError instanceof Error
              ? cacheBuildError.message
              : String(cacheBuildError),
          stack:
            cacheBuildError instanceof Error
              ? cacheBuildError.stack
              : undefined,
        });
      });
    }
  } catch (err) {
    logger.error("Failed to register resources/tools", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err; // Re-throw to be caught by the caller (e.g., startTransport)
  }

  return server;
}

/**
 * Selects, sets up, and starts the appropriate MCP transport layer based on configuration.
 * This function acts as the bridge between the core server logic and the communication channel.
 * It now accepts shared service instances to pass them down the chain.
 *
 * MCP Spec Relevance:
 * - Transport Selection: Uses `config.mcpTransportType` ('stdio' or 'http').
 * - Transport Connection: Calls dedicated functions for chosen transport.
 * - Server Instance Lifecycle: Single instance for 'stdio', per-session for 'http'.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance.
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance.
 * @returns {Promise<McpServer | void>} Resolves with the `McpServer` instance for 'stdio', or `void` for 'http'.
 * @throws {Error} If the configured transport type is unsupported or if transport setup fails.
 * @private
 */
async function startTransport(
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService: VaultCacheService | undefined,
): Promise<McpServer | ServerType | void> {
  const transportType = config.mcpTransportType;
  const context = requestContextService.createRequestContext({
    operation: "startTransport",
    transport: transportType,
  });
  logger.info(`Starting transport: ${transportType}`, context);

  if (transportType === "http") {
    logger.debug(
      "Delegating to startHttpTransport with a factory for McpServer instances...",
      context,
    );
    // For HTTP, startHttpTransport manages its own lifecycle and server instances per session.
    // It needs a factory function to create new McpServer instances, passing along the shared services.
    const mcpServerFactory = async () =>
      createMcpServerInstance(obsidianService, vaultCacheService);
    const httpServerInstance = await startHttpTransport(
      mcpServerFactory,
      context,
      vaultCacheService,
    );
    return httpServerInstance; // Return the http.Server instance.
  }

  if (transportType === "stdio") {
    logger.debug(
      "Creating single McpServer instance for stdio transport using shared services...",
      context,
    );
    const server = await createMcpServerInstance(
      obsidianService,
      vaultCacheService,
    );
    logger.debug("Delegating to connectStdioTransport...", context);
    await connectStdioTransport(server, context);
    return server; // Return the single server instance for stdio.
  }

  // Should not be reached if config validation is effective.
  logger.fatal(
    `Unsupported transport type configured: ${transportType}`,
    context,
  );
  throw new Error(
    `Unsupported transport type: ${transportType}. Must be 'stdio' or 'http'.`,
  );
}

/**
 * Main application entry point. Initializes services and starts the MCP server.
 * Orchestrates server startup, transport selection, and top-level error handling.
 *
 * MCP Spec Relevance:
 * - Manages server startup, leading to a server ready for MCP messages.
 * - Handles critical startup failures, ensuring appropriate process exit.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance, instantiated by the caller (e.g., index.ts).
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance, instantiated by the caller (e.g., index.ts).
 * @returns {Promise<void | McpServer>} For 'stdio', resolves with `McpServer`. For 'http', runs indefinitely.
 *   Rejects on critical failure, leading to process exit.
 */
export async function initializeAndStartServer(
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void | McpServer | ServerType> {
  const context = requestContextService.createRequestContext({
    operation: "initializeAndStartServer",
  });
  logger.info(
    "MCP Server initialization sequence started (services provided).",
    context,
  );

  try {
    // Services are now provided by the caller (e.g., index.ts)
    logger.debug(
      "Using provided shared services (ObsidianRestApiService, VaultCacheService).",
      context,
    );

    // Initiate the transport setup based on configuration, passing shared services.
    const result = await startTransport(obsidianService, vaultCacheService);
    logger.info(
      "MCP Server initialization sequence completed successfully.",
      context,
    );
    return result;
  } catch (err) {
    logger.fatal("Critical error during MCP server initialization.", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Ensure the error is handled by our centralized handler, which might log more details or perform cleanup.
    ErrorHandler.handleError(err, {
      operation: "initializeAndStartServer", // More specific operation
      context: context, // Pass the existing context
      critical: true, // This is a critical failure
    });
    logger.info(
      "Exiting process due to critical initialization error.",
      context,
    );
    process.exit(1); // Exit with a non-zero code to indicate failure.
  }
}
