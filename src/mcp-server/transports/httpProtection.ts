import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { AuthInfo } from "./auth/index.js";
import type { VerifiedHttpIdentity } from "./httpRequestState.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function envInteger(defaultValue: number, min: number, max: number) {
  return z.preprocess(
    (value) =>
      value === undefined || value === null || value === ""
        ? defaultValue
        : value,
    z.coerce.number().int().min(min).max(max),
  );
}

const HttpProtectionEnvSchema = z
  .object({
    MCP_HTTP_PREAUTH_RATE_LIMIT_WINDOW_MS: envInteger(15 * 60 * 1000, 1000, DAY_MS),
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: envInteger(600, 1, 1_000_000),
    MCP_HTTP_LOOPBACK_POLICY: z
      .enum(["shared", "elevated"])
      .default("elevated"),
    MCP_HTTP_LOOPBACK_PREAUTH_RATE_LIMIT_MAX: envInteger(3000, 1, 1_000_000),
    MCP_HTTP_IDENTITY_RATE_LIMIT_WINDOW_MS: envInteger(15 * 60 * 1000, 1000, DAY_MS),
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: envInteger(100, 1, 1_000_000),
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS: envInteger(5000, 1, 1_000_000),
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS: envInteger(10_000, 1, 1_000_000),
    MCP_HTTP_RATE_LIMIT_CLEANUP_INTERVAL_MS: envInteger(5 * 60 * 1000, 1000, DAY_MS),
    MCP_HTTP_MAX_SESSIONS: envInteger(500, 1, 100_000),
    MCP_TRUSTED_PROXIES: z.string().default(""),
    MCP_TRUST_PROXY: z.string().optional(),
    MCP_HTTP_IDENTITY_HASH_KEY: z.string().min(32).optional(),
    MCP_AUTH_SECRET_KEY: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const legacyTrust = (value.MCP_TRUST_PROXY ?? "false").toLowerCase();
    if (!new Set(["true", "false", ""]).has(legacyTrust)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_TRUST_PROXY"],
        message: "MCP_TRUST_PROXY must be true or false when present.",
      });
    }
    if (legacyTrust === "true" && !value.MCP_TRUSTED_PROXIES.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_TRUSTED_PROXIES"],
        message:
          "MCP_TRUST_PROXY=true is no longer sufficient. Configure explicit MCP_TRUSTED_PROXIES IP/CIDR entries.",
      });
    }

    for (const candidate of splitCsv(value.MCP_TRUSTED_PROXIES)) {
      try {
        parseIpRange(candidate);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MCP_TRUSTED_PROXIES"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

const parsedProtectionEnv = HttpProtectionEnvSchema.safeParse(process.env);
if (!parsedProtectionEnv.success) {
  const details = parsedProtectionEnv.error.flatten().fieldErrors;
  throw new Error(
    `Invalid HTTP protection configuration: ${JSON.stringify(details)}`,
  );
}

const protectionEnv = parsedProtectionEnv.data;

export const httpProtectionConfig = {
  preAuthWindowMs: protectionEnv.MCP_HTTP_PREAUTH_RATE_LIMIT_WINDOW_MS,
  preAuthMaxRequests: protectionEnv.MCP_HTTP_PREAUTH_RATE_LIMIT_MAX,
  loopbackPolicy: protectionEnv.MCP_HTTP_LOOPBACK_POLICY,
  loopbackPreAuthMaxRequests:
    protectionEnv.MCP_HTTP_LOOPBACK_PREAUTH_RATE_LIMIT_MAX,
  identityWindowMs: protectionEnv.MCP_HTTP_IDENTITY_RATE_LIMIT_WINDOW_MS,
  identityMaxRequests: protectionEnv.MCP_HTTP_IDENTITY_RATE_LIMIT_MAX,
  preAuthMaxKeys: protectionEnv.MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS,
  identityMaxKeys: protectionEnv.MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS,
  cleanupIntervalMs: protectionEnv.MCP_HTTP_RATE_LIMIT_CLEANUP_INTERVAL_MS,
  maxSessions: protectionEnv.MCP_HTTP_MAX_SESSIONS,
  trustedProxyRanges: splitCsv(protectionEnv.MCP_TRUSTED_PROXIES).map(
    parseIpRange,
  ),
};

const identityDigestKey = Buffer.from(
  protectionEnv.MCP_HTTP_IDENTITY_HASH_KEY ??
    protectionEnv.MCP_AUTH_SECRET_KEY ??
    randomBytes(32).toString("base64url"),
  "utf8",
);

function splitCsv(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeIpLiteral(value: string): string | undefined {
  let candidate = value.trim().replace(/^"|"$/gu, "");
  if (!candidate || candidate.toLowerCase() === "unknown") return undefined;

  const zoneIndex = candidate.indexOf("%");
  if (zoneIndex !== -1) candidate = candidate.slice(0, zoneIndex);

  if (candidate.startsWith("[")) {
    const closing = candidate.indexOf("]");
    if (closing === -1) return undefined;
    candidate = candidate.slice(1, closing);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/u.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(":"));
  }

  if (candidate.toLowerCase().startsWith("::ffff:")) {
    const mapped = candidate.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }

  return isIP(candidate) ? candidate.toLowerCase() : undefined;
}

function expandIpv4Tail(value: string): string {
  const lastColon = value.lastIndexOf(":");
  const ipv4 = value.slice(lastColon + 1);
  if (isIP(ipv4) !== 4) return value;
  const octets = ipv4.split(".").map(Number);
  const first = ((octets[0] << 8) | octets[1]).toString(16);
  const second = ((octets[2] << 8) | octets[3]).toString(16);
  return `${value.slice(0, lastColon)}:${first}:${second}`;
}

function ipToBigInt(value: string): { version: 4 | 6; bits: number; value: bigint } {
  const normalized = normalizeIpLiteral(value);
  if (!normalized) throw new Error(`Invalid IP address: ${value}`);
  const version = isIP(normalized);
  if (version === 4) {
    const numeric = normalized
      .split(".")
      .map(Number)
      .reduce((acc, part) => (acc << 8n) | BigInt(part), 0n);
    return { version: 4, bits: 32, value: numeric };
  }

  const expandedTail = expandIpv4Tail(normalized);
  const [leftRaw, rightRaw] = expandedTail.split("::");
  if (expandedTail.split("::").length > 2) {
    throw new Error(`Invalid IPv6 address: ${value}`);
  }
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!expandedTail.includes("::") && missing !== 0)) {
    throw new Error(`Invalid IPv6 address: ${value}`);
  }
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) {
    throw new Error(`Invalid IPv6 address: ${value}`);
  }
  const numeric = groups.reduce(
    (acc, group) => (acc << 16n) | BigInt(`0x${group}`),
    0n,
  );
  return { version: 6, bits: 128, value: numeric };
}

export type ParsedIpRange = {
  source: string;
  version: 4 | 6;
  bits: number;
  prefixLength: number;
  network: bigint;
};

export function parseIpRange(source: string): ParsedIpRange {
  const [address, prefixRaw, ...extra] = source.trim().split("/");
  if (extra.length > 0) throw new Error(`Invalid trusted proxy range: ${source}`);
  const parsed = ipToBigInt(address);
  const prefixLength =
    prefixRaw === undefined || prefixRaw === ""
      ? parsed.bits
      : Number(prefixRaw);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > parsed.bits) {
    throw new Error(`Invalid trusted proxy prefix length: ${source}`);
  }
  const shift = BigInt(parsed.bits - prefixLength);
  const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift;
  return {
    source,
    version: parsed.version,
    bits: parsed.bits,
    prefixLength,
    network,
  };
}

export function ipMatchesRange(address: string, range: ParsedIpRange): boolean {
  try {
    const parsed = ipToBigInt(address);
    if (parsed.version !== range.version) return false;
    const shift = BigInt(range.bits - range.prefixLength);
    return shift === 0n
      ? parsed.value === range.network
      : (parsed.value >> shift) << shift === range.network;
  } catch {
    return false;
  }
}

function isTrustedProxy(address: string): boolean {
  return httpProtectionConfig.trustedProxyRanges.some((range) =>
    ipMatchesRange(address, range),
  );
}

function parseForwardedHeader(value: string): string[] | undefined {
  const addresses: string[] = [];
  for (const element of value.split(",")) {
    const forPart = element
      .split(";")
      .map((part) => part.trim())
      .find((part) => /^for=/iu.test(part));
    if (!forPart) return undefined;
    const normalized = normalizeIpLiteral(forPart.slice(forPart.indexOf("=") + 1));
    if (!normalized) return undefined;
    addresses.push(normalized);
  }
  return addresses;
}

function parseXForwardedFor(value: string): string[] | undefined {
  const addresses = value.split(",").map((part) => normalizeIpLiteral(part));
  if (addresses.some((address) => !address)) return undefined;
  return addresses as string[];
}

export type ClientAddressResolution = {
  address: string;
  source:
    | "socket"
    | "trusted-forwarded"
    | "trusted-x-forwarded-for"
    | "socket-invalid-forward-chain";
  trustedProxyHeaders: boolean;
};

export function resolveClientAddress(input: {
  remoteAddress?: string;
  forwarded?: string;
  xForwardedFor?: string;
}): ClientAddressResolution {
  const socketAddress = normalizeIpLiteral(input.remoteAddress ?? "") ?? "unknown_ip";
  if (socketAddress === "unknown_ip" || !isTrustedProxy(socketAddress)) {
    return {
      address: socketAddress,
      source: "socket",
      trustedProxyHeaders: false,
    };
  }

  const hasForwarded = Boolean(input.forwarded?.trim());
  const hasXForwardedFor = Boolean(input.xForwardedFor?.trim());
  const parsedChain = hasForwarded
    ? parseForwardedHeader(input.forwarded!)
    : hasXForwardedFor
      ? parseXForwardedFor(input.xForwardedFor!)
      : [];
  const source = hasForwarded
    ? "trusted-forwarded"
    : "trusted-x-forwarded-for";

  if (parsedChain === undefined) {
    return {
      address: socketAddress,
      source: "socket-invalid-forward-chain",
      trustedProxyHeaders: false,
    };
  }
  if (parsedChain.length === 0) {
    return {
      address: socketAddress,
      source: "socket",
      trustedProxyHeaders: false,
    };
  }

  let currentHop = socketAddress;
  for (let index = parsedChain.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxy(currentHop)) break;
    currentHop = parsedChain[index];
  }
  return {
    address: currentHop,
    source,
    trustedProxyHeaders: true,
  };
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  if (!normalized) return false;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return normalized === "::1";
}

function digest(namespace: string, value: string): string {
  return createHmac("sha256", identityDigestKey)
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function pseudonymizeClientAddress(address: string): string {
  return `ip_${digest("http-source-ip-v1", address).slice(0, 20)}`;
}

export function deriveVerifiedHttpIdentity(authInfo: AuthInfo): VerifiedHttpIdentity {
  const issuer = authInfo.issuer?.trim() || "optimike-local";
  const clientId = authInfo.clientId?.trim();
  if (!clientId) throw new Error("Authenticated request has no verified clientId.");
  const subject = authInfo.subject?.trim() || undefined;
  const tokenFingerprint = subject
    ? undefined
    : digest("http-token-fallback-v1", authInfo.token);
  const canonical = JSON.stringify({
    issuer,
    clientId,
    subject: subject ?? null,
    tokenFingerprint: tokenFingerprint ?? null,
  });
  const key = digest("http-client-identity-v1", canonical);
  return {
    key,
    pseudonym: `client_${key.slice(0, 20)}`,
    clientId,
    subject,
    issuer,
    source: subject ? "claims" : "claims-and-token-fingerprint",
  };
}

export type RateLimitOutcome = "allowed" | "limited" | "capacity";

export type RateLimitDecision = {
  allowed: boolean;
  outcome: RateLimitOutcome;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};

export class BoundedFixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      windowMs: number;
      maxRequests: number;
      maxKeys: number;
      cleanupIntervalMs?: number;
      now?: () => number;
    },
  ) {
    if (options.windowMs <= 0 || options.maxRequests <= 0 || options.maxKeys <= 0) {
      throw new Error("Rate limiter window, request limit and key capacity must be positive.");
    }
    if (options.cleanupIntervalMs && options.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(
        () => this.cleanupExpiredEntries(),
        options.cleanupIntervalMs,
      );
      this.cleanupTimer.unref?.();
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  public check(key: string): RateLimitDecision {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && now >= entry.resetAt) {
      this.entries.delete(key);
      entry = undefined;
    }

    if (!entry) {
      if (this.entries.size >= this.options.maxKeys) {
        this.cleanupExpiredEntries(now);
      }
      if (this.entries.size >= this.options.maxKeys) {
        const earliestResetAt = Math.min(
          ...Array.from(this.entries.values(), (candidate) => candidate.resetAt),
        );
        return {
          allowed: false,
          outcome: "capacity",
          limit: this.options.maxRequests,
          remaining: 0,
          resetAt: earliestResetAt,
          retryAfterSeconds: Math.max(1, Math.ceil((earliestResetAt - now) / 1000)),
        };
      }
      const resetAt = now + this.options.windowMs;
      this.entries.set(key, { count: 1, resetAt, lastSeenAt: now });
      return {
        allowed: true,
        outcome: "allowed",
        limit: this.options.maxRequests,
        remaining: Math.max(0, this.options.maxRequests - 1),
        resetAt,
        retryAfterSeconds: 0,
      };
    }

    entry.lastSeenAt = now;
    if (entry.count >= this.options.maxRequests) {
      return {
        allowed: false,
        outcome: "limited",
        limit: this.options.maxRequests,
        remaining: 0,
        resetAt: entry.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }

    entry.count += 1;
    return {
      allowed: true,
      outcome: "allowed",
      limit: this.options.maxRequests,
      remaining: Math.max(0, this.options.maxRequests - entry.count),
      resetAt: entry.resetAt,
      retryAfterSeconds: 0,
    };
  }

  public cleanupExpiredEntries(now = this.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  public getStats(): { keys: number; maxKeys: number } {
    return { keys: this.entries.size, maxKeys: this.options.maxKeys };
  }

  public dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.entries.clear();
  }
}

export const preAuthSourceLimiter = new BoundedFixedWindowRateLimiter({
  windowMs: httpProtectionConfig.preAuthWindowMs,
  maxRequests: httpProtectionConfig.preAuthMaxRequests,
  maxKeys: httpProtectionConfig.preAuthMaxKeys,
  cleanupIntervalMs: httpProtectionConfig.cleanupIntervalMs,
});

export const loopbackPreAuthSourceLimiter = new BoundedFixedWindowRateLimiter({
  windowMs: httpProtectionConfig.preAuthWindowMs,
  maxRequests:
    httpProtectionConfig.loopbackPolicy === "elevated"
      ? httpProtectionConfig.loopbackPreAuthMaxRequests
      : httpProtectionConfig.preAuthMaxRequests,
  maxKeys: httpProtectionConfig.preAuthMaxKeys,
  cleanupIntervalMs: httpProtectionConfig.cleanupIntervalMs,
});

export const authenticatedIdentityLimiter = new BoundedFixedWindowRateLimiter({
  windowMs: httpProtectionConfig.identityWindowMs,
  maxRequests: httpProtectionConfig.identityMaxRequests,
  maxKeys: httpProtectionConfig.identityMaxKeys,
  cleanupIntervalMs: httpProtectionConfig.cleanupIntervalMs,
});
