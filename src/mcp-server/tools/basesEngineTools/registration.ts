import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v3";
import { BASE_FUNCTION_TYPES } from "../../../services/basesEngineContract.js";
import { restBaseEngine } from "../../../services/baseFormulaEngineCheck.js";
import { basesCheck, basesFunctions } from "../../../services/basesEngineReads.js";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/service.js";
import { requestContextService } from "../../../utils/index.js";
import { publicMcpToolErrorPayload } from "../../../utils/internal/errorHandler.js";
import { mcpSchema } from "../../mcpSchema.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../toolAnnotations.js";

const FunctionsSchema = z.object({
  on: z
    .enum(BASE_FUNCTION_TYPES)
    .optional()
    .describe("Receiver type to detail. Omit for the names of every type."),
});

const CheckSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe("Vault-relative path of one .base file. Omit to check every Base."),
});

async function runTool(toolName: string, params: unknown, operation: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }], isError: false };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(publicMcpToolErrorPayload(error, { operation: toolName, toolName, params }), null, 2) }],
      isError: true,
    };
  }
}

/** Read-only Bases engine tools; registered only with a live Obsidian REST service. */
export function registerBasesEngineTools(server: McpServer, service: ObsidianRestApiService | undefined): void {
  if (!service) return;
  const engine = restBaseEngine(service);
  server.registerTool("bases_functions", {
    description:
      "List the Bases formula functions of the installed Obsidian, as its own engine knows them (via the Bases Bridge). Without on: function names grouped by receiver type (Global, Any, String, Number, List, Date, File, ...); methods under Any apply to every value. With on: that type's signatures and short descriptions. Use it before writing or fixing a Base formula. Read-only. When the engine is unavailable the answer is status unverified with a reason. Reference: https://help.obsidian.md/bases/functions",
    inputSchema: mcpSchema(FunctionsSchema.shape),
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }, (params) => runTool("bases_functions", params, () => basesFunctions(engine, FunctionsSchema.parse(params).on)));
  server.registerTool("bases_check", {
    description:
      "Check the formulas of one Base (path) or of every Base with Obsidian's own Bases engine (via the Bases Bridge). Each formula is ok, syntax_error, runtime_error, all_null or not_evaluated, with row counts and the first engine message. With path every formula is listed; without path healthy Bases are only counted and problem formulas are listed (at most 100 Bases). Read-only, nothing is written. When the engine is unavailable (Obsidian closed, older Bridge, failed canary) the result is unverified, never ok. Syntax: https://help.obsidian.md/bases/syntax",
    inputSchema: mcpSchema(CheckSchema.shape),
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  }, (params) => runTool("bases_check", params, async () => {
    const { path } = CheckSchema.parse(params);
    const context = requestContextService.createRequestContext({ operation: "BasesCheckList" });
    return basesCheck(engine, async () => (await service.listBases(context)).bases.map((base) => base.path), path);
  }));
}
