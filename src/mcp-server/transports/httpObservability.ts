import { HttpBindings } from "@hono/node-server";
import { Context, Next } from "hono";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { VaultCacheService } from "../../services/obsidianRestAPI/vaultCache/index.js";
import { logger, requestContextService } from "../../utils/index.js";
import { httpAdmissionController } from "./httpBackpressure.js";
import {
  authenticatedIdentityLimiter,
  preAuthSourceLimiter,
} from "./httpProtection.js";
import { getHttpRequestState } from "./httpRequestState.js";

export type ReadinessState = "ready" | "degraded" | "critical";
export type ResponseProvenance =
  | "live-obsidian"
  | "filesystem"
  | "cache"
  | "snapshot"
  | "unknown";

export type HealthDependency = {
  required: boolean;
  available: boolean | null;
  reason?: string;
};

export type HealthSnapshot = {
  schemaVersion: "1";
  state: ReadinessState;
  ready: boolean;
  degraded: boolean;
  critical: boolean;
  timestamp: string;
  processStartedAt: string;
  runtimeMode: string;
  provenance: {
    source: ResponseProvenance;
    origin: "obsidian_api" | "filesystem" | "cache" | "snapshot" | "unknown";
    observedAt: string | null;
    freshnessMs: number | null;
    stale: boolean;
    freshnessKnown: boolean;
  };
  dependencies: {
    obsidianDesktop: HealthDependency;
    filesystemVault: HealthDependency;
    sharedCache: HealthDependency;
  };
  capabilities: {
    liveObsidianReads: boolean;
    filesystemReads: boolean;
    cacheReads: boolean;
    mutations: boolean;
    temporarilyUnavailable: string[];
  };
  reasons: string[];
};

export type HttpSessionStats = {
  active: number;
  pendingInitializations: number;
  activeRequests: number;
  maxSessions: number;
};

type CacheStatsLike = {
  status?: unknown;
  lastRefreshAt?: unknown;
  refreshSource?: unknown;
  totalFiles?: unknown;
  files?: unknown;
  error?: unknown;
  lastError?: unknown;
};

type HealthOptions = {
  vaultCacheService?: VaultCacheService;
  getSessionStats?: () => HttpSessionStats;
  now?: () => number;
  runtimeMode?: string;
  vaultPath?: string;
  cacheSource?: string;
  writeMode?: string;
  staleAfterMs?: number;
};

const ObservabilityEnvSchema = z.object({
  MCP_OBSERVABILITY_STALE_AFTER_MS: z.preprocess(
    (value) =>
      value === undefined || value === null || value === ""
        ? 15 * 60 * 1000
        : value,
    z.coerce.number().int().min(1000).max(30 * 24 * 60 * 60 * 1000),
  ),
});

const parsedObservabilityEnv = ObservabilityEnvSchema.safeParse(process.env);
if (!parsedObservabilityEnv.success) {
  throw new Error(
    `Invalid HTTP observability configuration: ${JSON.stringify(
      parsedObservabilityEnv.error.flatten().fieldErrors,
    )}`,
  );
}

const PROCESS_STARTED_AT = new Date().toISOString();
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function sanitizeExternalCorrelationId(
  value: string | undefined,
): string | undefined {
  const candidate = value?.trim();
  return candidate && SAFE_EXTERNAL_ID.test(candidate) ? candidate : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readCacheStats(
  service: VaultCacheService | undefined,
): { stats?: CacheStatsLike; error?: string } {
  if (!service || typeof service.getStats !== "function") return {};
  try {
    const value = service.getStats() as unknown;
    if (!value || typeof value !== "object" || value instanceof Promise) {
      return { error: "cache_stats_unavailable" };
    }
    return { stats: value as CacheStatsLike };
  } catch (error) {
    return {
      error: error instanceof Error ? error.name : "cache_stats_failed",
    };
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveFileCount(stats: CacheStatsLike | undefined): boolean {
  const candidate = stats?.totalFiles ?? stats?.files;
  if (typeof candidate === "number") return candidate > 0;
  if (Array.isArray(candidate)) return candidate.length > 0;
  return false;
}

function normalizeRuntimeMode(value: string | undefined): string {
  return (value ?? "live").trim().toLowerCase();
}

function normalizeCacheOrigin(
  refreshSource: string | undefined,
  configuredSource: string | undefined,
): HealthSnapshot["provenance"]["origin"] {
  const source = `${refreshSource ?? configuredSource ?? ""}`.toLowerCase();
  if (source.includes("obsidian")) return "obsidian_api";
  if (source.includes("filesystem")) return "filesystem";
  if (source.includes("snapshot")) return "snapshot";
  if (source.includes("cache") || source.includes("sqlite")) return "cache";
  return "unknown";
}

function statusFailed(stats: CacheStatsLike | undefined): boolean {
  const status = nonEmptyString(stats?.status)?.toLowerCase();
  return Boolean(
    status &&
      ["error", "failed", "critical", "unavailable", "invalid"].includes(
        status,
      ),
  );
}

export function buildHealthSnapshot(
  options: HealthOptions = {},
): HealthSnapshot {
  const now = options.now?.() ?? Date.now();
  const runtimeMode = normalizeRuntimeMode(
    options.runtimeMode ?? process.env.OBSIDIAN_RUNTIME_MODE,
  );
  const vaultPath = options.vaultPath ?? process.env.OBSIDIAN_VAULT;
  const cacheSource =
    options.cacheSource ?? process.env.OBSIDIAN_CACHE_SOURCE ?? "";
  const writeMode = (
    options.writeMode ??
    process.env.MCP_WRITE_MODE ??
    "readonly"
  ).toLowerCase();
  const staleAfterMs =
    options.staleAfterMs ??
    parsedObservabilityEnv.data.MCP_OBSERVABILITY_STALE_AFTER_MS;
  const cacheResult = readCacheStats(options.vaultCacheService);
  const stats = cacheResult.stats;
  const observedAtMs = parseTimestamp(stats?.lastRefreshAt);
  const freshnessMs = observedAtMs === undefined ? null : Math.max(0, now - observedAtMs);
  const stale = freshnessMs !== null && freshnessMs > staleAfterMs;
  const origin = normalizeCacheOrigin(
    nonEmptyString(stats?.refreshSource),
    cacheSource,
  );
  const vaultAvailable = Boolean(vaultPath && existsSync(vaultPath));
  const cacheHasData = Boolean(stats && (positiveFileCount(stats) || observedAtMs));
  const cacheAvailable = Boolean(stats && !statusFailed(stats));
  const liveObserved = origin === "obsidian_api" && cacheAvailable && !stale;
  const filesystemObserved =
    origin === "filesystem" ||
    runtimeMode.startsWith("headless") ||
    cacheSource.toLowerCase().includes("filesystem");
  const usableFallback =
    cacheHasData || (filesystemObserved && vaultAvailable) || origin === "snapshot";

  let provenance: ResponseProvenance = "unknown";
  if (liveObserved) provenance = "live-obsidian";
  else if (stale && cacheHasData) provenance = "snapshot";
  else if (origin === "filesystem" && vaultAvailable) provenance = "filesystem";
  else if (cacheHasData) provenance = "cache";
  else if (origin === "snapshot") provenance = "snapshot";

  const headless = runtimeMode.startsWith("headless");
  const hybrid = runtimeMode === "hybrid";
  const reasons: string[] = [];
  let state: ReadinessState;

  if (headless) {
    if (!vaultAvailable && !cacheHasData) {
      state = "critical";
      reasons.push("headless_vault_and_cache_unavailable");
    } else if (stale || statusFailed(stats) || cacheResult.error) {
      state = "degraded";
      reasons.push(
        stale
          ? "fallback_data_stale"
          : cacheResult.error ?? "cache_degraded",
      );
    } else {
      state = "ready";
    }
  } else if (liveObserved) {
    state = "ready";
  } else if (usableFallback || hybrid) {
    state = "degraded";
    reasons.push(
      stale
        ? "live_obsidian_unavailable_using_stale_fallback"
        : "live_obsidian_unverified_using_fallback",
    );
  } else {
    state = "critical";
    reasons.push("no_verified_live_or_fallback_source");
  }

  if (cacheResult.error && !reasons.includes(cacheResult.error)) {
    reasons.push(cacheResult.error);
  }
  if (statusFailed(stats) && !reasons.includes("cache_status_failed")) {
    reasons.push("cache_status_failed");
  }

  const liveRequired = !headless;
  const mutationCapable =
    writeMode !== "readonly" && liveObserved && !runtimeMode.includes("readonly");
  const unavailable: string[] = [];
  if (!liveObserved) unavailable.push("live-obsidian-reads");
  if (!vaultAvailable) unavailable.push("filesystem-reads");
  if (!cacheAvailable && !cacheHasData) unavailable.push("cache-reads");
  if (!mutationCapable) unavailable.push("mutations");

  return {
    schemaVersion: "1",
    state,
    ready: state !== "critical",
    degraded: state === "degraded",
    critical: state === "critical",
    timestamp: new Date(now).toISOString(),
    processStartedAt: PROCESS_STARTED_AT,
    runtimeMode,
    provenance: {
      source: provenance,
      origin,
      observedAt:
        observedAtMs === undefined ? null : new Date(observedAtMs).toISOString(),
      freshnessMs,
      stale,
      freshnessKnown: freshnessMs !== null,
    },
    dependencies: {
      obsidianDesktop: {
        required: liveRequired,
        available: liveObserved ? true : liveRequired ? null : false,
        reason: liveObserved
          ? undefined
          : liveRequired
            ? "live_dependency_not_verified"
            : "not_required_by_headless_profile",
      },
      filesystemVault: {
        required: headless,
        available: vaultAvailable,
        reason: vaultAvailable ? undefined : "configured_vault_unavailable",
      },
      sharedCache: {
        required: headless || hybrid,
        available: cacheAvailable || cacheHasData,
        reason:
          cacheAvailable || cacheHasData
            ? undefined
            : cacheResult.error ?? "cache_not_initialized",
      },
    },
    capabilities: {
      liveObsidianReads: liveObserved,
      filesystemReads: vaultAvailable,
      cacheReads: cacheAvailable || cacheHasData,
      mutations: mutationCapable,
      temporarilyUnavailable: unavailable,
    },
    reasons,
  };
}

function summarizeResult(status: number): string {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  if (status >= 300) return "redirect";
  return "success";
}

export function createHttpObservability(options: HealthOptions = {}) {
  const healthSnapshot = () => buildHealthSnapshot(options);

  const requestLoggingMiddleware = async (
    c: Context<{ Bindings: HttpBindings }>,
    next: Next,
  ): Promise<void> => {
    const state = getHttpRequestState(c.req.raw);
    state.correlationId = sanitizeExternalCorrelationId(
      c.req.header("x-correlation-id"),
    );
    state.incidentId = sanitizeExternalCorrelationId(
      c.req.header("x-incident-id"),
    );
    let thrown: unknown;
    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const snapshot = healthSnapshot();
      const durationMs = Math.max(0, Date.now() - state.startedAt);
      logger.info(
        "HTTP request completed.",
        requestContextService.createRequestContext({
          requestId: state.requestId,
          operation:
            state.admission?.operationName ?? `${c.req.method} ${c.req.path}`,
          clientIdentity: state.identity?.pseudonym,
          transport: "streamable-http",
          httpMethod: c.req.method,
          httpRoute: c.req.path,
          durationMs,
          result: thrown ? "exception" : summarizeResult(c.res.status),
          httpStatus: thrown ? 500 : c.res.status,
          quotaStatus: state.quotas.map((quota) => ({
            scope: quota.scope,
            outcome: quota.outcome,
            remaining: quota.remaining,
          })),
          backpressureStatus: state.admission?.outcome,
          operationClass: state.admission?.operationClass,
          queueWaitMs: state.admission?.waitMs,
          provenance: snapshot.provenance.source,
          stale: snapshot.provenance.stale,
          correlationId: state.correlationId,
          incidentId: state.incidentId,
        }),
      );
    }
  };

  const livenessHandler = (c: Context) =>
    c.json({
      ok: true,
      status: "healthy",
      state: "live",
      timestamp: new Date().toISOString(),
      transport: "streamable-http",
      endpoint: "/mcp",
    });

  const readinessHandler = (c: Context) => {
    const snapshot = healthSnapshot();
    return snapshot.ready ? c.json(snapshot, 200) : c.json(snapshot, 503);
  };

  const statusHandler = (c: Context) => {
    const snapshot = healthSnapshot();
    const controls = {
      sessions: options.getSessionStats?.() ?? null,
      admission: httpAdmissionController.getSnapshot(),
      rateLimits: {
        sourceAddresses: preAuthSourceLimiter.getStats(),
        clientIdentities: authenticatedIdentityLimiter.getStats(),
      },
    };
    return c.json({ ...snapshot, controls });
  };

  return {
    healthSnapshot,
    requestLoggingMiddleware,
    livenessHandler,
    readinessHandler,
    statusHandler,
  };
}
