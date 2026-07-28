/**
 * @fileoverview Configures and starts the Streamable HTTP MCP transport using Hono.
 *
 * The transport owns the MCP lifecycle endpoint and the optional authenticated
 * download endpoint used by transportable external-artifact handoff. The latter
 * accepts only an opaque ticket in a dedicated header; source paths and tickets
 * never appear in URLs.
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
  externalHandoffEndpoint,
  externalHandoffTicketHeader,
  externalTransferBroker,
} from "../../services/externalTransferBroker.js";
import { collectRuntimeStatus } from "../../services/runtimeState.js";
import type { VaultCacheService } from "../../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  logger,
  rateLimiter,
  RequestContext,
  requestContextService,
} from "../../utils/index.js";
import {
  jwtAuthMiddleware,
  oauthMiddleware,
  type AuthInfo,
} from "./auth/index.js";
import { httpErrorHandler } from "./httpErrorHandler.js";

const HTTP_PORT = config.mcpHttpPort;
const HTTP_HOST = config.mcpHttpHost;
const MCP_ENDPOINT_PATH = "/mcp";
const MAX_PORT_RETRIES = parsePortRetries();
const TRUST_PROXY =
  (process.env.MCP_TRUST_PROXY ?? "false").toLowerCase() === "true";

// Active sessions are intentionally in-memory. This profile is a single-process
// service and is not a serverless or clustered deployment contract.
const transports: Record<string, WebStandardStreamableHTTPServerTransport> = {};

function parsePortRetries(): number {
  const raw = process.env.MCP_HTTP_PORT_RETRIES ?? "0";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new Error("MCP_HTTP_PORT_RETRIES must be an integer between 0 and 15.");
  }
  return value;
}

function originAllowed(origin: string): boolean {
  return (config.mcpAllowedOrigins ?? []).includes(origin);
}

function clientIp(c: Context<{ Bindings: HttpBindings }>): string {
  if (TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return c.env.incoming.socket.remoteAddress ?? "unknown_ip";
}

async function authMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
): Promise<void | Response> {
  return config.mcpAuthMode === "oauth"
    ? oauthMiddleware(c, next)
    : jwtAuthMiddleware(c, next);
}

async function rateLimitMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
): Promise<void> {
  const ipAddress = clientIp(c);
  const context = requestContextService.createRequestContext({
    operation: "httpRateLimitCheck",
    ipAddress,
    trustedProxyHeaders: TRUST_PROXY,
  });
  rateLimiter.check(ipAddress, context);
  await next();
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
  vaultCacheService?: VaultCacheService,
): Promise<ServerType> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const transportContext = requestContextService.createRequestContext({
    ...parentContext,
    component: "HttpTransportSetup",
  });

  // MCP requires Origin validation to mitigate browser-based DNS rebinding.
  // Requests without Origin remain valid for non-browser MCP clients.
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
      ],
      credentials: true,
    }),
  );

  app.use("*", async (c: Context, next: Next) => {
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    await next();
  });

  app.get("/healthz", async (c: Context) => {
    const includeIntegrity = c.req.query("integrity") === "1";
    const runtimeStatus = await collectRuntimeStatus(vaultCacheService, {
      includeIntegrity,
    });
    return c.json({
      ...runtimeStatus,
      transport: "streamable-http",
      endpoint: MCP_ENDPOINT_PATH,
      externalHttpHandoff: externalTransferBroker.publicStatus(),
      trustedProxyHeaders: TRUST_PROXY,
      portRetries: MAX_PORT_RETRIES,
    });
  });

  app.use(MCP_ENDPOINT_PATH, rateLimitMiddleware);
  app.use(externalHandoffEndpoint, rateLimitMiddleware);
  app.use(MCP_ENDPOINT_PATH, authMiddleware);
  app.use(externalHandoffEndpoint, authMiddleware);

  app.onError(httpErrorHandler);

  app.get(externalHandoffEndpoint, async (c: Context) => {
    const ticket = c.req.header(externalHandoffTicketHeader);
    const authInfo = c.env.incoming.auth as AuthInfo | undefined;
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
      return new Response(new Uint8Array(artifact.buffer), {
        status: 200,
        headers: {
          "Cache-Control": "no-store, max-age=0",
          Pragma: "no-cache",
          "Content-Type": artifact.mediaType,
          "Content-Length": String(artifact.size),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
            artifact.filename,
          )}`,
          "X-Artifact-SHA256": artifact.sha256,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (error) {
      logger.warning("HTTP artifact transfer denied or unavailable.", {
        ...transportContext,
        operation: "consumeExternalHandoffTicket",
        clientId: authInfo.clientId,
        errorCode:
          error instanceof ExternalRootError
            ? error.code
            : "non_verifiable",
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
    const postContext = requestContextService.createRequestContext({
      ...transportContext,
      operation: "handlePost",
    });
    const body = await c.req.raw.clone().json();
    const sessionId = c.req.header("mcp-session-id");
    let transport: WebStandardStreamableHTTPServerTransport | undefined = sessionId
      ? transports[sessionId]
      : undefined;

    if (isInitializeRequest(body)) {
      if (transport) {
        logger.warning("Re-initializing existing session.", {
          ...postContext,
          sessionId,
        });
        await transport.close();
      }

      const newTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          transports[newId] = newTransport;
          logger.info(`HTTP Session created: ${newId}`, {
            ...postContext,
            newSessionId: newId,
          });
        },
      });

      newTransport.onclose = () => {
        const closedSessionId = newTransport.sessionId;
        if (closedSessionId && transports[closedSessionId]) {
          delete transports[closedSessionId];
          logger.info(`HTTP Session closed: ${closedSessionId}`, {
            ...postContext,
            closedSessionId,
          });
        }
      };

      const server = await createServerInstanceFn();
      await server.connect(newTransport);
      transport = newTransport;
    } else if (!transport) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "Invalid or expired session ID.",
      );
    }

    return await transport.handleRequest(c.req.raw, {
      authInfo: c.env.incoming.auth,
      parsedBody: body,
    });
  });

  const handleSessionRequest = async (
    c: Context<{ Bindings: HttpBindings }>,
  ) => {
    const sessionId = c.req.header("mcp-session-id");
    const transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "Session not found or expired.",
      );
    }

    return await transport.handleRequest(c.req.raw, {
      authInfo: c.env.incoming.auth,
    });
  };

  app.get(MCP_ENDPOINT_PATH, handleSessionRequest);
  app.delete(MCP_ENDPOINT_PATH, handleSessionRequest);

  return startHttpServerWithRetry(
    app,
    HTTP_PORT,
    HTTP_HOST,
    MAX_PORT_RETRIES,
    transportContext,
  );
}
