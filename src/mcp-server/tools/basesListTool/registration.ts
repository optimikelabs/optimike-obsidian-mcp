/**
 * @fileoverview Registers the `bases_list` MCP tool.
 */

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
  BasesListInput,
  BasesListInputSchema,
  processBasesList,
} from "./logic.js";

const TOOL_NAME = "bases_list";
const TOOL_DESCRIPTION =
  "Liste les Bases (.base) disponibles via le bridge REST."
  + " Utilise l'extension obsidian-bases-bridge du plugin Local REST API.";

export async function registerBasesListTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService | undefined,
  localBasesService?: LocalBasesService,
): Promise<void> {
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterBasesListTool",
      toolName: TOOL_NAME,
    });

  await ErrorHandler.tryCatch(
    async () => {
      logger.info(`Enregistrement du tool ${TOOL_NAME}`, registrationContext);
      server.tool(
        TOOL_NAME,
        TOOL_DESCRIPTION,
        BasesListInputSchema.shape,
        READ_ONLY_TOOL_ANNOTATIONS,
        async (_params: BasesListInput) => {
          const handlerContext = requestContextService.createRequestContext({
            parentContext: registrationContext,
            operation: "HandleBasesList",
            toolName: TOOL_NAME,
          });

          const result = await processBasesList(
            {},
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
      operation: "registerBasesListTool",
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Échec de l'enregistrement du tool ${TOOL_NAME}: ${
            error instanceof Error ? error.message : "Erreur inconnue"
          }`,
          registrationContext,
        ),
      critical: true,
    },
  );
}
