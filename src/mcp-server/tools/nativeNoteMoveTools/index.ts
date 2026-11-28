import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";
import { NOTE_NAME_RULES_DESCRIPTION } from "../../../services/noteNameRules.js";

const HEADLESS_DESCRIPTIONS = {
  plan: "Seal a headless file move and its indexed backlink rewrites without writing to the vault. Inspect the capped preview before applying. Requires MCP_WRITE_MODE=full.",
  apply: "Apply the sealed move only after rechecking the graph and every affected file. Reuse the plan key. After a lost reply, inspect status and recover the same plan if requested.",
  status: "Reconcile the sealed headless move against the filesystem without rewriting or moving a file.",
};

const Plan = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .max(1024)
      .describe("Exact vault-relative source path. Live requires Markdown. Headless also accepts attachments."),
    destinationPath: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Exact absent destination of the same file type; its parent must already exist. Must satisfy the shared note name rules (see the tool description); the source may keep a legacy name.",
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
export function registerNativeNoteMoveTools(
  server: McpServer,
  runtime: {
    plan: (input: z.infer<typeof Plan>) => Promise<unknown>;
    apply: (ref: string, key: string) => Promise<unknown>;
    status: (ref: string) => Promise<unknown>;
    recover?: (ref: string, key: string) => Promise<unknown>;
  } | undefined,
): void {
  if (!runtime) return;
  server.registerTool(
    "obsidian_note_move_plan",
    {
      description: runtime.recover ? HEADLESS_DESCRIPTIONS.plan :
        `Seal one native Markdown move and its bounded observed semantic neighborhood without moving a note. Requires MCP_WRITE_MODE=full and the independent native-move Bridge grant. No global graph transaction or source-content CAS. Unknown/truncated neighborhoods are refused; graph effects outside the sealed neighborhood are not certified. ${NOTE_NAME_RULES_DESCRIPTION}`,
      inputSchema: mcpSchema(Plan.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_move_plan", () => runtime.plan(Plan.parse(params))),
  );
  server.registerTool(
    "obsidian_note_move_apply",
    {
      description: runtime.recover ? HEADLESS_DESCRIPTIONS.apply :
        "Dispatch only the exact sealed native rename once. Native completion does not mean graph verification. Inspect graph_postflight with status after a lost reply; never manufacture a new move request to retry an uncertain effect.",
      inputSchema: mcpSchema(Apply.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_move_apply", () => {
        const p = Apply.parse(params);
        return runtime.apply(p.planRef, p.idempotencyKey);
      }),
  );
  server.registerTool(
    "obsidian_note_move_status",
    {
      description: runtime.recover ? HEADLESS_DESCRIPTIONS.status :
        "Read/reconcile the durable move outcome and separately observe graph_postflight without executing a rename. Backend restart can leave an unacknowledged move indeterminate; no recover/undo tool exists for this V1.",
      inputSchema: mcpSchema(Status.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_move_status", () =>
        runtime.status(Status.parse(params).planRef),
      ),
  );
  if (runtime.recover) {
    const recover = runtime.recover;
    server.registerTool(
      "obsidian_note_move_recover",
      {
        description: "Resume only the recorded headless plan after status reports recoveryAllowed. Reuse its original idempotency key.",
        inputSchema: mcpSchema(Apply.shape),
        annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
      },
      (params) => run("obsidian_note_move_recover", () => {
        const p = Apply.parse(params);
        return recover(p.planRef, p.idempotencyKey);
      }),
    );
  }
}
