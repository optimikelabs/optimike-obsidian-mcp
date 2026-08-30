#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import {
  externalHandoffResponse,
  ExternalTransferBroker,
} from "../dist/services/externalTransferBroker.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function sendThenDisconnect(url, headers) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(
      {
        host: url.hostname,
        port: Number(url.port),
      },
      () => {
        const requestHeaders = Object.entries(headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n");
        socket.setNoDelay(true);
        socket.write(
          `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n${requestHeaders}\r\nConnection: close\r\n\r\n`,
          (error) => {
            if (error) {
              reject(error);
              return;
            }
            socket.destroy();
            resolve();
          },
        );
      },
    );
    socket.once("error", reject);
  });
}

async function signToken(
  secret,
  clientId,
  subject = clientId,
  scopes = ["external:read"],
) {
  return new SignJWT({ cid: clientId, scp: scopes })
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
  await assert.rejects(
    () =>
      broker.consume(descriptor.ticket, {
        ...auth,
        token: "rotated-token",
      }),
    /invalid or unavailable/u,
  );
  await assert.rejects(
    () =>
      broker.consume(descriptor.ticket, {
        ...auth,
        subject: "different-subject",
      }),
    /invalid or unavailable/u,
  );
  const delivered = await broker.consume(descriptor.ticket, auth);
  assert.deepEqual(delivered.buffer, content);
  assert.equal(delivered.sha256, sha256(content));
  await delivered.release();
  await access(stagedPath);
  await assert.rejects(
    () => broker.consume(descriptor.ticket, auth),
    /invalid or unavailable/u,
  );

  // The broker must not delete the ExternalRootsService-owned copy. It may be
  // reused by a later handoff until the service's own bounded cache expires.
  const repeated = await broker.issue(prepared, auth);
  const competingConsumers = await Promise.allSettled([
    broker.consume(repeated.ticket, auth),
    broker.consume(repeated.ticket, auth),
  ]);
  const successfulConsumers = competingConsumers.filter(
    (result) => result.status === "fulfilled",
  );
  const rejectedConsumers = competingConsumers.filter(
    (result) => result.status === "rejected",
  );
  assert.equal(successfulConsumers.length, 1);
  assert.equal(rejectedConsumers.length, 1);
  assert.match(String(rejectedConsumers[0].reason), /invalid or unavailable/u);
  const repeatedDelivery = successfulConsumers[0].value;
  assert.deepEqual(repeatedDelivery.buffer, content);
  await repeatedDelivery.release();
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
  const fulfilled = concurrent.filter(
    (result) => result.status === "fulfilled",
  );
  const rejected = concurrent.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /capacity is currently exhausted/u);
  const capacityTicket = fulfilled[0].value.ticket;
  const capacityDelivery = await capacityBroker.consume(capacityTicket, auth);
  assert.deepEqual(capacityDelivery.buffer, content);

  // Claiming a ticket must not free its memory budget while the download is
  // still in flight.
  await assert.rejects(
    () => capacityBroker.issue(prepared, auth),
    /capacity is currently exhausted/u,
  );
  await capacityDelivery.release();
  await capacityDelivery.release();

  // After the completed delivery releases its lease, a new request succeeds.
  const afterRelease = await capacityBroker.issue(prepared, auth);
  const afterReleaseDelivery = await capacityBroker.consume(
    afterRelease.ticket,
    auth,
  );
  assert.deepEqual(afterReleaseDelivery.buffer, content);
  await afterReleaseDelivery.release();
  await capacityBroker.dispose();
}

async function testTransferWatchdog() {
  let releases = 0;
  const content = Buffer.from("unconsumed response");
  const response = externalHandoffResponse(
    {
      buffer: content,
      filename: "watchdog.bin",
      mediaType: "application/octet-stream",
      size: content.length,
      sha256: sha256(content),
      release: async () => {
        releases += 1;
      },
    },
    25,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(releases, 1);
  await response.body?.cancel().catch(() => undefined);
  assert.equal(releases, 1);
}

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-http-external-handoff-"),
);
const vaultPath = path.join(sandbox, "vault");
const externalPath = path.join(sandbox, "external");
const configPath = path.join(sandbox, "external-roots.json");
const port = await unusedPort();
const baseUrl = new URL(`http://127.0.0.1:${port}`);
const mcpUrl = new URL("/mcp/full", baseUrl);
const healthUrl = new URL("/healthz", baseUrl);
const downloadUrl = new URL("/external-handoff", baseUrl);
const secret = "http-handoff-test-secret-must-be-at-least-32-characters";
const token = await signToken(secret, "http-client", "operator");
const otherToken = await signToken(secret, "other-client", "other-operator");
const wrongScopeToken = await signToken(
  secret,
  "wrong-scope-client",
  "wrong-scope-operator",
  ["vault:read"],
);
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
    MCP_HTTP_HANDOFF_TRANSFER_TIMEOUT_MS: "500",
    MCP_HTTP_HANDOFF_MAX_TICKETS: "1",
    MCP_HTTP_HANDOFF_MAX_TOTAL_BYTES: String(payload.length),
    MCP_AUTH_MODE: "jwt",
    MCP_AUTH_SECRET_KEY: secret,
    MCP_ALLOWED_ORIGINS: "https://allowed.example",
    MCP_HTTP_IDENTITY_RATE_LIMIT_WINDOW_MS: "1000",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "20",
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
const wrongScopeTransport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {
    headers: {
      Authorization: `Bearer ${wrongScopeToken}`,
    },
  },
});
const wrongScopeClient = new Client({
  name: "optimike-http-external-handoff-wrong-scope-test",
  version: "0",
});

try {
  await testBrokerLifecycle(sandbox);
  await testTransferWatchdog();
  await waitForHealth(healthUrl, backend);

  const rejectedOrigin = await fetch(healthUrl, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(rejectedOrigin.status, 403);
  const allowedOrigin = await fetch(healthUrl, {
    headers: { Origin: "https://allowed.example" },
  });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(
    allowedOrigin.headers.get("access-control-allow-origin"),
    "https://allowed.example",
  );
  const allowedPreflight = await fetch(downloadUrl, {
    method: "OPTIONS",
    headers: {
      Origin: "https://allowed.example",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers":
        "Authorization,X-External-Handoff-Ticket",
    },
  });
  assert.equal(allowedPreflight.status, 204);
  assert.equal(
    allowedPreflight.headers.get("access-control-allow-origin"),
    "https://allowed.example",
  );

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

  await sleep(1100);
  for (let index = 0; index < 19; index += 1) {
    await client.listTools();
  }
  const lastAllowanceHandoff = jsonOf(
    await client.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "http.pilot",
        relativePath: "artifact.bin",
      },
    }),
  );
  const lastAllowanceDownload = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-External-Handoff-Ticket": lastAllowanceHandoff.ticket,
    },
  });
  const lastAllowanceFailure =
    lastAllowanceDownload.status === 200
      ? ""
      : await lastAllowanceDownload.clone().text();
  assert.equal(
    lastAllowanceDownload.status,
    200,
    `ticket redemption failed after issuance on the final identity allowance: ${lastAllowanceFailure}`,
  );
  assert.deepEqual(
    Buffer.from(await lastAllowanceDownload.arrayBuffer()),
    payload,
  );
  await sleep(1100);

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

  await wrongScopeClient.connect(wrongScopeTransport);
  const wrongScopeCalls = [
    { name: "external_runtime_status", arguments: {} },
    { name: "external_roots_list", arguments: {} },
    {
      name: "external_list",
      arguments: { rootId: "http.pilot", relativePath: "" },
    },
    {
      name: "external_stat",
      arguments: { rootId: "http.pilot", relativePath: "artifact.bin" },
    },
    {
      name: "external_read",
      arguments: { rootId: "http.pilot", relativePath: "artifact.bin" },
    },
    {
      name: "external_handoff",
      arguments: {
        rootId: "http.pilot",
        relativePath: "artifact.bin",
      },
    },
  ];
  for (const call of wrongScopeCalls) {
    const denied = await wrongScopeClient.callTool(call);
    assert.equal(denied.isError, true, `${call.name} accepted wrong scope`);
    const denial = jsonOf(denied);
    assert.equal(denial.error, "capability_denied");
    assert.equal(denial.message, "This request is not authorized.");
    assert.equal(
      denial.details?.reasonCode,
      "EXTERNAL_ROOT_CAPABILITY_DENIED",
    );
    assert.match(
      denial.details?.requestId ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    assert.equal(
      JSON.stringify(denial).includes("external:read"),
      false,
      "authorization failures must not reveal policy internals",
    );
  }

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

  const abandoned = jsonOf(
    await client.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "http.pilot",
        relativePath: "artifact.bin",
      },
    }),
  );
  await sendThenDisconnect(downloadUrl, {
    Authorization: `Bearer ${token}`,
    "X-External-Handoff-Ticket": abandoned.ticket,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const abandonedReplay = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-External-Handoff-Ticket": abandoned.ticket,
    },
  });
  assert.equal(abandonedReplay.status, 404);
  const afterAbandoned = jsonOf(
    await client.callTool({
      name: "external_handoff",
      arguments: {
        rootId: "http.pilot",
        relativePath: "artifact.bin",
      },
    }),
  );
  const recoveredDownload = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-External-Handoff-Ticket": afterAbandoned.ticket,
    },
  });
  assert.equal(recoveredDownload.status, 200);
  assert.deepEqual(Buffer.from(await recoveredDownload.arrayBuffer()), payload);

  console.log(
    "PASS: authenticated HTTP external-root access requires external:read, handoff returns one-use identity-bound tickets, preserves integrity, bounds pending and in-flight buffering, recovers abandoned transfers, rejects cross-client use and replay, and discloses no source path",
  );
} finally {
  await wrongScopeClient.close().catch(() => undefined);
  await client.close().catch(() => undefined);
  backend.kill();
  await new Promise((resolve) => {
    if (backend.exitCode !== null) return resolve();
    backend.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  await rm(sandbox, { recursive: true, force: true });
}
