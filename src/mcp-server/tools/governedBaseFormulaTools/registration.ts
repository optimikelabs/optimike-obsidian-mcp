import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  GovernedBaseFormulaPlanInput,
  GovernedBaseFormulaRuntime,
} from "../../../services/baseFormulaProjectionRuntime.js";
import { McpError } from "../../../types-global/errors.js";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";

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

export async function registerGovernedBaseFormulaTools(
  server: McpServer,
  runtime: GovernedBaseFormulaRuntime | undefined,
): Promise<void> {
  if (!runtime) return;
  server.tool(
    "bases_formula_patch_plan",
    "Plan a source-preserving set/delete patch of named formulas in one existing Obsidian Base. The complete next YAML, backend binding, hashes, and byte-preservation proof are sealed without writing.",
    PlanSchema.shape,
    GOVERNED_PLAN_TOOL_ANNOTATIONS,
    async (params: GovernedBaseFormulaPlanInput) =>
      runTool(() => runtime.plan(params)),
  );
  server.tool(
    "bases_formula_patch_apply",
    "Apply only the exact sealed Base formula plan through the Bases Bridge atomic CAS. No target, formula, expression, or compiled YAML can change after planning.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool(() => runtime.apply(params.planRef, params.idempotencyKey)),
  );
  server.tool(
    "bases_formula_patch_status",
    "Read and reconcile the durable status of one governed Base formula plan without starting a new mutation.",
    StatusSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof StatusSchema>) =>
      runTool(() => runtime.status(params.planRef)),
  );
  server.tool(
    "bases_formula_patch_recover",
    "Recover the exact sealed Base formula plan after an uncertain outcome. Recovery is not undo and accepts no new formula intent.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool(() => runtime.recover(params.planRef, params.idempotencyKey)),
  );
}
