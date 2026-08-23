#!/usr/bin/env node

import "./config/toolProfileCli.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  selectAvailableToolProfileNames,
  type ToolProfileId,
} from "./mcp-server/toolProfiles.js";
import { resolveToolProfile } from "./mcp-server/toolProfileRuntime.js";
import { config, profileExternalMoveJournalPath } from "./config/index.js";
import { ensureLocalBackendRunning } from "./runtime/localBackend.js";
import {
  ExternalRootError,
  ExternalRootsService,
} from "./services/externalRootsService.js";
import { BackendVaultAdapter } from "./services/externalReferences/backendVaultAdapter.js";
import type { ExternalMoveBindingIdentity } from "./services/externalReferences/backendVaultAdapter.js";
import { ExternalMoveCoordinator } from "./services/externalReferences/externalMoveCoordinator.js";
import { ExternalMoveJournal } from "./services/externalReferences/externalMoveJournal.js";

type PackageInfo = { name?: string; version?: string };
type BackendClient = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};
type BackendConnection = BackendClient & {
  generation: number;
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

function invalidExternalArguments(
  toolName: string,
  message: string,
): {
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
            message: `Invalid ${toolName} arguments: ${message}`,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function hiddenToolResult(toolName: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: "tool_not_exposed",
            message: `Tool ${toolName} is not exposed by MCP tool profile ${toolProfile}.`,
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

function errorHasNetworkCause(
  error: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error as {
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (
    typeof candidate.code === "string" &&
    NETWORK_ERROR_CODES.has(candidate.code)
  ) {
    return true;
  }
  if (Array.isArray(candidate.errors)) {
    return candidate.errors.some((nested) =>
      errorHasNetworkCause(nested, seen),
    );
  }
  return errorHasNetworkCause(candidate.cause, seen);
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
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown })
      : undefined;
  const rawCode = candidate?.code;
  const safeCode =
    (typeof rawCode === "string" && /^[A-Z0-9_.-]{1,64}$/u.test(rawCode)) ||
    (typeof rawCode === "number" && Number.isInteger(rawCode))
      ? String(rawCode)
      : "unknown";
  return `kind=${classifyBackendFailure(error)}, code=${safeCode}, message=[REDACTED]`;
}

function backendOutcomeUnknownError(
  operationName: string,
  originalError: unknown,
  reconnectError?: unknown,
): Error {
  const reconnectDetail =
    reconnectError === undefined
      ? "reconnect=succeeded for future calls"
      : `reconnect=failed (${redactedBackendFailureDetail(reconnectError)})`;
  return new Error(
    `MCP backend_outcome_unknown for ${operationName}: the network failed after a non-read-only call may have reached the backend; the proxy did not replay it. ${reconnectDetail}; original_failure=${redactedBackendFailureDetail(originalError)}`,
  );
}

function backendReplayNotAuthorizedError(
  operationName: string,
  originalError: unknown,
): Error {
  return new Error(
    `MCP backend_outcome_unknown for ${operationName}: the network failed and the replacement backend generation did not prove the tool read-only; the proxy did not replay it. reconnect=succeeded for future calls; original_failure=${redactedBackendFailureDetail(originalError)}`,
  );
}

function backendOutcomeUnknownAfterRetryError(
  operationName: string,
  retryError: unknown,
): Error {
  return new Error(
    `MCP backend_outcome_unknown for ${operationName}: the network failed after the one permitted retry of a request that may have reached the backend; the proxy did not replay it again. reconnect=not-attempted after retry; retry_failure=${redactedBackendFailureDetail(retryError)}`,
  );
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
      throw originalError;
    }

    console.error(
      `[${packageName}] ${operationName} failed against backend (${redactedBackendFailureDetail(originalError)}); reconnecting once`,
    );

    if (failedGeneration === undefined) throw originalError;

    try {
      await reconnectBackend(failedGeneration);
    } catch (retryError) {
      if (failureKind === "network" && !networkReplayAuthorized) {
        throw backendOutcomeUnknownError(
          operationName,
          originalError,
          retryError,
        );
      }
      throw new Error(
        `MCP backend_unreachable after retry for ${operationName}. Backend ${backendUrl.toString()} did not complete the request: ${redactedBackendFailureDetail(retryError)}`,
      );
    }

    if (failureKind === "network" && !networkReplayAuthorized) {
      throw backendOutcomeUnknownError(operationName, originalError);
    }

    try {
      const retried = await execute(failureKind === "network");
      options.onSuccess?.(retried);
      return retried.value;
    } catch (retryError) {
      if (retryError instanceof BackendReplayNotAuthorizedError) {
        throw backendReplayNotAuthorizedError(operationName, originalError);
      }
      const retryOriginal =
        retryError instanceof BackendOperationError
          ? retryError.originalError
          : retryError;
      const retryFailureKind = classifyBackendFailure(retryOriginal);
      if (retryFailureKind === "application") {
        throw retryOriginal;
      }
      if (
        retryError instanceof BackendOperationError &&
        retryFailureKind === "network" &&
        !retryError.networkReplayAuthorized
      ) {
        throw backendOutcomeUnknownAfterRetryError(
          operationName,
          retryOriginal,
        );
      }
      throw new Error(
        `MCP backend_unreachable after retry for ${operationName}. Backend ${backendUrl.toString()} did not complete the request: ${redactedBackendFailureDetail(retryOriginal)}`,
      );
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
  if (externalRootsService) {
    const rootsFingerprint = rootConfigFingerprint(
      process.env.MCP_EXTERNAL_ROOTS_FILE!,
    );
    const vault = new BackendVaultAdapter(
      async (name, args) =>
        withBackendRetry(
          `external reference backend adapter: ${name}`,
          (client) =>
            client.callTool(
              { name, arguments: args },
              CompatibilityCallToolResultSchema,
            ),
          { replayNetworkFailure: { toolName: name } },
        ),
      {
        backendEndpoint: backendUrl.toString(),
        rootConfigFingerprint: rootsFingerprint,
        profileId: config.externalMoveProfileId,
      },
    );
    externalMoveBindingIdentity = await vault.getBindingIdentity();
    const profiledJournalPath = profileExternalMoveJournalPath(
      config.externalMoveJournalPath,
      externalMoveBindingIdentity.bindingFingerprint,
    );
    externalMoveCoordinator = new ExternalMoveCoordinator(
      externalRootsService,
      vault,
      new ExternalMoveJournal(profiledJournalPath),
    );
  }

  proxyServer.setRequestHandler(ListToolsRequestSchema, async (request) =>
    filteredBackendTools(request.params),
  );

  proxyServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!(await toolIsExposed(request.params.name))) {
      return hiddenToolResult(request.params.name);
    }

    if (request.params.name === "external_runtime_status") {
      return externalRootsResult(async () => ({
        enabled: Boolean(externalRootsService),
        mode:
          config.externalMoveEnabled && config.mcpWriteMode === "full"
            ? "read-write-opt-in"
            : "read-only",
        localHandoffAllowed: true,
        externalMove: {
          available:
            Boolean(externalMoveCoordinator) &&
            externalMoveBindingIdentity?.verifiable === true &&
            config.externalMoveEnabled &&
            config.mcpWriteMode === "full",
          transport: "stdio-only",
          requiresRootCapability: "move",
          identityVerified: externalMoveBindingIdentity?.verifiable ?? false,
          identitySource: externalMoveBindingIdentity?.vaultIdentitySource,
          profileFingerprint: externalMoveBindingIdentity?.bindingFingerprint,
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
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.list(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.depth,
              parsed.data.maxEntries,
            )
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_stat") {
      const parsed = ExternalStatSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.getStat(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.includeHash,
            )
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_read") {
      const parsed = ExternalReadSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.readText(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.maxChars,
            )
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_handoff") {
      const parsed = ExternalHandoffSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }

      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.handoff(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.includeHash,
            )
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_references_scan") {
      const parsed = ExternalReferencesScanSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(() =>
        externalMoveCoordinator
          ? externalMoveCoordinator.scan(
              parsed.data.rootId,
              parsed.data.relativePath,
            )
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_move_plan") {
      const parsed = ExternalMovePlanSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(() =>
        externalMoveCoordinator
          ? externalMoveCoordinator.plan(parsed.data)
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_move_status") {
      const parsed = ExternalMoveStatusSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(async () =>
        externalMoveCoordinator
          ? externalMoveCoordinator.status(parsed.data.planId)
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_move_apply") {
      const parsed = ExternalMoveApplySchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(() =>
        externalMoveCoordinator
          ? externalMoveCoordinator.apply(
              parsed.data.planId,
              parsed.data.idempotencyKey,
            )
          : disabledExternalRoots(),
      )();
    }

    if (request.params.name === "external_move_rollback") {
      const parsed = ExternalMoveRollbackSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return invalidExternalArguments(
          request.params.name,
          parsed.error.message,
        );
      }
      return externalRootsResult(() =>
        externalMoveCoordinator
          ? externalMoveCoordinator.rollback(
              parsed.data.planId,
              parsed.data.idempotencyKey,
            )
          : disabledExternalRoots(),
      )();
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
    `[${packageName}] stdio proxy connected to ${backendUrl.toString()} with tool profile ${toolProfile}`,
  );
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch((error) => {
  console.error(`[${packageName}] stdio proxy failed:`, error);
  process.exit(1);
});
