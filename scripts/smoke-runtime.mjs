#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const httpUrl = process.env.MCP_SMOKE_HTTP_URL ?? "http://127.0.0.1:3010/mcp";
const healthUrl =
  process.env.MCP_SMOKE_HEALTH_URL ?? httpUrl.replace(/\/mcp\/?$/u, "/healthz");
const minTools = Number(process.env.MCP_SMOKE_MIN_TOOLS ?? "20");
const timeoutMs = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? "8000");
const includeStdioProxy =
  (process.env.MCP_SMOKE_STDIO_PROXY ?? "true").toLowerCase() === "true";

function withTimeout(promise, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    run: promise(controller.signal).finally(() => clearTimeout(timer)),
    label,
  };
}

async function checkHealth() {
  const start = Date.now();
  const timed = withTimeout(
    (signal) =>
      fetch(healthUrl, {
        headers: { Accept: "application/json" },
        signal,
      }),
    "healthz",
  );
  const response = await timed.run;
  if (!response.ok) {
    throw new Error(`healthz returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body.ok) {
    throw new Error(`healthz returned ok=false: ${JSON.stringify(body)}`);
  }
  return {
    ok: true,
    ms: Date.now() - start,
    status: body.status,
    transport: body.transport,
  };
}

async function listToolsViaHttp() {
  const start = Date.now();
  const transport = new StreamableHTTPClientTransport(new URL(httpUrl));
  const client = new Client({
    name: "optimike-runtime-smoke-http",
    version: "0",
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    if (result.tools.length < minTools) {
      throw new Error(
        `HTTP MCP exposed ${result.tools.length} tools, expected at least ${minTools}`,
      );
    }
    return {
      ok: true,
      ms: Date.now() - start,
      toolCount: result.tools.length,
      sample: result.tools.slice(0, 8).map((tool) => tool.name),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function listToolsViaStdioProxy() {
  const start = Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio-proxy.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_HTTP_HOST: new URL(httpUrl).hostname,
      MCP_HTTP_PORT: new URL(httpUrl).port || "80",
      MCP_PROXY_START_TIMEOUT_MS: String(timeoutMs),
    },
  });
  const client = new Client({
    name: "optimike-runtime-smoke-stdio-proxy",
    version: "0",
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    if (result.tools.length < minTools) {
      throw new Error(
        `stdio proxy exposed ${result.tools.length} tools, expected at least ${minTools}`,
      );
    }
    return {
      ok: true,
      ms: Date.now() - start,
      toolCount: result.tools.length,
      sample: result.tools.slice(0, 8).map((tool) => tool.name),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  const result = {
    ok: true,
    target: {
      httpUrl,
      healthUrl,
      minTools,
      includeStdioProxy,
    },
    checks: {
      health: await checkHealth(),
      httpMcp: await listToolsViaHttp(),
      stdioProxy: includeStdioProxy
        ? await listToolsViaStdioProxy()
        : "skipped",
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
