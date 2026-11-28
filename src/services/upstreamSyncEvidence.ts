import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod/v3";
import { config } from "../config/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import type { RequestContext } from "../utils/index.js";

const timestamp = z.string().datetime({ precision: 3 }).refine(
  value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
);
const receiptSchema = z.object({
  version: z.literal(1),
  heartbeatAt: timestamp,
  state: z.enum(["ok", "running", "error"]),
  lastSuccessfulPull: z.object({ startedAt: timestamp, completedAt: timestamp }).nullable(),
});
export const upstreamSyncSchema = z.object({
  upstreamSync: z.enum(["current", "lagging", "stalled", "error", "unknown"]),
  lastSuccessfulPullAt: timestamp.nullable(),
  lagSecondsUpperBound: z.number().int().nonnegative().safe().nullable(),
  evidenceSource: z.literal("heartbeat-file").nullable(),
});

export const unknownUpstreamSync = {
  upstreamSync: "unknown",
  lastSuccessfulPullAt: null,
  lagSecondsUpperBound: null,
  evidenceSource: null,
} as const;

export type SyncEvidenceSource = {
  id: UpstreamSyncEvidence["evidenceSource"] & string;
  read(): Promise<unknown>;
};

export type UpstreamSyncEvidence = z.infer<typeof upstreamSyncSchema>;

export function heartbeatFileSource(filename: string): SyncEvidenceSource {
  return {
    id: "heartbeat-file",
    async read() {
      const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      try {
        const buffer = Buffer.alloc(4097);
        if (!(await file.stat()).isFile()) return;
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead < buffer.length) return JSON.parse(buffer.toString("utf8", 0, bytesRead));
      } finally {
        await file.close();
      }
    },
  };
}

export async function observeUpstreamSync(
  source: SyncEvidenceSource | undefined,
  thresholds: { currentSeconds: number; stallSeconds: number },
  now = Date.now,
): Promise<UpstreamSyncEvidence> {
  const unknown: UpstreamSyncEvidence = {
    ...unknownUpstreamSync,
    evidenceSource: source?.id ?? null,
  };
  const raw = await source?.read().catch(() => undefined);
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return unknown;
  const { heartbeatAt, state, lastSuccessfulPull } = parsed.data;
  const observedAt = now();
  const heartbeat = Date.parse(heartbeatAt);
  const started = lastSuccessfulPull ? Date.parse(lastSuccessfulPull.startedAt) : null;
  const completed = lastSuccessfulPull ? Date.parse(lastSuccessfulPull.completedAt) : null;
  if (heartbeat > observedAt || (started !== null && completed !== null &&
      (started > completed || completed > heartbeat))) return unknown;

  const age = started === null ? null : Math.ceil((observedAt - started) / 1000);
  let upstreamSync: UpstreamSyncEvidence["upstreamSync"] = "unknown";
  if (observedAt - heartbeat > thresholds.stallSeconds * 1000) upstreamSync = "stalled";
  else if (state === "error") upstreamSync = "error";
  else if (age !== null) upstreamSync = age > thresholds.currentSeconds ? "lagging" : "current";
  return {
    upstreamSync,
    lastSuccessfulPullAt: lastSuccessfulPull?.completedAt ?? null,
    lagSecondsUpperBound: age,
    evidenceSource: unknown.evidenceSource,
  };
}

export function readUpstreamSync(): Promise<UpstreamSyncEvidence> {
  return observeUpstreamSync(
    config.upstreamSyncHeartbeatFile ? heartbeatFileSource(config.upstreamSyncHeartbeatFile) : undefined,
    { currentSeconds: config.upstreamSyncCurrentSeconds, stallSeconds: config.upstreamSyncStallSeconds },
  );
}

export function isSyncConflictPath(relative: string): boolean {
  return !/[:\\\x00-\x1f]/u.test(relative) &&
    relative.split("/").every(part => part && part !== "." && part !== "..") &&
    / \(Conflicted copy [^/]+ \d{12}\)\.md$/u.test(relative);
}

export async function assertHeadlessSyncWriteAllowed(context: RequestContext): Promise<void> {
  const maximumAge = config.upstreamSyncWriteMaxAgeSeconds;
  if (maximumAge === undefined || !config.obsidianRuntimeMode.startsWith("headless-")) return;
  const evidence = await readUpstreamSync();
  if (["unknown", "stalled", "error"].includes(evidence.upstreamSync) ||
      evidence.lagSecondsUpperBound === null || evidence.lagSecondsUpperBound > maximumAge) {
    throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, "Headless write blocked by upstream Sync freshness.", {
      ...context, reasonCode: "upstream_sync_write_blocked",
    });
  }
}
