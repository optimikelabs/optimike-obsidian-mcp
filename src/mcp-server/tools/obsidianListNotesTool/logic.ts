/**
 * @fileoverview Core logic for the 'obsidian_list_notes' tool.
 * This module defines the input schema, response types, and processing logic for
 * recursively listing files and directories in an Obsidian vault with filtering.
 * @module src/mcp-server/tools/obsidianListNotesTool/logic
 */

import path from "node:path";
import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  retryWithDelay,
} from "../../../utils/index.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/**
 * Zod schema for validating the input parameters of the 'obsidian_list_notes' tool.
 */
export const ObsidianListNotesInputSchema = z
  .object({
    /**
     * The vault-relative path to the directory whose contents should be listed.
     * The path is treated as case-sensitive by the underlying Obsidian API.
     */
    dirPath: z
      .string()
      .describe(
        'The vault-relative path to the directory to list (e.g., "developer/atlas-mcp-server", "/" for root). Case-sensitive.',
      ),
    /**
     * Optional array of file extensions (including the leading dot) to filter the results.
     * Only files matching one of these extensions will be included. Directories are always included.
     */
    fileExtensionFilter: z
      .array(z.string().startsWith(".", "Extension must start with a dot '.'"))
      .optional()
      .describe(
        'Optional array of file extensions (e.g., [".md"]) to filter files. Directories are always included.',
      ),
    /**
     * Optional JavaScript-compatible regular expression pattern string to filter results by name.
     * Only files and directories whose names match the regex will be included.
     */
    nameRegexFilter: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Optional regex pattern (JavaScript syntax) to filter results by name.",
      ),
    /**
     * The maximum depth of subdirectories to list recursively.
     * - A value of `0` lists only the files and directories in the specified `dirPath`.
     * - A value of `1` lists the contents of `dirPath` and the contents of its immediate subdirectories.
     * - A value of `-1` (the default) indicates infinite recursion, listing all subdirectories.
     */
    recursionDepth: z
      .number()
      .int()
      .default(-1)
      .describe(
        "Maximum recursion depth. 0 for no recursion, -1 for infinite (default).",
      ),
    responseMode: z
      .enum(["tree", "compact"])
      .optional()
      .default("tree")
      .describe(
        "Response shape. 'tree' preserves the legacy tree string; 'compact' returns paginated path entries for agent context efficiency.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Maximum compact entries to return. Only applies to responseMode='compact'."),
    cursor: z
      .string()
      .optional()
      .describe("Opaque cursor returned by a previous compact response."),
  })
  .describe(
    "Input parameters for listing files and subdirectories within a specified Obsidian vault directory, with optional filtering and recursion.",
  );

/**
 * TypeScript type inferred from the input schema (`ObsidianListNotesInputSchema`).
 */
export type ObsidianListNotesInput = z.infer<
  typeof ObsidianListNotesInputSchema
>;

// ====================================================================================
// Response & Internal Type Definitions
// ====================================================================================

/**
 * Defines the structure of a node in the file tree.
 */
interface FileTreeNode {
  name: string;
  type: "file" | "directory";
  children: FileTreeNode[];
}

interface CompactFileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
}

/**
 * Defines the structure of the successful response returned by the core logic function.
 */
export interface ObsidianListNotesResponse {
  directoryPath: string;
  tree?: string;
  entries?: CompactFileEntry[];
  totalEntries: number;
  count?: number;
  limit?: number;
  nextCursor?: string;
  hasMore?: boolean;
  responseMode?: "tree" | "compact";
}

// ====================================================================================
// Helper Functions
// ====================================================================================

/**
 * Recursively builds a formatted tree string from a nested array of FileTreeNode objects.
 *
 * @param {FileTreeNode[]} nodes - The array of nodes to format.
 * @param {string} [indent=""] - The indentation prefix for the current level.
 * @returns {{ tree: string, count: number }} An object containing the formatted tree string and the total count of entries.
 */
function formatTree(
  nodes: FileTreeNode[],
  indent = "",
): { tree: string; count: number } {
  let treeString = "";
  let count = nodes.length;

  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const prefix = isLast ? "└── " : "├── ";
    const childIndent = isLast ? "    " : "│   ";

    treeString += `${indent}${prefix}${node.name}\n`;

    if (node.children && node.children.length > 0) {
      const result = formatTree(node.children, indent + childIndent);
      treeString += result.tree;
      count += result.count;
    }
  });

  return { tree: treeString, count };
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      `Invalid cursor '${cursor}'. Use nextCursor from the previous compact response.`,
    );
  }
  return parsed;
}

function flattenTree(
  nodes: FileTreeNode[],
  parentPath: string,
): CompactFileEntry[] {
  const entries: CompactFileEntry[] = [];
  for (const node of nodes) {
    const cleanName =
      node.type === "directory" ? node.name.replace(/\/$/u, "") : node.name;
    const entryPath =
      parentPath === "/" || parentPath === ""
        ? cleanName
        : path.posix.join(parentPath, cleanName);
    entries.push({
      path: node.type === "directory" ? `${entryPath}/` : entryPath,
      name: node.name,
      type: node.type,
    });
    if (node.children.length > 0) {
      entries.push(...flattenTree(node.children, entryPath));
    }
  }
  return entries;
}

/**
 * Recursively builds a file tree by fetching directory contents from the Obsidian API.
 *
 * @param {string} dirPath - The path of the directory to process.
 * @param {number} currentDepth - The current recursion depth.
 * @param {ObsidianListNotesInput} params - The original validated input parameters, including filters and max depth.
 * @param {RequestContext} context - The request context for logging.
 * @param {ObsidianRestApiService} obsidianService - The Obsidian API service instance.
 * @returns {Promise<FileTreeNode[]>} A promise that resolves to an array of file tree nodes.
 */
async function buildFileTree(
  dirPath: string,
  currentDepth: number,
  params: ObsidianListNotesInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<FileTreeNode[]> {
  const { recursionDepth, fileExtensionFilter, nameRegexFilter } = params;

  // Stop recursion if max depth is reached (and it's not infinite)
  if (recursionDepth !== -1 && currentDepth > recursionDepth) {
    return [];
  }

  let fileNames;
  try {
    fileNames = await obsidianService.listFiles(dirPath, context);
  } catch (error) {
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      logger.warning(
        `Directory not found during recursive list: ${dirPath}. Skipping.`,
        context,
      );
      return []; // Return empty array if a subdirectory is not found
    }
    throw error; // Re-throw other errors
  }

  const regex =
    nameRegexFilter && nameRegexFilter.trim() !== ""
      ? new RegExp(nameRegexFilter)
      : null;

  const treeNodes: FileTreeNode[] = [];

  for (const name of fileNames) {
    const fullPath = path.posix.join(dirPath, name);
    const isDirectory = name.endsWith("/");
    const cleanName = isDirectory ? name.slice(0, -1) : name;

    // Apply filters
    if (regex && !regex.test(cleanName)) {
      continue;
    }
    if (!isDirectory && fileExtensionFilter && fileExtensionFilter.length > 0) {
      const extension = path.posix.extname(name);
      if (!fileExtensionFilter.includes(extension)) {
        continue;
      }
    }

    const node: FileTreeNode = {
      name: cleanName,
      type: isDirectory ? "directory" : "file",
      children: [],
    };

    if (isDirectory) {
      node.name += "/"; // Add trailing slash back for display
      node.children = await buildFileTree(
        fullPath,
        currentDepth + 1,
        params,
        context,
        obsidianService,
      );
    }

    treeNodes.push(node);
  }

  // Sort entries: directories first, then files, alphabetically
  treeNodes.sort((a, b) => {
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  return treeNodes;
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Processes the core logic for listing files and directories recursively within the Obsidian vault.
 *
 * @param {ObsidianListNotesInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service.
 * @returns {Promise<ObsidianListNotesResponse>} A promise resolving to the structured success response.
 * @throws {McpError} Throws an McpError if the initial directory is not found or another error occurs.
 */
export const processObsidianListNotes = async (
  params: ObsidianListNotesInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianListNotesResponse> => {
  const { dirPath } = params;
  const dirPathForLog = dirPath === "" || dirPath === "/" ? "/" : dirPath;

  logger.debug(
    `Processing obsidian_list_notes request for path: ${dirPathForLog}`,
    { ...context, params },
  );

  try {
    const effectiveDirPath = dirPath === "" ? "/" : dirPath;

    // --- Step 1: Build the file tree recursively with retry for the initial call ---
    const buildTreeContext = {
      ...context,
      operation: "buildFileTreeWithRetry",
    };
    const shouldRetryNotFound = (err: unknown) =>
      err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND;

    let fileTree: FileTreeNode[];
    try {
      if (!obsidianService) {
        if (!vaultCacheService?.isReady()) {
          throw new McpError(
            BaseErrorCode.SERVICE_UNAVAILABLE,
            "Obsidian REST API is unavailable and shared cache is not ready.",
            buildTreeContext,
          );
        }
        fileTree = buildFileTreeFromCache(
          effectiveDirPath,
          params,
          vaultCacheService,
        );
      } else {
        fileTree = await retryWithDelay(
          () =>
            buildFileTree(
              effectiveDirPath,
              0, // Start at depth 0
              params,
              buildTreeContext,
              obsidianService,
            ),
          {
            operationName: "buildFileTreeWithRetry",
            context: buildTreeContext,
            maxRetries: 3,
            delayMs: 300,
            shouldRetry: shouldRetryNotFound,
          },
        );
      }
    } catch (error) {
      if (
        error instanceof McpError &&
        error.code === BaseErrorCode.SERVICE_UNAVAILABLE &&
        vaultCacheService?.isReady()
      ) {
        logger.info(
          `Falling back to shared cache tree for ${effectiveDirPath}.`,
          { ...buildTreeContext, fallbackMode: "shared-cache" },
        );
        fileTree = buildFileTreeFromCache(
          effectiveDirPath,
          params,
          vaultCacheService,
        );
      } else {
        throw error;
      }
    }

    // --- Step 2: Format the tree and count entries ---
    const formatContext = { ...context, operation: "formatResponse" };
    if (fileTree.length === 0) {
      logger.debug(
        "Directory is empty or all items were filtered out.",
        formatContext,
      );
      return {
        directoryPath: dirPathForLog,
        tree: "(empty or all items filtered)",
        totalEntries: 0,
        count: 0,
        hasMore: false,
        responseMode: params.responseMode,
      };
    }

    const { tree, count } = formatTree(fileTree);
    if (params.responseMode === "compact") {
      const allEntries = flattenTree(fileTree, dirPathForLog);
      const offset = parseCursor(params.cursor);
      const limit = params.limit ?? 100;
      const entries = allEntries.slice(offset, offset + limit);
      const nextOffset = offset + entries.length;
      const hasMore = nextOffset < allEntries.length;
      return {
        directoryPath: dirPathForLog,
        entries,
        totalEntries: allEntries.length,
        count: entries.length,
        limit,
        nextCursor: hasMore ? String(nextOffset) : undefined,
        hasMore,
        responseMode: "compact",
      };
    }

    // --- Step 3: Construct and return the response ---
    const response: ObsidianListNotesResponse = {
      directoryPath: dirPathForLog,
      tree: tree.trimEnd(), // Remove trailing newline
      totalEntries: count,
      responseMode: "tree",
    };

    logger.debug(
      `Successfully processed list request for ${dirPathForLog}. Found ${count} entries.`,
      context,
    );
    return response;
  } catch (error) {
    if (error instanceof McpError) {
      // Provide a more specific message if the directory wasn't found after retries
      if (error.code === BaseErrorCode.NOT_FOUND) {
        const notFoundMsg = `Directory not found after retries: ${dirPathForLog}`;
        logger.error(notFoundMsg, error, context);
        throw new McpError(error.code, notFoundMsg, context);
      }
      logger.error(
        `McpError during file listing for ${dirPathForLog}: ${error.message}`,
        error,
        context,
      );
      throw error;
    }

    const errorMessage = `Unexpected error listing Obsidian files in ${dirPathForLog}`;
    logger.error(
      errorMessage,
      error instanceof Error ? error : undefined,
      context,
    );
    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `${errorMessage}: ${error instanceof Error ? error.message : String(error)}`,
      context,
    );
  }
};

function buildFileTreeFromCache(
  dirPath: string,
  params: ObsidianListNotesInput,
  vaultCacheService: VaultCacheService,
): FileTreeNode[] {
  const effectiveDirPath = dirPath === "" ? "/" : dirPath;
  const normalizedPrefix =
    effectiveDirPath === "/"
      ? "/"
      : path.posix.normalize(
          effectiveDirPath.startsWith("/") ? effectiveDirPath : `/${effectiveDirPath}`,
        );
  const regex =
    params.nameRegexFilter && params.nameRegexFilter.trim() !== ""
      ? new RegExp(params.nameRegexFilter)
      : null;
  const root: FileTreeNode[] = [];
  const entries = vaultCacheService.getEntriesByPrefix(normalizedPrefix);

  const getOrCreateDirectory = (
    parent: FileTreeNode[],
    name: string,
  ): FileTreeNode | null => {
    if (regex && !regex.test(name)) {
      return null;
    }

    const key = `${name}/`;
    const existing = parent.find(
      (node) => node.type === "directory" && node.name === key,
    );
    if (existing) {
      return existing;
    }

    const created: FileTreeNode = {
      name: `${name}/`,
      type: "directory",
      children: [],
    };
    parent.push(created);
    return created;
  };

  for (const entry of entries) {
    const relative =
      normalizedPrefix === "/"
        ? entry.path.replace(/^\/+/u, "")
        : path.posix.relative(normalizedPrefix, entry.path);
    if (!relative || relative.startsWith("..")) {
      continue;
    }

    const segments = relative.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    let currentLevel = root;
    let hiddenByFilter = false;
    const maxDirectoryDepth =
      params.recursionDepth === -1
        ? Math.max(segments.length - 1, 0)
        : Math.min(params.recursionDepth, Math.max(segments.length - 1, 0));

    for (let index = 0; index < maxDirectoryDepth; index++) {
      const directoryNode = getOrCreateDirectory(currentLevel, segments[index]);
      if (!directoryNode) {
        hiddenByFilter = true;
        break;
      }
      currentLevel = directoryNode.children;
    }

    if (hiddenByFilter) {
      continue;
    }

    const fileName = segments[segments.length - 1];
    const fileDepth = segments.length - 1;
    if (params.recursionDepth !== -1 && fileDepth > params.recursionDepth) {
      continue;
    }
    if (regex && !regex.test(fileName)) {
      continue;
    }
    if (
      params.fileExtensionFilter &&
      params.fileExtensionFilter.length > 0 &&
      !params.fileExtensionFilter.includes(path.posix.extname(fileName))
    ) {
      continue;
    }
    if (!currentLevel.some((node) => node.type === "file" && node.name === fileName)) {
      currentLevel.push({
        name: fileName,
        type: "file",
        children: [],
      });
    }
  }

  return sortTreeNodes(root);
}

function sortTreeNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  for (const node of nodes) {
    if (node.children.length > 0) {
      node.children = sortTreeNodes(node.children);
    }
  }

  return nodes.sort((a, b) => {
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}
