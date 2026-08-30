#!/usr/bin/env node

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.MCP_TOOL_PROFILE = "tasks";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { registerRuntimeTools } = await import(
  "../dist/mcp-server/tools/runtimeTools/registration.js"
);
const { installToolProfileRegistrationGate } = await import(
  "../dist/mcp-server/toolProfileRuntime.js"
);

const privateMarker = "P2-MCP-PRIVATE-MARKER-6c92";
const atomicStatus = {
  ok: true,
  contractVersion: 1,
  plugin: { id: "atomic", version: "1" },
  backend: {
    kind: "obsidian-vault-process",
    bindingFingerprint: privateMarker,
    atomicCas: true,
    writeEnabled: true,
    canvasAtomicCas: true,
    canvasWriteEnabled: true,
  },
  limits: { markdownOnly: true },
};
const baseStatus = {
  ok: true,
  contractVersion: 1,
  plugin: { id: "bases", version: "1" },
  backend: {
    kind: "obsidian-vault-process-base",
    bindingFingerprint: privateMarker,
    atomicCas: true,
    writeEnabled: true,
  },
  limits: { baseOnly: true, sourcePreservingCompilerRequired: true },
  migration: { legacyConfigWritesEnabled: false },
};
const operonStatus = {
  ok: true,
  source: "operon-live",
  stale: false,
  live: {
    bridge: { mode: "read-only", mutationsEnabled: false },
    operon: { present: true, compatible: true },
    index: { ready: true, duplicateConflictCount: 0 },
    capabilities: {
      list: true,
      query: true,
      create: true,
      update: true,
      transition: true,
      recovery: true,
    },
    privateMarker,
  },
};

const server = new McpServer({ name: "capability-doctor-test", version: "1" });
installToolProfileRegistrationGate(server, "tasks");
await registerRuntimeTools(
  server,
  {},
  undefined,
  undefined,
  undefined,
  undefined,
  {
    localRest: async () => ({ authenticated: true }),
    atomicWrite: async () => atomicStatus,
    baseAtomicWrite: async () => baseStatus,
    operon: async () => operonStatus,
  },
);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client(
  { name: "capability-doctor-client", version: "1" },
  { capabilities: {} },
);

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.ok(
    listed.tools.some((tool) => tool.name === "obsidian_runtime_status"),
    "the canonical doctor must remain visible in the tasks profile",
  );
  const result = await client.callTool({
    name: "obsidian_runtime_status",
    arguments: {},
  });
  assert.notEqual(result.isError, true);
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const payload = JSON.parse(text);
  assert.equal(payload.capabilityManifest.contractVersion, 1);
  assert.equal(payload.capabilityManifest.profile, "tasks");
  assert.equal(payload.capabilityManifest.registrationMode, "hybrid-live");
  const write = payload.capabilityManifest.capabilities.find(
    (item) => item.id === "operon-write",
  );
  assert.deepEqual(
    {
      discoverable: write.discoverable,
      available: write.available,
      authorized: write.authorized,
      state: write.state,
      reasonCode: write.reasonCode,
      nextAction: write.nextAction,
    },
    {
      discoverable: true,
      available: true,
      authorized: false,
      state: "blocked",
      reasonCode: "operon_mutations_disabled",
      nextAction: "enable_operon_mutations",
    },
  );
  assert.equal(write.operations.length, 11);
  assert.ok(
    write.operations.every(
      (operation) => operation.reasonCode === "operon_mutations_disabled",
    ),
  );
  assert.equal(text.includes(privateMarker), false);
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}

console.log("Capability doctor MCP contract passed.");
