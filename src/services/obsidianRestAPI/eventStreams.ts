import axios, { type AxiosInstance } from "axios";
import type { Readable } from "node:stream";
import { createParser } from "eventsource-parser";

export const VAULT_CACHE_EVENTS = [
  "create",
  "modify",
  "delete",
  "rename",
] as const;
export type VaultCacheEvent = (typeof VAULT_CACHE_EVENTS)[number];
export type VaultEventNotice = {
  event: VaultCacheEvent;
  path: string;
  oldPath?: string;
  isFolder: boolean;
  epoch?: string;
};
export type EventStreamFailure =
  | "unsupported"
  | "forbidden"
  | "unavailable"
  | "invalid_stream"
  | "aborted";
export class LocalRestEventError extends Error {
  constructor(readonly reason: EventStreamFailure) {
    super("Local REST event stream unavailable: " + reason);
  }
}
export interface VaultEventSource {
  consumeVaultEvents(
    event: VaultCacheEvent,
    signal: AbortSignal,
    onReady: () => void,
    onEvent: (event: VaultEventNotice) => void,
  ): Promise<void>;
}

/** Drop all note content, frontmatter, links and raw IDs before leaving the adapter. */
export function projectVaultEvent(
  event: VaultCacheEvent,
  data: string,
  id?: string,
): VaultEventNotice {
  if (data.length > 262144) throw new LocalRestEventError("invalid_stream");
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalRestEventError("invalid_stream");
  const item = value as Record<string, unknown>;
  const validPath = (p: unknown): p is string =>
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 4096 &&
    !/[\u0000-\u001f]/u.test(p) &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !/^[a-z]:/iu.test(p) &&
    !p.split("/").some((part) => part === ".." || part === "." || !part);
  if (
    item.emitter !== "vault" ||
    item.event !== event ||
    !validPath(item.path) ||
    typeof item.isFolder !== "boolean" ||
    (event === "rename" && !validPath(item.oldPath))
  ) {
    throw new LocalRestEventError("invalid_stream");
  }
  // Keep only the epoch. In Local REST 5.3.1 the EventStreams-wide
  // counter is incremented before each subscription's filter is evaluated, so a
  // healthy filtered stream can legitimately observe numeric gaps. Stream loss,
  // parser failure, reconnect and epoch changes remain reconciliation signals.
  const epoch =
    id && /^[a-f0-9]{8}-[0-9]+$/u.test(id) ? id.slice(0, 8) : undefined;
  return {
    event,
    path: item.path,
    isFolder: item.isFolder,
    ...(event === "rename" ? { oldPath: item.oldPath as string } : {}),
    ...(epoch ? { epoch } : {}),
  };
}

// Four slots per REST client; no signed URLs or credentials are retained.
// Thirty-second grant lifetime also bounds orphan registrations after a lost POST
// acknowledgement; an already-open upstream stream outlives this lifetime.
const SUBSCRIPTION_TTL_SECONDS = 30;
type SubscriptionSlot = {
  active: boolean;
  grant?: { base: string; id: string; expiresAt: number };
};
const subscriptionSlots = new WeakMap<AxiosInstance, Map<VaultCacheEvent, SubscriptionSlot>>();

/** One authenticated subscription and bounded stream; the caller owns reconnect. */
export async function consumeVaultEventStream(
  client: AxiosInstance,
  baseUrl: string,
  event: VaultCacheEvent,
  signal: AbortSignal,
  onReady: () => void,
  onEvent: (event: VaultEventNotice) => void,
  limits = { handshakeMs: 5000, idleMs: 45000 },
): Promise<void> {
  if (!(VAULT_CACHE_EVENTS as readonly string[]).includes(event))
    throw new LocalRestEventError("invalid_stream");
  const route = "/events/vault/" + event + "/";
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let stream: Readable | undefined;
  let ownedSlot: SubscriptionSlot | undefined;
  let openingGrant = false;
  let deadline: NodeJS.Timeout | undefined;
  const resetDeadline = (ms: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => controller.abort(), ms);
  };
  try {
    const base = new URL(baseUrl);
    if (
      base.username ||
      base.password || base.search || base.hash ||
      !["http:", "https:"].includes(base.protocol)
    )
      throw new LocalRestEventError("invalid_stream");
    const baseKey = base.href.replace(/\/$/u, "");
    let slots = subscriptionSlots.get(client);
    if (!slots) { slots = new Map(); subscriptionSlots.set(client, slots); }
    const slot = slots.get(event) ?? { active: false };
    // A second caller must not mint a grant or release the first caller's slot.
    if (slot.active) throw new LocalRestEventError("unavailable");
    slot.active = true;
    slots.set(event, slot);
    ownedSlot = slot;
    if (slot.grant && (slot.grant.base !== baseKey || slot.grant.expiresAt <= Date.now())) {
      slot.grant = undefined;
    }
    if (!slot.grant) {
      const response = await client.request({
        method: "POST", url: route, params: { ttl: SUBSCRIPTION_TTL_SECONDS }, data: {},
        headers: { "Content-Type": "application/json" }, maxRedirects: 0,
        timeout: limits.handshakeMs, maxContentLength: 65536, maxBodyLength: 1024,
        signal: combined,
      });
      const grant: unknown = response.data;
      if (response.status !== 201 || !grant || typeof grant !== "object")
        throw new LocalRestEventError("invalid_stream");
      const record = grant as Record<string, unknown>;
      if (record.emitter !== "vault" || record.event !== event ||
          typeof record.id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(record.id) ||
          typeof record.url !== "string" || typeof record.expiresAt !== "string") {
        throw new LocalRestEventError("invalid_stream");
      }
      const given = new URL(record.url);
      const expected = new URL(baseKey + route + record.id + "/");
      const expiresAt = Date.parse(record.expiresAt);
      // HTTP Date avoids assuming that the host clock equals this process clock.
      const serverTime = Date.parse(String(response.headers.date));
      const remaining = expiresAt - (Number.isFinite(serverTime) ? serverTime : Date.now());
      if (given.origin !== expected.origin || given.pathname !== expected.pathname ||
          given.username || given.password || given.hash || !Number.isFinite(remaining) || remaining <= 0) {
        throw new LocalRestEventError("invalid_stream");
      }
      slot.grant = { base: baseKey, id: record.id,
        expiresAt: Date.now() + Math.min(remaining, SUBSCRIPTION_TTL_SECONDS * 1000) };
    }
    openingGrant = true;
    // Signed query parameters are unnecessary for the authenticated internal client.
    resetDeadline(limits.handshakeMs);
    const opened = await client.request<Readable>({
      method: "GET",
      url: route + slot.grant.id + "/",
      headers: { Accept: "text/event-stream" },
      responseType: "stream",
      maxRedirects: 0,
      timeout: 0,
      signal: combined,
    });
    stream = opened.data;
    if (
      opened.status !== 200 ||
      !/^text\/event-stream(?:;|$)/iu.test(
        String(opened.headers["content-type"]),
      )
    ) {
      throw new LocalRestEventError("invalid_stream");
    }
    const parser = createParser({
      maxBufferSize: 262144,
      onError: () => {
        throw new LocalRestEventError("invalid_stream");
      },
      onEvent: (message) => {
        if (message.event !== event)
          throw new LocalRestEventError("invalid_stream");
        onEvent(projectVaultEvent(event, message.data, message.id));
      },
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    resetDeadline(limits.idleMs);
    onReady();
    for await (const chunk of stream) {
      if (combined.aborted) throw new LocalRestEventError("aborted");
      if (!Buffer.isBuffer(chunk) || chunk.length > 1048576)
        throw new LocalRestEventError("invalid_stream");
      resetDeadline(limits.idleMs);
      parser.feed(decoder.decode(chunk, { stream: true }));
    }
    throw new LocalRestEventError("unavailable");
  } catch (error) {
    if (signal.aborted) throw new LocalRestEventError("aborted");
    if (error instanceof LocalRestEventError) throw error;
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const failedStream = error.response?.data;
      if (failedStream && typeof failedStream.destroy === "function") failedStream.destroy();
      if (openingGrant && (status === 404 || status === 410)) {
        // The feature may still exist: only this subscription expired/reloaded.
        if (ownedSlot) ownedSlot.grant = undefined;
        throw new LocalRestEventError("unavailable");
      }
      if (status === 404) throw new LocalRestEventError("unsupported");
      if (status === 401 || status === 403)
        throw new LocalRestEventError("forbidden");
      throw new LocalRestEventError("unavailable");
    }
    throw new LocalRestEventError("invalid_stream");
  } finally {
    clearTimeout(deadline);
    controller.abort();
    stream?.destroy();
    if (ownedSlot) ownedSlot.active = false;
  }
}
