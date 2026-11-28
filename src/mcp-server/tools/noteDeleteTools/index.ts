import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

const HEADLESS_DESCRIPTIONS = {
  plan: "Seal deletion to the vault trash. Inspect incomingLinks and explicitly acknowledge backlinks with a new plan if required. Requires MCP_WRITE_MODE=full.",
  apply: "Move the exact sealed file into the vault trash only after rechecking its content and backlinks. Reuse the plan key.",
  status: "Reconcile the sealed headless deletion against the original path and its exact trash destination.",
};

const Plan = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .describe("Exact vault-relative path of the Markdown note to move to the trash."),
    acknowledgeBacklinks: z
      .boolean()
      .optional()
      .describe(
        "Default false: a note that other notes link to is refused. Set true, after inspecting them with obsidian_note_links, to delete it anyway; those links become unresolved, they are not rewritten.",
      ),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();
const Apply = z
  .object({
    planRef: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();
const Status = z.object({ planRef: z.string().min(1).max(128) }).strict();
async function run(toolName: string, operation: () => Promise<unknown>) {
  try {
    return {
      isError: false,
      content: [
        { type: "text" as const, text: JSON.stringify(await operation()) },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            publicMcpToolErrorPayload(error, {
              operation: toolName,
              toolName,
              params: {},
            }),
          ),
        },
      ],
    };
  }
}
export function registerNoteDeleteTools(
  server: McpServer,
  runtime: {
    plan: (input: z.infer<typeof Plan>) => Promise<unknown>;
    apply: (ref: string, key: string) => Promise<unknown>;
    status: (ref: string) => Promise<unknown>;
    recover?: (ref: string, key: string, action?: "resume" | "abandon") => Promise<unknown>;
  } | undefined,
): void {
  if (!runtime) return;
  server.registerTool(
    "obsidian_note_delete_plan",
    {
      description: runtime.recover ? HEADLESS_DESCRIPTIONS.plan :
        "Seal the deletion of one Markdown note without deleting it: its exact content hash, size, incoming links and the vault's trash preference. The note is later moved to Obsidian's trash by the Atomic Write Bridge, never deleted outright; a permanent-deletion preference is refused. Requires MCP_WRITE_MODE=full and the independent note-deletion Bridge grant. A note that other notes link to is refused unless acknowledgeBacklinks=true.",
      inputSchema: mcpSchema(Plan.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_delete_plan", () => runtime.plan(Plan.parse(params))),
  );
  server.registerTool(
    "obsidian_note_delete_apply",
    {
      description: runtime.recover ? HEADLESS_DESCRIPTIONS.apply :
        "Dispatch only the exact sealed deletion once, after the Bridge re-reads the note and refuses if its content or incoming links changed since the plan. Reuse the idempotencyKey of the plan. After a lost reply call obsidian_note_delete_status; never replan to retry an uncertain effect. committed means the note left its path through the trash call; postflight.status verified means an exact new copy was observed in the vault trash.",
      inputSchema: mcpSchema(Apply.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_delete_apply", () => {
        const p = Apply.parse(params);
        return runtime.apply(p.planRef, p.idempotencyKey);
      }),
  );
  server.registerTool(
    "obsidian_note_delete_status",
    {
      description: runtime.recover ? HEADLESS_DESCRIPTIONS.status :
        "Read and reconcile the durable deletion outcome and observe postflight without deleting anything. postflight.status: verified (absent from its path and an exact new copy in the vault trash), path_absent_only (absent; a system trash cannot be observed), pending, failed or indeterminate. A backend restart can leave an unacknowledged deletion unknown; no recover or undo tool exists, restore from the trash in Obsidian.",
      inputSchema: mcpSchema(Status.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_delete_status", () =>
        runtime.status(Status.parse(params).planRef),
      ),
  );
  if (runtime.recover) {
    const recover = runtime.recover;
    const Recovery = Apply.extend({ action: z.enum(["resume", "abandon"]).optional() });
    server.registerTool(
      "obsidian_note_delete_recover",
      {
        description: "Resume the same headless plan when recoveryAllowed, or use action=abandon when abandonAllowed to release the reservation for manual repair. Reuse the original idempotency key.",
        inputSchema: mcpSchema(Recovery.shape),
        annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
      },
      (params) => run("obsidian_note_delete_recover", () => {
        const p = Recovery.parse(params);
        return recover(p.planRef, p.idempotencyKey, p.action);
      }),
    );
  }
}
