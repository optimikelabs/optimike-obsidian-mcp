import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AuthInfo } from "../mcp-server/transports/auth/core/authTypes.js";
import { ExternalRootError } from "./externalRootsService.js";

const HTTP_HANDOFF_ENDPOINT = "/external-handoff";
const HTTP_HANDOFF_TICKET_HEADER = "X-External-Handoff-Ticket";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_TICKETS = 16;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_TTL_MS = 5 * 60 * 1000;
const MAX_TICKETS = 128;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export type PreparedExternalHandoff = {
  rootId: string;
  path: string;
  localPath: string;
  size: number;
  modifiedAt: string;
  sha256?: string;
};

export type HttpExternalHandoffDescriptor = {
  delivery: "http_ticket";
  endpoint: string;
  method: "GET";
  ticketHeader: string;
  ticket: string;
  rootId: string;
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  mediaType: string;
  expiresAt: string;
};

type TicketEntry = {
  ticket: string;
  tokenFingerprint: string;
  clientId: string;
  subject?: string;
  rootId: string;
  relativePath: string;
  buffer: Buffer;
  size: number;
  modifiedAt: string;
  sha256: string;
  mediaType: string;
  filename: string;
  expiresAtMs: number;
};

export type ExternalTransferBrokerOptions = {
  enabled?: boolean;
  ttlMs?: number;
  maxTickets?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
};

function parseBoundedInteger(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return value;
}

function envOptions(): Required<Omit<ExternalTransferBrokerOptions, "now">> {
  return {
    enabled:
      (process.env.MCP_HTTP_HANDOFF_ENABLED ?? "false").toLowerCase() ===
      "true",
    ttlMs: parseBoundedInteger(
      "MCP_HTTP_HANDOFF_TTL_MS",
      DEFAULT_TTL_MS,
      MAX_TTL_MS,
    ),
    maxTickets: parseBoundedInteger(
      "MCP_HTTP_HANDOFF_MAX_TICKETS",
      DEFAULT_MAX_TICKETS,
      MAX_TICKETS,
    ),
    maxFileBytes: parseBoundedInteger(
      "MCP_HTTP_HANDOFF_MAX_FILE_BYTES",
      DEFAULT_MAX_FILE_BYTES,
      MAX_FILE_BYTES,
    ),
    maxTotalBytes: parseBoundedInteger(
      "MCP_HTTP_HANDOFF_MAX_TOTAL_BYTES",
      DEFAULT_MAX_TOTAL_BYTES,
      MAX_TOTAL_BYTES,
    ),
  };
}

function tokenFingerprint(authInfo: AuthInfo): string {
  return createHash("sha256").update(authInfo.token).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function mediaTypeFor(relativePath: string): string {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".json":
      return "application/json";
    case ".md":
    case ".markdown":
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function safeFilename(relativePath: string): string {
  const raw = path
    .basename(relativePath)
    .replace(/[\u0000-\u001f\u007f"\\]/gu, "_");
  if (!raw) return "artifact.bin";
  if (Buffer.byteLength(raw, "utf8") <= 160) return raw;
  const extension = path.extname(raw);
  const boundedExtension =
    Buffer.byteLength(extension, "utf8") <= 32 ? extension : "";
  return `artifact${boundedExtension}`;
}

export class ExternalTransferBroker {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxTickets: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;

  private readonly now: () => number;
  private readonly tickets = new Map<string, TicketEntry>();
  private lock: Promise<void> = Promise.resolve();
  private readonly sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options?: ExternalTransferBrokerOptions) {
    const defaults = envOptions();
    this.enabled = options?.enabled ?? defaults.enabled;
    this.ttlMs = options?.ttlMs ?? defaults.ttlMs;
    this.maxTickets = options?.maxTickets ?? defaults.maxTickets;
    this.maxFileBytes = options?.maxFileBytes ?? defaults.maxFileBytes;
    this.maxTotalBytes = options?.maxTotalBytes ?? defaults.maxTotalBytes;
    this.now = options?.now ?? Date.now;

    if (this.enabled) {
      this.sweepTimer = setInterval(() => {
        void this.withLock(() => this.pruneExpired()).catch(() => undefined);
      }, Math.max(1_000, Math.min(this.ttlMs, 30_000)));
      this.sweepTimer.unref();
    }
  }

  publicStatus(): {
    enabled: boolean;
    endpoint: string;
    ticketHeader: string;
    storage: "bounded_memory";
    ttlMs: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxTickets: number;
  } {
    return {
      enabled: this.enabled,
      endpoint: HTTP_HANDOFF_ENDPOINT,
      ticketHeader: HTTP_HANDOFF_TICKET_HEADER,
      storage: "bounded_memory",
      ttlMs: this.ttlMs,
      maxFileBytes: this.maxFileBytes,
      maxTotalBytes: this.maxTotalBytes,
      maxTickets: this.maxTickets,
    };
  }

  async issue(
    handoff: PreparedExternalHandoff,
    authInfo: AuthInfo,
  ): Promise<HttpExternalHandoffDescriptor> {
    this.assertEnabled();
    if (!handoff.sha256) {
      throw new ExternalRootError(
        "non_verifiable",
        "HTTP handoff requires a verified SHA-256 digest.",
      );
    }
    if (handoff.size > this.maxFileBytes) {
      throw new ExternalRootError(
        "too_large",
        `The artifact exceeds the ${this.maxFileBytes}-byte HTTP handoff limit.`,
      );
    }

    // The local handoff copy is owned by ExternalRootsService and may be cached
    // for a later stdio or HTTP request. Never delete or mutate it here.
    const fileStat = await stat(handoff.localPath);
    if (!fileStat.isFile() || fileStat.size !== handoff.size) {
      throw new ExternalRootError(
        "non_verifiable",
        "The verified handoff copy changed before ticket creation.",
      );
    }
    const buffer = await readFile(handoff.localPath);
    if (
      buffer.length !== handoff.size ||
      !constantTimeEqual(sha256(buffer), handoff.sha256)
    ) {
      throw new ExternalRootError(
        "non_verifiable",
        "The verified handoff copy failed integrity verification.",
      );
    }

    return this.withLock(async () => {
      await this.pruneExpired();
      const totalBytes = [...this.tickets.values()].reduce(
        (total, entry) => total + entry.size,
        0,
      );
      if (
        this.tickets.size >= this.maxTickets ||
        totalBytes + handoff.size > this.maxTotalBytes
      ) {
        throw new ExternalRootError(
          "too_large",
          "The bounded HTTP handoff capacity is currently exhausted.",
        );
      }

      const ticket = randomBytes(32).toString("base64url");
      const expiresAtMs = this.now() + this.ttlMs;
      const mediaType = mediaTypeFor(handoff.path);
      this.tickets.set(ticket, {
        ticket,
        tokenFingerprint: tokenFingerprint(authInfo),
        clientId: authInfo.clientId,
        subject: authInfo.subject,
        rootId: handoff.rootId,
        relativePath: handoff.path,
        buffer,
        size: handoff.size,
        modifiedAt: handoff.modifiedAt,
        sha256: handoff.sha256,
        mediaType,
        filename: safeFilename(handoff.path),
        expiresAtMs,
      });

      return {
        delivery: "http_ticket",
        endpoint: HTTP_HANDOFF_ENDPOINT,
        method: "GET",
        ticketHeader: HTTP_HANDOFF_TICKET_HEADER,
        ticket,
        rootId: handoff.rootId,
        path: handoff.path,
        size: handoff.size,
        modifiedAt: handoff.modifiedAt,
        sha256: handoff.sha256,
        mediaType,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    });
  }

  async consume(
    ticket: string,
    authInfo: AuthInfo,
  ): Promise<{
    buffer: Buffer;
    filename: string;
    mediaType: string;
    size: number;
    sha256: string;
  }> {
    return this.withLock(async () => {
      this.assertEnabled();
      await this.pruneExpired();
      const entry = this.tickets.get(ticket);
      if (!entry || !this.sameIdentity(entry, authInfo)) {
        throw new ExternalRootError(
          "not_found",
          "The HTTP handoff ticket is invalid or unavailable.",
        );
      }

      // Claim before returning bytes. A concurrent replay sees no ticket.
      this.tickets.delete(ticket);
      if (
        entry.buffer.length !== entry.size ||
        !constantTimeEqual(sha256(entry.buffer), entry.sha256)
      ) {
        throw new ExternalRootError(
          "non_verifiable",
          "The staged handoff snapshot failed integrity verification.",
        );
      }
      return {
        buffer: entry.buffer,
        filename: entry.filename,
        mediaType: entry.mediaType,
        size: entry.size,
        sha256: entry.sha256,
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.withLock(async () => {
      this.tickets.clear();
    });
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ExternalRootError(
        "capability_denied",
        "HTTP handoff is disabled by default. Set MCP_HTTP_HANDOFF_ENABLED=true on an authenticated HTTP profile to enable it.",
      );
    }
  }

  private sameIdentity(entry: TicketEntry, authInfo: AuthInfo): boolean {
    return (
      entry.clientId === authInfo.clientId &&
      entry.subject === authInfo.subject &&
      constantTimeEqual(entry.tokenFingerprint, tokenFingerprint(authInfo))
    );
  }

  private async pruneExpired(): Promise<void> {
    const now = this.now();
    for (const entry of this.tickets.values()) {
      if (entry.expiresAtMs <= now) this.tickets.delete(entry.ticket);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const externalTransferBroker = new ExternalTransferBroker();
export const externalHandoffEndpoint = HTTP_HANDOFF_ENDPOINT;
export const externalHandoffTicketHeader = HTTP_HANDOFF_TICKET_HEADER;
