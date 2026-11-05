import { config } from "../config/index.js";
import type { ObsidianRestApiService } from "../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../services/obsidianRestAPI/vaultCache/index.js";
import { OperonService } from "../services/operon/service.js";
import {
  filesystemInstructionsSource,
  InstructionProbeLimiter,
  restInstructionsSource,
  VAULT_INSTRUCTIONS_LIMITS,
  VaultInstructionsReadLedger,
  VaultInstructionsUnavailableError,
  type VaultInstructionsSource,
} from "../services/vaultInstructions.js";
import { VaultInstructionsSealJournal } from "../services/vaultInstructionsSeal.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { logger, requestContextService } from "../utils/index.js";
import type { VaultInstructionsRuntime } from "./vaultInstructionsGate.js";

let runtime: VaultInstructionsRuntime | undefined;
let runtimeKey: unknown;

/**
 * One process-wide runtime per backend: every MCP session of this process
 * shares the read ledger (keyed by reader) and the seal journal.
 */
export function defaultVaultInstructionsRuntime(
  obsidianService: ObsidianRestApiService | undefined,
  vaultCacheService: VaultCacheService | undefined,
): VaultInstructionsRuntime | undefined {
  const key = obsidianService ?? vaultCacheService ?? "none";
  if (runtime && runtimeKey === key) return runtime;
  const context = requestContextService.createRequestContext({
    operation: "vaultInstructionsRuntime",
  });
  let source: VaultInstructionsSource | undefined;
  let refresh: ((vaultPath: string) => Promise<void>) | undefined;
  if (obsidianService) {
    // Raw text, bounded and cancellable: a body that looks like JSON is never
    // parsed, and a body larger than the bound is never buffered whole.
    source = restInstructionsSource(
      async (vaultPath, options) => {
        const result = await obsidianService.readVaultTextBounded(vaultPath, {
          maxBytes: options.maxBytes,
          signal: options.signal,
          timeoutMs: VAULT_INSTRUCTIONS_LIMITS.probeTimeoutMs,
        });
        if (result.status === "not_found") {
          throw new McpError(BaseErrorCode.NOT_FOUND, "Instruction file not found.", {});
        }
        if (result.status === "too_large") {
          throw new VaultInstructionsUnavailableError("too_large");
        }
        return result.body;
      },
      (error) => error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND,
    );
  } else if (config.obsidianVaultPath) {
    source = filesystemInstructionsSource(config.obsidianVaultPath);
    if (vaultCacheService) {
      refresh = (vaultPath) => vaultCacheService.updateCacheForFile(vaultPath, context);
    }
  }
  if (!source) {
    logger.info(
      "Vault instructions are inactive: no Local REST API and no vault folder to read them from.",
      context,
    );
  }
  let seals: VaultInstructionsSealJournal | undefined;
  let sealsFailed = false;
  let operon: OperonService | undefined;
  runtime = {
    settings: {
      defaultMode: config.vaultInstructionsMode,
      minimumMode: config.vaultInstructionsMinimumMode,
      names: config.vaultInstructionsFiles,
      vaultId: config.vaultInstructionsVaultId,
    },
    source,
    ledger: new VaultInstructionsReadLedger(),
    probeLimiter: new InstructionProbeLimiter(VAULT_INSTRUCTIONS_LIMITS.globalConcurrency),
    seals: () => {
      if (seals || sealsFailed) return seals;
      try {
        seals = new VaultInstructionsSealJournal(config.vaultInstructionsJournalPath);
      } catch {
        sealsFailed = true;
        logger.warning("The vault instructions seal journal could not be opened.", context);
      }
      return seals;
    },
    assetFolder: config.assetFolder,
    resolveOperonTaskPath: async (operonId) => {
      operon ??= new OperonService();
      const result = (await operon.getTask({ operonId })) as {
        task?: { path?: unknown };
      };
      return typeof result?.task?.path === "string" ? result.task.path : undefined;
    },
    resolveOperonFileTaskFolder: async () => {
      operon ??= new OperonService();
      return operon.configuredFileTaskFolder();
    },
    refreshCachedInstructionFile: refresh,
  };
  runtimeKey = key;
  return runtime;
}
