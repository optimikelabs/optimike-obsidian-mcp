import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import type { VaultFileCreateOperationAdapter } from "../../../services/operations/vaultFileCreateOperationAdapter.js";
import { VAULT_FILE_CREATE_MAX_BYTES, VAULT_FILE_CREATE_PROFILES } from "../../../services/vaultFileCreateContract.js";
import { NOTE_NAME_RULES_DESCRIPTION } from "../../../services/noteNameRules.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import {
  GOVERNED_PLAN_TOOL_ANNOTATIONS,
  GOVERNED_MUTATION_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import { mcpSchema } from "../../mcpSchema.js";

const CONTENT = {
  base: "Exact complete intended .base YAML: a nonempty mapping (filters, formulas, properties, views). It must pass obsidian_validate_format kind=base without errors.",
  canvas: "Exact complete intended JSON Canvas: strict JSON with nodes and edges arrays and a valid graph (unique ids, integer geometry, known node types, edges between existing nodes). Use {\"nodes\":[],\"edges\":[]} for an empty Canvas.",
} as const;
const DESCRIPTION = {
  base: "Seal one absent-only Base (.base) creation in the existing durable journal. The YAML is validated before sealing; a refusal returns reasonCode create_format_invalid (call obsidian_validate_format kind=base for the issue list). Does not create the file. Requires the separate Bridge Base-creation grant and writable MCP policy; never overwrites, never edits an existing Base (use bases_formula_patch_plan for formulas), no automatic naming or parent-directory creation.",
  canvas: "Seal one absent-only Canvas (.canvas) creation in the existing durable journal. The graph is validated before sealing so obsidian_canvas_patch_plan can edit it later; a refusal returns reasonCode create_format_invalid (obsidian_validate_format kind=canvas lists common issues). Does not create the file. Requires the separate Bridge Canvas-creation grant and writable MCP policy; never overwrites an existing Canvas, no automatic naming or parent-directory creation.",
} as const;

/** Literal public names; the shared contract must agree (checked at registration). */
const TOOL_NAMES = {
  base: { plan: "bases_create_plan", apply: "bases_create_apply", status: "bases_create_status" },
  canvas: { plan: "obsidian_canvas_create_plan", apply: "obsidian_canvas_create_apply", status: "obsidian_canvas_create_status" },
} as const;

const Apply = z.object({
  planRef: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(256).describe("Reuse the exact idempotencyKey from the plan. Do not generate a new key for apply."),
}).strict();
const Status = z.object({ planRef: z.string().min(1).max(128) }).strict();

async function run(toolName: string, operation: () => Promise<unknown>) {
  try {
    return { isError: false, content: [{ type: "text" as const, text: JSON.stringify(await operation()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const,
      text: JSON.stringify(publicMcpToolErrorPayload(error, { operation: toolName, toolName, params: {} })) }] };
  }
}

function registerFamily(server: McpServer, runtime: VaultFileCreateOperationAdapter): void {
  const profile = VAULT_FILE_CREATE_PROFILES[runtime.kind];
  const names = TOOL_NAMES[runtime.kind];
  if (names.plan !== profile.tools.plan || names.apply !== profile.tools.apply || names.status !== profile.tools.status) {
    throw new Error(`Inconsistent ${profile.label} creation tool names.`);
  }
  const Plan = z.object({
    path: z.string().min(1).max(1024).describe(
      `Exact new vault-relative ${profile.extension} path; parent directory must already exist. Must satisfy the shared note name rules with the ${profile.extension} extension.`),
    content: z.string().max(VAULT_FILE_CREATE_MAX_BYTES).describe(CONTENT[runtime.kind]),
    idempotencyKey: z.string().min(1).max(256),
  }).strict();
  server.registerTool(names.plan, {
    description: `${DESCRIPTION[runtime.kind]} ${NOTE_NAME_RULES_DESCRIPTION}`,
    inputSchema: mcpSchema(Plan.shape),
    annotations: GOVERNED_PLAN_TOOL_ANNOTATIONS,
  }, (params) => run(names.plan, () => runtime.plan(Plan.parse(params))));
  server.registerTool(names.apply, {
    description: `Attempt the exact sealed exclusive ${profile.label} creation once. Reuse the same idempotencyKey supplied to ${names.plan}; never generate a new key for apply. Never overwrite or add suffixes. On conflict or lost response, call ${names.status} on the existing planRef before any further action; never blindly replay. Only terminal/committed with postflight verified certifies completion. Committed means the exact bytes were observed, not attribution to this attempt; Obsidian indexing is not certified.`,
    inputSchema: mcpSchema(Apply.shape),
    annotations: { ...GOVERNED_MUTATION_TOOL_ANNOTATIONS, destructiveHint: false },
  }, (params) => run(names.apply, () => {
    const p = Apply.parse(params);
    return runtime.apply(p.planRef, p.idempotencyKey);
  }));
  server.registerTool(names.status, {
    description: `Observe/reconcile a durable ${profile.label} creation without writing. Only the exact sealed bytes verify; no automatic rewrite is excused. Partial/unknown effects are never overwritten, deleted or blindly replayed. No recovery tool is exposed.`,
    inputSchema: mcpSchema(Status.shape),
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }, (params) => run(names.status, () => runtime.status(Status.parse(params).planRef)));
}

export function registerVaultFileCreateTools(
  server: McpServer,
  runtimes: readonly (VaultFileCreateOperationAdapter | undefined)[],
): void {
  for (const runtime of runtimes) if (runtime) registerFamily(server, runtime);
}
