import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import { ADMINISTRATIVE_CLOSURE_REASON_CODES } from "../../../services/operations/administrativeClosure.js";
import type { GovernedNoteReplaceRuntime } from "../governedNoteReplaceTools/index.js";
import { assertWriteAllowed } from "../../../services/writePolicy.js";
import { MAINTENANCE_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

export const OPERATION_CLOSE_MAX_TARGETS = 20;

const InputSchema = z
  .object({
    planRefs: z
      .array(z.string().min(1).max(256))
      .max(OPERATION_CLOSE_MAX_TARGETS)
      .optional()
      .describe("planRef values from obsidian_list_pending_operations (state outcome_unknown) or from a governed receipt."),
    datePreparationPaths: z
      .array(z.string().min(1).max(1024))
      .max(OPERATION_CLOSE_MAX_TARGETS)
      .optional()
      .describe("Vault-relative Markdown paths locked by date_preparation_unverified."),
    reasonCode: z
      .enum(ADMINISTRATIVE_CLOSURE_REASON_CODES)
      .default("operator_review")
      .describe("Why the owner closes: operator_review or historical_cleanup."),
    dryRun: z
      .boolean()
      .default(true)
      .describe("Default true: inspect the Bridge fence without revoking anything or changing the journal. Set false only after the owner approved the closure."),
  })
  .strict()
  .refine(
    (value) => (value.planRefs?.length ?? 0) + (value.datePreparationPaths?.length ?? 0) >= 1 &&
      (value.planRefs?.length ?? 0) + (value.datePreparationPaths?.length ?? 0) <= OPERATION_CLOSE_MAX_TARGETS,
    { message: `Provide between 1 and ${OPERATION_CLOSE_MAX_TARGETS} planRefs or datePreparationPaths.` },
  );

export function registerOperationCloseTool(
  server: McpServer,
  runtime: GovernedNoteReplaceRuntime | undefined,
): void {
  if (!runtime) return;
  server.registerTool(
    "obsidian_operation_close",
    {
      description:
        "Administratively closes uncertain governed writes (outcome_unknown) as reviewed_unverified, or releases a date_preparation_unverified lock, after owner review. It first reconciles status, then asks the Atomic Write Bridge to revoke every recorded attempt at its effect point; it closes only when no attempt can still change the vault. It never writes a note, never claims success and never replays. dryRun defaults to true. Refusals (Bridge unavailable or too old, effect in progress, unfenced historical attempts while the Bridge does not require tokens) leave everything unchanged.",
      inputSchema: mcpSchema(InputSchema.innerType().shape),
      annotations: MAINTENANCE_TOOL_ANNOTATIONS,
    },
    async (raw: unknown) => {
      const params = InputSchema.parse(raw);
      const count = (params.planRefs?.length ?? 0) + (params.datePreparationPaths?.length ?? 0);
      assertWriteAllowed({
        operation: "obsidian_operation_close",
        action: params.dryRun ? "inspect" : "close",
        batchCount: count,
        allowInReadonly: params.dryRun,
        allowInGuarded: true,
      });
      const options = { dryRun: params.dryRun, reasonCode: params.reasonCode };
      const items = [];
      // Sequential on purpose: each verdict reads the Bridge after the previous closure.
      for (const planRef of params.planRefs ?? []) items.push(await runtime.closeOperation(planRef, options));
      for (const path of params.datePreparationPaths ?? []) items.push(await runtime.releaseDatePreparationLock(path, options));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ contractVersion: 1, dryRun: params.dryRun, items }, null, 2),
          },
        ],
        isError: false,
      };
    },
  );
}
