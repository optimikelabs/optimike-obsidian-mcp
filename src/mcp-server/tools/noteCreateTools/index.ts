import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { NoteCreateOperationAdapter } from "../../../services/operations/noteCreateOperationAdapter.js";
import { NOTE_CREATE_MAX_BYTES } from "../../../services/noteCreateContract.js";
import { NOTE_NAME_RULES_DESCRIPTION } from "../../../services/noteNameRules.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";
import { canonicalRejection } from "../../../services/obsidianFrontmatterFormat.js";

const Plan = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Exact new vault-relative Markdown path; parent directory must already exist. Must satisfy the shared note name rules (see the tool description).",
      ),
    content: z
      .string()
      .max(NOTE_CREATE_MAX_BYTES)
      .describe(
        "Exact complete intended Markdown. Include a frontmatter envelope when qualified automatic date fields are active.",
      ),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();
const Apply = z
  .object({
    planRef: z.string().min(1).max(128),
    idempotencyKey: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "Reuse the exact idempotencyKey from obsidian_note_create_plan. Do not generate a new key for apply.",
      ),
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
    const canonical = toolName === "obsidian_note_create_plan" ? canonicalRejection(error) : undefined;
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            canonical ?? publicMcpToolErrorPayload(error, {
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
export function registerNoteCreateTools(
  server: McpServer,
  runtime: NoteCreateOperationAdapter | undefined,
): void {
  if (!runtime) return;
  server.registerTool(
    "obsidian_note_create_plan",
    {
      description:
        `Seal one absent-only Markdown creation in the existing durable journal. Caller-supplied frontmatter must use Obsidian's canonical form; a refusal returns expectedFrontmatter for resubmission. Type issues are warnings. Does not create a note. Requires the separate Bridge creation grant and writable MCP policy; no automatic naming or parent-directory creation. ${NOTE_NAME_RULES_DESCRIPTION}`,
      inputSchema: mcpSchema(Plan.shape),
      annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_create_plan", () => runtime.plan(Plan.parse(params))),
  );
  server.registerTool(
    "obsidian_note_create_apply",
    {
      description:
        "Attempt the exact sealed exclusive creation once. Reuse the same idempotencyKey supplied to obsidian_note_create_plan; never generate a new key for apply. Never overwrite or add suffixes. On conflict or lost response, call obsidian_note_create_status on the existing planRef before any further action; never blindly replay. Only terminal/committed with postflight verified certifies completion. Committed means intended state observed, not attribution to this attempt; Obsidian indexing is not certified.",
      inputSchema: mcpSchema(Apply.shape),
      annotations: {
        ...GOVERNED_MUTATION_TOOL_ANNOTATIONS,
        destructiveHint: false,
      },
    },
    (params) =>
      run("obsidian_note_create_apply", () => {
        const p = Apply.parse(params);
        return runtime.apply(p.planRef, p.idempotencyKey);
      }),
  );
  server.registerTool(
    "obsidian_note_create_status",
    {
      description:
        "Observe/reconcile a durable create without writing a note. Verifies exact bytes or strictly qualified automatic date fields after their settlement delay. Partial/unknown effects are never overwritten, deleted or blindly replayed. No recovery tool is exposed.",
      inputSchema: mcpSchema(Status.shape),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (params) =>
      run("obsidian_note_create_status", () =>
        runtime.status(Status.parse(params).planRef),
      ),
  );
}
