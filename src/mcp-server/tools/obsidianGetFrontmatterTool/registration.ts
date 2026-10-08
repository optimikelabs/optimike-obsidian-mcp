import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { requestContextService, ErrorHandler } from "../../../utils/index.js";
import { processObsidianManageFrontmatter } from "../obsidianManageFrontmatterTool/logic.js";

const Input = z.object({
  filePath: z.string().min(1).describe("Vault-relative path of the note."),
  key: z.string().min(1).describe("Raw frontmatter key to read."),
}).strict();

export function registerObsidianGetFrontmatterTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): void {
  server.registerTool("obsidian_get_frontmatter", {
    description: "Read one frontmatter key through Local REST. Read-only: no set/delete/value inputs and no note mutation. Use obsidian_frontmatter_patch_plan/apply/status for edits; obsidian_read_note remains the complete-note read path.",
    inputSchema: mcpSchema(Input),
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }, async (params) => {
    const context = requestContextService.createRequestContext({
      operation: "ReadObsidianFrontmatter", toolName: "obsidian_get_frontmatter",
    });
    return ErrorHandler.tryCatch(async () => {
      const parsed = Input.parse(params);
      const response = await processObsidianManageFrontmatter(
        { ...parsed, operation: "get" }, context, obsidianService, undefined,
      );
      return { content: [{ type: "text", text: JSON.stringify(response) }], isError: false };
    }, { operation: "read frontmatter key", context });
  });
}
