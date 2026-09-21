/**
 * Last-resort Hono error boundary. Expected tool failures should have already
 * become a public MCP CallToolResult; this handler covers transport, auth and
 * route failures with the same closed JSON-RPC envelope.
 */

import { Context } from "hono";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { jsonRpcErrorResponse } from "./httpJsonRpcError.js";

/** Only transport admission may construct this pre-dispatch rejection. */
export class InvalidHttpSessionError extends McpError {
  constructor() {
    super(BaseErrorCode.NOT_FOUND, "Invalid or expired session ID.");
    Object.setPrototypeOf(this, InvalidHttpSessionError.prototype);
  }
}

/**
 * A centralized error handling middleware for Hono.
 * This function is registered with `app.onError()` and will catch any errors
 * thrown from preceding middleware or route handlers.
 *
 * @param err - The error that was thrown.
 * @param c - The Hono context object for the request.
 * @returns A Response object containing the formatted JSON-RPC error.
 */
export const httpErrorHandler = async (err: Error, c: Context) =>
  jsonRpcErrorResponse(c, err, {
    operation: "httpTransport",
    ...(err instanceof InvalidHttpSessionError
      ? { details: { transportReason: "mcp_session_invalid" } }
      : {}),
  });
