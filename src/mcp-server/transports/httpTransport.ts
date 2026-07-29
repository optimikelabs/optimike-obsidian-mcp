/**
 * @fileoverview Configures and starts the Streamable HTTP MCP transport using Hono.
 *
 * The HTTP boundary applies two independent protections:
 *
 * 1. a bounded pre-authentication source-address limiter;
 * 2. a bounded functional limiter keyed by verified authentication claims.
 *
 * Proxy headers are ignored unless the immediate peer belongs to the explicit
 * `MCP_TRUSTED_PROXIES` allowlist. MCP sessions are bound to the verified identity
 * that initialized them. Raw bearer tokens are never used as keys or log fields.
 *
 * @module src/mcp-server/transports/httpTransport
 */

import { HttpBindings, serve, ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Context, Hono, Next } from "hono";
import { cors } from "hono/cors";
import http from "http";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { ExternalRootError } from "../../services/externalRootsService.js";
import {
  externalHandoffResponse,
  externalHandoffEndpoint,
  externalHandoffTicketHeader,
  externalTransferBroker,
} from "../../services/externalTransferBroker.js";
import type { VaultCacheService } from "../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../utils/index.js";
import {
  jwtAuthMiddleware,
  oauthMiddleware,
  type AuthInfo,
} from "./auth/index.js";
import {
  createHttpBackpressureMiddleware,
  createHttpRequestBodyGuardMiddleware,
} from "./httpBackpressure.js";
import { httpErrorHandler } from "./httpErrorHandler.js";
import {
  authenticatedIdentityLimiter,
  deriveVerifiedHttpIdentity,
  httpProtectionConfig,
  isLoopbackAddress,
  preAuthSourceLimiter,
  pseudonymizeClientAddress,
  type RateLimitDecision,
  resolveClientAddress,
} from "./httpProtection.js";
import {
  getHttpRequestState,
  type HttpQuotaState,
  type VerifiedHttpIdentity,
} from "./httpRequestState.js";

const HTTP_PORT = config.mcpHttpPort;
const HTTP_HOST = config.mcpHttpHost;
const MCP_ENDPOINT_PATH = "/mcp";
const MAX_PORT_RETRIES = parsePortRetries();
const httpRequestBodyGuardMiddleware = createHttpRequestBodyGuardMiddleware();
const httpBackpressureMiddleware = createHttpBackpressureMiddleware();

type HttpSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  identityKey: string;
  identityPseudonym: string;
  createdAt: number;
  lastSeenAt: number;
  activeRequests: number;
};

type SessionCapacityReservation = {
  release: () => void;
};

// The session store is intentionally process-local. Registered sessions plus
// initialization reservations are both bounded by MCP_HTTP_MAX_SESSIONS.
const transports = new Map<string, HttpSession>();
let pendingSessionInitializations = 0;

function parsePortRetries(): number {
  const raw = process.env.MCP_HTTP_PORT_RETRIES ?? "0";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new Error(
      "MCP_HTTP_PORT_RETRIES must be an integer between 0 and 15.",
    );
  }
  return value;
}

function originAllowed(origin: string): boolean {
  return (config.mcpAllowedOrigins ?? []).includes(origin);
}

async function authMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
): Promise<void | Response> {
  return config.mcpAuthMode === "oauth"
    ? oauthMiddleware(c, next)
    : jwtAuthMiddleware(c, next);
}

function quotaState(
  scope: HttpQuotaState["scope"],
  decision: RateLimitDecision,
): HttpQuotaState {
  return {
    scope,
    limit: decision.limit,
    remaining: decision.remaining,
    resetAt: decision.resetAt,
    outcome: decision.outcome,
  };
}

function jsonRpcIdFromBody(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

async function requestJsonRpcId(c: Context): Promise<string | number | null> {
  if (c.req.method !== "POST") return null;
  try {
    return jsonRpcIdFromBody(await c.req.raw.clone().json());
  } catch {
    return null;
  }
}

async function rateLimitResponse(
  c: Context,
  scope: HttpQuotaState["scope"],
  decision: RateLimitDecision,
): Promise<Response> {
  const requestState = getHttpRequestState(c.req.raw);
  const preAuthRejection = scope !== "client-identity";
  const rpcId = preAuthRejection ? null : await requestJsonRpcId(c);
  if (preAuthRejection && c.req.method === "POST") {
    // Source limiting runs before the request-body guard. Never clone or parse
    // an untrusted body on this rejection path; cancel it instead.
    void c.req.raw.body
      ?.cancel("pre-authentication source rate limit")
      .catch(() => undefined);
  }
  c.header("Retry-After", String(decision.retryAfterSeconds));
  c.header("RateLimit-Limit", String(decision.limit));
  c.header("RateLimit-Remaining", String(decision.remaining));
  c.header("RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
  c.header("X-Optimike-Rate-Limit-Scope", scope);
  c.header("X-Request-Id", requestState.requestId);

  logger.warning(
    "HTTP request rejected by bounded rate limiting.",
    requestContextService.createRequestContext({
      requestId: requestState.requestId,
      operation: "httpRateLimitRejected",
      scope,
      outcome: decision.outcome,
      retryAfterSeconds: decision.retryAfterSeconds,
      clientIdentity: requestState.identity?.pseudonym,
      sourceAddress: requestState.clientAddress
        ? pseudonymizeClientAddress(requestState.clientAddress)
        : undefined,
    }),
  );

  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: BaseErrorCode.RATE_LIMITED,
        message:
          decision.outcome === "capacity"
            ? "Rate-limit state capacity is temporarily exhausted."
            : "Rate limit exceeded.",
      },
      id: rpcId,
    },
    429,
  );
}

async function preAuthRateLimitMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
): Promise<void | Response> {
  const requestState = getHttpRequestState(c.req.raw);
  const address = resolveClientAddress({
    remoteAddress: c.env.incoming.socket.remoteAddress,
    forwarded: c.req.header("forwarded"),
    xForwardedFor: c.req.header("x-forwarded-for"),
  });
  requestState.clientAddress = address.address;
  requestState.clientAddressSource = address.source;
  requestState.trustedProxyHeaders = address.trustedProxyHeaders;

  const loopback = isLoopbackAddress(address.address);
  const scope: HttpQuotaState["scope"] = loopback
    ? "loopback-source-ip"
    : "source-ip";
  const maxRequests =
    loopback && httpProtectionConfig.loopbackPolicy === "elevated"
      ? httpProtectionConfig.loopbackPreAuthMaxRequests
      : httpProtectionConfig.preAuthMaxRequests;
  const decision = preAuthSourceLimiter.check(
    pseudonymizeClientAddress(address.address),
    maxRequests,
  );
  requestState.quotas.push(quotaState(scope, decision));
  if (!decision.allowed) {
    return rateLimitResponse(c, scope, decision);
  }
  await next();
}

function attachVerifiedIdentity(
  c: Context<{ Bindings: HttpBindings }>,
): VerifiedHttpIdentity {
  const authInfo = c.env.incoming.auth as AuthInfo | undefined;
  if (!authInfo) {
    throw new McpError(
      BaseErrorCode.UNAUTHORIZED,
      "A verified client identity is required for Streamable HTTP.",
    );
  }

  const requestState = getHttpRequestState(c.req.raw);
  const identity =
    requestState.identity ?? deriveVerifiedHttpIdentity(authInfo);
  requestState.authInfo = authInfo;
  requestState.identity = identity;
  return identity;
}

async function verifiedIdentityMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
): Promise<void> {
  attachVerifiedIdentity(c);
  await next();
}

async function authenticatedIdentityRateLimitMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
): Promise<void | Response> {
  const requestState = getHttpRequestState(c.req.raw);
  const identity = attachVerifiedIdentity(c);
  const decision = authenticatedIdentityLimiter.check(identity.key);
  requestState.quotas.push(quotaState("client-identity", decision));
  if (!decision.allowed) {
    return rateLimitResponse(c, "client-identity", decision);
  }
  await next();
}

function requireIdentity(c: Context): VerifiedHttpIdentity {
  const identity = getHttpRequestState(c.req.raw).identity;
  if (!identity) {
    throw new McpError(
      BaseErrorCode.UNAUTHORIZED,
      "Verified client identity is unavailable.",
    );
  }
  return identity;
}

function sessionExpired(session: HttpSession, now: number): boolean {
  const maxLifetimeExpired =
    now - session.createdAt >= httpProtectionConfig.sessionMaxLifetimeMs;
  if (maxLifetimeExpired) return true;
  return (
    session.activeRequests === 0 &&
    now - session.lastSeenAt >= httpProtectionConfig.sessionIdleTimeoutMs
  );
}

function expireStaleSessions(now = Date.now()): number {
  let expired = 0;
  for (const [sessionId, session] of transports) {
    if (!sessionExpired(session, now)) continue;
    transports.delete(sessionId);
    expired += 1;
    void session.transport.close().catch((error) => {
      logger.warning(
        "Expired HTTP session failed to close cleanly.",
        requestContextService.createRequestContext({
          operation: "expireHttpSession",
          clientIdentity: session.identityPseudonym,
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      );
    });
  }
  if (expired > 0) {
    logger.info(
      "Expired abandoned HTTP sessions.",
      requestContextService.createRequestContext({
        operation: "expireHttpSessions",
        expiredSessionCount: expired,
        sessionCount: transports.size,
      }),
    );
  }
  return expired;
}

function reserveSessionCapacity(): SessionCapacityReservation | undefined {
  expireStaleSessions();
  if (
    transports.size + pendingSessionInitializations >=
    httpProtectionConfig.maxSessions
  ) {
    return undefined;
  }
  pendingSessionInitializations += 1;
  let active = true;
  return {
    release: () => {
      if (!active) return;
      active = false;
      pendingSessionInitializations = Math.max(
        0,
        pendingSessionInitializations - 1,
      );
    },
  };
}

function sessionForRequest(
  c: Context,
  sessionId: string | undefined,
): HttpSession | undefined {
  if (!sessionId) return undefined;
  const now = Date.now();
  expireStaleSessions(now);
  const session = transports.get(sessionId);
  if (!session) return undefined;
  const identity = requireIdentity(c);
  if (session.identityKey !== identity.key) {
    logger.warning(
      "HTTP session identity mismatch rejected.",
      requestContextService.createRequestContext({
        requestId: getHttpRequestState(c.req.raw).requestId,
        operation: "httpSessionIdentityMismatch",
        clientIdentity: identity.pseudonym,
      }),
    );
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      "Invalid or expired session ID.",
    );
  }
  session.lastSeenAt = now;
  return session;
}

function finishSessionActivity(session: HttpSession): void {
  session.activeRequests = Math.max(0, session.activeRequests - 1);
  session.lastSeenAt = Date.now();
}

function wrapSessionResponse(
  session: HttpSession,
  response: Response,
): Response {
  if (!response.body) {
    finishSessionActivity(session);
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    finishSessionActivity(session);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function handleWithSessionActivity(
  session: HttpSession,
  operation: () => Promise<Response>,
  alreadyActive = false,
): Promise<Response> {
  if (!alreadyActive) {
    session.activeRequests += 1;
    session.lastSeenAt = Date.now();
  }
  try {
    return wrapSessionResponse(session, await operation());
  } catch (error) {
    finishSessionActivity(session);
    throw error;
  }
}

function sessionCapacityResponse(c: Context, body: unknown): Response {
  const state = getHttpRequestState(c.req.raw);
  c.header("Retry-After", "1");
  c.header("X-Request-Id", state.requestId);
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: BaseErrorCode.SERVICE_UNAVAILABLE,
        message: "HTTP session capacity is temporarily exhausted.",
      },
      id: jsonRpcIdFromBody(body),
    },
    503,
  );
}

async function isPortInUse(
  port: number,
  host: string,
  parentContext: RequestContext,
): Promise<boolean> {
  requestContextService.createRequestContext({
    ...parentContext,
    operation: "isPortInUse",
    port,
    host,
  });
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE");
      })
      .once("listening", () => {
        tempServer.close(() => resolve(false));
      })
      .listen(port, host);
  });
}

function startHttpServerWithRetry(
  app: Hono<{ Bindings: HttpBindings }>,
  initialPort: number,
  host: string,
  maxRetries: number,
  parentContext: RequestContext,
): Promise<ServerType> {
  const startContext = requestContextService.createRequestContext({
    ...parentContext,
    operation: "startHttpServerWithRetry",
  });

  return new Promise(async (resolve, reject) => {
    for (let i = 0; i <= maxRetries; i++) {
      const currentPort = initialPort + i;
      const attemptContext = {
        ...startContext,
        port: currentPort,
        attempt: i + 1,
      };

      if (await isPortInUse(currentPort, host, attemptContext)) {
        logger.warning(`Port ${currentPort} is in use.`, attemptContext);
        continue;
      }

      try {
        const serverInstance = serve(
          { fetch: app.fetch, port: currentPort, hostname: host },
          (info: { address: string; port: number }) => {
            const serverAddress = `http://${info.address}:${info.port}${MCP_ENDPOINT_PATH}`;
            logger.info(`HTTP transport listening at ${serverAddress}`, {
              ...attemptContext,
              address: serverAddress,
            });
            if (process.stdout.isTTY) {
              console.log(`\n🚀 MCP Server running at: ${serverAddress}\n`);
            }
          },
        );
        resolve(serverInstance);
        return;
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          reject(err);
          return;
        }
      }
    }
    reject(
      new Error(
        `Failed to bind HTTP transport at ${host}:${initialPort}${
          maxRetries > 0 ? ` through ${initialPort + maxRetries}` : ""
        }.`,
      ),
    );
  });
}

export async function startHttpTransport(
  createServerInstanceFn: () => Promise<McpServer>,
  parentContext: RequestContext,
  _vaultCacheService?: VaultCacheService,
): Promise<ServerType> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const transportContext = requestContextService.createRequestContext({
    ...parentContext,
    component: "HttpTransportSetup",
  });

  app.use("*", async (c: Context, next: Next) => {
    const origin = c.req.header("origin");
    if (origin && !originAllowed(origin)) {
      return c.json(
        { error: "origin_not_allowed", message: "Origin is not allowed." },
        403,
      );
    }
    await next();
  });

  app.use(
    "*",
    cors({
      origin: config.mcpAllowedOrigins || [],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Mcp-Session-Id",
        "Last-Event-ID",
        "Authorization",
        externalHandoffTicketHeader,
      ],
      exposeHeaders: [
        "Content-Disposition",
        "Content-Length",
        "X-Artifact-SHA256",
        "Retry-After",
        "RateLimit-Limit",
        "RateLimit-Remaining",
        "RateLimit-Reset",
        "X-Optimike-Rate-Limit-Scope",
        "X-Optimike-Backpressure",
        "X-Optimike-Operation-Class",
        "X-Optimike-Queue-Wait-Ms",
        "X-Request-Id",
      ],
      credentials: true,
    }),
  );

  app.use("*", async (c: Context, next: Next) => {
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("X-Request-Id", getHttpRequestState(c.req.raw).requestId);
    await next();
  });

  // Backward-compatible liveness only. M3 adds readiness and detailed state.
  app.get("/healthz", (c: Context) => {
    return c.json({
      ok: true,
      status: "healthy",
      transport: "streamable-http",
      endpoint: MCP_ENDPOINT_PATH,
    });
  });

  app.use(MCP_ENDPOINT_PATH, preAuthRateLimitMiddleware);
  app.use(externalHandoffEndpoint, preAuthRateLimitMiddleware);
  // Source limiting must happen before buffering. Its 429 path never reads the
  // body; this guard then protects authentication and identity-quota errors.
  app.use(MCP_ENDPOINT_PATH, httpRequestBodyGuardMiddleware);
  app.use(MCP_ENDPOINT_PATH, authMiddleware);
  app.use(externalHandoffEndpoint, authMiddleware);
  app.use(MCP_ENDPOINT_PATH, authenticatedIdentityRateLimitMiddleware);
  app.use(externalHandoffEndpoint, verifiedIdentityMiddleware);
  app.use(MCP_ENDPOINT_PATH, httpBackpressureMiddleware);
  app.use(externalHandoffEndpoint, httpBackpressureMiddleware);

  app.onError(httpErrorHandler);

  app.get(externalHandoffEndpoint, async (c: Context) => {
    const ticket = c.req.header(externalHandoffTicketHeader);
    const authInfo = c.env.incoming.auth as AuthInfo | undefined;
    const state = getHttpRequestState(c.req.raw);
    if (!ticket || !authInfo) {
      return c.json(
        {
          error: "not_found",
          message: "Artifact transfer is invalid or unavailable.",
        },
        404,
      );
    }

    try {
      const artifact = await externalTransferBroker.consume(ticket, authInfo);
      if (c.env.incoming.destroyed) {
        await artifact.release();
        throw new ExternalRootError(
          "not_found",
          "The HTTP client disconnected before artifact delivery.",
        );
      }
      return externalHandoffResponse(
        artifact,
        externalTransferBroker.transferTimeoutMs,
      );
    } catch (error) {
      logger.warning("HTTP artifact transfer denied or unavailable.", {
        ...transportContext,
        requestId: state.requestId,
        operation: "consumeExternalHandoffTicket",
        clientIdentity: state.identity?.pseudonym,
        errorCode:
          error instanceof ExternalRootError ? error.code : "non_verifiable",
      });
      return c.json(
        {
          error: "not_found",
          message: "Artifact transfer is invalid or unavailable.",
        },
        404,
      );
    }
  });

  app.post(MCP_ENDPOINT_PATH, async (c: Context) => {
    const state = getHttpRequestState(c.req.raw);
    const identity = requireIdentity(c);
    const postContext = requestContextService.createRequestContext({
      ...transportContext,
      requestId: state.requestId,
      operation: "handlePost",
      clientIdentity: identity.pseudonym,
    });
    const body = await c.req.raw.clone().json();
    const sessionId = c.req.header("mcp-session-id");
    const session = sessionForRequest(c, sessionId);
    let transport = session?.transport;
    let initializationReservation: SessionCapacityReservation | undefined;
    let initializingTransport:
      | WebStandardStreamableHTTPServerTransport
      | undefined;
    let initializedSession: HttpSession | undefined;

    if (isInitializeRequest(body)) {
      if (transport) {
        logger.warning("Re-initializing existing session.", {
          ...postContext,
          sessionPresent: true,
        });
        await transport.close();
        transport = undefined;
      }

      initializationReservation = reserveSessionCapacity();
      if (!initializationReservation) {
        return sessionCapacityResponse(c, body);
      }

      const newTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          const now = Date.now();
          initializationReservation?.release();
          initializedSession = {
            transport: newTransport,
            identityKey: identity.key,
            identityPseudonym: identity.pseudonym,
            createdAt: now,
            lastSeenAt: now,
            activeRequests: 1,
          };
          transports.set(newId, initializedSession);
          logger.info("HTTP session created.", {
            ...postContext,
            sessionCount: transports.size,
            pendingSessionInitializations,
          });
        },
      });
      initializingTransport = newTransport;

      newTransport.onclose = () => {
        initializationReservation?.release();
        const closedSessionId = newTransport.sessionId;
        const current = closedSessionId
          ? transports.get(closedSessionId)
          : undefined;
        if (closedSessionId && current?.transport === newTransport) {
          transports.delete(closedSessionId);
          logger.info("HTTP session closed.", {
            ...postContext,
            sessionCount: transports.size,
          });
        }
      };

      try {
        const server = await createServerInstanceFn();
        await server.connect(newTransport);
        transport = newTransport;
      } catch (error) {
        initializationReservation.release();
        await newTransport.close().catch(() => undefined);
        throw error;
      }
    } else if (!transport || !session) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "Invalid or expired session ID.",
      );
    }

    try {
      if (initializedSession) {
        return await handleWithSessionActivity(
          initializedSession,
          () =>
            transport!.handleRequest(c.req.raw, {
              authInfo: c.env.incoming.auth,
              parsedBody: body,
            }),
          true,
        );
      }
      if (isInitializeRequest(body)) {
        const response = await transport.handleRequest(c.req.raw, {
          authInfo: c.env.incoming.auth,
          parsedBody: body,
        });
        if (!initializedSession) {
          await initializingTransport?.close().catch(() => undefined);
          throw new McpError(
            BaseErrorCode.INTERNAL_ERROR,
            "HTTP session initialization completed without a registered session.",
          );
        }
        return wrapSessionResponse(initializedSession, response);
      }
      return await handleWithSessionActivity(session!, () =>
        transport!.handleRequest(c.req.raw, {
          authInfo: c.env.incoming.auth,
          parsedBody: body,
        }),
      );
    } catch (error) {
      if (initializingTransport) {
        await initializingTransport.close().catch(() => undefined);
      }
      if (initializedSession && initializedSession.activeRequests > 0) {
        finishSessionActivity(initializedSession);
      }
      throw error;
    } finally {
      initializationReservation?.release();
    }
  });

  const handleSessionRequest = async (
    c: Context<{ Bindings: HttpBindings }>,
  ) => {
    const sessionId = c.req.header("mcp-session-id");
    const session = sessionForRequest(c, sessionId);

    if (!session) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "Session not found or expired.",
      );
    }

    return await handleWithSessionActivity(session, () =>
      session.transport.handleRequest(c.req.raw, {
        authInfo: c.env.incoming.auth,
      }),
    );
  };

  app.get(MCP_ENDPOINT_PATH, handleSessionRequest);
  app.delete(MCP_ENDPOINT_PATH, handleSessionRequest);

  const server = await startHttpServerWithRetry(
    app,
    HTTP_PORT,
    HTTP_HOST,
    MAX_PORT_RETRIES,
    transportContext,
  );
  const sessionCleanupTimer = setInterval(
    () => expireStaleSessions(),
    httpProtectionConfig.sessionCleanupIntervalMs,
  );
  sessionCleanupTimer.unref?.();
  server.once("close", () => clearInterval(sessionCleanupTimer));
  return server;
}
