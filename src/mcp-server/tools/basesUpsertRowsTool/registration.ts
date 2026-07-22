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
  BasesUpsertRowsInput,
  BasesUpsertRowsInputSchema,
  processBasesUpsertRows,
} from "./logic.js";

const TOOL_NAME = "bases_upsert_rows";
const TOOL_DESCRIPTION =
  "Met à jour les propriétés de notes issues d'une base via le bridge REST (set/unset + mtime).";

export async function registerBasesUpsertRowsTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterBasesUpsertRowsTool",
      toolName: TOOL_NAME,
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        TOOL_NAME,
        TOOL_DESCRIPTION,
        BasesUpsertRowsInputSchema.shape,
        MUTATING_TOOL_ANNOTATIONS,
        async (params: BasesUpsertRowsInput) => {
          const handlerContext = requestContextService.createRequestContext({
            parentContext: registrationContext,
            operation: "HandleBasesUpsertRows",
            toolName: TOOL_NAME,
            params: {
              base_id: params.base_id,
              operations: params.operations.length,
              continueOnError: params.continueOnError,
            },
          });

          const result = await processBasesUpsertRows(
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
      operation: "registerBasesUpsertRowsTool",
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
