import {
  GovernedResponseFields,
  governedResponse,
} from "../../../services/governedResponse.js";
import { FrontmatterOperationSchema } from "../governedFrontmatterTools/registration.js";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import {
  confirmGovernedApply,
  type ApplyConfirmationGate,
} from "../../applyConfirmation.js";
import { z } from "zod/v3";
import {
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import {
  GovernedTextPatchRuntime,
  TextPatchProposalSchema,
  type GovernedTextPatchPlanInput,
} from "../../../services/textPatchProjectionRuntime.js";
import type { GovernedNoteReplaceRuntime } from "../governedNoteReplaceTools/runtime.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import { preparationPlanRejection } from "../../../services/obsidianFrontmatterFormat.js";
import { mcpSchema } from "../../mcpSchema.js";

const OperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("append_body"),
    text: z.string().min(1).max(262_144),
  }),
  z.object({
    op: z.literal("prepend_body"),
    text: z.string().min(1).max(262_144),
  }),
  z.object({
    op: z.literal("replace_literal"),
    search: z.string().min(1).max(262_144),
    replacement: z.string().max(262_144),
    occurrence: z.enum(["unique", "all"]).optional(),
    intent: z.literal("replace_all").optional(),
  }),
]);

const PlanSchema = z.object({
  ...GovernedResponseFields,
  frontmatterOperations: z
    .array(FrontmatterOperationSchema)
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Optional top-level frontmatter set/delete intentions compiled after the body patch into the SAME sealed plan and single CAS. Both write policies and date protection apply. No new values on apply/recover.",
    ),
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe("Vault-relative path of one existing Markdown note."),
  operations: z
    .array(OperationSchema)
    .min(1)
    .max(32)
    .describe(
      "Ordered body-only append_body, prepend_body, or replace_literal intentions. All-occurrence replacement needs occurrence=all and intent=replace_all. Literal values are sealed privately and never returned.",
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("Caller-owned key binding one canonical text patch intent."),
  proposal: TextPatchProposalSchema.optional().describe(
    "Import one offline body patch. Use idempotencyKey optimike:proposal:v1:<id> and supply the expected live Atomic Write binding and SHA-256 of the original note. Only imports may use this key prefix. Omit frontmatterOperations. Import never prepares creation dates or applies the patch.",
  ),
});

const [AppendOperation, PrependOperation, ReplaceOperation] = OperationSchema.options;
const StrictProposalPlanSchema = PlanSchema.extend({
  operations: z.array(z.discriminatedUnion("op", [
    AppendOperation.strict(),
    PrependOperation.strict(),
    ReplaceOperation.strict(),
  ])).min(1).max(32),
}).strict();

// Existing plans retain their parser. Imports must reject unknown fields
// before the ordinary plan schema can strip them.
const PlanInputSchema = z.preprocess((value, context) => {
  if (value && typeof value === "object" && Object.hasOwn(value, "proposal") &&
      !StrictProposalPlanSchema.safeParse(value).success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid offline text patch proposal." });
  }
  return value;
}, PlanSchema);

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
    .describe("Opaque reference returned by obsidian_text_patch_plan."),
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .describe("The exact public idempotency key bound during planning."),
});

const StatusSchema = z.object({
  ...GovernedResponseFields,
  planRef: z
    .string()
    .min(1)
    .describe("Opaque reference returned by obsidian_text_patch_plan."),
});

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
          text: JSON.stringify(
            await governedResponse(toolName, params, operation),
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
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            (toolName === "obsidian_text_patch_plan" ? preparationPlanRejection(error) : undefined) ?? publicMcpToolErrorPayload(error, {
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

export async function registerGovernedTextPatchTools(
  server: McpServer,
  noteRuntime: GovernedNoteReplaceRuntime | undefined,
): Promise<void> {
  if (!noteRuntime) return;
  const runtime = new GovernedTextPatchRuntime(noteRuntime);
  server.registerTool(
    "obsidian_text_patch_plan",
    {
      description: noteRuntime.isFilesystem ? "Seal one bounded body text patch, optionally with frontmatterOperations, using the on-disk SHA-256 and vault identity. The headless filesystem authority maintains configured dates." :
        "Plan one bounded body text patch, optionally combined with frontmatterOperations, of an existing Markdown note. Noncanonical existing frontmatter is normalized in the sealed plan and announced in frontmatterFormat.normalization; type issues are warnings. After normalization the plan preserves bytes outside authorized body and frontmatter ranges, binds the before proof and vault identity, and does not apply the requested patch. Templates and date-manager-excluded paths are never dated. Otherwise missing creation dates may be prepared by the active vault date manager and any preparation normalization is reported. If preparation is unavailable or fails its preconditions, the plan is refused; ask the vault owner to resolve the missing date. A Bridge that cannot prove the added creation date refuses with date_preparation_bridge_upgrade_required before any change (ask the vault owner to update the Atomic Write Bridge); date_preparation_unverified names the failed check in preparationCheck.",
      inputSchema: mcpSchema(PlanInputSchema),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    async (params: GovernedTextPatchPlanInput) =>
      runTool("obsidian_text_patch_plan", params, () => runtime.plan(params)),
  );
  server.registerTool(
    "obsidian_text_patch_apply",
    {
      description:
        "Apply only the exact sealed text patch. Pass planRef and its matching idempotencyKey; no target, text, operation, or hash can be replaced after planning. After a lost response, call status before any recovery.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>, ctx: ServerContext) => {
      // Opt-in confirmation, asked after the seal/policy checks and the CAS
      // preflight, before any effect. Off or unsupported: unchanged flow.
      let gate: ApplyConfirmationGate;
      try {
        gate = await confirmGovernedApply({
          server: server.server,
          ctx,
          toolName: "obsidian_text_patch_apply",
          loadTarget: () =>
            runtime.confirmationTarget(params.planRef, params.idempotencyKey),
        });
      } catch (error) {
        return runTool("obsidian_text_patch_apply", params, () =>
          Promise.reject(error),
        );
      }
      if (gate.kind === "input_required") return gate.result;
      return runTool("obsidian_text_patch_apply", params, async () => {
        const receipt = await runtime.apply(
          params.planRef,
          params.idempotencyKey,
          params.completionMode,
        );
        return gate.confirmation
          ? { ...receipt, confirmation: gate.confirmation }
          : receipt;
      });
    },
  );
  server.registerTool(
    "obsidian_text_patch_status",
    {
      description:
        "Read and reconcile the durable status of one governed text patch without executing a mutation. The response never includes its idempotency key or sealed text.",
      inputSchema: mcpSchema(StatusSchema.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof StatusSchema>) =>
      runTool("obsidian_text_patch_status", params, () =>
        runtime.status(params.planRef),
      ),
  );
  server.registerTool(
    "obsidian_text_patch_recover",
    {
      description:
        "Recover the exact same sealed text patch after an uncertain outcome. Recovery is not undo and accepts no new patch intent; it reconciles the existing plan under its original fencing.",
      inputSchema: mcpSchema(ApplySchema.shape),
      annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    },
    async (params: z.infer<typeof ApplySchema>) =>
      runTool("obsidian_text_patch_recover", params, () =>
        runtime.recover(
          params.planRef,
          params.idempotencyKey,
          params.completionMode,
        ),
      ),
  );
}
