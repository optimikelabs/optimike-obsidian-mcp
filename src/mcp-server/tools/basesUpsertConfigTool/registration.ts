import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  BasesUpsertConfigInput,
  BasesUpsertConfigInputSchema,
  processBasesUpsertConfig,
} from "./logic.js";

const TOOL_NAME = "bases_upsert_config";
const TOOL_DESCRIPTION =
  "Met à jour (ou valide) la configuration YAML/JSON d'une base via le bridge REST.";

export async function registerBasesUpsertConfigTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> {
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterBasesUpsertConfigTool",
      toolName: TOOL_NAME,
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        TOOL_NAME,
        TOOL_DESCRIPTION,
        BasesUpsertConfigInputSchema.shape,
        DESTRUCTIVE_TOOL_ANNOTATIONS,
        async (params: BasesUpsertConfigInput) => {
          const handlerContext = requestContextService.createRequestContext({
            parentContext: registrationContext,
            operation: "HandleBasesUpsertConfig",
            toolName: TOOL_NAME,
            params: {
              base_id: params.base_id,
              hasYaml: Boolean(params.yaml),
              hasJson: Boolean(params.json),
              validateOnly: params.validateOnly,
            },
          });

          const result = await processBasesUpsertConfig(
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
      operation: "registerBasesUpsertConfigTool",
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
