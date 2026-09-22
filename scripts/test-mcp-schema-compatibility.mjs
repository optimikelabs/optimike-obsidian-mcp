import assert from "node:assert/strict";
import { z } from "zod";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer as V1Server } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport as V1Transport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client as V2Client } from "@modelcontextprotocol/client";
import {
  McpServer as V2Server,
  InMemoryTransport as V2Transport,
} from "@modelcontextprotocol/server";
import { mcpSchema } from "../dist/mcp-server/mcpSchema.js";
const { installLegacyToolCatalog } = await import(
  "../dist/mcp-server/legacyToolCatalog.js"
);
const wire = (value) => JSON.parse(JSON.stringify(value));
const schemas = {
  fixture: {
    text: z.string().trim().min(1),
    count: z.coerce.number().int().positive().default(2),
    nested: z.object({ enum: z.enum(["a", "b"]).default("a") }).default({}),
    tags: z.array(z.string()).default([]),
  },
  pipeline: {
    text: z
      .string()
      .transform((x) => x.length)
      .pipe(z.number().positive()),
  },
  asynchronous: {
    text: z
      .string()
      .refine(async (x) => x === "allowed", "fixture async refinement"),
  },
};
const clients = [],
  servers = [];
async function connection(v2) {
  const Server = v2 ? V2Server : V1Server,
    Client = v2 ? V2Client : V1Client,
    T = v2 ? V2Transport : V1Transport;
  const server = new Server({ name: "schema-golden", version: "1" });
  servers.push(server);
  if (v2) installLegacyToolCatalog(server.server);
  for (const [name, shape] of Object.entries(schemas)) {
    const handler = async (params) => ({
      content: [{ type: "text", text: JSON.stringify(params) }],
    });
    const annotations = { readOnlyHint: true };
    if (v2)
      server.registerTool(
        name,
        { description: "same", inputSchema: mcpSchema(shape), annotations },
        handler,
      );
    else server.tool(name, "same", shape, annotations, handler);
  }
  const [ct, st] = T.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "schema-client", version: "1" });
  clients.push(client);
  await client.connect(ct);
  return client;
}
try {
  const v1 = await connection(false),
    v2 = await connection(true);
  assert.deepEqual(
    wire((await v2.listTools()).tools),
    wire((await v1.listTools()).tools),
    "SDK v2 must publish the exact v1 JSON Schema dialect and validation surface",
  );
  for (const [name, args] of [
    ["fixture", { text: " trimmed ", count: "3", extra: "stripped" }],
    ["pipeline", { text: "abc" }],
    ["asynchronous", { text: "allowed" }],
  ]) {
    const [a, b] = await Promise.all(
      [v1, v2].map((c) => c.callTool({ name, arguments: args })),
    );
    assert.deepEqual(
      b,
      a,
      "defaults/coercion/stripping/transforms/async refinements must be unchanged",
    );
  }
  for (const [name, args] of [
    ["fixture", { text: " " }],
    ["pipeline", { text: "" }],
    ["asynchronous", { text: "denied" }],
  ]) {
    for (const c of [v1, v2])
      assert.equal((await c.callTool({ name, arguments: args })).isError, true);
  }
  console.log(
    "PASS: exact SDK 1.30 vs SDK 2 schemas, input pipe strategy, defaults, stripping, coercion, transforms and async validation",
  );
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  await Promise.allSettled(servers.map((s) => s.close()));
}
