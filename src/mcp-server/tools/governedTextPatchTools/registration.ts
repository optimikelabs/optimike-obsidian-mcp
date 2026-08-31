import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import {
  GovernedTextPatchRuntime,
  type GovernedTextPatchPlanInput,
} from "../../../services/textPatchProjectionRuntime.js";
import type { GovernedNoteReplaceRuntime } from "../governedNoteReplaceTools/runtime.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";

const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("append_body"),
    text: z.string().min(1).max(262_144),
  }),
  z.object({
    op: z.literal("prepend_body"),
    text: z.string().min(1).max(262_144),
  }),
  z.object({
    op: z.literal("replace_literal"),
    search: z.string().min(1).max(262_144),
    replacement: z.string().max(262_144),
    occurrence: z.enum(["unique", "all"]).optional(),
    intent: z.literal("replace_all").optional(),
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
    .max(32)
    .describe(
      "Ordered body-only append_body, prepend_body, or replace_literal intentions. All-occurrence replacement needs occurrence=all and intent=replace_all. Literal values are sealed privately and never returned.",
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("Caller-owned key binding one canonical text patch intent."),
});

const ApplySchema = z.object({
  planRef: z
    .string()
    .min(1)
    .describe("Opaque reference returned by obsidian_text_patch_plan."),
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
    .describe("Opaque reference returned by obsidian_text_patch_plan."),
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

export async function registerGovernedTextPatchTools(
  server: McpServer,
  noteRuntime: GovernedNoteReplaceRuntime | undefined,
): Promise<void> {
  if (!noteRuntime) return;
  const runtime = new GovernedTextPatchRuntime(noteRuntime);

  server.tool(
    "obsidian_text_patch_plan",
    "Plan one bounded body-only text patch of an existing Markdown note. The sealed plan preserves the complete note outside its authorized body ranges, binds the current before proof and vault identity, and returns only opaque proof metadata; it never writes the note.",
    PlanSchema.shape,
    GOVERNED_PLAN_TOOL_ANNOTATIONS,
    async (params: GovernedTextPatchPlanInput) =>
      runTool("obsidian_text_patch_plan", params, () => runtime.plan(params)),
  );

  server.tool(
    "obsidian_text_patch_apply",
    "Apply only the exact sealed text patch. Pass planRef and its matching idempotencyKey; no target, text, operation, or hash can be replaced after planning. After a lost response, call status before any recovery.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_text_patch_apply", params, () =>
        runtime.apply(params.planRef, params.idempotencyKey),
      ),
  );

  server.tool(
    "obsidian_text_patch_status",
    "Read and reconcile the durable status of one governed text patch without executing a mutation. The response never includes its idempotency key or sealed text.",
    StatusSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof StatusSchema>) =>
      runTool("obsidian_text_patch_status", params, () =>
        runtime.status(params.planRef),
      ),
  );

  server.tool(
    "obsidian_text_patch_recover",
    "Recover the exact same sealed text patch after an uncertain outcome. Recovery is not undo and accepts no new patch intent; it reconciles the existing plan under its original fencing.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_text_patch_recover", params, () =>
        runtime.recover(params.planRef, params.idempotencyKey),
      ),
  );
}
