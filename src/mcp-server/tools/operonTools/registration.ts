import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OperonAdoptTaskSchema,
  OperonCreatePeriodicTaskSchema,
  OperonUpdatePeriodicSchedulingSchema,
  OperonConvertTaskSchema,
  OperonConvertTaskInputSchema,
  OperonCreateTaskSchema,
  OperonFilterQuerySchema,
  OperonRelocateTaskSchema,
  OperonRecoverMutationInputSchema,
  OperonRecoverMutationSchema,
  OperonPendingRecoveriesInputSchema,
  OperonTaskFinderSchema,
  OperonResolveTaskSchema,
  OperonRelationshipsSchema,
  OperonContextSchema,
  OperonContextInputSchema,
  OperonQuerySchema,
  OperonTransitionTaskSchema,
  OperonTransitionTaskInputSchema,
  OperonUpdateTaskSchema,
  OperonSetRelationshipsSchema,
  OperonSetRelationshipsInputSchema,
  OperonUpdateRecurrenceSchema,
} from "../../../services/operon/contract.js";
import { OperonService } from "../../../services/operon/service.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";

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

async function runTool(
  toolName: string,
  params: unknown,
  operation: () => Promise<unknown>,
) {
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

export async function registerOperonTools(server: McpServer): Promise<void> {
  const service = new OperonService();

  server.tool(
    "operon_status",
    "Inspect the live Optimike Operon Bridge and the persisted MCP snapshot. forceRefresh=true rebuilds the snapshot only when Obsidian Desktop, Local REST API, Operon, and the Bridge are available. This surface is read-only.",
    ForceRefreshSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool("operon_status", params, () =>
        service.status(params.forceRefresh),
      ),
  );

  server.tool(
    "operon_get_configuration",
    "Read the task-semantic Operon configuration from the live plugin runtime: language, stable workflow/status IDs, priority definitions, canonical-to-visible key mappings, creation targets/templates, task automations, excluded folders, and documentation location. A saved-filter catalog is included only when the official runtime exposes one. Falls back only to an explicitly stale persisted snapshot.",
    ForceRefreshSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool("operon_get_configuration", params, () =>
        service.configuration(params.forceRefresh),
      ),
  );

  server.tool(
    "operon_list_tasks",
    "List Operon tasks from a live-generation-validated snapshot or an explicitly stale persisted fallback. Supports pagination and optional filters. No task mutation is performed.",
    OperonQuerySchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonQuerySchema>) =>
      runTool("operon_list_tasks", params, () => service.query(params)),
  );

  server.tool(
    "operon_query_tasks",
    "Query Operon tasks by identity, text, source, checkbox, stable workflow/status IDs, visible workflow labels, priority, tier, path, tags, parent, dates, canonical/custom fields, or unmanaged file-task properties. Prefer pipelineIds/statusIds from operon_get_configuration so UI language changes do not break automations. Responses always declare source and freshness.",
    OperonQuerySchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonQuerySchema>) =>
      runTool("operon_query_tasks", params, () => service.query(params)),
  );

  server.tool(
    "operon_query_saved_filter",
    "Evaluate one saved Operon filter through Operon's native filter engine. filterSetId must be an exact ID obtained from Operon's UI/configuration or an operator workflow; Operon 3.2 can execute a filter but does not expose the saved-filter catalog through its official Developer API. optional scopePath limits results to one note or folder. This capability is live-only because headless snapshots cannot reproduce plugin filter semantics.",
    OperonFilterQuerySchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonFilterQuerySchema>) =>
      runTool("operon_query_saved_filter", params, () =>
        service.querySavedFilter(params),
      ),
  );

  server.tool(
    "operon_get_task",
    "Read one Operon task by stable operonId from the live-generation-validated snapshot or the last persisted stale fallback.",
    GetTaskSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof GetTaskSchema>) =>
      runTool("operon_get_task", params, () => service.getTask(params)),
  );

  server.tool(
    "operon_validate",
    "Validate the live Operon duplicate/source/workflow graph when available, otherwise run a limited snapshot-only validation and state its limitations.",
    ForceRefreshSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof ForceRefreshSchema>) =>
      runTool("operon_validate", params, () =>
        service.validate(params.forceRefresh),
      ),
  );

  server.tool(
    "operon_get_diagnostics",
    "Read Operon 3.2 native runtime diagnostics through Developer API V1. Use this for lifecycle, persistence, capability/grant, catalog, and transport diagnosis; it never modifies the vault.",
    {},
    READ_ONLY_ANNOTATIONS,
    async () =>
      runTool("operon_get_diagnostics", {}, () => service.diagnostics()),
  );

  server.tool(
    "operon_find_tasks",
    "Run Operon's native ranked task/project finder with bounded filters, scopes, representations, project mode, cursor, and at most 50 rows. Prefer this over broad text query when ranking, overdue/today/recent scope, or project-tree counts matter.",
    OperonTaskFinderSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonTaskFinderSchema>) =>
      runTool("operon_find_tasks", params, () => service.findTasks(params)),
  );

  server.tool(
    "operon_resolve_task",
    "Resolve an Operon task selector through the native entity resolver and return resolved, ambiguous, or not-found with bounded candidates. Use before acting when you have a path, note name, locator, search phrase, or uncertain identity instead of guessing an operonId.",
    OperonResolveTaskSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonResolveTaskSchema>) =>
      runTool("operon_resolve_task", params, () => service.resolveTask(params)),
  );

  server.tool(
    "operon_get_relationships",
    "Read the bounded native relationship graph for one stable operonId, including explicit, derived, and inferred edges plus hydrated task summaries. Depth is capped at 3 and results at 100.",
    OperonRelationshipsSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonRelationshipsSchema>) =>
      runTool("operon_get_relationships", params, () =>
        service.relationships(params),
      ),
  );

  server.tool(
    "operon_build_context",
    "Build a bounded native Operon context pack for exact-task, neighborhood, project analysis, planning workload, or creation context. Only notes, links, and custom fields may be hydrated; source Markdown, tracker history, reminders, placement, and mutation-readiness packs are intentionally excluded.",
    OperonContextInputSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonContextSchema>) =>
      runTool("operon_build_context", params, () => service.context(params)),
  );

  server.tool(
    "operon_get_timer_state",
    "Read Operon's native active timer and in-flight timer transition state. This is observation only; timer start, stop, and session edits remain operator-controlled outside MCP.",
    {},
    READ_ONLY_ANNOTATIONS,
    async () => runTool("operon_get_timer_state", {}, () => service.timers()),
  );

  server.tool(
    "operon_adopt_task",
    "Adopt one existing plain Markdown or Obsidian Tasks checkbox in place through Operon's official sealed task-workflow preview/apply contract. Requires an exact one-based line and expectedLine precondition, plus idempotencyKey; dryRun defaults to true. No raw Markdown or CLI fallback exists.",
    OperonAdoptTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonAdoptTaskSchema>) =>
      runTool("operon_adopt_task", params, () => service.adoptTask(params)),
  );

  server.tool(
    "operon_create_periodic_task",
    "Create exactly one inline Operon task in the configured Daily or Weekly Note through Operon's sealed periodic-note workflow. Operon owns routing, templates, container identity and receipts; routeDate is optional and distinct from an initial fields.dateScheduled value. Later dateScheduled changes must use operon_update_periodic_scheduling. dryRun defaults to true. Apply requires the live Bridge, idempotency and the periodicCreate capability.",
    OperonCreatePeriodicTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonCreatePeriodicTaskSchema>) =>
      runTool("operon_create_periodic_task", params, () =>
        service.createPeriodicTask(params),
      ),
  );

  server.tool(
    "operon_update_periodic_scheduling",
    "Set or clear dateScheduled for one exact Operon task through the sealed periodic-update workflow. Use this tool, not operon_update_task, for every dateScheduled change: Operon decides retain, detach or realign without moving the source Markdown. expectedRevision and idempotencyKey are mandatory; dryRun defaults to true.",
    OperonUpdatePeriodicSchedulingSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonUpdatePeriodicSchedulingSchema>) =>
      runTool("operon_update_periodic_scheduling", params, () =>
        service.updatePeriodicScheduling(params),
      ),
  );

  server.tool(
    "operon_create_task",
    "Create an Operon inline or file task through the loaded engine's supported official API. dateScheduled is reserved for operon_update_periodic_scheduling. dryRun defaults to true. Apply requires the live Bridge and an idempotencyKey; no raw Markdown fallback exists.",
    OperonCreateTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonCreateTaskSchema>) =>
      runTool("operon_create_task", params, () => service.createTask(params)),
  );

  server.tool(
    "operon_update_task",
    "Update exactly one ordinary Operon mutation group: description, managed fields/tags, or one unmanaged file property. Do not use this tool for dateScheduled (use operon_update_periodic_scheduling), relationships (use operon_set_relationships), or recurrence fields (use operon_update_recurrence). expectedRevision and idempotencyKey are mandatory; dryRun defaults to true.",
    OperonUpdateTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonUpdateTaskSchema>) =>
      runTool("operon_update_task", params, () => service.updateTask(params)),
  );

  server.tool(
    "operon_transition_task",
    "Transition an Operon task through Operon's dependency, recurrence, aggregate, and workflow guards. Prefer stable statusId from operon_get_configuration; exact configured status remains supported. expectedRevision and idempotencyKey are mandatory; dryRun defaults to true.",
    OperonTransitionTaskInputSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonTransitionTaskSchema>) =>
      runTool("operon_transition_task", params, () =>
        service.transitionTask(params),
      ),
  );

  server.tool(
    "operon_convert_task",
    "Convert an Operon task between inline and file forms through Operon's transition-safe conversion path. Apply is destructive and requires MCP_WRITE_MODE=full; dryRun defaults to true.",
    OperonConvertTaskInputSchema.shape,
    DESTRUCTIVE_MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonConvertTaskSchema>) =>
      runTool("operon_convert_task", params, () => service.convertTask(params)),
  );

  server.tool(
    "operon_relocate_task",
    "Move one inline Operon task to another Markdown note while preserving operonId. expectedRevision and idempotencyKey are mandatory; dryRun defaults to true. Both Bridge and MCP mutation opt-ins must be enabled for apply.",
    OperonRelocateTaskSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonRelocateTaskSchema>) =>
      runTool("operon_relocate_task", params, () =>
        service.relocateTask(params),
      ),
  );

  server.tool(
    "operon_set_relationships",
    "Replace or explicitly clear parentTask, blocking, or blockedBy through Operon Developer API V1. The tool rejects duplicate, self, and contradictory dependency targets; expectedRevision and idempotencyKey are mandatory; dryRun defaults to true.",
    OperonSetRelationshipsInputSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonSetRelationshipsSchema>) =>
      runTool("operon_set_relationships", params, () =>
        service.setRelationships(params),
      ),
  );

  server.tool(
    "operon_update_recurrence",
    "Set or explicitly clear an Operon recurrence rule and its official temporal fields, except dateScheduled, for this-task or this-and-following. dateScheduled is reserved for operon_update_periodic_scheduling. This apply is reserved for full write policy; expectedRevision and idempotencyKey are mandatory; dryRun defaults to true.",
    OperonUpdateRecurrenceSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonUpdateRecurrenceSchema>) =>
      runTool("operon_update_recurrence", params, () =>
        service.updateRecurrence(params),
      ),
  );

  server.tool(
    "operon_list_pending_recoveries",
    "List durable official Operon Developer API mutation recoveries. Read-only: it does not retry or apply anything; use the returned recoveryRef only with operon_recover_mutation after inspecting the uncertain outcome.",
    OperonPendingRecoveriesInputSchema.shape,
    READ_ONLY_ANNOTATIONS,
    async (params: z.infer<typeof OperonPendingRecoveriesInputSchema>) =>
      runTool("operon_list_pending_recoveries", params, () =>
        service.pendingRecoveries(params),
      ),
  );

  server.tool(
    "operon_recover_mutation",
    "Recover exactly one uncertain official Operon mutation by recoveryRef. Set recovery.kind=developer-api for legacy official recovery, or use the exact task-workflow kind returned by pending state and optionally echo its planDigest. This replays the same durable plan only; it never constructs a new mutation. Requires idempotencyKey, OPERON_MUTATIONS_ENABLED=true, MCP_WRITE_MODE=full, and an empty OPERON_MUTATION_ALLOWED_PATH_PREFIXES because current recovery records do not prove their route.",
    OperonRecoverMutationInputSchema.shape,
    MUTATION_ANNOTATIONS,
    async (params: z.infer<typeof OperonRecoverMutationSchema>) =>
      runTool("operon_recover_mutation", params, () =>
        service.recoverMutation(params),
      ),
  );
}
