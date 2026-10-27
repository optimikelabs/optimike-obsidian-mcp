import {
  GovernedResponseFields,
  governedResponse,
} from "../../../services/governedResponse.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import type { GovernedNoteReplaceRuntime } from "./runtime.js";
import { mcpSchema } from "../../mcpSchema.js";
import { canonicalRejection, preparationPlanRejection } from "../../../services/obsidianFrontmatterFormat.js";

const PlanSchema = z.object({
  ...GovernedResponseFields,
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe("Vault-relative path of an existing Markdown note."),
  nextContent: z
    .string()
    .describe(
      "Complete next Markdown content. It is sealed in the private journal and never returned.",
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("Caller-owned key binding one canonical replacement request."),
});

const ApplySchema = z.object({
  ...GovernedResponseFields,
  completionMode: z
    .enum(["deferred", "verified"])
    .optional()
    .describe(
      "Default deferred: return after the CAS attempt, with postflight.checkAfter when date settlement is pending. Call status at or after that time; only committed/verified certifies success. verified waits within the sealed observation window and can exceed client timeouts; a still-pending completion signal returns applying for later status.",
    ),
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
  ...GovernedResponseFields,
  planRef: z
    .string()
    .min(1)
    .describe("Opaque plan reference returned by obsidian_note_replace_plan."),
});

async function runTool(
  toolName: string,
  params: unknown,
  operation: () => Promise<unknown>,
) {
  try {
    const result = await governedResponse(toolName, params, operation);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            result,
            null,
            (params as { responseMode?: string })?.responseMode !== "detailed"
              ? undefined
              : 2,
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    const canonical = toolName === "obsidian_note_replace_plan" ? canonicalRejection(error) ?? preparationPlanRejection(error) : undefined;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            canonical ?? publicMcpToolErrorPayload(error, {
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

export async function registerGovernedNoteReplaceTools(
  server: McpServer,
  runtime: GovernedNoteReplaceRuntime | undefined,
): Promise<void> {
  if (!runtime) return;
  server.registerTool(
    "obsidian_note_replace_plan",
    {
      description:
        "Plan one complete atomic replacement of an existing Markdown note. Caller-supplied frontmatter must already use Obsidian's canonical form; a refusal returns expectedFrontmatter for the caller to resend. Type issues are warnings. The live Bridge validates and seals before/after proofs without applying the requested replacement. Missing creation dates may first be prepared by the active vault date manager; any preparation normalization is announced. planRef is opaque.",
      inputSchema: mcpSchema(PlanSchema.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof PlanSchema>) =>
      runTool("obsidian_note_replace_plan", params, () =>
        runtime.planPublicDirect(params),
      ),
  );
  server.registerTool(
    "obsidian_note_replace_apply",
    {
      description:
        "Apply only the exact sealed note-replacement plan. Pass planRef and its matching idempotencyKey; do not provide a new target, hash, or content. A lost response must be followed by status, never by a new mutation request.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_note_replace_apply", params, () =>
        runtime.applyPublicDirectPlan(
          params.planRef,
          params.idempotencyKey,
          params.completionMode,
        ),
      ),
  );
  server.registerTool(
    "obsidian_note_replace_status",
    {
      description:
        "Read and reconcile the durable status of one sealed note-replacement plan without executing a new mutation. Use this first after a timeout or lost response.",
      inputSchema: mcpSchema(StatusSchema.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof StatusSchema>) =>
      runTool("obsidian_note_replace_status", params, () =>
        runtime.statusPublicDirectPlan(params.planRef),
      ),
  );
  server.registerTool(
    "obsidian_note_replace_recover",
    {
      description:
        "Recover the exact same sealed note-replacement plan after an uncertain outcome. Recovery reconciles or safely resumes that plan; it is not undo and never accepts replacement mutation inputs.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_note_replace_recover", params, () =>
        runtime.recoverPublicDirectPlan(
          params.planRef,
          params.idempotencyKey,
          params.completionMode,
        ),
      ),
  );
}
