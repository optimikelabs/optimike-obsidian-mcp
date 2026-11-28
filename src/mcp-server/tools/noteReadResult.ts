import { config } from "../../config/index.js";
import type { VaultCacheService } from "../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { publicMcpToolErrorPayload } from "../../utils/internal/errorHandler.js";

export async function noteReadResult(
  read: () => Promise<object>,
  cache: VaultCacheService | undefined,
  errorContext: Parameters<typeof publicMcpToolErrorPayload>[1],
) {
  const headlessCache = config.obsidianRuntimeMode.startsWith("headless-")
    ? cache
    : undefined;
  const before = headlessCache?.getRefreshEvidence();
  let payload: object;
  let isError = false;
  try {
    payload = await read();
  } catch (error) {
    if (
      !before ||
      !(error instanceof McpError) ||
      error.code !== BaseErrorCode.SERVICE_UNAVAILABLE
    ) {
      throw error;
    }
    payload = publicMcpToolErrorPayload(error, errorContext);
    isError = true;
  }

  const after = headlessCache?.getRefreshEvidence();
  if (before && after) {
    const refreshing = before.refreshing || after.refreshing ||
      before.generation !== after.generation;
    const direct = "readPath" in payload && payload.readPath === "direct-filesystem";
    // An exact disk read has its own observation time. The inventory checkpoint
    // applies to cached results and incomplete requests.
    const freshness = direct
      ? { partial: false }
      : {
          lastRefreshAt: after.lastRefreshAt,
          lastSuccessfulRefreshStartedAt: after.lastSuccessfulRefreshStartedAt,
          refreshOrigin: after.refreshOrigin,
          ...(!before.ready || !after.ready || refreshing ? { partial: true } : {}),
        };
    payload = {
      ...payload,
      provenance: {
        source: "filesystem",
        upstreamSync: "unknown",
        ...(refreshing ? { refreshing: true } : {}),
        ...freshness,
      },
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}
