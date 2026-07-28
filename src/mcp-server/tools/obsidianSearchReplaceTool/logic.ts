import path from "node:path"; // For file path fallback logic using POSIX separators
import { z } from "zod";
import {
  NoteJson,
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  createFormattedStatWithTokenCount,
  logger,
  RequestContext,
  retryWithDelay,
} from "../../../utils/index.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";

// ====================================================================================
// Schema Definitions for Input Validation
// ====================================================================================

/** Defines the possible types of targets for the search/replace operation. */
const TargetTypeSchema = z
  .enum(["filePath", "activeFile", "periodicNote"])
  .describe(
    "Specifies the target note: 'filePath', 'activeFile', or 'periodicNote'.",
  );

/** Defines the valid periods for periodic notes. */
const PeriodicNotePeriodSchema = z
  .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
  .describe("Valid periods for 'periodicNote' target type.");

/**
 * Defines the structure for a single search and replace operation block.
 */
const ReplacementBlockSchema = z.object({
  /** The exact string or regex pattern to search for within the note content. Cannot be empty. */
  search: z
    .string()
    .min(1, "Search pattern cannot be empty.")
    .describe("The exact string or regex pattern to search for."),
  /** The string to replace each match with. An empty string effectively deletes the matched text. */
  replace: z.string().describe("The string to replace matches with."),
});

/**
 * Base Zod schema object containing fields common to the search/replace tool input.
 * This is used as the foundation for both the registration shape and the refined internal schema.
 */
const BaseObsidianSearchReplaceInputSchema = z.object({
  /** Specifies the target note: 'filePath', 'activeFile', or 'periodicNote'. */
  targetType: TargetTypeSchema,
  /**
   * Identifier for the target. Required and must be a vault-relative path if targetType is 'filePath'.
   * Required and must be a valid period string (e.g., 'daily') if targetType is 'periodicNote'.
   * Not used if targetType is 'activeFile'. The tool attempts a case-insensitive fallback if the exact filePath is not found.
   */
  targetIdentifier: z
    .string()
    .optional()
    .describe(
      "Required if targetType is 'filePath' (vault-relative path) or 'periodicNote' (period string: 'daily', etc.). Tries case-insensitive fallback for filePath.",
    ),
  /** An array of one or more search/replace operations to perform sequentially on the note content. */
  replacements: z
    .array(ReplacementBlockSchema)
    .min(1, "Replacements array cannot be empty.")
    .describe("An array of search/replace operations to perform sequentially."),
  /** If true, treats the 'search' field in each replacement block as a JavaScript regular expression pattern. Defaults to false (exact string matching). */
  useRegex: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, treat the 'search' field in replacements as JavaScript regex patterns. Defaults to false (exact string matching).",
    ),
  /** If true (default), replaces all occurrences matching each search pattern within the note. If false, replaces only the first occurrence of each pattern. */
  replaceAll: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), replace all occurrences for each search pattern. If false, replace only the first occurrence.",
    ),
  /** If true (default), the search operation is case-sensitive. If false, it's case-insensitive. Applies to both string and regex searches. */
  caseSensitive: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "If true (default), the search is case-sensitive. If false, it's case-insensitive. Applies to both string and regex search.",
    ),
  /** If true (and useRegex is false), treats sequences of whitespace in the search string as matching one or more whitespace characters (\s+). Defaults to false. Cannot be true if useRegex is true. */
  flexibleWhitespace: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true (and useRegex=false), treats sequences of whitespace in the search string as matching one or more whitespace characters (\\s+). Defaults to false.",
    ),
  /** If true, ensures the search term matches only whole words by implicitly adding word boundaries (\b) around the pattern (unless boundaries already exist in regex). Applies to both regex and non-regex modes. Defaults to false. */
  wholeWord: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, ensures the search term matches only whole words using word boundaries (\\b). Applies to both regex and non-regex modes. Defaults to false.",
    ),
  /** If true, includes the final content of the modified file in the response. Defaults to false. */
  returnContent: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, returns the final content of the file in the response. Defaults to false.",
    ),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional()
    .describe(
      "Optional SHA-256 precondition for a filePath target in guarded headless modes. Live Local REST writes reject this precondition.",
    ),
});

// ====================================================================================
// Refined Schema for Internal Logic and Strict Validation
// ====================================================================================

/**
 * Refined Zod schema used internally within the tool's logic for strict validation.
 * It builds upon `BaseObsidianSearchReplaceInputSchema` and adds cross-field validation rules:
 * 1. Ensures `targetIdentifier` is provided and valid when required by `targetType`.
 * 2. Ensures `flexibleWhitespace` is not used concurrently with `useRegex`.
 */
export const ObsidianSearchReplaceInputSchema =
  BaseObsidianSearchReplaceInputSchema.refine(
    (data) => {
      // Rule 1: Validate targetIdentifier based on targetType
      if (
        (data.targetType === "filePath" ||
          data.targetType === "periodicNote") &&
        !data.targetIdentifier
      ) {
        return false; // Missing targetIdentifier
      }
      if (
        data.targetType === "periodicNote" &&
        data.targetIdentifier &&
        !PeriodicNotePeriodSchema.safeParse(data.targetIdentifier).success
      ) {
        return false; // Invalid period
      }
      // Rule 2: flexibleWhitespace cannot be true if useRegex is true
      if (data.flexibleWhitespace && data.useRegex) {
        return false; // Conflicting options
      }
      return true; // All checks passed
    },
    {
      // Custom error message for refinement failures
      message:
        "Validation failed: targetIdentifier is required and must be valid for 'filePath' or 'periodicNote'. Also, 'flexibleWhitespace' cannot be true if 'useRegex' is true.",
      // Point error reporting to potentially problematic fields
      path: ["targetIdentifier", "flexibleWhitespace", "useRegex"],
    },
  ).describe(
    "Performs one or more search-and-replace operations within a target Obsidian note (file path, active, or periodic). Reads the file, applies replacements sequentially in memory, and writes the modified content back, overwriting the original. Supports string/regex search, case sensitivity toggle, replacing first/all occurrences, flexible whitespace matching (non-regex), and whole word matching.",
  );

// ====================================================================================
// Schema Shape and Type Exports for Registration and Logic
// ====================================================================================

/**
 * The shape of the base input schema, used by `server.tool` for registration and initial validation.
 * @see BaseObsidianSearchReplaceInputSchema
 */
export const ObsidianSearchReplaceInputSchemaShape =
  BaseObsidianSearchReplaceInputSchema.shape;

/**
 * TypeScript type inferred from the base registration schema. Represents the raw input
 * received by the tool handler *before* refinement.
 * @see BaseObsidianSearchReplaceInputSchema
 */
export type ObsidianSearchReplaceRegistrationInput = z.infer<
  typeof BaseObsidianSearchReplaceInputSchema
>;

/**
 * TypeScript type inferred from the *refined* input schema (`ObsidianSearchReplaceInputSchema`).
 * This type represents the validated and structured input used within the core processing logic.
 */
export type ObsidianSearchReplaceInput = z.infer<
  typeof ObsidianSearchReplaceInputSchema
>;

// ====================================================================================
// Response Type Definition
// ====================================================================================

/**
 * Represents the structure of file statistics after formatting, including
 * human-readable timestamps and an estimated token count.
 */
type FormattedStat = {
  /** Creation time formatted as a standard date-time string. */
  createdTime: string;
  /** Last modified time formatted as a standard date-time string. */
  modifiedTime: string;
  /** Estimated token count of the file content (using tiktoken 'gpt-4o'). */
  tokenCountEstimate: number;
};

/**
 * Defines the structure of the successful response returned by the `processObsidianSearchReplace` function.
 * This object is typically serialized to JSON and sent back to the client.
 */
export interface ObsidianSearchReplaceResponse {
  /** Indicates whether the operation was successful. */
  success: boolean;
  /** A human-readable message describing the outcome of the operation (e.g., number of replacements). */
  message: string;
  /** The total number of replacements made across all search/replace blocks. */
  totalReplacementsMade: number;
  /** Optional file statistics (creation/modification times, token count) if the file could be read after the update. */
  stats?: FormattedStat;
  /** Optional final content of the file, included only if `returnContent` was true in the request. */
  finalContent?: string;
}

// ====================================================================================
// Helper Functions
// ====================================================================================

/**
 * Escapes characters that have special meaning in regular expressions.
 * This allows treating a literal string as a pattern in a regex.
 *
 * @param {string} str - The input string to escape.
 * @returns {string} The string with regex special characters escaped.
 */
function escapeRegex(str: string): string {
  // Escape characters: . * + ? ^ $ { } ( ) | [ ] \ -
  return str.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"); // $& inserts the matched character
}

/**
 * Attempts to retrieve the final state (content and stats) of the target note after a search/replace operation.
 * Uses the appropriate Obsidian API method based on the target type and the potentially corrected file path.
 * Logs a warning and returns null if fetching the final state fails, preventing failure of the entire operation.
 *
 * @param {z.infer<typeof TargetTypeSchema>} targetType - The type of the target note.
 * @param {string | undefined} effectiveFilePath - The vault-relative path (potentially corrected by case-insensitive fallback). Undefined for non-filePath targets.
 * @param {z.infer<typeof PeriodicNotePeriodSchema> | undefined} period - The parsed period if targetType is 'periodicNote'.
 * @param {ObsidianRestApiService} obsidianService - The Obsidian API service instance.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @returns {Promise<NoteJson | null>} A promise resolving to the NoteJson object or null if retrieval fails.
 */
async function getFinalState(
  targetType: z.infer<typeof TargetTypeSchema>,
  effectiveFilePath: string | undefined,
  period: z.infer<typeof PeriodicNotePeriodSchema> | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<NoteJson | null> {
  const operation = "getFinalStateAfterSearchReplace";
  const targetDesc =
    effectiveFilePath ?? (period ? `periodic ${period}` : "active file");
  logger.debug(`Attempting to retrieve final state for target: ${targetDesc}`, {
    ...context,
    operation,
  });
  try {
    let noteJson: NoteJson | null = null;
    // Call the appropriate API method
    if (targetType === "filePath" && effectiveFilePath) {
      noteJson = (await obsidianService.getFileContent(
        effectiveFilePath,
        "json",
        context,
      )) as NoteJson;
    } else if (targetType === "activeFile") {
      noteJson = (await obsidianService.getActiveFile(
        "json",
        context,
      )) as NoteJson;
    } else if (targetType === "periodicNote" && period) {
      noteJson = (await obsidianService.getPeriodicNote(
        period,
        "json",
        context,
      )) as NoteJson;
    }
    logger.debug(`Successfully retrieved final state for ${targetDesc}`, {
      ...context,
      operation,
    });
    return noteJson;
  } catch (error) {
    // Log the error but return null to avoid failing the main operation.
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warning(
      `Could not retrieve final state after search/replace for target: ${targetDesc}. Error: ${errorMsg}`,
      { ...context, operation, error: errorMsg },
    );
    return null;
  }
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

/**
 * Processes the core logic for the 'obsidian_search_replace' tool.
 * Reads the target note content, performs a sequence of search and replace operations
 * based on the provided parameters (handling regex, case sensitivity, etc.),
 * writes the modified content back to Obsidian, retrieves the final state,
 * and constructs the response object.
 *
 * @param {ObsidianSearchReplaceInput} params - The validated input parameters conforming to the refined schema.
 * @param {RequestContext} context - The request context for logging and correlation.
 * @param {ObsidianRestApiService} obsidianService - The instance of the Obsidian REST API service.
 * @returns {Promise<ObsidianSearchReplaceResponse>} A promise resolving to the structured success response.
 * @throws {McpError} Throws an McpError if validation fails, reading/writing fails, or an unexpected error occurs during processing.
 */
export const processObsidianSearchReplace = async (
  params: ObsidianSearchReplaceInput, // Use the refined, validated type
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<ObsidianSearchReplaceResponse> => {
  // Destructure validated parameters for easier access
  const {
    targetType,
    targetIdentifier,
    replacements,
    useRegex: initialUseRegex, // Rename to avoid shadowing loop variable
    replaceAll,
    caseSensitive,
    flexibleWhitespace, // Note: Cannot be true if initialUseRegex is true (enforced by schema)
    wholeWord,
    returnContent,
  } = params;

  let effectiveFilePath = targetIdentifier; // Store the path used (might be updated by fallback)
  let targetDescription = targetIdentifier ?? "active file"; // For logging and error messages
  let targetPeriod: z.infer<typeof PeriodicNotePeriodSchema> | undefined;

  logger.debug(`Processing obsidian_search_replace request`, {
    ...context,
    targetType,
    targetIdentifier,
    initialUseRegex,
    flexibleWhitespace,
    wholeWord,
    returnContent,
  });

  assertWriteAllowed({
    operation: "obsidian_search_replace",
    action: "replace",
    target: targetIdentifier,
    targetType,
    contentLength: replacements.reduce(
      (total, replacement) =>
        total + replacement.search.length + replacement.replace.length,
      0,
    ),
    batchCount: replacements.length,
    guardedReason:
      initialUseRegex && replaceAll
        ? "regex replaceAll is blocked in guarded mode; use exact replacement, replaceAll=false, or MCP_WRITE_MODE=full"
        : undefined,
    context,
  });

  // --- Step 1: Read Initial Content (with case-insensitive fallback for filePath) ---
  let originalContent: string;
  const readContext = { ...context, operation: "readFileContent" };
  try {
    if (targetType === "filePath") {
      if (!targetIdentifier) {
        // Should be caught by schema, but double-check
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "targetIdentifier is required for targetType 'filePath'.",
          readContext,
        );
      }
      targetDescription = targetIdentifier; // Initial description
      try {
        // Attempt 1: Case-sensitive read
        logger.debug(
          `Attempting to read file (case-sensitive): ${targetIdentifier}`,
          readContext,
        );
        originalContent = (await obsidianService.getFileContent(
          targetIdentifier,
          "markdown",
          readContext,
        )) as string;
        effectiveFilePath = targetIdentifier; // Confirm exact path worked
        logger.debug(
          `Successfully read file using exact path: ${targetIdentifier}`,
          readContext,
        );
      } catch (readError) {
        // Attempt 2: Case-insensitive fallback if NOT_FOUND
        if (
          readError instanceof McpError &&
          readError.code === BaseErrorCode.NOT_FOUND
        ) {
          logger.info(
            `File not found with exact path: ${targetIdentifier}. Attempting case-insensitive fallback.`,
            readContext,
          );
          const dirname = path.posix.dirname(targetIdentifier);
          const filenameLower = path.posix
            .basename(targetIdentifier)
            .toLowerCase();
          // List directory contents (use root '/' if dirname is '.')
          const dirToList = dirname === "." ? "/" : dirname;
          const filesInDir = await obsidianService.listFiles(
            dirToList,
            readContext,
          );
          // Filter for files matching the lowercase basename
          const matches = filesInDir.filter(
            (f) =>
              !f.endsWith("/") &&
              path.posix.basename(f).toLowerCase() === filenameLower,
          );

          if (matches.length === 1) {
            // Found exactly one match
            const correctFilename = path.posix.basename(matches[0]);
            effectiveFilePath = path.posix.join(dirname, correctFilename); // Construct the correct path
            targetDescription = effectiveFilePath; // Update description for subsequent logs/errors
            logger.info(
              `Found case-insensitive match: ${effectiveFilePath}. Reading content.`,
              readContext,
            );
            originalContent = (await obsidianService.getFileContent(
              effectiveFilePath,
              "markdown",
              readContext,
            )) as string;
            logger.debug(
              `Successfully read file using fallback path: ${effectiveFilePath}`,
              readContext,
            );
          } else {
            // Handle ambiguous (multiple matches) or no match found
            const errorMsg =
              matches.length > 1
                ? `Read failed: Ambiguous case-insensitive matches found for '${targetIdentifier}' in directory '${dirToList}'. Matches: [${matches.join(", ")}]`
                : `Read failed: File not found for '${targetIdentifier}' (case-insensitive fallback also failed in directory '${dirToList}').`;
            logger.error(errorMsg, { ...readContext, matches });
            // Use NOT_FOUND for no match, CONFLICT for ambiguity
            throw new McpError(
              matches.length > 1
                ? BaseErrorCode.CONFLICT
                : BaseErrorCode.NOT_FOUND,
              errorMsg,
              readContext,
            );
          }
        } else {
          // Re-throw errors other than NOT_FOUND during the initial read attempt
          throw readError;
        }
      }
    } else if (targetType === "activeFile") {
      logger.debug(`Reading content from active file.`, readContext);
      originalContent = (await obsidianService.getActiveFile(
        "markdown",
        readContext,
      )) as string;
      targetDescription = "the active file";
      effectiveFilePath = undefined; // Not applicable
      logger.debug(`Successfully read active file content.`, readContext);
    } else {
      // periodicNote
      if (!targetIdentifier) {
        // Should be caught by schema
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "targetIdentifier is required for targetType 'periodicNote'.",
          readContext,
        );
      }
      // Parse period (already validated by refined schema)
      targetPeriod = PeriodicNotePeriodSchema.parse(targetIdentifier);
      targetDescription = `periodic note '${targetPeriod}'`;
      effectiveFilePath = undefined; // Not applicable
      logger.debug(`Reading content from ${targetDescription}.`, readContext);
      originalContent = (await obsidianService.getPeriodicNote(
        targetPeriod,
        "markdown",
        readContext,
      )) as string;
      logger.debug(
        `Successfully read ${targetDescription} content.`,
        readContext,
      );
    }
  } catch (error) {
    // Catch and handle errors during the initial read phase
    if (error instanceof McpError) throw error; // Re-throw known McpErrors
    const errorMessage = `Unexpected error reading target ${targetDescription} before search/replace.`;
    logger.error(
      errorMessage,
      error instanceof Error ? error : undefined,
      readContext,
    );
    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      `${errorMessage}: ${error instanceof Error ? error.message : String(error)}`,
      readContext,
    );
  }

  if (params.expectedSha256) {
    if (targetType !== "filePath" || !effectiveFilePath) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "expectedSha256 is supported only for an explicit filePath target.",
        context,
      );
    }
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      "Atomic expectedSha256 writes are unavailable through the current Obsidian Local REST API. Use a copied or dedicated vault in headless-filesystem mode.",
      context,
    );
  }

  // --- Step 2: Perform Sequential Replacements ---
  let modifiedContent = originalContent;
  let totalReplacementsMade = 0;
  const replaceContext = { ...context, operation: "performReplacements" };

  logger.debug(
    `Starting ${replacements.length} replacement operations.`,
    replaceContext,
  );

  for (let i = 0; i < replacements.length; i++) {
    const rep = replacements[i];
    const repContext = {
      ...replaceContext,
      replacementIndex: i,
      searchPattern: rep.search,
    };
    let currentReplacementsInBlock = 0;
    let finalSearchPattern: string | RegExp = rep.search; // Start with the raw search string
    let useRegexForThisRep = initialUseRegex; // Use the overall setting initially

    try {
      // --- 2a: Prepare the Search Pattern (Apply options) ---
      const patternPrepContext = {
        ...repContext,
        subOperation: "prepareSearchPattern",
      };
      if (!initialUseRegex) {
        // Handle non-regex specific options: flexibleWhitespace and wholeWord
        let searchStr = rep.search; // Work with a mutable string
        if (flexibleWhitespace) {
          // Convert to a regex string: escape special chars, then replace whitespace sequences with \s+
          searchStr = escapeRegex(searchStr).replace(/\s+/g, "\\s+");
          useRegexForThisRep = true; // Now treat it as a regex pattern string
          logger.debug(
            `Applying flexibleWhitespace: "${rep.search}" -> /${searchStr}/`,
            patternPrepContext,
          );
        }
        if (wholeWord) {
          // Add word boundaries (\b) to the pattern string
          // If flexibleWhitespace was applied, searchStr is already a regex string.
          // Otherwise, escape the original search string first.
          const basePattern = useRegexForThisRep
            ? searchStr
            : escapeRegex(searchStr);
          searchStr = `\\b${basePattern}\\b`;
          useRegexForThisRep = true; // Definitely treat as a regex pattern string now
          logger.debug(
            `Applying wholeWord: "${rep.search}" -> /${searchStr}/`,
            patternPrepContext,
          );
        }
        finalSearchPattern = searchStr; // Update the pattern to use
      } else if (wholeWord) {
        // Initial useRegex is true, but wholeWord is also requested.
        // Apply wholeWord boundaries if the user's regex doesn't obviously have them.
        let searchStr = rep.search;
        // Heuristic check: Does the pattern likely already account for boundaries?
        // Looks for ^, $, \b at start/end, or patterns matching full lines/non-whitespace sequences.
        const hasBoundary =
          /(?:^|\\b)\S.*\S(?:$|\\b)|^\S$|^\S.*\S$|^$/.test(searchStr) ||
          /^\^|\\b/.test(searchStr) ||
          /\$|\\b$/.test(searchStr);
        if (!hasBoundary) {
          searchStr = `\\b${searchStr}\\b`;
          // Log a warning as this might interfere with complex user regex.
          logger.warning(
            `Applying wholeWord=true to user-provided regex. Original: /${rep.search}/, Modified: /${searchStr}/. This might affect complex regex behavior.`,
            patternPrepContext,
          );
          finalSearchPattern = searchStr; // Update the pattern string
        } else {
          logger.debug(
            `wholeWord=true requested, but user regex /${searchStr}/ appears to already contain boundary anchors. Using original regex.`,
            patternPrepContext,
          );
          finalSearchPattern = rep.search; // Keep original regex string
        }
      }
      // If it's still not treated as regex, finalSearchPattern remains the original rep.search string.

      // --- 2b: Execute the Replacement ---
      const execContext = {
        ...repContext,
        subOperation: "executeReplacement",
        isRegex: useRegexForThisRep,
      };
      if (useRegexForThisRep) {
        // --- Regex Replacement ---
        let flags = "";
        if (replaceAll) flags += "g"; // Global flag for all matches
        if (!caseSensitive) flags += "i"; // Ignore case flag
        const regex = new RegExp(finalSearchPattern as string, flags); // Create RegExp object
        logger.debug(
          `Executing regex replacement: /${finalSearchPattern}/${flags}`,
          execContext,
        );

        // Count matches *before* replacing to report accurately
        const matches = modifiedContent.match(regex);
        currentReplacementsInBlock = matches ? matches.length : 0;
        // If replaceAll is false, we only perform/count one replacement, even if regex matches more
        if (!replaceAll && currentReplacementsInBlock > 0) {
          currentReplacementsInBlock = 1;
        }

        // Perform the replacement
        if (currentReplacementsInBlock > 0) {
          if (replaceAll) {
            modifiedContent = modifiedContent.replace(regex, rep.replace);
          } else {
            // Replace only the first occurrence found by the regex
            modifiedContent = modifiedContent.replace(regex, rep.replace);
          }
        }
      } else {
        // --- Simple String Replacement ---
        // Note: wholeWord and flexibleWhitespace would have set useRegexForThisRep = true
        const searchString = finalSearchPattern as string; // It's just a string here
        const comparisonString = caseSensitive
          ? searchString
          : searchString.toLowerCase();
        let startIndex = 0;
        logger.debug(
          `Executing string replacement: "${searchString}" (caseSensitive: ${caseSensitive})`,
          execContext,
        );

        while (true) {
          const contentToSearch = caseSensitive
            ? modifiedContent
            : modifiedContent.toLowerCase();
          const index = contentToSearch.indexOf(comparisonString, startIndex);

          if (index === -1) {
            break; // No more occurrences found
          }

          currentReplacementsInBlock++;

          // Perform replacement using original indices and search string length
          modifiedContent =
            modifiedContent.substring(0, index) +
            rep.replace +
            modifiedContent.substring(index + searchString.length);

          if (!replaceAll) {
            break; // Stop after the first replacement
          }

          // Move start index past the inserted replacement to find the next match
          startIndex = index + rep.replace.length;

          // Safety break for empty search string or potential infinite loops
          if (searchString.length === 0) {
            logger.warning(
              `Search string is empty. Breaking replacement loop to prevent infinite execution.`,
              execContext,
            );
            break;
          }
          // Basic check if replacement could cause infinite loop (e.g., replacing 'a' with 'ba')
          if (
            rep.replace.includes(searchString) &&
            rep.replace.length >= searchString.length
          ) {
            // This is a heuristic, might not catch all cases but prevents common ones.
            logger.warning(
              `Replacement string "${rep.replace}" contains search string "${searchString}". Potential infinite loop detected. Breaking loop for this block.`,
              execContext,
            );
            break;
          }
        }
      }
      totalReplacementsMade += currentReplacementsInBlock;
      logger.debug(
        `Block ${i}: Performed ${currentReplacementsInBlock} replacements for search: "${rep.search}"`,
        repContext,
      );
    } catch (error) {
      // Catch errors during a specific replacement block
      const errorMessage = `Error during replacement block ${i} (search: "${rep.search}")`;
      logger.error(
        errorMessage,
        error instanceof Error ? error : undefined,
        repContext,
      );
      // Fail fast: Stop processing further replacements if one block fails.
      throw new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        `${errorMessage}: ${error instanceof Error ? error.message : "Unknown error"}`,
        repContext,
      );
    }
  } // End of replacements loop

  logger.debug(
    `Finished all replacement operations. Total replacements made: ${totalReplacementsMade}`,
    replaceContext,
  );

  // --- Step 3: Write Modified Content Back to Obsidian ---
  let finalState: NoteJson | null = null;
  const POST_UPDATE_DELAY_MS = 500; // Delay before trying to read the file back

  // Only write back if the content actually changed to avoid unnecessary file operations.
  if (modifiedContent !== originalContent) {
    const writeContext = { ...context, operation: "writeFileContent" };
    try {
      logger.debug(
        `Content changed. Writing modified content back to ${targetDescription}`,
        writeContext,
      );
      // Use the effectiveFilePath determined during the read phase for filePath targets
      if (targetType === "filePath") {
        await obsidianService.updateFileContent(
          effectiveFilePath!,
          modifiedContent,
          writeContext,
        );
        if (vaultCacheService) {
          await vaultCacheService.updateCacheForFile(
            effectiveFilePath!,
            writeContext,
          );
        }
      } else if (targetType === "activeFile") {
        await obsidianService.updateActiveFile(modifiedContent, writeContext);
      } else {
        // periodicNote
        await obsidianService.updatePeriodicNote(
          targetPeriod!,
          modifiedContent,
          writeContext,
        );
      }
      logger.info(
        `Successfully updated ${targetDescription} with ${totalReplacementsMade} replacement(s).`,
        writeContext,
      );

      // Attempt to get the final state *after* successfully writing.
      logger.debug(
        `Waiting ${POST_UPDATE_DELAY_MS}ms before retrieving final state after write...`,
        { ...writeContext, subOperation: "postWriteDelay" },
      );
      await new Promise((resolve) => setTimeout(resolve, POST_UPDATE_DELAY_MS));
      try {
        finalState = await retryWithDelay(
          async () =>
            getFinalState(
              targetType,
              effectiveFilePath,
              targetPeriod,
              obsidianService,
              context,
            ),
          {
            operationName: "getFinalStateAfterSearchReplaceWrite",
            context: {
              ...context,
              operation: "getFinalStateAfterSearchReplaceWriteAttempt",
            },
            maxRetries: 3,
            delayMs: 300,
            shouldRetry: (err: unknown) =>
              err instanceof McpError &&
              (err.code === BaseErrorCode.NOT_FOUND ||
                err.code === BaseErrorCode.SERVICE_UNAVAILABLE ||
                err.code === BaseErrorCode.TIMEOUT),
            onRetry: (attempt, err) =>
              logger.warning(
                `getFinalStateAfterSearchReplaceWrite (attempt ${attempt}) failed. Error: ${(err as Error).message}. Retrying...`,
                writeContext,
              ),
          },
        );
      } catch (retryError) {
        finalState = null;
        logger.error(
          `Failed to retrieve final state for ${targetDescription} after write, even after retries. Error: ${(retryError as Error).message}`,
          retryError instanceof Error ? retryError : undefined,
          writeContext,
        );
      }
    } catch (error) {
      // Handle errors during the write phase
      if (error instanceof McpError) throw error; // Re-throw known McpErrors
      const errorMessage = `Unexpected error writing modified content to ${targetDescription}.`;
      logger.error(
        errorMessage,
        error instanceof Error ? error : undefined,
        writeContext,
      );
      throw new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        `${errorMessage}: ${error instanceof Error ? error.message : String(error)}`,
        writeContext,
      );
    }
  } else {
    // Content did not change, no need to write.
    logger.info(
      `No changes detected in ${targetDescription} after search/replace operations. Skipping write.`,
      context,
    );
    // Still attempt to get the state, as the user might want stats even if content is unchanged.
    logger.debug(
      `Waiting ${POST_UPDATE_DELAY_MS}ms before retrieving final state (no change)...`,
      { ...context, subOperation: "postNoChangeDelay" },
    );
    await new Promise((resolve) => setTimeout(resolve, POST_UPDATE_DELAY_MS));
    try {
      finalState = await retryWithDelay(
        async () =>
          getFinalState(
            targetType,
            effectiveFilePath,
            targetPeriod,
            obsidianService,
            context,
          ),
        {
          operationName: "getFinalStateAfterSearchReplaceNoChange",
          context: {
            ...context,
            operation: "getFinalStateAfterSearchReplaceNoChangeAttempt",
          },
          maxRetries: 3,
          delayMs: 300,
          shouldRetry: (err: unknown) =>
            err instanceof McpError &&
            (err.code === BaseErrorCode.NOT_FOUND ||
              err.code === BaseErrorCode.SERVICE_UNAVAILABLE ||
              err.code === BaseErrorCode.TIMEOUT),
          onRetry: (attempt, err) =>
            logger.warning(
              `getFinalStateAfterSearchReplaceNoChange (attempt ${attempt}) failed. Error: ${(err as Error).message}. Retrying...`,
              context,
            ),
        },
      );
    } catch (retryError) {
      finalState = null;
      logger.error(
        `Failed to retrieve final state for ${targetDescription} (no change), even after retries. Error: ${(retryError as Error).message}`,
        retryError instanceof Error ? retryError : undefined,
        context,
      );
    }
  }

  // --- Step 4: Construct and Return the Response ---
  const responseContext = { ...context, operation: "buildResponse" };
  let message: string;
  if (totalReplacementsMade > 0) {
    message = `Search/replace completed on ${targetDescription}. Successfully made ${totalReplacementsMade} replacement(s).`;
  } else if (modifiedContent !== originalContent) {
    // This case should ideally not happen if totalReplacementsMade is 0, but as a safeguard:
    message = `Search/replace completed on ${targetDescription}. Content was modified, but replacement count is zero. Please review.`;
  } else {
    message = `Search/replace completed on ${targetDescription}. No matching text was found, so no replacements were made.`;
  }

  // Append a warning if the final state couldn't be retrieved
  if (finalState === null) {
    const warningMsg =
      " (Warning: Could not retrieve final file stats/content after update.)";
    message += warningMsg;
    logger.warning(
      `Appending warning to response message: ${warningMsg}`,
      responseContext,
    );
  }

  // Format the file statistics using the shared utility.
  // Use final state content if available, otherwise use the (potentially modified) content in memory for token count.
  const finalContentForStat = finalState?.content ?? modifiedContent;
  const formattedStatResult = finalState?.stat
    ? await createFormattedStatWithTokenCount(
        finalState.stat,
        finalContentForStat,
        responseContext,
      ) // Await the async utility
    : undefined;
  // Ensure stat is undefined if the utility returned null (e.g., token counting failed)
  const formattedStat =
    formattedStatResult === null ? undefined : formattedStatResult;

  // Build the final response object
  const response: ObsidianSearchReplaceResponse = {
    success: true,
    message: message,
    totalReplacementsMade,
    stats: formattedStat,
  };

  // Include final content if requested and available.
  if (returnContent) {
    // Prefer content from final state read, fallback to in-memory modified content.
    response.finalContent = finalState?.content ?? modifiedContent;
    logger.debug(
      `Including final content in response as requested.`,
      responseContext,
    );
  }

  logger.debug(
    `Search/replace process completed successfully.`,
    responseContext,
  );
  return response;
};
