import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalBasesService } from "../../../services/localBasesService.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  BasesQueryInput,
  BasesQueryInputSchema,
  processBasesQuery,
} from "./logic.js";

const TOOL_NAME = "bases_query";
const TOOL_DESCRIPTION =
  "Exécute une requête sur une base (.base) avec filtres additionnels, tri et pagination.";

export async function registerBasesQueryTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService | undefined,
  localBasesService?: LocalBasesService,
): Promise<void> {
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterBasesQueryTool",
      toolName: TOOL_NAME,
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        TOOL_NAME,
        TOOL_DESCRIPTION,
        BasesQueryInputSchema.shape,
        async (params: BasesQueryInput) => {
          const handlerContext = requestContextService.createRequestContext({
            parentContext: registrationContext,
            operation: "HandleBasesQuery",
            toolName: TOOL_NAME,
            params,
          });

          const result = await processBasesQuery(
            params,
            handlerContext,
            obsidianService,
            localBasesService,
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
            isError: false,
          };
        },
      );

      logger.info(
        `Tool ${TOOL_NAME} enregistré avec succès`,
        registrationContext,
      );
    },
    {
      operation: "registerBasesQueryTool",
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Impossible d'enregistrer ${TOOL_NAME}: ${
            error instanceof Error ? error.message : "Erreur inconnue"
          }`,
          registrationContext,
        ),
      critical: true,
    },
  );
}
