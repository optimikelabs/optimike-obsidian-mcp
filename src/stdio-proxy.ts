#!/usr/bin/env node

import "./config/toolProfileCli.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ExternalHandoffSchema,
  ExternalListSchema,
  ExternalMoveApplySchema,
  ExternalMovePlanSchema,
  ExternalMoveRollbackSchema,
  ExternalMoveStatusSchema,
  ExternalReadSchema,
  ExternalReferencesScanSchema,
  ExternalStatSchema,
  externalRootsResult,
} from "./mcp-server/tools/externalRootsTools/registration.js";
import {
  compileToolProfileNames,
  selectAvailableToolProfileNames,
  type ToolProfileId,
} from "./mcp-server/toolProfiles.js";
import { resolveToolProfile } from "./mcp-server/toolProfileRuntime.js";
import { config, profileExternalMoveJournalPath } from "./config/index.js";
import { ensureLocalBackendRunning } from "./runtime/localBackend.js";
import {
  ExternalRootError,
  ExternalRootsService,
  externalMoveMutationUnavailableError,
  moveMutationStatus,
} from "./services/externalRootsService.js";
import {
  attestVaultFilesystemTarget,
  BackendVaultTargetUnverifiedError,
  BackendVaultAdapter,
} from "./services/externalReferences/backendVaultAdapter.js";
import type { ExternalMoveBindingIdentity } from "./services/externalReferences/backendVaultAdapter.js";
import {
  ExternalMoveCoordinator,
  projectExternalMovePlanForUnavailableDestructiveSession,
} from "./services/externalReferences/externalMoveCoordinator.js";
import {
  ExternalMoveJournal,
  isExternalMoveJournalObservationConsistent,
} from "./services/externalReferences/externalMoveJournal.js";
import type {
  ExternalMoveJournalObservation,
  ExternalMovePlan,
  ExternalMovePlanStatus,
} from "./services/externalReferences/externalMoveJournal.js";
import {
  safelyReadUntrustedErrorField,
  safelySnapshotUntrustedErrorArray,
} from "./utils/security/safeErrorField.js";

type PackageInfo = { name?: string; version?: string };
type BackendClient = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};
type BackendConnection = BackendClient & {
  generation: number;
  sessionId: string;
  inFlight: number;
  retired: boolean;
  retiredTimer?: NodeJS.Timeout;
  closePromise?: Promise<void>;
};
type BackendFailureKind = "application" | "network" | "session-invalid";
type NetworkReplayPolicy = boolean | { toolName: string };
type BackendRetryOptions<T> = {
  /** Only calls with an explicit readOnlyHint may be replayed after a network loss. */
  replayNetworkFailure: NetworkReplayPolicy;
  onSuccess?: (result: { generation: number; value: T }) => void;
};

class BackendOperationError extends Error {
  constructor(
    readonly generation: number,
    readonly originalError: unknown,
    readonly networkReplayAuthorized: boolean,
  ) {
    super("Backend operation failed");
  }
}

class BackendGenerationChangedError extends Error {}

class BackendReplayNotAuthorizedError extends Error {}

const packageInfo = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as PackageInfo;

const packageName = packageInfo.name ?? "optimike-obsidian-mcp";
const packageVersion = packageInfo.version ?? "0.0.0";
const projectRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
const port = Number(process.env.MCP_HTTP_PORT || "3010");
// The proxy applies its own per-client profile. Its shared backend therefore
// uses the explicit unfiltered endpoint even though /mcp defaults to standard.
const backendUrl = new URL(`http://${host}:${port}/mcp/full`);
const healthUrl = new URL(`http://${host}:${port}/healthz`);
const backendBearerToken = process.env.MCP_BACKEND_BEARER_TOKEN?.trim();
const toolProfile: ToolProfileId = resolveToolProfile();
const FAIL_CLOSED_EXTERNAL_MOVE_MUTATION_TOOLS = new Set([
  "external_move_apply",
  "external_move_rollback",
] as const);
// These two names are implemented by this proxy (not forwarded to the backend)
// and are registered in every server mode. Decide their profile visibility from
// the static profile contract before any backend metadata request: an unavailable
// backend must not turn a known fail-closed endpoint into an indeterminate one.
const staticallyVisibleLocalExternalMoveMutationTools = new Set(
  compileToolProfileNames({
    profile: toolProfile,
    registrationMode: "headless-readonly",
  }),
);

function isLocalFailClosedExternalMoveMutationTool(
  toolName: string,
): toolName is "external_move_apply" | "external_move_rollback" {
  return FAIL_CLOSED_EXTERNAL_MOVE_MUTATION_TOOLS.has(
    toolName as "external_move_apply" | "external_move_rollback",
  );
}

function localFailClosedExternalMoveMutationIsVisible(
  toolName: "external_move_apply" | "external_move_rollback",
): boolean {
  return staticallyVisibleLocalExternalMoveMutationTools.has(toolName);
}

const proxyServer = new Server(
  { name: `${packageName}-stdio-proxy`, version: packageVersion },
  { capabilities: { tools: { listChanged: true } } },
);

let backend: BackendConnection | undefined;
let backendGeneration = 0;
let initialConnectionPromise: Promise<BackendConnection> | undefined;
let reconnectPromise: Promise<BackendConnection> | undefined;
let allowedToolNames: Set<string> | undefined;
let readOnlyToolNames: Set<string> | undefined;
let toolMetadataGeneration: number | undefined;
const retiredConnections = new Set<BackendConnection>();
let externalRootsService: ExternalRootsService | undefined;
let externalMoveCoordinator: ExternalMoveCoordinator | undefined;
let externalMoveBindingIdentity: ExternalMoveBindingIdentity | undefined;
let externalMoveUnavailableReason:
  | "not_requested"
  | "profile_required"
  | "target_unverified"
  | "backend_attestation_unavailable" = "not_requested";

function boundedDurationFromEnvironment(
  name: string,
  fallbackMs: number,
): number {
  const configured = Number(process.env[name] ?? fallbackMs);
  return Number.isFinite(configured) &&
    configured >= 1_000 &&
    configured <= 300_000
    ? Math.floor(configured)
    : fallbackMs;
}

const retiredDrainTimeoutMs = boundedDurationFromEnvironment(
  "MCP_PROXY_RETIRED_DRAIN_TIMEOUT_MS",
  30_000,
);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function rootConfigFingerprint(filePath: string): string {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return createHash("sha256")
    .update("optimike.external-move.roots.v1\0", "utf8")
    .update(canonicalJson(parsed), "utf8")
    .digest("hex");
}

function disabledExternalRoots(): Promise<never> {
  return Promise.reject(
    new ExternalRootError(
      "configuration_invalid",
      "External roots are disabled. Configure MCP_EXTERNAL_ROOTS_FILE to enable them.",
    ),
  );
}

function unavailableExternalMove(): Promise<never> {
  return Promise.reject(
    new ExternalRootError(
      "configuration_invalid",
      "External move is unavailable because its destructive target could not be verified.",
    ),
  );
}

function disabledExternalMoveMutation(): Promise<never> {
  return Promise.reject(externalMoveMutationUnavailableError());
}

function unknownExternalMovePlan(): Promise<never> {
  return Promise.reject(
    new ExternalRootError("not_found", "Unknown external move plan."),
  );
}

const EXTERNAL_MOVE_JOURNAL_SUFFIXES = ["", "-wal"] as const;

function removePrivateJournalSnapshot(directory: string): void {
  try {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  } catch {
    throw new Error("Private external move status snapshot cleanup failed.");
  }
}

function externalMoveJournalSnapshotSignature(
  journalPath: string,
): Array<{ suffix: string; size: string; mtimeNs: string }> {
  return EXTERNAL_MOVE_JOURNAL_SUFFIXES.flatMap((suffix) => {
    const filePath = `${journalPath}${suffix}`;
    if (!existsSync(filePath)) return [];
    const metadata = statSync(filePath, { bigint: true });
    return [
      {
        suffix,
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
      },
    ];
  });
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Copies a stable DB/WAL generation outside the repository before SQLite
 * opens it. SQLite rebuilds a private SHM and may checkpoint the private copy,
 * but never touches the operator's durable journal merely to serve status.
 */
function snapshotExternalMoveJournal(journalPath: string): {
  directory: string;
  databasePath: string;
} {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "optimike-external-status-"),
    );
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Windows ACLs remain authoritative when POSIX modes are unavailable.
    }
    const databasePath = path.join(directory, path.basename(journalPath));
    try {
      const before = externalMoveJournalSnapshotSignature(journalPath);
      if (!before.some((item) => item.suffix === "")) {
        throw new Error("The external move journal is absent.");
      }
      for (const { suffix } of before) {
        const copiedPath = `${databasePath}${suffix}`;
        copyFileSync(`${journalPath}${suffix}`, copiedPath);
        try {
          chmodSync(copiedPath, 0o600);
        } catch {
          // Windows ACLs remain authoritative when POSIX modes are unavailable.
        }
      }
      const afterCopy = externalMoveJournalSnapshotSignature(journalPath);
      const copiedGenerationIsStable =
        JSON.stringify(afterCopy) === JSON.stringify(before) &&
        afterCopy.every(
          ({ suffix }) =>
            sha256File(`${journalPath}${suffix}`) ===
            sha256File(`${databasePath}${suffix}`),
        ) &&
        JSON.stringify(externalMoveJournalSnapshotSignature(journalPath)) ===
          JSON.stringify(afterCopy);
      if (copiedGenerationIsStable) return { directory, databasePath };
    } catch {
      // A concurrent writer may rotate or append the WAL during the copy.
      // Retry from a fresh private directory; never open an unstable snapshot.
    }
    removePrivateJournalSnapshot(directory);
  }
  throw new Error("The external move journal changed during status snapshot.");
}

function readExternalMovePlanFromJournal(
  journalPath: string,
  planId: string,
): ExternalMovePlan | undefined {
  if (!existsSync(journalPath)) return undefined;
  let db: DatabaseSync | undefined;
  let snapshotDirectory: string | undefined;
  try {
    const snapshot = snapshotExternalMoveJournal(journalPath);
    snapshotDirectory = snapshot.directory;
    db = new DatabaseSync(snapshot.databasePath);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA query_only=ON");
    const row = db
      .prepare(
        `SELECT plan_id, idempotency_key, status, payload_json, updated_at
         FROM external_move_plans WHERE plan_id = ?`,
      )
      .get(planId) as
      | {
          plan_id?: unknown;
          idempotency_key?: unknown;
          status?: unknown;
          payload_json?: unknown;
          updated_at?: unknown;
        }
      | undefined;
    if (
      typeof row?.plan_id !== "string" ||
      typeof row.idempotency_key !== "string" ||
      typeof row.status !== "string" ||
      typeof row.payload_json !== "string" ||
      typeof row.updated_at !== "string"
    ) {
      return undefined;
    }
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const observed: ExternalMoveJournalObservation = {
      plan: parsed as ExternalMovePlan,
      planId: row.plan_id,
      idempotencyKey: row.idempotency_key,
      status: row.status as ExternalMovePlanStatus,
      rawPayload: row.payload_json,
      updatedAt: row.updated_at,
    };
    return isExternalMoveJournalObservationConsistent(observed)
      ? observed.plan
      : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Cleanup of the sensitive private copy remains mandatory even if the
      // temporary SQLite handle itself reports a close failure.
    } finally {
      if (snapshotDirectory) {
        removePrivateJournalSnapshot(snapshotDirectory);
      }
    }
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Returns only already-existing durable journal paths. Current journals are
 * namespaced by the first 24 hex characters of their private binding digest;
 * older pre-attestation journals used the configured base filename directly.
 * Discovery never creates or opens a writable database.
 */
function externalMoveJournalCandidates(): string[] {
  const basePath = config.externalMoveJournalPath;
  if (basePath === ":memory:") return [];
  const parsed = path.parse(basePath);
  const directory = parsed.dir || ".";
  const extension = parsed.ext || ".sqlite";
  const stem = parsed.ext ? parsed.name : parsed.base;
  const profiledName = new RegExp(
    `^${escapeRegularExpression(stem)}\\.[a-f0-9]{24}${escapeRegularExpression(extension)}$`,
    "u",
  );
  let profiledPaths: string[] = [];
  try {
    profiledPaths = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && profiledName.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    // The journal directory may not exist yet. Status remains read-only and
    // must not create it merely to report that no receipt is available.
  }
  return [...new Set([basePath, ...profiledPaths])];
}

/**
 * Reads legacy and current profiled journals without constructing a new
 * destructive binding. A duplicate plan ID across journals is ambiguous and
 * therefore fails closed instead of selecting an arbitrary vault/profile.
 */
function getStoredExternalMovePlan(
  planId: string,
): ExternalMovePlan | undefined {
  let match: ExternalMovePlan | undefined;
  for (const journalPath of externalMoveJournalCandidates()) {
    const candidate = readExternalMovePlanFromJournal(journalPath, planId);
    if (!candidate) continue;
    if (match) return undefined;
    match = candidate;
  }
  return match;
}

function invalidExternalArguments(toolName: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "path_invalid",
            message: `Invalid ${toolName} arguments.`,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function hiddenToolResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: "tool_not_exposed",
            message:
              "The requested tool is not exposed by the active MCP tool profile.",
            toolProfile,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const STREAMABLE_HTTP_POST_ERROR_PREFIX =
  "Streamable HTTP error: Error POSTing to endpoint: ";
const SESSION_INVALID_MESSAGES = new Set([
  "Invalid or expired session ID.",
  "Session not found or expired.",
]);
const HTTP_ADMISSION_ERROR_CODE = -32015;
const MAX_HTTP_ADMISSION_ERROR_BODY_BYTES = 8 * 1024;
const HTTP_ADMISSION_MESSAGES = new Map([
  ["queue-full", "The HTTP operation queue is full."],
  [
    "identity-queue-full",
    "This client identity already has the maximum number of queued operations.",
  ],
  ["timeout", "The operation was not admitted before its queue timeout."],
  ["cancelled", "The operation was cancelled before admission."],
] as const);
const HTTP_ADMISSION_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type HttpAdmissionReason =
  | "queue-full"
  | "identity-queue-full"
  | "timeout"
  | "cancelled";
type HttpAdmissionError = {
  applicationCode: "SERVICE_UNAVAILABLE";
  admission: HttpAdmissionReason;
  retryable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const observed = Object.keys(value);
  return (
    observed.length === keys.length &&
    observed.every((key) => keys.includes(key))
  );
}

/**
 * Only the server-owned HTTP admission envelope is safe to project through
 * stdio. Its request correlation id and any future HTTP-only fields remain on
 * the HTTP boundary; all other application failures stay status-only.
 */
function parseHttpAdmissionError(
  error: unknown,
): HttpAdmissionError | undefined {
  if (!(error instanceof StreamableHTTPError) || error.code !== 503) {
    return undefined;
  }
  if (!error.message.startsWith(STREAMABLE_HTTP_POST_ERROR_PREFIX)) {
    return undefined;
  }
  const responseBody = error.message.slice(
    STREAMABLE_HTTP_POST_ERROR_PREFIX.length,
  );
  if (
    Buffer.byteLength(responseBody, "utf8") >
    MAX_HTTP_ADMISSION_ERROR_BODY_BYTES
  ) {
    return undefined;
  }
  try {
    const body = JSON.parse(responseBody) as unknown;
    if (
      !isRecord(body) ||
      !hasExactlyKeys(body, ["jsonrpc", "error", "id"]) ||
      body.jsonrpc !== "2.0" ||
      !(
        body.id === null ||
        typeof body.id === "string" ||
        (typeof body.id === "number" && Number.isFinite(body.id))
      ) ||
      !isRecord(body.error) ||
      !hasExactlyKeys(body.error, ["code", "message", "data"]) ||
      body.error.code !== HTTP_ADMISSION_ERROR_CODE ||
      !isRecord(body.error.data) ||
      !hasExactlyKeys(body.error.data, [
        "applicationCode",
        "admission",
        "retryable",
        "requestId",
      ]) ||
      body.error.data.applicationCode !== "SERVICE_UNAVAILABLE" ||
      typeof body.error.data.admission !== "string" ||
      !HTTP_ADMISSION_MESSAGES.has(
        body.error.data.admission as HttpAdmissionReason,
      ) ||
      body.error.message !==
        HTTP_ADMISSION_MESSAGES.get(
          body.error.data.admission as HttpAdmissionReason,
        ) ||
      typeof body.error.data.retryable !== "boolean" ||
      body.error.data.retryable !==
        (body.error.data.admission !== "cancelled") ||
      typeof body.error.data.requestId !== "string" ||
      !HTTP_ADMISSION_REQUEST_ID.test(body.error.data.requestId)
    ) {
      return undefined;
    }
    return {
      applicationCode: "SERVICE_UNAVAILABLE",
      admission: body.error.data.admission as HttpAdmissionReason,
      retryable: body.error.data.retryable,
    };
  } catch {
    return undefined;
  }
}

function errorHasNetworkCause(
  error: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const code = safelyReadUntrustedErrorField(error, "code");
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  const errors = safelyReadUntrustedErrorField(error, "errors");
  const nestedErrors = safelySnapshotUntrustedErrorArray(errors);
  if (nestedErrors) {
    for (const nested of nestedErrors) {
      if (errorHasNetworkCause(nested, seen)) return true;
    }
  }
  return errorHasNetworkCause(
    safelyReadUntrustedErrorField(error, "cause"),
    seen,
  );
}

function streamableHttpApplicationMessage(
  error: StreamableHTTPError,
): string | undefined {
  if (!error.message.startsWith(STREAMABLE_HTTP_POST_ERROR_PREFIX)) {
    return undefined;
  }
  const responseBody = error.message.slice(
    STREAMABLE_HTTP_POST_ERROR_PREFIX.length,
  );
  try {
    const parsed = JSON.parse(responseBody) as {
      error?: { message?: unknown };
    };
    return typeof parsed.error?.message === "string"
      ? parsed.error.message
      : undefined;
  } catch {
    return responseBody;
  }
}

function classifyBackendFailure(error: unknown): BackendFailureKind {
  // HTTP replies are application outcomes. Only the Streamable HTTP session
  // contract gives its exact 404 payload the special meaning that the handler
  // was not entered. A generic 404 can be an application/route outcome.
  if (error instanceof StreamableHTTPError) {
    return error.code === 404 &&
      SESSION_INVALID_MESSAGES.has(
        streamableHttpApplicationMessage(error) ?? "",
      )
      ? "session-invalid"
      : "application";
  }
  return errorHasNetworkCause(error) ? "network" : "application";
}

function redactedBackendFailureDetail(error: unknown): string {
  const rawCode = safelyReadUntrustedErrorField(error, "code");
  const safeCode =
    (typeof rawCode === "string" && /^[A-Z0-9_.-]{1,64}$/u.test(rawCode)) ||
    (typeof rawCode === "number" && Number.isInteger(rawCode))
      ? String(rawCode)
      : "unknown";
  return `kind=${classifyBackendFailure(error)}, code=${safeCode}, message=[REDACTED]`;
}

function backendOutcomeUnknownError(reconnectError?: unknown): Error {
  const reconnectDetail =
    reconnectError === undefined
      ? "reconnect=succeeded for future calls"
      : `reconnect=failed (${redactedBackendFailureDetail(reconnectError)})`;
  return new Error(
    `MCP backend_outcome_unknown: the network failed after a non-read-only call may have reached the backend; the proxy did not replay it. ${reconnectDetail}.`,
  );
}

function backendReplayNotAuthorizedError(): Error {
  return new Error(
    "MCP backend_outcome_unknown: the network failed and the replacement backend generation did not prove the tool read-only; the proxy did not replay it. reconnect=succeeded for future calls.",
  );
}

function backendOutcomeUnknownAfterRetryError(): Error {
  return new Error(
    "MCP backend_outcome_unknown: the network failed after the one permitted retry of a request that may have reached the backend; the proxy did not replay it again. reconnect=not-attempted after retry.",
  );
}

function backendApplicationError(error: unknown): Error {
  const admission = parseHttpAdmissionError(error);
  if (admission) {
    // The server transport adds a JSON-RPC envelope around thrown errors. Keep
    // this local error message catalogued so clients receive it once, then
    // construct their normal SDK McpError from the structured response.
    return Object.assign(
      new Error(HTTP_ADMISSION_MESSAGES.get(admission.admission)!),
      { code: HTTP_ADMISSION_ERROR_CODE, data: admission },
    );
  }
  const rawCode = safelyReadUntrustedErrorField(error, "code");
  const numericCode =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^[0-9]{3}$/u.test(rawCode)
        ? Number(rawCode)
        : undefined;
  const safeStatus =
    numericCode !== undefined &&
    Number.isInteger(numericCode) &&
    numericCode >= 100 &&
    numericCode <= 599
      ? String(numericCode)
      : "unknown";
  return new Error(`MCP backend rejected the request (status=${safeStatus}).`);
}

function backendUnreachableError(): Error {
  return new Error("MCP backend is unreachable after retry.");
}

function closeBackendConnection(
  connection: BackendConnection,
  reason: "drained" | "drain-timeout" | "shutdown",
): Promise<void> {
  if (connection.closePromise) return connection.closePromise;
  if (connection.retiredTimer) {
    clearTimeout(connection.retiredTimer);
    connection.retiredTimer = undefined;
  }
  connection.closePromise = Promise.allSettled([
    connection.client.close(),
    connection.transport.close(),
  ]).then((results) => {
    retiredConnections.delete(connection);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected.length > 0) {
      console.error(
        `[${packageName}] backend generation ${connection.generation} closed after ${reason} with ${rejected.length} close error(s)`,
      );
    } else {
      console.error(
        `[${packageName}] backend generation ${connection.generation} closed after ${reason}`,
      );
    }
  });
  return connection.closePromise;
}

function closeRetiredBackend(connection: BackendConnection): void {
  if (!connection.retired || connection.inFlight !== 0) return;
  void closeBackendConnection(connection, "drained");
}

function retireBackend(connection: BackendConnection): void {
  if (connection.retired) return;
  connection.retired = true;
  retiredConnections.add(connection);
  connection.retiredTimer = setTimeout(() => {
    if (connection.closePromise) return;
    console.error(
      `[${packageName}] backend generation ${connection.generation} exceeded the ${retiredDrainTimeoutMs}ms retired drain; aborting ${connection.inFlight} in-flight call(s)`,
    );
    void closeBackendConnection(connection, "drain-timeout");
  }, retiredDrainTimeoutMs);
  connection.retiredTimer.unref?.();
  closeRetiredBackend(connection);
}

async function createBackendConnection(): Promise<BackendConnection> {
  await ensureLocalBackendRunning({
    serviceName: packageName,
    url: healthUrl,
    command: process.execPath,
    args: [path.join(projectRoot, "dist/index.js")],
    cwd: projectRoot,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: "http",
      // One shared backend must never inherit a per-agent stdio profile.
      // Per-client exposure is enforced by this proxy; the backend stays full.
      MCP_TOOL_PROFILE: "full",
    },
    startupTimeoutMs: Number(process.env.MCP_PROXY_START_TIMEOUT_MS || "20000"),
    spawnIfUnavailable:
      process.env.MCP_PROXY_REQUIRE_EXISTING_BACKEND?.toLowerCase() !== "true",
  });

  if (process.env.MCP_AUTH_MODE && !backendBearerToken) {
    throw new Error(
      "MCP_BACKEND_BEARER_TOKEN is required by the stdio proxy when the shared HTTP backend uses JWT or OAuth authentication. Provision one verified credential per agent for isolated quotas.",
    );
  }

  const transport = new StreamableHTTPClientTransport(
    backendUrl,
    backendBearerToken
      ? {
          requestInit: {
            headers: {
              Authorization: `Bearer ${backendBearerToken}`,
            },
          },
        }
      : undefined,
  );
  const client = new Client(
    { name: `${packageName}-stdio-proxy`, version: packageVersion },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    transport,
    generation: ++backendGeneration,
    sessionId: randomUUID(),
    inFlight: 0,
    retired: false,
  };
}

async function ensureBackendConnected(): Promise<BackendConnection> {
  if (backend) return backend;
  initialConnectionPromise ??= createBackendConnection().then((connection) => {
    backend ??= connection;
    if (backend !== connection) retireBackend(connection);
    return backend;
  });
  try {
    return await initialConnectionPromise;
  } finally {
    initialConnectionPromise = undefined;
  }
}

async function reconnectBackend(
  failedGeneration: number,
): Promise<BackendConnection> {
  if (backend && backend.generation !== failedGeneration) return backend;
  if (!backend) return ensureBackendConnected();
  reconnectPromise ??= (async () => {
    const failedConnection = backend;
    if (!failedConnection || failedConnection.generation !== failedGeneration) {
      return ensureBackendConnected();
    }
    const replacement = await createBackendConnection();
    if (backend !== failedConnection) {
      retireBackend(replacement);
      return backend ?? ensureBackendConnected();
    }
    backend = replacement;
    allowedToolNames = undefined;
    readOnlyToolNames = undefined;
    toolMetadataGeneration = undefined;
    retireBackend(failedConnection);
    return replacement;
  })();
  try {
    return await reconnectPromise;
  } finally {
    reconnectPromise = undefined;
  }
}

async function withBackendLease<T>(
  operation: (client: Client) => Promise<T>,
  options: {
    expectedGeneration?: number;
    networkReplayAuthorized: boolean;
  },
): Promise<{ generation: number; value: T }> {
  const connection = await ensureBackendConnected();
  if (
    options.expectedGeneration !== undefined &&
    connection.generation !== options.expectedGeneration
  ) {
    throw new BackendGenerationChangedError();
  }
  connection.inFlight += 1;
  try {
    return {
      generation: connection.generation,
      value: await operation(connection.client),
    };
  } catch (error) {
    throw new BackendOperationError(
      connection.generation,
      error,
      options.networkReplayAuthorized,
    );
  } finally {
    connection.inFlight -= 1;
    closeRetiredBackend(connection);
  }
}

async function toolReplayProof(
  toolName: string,
): Promise<{ generation: number; readOnly: boolean }> {
  if (!readOnlyToolNames || toolMetadataGeneration !== backend?.generation) {
    await filteredBackendTools();
  }
  if (
    toolMetadataGeneration === undefined ||
    toolMetadataGeneration !== backend?.generation
  ) {
    throw new Error(
      "Backend changed generation while resolving tool replay metadata; refusing automatic replay.",
    );
  }
  return {
    generation: toolMetadataGeneration,
    readOnly: readOnlyToolNames?.has(toolName) ?? false,
  };
}

async function withGenerationBoundToolLease<T>(
  toolName: string,
  operation: (client: Client) => Promise<T>,
  requireReadOnly: boolean,
): Promise<{ generation: number; value: T }> {
  // A concurrent reconnect may rotate the active backend between metadata
  // resolution and lease acquisition. Retry only that pre-execution binding;
  // never carry an annotation proof across generations.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const proof = await toolReplayProof(toolName);
    if (requireReadOnly && !proof.readOnly) {
      throw new BackendReplayNotAuthorizedError();
    }
    try {
      return await withBackendLease(operation, {
        expectedGeneration: proof.generation,
        networkReplayAuthorized: proof.readOnly,
      });
    } catch (error) {
      if (error instanceof BackendGenerationChangedError) continue;
      throw error;
    }
  }
  throw new Error(
    "Backend changed generation repeatedly while binding tool replay metadata; refusing automatic replay.",
  );
}

async function withBackendRetry<T>(
  operationName: string,
  operation: (client: Client) => Promise<T>,
  options: BackendRetryOptions<T>,
): Promise<T> {
  const replayPolicy = options.replayNetworkFailure;
  const execute = (requireReadOnly: boolean) => {
    if (typeof replayPolicy === "boolean") {
      return withBackendLease(operation, {
        networkReplayAuthorized: replayPolicy,
      });
    }
    return withGenerationBoundToolLease(
      replayPolicy.toolName,
      operation,
      requireReadOnly,
    );
  };
  try {
    const result = await execute(false);
    options.onSuccess?.(result);
    return result.value;
  } catch (error) {
    const failedGeneration =
      error instanceof BackendOperationError ? error.generation : undefined;
    const originalError =
      error instanceof BackendOperationError ? error.originalError : error;
    const networkReplayAuthorized =
      error instanceof BackendOperationError
        ? error.networkReplayAuthorized
        : false;
    const failureKind = classifyBackendFailure(originalError);
    if (failureKind === "application") {
      throw backendApplicationError(originalError);
    }

    console.error(
      `[${packageName}] ${operationName} failed against backend (${redactedBackendFailureDetail(originalError)}); reconnecting once`,
    );

    if (failedGeneration === undefined) throw backendUnreachableError();

    try {
      await reconnectBackend(failedGeneration);
    } catch (retryError) {
      if (failureKind === "network" && !networkReplayAuthorized) {
        throw backendOutcomeUnknownError(retryError);
      }
      throw backendUnreachableError();
    }

    if (failureKind === "network" && !networkReplayAuthorized) {
      throw backendOutcomeUnknownError();
    }

    try {
      const retried = await execute(failureKind === "network");
      options.onSuccess?.(retried);
      return retried.value;
    } catch (retryError) {
      if (retryError instanceof BackendReplayNotAuthorizedError) {
        throw backendReplayNotAuthorizedError();
      }
      const retryOriginal =
        retryError instanceof BackendOperationError
          ? retryError.originalError
          : retryError;
      const retryFailureKind = classifyBackendFailure(retryOriginal);
      if (retryFailureKind === "application") {
        throw backendApplicationError(retryOriginal);
      }
      if (
        retryError instanceof BackendOperationError &&
        retryFailureKind === "network" &&
        !retryError.networkReplayAuthorized
      ) {
        throw backendOutcomeUnknownAfterRetryError();
      }
      throw backendUnreachableError();
    }
  }
}

async function filteredBackendTools(
  params?: Record<string, unknown>,
  staleRefreshesRemaining = 1,
) {
  let resultGeneration: number | undefined;
  const result = await withBackendRetry(
    "listTools",
    (client) => client.listTools(params),
    {
      replayNetworkFailure: true,
      onSuccess: ({ generation }) => {
        resultGeneration = generation;
      },
    },
  );
  if (resultGeneration === undefined) {
    throw new Error(
      "Backend tools/list completed without a connection generation.",
    );
  }
  if (backend?.generation !== resultGeneration) {
    if (staleRefreshesRemaining <= 0) {
      throw new Error(
        "Backend changed generation while tools/list was in flight; refusing to expose stale tool metadata.",
      );
    }
    return filteredBackendTools(params, staleRefreshesRemaining - 1);
  }
  const selected = new Set(
    selectAvailableToolProfileNames({
      profile: toolProfile,
      availableNames: result.tools.map((tool) => tool.name),
    }),
  );
  allowedToolNames = selected;
  readOnlyToolNames = new Set(
    result.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name),
  );
  toolMetadataGeneration = resultGeneration;
  return {
    ...result,
    tools: result.tools.filter((tool) => selected.has(tool.name)),
  };
}

async function toolIsExposed(toolName: string): Promise<boolean> {
  if (!allowedToolNames || toolMetadataGeneration !== backend?.generation) {
    await filteredBackendTools();
  }
  return allowedToolNames?.has(toolName) ?? false;
}

async function shutdown(signal: string) {
  console.error(`[${packageName}] proxy shutdown on ${signal}`);
  const connections = new Set<BackendConnection>(retiredConnections);
  if (backend) connections.add(backend);
  await Promise.allSettled([
    proxyServer.close(),
    ...[...connections].map((connection) =>
      closeBackendConnection(connection, "shutdown"),
    ),
  ]);
  process.exit(0);
}

async function start() {
  externalRootsService = process.env.MCP_EXTERNAL_ROOTS_FILE
    ? await ExternalRootsService.fromConfigFile(
        process.env.MCP_EXTERNAL_ROOTS_FILE,
      )
    : undefined;

  await ensureBackendConnected();
  // Scan, plan and status remain diagnostic. Their binding and private SQLite
  // snapshot handling is retained, while native-handle-relative mutation is
  // unavailable on every platform.
  if (externalRootsService) {
    const moveRootsService = externalRootsService;
    const rootsFingerprint = rootConfigFingerprint(
      process.env.MCP_EXTERNAL_ROOTS_FILE!,
    );
    const expectedTargetAttestation =
      config.obsidianRuntimeMode === "headless-filesystem"
        ? attestVaultFilesystemTarget(config.obsidianVaultPath)
        : undefined;
    if (!config.externalMoveProfileId) {
      externalMoveUnavailableReason = "profile_required";
    } else if (!expectedTargetAttestation) {
      externalMoveUnavailableReason = "target_unverified";
    } else {
      try {
        const vault = new BackendVaultAdapter(
          async (name, args) => {
            let generation: number | undefined;
            const result = await withBackendRetry(
              `external reference backend adapter: ${name}`,
              (client) =>
                client.callTool(
                  { name, arguments: args },
                  CompatibilityCallToolResultSchema,
                ),
              {
                replayNetworkFailure: { toolName: name },
                onSuccess: ({ generation: completedGeneration }) => {
                  generation = completedGeneration;
                },
              },
            );
            const completedConnection = backend;
            return {
              result,
              generation,
              sessionId:
                generation === completedConnection?.generation
                  ? completedConnection?.sessionId
                  : undefined,
            };
          },
          {
            backendEndpoint: backendUrl.toString(),
            rootConfigFingerprint: rootsFingerprint,
            profileId: config.externalMoveProfileId,
            expectedTargetAttestation,
            getActiveBackendSession: () =>
              backend
                ? {
                    generation: backend.generation,
                    sessionId: backend.sessionId,
                  }
                : undefined,
          },
        );
        externalMoveBindingIdentity = await vault.getBindingIdentity();
        if (externalMoveBindingIdentity.verifiable) {
          const profiledJournalPath = profileExternalMoveJournalPath(
            config.externalMoveJournalPath,
            externalMoveBindingIdentity.bindingFingerprint,
          );
          externalMoveCoordinator = new ExternalMoveCoordinator(
            moveRootsService!,
            vault,
            () => new ExternalMoveJournal(profiledJournalPath),
          );
        } else {
          externalMoveUnavailableReason = "target_unverified";
        }
      } catch (error) {
        externalMoveUnavailableReason =
          error instanceof BackendVaultTargetUnverifiedError
            ? "target_unverified"
            : "backend_attestation_unavailable";
      }
    }
  }

  proxyServer.setRequestHandler(ListToolsRequestSchema, async (request) =>
    filteredBackendTools(request.params),
  );

  proxyServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Apply and rollback are local retained endpoints. Their visibility is
    // derivable from the static profile contract, so do not call tools/list
    // before returning their stable unsupported result. This keeps the
    // fail-closed boundary deterministic through cold metadata and a backend
    // outage, while profiles that do not include external.move still see a
    // hidden tool.
    if (isLocalFailClosedExternalMoveMutationTool(request.params.name)) {
      if (!localFailClosedExternalMoveMutationIsVisible(request.params.name)) {
        return hiddenToolResult();
      }
      const parsed =
        request.params.name === "external_move_apply"
          ? ExternalMoveApplySchema.safeParse(request.params.arguments ?? {})
          : ExternalMoveRollbackSchema.safeParse(
              request.params.arguments ?? {},
            );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }
      return externalRootsResult(() => disabledExternalMoveMutation())();
    }

    if (!(await toolIsExposed(request.params.name))) {
      return hiddenToolResult();
    }

    if (request.params.name === "external_runtime_status") {
      return externalRootsResult(async () => ({
        enabled: Boolean(externalRootsService),
        mode: "read-only",
        localHandoffAllowed: true,
        externalMove: {
          available: false,
          ...moveMutationStatus(),
          transport: "stdio-only",
          requiresRootCapability: "move",
          identityVerified: Boolean(externalMoveCoordinator),
          planningAvailable: Boolean(externalMoveCoordinator),
          ...(externalMoveCoordinator
            ? {
                identitySource:
                  externalMoveBindingIdentity?.vaultIdentitySource,
              }
            : {
                // This is deliberately separate from mutationUnavailableReason:
                // the native mutation primitive is unavailable everywhere,
                // while planning/status can additionally be unavailable when
                // this process cannot establish a redacted, verifiable
                // binding. unavailableReason remains a compatibility alias
                // for older clients; new callers must use the explicit
                // planningUnavailableReason field.
                planningUnavailableReason: externalMoveUnavailableReason,
                unavailableReason: externalMoveUnavailableReason,
              }),
        },
        roots: externalRootsService
          ? await externalRootsService.listRoots()
          : [],
      }))();
    }

    if (request.params.name === "external_roots_list") {
      return externalRootsResult(async () => ({
        roots: externalRootsService
          ? await externalRootsService.listRoots()
          : [],
      }))();
    }

    if (request.params.name === "external_list") {
      const parsed = ExternalListSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }
      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.list(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.depth,
              parsed.data.maxEntries,
            )
          : unavailableExternalMove(),
      )();
    }

    if (request.params.name === "external_stat") {
      const parsed = ExternalStatSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }
      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.getStat(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.includeHash,
            )
          : unavailableExternalMove(),
      )();
    }

    if (request.params.name === "external_read") {
      const parsed = ExternalReadSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }
      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.readText(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.maxChars,
            )
          : unavailableExternalMove(),
      )();
    }

    if (request.params.name === "external_handoff") {
      const parsed = ExternalHandoffSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }

      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.handoff(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.includeHash,
            )
          : unavailableExternalMove(),
      )();
    }

    if (request.params.name === "external_references_scan") {
      const parsed = ExternalReferencesScanSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }
      return externalRootsResult(() =>
        externalMoveCoordinator
          ? externalMoveCoordinator.scan(
              parsed.data.rootId,
              parsed.data.relativePath,
            )
          : unavailableExternalMove(),
      )();
    }

    if (request.params.name === "external_move_plan") {
      const parsed = ExternalMovePlanSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }
      return externalRootsResult(() =>
        externalMoveCoordinator
          ? externalMoveCoordinator.plan(parsed.data)
          : unavailableExternalMove(),
      )();
    }

    if (request.params.name === "external_move_status") {
      const parsed = ExternalMoveStatusSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(request.params.name);
      }
      return externalRootsResult(async () => {
        if (
          config.externalMoveJournalPath === ":memory:" &&
          externalMoveCoordinator
        ) {
          return externalMoveCoordinator.status(parsed.data.planId);
        }
        const stored = getStoredExternalMovePlan(parsed.data.planId);
        if (!stored) return unknownExternalMovePlan();
        const storedBinding = stored.bindingIdentity?.bindingFingerprint;
        if (
          externalMoveCoordinator &&
          typeof storedBinding === "string" &&
          storedBinding === externalMoveBindingIdentity?.bindingFingerprint
        ) {
          return externalMoveCoordinator.status(parsed.data.planId, stored);
        }
        // A journal may be readable after restart or from another binding, but
        // this process cannot authenticate the session that sealed it. Project
        // all actionable receipts as manual review without opening or changing
        // the durable journal.
        return projectExternalMovePlanForUnavailableDestructiveSession(stored);
      })();
    }

    return withBackendRetry(
      "callTool",
      (client) =>
        client.callTool(request.params, CompatibilityCallToolResultSchema),
      { replayNetworkFailure: { toolName: request.params.name } },
    );
  });

  const stdioTransport = new StdioServerTransport();
  await proxyServer.connect(stdioTransport);
  console.error(
    `[${packageName}] stdio proxy connected with tool profile ${toolProfile}`,
  );
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch(() => {
  console.error(`[${packageName}] stdio proxy failed to start.`);
  process.exit(1);
});
