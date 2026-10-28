import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import type {
  GovernedBaseConfigPlanInput,
  GovernedBaseConfigRuntime,
} from "../../../services/baseConfigProjectionRuntime.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

const Name = z.string().min(1).max(256);
const Json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(Json)]),
);
const Filter: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z.object({ and: z.array(Filter).min(1) }).strict(),
    z.object({ or: z.array(Filter).min(1) }).strict(),
    z.object({ not: z.array(Filter).min(1) }).strict(),
  ]),
).describe('A filter statement such as \'file.hasTag("book")\', or {and|or|not: [filters]}.');

const OperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_filters"), filters: Filter }).describe("Replace the global filters (combined with each view's filters by AND)."),
  z.object({ op: z.literal("delete_filters") }),
  z.object({ op: z.literal("set_formula"), name: Name, expression: z.string().min(1).max(65_536) }),
  z.object({ op: z.literal("delete_formula"), name: Name }),
  z.object({ op: z.literal("set_property"), property: Name, key: Name, value: Json })
    .describe("Set one setting of a property, e.g. property 'formula.price', key 'displayName'."),
  z.object({ op: z.literal("delete_property"), property: Name, key: Name.optional() })
    .describe("Remove one property setting, or the whole property entry when key is omitted."),
  z.object({ op: z.literal("set_summary"), name: Name, formula: z.string().min(1).max(65_536) })
    .describe("Custom summary formula using values, e.g. 'values.mean().round(3)'."),
  z.object({ op: z.literal("delete_summary"), name: Name }),
  z.object({ op: z.literal("add_view"), view: z.record(Json), position: z.number().int().min(0).optional(), pluginViewType: z.boolean().optional() })
    .describe("Add a view object with at least type and a unique name; optional 0-based position."),
  z.object({ op: z.literal("delete_view"), view: Name }),
  z.object({ op: z.literal("move_view"), view: Name, position: z.number().int().min(0) }),
  z.object({ op: z.literal("set_view_key"), view: Name, key: Name, value: Json, pluginViewType: z.boolean().optional() })
    .describe("Set any key of the named view: name (rename), type, filters, order, sort, groupBy, groupOrder, summaries, limit, or a view/plugin key."),
  z.object({ op: z.literal("delete_view_key"), view: Name, key: Name }),
]);

const PlanSchema = z.object({
  path: z.string().min(1).max(1024).describe("Vault-relative path of one existing .base file."),
  operations: z.array(OperationSchema).min(1).max(64).describe("Ordered edits; views are selected by their exact unique name."),
  idempotencyKey: z.string().min(1).max(256),
});
const ApplySchema = z.object({ planRef: z.string().min(1), idempotencyKey: z.string().min(1).max(256) });
const StatusSchema = z.object({ planRef: z.string().min(1) });

async function runTool(toolName: string, params: unknown, operation: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }], isError: false };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(publicMcpToolErrorPayload(error, { operation: toolName, toolName, params }), null, 2) }],
      isError: true,
    };
  }
}

export function registerGovernedBaseConfigTools(server: McpServer, runtime: GovernedBaseConfigRuntime | undefined): void {
  if (!runtime) return;
  server.registerTool("bases_config_patch_plan", {
    description:
      "Plan an edit of a whole existing Obsidian Base: global filters, formulas, property settings (displayName...), summaries and views (add, delete, move, rename, type, filters, order, sort, groupBy, groupOrder, summaries, limit, any view or plugin key). Untouched values are kept and comments survive (the proof counts any dropped with a deleted entry); the result must be a valid Base. Built-in view types are table, cards, list and map; set pluginViewType: true for a plugin type such as kanban. Seals the exact next YAML and hashes without writing.",
    inputSchema: mcpSchema(PlanSchema.shape),
    annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
  }, (params) => runTool("bases_config_patch_plan", params, () => runtime.plan(PlanSchema.parse(params) as GovernedBaseConfigPlanInput)));
  server.registerTool("bases_config_patch_apply", {
    description: "Apply only the exact sealed Base configuration plan through the Bases Bridge atomic CAS. Nothing can change after planning.",
    inputSchema: mcpSchema(ApplySchema.shape),
    annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  }, (params) => runTool("bases_config_patch_apply", params, () => {
    const p = ApplySchema.parse(params);
    return runtime.apply(p.planRef, p.idempotencyKey);
  }));
  server.registerTool("bases_config_patch_status", {
    description: "Read and reconcile the durable status of one governed Base configuration plan without starting a new mutation.",
    inputSchema: mcpSchema(StatusSchema.shape),
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }, (params) => runTool("bases_config_patch_status", params, () => runtime.status(StatusSchema.parse(params).planRef)));
  server.registerTool("bases_config_patch_recover", {
    description: "Recover the exact sealed Base configuration plan after an uncertain outcome. Recovery is not undo and accepts no new intent.",
    inputSchema: mcpSchema(ApplySchema.shape),
    annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  }, (params) => runTool("bases_config_patch_recover", params, () => {
    const p = ApplySchema.parse(params);
    return runtime.recover(p.planRef, p.idempotencyKey);
  }));
}
