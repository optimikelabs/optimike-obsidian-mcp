import path from "node:path"; // Using POSIX path functions for vault path manipulation
import { load } from "js-yaml";
import { z } from "zod";
import {
  NoteJson,
  ObsidianRestApiService,
} from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  createFormattedStatWithTokenCount,
  logger,
  RequestContext,
  retryWithDelay,
} from "../../../utils/index.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/**
 * Defines the allowed formats for the returned file content.
 * - 'markdown': Returns the raw Markdown content as a string.
 * - 'json': Returns a structured NoteJson object including content, frontmatter, tags, and stats.
 */
const ReadNoteFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Specifies the format for the returned content ('markdown' or 'json'). Defaults to 'markdown'.",
  );

/**
 * Zod schema for validating the input parameters of the 'obsidian_read_note' tool.
 */
export const ObsidianReadNoteInputSchema = z
  .object({
    /**
     * The vault-relative path to the target file (e.g., "Folder/My Note.md").
     * Must include the file extension. The tool first attempts a case-sensitive match.
     * If not found, it attempts a case-insensitive fallback search within the same directory.
     */
    filePath: z
      .string()
      .min(1, "filePath cannot be empty")
      .describe(
        'The vault-relative path to the target file (e.g., "developer/github/tips.md"). Tries case-sensitive first, then case-insensitive fallback.',
      ),
    /**
     * Specifies the desired format for the returned content.
     * 'markdown' returns the raw file content as a string.
     * 'json' returns a structured NoteJson object containing content, parsed frontmatter, tags, and file metadata (stat).
     * Defaults to 'markdown'.
     */
    format: ReadNoteFormatSchema.optional() // Optional, defaults to 'markdown' via ReadNoteFormatSchema
      .describe(
        "Format for the returned content ('markdown' or 'json'). Defaults to 'markdown'.",
      ),
    /**
     * If true and the requested format is 'markdown', includes formatted file statistics
     * (creation time, modification time, token count estimate) in the response's 'stat' field.
     * Defaults to false. This flag is ignored if the format is 'json', as stats are always included within the NoteJson object itself (and also added to the top-level 'stat' field in the response).
     */
    includeStat: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true and format is 'markdown', includes file stats in the response. Defaults to false. Ignored if format is 'json'.",
      ),
  })
  .describe(
    "Retrieves the content and optionally metadata of a specific file within the connected Obsidian vault. Supports case-insensitive path fallback.",
  );

/**
 * TypeScript type inferred from the input schema (`ObsidianReadNoteInputSchema`).
 * Represents the validated input parameters used within the core processing logic.
 */
export type ObsidianReadNoteInput = z.infer<typeof ObsidianReadNoteInputSchema>;

// ====================================================================================
// Response Type Definition
// ====================================================================================

/**
 * Represents the structure of file statistics after formatting, including
 * human-readable timestamps and an estimated token count.
 */
type FormattedStat = {
  /** Creation time formatted as a standard date-time string (e.g., "05:29:00 PM | 05-03-2025"). */
  createdTime: string;
  /** Last modified time formatted as a standard date-time string (e.g., "05:29:00 PM | 05-03-2025"). */
  modifiedTime: string;
  /** Estimated token count of the file content (using tiktoken 'gpt-4o'). */
  tokenCountEstimate: number;
};

/**
 * Defines the structure of the successful response returned by the `processObsidianReadNote` function.
 * This object is typically serialized to JSON and sent back to the client.
 */
export interface ObsidianReadNoteResponse {
  /**
   * The content of the file in the requested format.
   * If format='markdown', this is a string.
   * If format='json', this is a NoteJson object (which also contains the content string and stats).
   */
  content: string | NoteJson;
  /**
   * Optional formatted file statistics.
   * Included if format='json', or if format='markdown' and includeStat=true.
   */
  stats?: FormattedStat; // Renamed from stat
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Processes the core logic for reading a file from the Obsidian vault.
 *
 * It attempts to read the file using the provided path (case-sensitive first,
 * then case-insensitive fallback). It always fetches the full NoteJson object
 * internally to access file statistics. Finally, it formats the response
 * according to the requested format ('markdown' or 'json') and the 'includeStat' flag.
 *
 * @param {ObsidianReadNoteInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service.
 * @returns {Promise<ObsidianReadNoteResponse>} A promise resolving to the structured success response
 *   containing the file content and optionally formatted statistics.
 * @throws {McpError} Throws an McpError if the file cannot be found (even with fallback),
 *   if there's an ambiguous fallback match, or if any other API interaction fails.
 */
export const processObsidianReadNote = async (
  params: ObsidianReadNoteInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianReadNoteResponse> => {
  const {
    filePath: originalFilePath,
    format: requestedFormat,
    includeStat,
  } = params;
  let effectiveFilePath = originalFilePath; // Track the actual path used (might change during fallback)

  logger.debug(
    `Processing obsidian_read_note request for path: ${originalFilePath}`,
    { ...context, format: requestedFormat, includeStat },
  );

  const shouldRetryNotFound = (err: unknown) =>
    err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND;

  const readFromSharedCache = async (
    requestedPath: string,
  ): Promise<ObsidianReadNoteResponse | null> => {
    if (!vaultCacheService?.isReady()) {
      await vaultCacheService?.buildVaultCache();
      await vaultCacheService?.waitUntilReady();
    }

    if (!vaultCacheService?.isReady()) {
      return null;
    }

    const matchedPath = vaultCacheService.findMatchingPath(requestedPath);
    if (!matchedPath) {
      return null;
    }

    const cacheEntry = await vaultCacheService.getEntry(matchedPath);
    if (!cacheEntry) {
      return null;
    }

    effectiveFilePath = matchedPath;
    const noteJson = buildNoteJsonFromCache(matchedPath, cacheEntry);
    const formattedStat = await createFormattedStatWithTokenCount(
      noteJson.stat,
      noteJson.content ?? "",
      { ...context, operation: "formatSharedCacheResponse", effectiveFilePath: matchedPath },
    );

    logger.info(`Serving ${matchedPath} from shared cache fallback.`, {
      ...context,
      fallbackMode: "shared-cache",
    });

    if (requestedFormat === "json") {
      return {
        content: noteJson,
        stats: formattedStat ?? undefined,
      };
    }

    return {
      content: noteJson.content ?? "",
      stats: includeStat ? formattedStat ?? undefined : undefined,
    };
  };

  try {
    let noteJson: NoteJson;

    // --- Step 1: Read File Content (always fetch JSON internally) ---
    const readContext = { ...context, operation: "readFileAsJson" };
    try {
      if (!obsidianService) {
        const cached = await readFromSharedCache(originalFilePath);
        if (cached) {
          return cached;
        }
        throw new McpError(
          BaseErrorCode.SERVICE_UNAVAILABLE,
          `Obsidian REST API is unavailable and shared cache is ${String(vaultCacheService?.getStats().status ?? "not ready")} or does not contain the requested file.`,
          { ...readContext, cacheStats: vaultCacheService?.getStats() },
        );
      }

      // Attempt 1: Read using the provided path (case-sensitive)
      logger.debug(
        `Attempting to read file as JSON (case-sensitive): ${originalFilePath}`,
        readContext,
      );
      noteJson = await retryWithDelay(
        () =>
          obsidianService.getFileContent(
            originalFilePath,
            "json",
            readContext,
          ) as Promise<NoteJson>,
        {
          operationName: "readFileWithRetry",
          context: readContext,
          maxRetries: 3,
          delayMs: 300,
          shouldRetry: shouldRetryNotFound,
        },
      );
      effectiveFilePath = originalFilePath; // Confirm exact path worked
      logger.debug(
        `Successfully read file as JSON using exact path: ${originalFilePath}`,
        readContext,
      );
    } catch (error) {
      if (
        error instanceof McpError &&
        error.code === BaseErrorCode.SERVICE_UNAVAILABLE
      ) {
        const cached = await readFromSharedCache(originalFilePath);
        if (cached) {
          return cached;
        }
      }

      // Attempt 2: Case-insensitive fallback if initial read failed with NOT_FOUND
      if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
        logger.info(
          `File not found with exact path: ${originalFilePath}. Attempting case-insensitive fallback.`,
          readContext,
        );
        const fallbackContext = {
          ...readContext,
          subOperation: "caseInsensitiveFallback",
        };

        try {
          // Use POSIX path functions as vault paths are typically /-separated
          const dirname = path.posix.dirname(originalFilePath);
          const filenameLower = path.posix
            .basename(originalFilePath)
            .toLowerCase();
          // Handle case where the file is in the vault root (dirname is '.')
          const dirToList = dirname === "." ? "/" : dirname;

          logger.debug(
            `Listing directory for fallback: ${dirToList}`,
            fallbackContext,
          );
          const filesInDir = await retryWithDelay(
              () => obsidianService!.listFiles(dirToList, fallbackContext),
            {
              operationName: "listFilesForReadFallback",
              context: fallbackContext,
              maxRetries: 3,
              delayMs: 300,
              shouldRetry: shouldRetryNotFound,
            },
          );

          // Filter directory listing for files matching the lowercase filename
          const matches = filesInDir.filter(
            (f) =>
              !f.endsWith("/") && // Ensure it's a file, not a directory entry ending in /
              path.posix.basename(f).toLowerCase() === filenameLower,
          );

          if (matches.length === 1) {
            // Found exactly one case-insensitive match
            const correctFilename = path.posix.basename(matches[0]);
            effectiveFilePath = path.posix.join(dirname, correctFilename); // Construct the correct path
            logger.info(
              `Found case-insensitive match: ${effectiveFilePath}. Retrying read as JSON.`,
              fallbackContext,
            );

            // Retry reading the file content using the corrected path
            noteJson = await retryWithDelay(
              () =>
                obsidianService!.getFileContent(
                  effectiveFilePath,
                  "json",
                  fallbackContext,
                ) as Promise<NoteJson>,
              {
                operationName: "readFileWithFallbackRetry",
                context: fallbackContext,
                maxRetries: 3,
                delayMs: 300,
                shouldRetry: shouldRetryNotFound,
              },
            );
            logger.debug(
              `Successfully read file as JSON using fallback path: ${effectiveFilePath}`,
              fallbackContext,
            );
          } else if (matches.length > 1) {
            // Ambiguous match: Multiple files match case-insensitively
            logger.error(
              `Case-insensitive fallback failed: Multiple matches found for ${filenameLower} in ${dirToList}.`,
              { ...fallbackContext, matches },
            );
            throw new McpError(
              BaseErrorCode.CONFLICT, // Use CONFLICT for ambiguity
              `File read failed: Ambiguous case-insensitive matches for '${originalFilePath}'. Found: [${matches.join(", ")}]`,
              fallbackContext,
            );
          } else {
            // No match found even with fallback
            logger.error(
              `Case-insensitive fallback failed: No match found for ${filenameLower} in ${dirToList}.`,
              fallbackContext,
            );
            throw new McpError(
              BaseErrorCode.NOT_FOUND,
              `File not found: '${originalFilePath}' (case-insensitive fallback also failed).`,
              fallbackContext,
            );
          }
        } catch (fallbackError) {
          // Catch errors specifically from the fallback logic
          if (fallbackError instanceof McpError) throw fallbackError; // Re-throw known errors
          // Wrap unexpected fallback errors
          const errorMessage = `Unexpected error during case-insensitive fallback for ${originalFilePath}`;
          logger.error(
            errorMessage,
            fallbackError instanceof Error ? fallbackError : undefined,
            fallbackContext,
          );
          throw new McpError(
            BaseErrorCode.INTERNAL_ERROR,
            `${errorMessage}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            fallbackContext,
          );
        }
      } else {
        // Re-throw errors from the initial read attempt that were not NOT_FOUND
        throw error;
      }
    }

    // --- Step 2: Format the Response ---
    const formatContext = {
      ...context,
      operation: "formatResponse",
      effectiveFilePath,
    };
    logger.debug(
      `Formatting response. Requested format: ${requestedFormat}, Include stat: ${includeStat}`,
      formatContext,
    );

    // Generate formatted statistics using the utility function.
    // Provide the content string for token counting. Handle cases where stat might be missing.
    const formattedStatResult = noteJson.stat
      ? await createFormattedStatWithTokenCount(
          noteJson.stat,
          noteJson.content ?? "",
          formatContext,
        ) // Await the async utility
      : undefined;
    // Ensure stat is undefined if the utility returned null (e.g., token counting failed)
    const formattedStat =
      formattedStatResult === null ? undefined : formattedStatResult;

    // Initialize the response object
    const response: ObsidianReadNoteResponse = {
      content: "", // Placeholder, will be set based on format
      // stat is added conditionally below
    };

    // Populate response based on requested format
    if (requestedFormat === "json") {
      // Return the full NoteJson object. Its internal 'stat' will remain numeric.
      // The formatted stats are provided in the top-level 'response.stats'.
      response.content = noteJson;
      response.stats = formattedStat; // Always include formatted stat at top level for JSON format
      logger.debug(
        `Response format set to JSON, including full NoteJson (with original numeric stat) and top-level formatted stat.`,
        formatContext,
      );
    } else {
      // 'markdown' format
      response.content = noteJson.content ?? ""; // Extract the markdown content string
      if (includeStat && formattedStat) {
        response.stats = formattedStat; // Include formatted stats only if requested for markdown
        logger.debug(
          `Response format set to markdown, including formatted stat as requested.`,
          formatContext,
        );
      } else {
        logger.debug(
          `Response format set to markdown, excluding stat (includeStat=${includeStat}).`,
          formatContext,
        );
      }
    }

    logger.debug(
      `Successfully processed read request for ${effectiveFilePath}.`,
      context,
    );
    return response;
  } catch (error) {
    // Catch any errors that propagated up (e.g., from initial read, fallback, or unexpected issues)
    if (error instanceof McpError) {
      // Log known McpErrors that reached this top level
      logger.error(
        `McpError during file read process for ${originalFilePath}: ${error.message}`,
        error,
        context,
      );
      throw error; // Re-throw McpError
    } else {
      // Wrap unexpected errors in a generic McpError
      const errorMessage = `Unexpected error processing read request for ${originalFilePath}`;
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
  }
};

function buildNoteJsonFromCache(
  filePath: string,
  entry: {
    content: string;
    ctime: number;
    mtime: number;
    size: number;
  },
): NoteJson {
  const { frontmatter, body } = extractFrontmatter(entry.content);
  return {
    content: entry.content,
    frontmatter,
    path: filePath,
    stat: {
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.size,
    },
    tags: extractTags(frontmatter, body),
  };
}

function extractFrontmatter(content: string): {
  frontmatter: Record<string, any>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  try {
    const parsed = load(match[1]);
    return {
      frontmatter:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, any>)
          : {},
      body: content.slice(match[0].length),
    };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function extractTags(frontmatter: Record<string, any>, body: string): string[] {
  const collected = new Set<string>();
  const frontmatterTags = frontmatter.tags;
  if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) {
      if (typeof tag === "string" && tag.trim()) {
        collected.add(tag.replace(/^#/u, ""));
      }
    }
  } else if (typeof frontmatterTags === "string" && frontmatterTags.trim()) {
    collected.add(frontmatterTags.replace(/^#/u, ""));
  }

  const regex = /(^|\s)#([A-Za-z0-9/_-]+)/g;
  for (const match of body.matchAll(regex)) {
    if (match[2]) {
      collected.add(match[2]);
    }
  }

  return [...collected];
}
