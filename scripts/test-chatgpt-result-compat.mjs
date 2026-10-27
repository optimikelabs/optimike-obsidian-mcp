import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const watchdog = setTimeout(() => {
  console.error("fixture timed out");
  process.exit(1);
}, 60000);
const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(202).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const msg = JSON.parse(Buffer.concat(chunks));
  if (msg.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  let result;
  if (msg.method === "initialize")
    result = {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    };
  else if (msg.method === "tools/list")
    result = {
      tools: [
        {
          name: "obsidian_read_note",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  else if (msg.method === "tools/call") result = msg.params.arguments.result;
  else {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "mcp-session-id": "fixture",
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
const vault = await mkdtemp(join(tmpdir(), "chatgpt-proxy-fixture-"));
let client;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sample = {
    content: [
      {
        type: "text",
        text: '{\n  "before": 1,\n  "content": "bonjour",\n  "stats": {"content": "nested"}\n}',
      },
      { type: "text", text: "plain text" },
      { type: "text", text: '{"other":1}' },
      { type: "text", text: '[{"content":"nested"}]' },
      { type: "text", text: '{"content":' },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    isError: false,
  };
  const expected = structuredClone(sample);
  expected.content[0].text = expected.content[0].text.replace(
    '"content": "bonjour"',
    '"note_content": "bonjour"',
  );
  const error = {
    content: [{ type: "text", text: '{"content":"error"}' }],
    isError: true,
  };
  const collision = {
    content: [{ type: "text", text: '{"content":"a","note_content":"b"}' }],
  };
  const duplicate = {
    content: [{ type: "text", text: '{"content":"a","content":"b"}' }],
  };
  for (const flag of [undefined, "1"]) {
    const env = {
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: vault,
      OBSIDIAN_ENABLE_CACHE: "false",
      MCP_WRITE_MODE: "readonly",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(server.address().port),
      MCP_TOOL_PROFILE: "full",
      MCP_LOG_LEVEL: "error",
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
    };
    if (flag) env.MCP_PROXY_CHATGPT_RESULT_COMPAT = flag;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/stdio-proxy.js", import.meta.url)),
        "--tool-profile",
        "full",
      ],
      cwd: vault,
      env,
      stderr: "pipe",
    });
    client = new Client({ name: "compat-test", version: "1" });
    await client.connect(transport);
    for (const [input, output] of [
      [sample, flag ? expected : sample],
      [error, error],
      [collision, collision],
      [duplicate, duplicate],
    ]) {
      const actual = await client.callTool({
        name: "obsidian_read_note",
        arguments: { result: input },
      });
      assert.equal(JSON.stringify(actual), JSON.stringify(output));
    }
    await client.close();
    client = undefined;
  }
  console.log("ChatGPT result compatibility: PASS");
} finally {
  if (client) await client.close();
  clearTimeout(watchdog);
  server.close();
  await rm(vault, { recursive: true, force: true });
}
