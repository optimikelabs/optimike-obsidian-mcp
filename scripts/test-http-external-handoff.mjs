#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import {
  ExternalTransferBroker,
} from "../dist/services/externalTransferBroker.js";

function jsonOf(result) {
  return JSON.parse(
    result.content?.map((item) => item.text ?? "").join("\n") ?? "{}",
  );
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP backend exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function signToken(secret, clientId, subject = clientId) {
  return new SignJWT({ cid: clientId, scp: ["external:read"] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

async function testBrokerLifecycle(sandbox) {
  let now = Date.now();
  const broker = new ExternalTransferBroker({
    enabled: true,
    ttlMs: 1_000,
    maxTickets: 2,
    maxFileBytes: 1024,
    maxTotalBytes: 2048,
    now: () => now,
  });
  const auth = {
    token: "token-a",
    clientId: "client-a",
    scopes: ["external:read"],
    subject: "subject-a",
  };
  const otherAuth = {
    token: "token-b",
    clientId: "client-b",
    scopes: ["external:read"],
    subject: "subject-b",
  };
  const content = Buffer.from("verified broker payload");
  const stagedPath = path.join(sandbox, "service-owned-staged.bin");
  await writeFile(stagedPath, content);
  const prepared = {
    rootId: "pilot.docs",
    path: "docs/payload.bin",
    localPath: stagedPath,
    size: content.length,
    modifiedAt: new Date(now).toISOString(),
    sha256: sha256(content),
  };
  const descriptor = await broker.issue(prepared, auth);
  assert.equal(descriptor.delivery, "http_ticket");
  assert.equal(descriptor.endpoint, "/external-handoff");
  assert.equal(descriptor.ticketHeader, "X-External-Handoff-Ticket");
  assert.equal("localPath" in descriptor, false);

  await assert.rejects(
    () => broker.consume(descriptor.ticket, otherAuth),
    /invalid or unavailable/u,
  );
  const delivered = await broker.consume(descriptor.ticket, auth);
  assert.deepEqual(delivered.buffer, content);
  assert.equal(delivered.sha256, sha256(content));
  await access(stagedPath);
  await assert.rejects(
    () => broker.consume(descriptor.ticket, auth),
    /invalid or unavailable/u,
  );

  // The broker must not delete the ExternalRootsService-owned copy. It may be
  // reused by a later handoff until the service's own bounded cache expires.
  const repeated = await broker.issue(prepared, auth);
  assert.deepEqual((await broker.consume(repeated.ticket, auth)).buffer, content);
  await access(stagedPath);

  const expiringPath = path.join(sandbox, "service-owned-expiring.bin");
  await writeFile(expiringPath, content);
  const expiring = await broker.issue(
    {
      rootId: "pilot.docs",
      path: "docs/expiring.bin",
      localPath: expiringPath,
      size: content.length,
      modifiedAt: new Date(now).toISOString(),
      sha256: sha256(content),
    },
    auth,
  );
  now += 1_001;
  await assert.rejects(
    () => broker.consume(expiring.ticket, auth),
    /invalid or unavailable/u,
  );
  await access(expiringPath);
  await broker.dispose();

  // Capacity must be reserved before file buffering. Two concurrent requests
  // cannot transiently exceed the one-ticket/one-payload memory budget.
  const capacityBroker = new ExternalTransferBroker({
    enabled: true,
    ttlMs: 10_000,
    maxTickets: 1,
    maxFileBytes: 1024,
    maxTotalBytes: content.length,
  });
  const concurrent = await Promise.allSettled([
    capacityBroker.issue(prepared, auth),
    capacityBroker.issue(prepared, auth),
  ]);
  const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
  const rejected = concurrent.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /capacity is currently exhausted/u);
  const capacityTicket = fulfilled[0].value.ticket;
  assert.deepEqual(
    (await capacityBroker.consume(capacityTicket, auth)).buffer,
    content,
  );

  // After the claimed ticket releases its budget, a new request succeeds.
  const afterRelease = await capacityBroker.issue(prepared, auth);
  assert.deepEqual(
    (await capacityBroker.consume(afterRelease.ticket, auth)).buffer,
    content,
  );
  await capacityBroker.dispose();
}

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-http-external-handoff-"),
);
const vaultPath = path.join(sandbox, "vault");
const externalPath = path.join(sandbox, "external");
const configPath = path.join(sandbox, "external-roots.json");
const port = await unusedPort();
const baseUrl = new URL(`http://127.0.0.1:${port}`);
const mcpUrl = new URL("/mcp", baseUrl);
const healthUrl = new URL("/healthz", baseUrl);
const downloadUrl = new URL("/external-handoff", baseUrl);
const secret = "http-handoff-test-secret-must-be-at-least-32-characters";
const token = await signToken(secret, "http-client", "operator");
const otherToken = await signToken(secret, "other-client", "other-operator");
const payload = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
await mkdir(externalPath, { recursive: true });
await writeFile(path.join(vaultPath, "Smoke.md"), "# Smoke\n", "utf8");
await writeFile(path.join(externalPath, "artifact.bin"), payload);
await writeFile(
  configPath,
  JSON.stringify({
    version: 1,
    roots: [
      {
        id: "http.pilot",
        path: externalPath,
        capabilities: ["visible", "readable", "handoff"],
        include: ["**/*.bin"],
        limits: {
          maxDepth: 2,
          maxFileBytes: 1024,
          maxListEntries: 20,
          maxTextChars: 100,
        },
      },
    ],
  }),
  "utf8",
);

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OBSIDIAN_RUNTIME_MODE: "headless-readonly",
    OBSIDIAN_VAULT: vaultPath,
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_ENABLE_CACHE: "false",
    MCP_WRITE_MODE: "readonly",
    SEMANTIC_SEARCH_PREWARM: "false",
    MCP_TRANSPORT_TYPE: "http",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_LOG_LEVEL: "error",
    MCP_EXTERNAL_ROOTS_FILE: configPath,
    MCP_HTTP_HANDOFF_ENABLED: "true",
    MCP_HTTP_HANDOFF_TTL_MS: "60000",
    MCP_AUTH_MODE: "jwt",
    MCP_AUTH_SECRET_KEY: secret,
    MCP_ALLOWED_ORIGINS: "https://allowed.example",
  },
  stdio: "ignore",
});

const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
});
const client = new Client({
  name: "optimike-http-external-handoff-test",
  version: "0",
});

try {
  await testBrokerLifecycle(sandbox);
  await waitForHealth(healthUrl, backend);

  const rejectedOrigin = await fetch(healthUrl, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(rejectedOrigin.status, 403);

  await client.connect(transport);
  const status = jsonOf(
    await client.callTool({
      name: "external_runtime_status",
      arguments: {},
    }),
  );
  assert.equal(status.enabled, true);
  assert.equal(status.localHandoffAllowed, false);
  assert.deepEqual(status.handoffModes, ["http_ticket"]);
  assert.equal(status.httpHandoff.available, true);
  assert.equal(status.httpHandoff.storage, "bounded_memory");
  assert.equal(JSON.stringify(status).includes(externalPath), false);

  const handoff = jsonOf(
    await client.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "http.pilot",
        relativePath: "artifact.bin",
        includeHash: false,
      },
    }),
  );
  assert.equal(handoff.delivery, "http_ticket");
  assert.equal(handoff.endpoint, "/external-handoff");
  assert.equal(handoff.ticketHeader, "X-External-Handoff-Ticket");
  assert.match(handoff.ticket, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(handoff.sha256, sha256(payload));
  assert.equal("localPath" in handoff, false);
  assert.equal(JSON.stringify(handoff).includes(externalPath), false);

  const crossClient = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${otherToken}`,
      "X-External-Handoff-Ticket": handoff.ticket,
    },
  });
  assert.equal(crossClient.status, 404);

  const downloaded = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-External-Handoff-Ticket": handoff.ticket,
    },
  });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(downloaded.headers.get("x-artifact-sha256"), sha256(payload));
  assert.equal(
    JSON.stringify([...downloaded.headers]).includes(externalPath),
    false,
  );
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), payload);

  const replay = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-External-Handoff-Ticket": handoff.ticket,
    },
  });
  assert.equal(replay.status, 404);

  const missingAuth = await fetch(downloadUrl, {
    headers: { "X-External-Handoff-Ticket": "unknown" },
  });
  assert.equal(missingAuth.status, 401);

  console.log(
    "PASS: authenticated HTTP handoff returns one-use identity-bound tickets, preserves integrity, bounds concurrent buffering, rejects cross-client use and replay, and discloses no source path",
  );
} finally {
  await client.close().catch(() => undefined);
  backend.kill();
  await new Promise((resolve) => {
    if (backend.exitCode !== null) return resolve();
    backend.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  await rm(sandbox, { recursive: true, force: true });
}
