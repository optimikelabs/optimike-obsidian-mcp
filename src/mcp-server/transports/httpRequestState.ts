import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withRequestCorrelationId } from "../../utils/internal/requestContext.js";
import type { AuthInfo } from "./auth/index.js";

export type VerifiedHttpIdentity = {
  key: string;
  pseudonym: string;
  clientId: string;
  subject?: string;
  issuer: string;
  source: "claims" | "claims-and-token-fingerprint";
};

export type HttpQuotaState = {
  scope: "source-ip" | "loopback-source-ip" | "client-identity";
  limit: number;
  remaining: number;
  resetAt: number;
  outcome: "allowed" | "limited" | "capacity";
};

export type HttpOperationClass = "standard" | "expensive" | "mutation";

export type HttpAdmissionState = {
  operationClass: HttpOperationClass;
  operationName: string;
  queued: boolean;
  waitMs: number;
  outcome:
    | "admitted"
    | "queue-full"
    | "identity-queue-full"
    | "timeout"
    | "cancelled";
  admittedAt?: number;
  releasedAt?: number;
};

export type HttpRequestState = {
  requestId: string;
  /** Parsed only from a validated JSON-RPC envelope; never inferred from an
   * arbitrary body during error handling. */
  rpcId?: string | number | null;
  startedAt: number;
  clientAddress?: string;
  clientAddressSource?:
    | "socket"
    | "trusted-forwarded"
    | "trusted-x-forwarded-for"
    | "socket-invalid-forward-chain"
    | "socket-conflicting-forward-headers";
  trustedProxyHeaders: boolean;
  authInfo?: AuthInfo;
  identity?: VerifiedHttpIdentity;
  quotas: HttpQuotaState[];
  correlationId?: string;
  incidentId?: string;
  admission?: HttpAdmissionState;
};

const requestStates = new WeakMap<Request, HttpRequestState>();
const activeHttpRequestState = new AsyncLocalStorage<HttpRequestState>();

export function getHttpRequestState(request: Request): HttpRequestState {
  const existing = requestStates.get(request);
  if (existing) return existing;

  const created: HttpRequestState = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    trustedProxyHeaders: false,
    quotas: [],
  };
  requestStates.set(request, created);
  return created;
}

/**
 * Runs SDK request processing in the same request state that produced the
 * HTTP response. The MCP SDK only exposes its private `createToolError`
 * callback with a rendered message, so this scoped carrier is the sole way to
 * retain the server-owned correlation UUID for SDK validation and unknown-tool
 * failures without trusting caller-supplied headers.
 */
export function withActiveHttpRequestState<T>(
  request: Request,
  operation: () => T,
): T {
  const state = getHttpRequestState(request);
  return activeHttpRequestState.run(state, () =>
    withRequestCorrelationId(state.requestId, operation),
  );
}

/**
 * Returns the server-owned HTTP request UUID while a Streamable HTTP request
 * is being dispatched through the SDK. Stdio and in-memory transports have no
 * HTTP request state and intentionally receive a fresh bounded UUID instead.
 */
export function activeHttpRequestId(): string | undefined {
  return activeHttpRequestState.getStore()?.requestId;
}
