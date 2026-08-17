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
    "Legacy Obsidian Tasks-compatible Markdown query, not Operon task authority. Each newline-separated query line is a filter and all lines are combined with AND logic. Supported predicates cover status, relative or absolute dates (EN/FR), description, tags, priority and path; examples include `done`, `not done`, `tag include #foo/bar`, `tag do not include #potato`, and `description includes keyword`. Supports include/exclude path filters, optional non-task inclusion, file created/modified metadata, frontmatter meta dates, and the configured global Tasks filter. The optional path is vault-relative, defaults to the vault root, and must not contain traversal components (`..`). Use operon_query_tasks for Operon-managed tasks, stable workflow IDs and validated snapshots.";

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
        READ_ONLY_TOOL_ANNOTATIONS,
        async (params: QueryTasksInput) => {
          const handlerContext = requestContextService.createRequestContext({
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

      logger.info(
        `Tool registered successfully: ${toolName}`,
        registrationContext,
      );
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
