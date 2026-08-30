#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import {
  BoundedFixedWindowRateLimiter,
  deriveVerifiedHttpIdentity,
  ipMatchesRange,
  parseIpRange,
  resolveClientAddress,
} from "../dist/mcp-server/transports/httpProtection.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function signToken(secret, clientId, subject = clientId) {
  return new SignJWT({ cid: clientId, scp: ["vault:read"] })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://issuer.optimike.test")
    .setSubject(subject)
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

async function mcpPost(baseUrl, { token, body, sessionId, headers = {} }) {
  return fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function headerOnlyPostStatus(baseUrl, contentLength, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: baseUrl.hostname,
      port: Number(baseUrl.port),
    });
    let response = "";
    let settled = false;
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(status);
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            "pre-auth rejection waited for an unfinished near-limit body",
          ),
        ),
      timeoutMs,
    );
    socket.on("connect", () => {
      socket.write(
        [
          "POST /mcp HTTP/1.1",
          `Host: ${baseUrl.host}`,
          "Accept: application/json",
          "Content-Type: application/json",
          `Content-Length: ${contentLength}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += String(chunk);
      const match = /^HTTP\/1\.[01] (\d{3})/u.exec(response);
      if (match) finish(undefined, Number(match[1]));
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) {
        finish(new Error(`connection closed without a response: ${response}`));
      }
    });
  });
}

async function startBackend(sandbox, name, overrides = {}) {
  const port = await unusedPort();
  const vaultPath = path.join(sandbox, `${name}-vault`);
  const logDir = path.join(
    process.cwd(),
    ".tmp",
    `http-multiclient-${name}-${port}`,
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
      MCP_LOG_LEVEL: "debug",
      LOGS_DIR: logDir,
      MCP_AUTH_MODE: "jwt",
      MCP_AUTH_SECRET_KEY:
        "multiclient-test-secret-must-be-at-least-32-characters",
      MCP_ALLOWED_ORIGINS: "",
      MCP_HTTP_LOOPBACK_POLICY: "shared",
      MCP_HTTP_PREAUTH_RATE_LIMIT_WINDOW_MS: "60000",
      MCP_HTTP_IDENTITY_RATE_LIMIT_WINDOW_MS: "60000",
      MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "100",
      MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "2",
      MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS: "100",
      MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS: "100",
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
  return { child, baseUrl, logDir };
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
}

async function testPureProtectionPrimitives() {
  const ipv4 = parseIpRange("10.0.0.0/8");
  const ipv6 = parseIpRange("2001:db8::/32");
  assert.equal(ipMatchesRange("10.1.2.3", ipv4), true);
  assert.equal(ipMatchesRange("11.1.2.3", ipv4), false);
  assert.equal(ipMatchesRange("2001:db8::42", ipv6), true);
  assert.equal(ipMatchesRange("2001:db9::42", ipv6), false);

  // No trusted proxy is configured in this process, so declarations are ignored.
  const untrusted = resolveClientAddress({
    remoteAddress: "127.0.0.1",
    xForwardedFor: "198.51.100.1",
  });
  assert.equal(untrusted.address, "127.0.0.1");
  assert.equal(untrusted.trustedProxyHeaders, false);

  const subjectIdentityA = deriveVerifiedHttpIdentity({
    token: "secret-token-a",
    clientId: "client-a",
    subject: "operator",
    issuer: "issuer",
    scopes: ["vault:read"],
  });
  const subjectIdentityB = deriveVerifiedHttpIdentity({
    token: "rotated-secret-token",
    clientId: "client-a",
    subject: "operator",
    issuer: "issuer",
    scopes: ["vault:read"],
  });
  assert.equal(subjectIdentityA.key, subjectIdentityB.key);
  assert.equal(subjectIdentityA.key.includes("secret-token-a"), false);
  assert.equal(subjectIdentityA.pseudonym.includes("client-a"), false);

  const whitespaceDistinctIdentity = deriveVerifiedHttpIdentity({
    token: "secret-token-a",
    clientId: " client-a",
    subject: "operator",
    issuer: "issuer",
    scopes: ["vault:read"],
  });
  assert.notEqual(subjectIdentityA.key, whitespaceDistinctIdentity.key);

  const fallbackIdentityA = deriveVerifiedHttpIdentity({
    token: "secret-token-a",
    clientId: "client-a",
    issuer: "issuer",
    scopes: ["vault:read"],
  });
  const fallbackIdentityB = deriveVerifiedHttpIdentity({
    token: "secret-token-b",
    clientId: "client-a",
    issuer: "issuer",
    scopes: ["vault:read"],
  });
  assert.notEqual(fallbackIdentityA.key, fallbackIdentityB.key);

  let now = 0;
  const limiter = new BoundedFixedWindowRateLimiter({
    windowMs: 1000,
    maxRequests: 1,
    maxKeys: 1,
    now: () => now,
  });
  assert.equal(limiter.check("a").allowed, true);
  const limited = limiter.check("a");
  assert.equal(limited.allowed, false);
  assert.equal(limited.outcome, "limited");
  const capacity = limiter.check("b");
  assert.equal(capacity.allowed, false);
  assert.equal(capacity.outcome, "capacity");
  now = 1001;
  assert.equal(limiter.cleanupExpiredEntries(), 1);
  assert.equal(limiter.getStats().keys, 0);
  assert.equal(limiter.check("b").allowed, true);
  limiter.dispose();
}

async function testIdentityIsolation(sandbox) {
  const instance = await startBackend(sandbox, "identity");
  const secret = "multiclient-test-secret-must-be-at-least-32-characters";
  const tokenA = await signToken(secret, "client-a", "operator-a");
  const tokenB = await signToken(secret, "client-b", "operator-b");
  try {
    const a1 = await mcpPost(instance.baseUrl, {
      token: tokenA,
      body: initializeBody(1, "a-1"),
    });
    assert.equal(a1.status, 200);
    const sessionA = a1.headers.get("mcp-session-id");
    assert.ok(sessionA);

    const b1 = await mcpPost(instance.baseUrl, {
      token: tokenB,
      body: initializeBody(2, "b-1"),
    });
    assert.equal(b1.status, 200);

    const a2 = await mcpPost(instance.baseUrl, {
      token: tokenA,
      body: initializeBody(3, "a-2"),
    });
    assert.equal(a2.status, 200);

    const a3 = await mcpPost(instance.baseUrl, {
      token: tokenA,
      body: initializeBody(4, "a-3"),
    });
    assert.equal(a3.status, 429);
    assert.ok(Number(a3.headers.get("retry-after")) >= 1);
    assert.equal(
      a3.headers.get("x-optimike-rate-limit-scope"),
      "client-identity",
    );

    // Client B remains isolated even though every request came from 127.0.0.1.
    const b2 = await mcpPost(instance.baseUrl, {
      token: tokenB,
      body: initializeBody(5, "b-2"),
    });
    assert.equal(b2.status, 200);

    // A session initialized by A is not reusable by B.
    const crossIdentity = await mcpPost(instance.baseUrl, {
      token: tokenB,
      sessionId: sessionA,
      body: { jsonrpc: "2.0", id: 6, method: "ping" },
    });
    assert.equal(crossIdentity.status, 429); // B has now also consumed its two-request quota.

    const combinedLog = await readFile(
      path.join(instance.logDir, "combined.log"),
      "utf8",
    );
    assert.equal(combinedLog.includes(tokenA), false);
    assert.equal(combinedLog.includes(tokenB), false);
    assert.equal(combinedLog.includes(secret), false);
  } finally {
    await stopBackend(instance);
    await rm(instance.logDir, { recursive: true, force: true });
  }
}

async function testSessionIdentityBinding(sandbox) {
  const instance = await startBackend(sandbox, "session-binding", {
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "10",
  });
  const secret = "multiclient-test-secret-must-be-at-least-32-characters";
  const tokenA = await signToken(secret, "client-a", "operator-a");
  const tokenB = await signToken(secret, "client-b", "operator-b");
  try {
    const initialized = await mcpPost(instance.baseUrl, {
      token: tokenA,
      body: initializeBody(10, "session-owner"),
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const rejected = await mcpPost(instance.baseUrl, {
      token: tokenB,
      sessionId,
      body: { jsonrpc: "2.0", id: 11, method: "ping" },
    });
    assert.equal(rejected.status, 404);
  } finally {
    await stopBackend(instance);
    await rm(instance.logDir, { recursive: true, force: true });
  }
}

async function testUntrustedProxyHeaders(sandbox) {
  const instance = await startBackend(sandbox, "untrusted-proxy", {
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "100",
    MCP_TRUSTED_PROXIES: "",
  });
  try {
    const first = await mcpPost(instance.baseUrl, {
      body: initializeBody(20, "missing-auth-a"),
      headers: {
        Forwarded: "for=198.51.100.1",
        "X-Forwarded-For": "203.0.113.1",
      },
    });
    assert.equal(first.status, 401);
    const second = await mcpPost(instance.baseUrl, {
      body: initializeBody(21, "missing-auth-b"),
      headers: {
        Forwarded: "for=198.51.100.2",
        "X-Forwarded-For": "203.0.113.2",
      },
    });
    assert.equal(second.status, 429);
    assert.equal(
      second.headers.get("x-optimike-rate-limit-scope"),
      "loopback-source-ip",
    );
    assert.equal((await second.json()).id, null);
  } finally {
    await stopBackend(instance);
    await rm(instance.logDir, { recursive: true, force: true });
  }
}

async function testPreAuthLimitPrecedesBodyBuffering(sandbox) {
  const instance = await startBackend(sandbox, "preauth-before-body", {
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "100",
    MCP_HTTP_REQUEST_BODY_READ_TIMEOUT_MS: "5000",
  });
  try {
    const allowance = await mcpPost(instance.baseUrl, {
      body: initializeBody(25, "consume-source-allowance"),
    });
    assert.equal(allowance.status, 401);

    const startedAt = Date.now();
    const statuses = await Promise.all(
      Array.from({ length: 4 }, () =>
        headerOnlyPostStatus(instance.baseUrl, 1024 * 1024 - 1),
      ),
    );
    assert.deepEqual(statuses, [429, 429, 429, 429]);
    assert.ok(
      Date.now() - startedAt < 3000,
      "source-limited uploads waited for their unfinished bodies",
    );
  } finally {
    await stopBackend(instance);
    await rm(instance.logDir, { recursive: true, force: true });
  }
}

async function testTrustedProxyHeaders(sandbox) {
  const instance = await startBackend(sandbox, "trusted-proxy", {
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "100",
    MCP_TRUSTED_PROXIES: "127.0.0.1/32",
  });
  try {
    const first = await mcpPost(instance.baseUrl, {
      body: initializeBody(30, "trusted-a"),
      headers: { "X-Forwarded-For": "198.51.100.1" },
    });
    assert.equal(first.status, 401);
    const secondIdentity = await mcpPost(instance.baseUrl, {
      body: initializeBody(31, "trusted-b"),
      headers: { "X-Forwarded-For": "198.51.100.2" },
    });
    assert.equal(secondIdentity.status, 401);
    const repeatedFirst = await mcpPost(instance.baseUrl, {
      body: initializeBody(32, "trusted-a-repeat"),
      headers: { "X-Forwarded-For": "198.51.100.1" },
    });
    assert.equal(repeatedFirst.status, 429);
    assert.equal(
      repeatedFirst.headers.get("x-optimike-rate-limit-scope"),
      "source-ip",
    );
  } finally {
    await stopBackend(instance);
    await rm(instance.logDir, { recursive: true, force: true });
  }
}

async function testTrustedProxyRejectsConflictingHeaderFamilies(sandbox) {
  const instance = await startBackend(sandbox, "trusted-proxy-conflict", {
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "100",
    MCP_TRUSTED_PROXIES: "127.0.0.1/32",
  });
  try {
    const first = await mcpPost(instance.baseUrl, {
      body: initializeBody(40, "trusted-conflict-a"),
      headers: {
        Forwarded: "for=198.51.100.1",
        "X-Forwarded-For": "203.0.113.1",
      },
    });
    assert.equal(first.status, 401);

    const second = await mcpPost(instance.baseUrl, {
      body: initializeBody(41, "trusted-conflict-b"),
      headers: {
        Forwarded: "for=198.51.100.2",
        "X-Forwarded-For": "203.0.113.2",
      },
    });
    assert.equal(
      second.status,
      429,
      "conflicting forwarding header families must share the trusted proxy socket quota",
    );
    assert.equal(
      second.headers.get("x-optimike-rate-limit-scope"),
      "loopback-source-ip",
    );
  } finally {
    await stopBackend(instance);
    await rm(instance.logDir, { recursive: true, force: true });
  }
}

async function testInvalidConfigurationRefused(sandbox) {
  const port = await unusedPort();
  const vaultPath = path.join(sandbox, "invalid-vault");
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: vaultPath,
      OBSIDIAN_ENABLE_CACHE: "false",
      MCP_TRANSPORT_TYPE: "http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_AUTH_MODE: "jwt",
      MCP_AUTH_SECRET_KEY:
        "multiclient-test-secret-must-be-at-least-32-characters",
      MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    // Cold Windows starts can exceed five seconds while parallel CI workers
    // are compiling; the contract is fail-closed exit, not startup speed.
    sleep(15_000).then(() => "timeout"),
  ]);
  if (exitCode === "timeout") child.kill();
  assert.notEqual(exitCode, "timeout");
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /Invalid HTTP protection configuration/u);
}

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-http-multiclient-"),
);

try {
  await testPureProtectionPrimitives();
  await testIdentityIsolation(sandbox);
  await testSessionIdentityBinding(sandbox);
  await testUntrustedProxyHeaders(sandbox);
  await testPreAuthLimitPrecedesBodyBuffering(sandbox);
  await testTrustedProxyHeaders(sandbox);
  await testTrustedProxyRejectsConflictingHeaderFamilies(sandbox);
  await testInvalidConfigurationRefused(sandbox);
  console.log(
    "PASS: verified HTTP identities isolate functional quotas, shared identities share limits, pre-auth rejection does not read bodies and rejects concurrent unfinished near-limit uploads before buffering, untrusted forwarding headers are ignored, conflicting trusted proxy header families fail closed, trusted proxy CIDRs are explicit, sessions are identity-bound, configuration fails closed, and secrets stay out of logs",
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
