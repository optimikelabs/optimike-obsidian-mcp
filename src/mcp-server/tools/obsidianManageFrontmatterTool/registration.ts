import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import {
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import type {
  ObsidianManageFrontmatterInput,
  ObsidianManageFrontmatterResponse,
} from "./logic.js";
import {
  ManageFrontmatterInputSchema,
  ObsidianManageFrontmatterInputSchemaShape,
  processObsidianManageFrontmatter,
} from "./logic.js";

export const registerObsidianManageFrontmatterTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void> => {
  const toolName = "obsidian_manage_frontmatter";
  const toolDescription =
    "Direct Local REST frontmatter get/set/delete for one note. Prefer obsidian_frontmatter_patch_plan for live mutations when available: it preserves authorized source ranges and provides a durable plan/status/recovery receipt. Keep this tool for reads, compatibility, or runtimes without the governed projection.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianManageFrontmatterTool",
      toolName: toolName,
      module: "ObsidianManageFrontmatterRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianManageFrontmatterInputSchemaShape,
        DESTRUCTIVE_TOOL_ANNOTATIONS,
        async (params: ObsidianManageFrontmatterInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianManageFrontmatterRequest",
              toolName: toolName,
              params: params,
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              const validatedParams =
                ManageFrontmatterInputSchema.parse(params);

              const response: ObsidianManageFrontmatterResponse =
                await processObsidianManageFrontmatter(
                  validatedParams,
                  handlerContext,
                  obsidianService,
                  vaultCacheService,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(response, null, 2),
                  },
                ],
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
