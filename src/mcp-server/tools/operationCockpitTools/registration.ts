import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OperationCockpit,
  OPERATION_COCKPIT_DEFAULT_LIMIT,
  OPERATION_COCKPIT_MAX_LIMIT,
  type PendingOperationSource,
} from "../../../services/operationCockpit.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";

const InputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(OPERATION_COCKPIT_MAX_LIMIT)
      .default(OPERATION_COCKPIT_DEFAULT_LIMIT)
      .describe("Maximum number of pending operations to return."),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,2048}$/u)
      .optional()
      .describe("Opaque cursor returned by the previous page."),
  })
  .strict();

export function registerOperationCockpitTool(
  server: McpServer,
  sources: readonly PendingOperationSource[],
): void {
  if (sources.length === 0) return;
  const cockpit = new OperationCockpit(sources);
  server.tool(
    "obsidian_list_pending_operations",
    "Lists redacted durable Note, Frontmatter, Base Formula, Canvas and Text Patch operations that still require apply, status or exact-plan recovery. It never returns note payloads, invokes a backend, changes a journal or performs recovery.",
    InputSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof InputSchema>) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            cockpit.list({ limit: params.limit, cursor: params.cursor }),
            null,
            2,
          ),
        },
      ],
      isError: false,
    }),
  );
}
