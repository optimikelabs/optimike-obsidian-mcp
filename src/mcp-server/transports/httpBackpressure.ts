import { HttpBindings } from "@hono/node-server";
import { Context, Next } from "hono";
import { z } from "zod";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  getHttpRequestState,
  type HttpOperationClass,
} from "./httpRequestState.js";

const DEFAULT_EXPENSIVE_TOOLS = [
  "smart_semantic_search",
  "smart_search",
  "smart-search",
  "obsidian_runtime_maintenance",
  "obsidian_global_search",
  "bases_query",
  "list_all_tasks",
  "query_tasks",
  "operon_get_configuration",
  "operon_validate",
  "external_read",
  "external_handoff",
].join(",");

const DEFAULT_MUTATION_TOOLS = [
  "obsidian_update_note",
  "obsidian_search_replace",
  "obsidian_delete_note",
  "obsidian_manage_frontmatter",
  "obsidian_batch_frontmatter",
  "obsidian_manage_tags",
  "obsidian_manage_canvas",
  "obsidian_admin_filesystem",
  "obsidian_move_note",
  "bases_create",
  "bases_upsert_config",
  "bases_upsert_rows",
  "operon_adopt_task",
  "operon_create_task",
  "operon_update_task",
  "operon_transition_task",
  "operon_convert_task",
  "operon_relocate_task",
].join(",");

function envInteger(defaultValue: number, min: number, max: number) {
  return z.preprocess(
    (value) =>
      value === undefined || value === null || value === ""
        ? defaultValue
        : value,
    z.coerce.number().int().min(min).max(max),
  );
}

const HttpBackpressureEnvSchema = z
  .object({
    MCP_HTTP_MAX_IN_FLIGHT: envInteger(32, 1, 10_000),
    MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY: envInteger(8, 1, 10_000),
    MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT: envInteger(4, 1, 10_000),
    MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY: envInteger(2, 1, 10_000),
    MCP_HTTP_MUTATION_MAX_IN_FLIGHT: envInteger(4, 1, 10_000),
    MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY: envInteger(1, 1, 10_000),
    MCP_HTTP_MAX_QUEUED: envInteger(64, 0, 100_000),
    MCP_HTTP_MAX_QUEUED_PER_IDENTITY: envInteger(8, 0, 100_000),
    MCP_HTTP_QUEUE_WAIT_TIMEOUT_MS: envInteger(5000, 1, 60 * 60 * 1000),
    MCP_HTTP_MAX_REQUEST_BODY_BYTES: envInteger(
      1024 * 1024,
      1024,
      16 * 1024 * 1024,
    ),
    MCP_HTTP_BACKPRESSURE_RETRY_AFTER_SECONDS: envInteger(1, 1, 3600),
    MCP_HTTP_EXPENSIVE_TOOLS: z.string().default(DEFAULT_EXPENSIVE_TOOLS),
    MCP_HTTP_MUTATION_TOOLS: z.string().default(DEFAULT_MUTATION_TOOLS),
  })
  .superRefine((value, ctx) => {
    const pairs: Array<[keyof typeof value, keyof typeof value]> = [
      ["MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY", "MCP_HTTP_MAX_IN_FLIGHT"],
      [
        "MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY",
        "MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT",
      ],
      [
        "MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY",
        "MCP_HTTP_MUTATION_MAX_IN_FLIGHT",
      ],
      ["MCP_HTTP_MAX_QUEUED_PER_IDENTITY", "MCP_HTTP_MAX_QUEUED"],
    ];
    for (const [perIdentity, global] of pairs) {
      if ((value[perIdentity] as number) > (value[global] as number)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [perIdentity],
          message: `${String(perIdentity)} cannot exceed ${String(global)}.`,
        });
      }
    }
    if (value.MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT > value.MCP_HTTP_MAX_IN_FLIGHT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT"],
        message: "Expensive-operation capacity cannot exceed global capacity.",
      });
    }
    if (
      value.MCP_HTTP_MUTATION_MAX_IN_FLIGHT >
      value.MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_HTTP_MUTATION_MAX_IN_FLIGHT"],
        message:
          "Mutation capacity cannot exceed expensive-operation capacity.",
      });
    }
  });

const parsedBackpressureEnv = HttpBackpressureEnvSchema.safeParse(process.env);
if (!parsedBackpressureEnv.success) {
  throw new Error(
    `Invalid HTTP backpressure configuration: ${JSON.stringify(
      parsedBackpressureEnv.error.flatten().fieldErrors,
    )}`,
  );
}

function parseToolSet(
  value: string,
  variableName: string,
): ReadonlySet<string> {
  const tools = value
    .split(/[\s,]+/u)
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (tools.length === 0) {
    throw new Error(`${variableName} must contain at least one tool name.`);
  }
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_.:-]+$/u.test(tool)) {
      throw new Error(`${variableName} contains an invalid tool name.`);
    }
  }
  return new Set(tools);
}

const backpressureEnv = parsedBackpressureEnv.data;

export const httpBackpressureConfig = {
  maxInFlight: backpressureEnv.MCP_HTTP_MAX_IN_FLIGHT,
  maxInFlightPerIdentity: backpressureEnv.MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY,
  expensiveMaxInFlight: backpressureEnv.MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT,
  expensiveMaxInFlightPerIdentity:
    backpressureEnv.MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY,
  mutationMaxInFlight: backpressureEnv.MCP_HTTP_MUTATION_MAX_IN_FLIGHT,
  mutationMaxInFlightPerIdentity:
    backpressureEnv.MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY,
  maxQueued: backpressureEnv.MCP_HTTP_MAX_QUEUED,
  maxQueuedPerIdentity: backpressureEnv.MCP_HTTP_MAX_QUEUED_PER_IDENTITY,
  queueWaitTimeoutMs: backpressureEnv.MCP_HTTP_QUEUE_WAIT_TIMEOUT_MS,
  maxRequestBodyBytes: backpressureEnv.MCP_HTTP_MAX_REQUEST_BODY_BYTES,
  retryAfterSeconds: backpressureEnv.MCP_HTTP_BACKPRESSURE_RETRY_AFTER_SECONDS,
  expensiveTools: parseToolSet(
    backpressureEnv.MCP_HTTP_EXPENSIVE_TOOLS,
    "MCP_HTTP_EXPENSIVE_TOOLS",
  ),
  mutationTools: parseToolSet(
    backpressureEnv.MCP_HTTP_MUTATION_TOOLS,
    "MCP_HTTP_MUTATION_TOOLS",
  ),
};

export type AdmissionRejectReason =
  | "queue-full"
  | "identity-queue-full"
  | "timeout"
  | "cancelled";

export class AdmissionRejectedError extends Error {
  public readonly name = "AdmissionRejectedError";

  constructor(
    public readonly reason: AdmissionRejectReason,
    public readonly retryAfterSeconds: number,
  ) {
    super(`HTTP admission rejected: ${reason}`);
  }
}

export type AdmissionLease = {
  queued: boolean;
  waitMs: number;
  release: () => void;
};

export type AdmissionSnapshot = {
  inFlight: number;
  expensiveInFlight: number;
  mutationInFlight: number;
  queued: number;
  activeIdentities: number;
  queuedIdentities: number;
  admitted: number;
  rejectedQueueFull: number;
  rejectedIdentityQueueFull: number;
  timedOut: number;
  cancelled: number;
  maxObservedInFlight: number;
  maxObservedQueued: number;
};

type QueueItem = {
  id: number;
  identityKey: string;
  operationClass: HttpOperationClass;
  enqueuedAt: number;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: AdmissionRejectedError) => void;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
  settled: boolean;
};

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

export class FairAdmissionController {
  private inFlight = 0;
  private expensiveInFlight = 0;
  private mutationInFlight = 0;
  private readonly inFlightByIdentity = new Map<string, number>();
  private readonly expensiveByIdentity = new Map<string, number>();
  private readonly mutationByIdentity = new Map<string, number>();
  private readonly queueByIdentity = new Map<string, QueueItem[]>();
  private readonly identityOrder: string[] = [];
  private queued = 0;
  private nextQueueId = 1;
  private admitted = 0;
  private rejectedQueueFull = 0;
  private rejectedIdentityQueueFull = 0;
  private timedOut = 0;
  private cancelled = 0;
  private maxObservedInFlight = 0;
  private maxObservedQueued = 0;

  constructor(
    private readonly limits: {
      maxInFlight: number;
      maxInFlightPerIdentity: number;
      expensiveMaxInFlight: number;
      expensiveMaxInFlightPerIdentity: number;
      mutationMaxInFlight: number;
      mutationMaxInFlightPerIdentity: number;
      maxQueued: number;
      maxQueuedPerIdentity: number;
      queueWaitTimeoutMs: number;
      retryAfterSeconds: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.limits.now?.() ?? Date.now();
  }

  private canGrant(
    identityKey: string,
    operationClass: HttpOperationClass,
  ): boolean {
    if (this.inFlight >= this.limits.maxInFlight) return false;
    if (
      (this.inFlightByIdentity.get(identityKey) ?? 0) >=
      this.limits.maxInFlightPerIdentity
    ) {
      return false;
    }
    if (operationClass !== "standard") {
      if (this.expensiveInFlight >= this.limits.expensiveMaxInFlight) {
        return false;
      }
      if (
        (this.expensiveByIdentity.get(identityKey) ?? 0) >=
        this.limits.expensiveMaxInFlightPerIdentity
      ) {
        return false;
      }
    }
    if (operationClass === "mutation") {
      if (this.mutationInFlight >= this.limits.mutationMaxInFlight) {
        return false;
      }
      if (
        (this.mutationByIdentity.get(identityKey) ?? 0) >=
        this.limits.mutationMaxInFlightPerIdentity
      ) {
        return false;
      }
    }
    return true;
  }

  private grant(
    identityKey: string,
    operationClass: HttpOperationClass,
    queued: boolean,
    waitMs: number,
  ): AdmissionLease {
    this.inFlight += 1;
    increment(this.inFlightByIdentity, identityKey);
    if (operationClass !== "standard") {
      this.expensiveInFlight += 1;
      increment(this.expensiveByIdentity, identityKey);
    }
    if (operationClass === "mutation") {
      this.mutationInFlight += 1;
      increment(this.mutationByIdentity, identityKey);
    }
    this.admitted += 1;
    this.maxObservedInFlight = Math.max(
      this.maxObservedInFlight,
      this.inFlight,
    );

    let released = false;
    return {
      queued,
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
        decrement(this.inFlightByIdentity, identityKey);
        if (operationClass !== "standard") {
          this.expensiveInFlight -= 1;
          decrement(this.expensiveByIdentity, identityKey);
        }
        if (operationClass === "mutation") {
          this.mutationInFlight -= 1;
          decrement(this.mutationByIdentity, identityKey);
        }
        this.dispatch();
      },
    };
  }

  public acquire(input: {
    identityKey: string;
    operationClass: HttpOperationClass;
    signal?: AbortSignal;
  }): Promise<AdmissionLease> {
    if (input.signal?.aborted) {
      this.cancelled += 1;
      return Promise.reject(
        new AdmissionRejectedError("cancelled", this.limits.retryAfterSeconds),
      );
    }

    if (
      this.queued === 0 &&
      this.canGrant(input.identityKey, input.operationClass)
    ) {
      return Promise.resolve(
        this.grant(input.identityKey, input.operationClass, false, 0),
      );
    }

    if (this.queued >= this.limits.maxQueued) {
      this.rejectedQueueFull += 1;
      return Promise.reject(
        new AdmissionRejectedError("queue-full", this.limits.retryAfterSeconds),
      );
    }
    const identityQueue = this.queueByIdentity.get(input.identityKey) ?? [];
    if (identityQueue.length >= this.limits.maxQueuedPerIdentity) {
      this.rejectedIdentityQueueFull += 1;
      return Promise.reject(
        new AdmissionRejectedError(
          "identity-queue-full",
          this.limits.retryAfterSeconds,
        ),
      );
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const item: QueueItem = {
        id: this.nextQueueId++,
        identityKey: input.identityKey,
        operationClass: input.operationClass,
        enqueuedAt: this.now(),
        resolve,
        reject,
        signal: input.signal,
        settled: false,
      };

      if (identityQueue.length === 0) {
        this.queueByIdentity.set(input.identityKey, identityQueue);
        this.identityOrder.push(input.identityKey);
      }
      identityQueue.push(item);
      this.queued += 1;
      this.maxObservedQueued = Math.max(this.maxObservedQueued, this.queued);

      item.timeout = setTimeout(() => {
        if (!this.removeQueuedItem(item)) return;
        this.timedOut += 1;
        item.reject(
          new AdmissionRejectedError("timeout", this.limits.retryAfterSeconds),
        );
        this.dispatch();
      }, this.limits.queueWaitTimeoutMs);
      item.timeout.unref?.();

      if (input.signal) {
        item.abortHandler = () => {
          if (!this.removeQueuedItem(item)) return;
          this.cancelled += 1;
          item.reject(
            new AdmissionRejectedError(
              "cancelled",
              this.limits.retryAfterSeconds,
            ),
          );
          this.dispatch();
        };
        input.signal.addEventListener("abort", item.abortHandler, {
          once: true,
        });
        if (input.signal.aborted) {
          item.abortHandler();
          return;
        }
      }

      this.dispatch();
    });
  }

  private cleanupQueueItem(item: QueueItem): void {
    if (item.timeout) clearTimeout(item.timeout);
    if (item.signal && item.abortHandler) {
      item.signal.removeEventListener("abort", item.abortHandler);
    }
    item.settled = true;
  }

  private removeQueuedItem(item: QueueItem): boolean {
    if (item.settled) return false;
    const queue = this.queueByIdentity.get(item.identityKey);
    if (!queue) return false;
    const index = queue.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) return false;
    queue.splice(index, 1);
    this.queued -= 1;
    this.cleanupQueueItem(item);
    if (queue.length === 0) {
      this.queueByIdentity.delete(item.identityKey);
      const orderIndex = this.identityOrder.indexOf(item.identityKey);
      if (orderIndex !== -1) this.identityOrder.splice(orderIndex, 1);
    }
    return true;
  }

  private dispatch(): void {
    if (this.identityOrder.length === 0) return;

    let attemptsWithoutProgress = this.identityOrder.length;
    while (this.identityOrder.length > 0 && attemptsWithoutProgress > 0) {
      const identityKey = this.identityOrder.shift()!;
      const queue = this.queueByIdentity.get(identityKey);
      if (!queue || queue.length === 0) {
        this.queueByIdentity.delete(identityKey);
        attemptsWithoutProgress -= 1;
        continue;
      }

      const item = queue[0];
      if (!this.canGrant(identityKey, item.operationClass)) {
        this.identityOrder.push(identityKey);
        attemptsWithoutProgress -= 1;
        continue;
      }

      queue.shift();
      this.queued -= 1;
      this.cleanupQueueItem(item);
      if (queue.length > 0) this.identityOrder.push(identityKey);
      else this.queueByIdentity.delete(identityKey);

      const waitMs = Math.max(0, this.now() - item.enqueuedAt);
      item.resolve(this.grant(identityKey, item.operationClass, true, waitMs));
      attemptsWithoutProgress = this.identityOrder.length;
    }
  }

  public getSnapshot(): AdmissionSnapshot {
    return {
      inFlight: this.inFlight,
      expensiveInFlight: this.expensiveInFlight,
      mutationInFlight: this.mutationInFlight,
      queued: this.queued,
      activeIdentities: this.inFlightByIdentity.size,
      queuedIdentities: this.queueByIdentity.size,
      admitted: this.admitted,
      rejectedQueueFull: this.rejectedQueueFull,
      rejectedIdentityQueueFull: this.rejectedIdentityQueueFull,
      timedOut: this.timedOut,
      cancelled: this.cancelled,
      maxObservedInFlight: this.maxObservedInFlight,
      maxObservedQueued: this.maxObservedQueued,
    };
  }
}

export const httpAdmissionController = new FairAdmissionController({
  maxInFlight: httpBackpressureConfig.maxInFlight,
  maxInFlightPerIdentity: httpBackpressureConfig.maxInFlightPerIdentity,
  expensiveMaxInFlight: httpBackpressureConfig.expensiveMaxInFlight,
  expensiveMaxInFlightPerIdentity:
    httpBackpressureConfig.expensiveMaxInFlightPerIdentity,
  mutationMaxInFlight: httpBackpressureConfig.mutationMaxInFlight,
  mutationMaxInFlightPerIdentity:
    httpBackpressureConfig.mutationMaxInFlightPerIdentity,
  maxQueued: httpBackpressureConfig.maxQueued,
  maxQueuedPerIdentity: httpBackpressureConfig.maxQueuedPerIdentity,
  queueWaitTimeoutMs: httpBackpressureConfig.queueWaitTimeoutMs,
  retryAfterSeconds: httpBackpressureConfig.retryAfterSeconds,
});

export type HttpOperationDescriptor = {
  operationClass: HttpOperationClass;
  operationName: string;
  rpcId: string | number | null;
};

type JsonRpcEnvelope = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

class RequestBodyTooLargeError extends Error {
  public readonly name = "RequestBodyTooLargeError";
}

function cancelRequestBody(request: Request, reason: string): void {
  void request.body?.cancel(reason).catch(() => undefined);
}

async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    cancelRequestBody(request, "declared request body limit exceeded");
    throw new RequestBodyTooLargeError();
  }

  const clone = request.clone();
  if (!clone.body) return undefined;
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        void reader
          .cancel("request body limit exceeded")
          .catch(() => undefined);
        cancelRequestBody(request, "request body limit exceeded");
        throw new RequestBodyTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function classifyEnvelope(envelope: JsonRpcEnvelope): HttpOperationDescriptor {
  const rpcId =
    typeof envelope.id === "string" || typeof envelope.id === "number"
      ? envelope.id
      : null;
  const method =
    typeof envelope.method === "string" ? envelope.method : "invalid-jsonrpc";
  if (method !== "tools/call") {
    return {
      operationClass: "standard",
      operationName: method,
      rpcId,
    };
  }

  const params =
    envelope.params && typeof envelope.params === "object"
      ? (envelope.params as Record<string, unknown>)
      : undefined;
  const toolName =
    typeof params?.name === "string" ? params.name : "tools/call";
  if (httpBackpressureConfig.mutationTools.has(toolName)) {
    return { operationClass: "mutation", operationName: toolName, rpcId };
  }
  if (httpBackpressureConfig.expensiveTools.has(toolName)) {
    return { operationClass: "expensive", operationName: toolName, rpcId };
  }
  return { operationClass: "standard", operationName: toolName, rpcId };
}

export async function classifyHttpOperation(
  c: Context<{ Bindings: HttpBindings }>,
): Promise<HttpOperationDescriptor> {
  if (c.req.path === "/external-handoff") {
    return {
      operationClass: "expensive",
      operationName: "external_handoff_delivery",
      rpcId: null,
    };
  }
  if (c.req.method !== "POST") {
    return {
      operationClass: "standard",
      operationName: `${c.req.method} ${c.req.path}`,
      rpcId: null,
    };
  }

  try {
    const payload = (await readBoundedJsonBody(
      c.req.raw,
      httpBackpressureConfig.maxRequestBodyBytes,
    )) as JsonRpcEnvelope | JsonRpcEnvelope[];
    const envelopes = Array.isArray(payload) ? payload : [payload];
    const classified = envelopes.map(classifyEnvelope);
    return (
      classified.find((item) => item.operationClass === "mutation") ??
      classified.find((item) => item.operationClass === "expensive") ??
      classified[0] ?? {
        operationClass: "standard",
        operationName: "empty-batch",
        rpcId: null,
      }
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return {
      operationClass: "standard",
      operationName: "invalid-json",
      rpcId: null,
    };
  }
}

function requestBodyTooLargeResponse(
  c: Context<{ Bindings: HttpBindings }>,
): Response {
  const state = getHttpRequestState(c.req.raw);
  c.header("X-Request-Id", state.requestId);
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: BaseErrorCode.VALIDATION_ERROR,
        message: "The HTTP request body exceeds the configured limit.",
        data: {
          maxBytes: httpBackpressureConfig.maxRequestBodyBytes,
        },
      },
      id: null,
    },
    413,
  );
}

function wrapAdmissionResponse(
  c: Context<{ Bindings: HttpBindings }>,
  lease: AdmissionLease,
): void {
  const state = getHttpRequestState(c.req.raw);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
    if (state.admission) state.admission.releasedAt = Date.now();
  };
  const response = c.res;
  if (!response.body) {
    release();
    return;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  c.res = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function rejectionMessage(reason: AdmissionRejectReason): string {
  switch (reason) {
    case "queue-full":
      return "The HTTP operation queue is full.";
    case "identity-queue-full":
      return "This client identity already has the maximum number of queued operations.";
    case "timeout":
      return "The operation was not admitted before its queue timeout.";
    case "cancelled":
      return "The operation was cancelled before admission.";
  }
}

function admissionRejectionResponse(
  c: Context<{ Bindings: HttpBindings }>,
  descriptor: HttpOperationDescriptor,
  error: AdmissionRejectedError,
): Response {
  const state = getHttpRequestState(c.req.raw);
  state.admission = {
    operationClass: descriptor.operationClass,
    operationName: descriptor.operationName,
    queued: error.reason === "timeout" || error.reason === "cancelled",
    waitMs: Math.max(0, Date.now() - state.startedAt),
    outcome: error.reason,
  };
  c.header("Retry-After", String(error.retryAfterSeconds));
  c.header("X-Optimike-Backpressure", error.reason);
  c.header("X-Optimike-Operation-Class", descriptor.operationClass);
  c.header("X-Request-Id", state.requestId);
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: BaseErrorCode.SERVICE_UNAVAILABLE,
        message: rejectionMessage(error.reason),
        data: {
          retryable: error.reason !== "cancelled",
          admission: error.reason,
        },
      },
      id: descriptor.rpcId,
    },
    503,
  );
}

export function createHttpBackpressureMiddleware(
  controller: FairAdmissionController = httpAdmissionController,
) {
  return async function httpBackpressureMiddleware(
    c: Context<{ Bindings: HttpBindings }>,
    next: Next,
  ): Promise<void | Response> {
    // A stateful MCP GET may hold a streaming connection. Sessions are already
    // bounded separately; operational slots are reserved for POST/DELETE and
    // auxiliary artifact delivery rather than long-lived event streams.
    if (c.req.path === "/mcp" && c.req.method === "GET") {
      await next();
      return;
    }

    const state = getHttpRequestState(c.req.raw);
    const identity = state.identity;
    if (!identity) {
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        "Verified client identity is unavailable for admission control.",
      );
    }
    const parsingDescriptor: HttpOperationDescriptor = {
      operationClass: "standard",
      operationName: "request-body",
      rpcId: null,
    };
    const signal =
      c.req.path === "/external-handoff" ? undefined : c.req.raw.signal;
    let descriptor: HttpOperationDescriptor;
    let lease: AdmissionLease | undefined;

    if (c.req.method === "POST") {
      try {
        lease = await controller.acquire({
          identityKey: identity.key,
          operationClass: "standard",
          signal,
        });
      } catch (error) {
        if (!(error instanceof AdmissionRejectedError)) throw error;
        return admissionRejectionResponse(c, parsingDescriptor, error);
      }
      try {
        descriptor = await classifyHttpOperation(c);
      } catch (error) {
        lease.release();
        if (error instanceof RequestBodyTooLargeError) {
          return requestBodyTooLargeResponse(c);
        }
        throw error;
      }
      if (descriptor.operationClass !== "standard") {
        lease.release();
        lease = undefined;
      }
    } else {
      descriptor = await classifyHttpOperation(c);
    }

    if (!lease) {
      try {
        lease = await controller.acquire({
          identityKey: identity.key,
          operationClass: descriptor.operationClass,
          // Once a valid external handoff request reaches the server, its one-use
          // ticket must be consumed even if the socket disappears immediately.
          // The bounded queue timeout still prevents orphaned work from waiting
          // indefinitely. Other operations remain abort-aware before admission.
          signal,
        });
      } catch (error) {
        if (!(error instanceof AdmissionRejectedError)) throw error;
        return admissionRejectionResponse(c, descriptor, error);
      }
    }

    state.admission = {
      operationClass: descriptor.operationClass,
      operationName: descriptor.operationName,
      queued: lease.queued,
      waitMs: lease.waitMs,
      outcome: "admitted",
      admittedAt: Date.now(),
    };
    c.header("X-Optimike-Operation-Class", descriptor.operationClass);
    c.header("X-Optimike-Queue-Wait-Ms", String(lease.waitMs));
    try {
      await next();
      wrapAdmissionResponse(c, lease);
    } catch (error) {
      lease.release();
      if (state.admission) state.admission.releasedAt = Date.now();
      throw error;
    }
  };
}
