import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { NativeNoteMoveOperationAdapter } from "../../../services/operations/nativeNoteMoveOperationAdapter.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

const Plan = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .max(1024)
      .describe("Exact vault-relative Markdown source path."),
    destinationPath: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Exact absent Markdown destination; its parent must already exist.",
      ),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();
const Apply = z
  .object({
    planRef: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();
const Status = z.object({ planRef: z.string().min(1).max(128) }).strict();
async function run(toolName: string, operation: () => Promise<unknown>) {
  try {
    return {
      isError: false,
      content: [
        { type: "text" as const, text: JSON.stringify(await operation()) },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            publicMcpToolErrorPayload(error, {
              operation: toolName,
              toolName,
              params: {},
            }),
          ),
        },
      ],
    };
  }
}
export function registerNativeNoteMoveTools(
  server: McpServer,
  runtime: NativeNoteMoveOperationAdapter | undefined,
): void {
  if (!runtime) return;
  server.registerTool(
    "obsidian_note_move_plan",
    {
      description:
        "Seal one native Markdown move and its bounded observed semantic neighborhood without moving a note. Requires MCP_WRITE_MODE=full and the independent native-move Bridge grant. No global graph transaction or source-content CAS. Unknown/truncated neighborhoods are refused; graph effects outside the sealed neighborhood are not certified.",
      inputSchema: mcpSchema(Plan.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_move_plan", () => runtime.plan(Plan.parse(params))),
  );
  server.registerTool(
    "obsidian_note_move_apply",
    {
      description:
        "Dispatch only the exact sealed native rename once. Native completion does not mean graph verification. Inspect graph_postflight with status after a lost reply; never manufacture a new move request to retry an uncertain effect.",
      inputSchema: mcpSchema(Apply.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_move_apply", () => {
        const p = Apply.parse(params);
        return runtime.apply(p.planRef, p.idempotencyKey);
      }),
  );
  server.registerTool(
    "obsidian_note_move_status",
    {
      description:
        "Read/reconcile the durable move outcome and separately observe graph_postflight without executing a rename. Backend restart can leave an unacknowledged move indeterminate; no recover/undo tool exists for this V1.",
      inputSchema: mcpSchema(Status.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_move_status", () =>
        runtime.status(Status.parse(params).planRef),
      ),
  );
}
