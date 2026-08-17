import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import type {
  GovernedCanvasPlanInput,
  GovernedCanvasRuntime,
} from "../../../services/canvasProjectionRuntime.js";
import { McpError } from "../../../types-global/errors.js";

const Id = z.string().min(1).max(256);
const Side = z.enum(["top", "right", "bottom", "left"]);
const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_text_node"),
    id: Id,
    text: z.string().max(1_048_576),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    color: z.string().min(1).max(64).optional(),
  }),
  z.object({
    op: z.literal("set_text"),
    id: Id,
    text: z.string().max(1_048_576),
  }),
  z.object({
    op: z.literal("move_node"),
    id: Id,
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
  }),
  z.object({ op: z.literal("delete_node"), id: Id }),
  z.object({
    op: z.literal("connect_nodes"),
    id: Id,
    fromNode: Id,
    toNode: Id,
    fromSide: Side.optional(),
    toSide: Side.optional(),
    label: z.string().max(1024).optional(),
    color: z.string().min(1).max(64).optional(),
  }),
  z.object({ op: z.literal("delete_edge"), id: Id }),
]);

const PlanSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe("Vault-relative path of one existing .canvas file."),
  operations: z
    .array(OperationSchema)
    .min(1)
    .max(64)
    .describe(
      "Ordered graph intentions. One node or edge ID may be targeted at most once; deleting a node also seals deletion of its incident edges.",
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("Caller-owned key binding one canonical Canvas intent."),
});

const ApplySchema = z.object({
  planRef: z
    .string()
    .min(1)
    .describe("Opaque reference returned by obsidian_canvas_patch_plan."),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("The exact public idempotency key bound during planning."),
});

const StatusSchema = z.object({
  planRef: z
    .string()
    .min(1)
    .describe("Opaque reference returned by obsidian_canvas_patch_plan."),
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
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await operation(), null, 2),
        },
      ],
      isError: false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(errorPayload(error), null, 2),
        },
      ],
      isError: true,
    };
  }
}

export async function registerGovernedCanvasTools(
  server: McpServer,
  runtime: GovernedCanvasRuntime | undefined,
): Promise<void> {
  if (!runtime) return;
  server.tool(
    "obsidian_canvas_patch_plan",
    "Plan a governed mutation of one existing JSON Canvas graph. It preserves unknown root/entity values, validates node and edge identity/references, compiles only the sealed entity changes, and performs no write.",
    PlanSchema.shape,
    GOVERNED_PLAN_TOOL_ANNOTATIONS,
    async (params: GovernedCanvasPlanInput) =>
      runTool(() => runtime.plan(params)),
  );
  server.tool(
    "obsidian_canvas_patch_apply",
    "Apply only the exact sealed Canvas plan through the Atomic Write Bridge with a vault binding and SHA-256 CAS. After a lost response call status, not a new mutation.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool(() => runtime.apply(params.planRef, params.idempotencyKey)),
  );
  server.tool(
    "obsidian_canvas_patch_status",
    "Read and reconcile the durable status of one governed Canvas plan without executing a new mutation.",
    StatusSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof StatusSchema>) =>
      runTool(() => runtime.status(params.planRef)),
  );
  server.tool(
    "obsidian_canvas_patch_recover",
    "Recover the exact same sealed Canvas plan after an uncertain outcome. It accepts no new graph intent and is not undo.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool(() => runtime.recover(params.planRef, params.idempotencyKey)),
  );
}
