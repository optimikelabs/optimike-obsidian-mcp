import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { McpError } from "../../../types-global/errors.js";
import { getGovernedNoteReplaceRuntime } from "./runtime.js";

const PlanSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe("Vault-relative path of an existing Markdown note."),
  nextContent: z
    .string()
    .describe("Complete next Markdown content. It is sealed in the private journal and never returned."),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("Caller-owned key binding one canonical replacement request."),
});

const ApplySchema = z.object({
  planRef: z
    .string()
    .min(1)
    .describe("Opaque plan reference returned by obsidian_note_replace_plan."),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("The exact idempotency key bound during planning."),
});

const StatusSchema = z.object({
  planRef: z
    .string()
    .min(1)
    .describe("Opaque plan reference returned by obsidian_note_replace_plan."),
});

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

export async function registerGovernedNoteReplaceTools(
  server: McpServer,
): Promise<void> {
  const runtime = getGovernedNoteReplaceRuntime();
  if (!runtime) return;

  server.tool(
    "obsidian_note_replace_plan",
    "Plan one complete atomic replacement of an existing Markdown note. This reads the live Atomic Write Bridge, validates the future Markdown and protected frontmatter, seals the before/after proofs and next content in the private journal, and performs no note write. planRef is opaque.",
    PlanSchema.shape,
    GOVERNED_PLAN_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof PlanSchema>) =>
      runTool(() => runtime.plan(params)),
  );

  server.tool(
    "obsidian_note_replace_apply",
    "Apply only the exact sealed note-replacement plan. Pass planRef and its matching idempotencyKey; do not provide a new target, hash, or content. A lost response must be followed by status, never by a new mutation request.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool(() => runtime.apply(params.planRef, params.idempotencyKey)),
  );

  server.tool(
    "obsidian_note_replace_status",
    "Read and reconcile the durable status of one sealed note-replacement plan without executing a new mutation. Use this first after a timeout or lost response.",
    StatusSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof StatusSchema>) =>
      runTool(() => runtime.status(params.planRef)),
  );

  server.tool(
    "obsidian_note_replace_recover",
    "Recover the exact same sealed note-replacement plan after an uncertain outcome. Recovery reconciles or safely resumes that plan; it is not undo and never accepts replacement mutation inputs.",
    ApplySchema.shape,
    GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof ApplySchema>) =>
      runTool(() => runtime.recover(params.planRef, params.idempotencyKey)),
  );
}
