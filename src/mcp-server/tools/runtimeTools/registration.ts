import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAINTENANCE_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../../toolAnnotations.js";
import {
  collectRuntimeStatus,
  projectPublicRuntimeMaintenanceResult,
  projectPublicRuntimeStatus,
  runRuntimeMaintenance,
} from "../../../services/runtimeState.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/service.js";
import {
  collectCapabilityManifest,
  resolveToolRegistrationMode,
  type CapabilityProbeDependencies,
} from "../../../services/capabilityManifest.js";
import { resolveToolProfile } from "../../toolProfileRuntime.js";
import {
  registerGovernedNoteReplaceTools,
  type GovernedNoteReplaceRuntime,
} from "../governedNoteReplaceTools/index.js";
import { registerGovernedFrontmatterTools } from "../governedFrontmatterTools/index.js";
import { registerGovernedTextPatchTools } from "../governedTextPatchTools/index.js";
import { registerGovernedBaseFormulaTools } from "../governedBaseFormulaTools/index.js";
import type { GovernedBaseFormulaRuntime } from "../../../services/baseFormulaProjectionRuntime.js";
import type { GovernedCanvasRuntime } from "../../../services/canvasProjectionRuntime.js";
import { registerGovernedCanvasTools } from "../governedCanvasTools/index.js";
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

const RuntimeStatusInputSchema = z
  .object({
    // Used by the local stdio proxy only. The backend recomputes its private
    // target proof and returns a boolean, never this challenge or a vault
    // digest. Normal runtime status callers omit it.
    expectedDestructiveVaultAttestation: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

export async function registerRuntimeTools(
  server: McpServer,
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService: VaultCacheService | undefined,
  governedNoteReplaceRuntime: GovernedNoteReplaceRuntime | undefined,
  governedBaseFormulaRuntime: GovernedBaseFormulaRuntime | undefined,
  governedCanvasRuntime: GovernedCanvasRuntime | undefined,
  capabilityProbes?: CapabilityProbeDependencies,
): Promise<void> {
  const profile = resolveToolProfile();
  const registrationMode = resolveToolRegistrationMode(obsidianService);
  server.tool(
    "obsidian_runtime_status",
    "Returns redacted runtime diagnostics plus the versioned capability manifest. The manifest distinguishes tool discoverability, backend availability, and authorization, with stable reason codes and safe next actions. Physical paths, URLs, secrets, note content, and raw configuration are never returned.",
    RuntimeStatusInputSchema.shape,
    READ_ONLY_TOOL_ANNOTATIONS,
    async (params: z.infer<typeof RuntimeStatusInputSchema>) => {
      const runtimeStatus = await collectRuntimeStatus(vaultCacheService);
      const capabilityManifest = await collectCapabilityManifest({
        profile,
        registrationMode,
        runtimeStatus,
        obsidianService,
        vaultCacheAvailable: Boolean(vaultCacheService),
        probes: capabilityProbes,
        governedRuntimes: {
          note: Boolean(governedNoteReplaceRuntime),
          base: Boolean(governedBaseFormulaRuntime),
          canvas: Boolean(governedCanvasRuntime),
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...projectPublicRuntimeStatus(runtimeStatus, {
                  expectedDestructiveVaultAttestation:
                    params.expectedDestructiveVaultAttestation,
                }),
                capabilityManifest,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    },
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
            projectPublicRuntimeMaintenanceResult(
              params.action,
              await runRuntimeMaintenance(params.action, vaultCacheService),
            ),
            null,
            2,
          ),
        },
      ],
      isError: false,
    }),
  );

  await registerGovernedNoteReplaceTools(server, governedNoteReplaceRuntime);
  await registerGovernedTextPatchTools(server, governedNoteReplaceRuntime);
  await registerGovernedFrontmatterTools(server, governedNoteReplaceRuntime);
  await registerGovernedBaseFormulaTools(server, governedBaseFormulaRuntime);
  await registerGovernedCanvasTools(server, governedCanvasRuntime);
  await registerOperonTools(server);
}
