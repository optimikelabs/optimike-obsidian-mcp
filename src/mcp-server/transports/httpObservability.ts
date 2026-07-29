import { HttpBindings } from "@hono/node-server";
import { Context, Next } from "hono";
import { existsSync } from "node:fs";
import { z } from "zod";
import { config } from "../../config/index.js";
import type { VaultCacheService } from "../../services/obsidianRestAPI/vaultCache/index.js";
import { logger, requestContextService } from "../../utils/index.js";
import { httpAdmissionController } from "./httpBackpressure.js";
import {
  authenticatedIdentityLimiter,
  preAuthSourceLimiter,
} from "./httpProtection.js";
import { httpErrorHandler } from "./httpErrorHandler.js";
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
  ready?: unknown;
  building?: unknown;
  lastRefreshAt?: unknown;
  lastRefreshError?: unknown;
  refreshSource?: unknown;
  configuredRefreshSource?: unknown;
  totalFiles?: unknown;
  files?: unknown;
  cachedFileCount?: unknown;
  inMemoryFileCount?: unknown;
  error?: unknown;
  lastError?: unknown;
};

export type LiveApiObservation = {
  available: boolean | null;
  observedAt?: number | string | Date;
};

type HealthOptions = {
  vaultCacheService?: VaultCacheService;
  getLiveApiObservation?: () => LiveApiObservation;
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
    z.coerce
      .number()
      .int()
      .min(1000)
      .max(30 * 24 * 60 * 60 * 1000),
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
const observabilityEnv = parsedObservabilityEnv.data;
export const HTTP_OBSERVABILITY_STALE_AFTER_MS =
  observabilityEnv.MCP_OBSERVABILITY_STALE_AFTER_MS;

const PROCESS_STARTED_AT = new Date().toISOString();
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_OPERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const KNOWN_HTTP_ROUTES = new Set([
  "/external-handoff",
  "/healthz",
  "/mcp",
  "/readyz",
  "/statusz",
]);
const KNOWN_HTTP_METHODS = new Set(["DELETE", "GET", "OPTIONS", "POST"]);

export function sanitizeExternalCorrelationId(
  value: string | undefined,
): string | undefined {
  const candidate = value?.trim();
  return candidate && SAFE_EXTERNAL_ID.test(candidate) ? candidate : undefined;
}

export function sanitizeLoggedOperationName(
  value: string | undefined,
): string | undefined {
  const candidate = value?.trim();
  return candidate && SAFE_OPERATION_NAME.test(candidate)
    ? candidate
    : undefined;
}

function safeHttpRoute(path: string): string {
  return KNOWN_HTTP_ROUTES.has(path) ? path : "unmatched-route";
}

function safeHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return KNOWN_HTTP_METHODS.has(normalized) ? normalized : "HTTP";
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

function readCacheStats(service: VaultCacheService | undefined): {
  stats?: CacheStatsLike;
  error?: string;
} {
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
  const candidate =
    stats?.cachedFileCount ??
    stats?.inMemoryFileCount ??
    stats?.totalFiles ??
    stats?.files;
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
  const source = `${refreshSource ?? configuredSource ?? ""}`
    .trim()
    .toLowerCase();
  if (source === "rest" || source.includes("obsidian")) return "obsidian_api";
  if (source.includes("filesystem")) return "filesystem";
  if (source.includes("snapshot")) return "snapshot";
  if (source.includes("cache") || source.includes("sqlite")) return "cache";
  return "unknown";
}

function cacheIsReady(stats: CacheStatsLike | undefined): boolean {
  const status = nonEmptyString(stats?.status)?.toLowerCase();
  return stats?.ready === true || status === "ready";
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
  const writeMode = (options.writeMode ?? config.mcpWriteMode).toLowerCase();
  const staleAfterMs =
    options.staleAfterMs ?? HTTP_OBSERVABILITY_STALE_AFTER_MS;
  const cacheResult = readCacheStats(options.vaultCacheService);
  const stats = cacheResult.stats;
  const cacheObservedAtMs = parseTimestamp(stats?.lastRefreshAt);
  const cacheFreshnessMs =
    cacheObservedAtMs === undefined
      ? null
      : Math.max(0, now - cacheObservedAtMs);
  const cacheStale =
    cacheFreshnessMs !== null && cacheFreshnessMs > staleAfterMs;
  let liveApiObservation: LiveApiObservation = { available: null };
  try {
    liveApiObservation =
      options.getLiveApiObservation?.() ?? liveApiObservation;
  } catch {
    liveApiObservation = { available: null };
  }
  const liveApiObservedAtMs = parseTimestamp(liveApiObservation.observedAt);
  const liveApiFreshnessMs =
    liveApiObservedAtMs === undefined
      ? null
      : Math.max(0, now - liveApiObservedAtMs);
  const liveApiStale =
    liveApiFreshnessMs !== null && liveApiFreshnessMs > staleAfterMs;
  const origin = normalizeCacheOrigin(
    nonEmptyString(stats?.refreshSource),
    nonEmptyString(stats?.configuredRefreshSource) ?? cacheSource,
  );
  const vaultAvailable = Boolean(vaultPath && existsSync(vaultPath));
  const cacheHasData = Boolean(
    stats && (positiveFileCount(stats) || cacheObservedAtMs),
  );
  const cacheReady = cacheIsReady(stats);
  const cacheRefreshFailed = Boolean(
    nonEmptyString(stats?.lastRefreshError) ?? nonEmptyString(stats?.lastError),
  );
  const cacheLiveObserved =
    origin === "obsidian_api" &&
    cacheReady &&
    cacheFreshnessMs !== null &&
    !cacheStale &&
    !cacheRefreshFailed;
  const directLiveObserved =
    liveApiObservation.available === true &&
    liveApiFreshnessMs !== null &&
    !liveApiStale;
  const liveObserved = directLiveObserved || cacheLiveObserved;
  const filesystemObserved =
    origin === "filesystem" ||
    runtimeMode.startsWith("headless") ||
    cacheSource.toLowerCase().includes("filesystem");
  const filesystemReads = filesystemObserved && vaultAvailable && cacheReady;
  const usableFallback =
    cacheReady &&
    (cacheHasData ||
      (filesystemObserved && vaultAvailable) ||
      origin === "snapshot");

  let provenance: ResponseProvenance = "unknown";
  if (liveObserved) provenance = "live-obsidian";
  else if (cacheReady && cacheStale && cacheHasData) provenance = "snapshot";
  else if (cacheReady && origin === "filesystem" && vaultAvailable) {
    provenance = "filesystem";
  } else if (cacheReady && cacheHasData) provenance = "cache";
  else if (cacheReady && origin === "snapshot") provenance = "snapshot";

  const headless = runtimeMode.startsWith("headless");
  const reasons: string[] = [];
  let state: ReadinessState;

  if (headless) {
    if (!vaultAvailable) {
      state = "critical";
      reasons.push("headless_vault_and_cache_unavailable");
    } else if (!cacheReady) {
      state = "critical";
      reasons.push("headless_cache_unavailable");
    } else if (
      cacheStale ||
      cacheRefreshFailed ||
      statusFailed(stats) ||
      cacheResult.error
    ) {
      state = "degraded";
      reasons.push(
        cacheStale
          ? "fallback_data_stale"
          : cacheRefreshFailed
            ? "cache_refresh_failed"
            : (cacheResult.error ?? "cache_degraded"),
      );
    } else {
      state = "ready";
    }
  } else if (liveObserved) {
    state = "ready";
  } else if (usableFallback) {
    state = "degraded";
    reasons.push(
      cacheStale
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
  if (cacheRefreshFailed && !reasons.includes("cache_refresh_failed")) {
    reasons.push("cache_refresh_failed");
    if (state === "ready") state = "degraded";
  }

  const liveRequired = !headless;
  const mutationCapable =
    writeMode !== "readonly" &&
    liveObserved &&
    !runtimeMode.includes("readonly");
  const unavailable: string[] = [];
  if (!liveObserved) unavailable.push("live-obsidian-reads");
  if (!filesystemReads) unavailable.push("filesystem-reads");
  if (!cacheReady) unavailable.push("cache-reads");
  if (!mutationCapable) unavailable.push("mutations");
  const selectedObservedAtMs = directLiveObserved
    ? liveApiObservedAtMs
    : cacheObservedAtMs;
  const selectedFreshnessMs = directLiveObserved
    ? liveApiFreshnessMs
    : cacheFreshnessMs;
  const selectedStale = directLiveObserved ? liveApiStale : cacheStale;

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
      origin: directLiveObserved ? "obsidian_api" : origin,
      observedAt:
        selectedObservedAtMs === undefined
          ? null
          : new Date(selectedObservedAtMs).toISOString(),
      freshnessMs: selectedFreshnessMs,
      stale: selectedStale,
      freshnessKnown: selectedFreshnessMs !== null,
    },
    dependencies: {
      obsidianDesktop: {
        required: liveRequired,
        available: liveObserved
          ? true
          : liveRequired
            ? liveApiObservation.available
            : false,
        reason: liveObserved
          ? undefined
          : liveRequired
            ? liveApiObservation.available === false
              ? "live_dependency_unavailable"
              : "live_dependency_not_verified"
            : "not_required_by_headless_profile",
      },
      filesystemVault: {
        required: headless,
        available: vaultAvailable,
        reason: vaultAvailable ? undefined : "configured_vault_unavailable",
      },
      sharedCache: {
        required: headless,
        available: cacheReady,
        reason: cacheReady
          ? undefined
          : (cacheResult.error ??
            (stats?.building === true
              ? "cache_building"
              : "cache_not_initialized")),
      },
    },
    capabilities: {
      liveObsidianReads: liveObserved,
      filesystemReads,
      cacheReads: cacheReady,
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

type ResponseCompletion = "response" | "cancelled" | "exception";

export function wrapResponseForCompletion(
  response: Response,
  onComplete: (completion: ResponseCompletion) => void,
): Response {
  let completed = false;
  const complete = (completion: ResponseCompletion) => {
    if (completed) return;
    completed = true;
    onComplete(completion);
  };

  if (!response.body) {
    complete("response");
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          complete("response");
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        complete("exception");
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        complete("cancelled");
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createHttpObservability(options: HealthOptions = {}) {
  const healthSnapshot = () => buildHealthSnapshot(options);

  const requestLoggingMiddleware = async (
    c: Context<{ Bindings: HttpBindings }>,
    next: Next,
  ): Promise<void | Response> => {
    const state = getHttpRequestState(c.req.raw);
    state.correlationId = sanitizeExternalCorrelationId(
      c.req.header("x-correlation-id"),
    );
    state.incidentId = sanitizeExternalCorrelationId(
      c.req.header("x-incident-id"),
    );
    const logCompletion = (completion: ResponseCompletion, status: number) => {
      const snapshot = healthSnapshot();
      const durationMs = Math.max(0, Date.now() - state.startedAt);
      const httpMethod = safeHttpMethod(c.req.method);
      const httpRoute = safeHttpRoute(c.req.path);
      const operation =
        sanitizeLoggedOperationName(state.admission?.operationName) ??
        `${httpMethod} ${httpRoute}`;
      logger.info(
        "HTTP request completed.",
        requestContextService.createRequestContext({
          requestId: state.requestId,
          operation,
          clientIdentity: state.identity?.pseudonym,
          transport: "streamable-http",
          httpMethod,
          httpRoute,
          durationMs,
          result:
            completion === "response" ? summarizeResult(status) : completion,
          // A body-stream failure happens after the response status may already
          // be on the wire. Preserve that status and use result=exception to
          // represent the later stream failure.
          httpStatus: status,
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
    };

    try {
      await next();
      const response = c.res;
      c.res = wrapResponseForCompletion(response, (completion) =>
        logCompletion(completion, response.status),
      );
    } catch (error) {
      // Hono's top-level onError hook runs after middleware unwinds. Map the
      // error here so its actual wire response follows the same body-completion
      // lifecycle and reports the mapped status instead of a premature 500.
      const response = await httpErrorHandler(
        error instanceof Error
          ? error
          : new Error("Unknown HTTP transport error."),
        c,
      );
      const wrapped = wrapResponseForCompletion(response, (completion) =>
        logCompletion(completion, response.status),
      );
      c.res = wrapped;
      return wrapped;
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
