import { McpServer } from "@modelcontextprotocol/server";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
  type RequestContext,
} from "../../../utils/index.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import {
  ObsidianNoteLinksInputSchema,
  processObsidianNoteLinks,
  type ObsidianNoteLinksInput,
} from "./logic.js";
import { mcpSchema } from "../../mcpSchema.js";

export async function registerObsidianNoteLinksTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService | undefined,
  vaultCache?: VaultCacheService,
): Promise<void> {
  const toolName = "obsidian_note_links";
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianNoteLinksTool",
      toolName,
      module: "ObsidianNoteLinksRegistration",
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.registerTool(
        toolName,
        {
          description:
            "Read outgoing links, embeds, frontmatter links, unresolved counts, and backlinks for one Markdown note. Live uses Obsidian Desktop MetadataCache. Headless resolves Markdown destinations in the shared filesystem cache and reports requested anchor validation as unknown. Returns provenance, freshness limits, and independent result limits.",
          inputSchema: mcpSchema(ObsidianNoteLinksInputSchema.shape),
          annotations: READ_ONLY_TOOL_ANNOTATIONS,
        },
        async (params: ObsidianNoteLinksInput) => {
          const context = requestContextService.createRequestContext({
            parentContext: registrationContext,
            operation: "HandleObsidianNoteLinksRequest",
            toolName,
            params: { filePath: params.filePath, limit: params.limit },
          });
          const response = await processObsidianNoteLinks(
            params,
            context,
            obsidianService,
            vaultCache,
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(response, null, 2) },
            ],
            isError: false,
          };
        },
      );
      logger.debug(
        "Tool registered successfully: " + toolName,
        registrationContext,
      );
    },
    {
      operation: "registering tool " + toolName,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          "Failed to register tool '" + toolName + "'.",
          registrationContext,
        ),
      critical: true,
    },
  );
}
