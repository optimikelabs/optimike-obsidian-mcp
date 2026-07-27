#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ExternalHandoffSchema,
  externalRootsResult,
} from "./mcp-server/tools/externalRootsTools/registration.js";
import { ensureLocalBackendRunning } from "./runtime/localBackend.js";
import {
  ExternalRootError,
  ExternalRootsService,
} from "./services/externalRootsService.js";

type PackageInfo = { name?: string; version?: string };
type BackendClient = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

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
const backendUrl = new URL(`http://${host}:${port}/mcp`);
const healthUrl = new URL(`http://${host}:${port}/healthz`);

const proxyServer = new Server(
  { name: `${packageName}-stdio-proxy`, version: packageVersion },
  { capabilities: { tools: { listChanged: true } } },
);

let backend: BackendClient | undefined;
let externalRootsService: ExternalRootsService | undefined;

function isReconnectableBackendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("Invalid or expired session ID") ||
    message.includes("Streamable HTTP error") ||
    message.includes("terminated") ||
    message.includes("socket hang up")
  );
}

async function ensureBackendConnected(forceReconnect = false): Promise<Client> {
  if (backend && !forceReconnect) {
    return backend.client;
  }

  if (backend) {
    await Promise.allSettled([
      backend.client.close(),
      backend.transport.close(),
    ]);
    backend = undefined;
  }

  await ensureLocalBackendRunning({
    serviceName: packageName,
    url: healthUrl,
    command: process.execPath,
    args: [path.join(projectRoot, "dist/index.js")],
    cwd: projectRoot,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: "http",
    },
    startupTimeoutMs: Number(process.env.MCP_PROXY_START_TIMEOUT_MS || "20000"),
  });

  const transport = new StreamableHTTPClientTransport(backendUrl);
  const client = new Client(
    { name: `${packageName}-stdio-proxy`, version: packageVersion },
    { capabilities: {} },
  );
  await client.connect(transport);
  backend = { client, transport };
  return client;
}

async function withBackendRetry<T>(
  operationName: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  try {
    return await operation(await ensureBackendConnected());
  } catch (error) {
    if (!isReconnectableBackendError(error)) {
      throw error;
    }

    console.error(
      `[${packageName}] ${operationName} failed against backend (${error instanceof Error ? error.message : String(error)}); reconnecting once`,
    );

    try {
      return await operation(await ensureBackendConnected(true));
    } catch (retryError) {
      const message =
        retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `MCP backend_unreachable after retry for ${operationName}. Backend ${backendUrl.toString()} did not complete the request: ${message}`,
      );
    }
  }
}

async function shutdown(signal: string) {
  console.error(`[${packageName}] proxy shutdown on ${signal}`);
  await Promise.allSettled([
    proxyServer.close(),
    backend?.client.close() ?? Promise.resolve(),
    backend?.transport.close() ?? Promise.resolve(),
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

  proxyServer.setRequestHandler(ListToolsRequestSchema, async (request) =>
    withBackendRetry("listTools", (client) => client.listTools(request.params)),
  );

  proxyServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "external_runtime_status") {
      return externalRootsResult(async () => ({
        enabled: Boolean(externalRootsService),
        mode: "read-only",
        localHandoffAllowed: true,
        roots: externalRootsService
          ? await externalRootsService.listRoots()
          : [],
      }))();
    }

    if (request.params.name === "external_handoff") {
      const parsed = ExternalHandoffSchema.safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "path_invalid",
                  message: `Invalid external_handoff arguments: ${parsed.error.message}`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      return externalRootsResult(() =>
        externalRootsService
          ? externalRootsService.handoff(
              parsed.data.rootId,
              parsed.data.relativePath,
              parsed.data.includeHash,
            )
          : Promise.reject(
              new ExternalRootError(
                "configuration_invalid",
                "External roots are disabled. Configure MCP_EXTERNAL_ROOTS_FILE to enable them.",
              ),
            ),
      )();
    }

    return withBackendRetry("callTool", (client) =>
      client.callTool(request.params, CompatibilityCallToolResultSchema),
    );
  });

  const stdioTransport = new StdioServerTransport();
  await proxyServer.connect(stdioTransport);
  console.error(
    `[${packageName}] stdio proxy connected to ${backendUrl.toString()}`,
  );
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch((error) => {
  console.error(`[${packageName}] stdio proxy failed:`, error);
  process.exit(1);
});
