import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  BaseRowsPatchRuntime,
  type BaseRowsPatchInput,
} from "../../../services/baseRowsPatchRuntime.js";
import { BaseRowTargetSchema } from "../../../services/baseRowSelection.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

// Canonical compiler performs depth/type/size/prototype validation before any admission.
const Operation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set"),
      key: z.string().min(1).max(256),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({ op: z.literal("delete"), key: z.string().min(1).max(256) })
    .strict(),
]);
const Plan = BaseRowTargetSchema.extend({
  operations: z
    .array(Operation)
    .min(1)
    .max(64)
    .describe(
      "Raw top-level frontmatter keys; not Base display names or file/formula properties.",
    ),
  idempotencyKey: z.string().min(1).max(256),
}).strict();
const Status = z.object({ planRef: z.string().min(1).max(128) }).strict();
const Apply = Status.extend({
  idempotencyKey: z.string().min(1).max(256),
}).strict();
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
export function registerBaseRowsPatchTools(
  server: McpServer,
  runtime: BaseRowsPatchRuntime | undefined,
) {
  if (!runtime) return;
  server.registerTool(
    "bases_rows_patch_plan",
    {
      description:
        "Seal a property patch for one exact existing Markdown row in an explicit Base/view. Uses a complete, warning-free supported-filter Bridge snapshot (max 500 rows, freshness unknown), not a native engine guarantee. No note write, creation or deletion. Reuses the durable note CAS journal.",
      inputSchema: mcpSchema(Plan.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("bases_rows_patch_plan", () =>
        runtime.plan(Plan.parse(params) as BaseRowsPatchInput),
      ),
  );
  server.registerTool(
    "bases_rows_patch_apply",
    {
      description:
        "Revalidate the sealed Base and selected path, then apply one note-content CAS. Top-level set/delete only. No Base write or multi-file transaction. Unknown or completed attempts are observed, never blindly replayed; no synthetic recovery.",
      inputSchema: mcpSchema(Apply.shape),
      annotations: {
        ...GOVERNED_MUTATION_TOOL_ANNOTATIONS,
        destructiveHint: false,
      },
    },
    (params) =>
      run("bases_rows_patch_apply", () => {
        const p = Apply.parse(params);
        return runtime.apply(p.planRef, p.idempotencyKey);
      }),
  );
  server.registerTool(
    "bases_rows_patch_status",
    {
      description:
        "Observe/reconcile the durable row patch without changing any note. Reports note postflight, not continued view membership; a patched row may legitimately leave the view. Does not expose internal child recovery or private idempotency keys.",
      inputSchema: mcpSchema(Status.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("bases_rows_patch_status", () =>
        runtime.status(Status.parse(params).planRef),
      ),
  );
}
