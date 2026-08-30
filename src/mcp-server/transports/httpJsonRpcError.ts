import { Context } from "hono";
import { BaseErrorCode } from "../../types-global/errors.js";
import { ErrorHandler, requestContextService } from "../../utils/index.js";
import { getHttpRequestState } from "./httpRequestState.js";

export type JsonRpcId = string | number | null;

function ownDataProperty(value: object, field: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JSON-RPC permits string, finite number, or null identifiers only.  Keep this
 * deliberately structural: never reflect objects, arrays, booleans, or a
 * caller-controlled coercion hook into an error response.
 */
export function jsonRpcIdFromBody(body: unknown): JsonRpcId {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  // An id belongs to a JSON-RPC request only after the surrounding envelope
  // has been validated. A primitive `id` inside arbitrary JSON must never be
  // reflected by an error path.
  if (
    ownDataProperty(body, "jsonrpc") !== "2.0" ||
    typeof ownDataProperty(body, "method") !== "string"
  ) {
    return null;
  }
  const params = ownDataProperty(body, "params");
  if (params !== undefined && (params === null || typeof params !== "object")) {
    return null;
  }

  // Descriptor reads avoid triggering accessors or Proxy coercion hooks.
  const id = ownDataProperty(body, "id");
  if (id === null || typeof id === "string") return id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

export function httpStatusForErrorCode(code: BaseErrorCode): number {
  switch (code) {
    case BaseErrorCode.NOT_FOUND:
      return 404;
    case BaseErrorCode.UNAUTHORIZED:
      return 401;
    case BaseErrorCode.FORBIDDEN:
      return 403;
    case BaseErrorCode.VALIDATION_ERROR:
    case BaseErrorCode.PARSING_ERROR:
      return 400;
    case BaseErrorCode.CONFLICT:
      return 409;
    case BaseErrorCode.RATE_LIMITED:
      return 429;
    case BaseErrorCode.TIMEOUT:
      return 504;
    case BaseErrorCode.SERVICE_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

type PublicHttpErrorOptions = {
  operation: string;
  id?: JsonRpcId;
  status?: number;
  details?: Record<string, string | number | boolean>;
};

function publicErrorBody(
  error: unknown,
  request: Request,
  options: PublicHttpErrorOptions,
) {
  const state = getHttpRequestState(request);
  const handled = ErrorHandler.handleError(error, {
    operation: options.operation,
    context: {
      requestId: state.requestId,
      transport: "http",
    },
    includeStack: false,
  });
  const formatted = ErrorHandler.formatError(handled);
  const code =
    typeof formatted.code === "string" &&
    Object.values(BaseErrorCode).includes(formatted.code as BaseErrorCode)
      ? (formatted.code as BaseErrorCode)
      : BaseErrorCode.INTERNAL_ERROR;
  const details =
    formatted.details && typeof formatted.details === "object"
      ? (formatted.details as Record<string, string | number | boolean>)
      : {};

  return {
    status: options.status ?? httpStatusForErrorCode(code),
    body: {
      jsonrpc: "2.0" as const,
      error: {
        code,
        message:
          typeof formatted.message === "string"
            ? formatted.message
            : "The request could not be completed. Use the request id to inspect server diagnostics.",
        // This is a closed public envelope.  All supplied details originate
        // from server-owned constants; the canonical correlation id is always
        // the request-state UUID used for the ErrorHandler log entry.
        data: {
          ...details,
          ...options.details,
          requestId: state.requestId,
        },
      },
      id: options.id ?? state.rpcId ?? null,
    },
  };
}

export function jsonRpcErrorResponse(
  c: Context,
  error: unknown,
  options: PublicHttpErrorOptions,
): Response {
  const state = getHttpRequestState(c.req.raw);
  const encoded = publicErrorBody(error, c.req.raw, options);
  c.header("X-Request-Id", state.requestId);
  c.header("Cache-Control", "no-store");
  return c.json(
    encoded.body,
    encoded.status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503 | 504,
  );
}

/**
 * Profile routing happens before Hono receives a request.  Establish the same
 * request state and ErrorHandler correlation at that first boundary so the
 * response contract remains identical even on an invalid profile path.
 */
export function earlyJsonRpcErrorResponse(
  request: Request,
  error: unknown,
  options: PublicHttpErrorOptions,
): Response {
  const state = getHttpRequestState(request);
  const encoded = publicErrorBody(error, request, options);
  return new Response(JSON.stringify(encoded.body), {
    status: encoded.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": state.requestId,
    },
  });
}
