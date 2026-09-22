import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mcpSchema } from "../dist/mcp-server/mcpSchema.js";

const revision = "2026-07-28";
const root = await mkdtemp(path.join(tmpdir(), "optimike-modern-proxy-"));
await mkdir(path.join(root, ".obsidian"));
const logs = path.join(process.cwd(), ".tmp", path.basename(root));
await mkdir(logs, { recursive: true });
const counts = new Map(),
  messages = [],
  dropped = new Set();
let generationReadOnly = true;
const handler = createMcpHandler(
  () => {
    const server = new McpServer({
      name: "modern-backend-fixture",
      version: "1",
    });
    for (const name of ["read_probe", "mutation_probe", "generation_probe"]) {
      server.registerTool(
        name,
        {
          inputSchema: mcpSchema(z.object({ case: z.string() })),
          annotations: {
            readOnlyHint:
              name === "read_probe" ||
              (name === "generation_probe" && generationReadOnly),
          },
        },
        async ({ case: key }) => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ name, key, count: counts.get(key) }),
              },
            ],
          };
        },
      );
    }
    return server;
  },
  { legacy: "reject" },
);
let discoveryReject;
const backend = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") {
      res.writeHead(200).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
    const message = body ? JSON.parse(body) : undefined;
    messages.push({ message, headers: req.headers });
    if (message?.method === "server/discover" && discoveryReject) {
      res
        .writeHead(discoveryReject, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "PRIVATE_BACKEND_RESPONSE" }));
      return;
    }
    if (message?.params?.arguments?.case?.endsWith("-application404")) {
      // A modern application 404 must NEVER become the legacy replay exception,
      // even if the body happens to contain the exact historic session wording.
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32012,
              message: "Invalid or expired session ID.",
              data: {
                applicationCode: "NOT_FOUND",
                transportReason: "mcp_session_invalid",
                requestId: "fca426b1-5884-4525-b286-7b11468fba99",
              },
            },
          }),
        );
      return;
    }
    const request = new Request("http://127.0.0.1" + req.url, {
      method: req.method,
      headers: req.headers,
      ...(body ? { body } : {}),
    });
    const response = await handler.fetch(request);
    const bytes = Buffer.from(await response.arrayBuffer()); // effect has completed
    const key = message?.params?.arguments?.case;
    if (
      key &&
      (key.endsWith("-lost") || key.endsWith("-generation")) &&
      !dropped.has(key)
    ) {
      dropped.add(key);
      if (key.endsWith("-generation")) generationReadOnly = false;
      res.destroy();
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(bytes);
  } catch (error) {
    res.destroy();
    console.error(error);
  }
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const port = backend.address().port;
const sessions = [];
async function connect(modern) {
  const T = modern ? ModernStdio : LegacyStdio,
    C = modern ? ModernClient : LegacyClient;
  const transport = new T({
    command: process.execPath,
    args: [path.resolve("dist/stdio-proxy.js"), "--tool-profile", "full"],
    cwd: root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            ![
              "MCP_AUTH_MODE",
              "MCP_AUTH_SECRET_KEY",
              "MCP_BACKEND_BEARER_TOKEN",
            ].includes(key),
        ),
      ),
      NODE_ENV: "test",
      MCP_PROTOCOL_MODE: "dual",
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: root,
      OBSIDIAN_ENABLE_CACHE: "false",
      MCP_WRITE_MODE: "readonly",
      MCP_TOOL_PROFILE: "full",
      MCP_EXTERNAL_ROOTS_FILE: "",
      MCP_SKILLS_CONFIG_FILE: "",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
      LOGS_DIR: logs,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += c));
  const client = new C(
    { name: "untrusted-upstream-client", version: "1" },
    modern ? { versionNegotiation: { mode: { pin: revision } } } : {},
  );
  sessions.push({ client, transport });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Proxy fixture connect failed: ${stderr}`, {
      cause: error,
    });
  }
  if (modern) assert.equal(client.getProtocolEra(), "modern");
  return { client, stderr: () => stderr };
}
const watchdog = setTimeout(() => {
  console.error("modern proxy fixture watchdog");
  process.exit(2);
}, 90000);
try {
  for (const modern of [false, true]) {
    const label = modern ? "modern" : "legacy",
      { client, stderr } = await connect(modern);
    generationReadOnly = true;
    assert.equal((await client.listTools()).tools.length, 3);
    await client.callTool({
      name: "read_probe",
      arguments: { case: label + "-read-lost" },
    });
    assert.equal(
      counts.get(label + "-read-lost"),
      2,
      "proven read-only retries exactly once",
    );
    await assert.rejects(
      client.callTool({
        name: "mutation_probe",
        arguments: { case: label + "-mutation-lost" },
      }),
      /backend_outcome_unknown/,
    );
    assert.equal(
      counts.get(label + "-mutation-lost"),
      1,
      "lost mutation response never replays",
    );
    await client.callTool({
      name: "read_probe",
      arguments: { case: label + "-after-mutation" },
    });
    const before = messages.filter(
      (x) => x.message?.method === "server/discover",
    ).length;
    await assert.rejects(
      client.callTool({
        name: "mutation_probe",
        arguments: { case: label + "-application404" },
      }),
      /status=404/,
    );
    assert.equal(
      messages.filter((x) => x.message?.method === "server/discover").length,
      before,
      "modern 404 must not reconnect",
    );
    await assert.rejects(
      client.callTool({
        name: "generation_probe",
        arguments: { case: label + "-generation" },
      }),
      /backend_outcome_unknown/,
    );
    assert.equal(
      counts.get(label + "-generation"),
      1,
      "read-only annotation proof may not survive a backend-generation change",
    );
    await client.callTool({
      name: "read_probe",
      arguments: { case: label + "-healthy" },
      _meta: { "example.test/custom": "preserved" },
    });
    assert.equal(stderr().includes("PRIVATE_BACKEND_RESPONSE"), false);
    await client.close();
  }
  assert.equal(
    messages.some((x) => x.message?.method === "initialize"),
    false,
    "backend negotiated modern, without a legacy handshake",
  );
  for (const { message, headers } of messages.filter(
    (x) => x.message?.method === "tools/call",
  )) {
    assert.equal(headers["mcp-session-id"], undefined);
    assert.equal(
      message.params._meta["io.modelcontextprotocol/protocolVersion"],
      revision,
    );
    assert.notEqual(
      message.params._meta["io.modelcontextprotocol/clientInfo"].name,
      "untrusted-upstream-client",
      "proxy rebuilds hop metadata",
    );
  }
  const custom = messages.find(
    (x) => x.message?.params?.arguments?.case === "modern-healthy",
  );
  assert.equal(custom.message.params._meta["example.test/custom"], "preserved");
  // Auto detection must not turn auth/server failures into downgrade signals.
  for (const status of [401, 403, 503]) {
    discoveryReject = status;
    const before = messages.length;
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/client"
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp/full`),
    );
    const client = new ModernClient(
      { name: "auto-negative", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    await assert.rejects(client.connect(transport));
    await client.close().catch(() => {});
    assert.equal(
      messages.slice(before).some((x) => x.message?.method === "initialize"),
      false,
      `${status} is not evidence for legacy fallback`,
    );
  }
  console.log(
    "PASS: v1 and modern stdio clients through modern HTTP proxy; auto discovery; read-only retry, mutation no-replay, generation fence, 404 isolation, hop metadata and no auth/server-error downgrade",
  );
} finally {
  clearTimeout(watchdog);
  await Promise.allSettled(sessions.map((s) => s.client.close()));
  await handler.close();
  backend.closeAllConnections?.();
  await new Promise((r) => backend.close(r));
  await rm(root, { recursive: true, force: true });
  await rm(logs, { recursive: true, force: true });
}
