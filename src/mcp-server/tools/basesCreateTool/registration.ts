import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MUTATING_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  BasesCreateInput,
  BasesCreateInputSchema,
  processBasesCreate,
} from "./logic.js";

const TOOL_NAME = "bases_create";
const TOOL_DESCRIPTION =
  "Crée (ou valide) une nouvelle base .base en générant le YAML via le bridge REST.";

export async function registerBasesCreateTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterBasesCreateTool",
      toolName: TOOL_NAME,
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        TOOL_NAME,
        TOOL_DESCRIPTION,
        BasesCreateInputSchema.shape,
        MUTATING_TOOL_ANNOTATIONS,
        async (params: BasesCreateInput) => {
          const handlerContext = requestContextService.createRequestContext({
            parentContext: registrationContext,
            operation: "HandleBasesCreate",
            toolName: TOOL_NAME,
            params: {
              path: params.path,
              overwrite: params.overwrite,
              validateOnly: params.validateOnly,
            },
          });

          const result = await processBasesCreate(
            params,
            handlerContext,
            obsidianService,
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
      operation: "registerBasesCreateTool",
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
