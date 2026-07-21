import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OperonAdoptTaskSchema,
  OperonConvertTaskSchema,
  OperonConvertTaskInputSchema,
  OperonCreateTaskSchema,
  OperonFilterQuerySchema,
  OperonRelocateTaskSchema,
  OperonQuerySchema,
  OperonTransitionTaskSchema,
  OperonTransitionTaskInputSchema,
  OperonUpdateTaskSchema,
} from "../../../services/operon/contract.js";
import { OperonService } from "../../../services/operon/service.js";
import { McpError } from "../../../types-global/errors.js";

const ForceRefreshSchema = z.object({
  forceRefresh: z.boolean().optional().default(false),
});

const GetTaskSchema = z.object({
  operonId: z.string().min(1),
  includeProperties: z.boolean().optional().default(false),
  forceRefresh: z.boolean().optional().default(false),
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_MUTATION_ANNOTATIONS = {
  ...MUTATION_ANNOTATIONS,
  destructiveHint: true,
} as const;

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
    const result = await operation();
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
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

export async function registerOperonTools(server: McpServer): Promise<void> {
  const service = new OperonService();

  server.tool(
    "operon_status",
    "Inspect the live Optimike Operon Bridge and the persisted MCP snapshot. forceRefresh=true rebuilds the snapshot only when Obsidian Desktop, Local REST API, Operon, and the Bridge are available. This surface is read-only.",
    ForceRefreshSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool(() => service.status(params.forceRefresh)),
  );

  server.tool(
    "operon_get_configuration",
    "Read the task-semantic Operon configuration from the live plugin runtime: language, stable workflow/status IDs, priority definitions, canonical-to-visible key mappings, creation targets/templates, task automations, excluded folders, documentation location, and saved filter catalog. Falls back only to an explicitly stale persisted snapshot.",
    ForceRefreshSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool(() => service.configuration(params.forceRefresh)),
  );

  server.tool(
    "operon_list_tasks",
    "List Operon tasks from a live-generation-validated snapshot or an explicitly stale persisted fallback. Supports pagination and optional filters. No task mutation is performed.",
    OperonQuerySchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonQuerySchema>) =>
      runTool(() => service.query(params)),
  );

  server.tool(
    "operon_query_tasks",
    "Query Operon tasks by identity, text, source, checkbox, stable workflow/status IDs, visible workflow labels, priority, tier, path, tags, parent, dates, canonical/custom fields, or unmanaged file-task properties. Prefer pipelineIds/statusIds from operon_get_configuration so UI language changes do not break automations. Responses always declare source and freshness.",
    OperonQuerySchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonQuerySchema>) =>
      runTool(() => service.query(params)),
  );

  server.tool(
    "operon_query_saved_filter",
    "Evaluate one saved Operon filter through Operon's native filter engine. Use filterSetId from operon_get_configuration; optional scopePath limits results to one note or folder. This capability is live-only because headless snapshots cannot reproduce plugin filter semantics.",
    OperonFilterQuerySchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonFilterQuerySchema>) =>
      runTool(() => service.querySavedFilter(params)),
  );

  server.tool(
    "operon_get_task",
    "Read one Operon task by stable operonId from the live-generation-validated snapshot or the last persisted stale fallback.",
    GetTaskSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof GetTaskSchema>) =>
      runTool(() => service.getTask(params)),
  );

  server.tool(
    "operon_validate",
    "Validate the live Operon duplicate/source/workflow graph when available, otherwise run a limited snapshot-only validation and state its limitations.",
    ForceRefreshSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool(() => service.validate(params.forceRefresh)),
  );

  server.tool(
    "operon_adopt_task",
    "Adopt one existing plain Markdown or Obsidian Tasks checkbox in place as an Operon inline task. Requires an exact one-based line and expectedLine precondition, plus idempotencyKey; dryRun defaults to true. The live Operon domain path preserves supported Tasks metadata and no raw Markdown fallback exists.",
    OperonAdoptTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonAdoptTaskSchema>) =>
      runTool(() => service.adoptTask(params)),
  );

  server.tool(
    "operon_create_task",
    "Create an Operon inline or file task through Operon Public API v1. dryRun defaults to true. Apply requires the live Bridge and an idempotencyKey; no raw Markdown fallback exists.",
    OperonCreateTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonCreateTaskSchema>) =>
      runTool(() => service.createTask(params)),
  );

  server.tool(
    "operon_update_task",
    "Update exactly one Operon mutation group through the full Operon domain path: description, managed fields/tags, or one unmanaged file property. expectedRevision and idempotencyKey are mandatory; dryRun defaults to true.",
    OperonUpdateTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonUpdateTaskSchema>) =>
      runTool(() => service.updateTask(params)),
  );

  server.tool(
    "operon_transition_task",
    "Transition an Operon task through Operon's dependency, recurrence, aggregate, and workflow guards. Prefer stable statusId from operon_get_configuration; exact configured status remains supported. expectedRevision and idempotencyKey are mandatory; dryRun defaults to true.",
    OperonTransitionTaskInputSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonTransitionTaskSchema>) =>
      runTool(() => service.transitionTask(params)),
  );

  server.tool(
    "operon_convert_task",
    "Convert an Operon task between inline and file forms through Operon's transition-safe conversion path. Apply is destructive and requires MCP_WRITE_MODE=full; dryRun defaults to true.",
    OperonConvertTaskInputSchema.shape,
    DESTRUCTIVE_MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonConvertTaskSchema>) =>
      runTool(() => service.convertTask(params)),
  );

  server.tool(
    "operon_relocate_task",
    "Move one inline Operon task to another Markdown note while preserving operonId. expectedRevision and idempotencyKey are mandatory; dryRun defaults to true. Both Bridge and MCP mutation opt-ins must be enabled for apply.",
    OperonRelocateTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonRelocateTaskSchema>) =>
      runTool(() => service.relocateTask(params)),
  );
}
