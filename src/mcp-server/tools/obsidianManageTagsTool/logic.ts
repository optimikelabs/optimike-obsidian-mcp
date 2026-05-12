import { z } from "zod";
import { dump } from "js-yaml";
import {
  NoteJson,
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  logger,
  RequestContext,
  retryWithDelay,
} from "../../../utils/index.js";
import { sanitization } from "../../../utils/security/sanitization.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";

// ====================================================================================
// Schema Definitions
// ====================================================================================

const ManageTagsInputSchemaBase = z.object({
  filePath: z
    .string()
    .min(1)
    .describe(
      "The vault-relative path to the target note (e.g., 'Journal/2024-06-12.md').",
    ),
  operation: z
    .enum(["add", "remove", "list"])
    .describe(
      "The tag operation to perform: 'add' to include new tags, 'remove' to delete existing tags, or 'list' to view all current tags.",
    ),
  tags: z
    .array(z.string())
    .describe(
      "An array of tag names to be processed. The '#' prefix should be omitted (e.g., use 'project/active', not '#project/active').",
    ),
});

export const ObsidianManageTagsInputSchemaShape =
  ManageTagsInputSchemaBase.shape;
export const ManageTagsInputSchema = ManageTagsInputSchemaBase;

export type ObsidianManageTagsInput = z.infer<typeof ManageTagsInputSchema>;

export interface ObsidianManageTagsResponse {
  success: boolean;
  message: string;
  currentTags: string[];
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const processObsidianManageTags = async (
  params: ObsidianManageTagsInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<ObsidianManageTagsResponse> => {
  logger.debug(`Processing obsidian_manage_tags request`, {
    ...context,
    ...params,
  });

  const { filePath, operation, tags: inputTags } = params;
  const sanitizedTags = inputTags.map((t) => sanitization.sanitizeTagName(t));

  if (operation !== "list") {
    assertWriteAllowed({
      operation: "obsidian_manage_tags",
      action: operation,
      target: filePath,
      batchCount: sanitizedTags.length,
      destructive: operation === "remove",
      guardedReason:
        operation === "remove"
          ? "tag removal requires MCP_WRITE_MODE=full"
          : undefined,
      context,
    });
  }

  const shouldRetryNotFound = (err: unknown) =>
    err instanceof McpError && err.code === BaseErrorCode.NOT_FOUND;

  const getFileWithRetry = async (
    opContext: RequestContext,
    format: "json" | "markdown",
  ): Promise<NoteJson | string> => {
    return await retryWithDelay(
      () => obsidianService.getFileContent(filePath, format, opContext),
      {
        operationName: `getFileContentForTagManagement`,
        context: opContext,
        maxRetries: 3,
        delayMs: 300,
        shouldRetry: shouldRetryNotFound,
      },
    );
  };

  const initialNote = (await getFileWithRetry(context, "json")) as NoteJson;
  const currentTags = initialNote.tags;

  switch (operation) {
    case "list": {
      return {
        success: true,
        message: "Successfully listed all tags.",
        currentTags: currentTags,
      };
    }

    case "add": {
      const tagsToAdd = sanitizedTags.filter((t) => !currentTags.includes(t));
      if (tagsToAdd.length === 0) {
        return {
          success: true,
          message:
            "No new tags to add; all provided tags already exist in the note.",
          currentTags: currentTags,
        };
      }

      const frontmatter = initialNote.frontmatter ?? {};
      const frontmatterTags: string[] = Array.isArray(frontmatter.tags)
        ? frontmatter.tags
        : [];
      const newFrontmatterTags = [
        ...new Set([...frontmatterTags, ...tagsToAdd]),
      ];
      frontmatter.tags = newFrontmatterTags;

      const noteContent = (await getFileWithRetry(
        context,
        "markdown",
      )) as string;
      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
      const match = noteContent.match(frontmatterRegex);
      const newFrontmatterString = dump(frontmatter);

      let newContent;
      if (match) {
        newContent = noteContent.replace(
          frontmatterRegex,
          `---\n${newFrontmatterString}---\n`,
        );
      } else {
        newContent = `---\n${newFrontmatterString}---\n\n${noteContent}`;
      }

      await retryWithDelay(
        () => obsidianService.updateFileContent(filePath, newContent, context),
        {
          operationName: `updateFileForTagAdd`,
          context,
          maxRetries: 3,
          delayMs: 300,
          shouldRetry: shouldRetryNotFound,
        },
      );

      if (vaultCacheService) {
        await vaultCacheService.updateCacheForFile(filePath, context);
      }

      const finalTags = [...new Set([...currentTags, ...tagsToAdd])];
      return {
        success: true,
        message: `Successfully added tags: ${tagsToAdd.join(", ")}.`,
        currentTags: finalTags,
      };
    }

    case "remove": {
      const tagsToRemove = sanitizedTags.filter((t) => currentTags.includes(t));
      if (tagsToRemove.length === 0) {
        return {
          success: true,
          message:
            "No tags to remove; none of the provided tags exist in the note.",
          currentTags: currentTags,
        };
      }

      let noteContent = (await getFileWithRetry(context, "markdown")) as string;
      const frontmatter = initialNote.frontmatter ?? {};
      let frontmatterTags: string[] = Array.isArray(frontmatter.tags)
        ? frontmatter.tags
        : [];
      const newFrontmatterTags = frontmatterTags.filter(
        (t) => !tagsToRemove.includes(t),
      );
      let frontmatterModified =
        newFrontmatterTags.length !== frontmatterTags.length;

      if (frontmatterModified) {
        frontmatter.tags = newFrontmatterTags;
        if (newFrontmatterTags.length === 0) {
          delete frontmatter.tags;
        }
      }

      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
      const match = noteContent.match(frontmatterRegex);

      if (frontmatterModified && match) {
        const newFrontmatterString =
          Object.keys(frontmatter).length > 0 ? dump(frontmatter) : "";
        if (newFrontmatterString) {
          noteContent = noteContent.replace(
            frontmatterRegex,
            `---\n${newFrontmatterString}---\n`,
          );
        } else {
          noteContent = noteContent.replace(frontmatterRegex, "");
        }
      }

      let inlineModified = false;
      for (const tag of tagsToRemove) {
        const regex = new RegExp(`(^|[^\\w-#])#${tag}\\b`, "g");
        if (regex.test(noteContent)) {
          noteContent = noteContent.replace(regex, "$1");
          inlineModified = true;
        }
      }

      if (frontmatterModified || inlineModified) {
        await retryWithDelay(
          () =>
            obsidianService.updateFileContent(filePath, noteContent, context),
          {
            operationName: `updateFileContentForTagRemove`,
            context,
            maxRetries: 3,
            delayMs: 300,
            shouldRetry: shouldRetryNotFound,
          },
        );
      }

      if (vaultCacheService) {
        await vaultCacheService.updateCacheForFile(filePath, context);
      }

      const finalTags = currentTags.filter((t) => !tagsToRemove.includes(t));
      return {
        success: true,
        message: `Successfully removed tags: ${tagsToRemove.join(", ")}.`,
        currentTags: finalTags,
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
