import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import {
  GovernedFrontmatterRuntime,
  type GovernedFrontmatterPlanInput,
} from "../../../services/frontmatterProjectionRuntime.js";
import type { FrontmatterJsonValue } from "../../../services/frontmatterPatchCompiler.js";
import type { GovernedNoteReplaceRuntime } from "../governedNoteReplaceTools/runtime.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";

const JsonValueSchema: z.ZodType<FrontmatterJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(262_144),
    z.array(JsonValueSchema).max(256),
    z
      .record(JsonValueSchema)
      .refine(
        (value) => Object.keys(value).length <= 256,
        "Frontmatter objects support at most 256 keys.",
      ),
  ]),
);

const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    key: z.string().min(1).max(256),
    value: JsonValueSchema,
  }),
  z.object({
    op: z.literal("delete"),
    key: z.string().min(1).max(256),
  }),
]);

const PlanSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe("Vault-relative path of one existing Markdown note."),
  operations: z
    .array(OperationSchema)
    .min(1)
    .max(64)
    .describe(
      "Bounded top-level set/delete intentions. Each key may appear at most once; unsupported YAML fails closed.",
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("Caller-owned key binding one canonical frontmatter intent."),
});

const ApplySchema = z.object({
  planRef: z
    .string()
    .min(1)
    .describe("Opaque reference returned by obsidian_frontmatter_patch_plan."),
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
    .describe("Opaque reference returned by obsidian_frontmatter_patch_plan."),
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

export async function registerGovernedFrontmatterTools(
  server: McpServer,
  noteRuntime: GovernedNoteReplaceRuntime | undefined,
): Promise<void> {
  if (!noteRuntime) return;
  const runtime = new GovernedFrontmatterRuntime(noteRuntime);

  server.tool(
    "obsidian_frontmatter_patch_plan",
    "Plan a source-preserving patch of top-level frontmatter keys in one existing Markdown note. The compiler changes only authorized source ranges, then seals the complete next note through the existing atomic note runtime. It performs no note write and returns an opaque planRef.",
    PlanSchema.shape,
    GOVERNED_PLAN_TOOL_ANNOTATIONS,
    async (params: GovernedFrontmatterPlanInput) =>
      runTool("obsidian_frontmatter_patch_plan", params, () =>
        runtime.plan(params),
      ),
  );

  server.tool(
    "obsidian_frontmatter_patch_apply",
    "Apply only the exact sealed frontmatter plan. The target, operations, compiled Markdown, hashes, and projection proof cannot be replaced after planning. After a lost response call status, not a new mutation.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_frontmatter_patch_apply", params, () =>
        runtime.apply(params.planRef, params.idempotencyKey),
      ),
  );

  server.tool(
    "obsidian_frontmatter_patch_status",
    "Read and reconcile the durable status of one governed frontmatter plan without executing a new mutation.",
    StatusSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof StatusSchema>) =>
      runTool("obsidian_frontmatter_patch_status", params, () =>
        runtime.status(params.planRef),
      ),
  );

  server.tool(
    "obsidian_frontmatter_patch_recover",
    "Recover the exact same sealed frontmatter plan after an uncertain outcome. Recovery inherits P0 fencing and reconciliation; it is not undo and accepts no new patch intent.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_frontmatter_patch_recover", params, () =>
        runtime.recover(params.planRef, params.idempotencyKey),
      ),
  );
}
