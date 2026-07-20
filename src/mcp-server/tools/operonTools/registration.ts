import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OperonQuerySchema } from "../../../services/operon/contract.js";
import { OperonService } from "../../../services/operon/service.js";
import { McpError } from "../../../types-global/errors.js";

const ForceRefreshSchema = z.object({
  forceRefresh: z.boolean().optional().default(false),
});

const GetTaskSchema = z.object({
  operonId: z.string().min(1),
  includeProperties: z.boolean().optional().default(false),
  forceRefresh: z.boolean().optional().default(false),
});

function errorPayload(error: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: error instanceof McpError ? error.code : "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof McpError ? error.details : undefined,
    },
  };
}

async function runTool(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(errorPayload(error), null, 2) }],
      isError: true,
    };
  }
}

export async function registerOperonTools(server: McpServer): Promise<void> {
  const service = new OperonService();

  server.tool(
    "operon_status",
    "Inspect the live Optimike Operon Bridge and the persisted MCP snapshot. forceRefresh=true rebuilds the snapshot only when Obsidian Desktop, Local REST API, Operon, and the Bridge are available. This surface is read-only.",
    ForceRefreshSchema.shape,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool(() => service.status(params.forceRefresh)),
  );

  server.tool(
    "operon_list_tasks",
    "List Operon tasks from a live-generation-validated snapshot or an explicitly stale persisted fallback. Supports pagination and optional filters. No task mutation is performed.",
    OperonQuerySchema.shape,
    async (params: z.infer<typeof OperonQuerySchema>) =>
      runTool(() => service.query(params)),
  );

  server.tool(
    "operon_query_tasks",
    "Query Operon tasks by identity, text, source, checkbox, workflow, priority, tier, path, tags, parent, dates, canonical/custom fields, or unmanaged file-task properties. Responses always declare source and freshness.",
    OperonQuerySchema.shape,
    async (params: z.infer<typeof OperonQuerySchema>) =>
      runTool(() => service.query(params)),
  );

  server.tool(
    "operon_get_task",
    "Read one Operon task by stable operonId from the live-generation-validated snapshot or the last persisted stale fallback.",
    GetTaskSchema.shape,
    async (params: z.infer<typeof GetTaskSchema>) =>
      runTool(() => service.getTask(params)),
  );

  server.tool(
    "operon_validate",
    "Validate the live Operon duplicate/source/workflow graph when available, otherwise run a limited snapshot-only validation and state its limitations.",
    ForceRefreshSchema.shape,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool(() => service.validate(params.forceRefresh)),
  );
}
