import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { VaultCacheService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  ListAllTasksInput,
  ListAllTasksInputSchemaShape,
  processListAllTasks,
} from "../tasksShared/logic.js";

export const registerListAllTasksTool = async (
  server: McpServer,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void> => {
  const toolName = "list_all_tasks";
  const toolDescription =
    "Extract all tasks from markdown files in a directory. Recursively scans all markdown files and extracts tasks based on the Obsidian Tasks format. Returns structured data about each task including status, dates, and tags. Supports include/exclude path filters, optional non-task inclusion, optional file metadata (created/modified), optional meta dates (frontmatter), and optional global filter application. The path parameter is optional; if not specified, it defaults to the vault root directory. The path must be relative to the vault directory and cannot contain directory traversal components (..).";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterListAllTasksTool",
      toolName,
      module: "ListAllTasksRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ListAllTasksInputSchemaShape,
        READ_ONLY_TOOL_ANNOTATIONS,
        async (params: ListAllTasksInput) => {
          const handlerContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleListAllTasksRequest",
              toolName,
              params,
            });

          return await ErrorHandler.tryCatch(
            async () => {
              const text = await processListAllTasks(
                params,
                handlerContext,
                vaultCacheService,
              );
              return {
                content: [{ type: "text", text }],
                isError: false,
              };
            },
            {
              operation: `processing ${toolName} handler`,
              context: handlerContext,
              input: params,
              errorMapper: (error: unknown) =>
                new McpError(
                  error instanceof McpError
                    ? error.code
                    : BaseErrorCode.INTERNAL_ERROR,
                  `Error processing ${toolName} tool: ${error instanceof Error ? error.message : "Unknown error"}`,
                  { ...handlerContext },
                ),
            },
          );
        },
      );

      logger.info(`Tool registered successfully: ${toolName}`, registrationContext);
    },
    {
      operation: `registering tool ${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext },
        ),
      critical: true,
    },
  );
};
