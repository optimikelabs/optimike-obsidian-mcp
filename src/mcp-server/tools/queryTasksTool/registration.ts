import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultCacheService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  QueryTasksInput,
  QueryTasksInputSchemaShape,
  processQueryTasks,
} from "../tasksShared/logic.js";

export const registerQueryTasksTool = async (
  server: McpServer,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void> => {
  const toolName = "query_tasks";
  const toolDescription =
    "Search for tasks based on Obsidian Tasks query syntax. Allows filtering tasks by status, dates (including relative, EN/FR), description, tags, priority, and path. Each line in the query is treated as a filter with AND logic between lines. Returns only tasks that match all query conditions. Examples of task filters are `done`, `not done`, `tag include #foo/bar`, `tag do not include #potato`, `description includes keyword`. Supports include/exclude path filters, optional non-task inclusion, optional file metadata (created/modified), optional meta dates (frontmatter), and optional global filter application. The path parameter is optional; if not specified, it defaults to the vault root directory. The path must be relative to the vault directory and cannot contain directory traversal components (..).";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterQueryTasksTool",
      toolName,
      module: "QueryTasksRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        QueryTasksInputSchemaShape,
        async (params: QueryTasksInput) => {
          const handlerContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleQueryTasksRequest",
              toolName,
              params,
            });

          return await ErrorHandler.tryCatch(
            async () => {
              const text = await processQueryTasks(
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
