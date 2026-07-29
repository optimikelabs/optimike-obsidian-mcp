#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = "session-bound-test-secret-must-be-at-least-32-characters";

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

async function signToken(clientId) {
  return new SignJWT({ cid: clientId, scp: ["vault:read"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://session-bounds.optimike.test")
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

function initializeBody(id, name) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name, version: "0" },
    },
  };
}

async function mcpPost(baseUrl, token, body, sessionId) {
  return fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function initialize(baseUrl, token, id) {
  return mcpPost(baseUrl, token, initializeBody(id, `session-test-${id}`));
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `HTTP backend exited with ${child.exitCode}: ${child.stderrText}`,
      );
    }
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function startBackend(sandbox, name, overrides) {
  const port = await unusedPort();
  const vaultPath = path.join(sandbox, `${name}-vault`);
  const logDir = path.join(
    process.cwd(),
    ".tmp",
    `http-session-${name}-${port}`,
  );
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(vaultPath, "Smoke.md"), "# Smoke\n", "utf8");

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
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
      MCP_LOG_LEVEL: "info",
      LOGS_DIR: logDir,
      MCP_AUTH_MODE: "jwt",
      MCP_AUTH_SECRET_KEY: secret,
      MCP_ALLOWED_ORIGINS: "",
      MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1000",
      MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "1000",
      MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS: "1000",
      MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS: "1000",
      MCP_HTTP_SESSION_CLEANUP_INTERVAL_MS: "20",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderrText = "";
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk) => {
    child.stderrText += String(chunk);
  });

  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  await waitForHealth(baseUrl, child);
  return { baseUrl, child, logDir };
}

async function stopBackend(instance) {
  instance.child.kill();
  await Promise.race([
    new Promise((resolve) => {
      if (instance.child.exitCode !== null) return resolve();
      instance.child.once("exit", resolve);
    }),
    sleep(3000),
  ]);
  await rm(instance.logDir, { recursive: true, force: true });
}

async function testConcurrentReservations(sandbox) {
  const instance = await startBackend(sandbox, "reservations", {
    MCP_HTTP_MAX_SESSIONS: "2",
    MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "5000",
    MCP_HTTP_SESSION_MAX_LIFETIME_MS: "10000",
  });
  try {
    const tokens = await Promise.all(
      Array.from({ length: 12 }, (_, index) => signToken(`burst-${index}`)),
    );
    const responses = await Promise.all(
      tokens.map((token, index) => initialize(instance.baseUrl, token, index + 1)),
    );
    const statuses = responses.map((response) => response.status);
    assert.equal(
      statuses.filter((status) => status === 200).length,
      2,
      `expected exactly two initialized sessions, got ${statuses.join(",")}`,
    );
    assert.equal(
      statuses.filter((status) => status === 503).length,
      10,
      `expected every excess initialization to receive 503, got ${statuses.join(",")}`,
    );
    for (const [index, response] of responses.entries()) {
      if (response.status !== 503) continue;
      assert.equal(response.headers.get("retry-after"), "1");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const payload = await response.json();
      assert.equal(
        payload.id,
        index + 1,
        "capacity errors must preserve the initialize request id",
      );
    }
  } finally {
    await stopBackend(instance);
  }
}

async function testIdleExpiry(sandbox) {
  const instance = await startBackend(sandbox, "idle-expiry", {
    MCP_HTTP_MAX_SESSIONS: "1",
    MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "80",
    MCP_HTTP_SESSION_MAX_LIFETIME_MS: "5000",
  });
  try {
    const first = await initialize(
      instance.baseUrl,
      await signToken("idle-owner"),
      20,
    );
    assert.equal(first.status, 200);
    const blocked = await initialize(
      instance.baseUrl,
      await signToken("idle-blocked"),
      21,
    );
    assert.equal(blocked.status, 503);

    await sleep(180);
    const afterExpiry = await initialize(
      instance.baseUrl,
      await signToken("idle-successor"),
      22,
    );
    assert.equal(afterExpiry.status, 200);
  } finally {
    await stopBackend(instance);
  }
}

async function testAbsoluteExpiry(sandbox) {
  const instance = await startBackend(sandbox, "absolute-expiry", {
    MCP_HTTP_MAX_SESSIONS: "1",
    MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "5000",
    MCP_HTTP_SESSION_MAX_LIFETIME_MS: "80",
  });
  try {
    const first = await initialize(
      instance.baseUrl,
      await signToken("absolute-owner"),
      30,
    );
    assert.equal(first.status, 200);
    await sleep(180);
    const successor = await initialize(
      instance.baseUrl,
      await signToken("absolute-successor"),
      31,
    );
    assert.equal(successor.status, 200);
  } finally {
    await stopBackend(instance);
  }
}

async function testActiveStreamSurvivesIdleCleanup(sandbox) {
  const instance = await startBackend(sandbox, "active-stream", {
    MCP_HTTP_MAX_SESSIONS: "1",
    MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "80",
    MCP_HTTP_SESSION_MAX_LIFETIME_MS: "5000",
  });
  const token = await signToken("stream-owner");
  const streamAbort = new AbortController();
  let streamResponse;
  try {
    const initialized = await initialize(instance.baseUrl, token, 40);
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);

    streamResponse = await Promise.race([
      fetch(new URL("/mcp", instance.baseUrl), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          "Mcp-Session-Id": sessionId,
        },
        signal: streamAbort.signal,
      }),
      sleep(3000).then(() => {
        throw new Error("timed out opening the MCP event stream");
      }),
    ]);
    assert.equal(streamResponse.status, 200);

    await sleep(180);
    const ping = await mcpPost(
      instance.baseUrl,
      token,
      { jsonrpc: "2.0", id: 41, method: "ping" },
      sessionId,
    );
    assert.equal(
      ping.status,
      200,
      "idle cleanup must not close a session with an active stream",
    );
  } finally {
    streamAbort.abort();
    await streamResponse?.body?.cancel().catch(() => undefined);
    await stopBackend(instance);
  }
}

async function testActiveStreamStopsAtAbsoluteExpiry(sandbox) {
  const instance = await startBackend(sandbox, "active-stream-max-lifetime", {
    MCP_HTTP_MAX_SESSIONS: "1",
    MCP_HTTP_SESSION_IDLE_TIMEOUT_MS: "5000",
    MCP_HTTP_SESSION_MAX_LIFETIME_MS: "120",
  });
  const token = await signToken("absolute-stream-owner");
  const streamAbort = new AbortController();
  let streamResponse;
  let streamReader;
  try {
    const initialized = await initialize(instance.baseUrl, token, 50);
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);

    streamResponse = await Promise.race([
      fetch(new URL("/mcp", instance.baseUrl), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          "Mcp-Session-Id": sessionId,
        },
        signal: streamAbort.signal,
      }),
      sleep(3000).then(() => {
        throw new Error("timed out opening the max-lifetime MCP event stream");
      }),
    ]);
    assert.equal(streamResponse.status, 200);
    assert.ok(streamResponse.body);
    streamReader = streamResponse.body.getReader();

    const streamClosed = (async () => {
      while (true) {
        const chunk = await streamReader.read();
        if (chunk.done) return true;
      }
    })();
    assert.equal(
      await Promise.race([
        streamClosed,
        sleep(3000).then(() => false),
      ]),
      true,
      "absolute session lifetime must close an active event stream",
    );

    const expiredPing = await mcpPost(
      instance.baseUrl,
      token,
      { jsonrpc: "2.0", id: 51, method: "ping" },
      sessionId,
    );
    assert.equal(
      expiredPing.status,
      404,
      "requests using an absolutely expired session must be rejected",
    );

    const successor = await initialize(
      instance.baseUrl,
      await signToken("absolute-stream-successor"),
      52,
    );
    assert.equal(
      successor.status,
      200,
      "absolute expiry must release session capacity after closing the stream",
    );
  } finally {
    streamAbort.abort();
    await streamReader?.cancel().catch(() => undefined);
    streamReader?.releaseLock();
    await stopBackend(instance);
  }
}

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-http-session-bounds-"),
);
try {
  await testConcurrentReservations(sandbox);
  await testIdleExpiry(sandbox);
  await testAbsoluteExpiry(sandbox);
  await testActiveStreamSurvivesIdleCleanup(sandbox);
  await testActiveStreamStopsAtAbsoluteExpiry(sandbox);
  console.log(
    "PASS: concurrent initialization reservations preserve the session maximum, capacity errors preserve JSON-RPC ids, idle cleanup preserves active streams, and absolute lifetime closes active streams deterministically",
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
