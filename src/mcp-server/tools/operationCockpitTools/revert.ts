import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import type { FilesystemRevert } from "../../../services/operations/filesystemRevert.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import { mcpSchema } from "../../mcpSchema.js";
import { GOVERNED_MUTATION_TOOL_ANNOTATIONS, GOVERNED_PLAN_TOOL_ANNOTATIONS, READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";

const ref = z.string().min(1).max(128);
const key = z.string().min(1).max(256);
const Plan = z.object({ path: z.string().min(1).max(1024), operationRef: ref, idempotencyKey: key }).strict();
const Apply = z.object({ planRef: ref, idempotencyKey: key }).strict();
const Status = z.object({ planRef: ref }).strict();

async function respond(toolName: string, operation: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await operation()) }], isError: false };
  } catch (error) {
    return { content: [{ type: "text" as const, text: JSON.stringify(publicMcpToolErrorPayload(error, {
      operation: toolName, toolName, params: {},
    })) }], isError: true };
  }
}

export function registerFilesystemRevertTools(server: McpServer, runtime: FilesystemRevert | undefined) {
  if (!runtime) return;
  server.registerTool("obsidian_operation_revert_plan", {
    description: "Seal restoration at the original path from a committed headless note operation or a recorded divergent write. Pass the original planRef as operationRef. Supply no note content. If a concurrent edit was displaced, restore those bytes. Divergence requires full write mode and the recorded on-disk hash or absence. Reverting creation removes the note if its bytes still match.",
    inputSchema: mcpSchema(Plan.shape), annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
  }, params => respond("obsidian_operation_revert_plan", () => runtime.plan(Plan.parse(params))));
  server.registerTool("obsidian_operation_revert_status", {
    description: "Reconcile the same sealed headless revert. An interrupted exchange may restore an edit it displaced.",
    inputSchema: mcpSchema(Status.shape), annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }, params => respond("obsidian_operation_revert_status", () => runtime.status(Status.parse(params).planRef)));
  for (const name of ["obsidian_operation_revert_apply", "obsidian_operation_revert_recover"] as const) {
    const recover = name === "obsidian_operation_revert_recover";
    server.registerTool(name, {
      description: recover ? "Reconcile or resume the same headless revert after an uncertain outcome. Check status first."
        : "Apply the exact sealed headless revert. Reuse its planRef and idempotencyKey.",
      inputSchema: mcpSchema(Apply.shape), annotations: GOVERNED_MUTATION_TOOL_ANNOTATIONS,
    }, params => respond(name, () => {
      const { planRef, idempotencyKey } = Apply.parse(params);
      return runtime.apply(planRef, idempotencyKey, recover);
    }));
  }
}
