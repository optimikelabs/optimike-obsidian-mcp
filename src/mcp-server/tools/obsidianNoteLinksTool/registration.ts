import { McpServer } from "@modelcontextprotocol/server";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
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
  obsidianService: ObsidianRestApiService,
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
            "Observe the bounded semantic neighborhood of one Markdown note from Obsidian Desktop public MetadataCache APIs. Returns outgoing links, embeds and frontmatter links with actual resolution; requested subpaths with honest anchor validation; unresolved aggregates; resolved backlinks; truncation; provenance; and cache-freshness limits. Read-only and no graph-preservation claim.",
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
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(response, null, 2) },
            ],
            isError: false,
          };
        },
      );
      logger.info(
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
