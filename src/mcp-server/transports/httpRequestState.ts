import { randomUUID } from "node:crypto";
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

export type HttpRequestState = {
  requestId: string;
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
};

const requestStates = new WeakMap<Request, HttpRequestState>();

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
