#!/usr/bin/env node
/**
 * Catalogue-only MCP server for scripts/run-tool-discovery-eval.mjs.
 *
 * It serves a tools/list and server instructions captured from the real
 * server, so a measured client sees the exact surface, and it refuses every
 * tools/call before any handler exists: the refusal is appended to the calls
 * log and returned as a tool error. No vault, Local REST API or runtime state
 * is reachable from here.
 *
 *   node scripts/tool-discovery-replay-server.mjs <catalog.json> <calls.jsonl>
 */
import { appendFileSync, readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const REPLAY_REFUSAL = "Tool calls are refused: this is a tool-discovery measurement fixture.";

const [catalogPath, callsPath] = process.argv.slice(2);
if (!catalogPath || !callsPath) {
  process.stderr.write("usage: tool-discovery-replay-server.mjs <catalog.json> <calls.jsonl>\n");
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const server = new Server(catalog.serverInfo, {
  capabilities: { tools: {} },
  ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  appendFileSync(
    callsPath,
    `${JSON.stringify({ name: request.params.name, at: new Date().toISOString() })}\n`,
    "utf8",
  );
  return { content: [{ type: "text", text: REPLAY_REFUSAL }], isError: true };
});
await server.connect(new StdioServerTransport());
