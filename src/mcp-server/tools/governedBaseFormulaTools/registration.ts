import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  GovernedBaseFormulaPlanInput,
  GovernedBaseFormulaRuntime,
} from "../../../services/baseFormulaProjectionRuntime.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_formula"),
    name: z.string().min(1).max(256),
    expression: z.string().min(1).max(65_536),
  }),
  z.object({
    op: z.literal("delete_formula"),
    name: z.string().min(1).max(256),
  }),
]);

const PlanSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe("Vault-relative path of one existing .base file."),
  operations: z.array(OperationSchema).min(1).max(32),
  idempotencyKey: z.string().min(1).max(256),
});

const ApplySchema = z.object({
  planRef: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
});

const StatusSchema = z.object({ planRef: z.string().min(1) });

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

export async function registerGovernedBaseFormulaTools(
  server: McpServer,
  runtime: GovernedBaseFormulaRuntime | undefined,
): Promise<void> {
  if (!runtime) return;
  server.registerTool(
    "bases_formula_patch_plan",
    {
      description:
        "Plan a source-preserving set/delete patch of named formulas in one existing Obsidian Base. The complete next YAML, backend binding, hashes, and byte-preservation proof are sealed without writing.",
      inputSchema: mcpSchema(PlanSchema.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    async (params: GovernedBaseFormulaPlanInput) =>
      runTool("bases_formula_patch_plan", params, () => runtime.plan(params)),
  );
  server.registerTool(
    "bases_formula_patch_apply",
    {
      description:
        "Apply only the exact sealed Base formula plan through the Bases Bridge atomic CAS. No target, formula, expression, or compiled YAML can change after planning.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("bases_formula_patch_apply", params, () =>
        runtime.apply(params.planRef, params.idempotencyKey),
      ),
  );
  server.registerTool(
    "bases_formula_patch_status",
    {
      description:
        "Read and reconcile the durable status of one governed Base formula plan without starting a new mutation.",
      inputSchema: mcpSchema(StatusSchema.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof StatusSchema>) =>
      runTool("bases_formula_patch_status", params, () =>
        runtime.status(params.planRef),
      ),
  );
  server.registerTool(
    "bases_formula_patch_recover",
    {
      description:
        "Recover the exact sealed Base formula plan after an uncertain outcome. Recovery is not undo and accepts no new formula intent.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("bases_formula_patch_recover", params, () =>
        runtime.recover(params.planRef, params.idempotencyKey),
      ),
  );
}
