#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ensureLocalBackendRunning } from "./runtime/localBackend.js";
import {
  TOOL_CATALOG,
  compileToolSurface,
} from "./mcp-server/toolSurface/catalog.js";
import { resolveProfileFromCli } from "./mcp-server/toolSurface/runtime.js";

const resolved = resolveProfileFromCli(
  process.argv.slice(2),
  process.env.MCP_TOOL_PROFILE,
  "standard",
);
process.argv = [...process.argv.slice(0, 2), ...resolved.argv];
process.env.MCP_TOOL_PROFILE = resolved.profile;

const packageRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
const port = Number(process.env.MCP_HTTP_PORT || "3010");
const healthUrl = new URL(`http://${host}:${port}/healthz`);

const packageInfo = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name?: string; version?: string };
const packageName = packageInfo.name ?? "optimike-obsidian-mcp";
const packageVersion = packageInfo.version ?? "3.0.0";

const proxyServer = new Server(
  { name: `${packageName}-surface-proxy`, version: packageVersion },
  { capabilities: { tools: { listChanged: true } } },
);

let childClient: Client | undefined;
let childTransport: StdioClientTransport | undefined;
type ListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
};

let allowedNames = new Set<string>();
let cachedTools: ListedTool[] = [];

async function startBackend(): Promise<void> {
  await ensureLocalBackendRunning({
    serviceName: packageName,
    url: healthUrl,
    command: process.execPath,
    args: [path.join(packageRoot, "dist/index-v3.js")],
    cwd: packageRoot,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: "http",
    },
    startupTimeoutMs: Number(process.env.MCP_PROXY_START_TIMEOUT_MS || "20000"),
  });
}

async function connectLegacyProxy(): Promise<void> {
  childTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, "dist/stdio-proxy.js")],
    cwd: packageRoot,
    env: {
      ...process.env,
      // The inner proxy connects to /mcp, retained as the full compatibility
      // endpoint. This outer proxy owns the V3 client surface.
      MCP_TOOL_PROFILE: "full",
    },
  });
  childClient = new Client({
    name: `${packageName}-surface-proxy-client`,
    version: packageVersion,
  });
  await childClient.connect(childTransport);
}

function client(): Client {
  if (!childClient) throw new Error("Inner stdio proxy is not connected.");
  return childClient;
}

async function refreshSurface(): Promise<ListedTool[]> {
  const listed = await client().listTools();
  const tools = listed.tools as ListedTool[];
  const availableNames: string[] = [];
  for (const tool of tools) {
    const name = tool.name;
    if (name === "smart_search" || name === "smart-search") continue;
    if (!TOOL_CATALOG.has(name)) {
      throw new Error(
        `Backend exposed uncatalogued V3 tool ${name}; refusing an ambiguous proxy surface.`,
      );
    }
    availableNames.push(name);
  }
  allowedNames = new Set(
    compileToolSurface(resolved.profile, availableNames, {
      externalRootsConfigured: Boolean(
        process.env.MCP_EXTERNAL_ROOTS_FILE?.trim(),
      ),
    }),
  );
  cachedTools = tools.filter((tool) => allowedNames.has(tool.name));
  return cachedTools;
}

function deniedTool(name: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            error: {
              code: "TOOL_OUTSIDE_PROFILE",
              message: `Tool ${name} is outside the active ${resolved.profile} profile.`,
            },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

async function shutdown(signal: string): Promise<void> {
  console.error(`${packageName} V3 surface proxy shutdown on ${signal}`);
  await Promise.allSettled([
    proxyServer.close(),
    childClient?.close() ?? Promise.resolve(),
    childTransport?.close() ?? Promise.resolve(),
  ]);
  process.exit(0);
}

async function start(): Promise<void> {
  await startBackend();
  await connectLegacyProxy();
  await refreshSurface();

  proxyServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await refreshSurface();
    return { tools };
  });

  proxyServer.setRequestHandler(
    CallToolRequestSchema,
    async (request: { params: { name: string; [key: string]: unknown } }) => {
      if (allowedNames.size === 0) await refreshSurface();
      if (!allowedNames.has(request.params.name)) {
        return deniedTool(request.params.name);
      }
      return await client().callTool(
        request.params,
        CompatibilityCallToolResultSchema,
      );
    },
  );

  await proxyServer.connect(new StdioServerTransport());
  console.error(
    `${packageName} V3 stdio profile=${resolved.profile} tools=${cachedTools.length}`,
  );
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch((error) => {
  console.error(
    `${packageName} V3 surface proxy failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exit(1);
});
