import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import { readMarkdownFrontmatter } from "../../../services/readMarkdownFrontmatter.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { requestContextService, ErrorHandler, type RequestContext } from "../../../utils/index.js";
import { frontmatterKeyResponse, processObsidianManageFrontmatter } from "../obsidianManageFrontmatterTool/logic.js";

const Input = z.object({
  filePath: z.string().min(1).describe("Vault-relative path of the note."),
  key: z.string().min(1).describe("Raw frontmatter key to read."),
}).strict();

async function readCachedKey(
  input: z.infer<typeof Input>, context: RequestContext, vaultCache?: VaultCacheService,
) {
  if (!vaultCache) {
    throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Shared filesystem cache is unavailable.", context);
  }
  const content = await vaultCache.readFilesystemNoteContent(input.filePath, context);
  return {
    ...frontmatterKeyResponse(readMarkdownFrontmatter(content).frontmatter, input.key),
    provenance: { source: "filesystem" },
  };
}

export function registerObsidianGetFrontmatterTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService | undefined,
  vaultCache?: VaultCacheService,
): void {
  server.registerTool("obsidian_get_frontmatter", {
    description: "Read one frontmatter key through Local REST or the shared filesystem cache in headless mode. Read-only: no set/delete/value inputs and no note mutation. Use obsidian_frontmatter_patch_plan/apply/status for edits; obsidian_read_note is the complete-note read path.",
    inputSchema: mcpSchema(Input),
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }, async (params) => {
    const context = requestContextService.createRequestContext({
      operation: "ReadObsidianFrontmatter", toolName: "obsidian_get_frontmatter",
    });
    return ErrorHandler.tryCatch(async () => {
      const parsed = Input.parse(params);
      const response = obsidianService
        ? await processObsidianManageFrontmatter({ ...parsed, operation: "get" }, context, obsidianService, undefined)
        : await readCachedKey(parsed, context, vaultCache);
      return { content: [{ type: "text", text: JSON.stringify(response) }], isError: false };
    }, { operation: "read frontmatter key", context });
  });
}
