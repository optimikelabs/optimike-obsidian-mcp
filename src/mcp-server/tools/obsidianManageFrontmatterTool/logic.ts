import { z } from "zod";
import { dump } from "js-yaml";
import {
  NoteJson,
  ObsidianRestApiService,
  PatchOptions,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  retryWithDelay,
} from "../../../utils/index.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";

// ====================================================================================
// Schema Definitions
// ====================================================================================

const ManageFrontmatterInputSchemaBase = z.object({
  filePath: z
    .string()
    .min(1)
    .describe(
      "The vault-relative path to the target note (e.g., 'Projects/Active/My Note.md').",
    ),
  operation: z
    .enum(["get", "set", "delete"])
    .describe(
      "The operation to perform on the frontmatter: 'get' to read a key, 'set' to create or update a key, or 'delete' to remove a key.",
    ),
  key: z
    .string()
    .min(1)
    .describe(
      "The name of the frontmatter key to target, such as 'status', 'tags', or 'aliases'.",
    ),
  value: z
    .any()
    .optional()
    .describe(
      "The value to assign when using the 'set' operation. Can be a string, number, boolean, array, or a JSON object.",
    ),
});

export const ObsidianManageFrontmatterInputSchemaShape =
  ManageFrontmatterInputSchemaBase.shape;

export const ManageFrontmatterInputSchema =
  ManageFrontmatterInputSchemaBase.refine(
    (data) => {
      if (data.operation === "set" && data.value === undefined) {
        return false;
      }
      return true;
    },
    {
      message: "A 'value' is required when the 'operation' is 'set'.",
      path: ["value"],
    },
  );

export type ObsidianManageFrontmatterInput = z.infer<
  typeof ManageFrontmatterInputSchema
>;

export interface ObsidianManageFrontmatterResponse {
  success: boolean;
  message: string;
  value?: any;
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const processObsidianManageFrontmatter = async (
  params: ObsidianManageFrontmatterInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<ObsidianManageFrontmatterResponse> => {
  logger.debug(`Processing obsidian_manage_frontmatter request`, {
    ...context,
    operation: params.operation,
    filePath: params.filePath,
    key: params.key,
  });

  const { filePath, operation, key, value } = params;

  if (operation !== "get") {
    assertWriteAllowed({
      operation: "obsidian_manage_frontmatter",
      action: operation,
      target: filePath,
      frontmatterKeys: [key],
      destructive: operation === "delete",
      guardedReason:
        operation === "delete"
          ? "frontmatter key deletion requires MCP_WRITE_MODE=full"
          : undefined,
      context,
    });
  }

  const shouldRetryNotFound = (err: unknown) =>
    err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND;

  const getFileWithRetry = async (
    opContext: RequestContext,
    format: "json" | "markdown" = "json",
  ): Promise<NoteJson | string> => {
    return await retryWithDelay(
      () => obsidianService.getFileContent(filePath, format, opContext),
      {
        operationName: `getFileContentForFrontmatter`,
        context: opContext,
        maxRetries: 3,
        delayMs: 300,
        shouldRetry: shouldRetryNotFound,
      },
    );
  };

  switch (operation) {
    case "get": {
      const note = (await getFileWithRetry(context)) as NoteJson;
      const frontmatter = note.frontmatter ?? {};
      const retrievedValue = frontmatter[key];
      return {
        success: true,
        message: `Successfully retrieved key '${key}' from frontmatter.`,
        value: retrievedValue,
      };
    }

    case "set": {
      const patchOptions: PatchOptions = {
        operation: "replace",
        targetType: "frontmatter",
        target: key,
        createTargetIfMissing: true,
        contentType:
          typeof value === "object" ? "application/json" : "text/markdown",
      };
      const content =
        typeof value === "object" ? JSON.stringify(value) : String(value);

      await retryWithDelay(
        () =>
          obsidianService.patchFile(filePath, content, patchOptions, context),
        {
          operationName: `patchFileForFrontmatterSet`,
          context,
          maxRetries: 3,
          delayMs: 300,
          shouldRetry: shouldRetryNotFound,
        },
      );

      if (vaultCacheService) {
        await vaultCacheService.updateCacheForFile(filePath, context);
      }
      return {
        success: true,
        message: `Successfully set key '${key}' in frontmatter.`,
        value: { [key]: value },
      };
    }

    case "delete": {
      // Note on deletion strategy: The Obsidian REST API's PATCH endpoint for frontmatter
      // supports adding/updating keys but does not have a dedicated "delete key" operation.
      // Therefore, deletion is handled by reading the note content, parsing the frontmatter,
      // removing the key from the JavaScript object, and then overwriting the entire note
      // with the updated frontmatter block. This regex-based replacement is a workaround
      // for the current API limitations.
      const noteJson = (await getFileWithRetry(context, "json")) as NoteJson;
      const frontmatter = noteJson.frontmatter;

      if (!frontmatter || frontmatter[key] === undefined) {
        return {
          success: true,
          message: `Key '${key}' not found in frontmatter. No action taken.`,
          value: {},
        };
      }

      delete frontmatter[key];

      const noteContent = (await getFileWithRetry(
        context,
        "markdown",
      )) as string;

      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
      const match = noteContent.match(frontmatterRegex);

      let newContent;
      const newFrontmatterString =
        Object.keys(frontmatter).length > 0 ? dump(frontmatter) : "";

      if (match) {
        // Frontmatter exists, replace it
        if (newFrontmatterString) {
          newContent = noteContent.replace(
            frontmatterRegex,
            `---\n${newFrontmatterString}---\n`,
          );
        } else {
          // If frontmatter is now empty, remove the block entirely
          newContent = noteContent.replace(frontmatterRegex, "");
        }
      } else {
        // This case should be rare given the initial check, but handle it defensively
        logger.warning(
          "Frontmatter key existed in JSON but block not found in markdown. No action taken.",
          context,
        );
        return {
          success: false,
          message: `Could not find frontmatter block to update, though key '${key}' was detected.`,
          value: {},
        };
      }

      await retryWithDelay(
        () => obsidianService.updateFileContent(filePath, newContent, context),
        {
          operationName: `updateFileForFrontmatterDelete`,
          context,
          maxRetries: 3,
          delayMs: 300,
          shouldRetry: shouldRetryNotFound,
        },
      );

      if (vaultCacheService) {
        await vaultCacheService.updateCacheForFile(filePath, context);
      }

      return {
        success: true,
        message: `Successfully deleted key '${key}' from frontmatter.`,
        value: {},
      };
    }

    default:
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Invalid operation: ${operation}`,
        context,
      );
  }
};
