import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import type {
  GovernedCanvasPlanInput,
  GovernedCanvasRuntime,
} from "../../../services/canvasProjectionRuntime.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import { mcpSchema } from "../../mcpSchema.js";

const Id = z.string().min(1).max(256);
const Side = z.enum(["top", "right", "bottom", "left"]);
const End = z.enum(["none", "arrow"]);
const Color = z.string().min(1).max(64).describe('Canvas preset "1"-"6" or a hex color such as "#ff8800".');
const NodeFields = z.object({
  color: Color.nullable().optional(),
  text: z.string().max(1_048_576).nullable().optional(),
  file: z.string().min(1).max(1024).nullable().optional(),
  subpath: z.string().min(2).max(1024).nullable().optional(),
  url: z.string().min(1).max(4096).nullable().optional(),
  label: z.string().max(1024).nullable().optional(),
  background: z.string().min(1).max(1024).nullable().optional(),
  backgroundStyle: z.enum(["cover", "ratio", "repeat"]).nullable().optional(),
}).strict();
const EdgeFields = z.object({
  label: z.string().max(1024).nullable().optional(),
  color: Color.nullable().optional(),
  fromSide: Side.nullable().optional(),
  toSide: Side.nullable().optional(),
  fromEnd: End.nullable().optional(),
  toEnd: End.nullable().optional(),
  fromNode: Id.optional(),
  toNode: Id.optional(),
}).strict();
const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_text_node"),
    id: Id,
    text: z.string().max(1_048_576),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
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
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
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
    fromEnd: End.optional(),
    toEnd: End.optional(),
  }),
  z.object({ op: z.literal("delete_edge"), id: Id }),
  z.object({
    op: z.literal("add_node"),
    id: Id,
    type: z.enum(["text", "file", "link", "group"]),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    text: z.string().max(1_048_576).optional().describe("text nodes only"),
    file: z.string().min(1).max(1024).optional().describe("file nodes only: vault-relative path"),
    subpath: z.string().min(2).max(1024).optional().describe("file nodes only: #heading or #^block"),
    url: z.string().min(1).max(4096).optional().describe("link nodes only"),
    label: z.string().max(1024).optional().describe("group nodes only"),
    background: z.string().min(1).max(1024).optional().describe("group nodes only: image path"),
    backgroundStyle: z.enum(["cover", "ratio", "repeat"]).optional().describe("group nodes only"),
    color: Color.optional(),
  }).describe("Add one node of any JSON Canvas type with only the fields of that type."),
  z.object({
    op: z.literal("set_node_fields"),
    id: Id,
    fields: NodeFields.describe("Set fields of the node's own type; null removes an optional field. Geometry uses move_node; id and type never change."),
  }),
  z.object({
    op: z.literal("update_edge"),
    id: Id,
    fields: EdgeFields.describe("Set edge fields; null removes label, color, sides or ends. fromNode/toNode re-target to existing nodes."),
  }),
]);

const PlanSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.trim() === value, "path must not be padded")
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

async function runTool(
  toolName: string,
  params: unknown,
  operation: () => Promise<unknown>,
) {
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
          text: JSON.stringify(
            publicMcpToolErrorPayload(error, {
              operation: toolName,
              toolName,
              params,
            }),
            null,
            2,
          ),
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
  server.registerTool(
    "obsidian_canvas_patch_plan",
    {
      description:
        "Plan a governed mutation of one existing JSON Canvas graph. It preserves unknown root/entity values, validates node and edge identity/references, compiles only the sealed entity changes, and performs no write.",
      inputSchema: mcpSchema(PlanSchema.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    async (params: GovernedCanvasPlanInput) =>
      runTool("obsidian_canvas_patch_plan", params, () => runtime.plan(params)),
  );
  server.registerTool(
    "obsidian_canvas_patch_apply",
    {
      description:
        "Apply only the exact sealed Canvas plan through the Atomic Write Bridge with a vault binding and SHA-256 CAS. After a lost response call status, not a new mutation.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_canvas_patch_apply", params, () =>
        runtime.apply(params.planRef, params.idempotencyKey),
      ),
  );
  server.registerTool(
    "obsidian_canvas_patch_status",
    {
      description:
        "Read and reconcile the durable status of one governed Canvas plan without executing a new mutation.",
      inputSchema: mcpSchema(StatusSchema.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof StatusSchema>) =>
      runTool("obsidian_canvas_patch_status", params, () =>
        runtime.status(params.planRef),
      ),
  );
  server.registerTool(
    "obsidian_canvas_patch_recover",
    {
      description:
        "Recover the exact same sealed Canvas plan after an uncertain outcome. It accepts no new graph intent and is not undo.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_canvas_patch_recover", params, () =>
        runtime.recover(params.planRef, params.idempotencyKey),
      ),
  );
}
