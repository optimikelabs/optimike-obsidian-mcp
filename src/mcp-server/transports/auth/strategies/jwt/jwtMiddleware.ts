/**
 * @fileoverview MCP Authentication Middleware for Bearer Token Validation (JWT) for Hono.
 *
 * This middleware validates JSON Web Tokens (JWT) passed via the Authorization header.
 * Verified claims are attached to the incoming request for SDK compatibility and to the
 * AsyncLocalStorage authentication context. Raw bearer tokens are never logged.
 *
 * @module src/mcp-server/transports/auth/strategies/jwt/jwtMiddleware
 */

import { HttpBindings } from "@hono/node-server";
import { Context, Next } from "hono";
import { jwtVerify } from "jose";
import { config, environment } from "../../../../../config/index.js";
import { logger, requestContextService } from "../../../../../utils/index.js";
import { BaseErrorCode, McpError } from "../../../../../types-global/errors.js";
import { authContext } from "../../core/authContext.js";

if (config.mcpAuthMode === "jwt") {
  if (environment === "production" && !config.mcpAuthSecretKey) {
    logger.fatal(
      "CRITICAL: MCP_AUTH_SECRET_KEY is not set in production environment for JWT auth. Authentication cannot proceed securely.",
    );
    throw new Error(
      "MCP_AUTH_SECRET_KEY must be set in production environment for JWT authentication.",
    );
  } else if (!config.mcpAuthSecretKey) {
    logger.warning(
      "MCP_AUTH_SECRET_KEY is not set. JWT auth middleware will use the shared development identity (DEVELOPMENT ONLY).",
    );
  }
}

/**
 * Hono middleware for verifying JWT Bearer authentication.
 */
export async function mcpAuthMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
) {
  const context = requestContextService.createRequestContext({
    operation: "mcpAuthMiddleware",
    method: c.req.method,
    path: c.req.path,
  });
  logger.debug(
    "Running MCP Authentication Middleware (Bearer Token Validation)...",
    context,
  );

  const reqWithAuth = c.env.incoming;

  if (config.mcpAuthMode !== "jwt") {
    return await next();
  }

  if (!config.mcpAuthSecretKey) {
    if (environment !== "production") {
      logger.warning(
        "Bypassing JWT verification with the shared development identity because MCP_AUTH_SECRET_KEY is not set (DEVELOPMENT ONLY).",
        context,
      );
      reqWithAuth.auth = {
        token: "dev-mode-placeholder-token",
        clientId: "dev-client-id",
        scopes: ["dev-scope"],
        issuer: "optimike-development",
      };
      const authInfo = reqWithAuth.auth;
      logger.debug("Development authentication identity created.", {
        ...context,
        clientId: authInfo.clientId,
        scopes: authInfo.scopes,
        issuer: authInfo.issuer,
      });
      return await authContext.run({ authInfo }, next);
    }

    logger.error(
      "FATAL: MCP_AUTH_SECRET_KEY is missing in production. Cannot bypass auth.",
      context,
    );
    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      "Server configuration error: Authentication key missing.",
    );
  }

  const secretKey = new TextEncoder().encode(config.mcpAuthSecretKey);
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warning(
      "Authentication failed: Missing or malformed Authorization header (Bearer scheme required).",
      context,
    );
    throw new McpError(
      BaseErrorCode.UNAUTHORIZED,
      "Missing or invalid authentication token format.",
    );
  }

  const tokenParts = authHeader.split(" ");
  if (tokenParts.length !== 2 || tokenParts[0] !== "Bearer" || !tokenParts[1]) {
    logger.warning("Authentication failed: Malformed Bearer token.", context);
    throw new McpError(
      BaseErrorCode.UNAUTHORIZED,
      "Malformed authentication token.",
    );
  }
  const rawToken = tokenParts[1];

  try {
    const { payload: decoded } = await jwtVerify(rawToken, secretKey);

    const clientIdFromToken =
      typeof decoded.cid === "string"
        ? decoded.cid
        : typeof decoded.client_id === "string"
          ? decoded.client_id
          : undefined;
    if (!clientIdFromToken) {
      logger.warning(
        "Authentication failed: JWT 'cid' or 'client_id' claim is missing or not a string.",
        { ...context, jwtPayloadKeys: Object.keys(decoded) },
      );
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        "Invalid token, missing client identifier.",
      );
    }

    let scopesFromToken: string[] = [];
    if (
      Array.isArray(decoded.scp) &&
      decoded.scp.every((scope) => typeof scope === "string")
    ) {
      scopesFromToken = decoded.scp as string[];
    } else if (
      typeof decoded.scope === "string" &&
      decoded.scope.trim() !== ""
    ) {
      scopesFromToken = decoded.scope.split(" ").filter(Boolean);
      if (scopesFromToken.length === 0 && decoded.scope.trim() !== "") {
        scopesFromToken = [decoded.scope.trim()];
      }
    }

    if (scopesFromToken.length === 0) {
      logger.warning(
        "Authentication failed: Token resulted in an empty scope array, and scopes are required.",
        { ...context, jwtPayloadKeys: Object.keys(decoded) },
      );
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        "Token must contain valid, non-empty scopes.",
      );
    }

    const subject = typeof decoded.sub === "string" ? decoded.sub : undefined;
    const issuer =
      typeof decoded.iss === "string" ? decoded.iss : "optimike-local-jwt";
    reqWithAuth.auth = {
      token: rawToken,
      clientId: clientIdFromToken,
      scopes: scopesFromToken,
      subject,
      issuer,
    };

    const authInfo = reqWithAuth.auth;
    logger.debug("JWT verified successfully. AuthInfo attached to request.", {
      ...context,
      subjectPresent: Boolean(subject),
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
      issuer: authInfo.issuer,
    });
    await authContext.run({ authInfo }, next);
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;

    if (error instanceof Error && error.name === "JWTExpired") {
      logger.warning("Authentication failed: Token expired.", {
        ...context,
        errorName: error.name,
      });
      throw new McpError(BaseErrorCode.UNAUTHORIZED, "Token expired.");
    }

    logger.warning("Authentication failed: Token verification rejected.", {
      ...context,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    throw new McpError(BaseErrorCode.UNAUTHORIZED, "Invalid token.");
  }
}
