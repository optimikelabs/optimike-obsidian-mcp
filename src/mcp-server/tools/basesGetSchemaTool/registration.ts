import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
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
  BasesGetSchemaInput,
  BasesGetSchemaInputSchema,
  processBasesGetSchema,
} from "./logic.js";

const TOOL_NAME = "bases_get_schema";
const TOOL_DESCRIPTION =
  "Retourne le schéma (propriétés, vues, formules) d'une base .base via le bridge REST.";

export async function registerBasesGetSchemaTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService | undefined,
  localBasesService?: LocalBasesService,
): Promise<void> {
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterBasesGetSchemaTool",
      toolName: TOOL_NAME,
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        TOOL_NAME,
        TOOL_DESCRIPTION,
        BasesGetSchemaInputSchema.shape,
        READ_ONLY_TOOL_ANNOTATIONS,
        async (params: BasesGetSchemaInput) => {
          const handlerContext = requestContextService.createRequestContext({
            parentContext: registrationContext,
            operation: "HandleBasesGetSchema",
            toolName: TOOL_NAME,
            params,
          });

          const result = await processBasesGetSchema(
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
      operation: "registerBasesGetSchemaTool",
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
