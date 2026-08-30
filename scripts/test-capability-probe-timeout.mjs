#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const tempParent = path.join(process.cwd(), ".tmp");
await mkdir(tempParent, { recursive: true });
const root = await mkdtemp(path.join(tempParent, "doctor-timeout-"));
const sockets = new Set();
const server = createServer((_request, response) => {
  setTimeout(() => {
    if (!response.destroyed) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }
  }, 1_000).unref();
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});
const address = server.address();
assert.ok(address && typeof address === "object");

process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.OBSIDIAN_API_KEY = "capability-probe-timeout-fixture";
process.env.OBSIDIAN_VERIFY_SSL = "false";
process.env.OBSIDIAN_ENABLE_CACHE = "false";
process.env.OBSIDIAN_SHARED_CACHE_DB_PATH = path.join(root, "cache.sqlite");
process.env.LOGS_DIR = path.join(root, "logs");
await mkdir(process.env.LOGS_DIR, { recursive: true });
process.env.MCP_LOG_LEVEL = "error";
process.env.SEMANTIC_SEARCH_PREWARM = "false";

const { ObsidianRestApiService } = await import(
  "../dist/services/obsidianRestAPI/service.js"
);
const { OperonService } = await import("../dist/services/operon/service.js");
const context = {
  requestId: "capability-probe-timeout",
  timestamp: new Date(0).toISOString(),
  operation: "capabilityProbeTimeout",
};
const rest = new ObsidianRestApiService();
const operon = new OperonService();

async function assertBounded(label, operation) {
  const started = performance.now();
  await operation();
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < 500,
    `${label} ignored the bounded probe timeout (${Math.round(elapsed)} ms)`,
  );
}

try {
  await assertBounded("Local REST status", async () => {
    await assert.rejects(() => rest.checkStatus(context, 40));
  });
  await assertBounded("Atomic Write status", async () => {
    await assert.rejects(() => rest.getAtomicWriteStatus(context, 40));
  });
  await assertBounded("Bases Atomic status", async () => {
    await assert.rejects(() => rest.getBaseAtomicStatus(context, 40));
  });
  await assertBounded("Operon status", async () => {
    const result = await operon.status(false, 40);
    assert.equal(result.source, "unavailable");
    assert.equal(result.ok, false);
  });
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("Capability probe timeout contract passed.");
