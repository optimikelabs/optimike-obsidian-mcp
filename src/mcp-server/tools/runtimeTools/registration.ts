import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAINTENANCE_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import {
  collectRuntimeStatus,
  runRuntimeMaintenance,
} from "../../../services/runtimeState.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import {
  registerGovernedNoteReplaceTools,
  type GovernedNoteReplaceRuntime,
} from "../governedNoteReplaceTools/index.js";
import { registerGovernedFrontmatterTools } from "../governedFrontmatterTools/index.js";
import { registerOperonTools } from "../operonTools/index.js";

const MaintenanceInputSchema = z.object({
  action: z
    .enum([
      "integrity_check",
      "run_maintenance",
      "refresh_vault_cache",
      "refresh_semantic_cache",
      "refresh_tasks_cache",
      "refresh_all",
    ])
    .describe("Maintenance action to run on the shared local runtime."),
});

export async function registerRuntimeTools(
  server: McpServer,
  vaultCacheService: VaultCacheService | undefined,
  governedNoteReplaceRuntime: GovernedNoteReplaceRuntime | undefined,
): Promise<void> {
  server.tool(
    "obsidian_runtime_status",
    "Returns the current local runtime status for the shared cache, semantic cache, degraded-mode capabilities, and local process health.",
    {},
    READ_ONLY_TOOL_ANNOTATIONS,
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await collectRuntimeStatus(vaultCacheService),
            null,
            2,
          ),
        },
      ],
      isError: false,
    }),
  );

  server.tool(
    "obsidian_runtime_maintenance",
    "Runs integrity checks, maintenance, or cache refresh actions for the local shared runtime.",
    MaintenanceInputSchema.shape,
    MAINTENANCE_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof MaintenanceInputSchema>) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await runRuntimeMaintenance(params.action, vaultCacheService),
            null,
            2,
          ),
        },
      ],
      isError: false,
    }),
  );

  await registerGovernedNoteReplaceTools(server, governedNoteReplaceRuntime);
  await registerGovernedFrontmatterTools(server, governedNoteReplaceRuntime);
  await registerOperonTools(server);
}
