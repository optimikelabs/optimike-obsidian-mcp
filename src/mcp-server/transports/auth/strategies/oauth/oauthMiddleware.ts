/**
 * @fileoverview Hono middleware for OAuth 2.1 Bearer Token validation.
 *
 * The middleware validates JWT bearer tokens against the configured issuer,
 * audience and JWKS. It retains only verified claims plus the token required by
 * downstream ticket binding. Raw tokens are never logged.
 *
 * @module src/mcp-server/transports/auth/strategies/oauth/oauthMiddleware
 */

import { HttpBindings } from "@hono/node-server";
import { Context, Next } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../../../../../config/index.js";
import { BaseErrorCode, McpError } from "../../../../../types-global/errors.js";
import { logger, requestContextService } from "../../../../../utils/index.js";
import { ErrorHandler } from "../../../../../utils/internal/errorHandler.js";
import { authContext } from "../../core/authContext.js";
import type { AuthInfo } from "../../core/authTypes.js";

if (config.mcpAuthMode === "oauth") {
  if (!config.oauthIssuerUrl) {
    throw new Error(
      "OAUTH_ISSUER_URL must be set when MCP_AUTH_MODE is 'oauth'",
    );
  }
  if (!config.oauthAudience) {
    throw new Error("OAUTH_AUDIENCE must be set when MCP_AUTH_MODE is 'oauth'");
  }
  logger.info(
    "OAuth 2.1 mode enabled. Verifying tokens against issuer.",
    requestContextService.createRequestContext({
      issuer: config.oauthIssuerUrl,
      audience: config.oauthAudience,
    }),
  );
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
if (config.mcpAuthMode === "oauth" && config.oauthIssuerUrl) {
  try {
    const jwksUrl = new URL(
      config.oauthJwksUri ||
        `${config.oauthIssuerUrl.replace(/\/$/, "")}/.well-known/jwks.json`,
    );
    jwks = createRemoteJWKSet(jwksUrl, {
      cooldownDuration: 300000,
      timeoutDuration: 5000,
    });
    logger.info(
      `JWKS client initialized for URL: ${jwksUrl.href}`,
      requestContextService.createRequestContext({
        operation: "oauthMiddlewareSetup",
      }),
    );
  } catch (error) {
    logger.fatal(
      "Failed to initialize JWKS client.",
      error as Error,
      requestContextService.createRequestContext({
        operation: "oauthMiddlewareSetup",
      }),
    );
    process.exit(1);
  }
}

export async function oauthMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
) {
  if (config.mcpAuthMode !== "oauth") {
    return await next();
  }

  const context = requestContextService.createRequestContext({
    operation: "oauthMiddleware",
    httpMethod: c.req.method,
    httpPath: c.req.path,
  });

  if (!jwks) {
    throw new McpError(
      BaseErrorCode.CONFIGURATION_ERROR,
      "OAuth middleware is active, but JWKS client is not initialized.",
      context,
    );
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new McpError(
      BaseErrorCode.UNAUTHORIZED,
      "Missing or invalid token format.",
    );
  }

  const token = authHeader.substring(7);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.oauthIssuerUrl!,
      audience: config.oauthAudience!,
    });

    const scopes =
      typeof payload.scope === "string"
        ? payload.scope.split(" ").filter(Boolean)
        : Array.isArray(payload.scp) &&
            payload.scp.every((scope) => typeof scope === "string")
          ? (payload.scp as string[])
          : [];

    if (scopes.length === 0) {
      logger.warning(
        "Authentication failed: Token contains no scopes, but scopes are required.",
        { ...context, jwtPayloadKeys: Object.keys(payload) },
      );
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        "Token must contain valid, non-empty scopes.",
      );
    }

    const clientId =
      typeof payload.client_id === "string"
        ? payload.client_id
        : typeof payload.cid === "string"
          ? payload.cid
          : undefined;

    if (!clientId) {
      logger.warning(
        "Authentication failed: OAuth token 'client_id' claim is missing or not a string.",
        { ...context, jwtPayloadKeys: Object.keys(payload) },
      );
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        "Invalid token, missing client identifier.",
      );
    }

    const authInfo: AuthInfo = {
      token,
      clientId,
      scopes,
      subject: typeof payload.sub === "string" ? payload.sub : undefined,
      issuer:
        typeof payload.iss === "string" ? payload.iss : config.oauthIssuerUrl!,
    };

    c.env.incoming.auth = authInfo;
    logger.debug("OAuth token verified successfully.", {
      ...context,
      clientId: authInfo.clientId,
      subjectPresent: Boolean(authInfo.subject),
      issuer: authInfo.issuer,
      scopes: authInfo.scopes,
    });
    await authContext.run({ authInfo }, next);
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;

    if (error instanceof Error && error.name === "JWTExpired") {
      logger.warning("Authentication failed: OAuth token expired.", context);
      throw new McpError(BaseErrorCode.UNAUTHORIZED, "Token expired.");
    }

    const handledError = ErrorHandler.handleError(error, {
      operation: "oauthMiddleware",
      context,
      rethrow: false,
    });
    logger.warning("Authentication failed: OAuth token verification rejected.", {
      ...context,
      errorName: handledError.name,
    });
    throw new McpError(BaseErrorCode.UNAUTHORIZED, "Invalid token.");
  }
}
