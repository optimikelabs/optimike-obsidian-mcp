#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = "observability-test-secret-at-least-32-characters-long";
const localRestSecret = "observability-local-rest-test-key";
const documentSecret = "DOCUMENT-CONTENT-MUST-NOT-ENTER-REQUEST-LOGS";

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
    .setIssuer("https://observability.optimike.test")
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

async function readAllLogs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await readAllLogs(candidate));
    else chunks.push(await readFile(candidate, "utf8").catch(() => ""));
  }
  return chunks.join("\n");
}

async function startBackend(sandbox, name, runtimeMode) {
  const port = await unusedPort();
  const vaultPath = path.join(sandbox, `${name}-vault`);
  const logDir = path.join(
    process.cwd(),
    ".tmp",
    `http-observability-${name}-${port}`,
  );
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(vaultPath, "Smoke.md"),
    `# Smoke\n\n${documentSecret}\n`,
    "utf8",
  );

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OBSIDIAN_RUNTIME_MODE: runtimeMode,
      OBSIDIAN_VAULT: vaultPath,
      OBSIDIAN_BASE_URL: "http://127.0.0.1:1",
      OBSIDIAN_API_KEY: localRestSecret,
      OBSIDIAN_STARTUP_BLOCKING: "false",
      OBSIDIAN_CACHE_SOURCE: runtimeMode === "live" ? "rest" : "filesystem",
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
      MCP_OBSERVABILITY_STALE_AFTER_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `backend exited with ${child.exitCode}: stdout=${stdout} stderr=${stderr}`,
      );
    }
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) return { baseUrl, child, logDir, vaultPath };
    } catch {
      // Starting.
    }
    await sleep(50);
  }
  child.kill();
  throw new Error(`timed out waiting for ${baseUrl}`);
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

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-http-observability-"),
);
try {
  const headless = await startBackend(sandbox, "headless", "headless-readonly");
  try {
    const liveness = await fetch(new URL("/healthz", headless.baseUrl));
    assert.equal(liveness.status, 200);
    const livenessBody = await liveness.json();
    assert.equal(livenessBody.ok, true);
    assert.equal(livenessBody.status, "healthy");
    assert.equal(livenessBody.state, "live");

    const readiness = await fetch(new URL("/readyz", headless.baseUrl));
    assert.equal(readiness.status, 200);
    const readinessBody = await readiness.json();
    assert.equal(readinessBody.ready, true);
    assert.equal(readinessBody.state, "ready");
    assert.equal(readinessBody.provenance.source, "filesystem");
    assert.equal(readinessBody.capabilities.liveObsidianReads, false);
    assert.equal(readinessBody.capabilities.mutations, false);

    const unauthenticated = await fetch(new URL("/statusz", headless.baseUrl));
    assert.equal(unauthenticated.status, 401);

    const token = await signToken("monitor-client");
    const status = await fetch(new URL("/statusz", headless.baseUrl), {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Correlation-Id": "incident-42:retry.1",
        "X-Incident-Id": "invalid incident with spaces",
      },
    });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.state, "ready");
    assert.ok(statusBody.controls.sessions);
    assert.ok(statusBody.controls.admission);
    assert.ok(statusBody.controls.rateLimits);
    const serializedStatus = JSON.stringify(statusBody);
    assert.equal(serializedStatus.includes(token), false);
    assert.equal(serializedStatus.includes(headless.vaultPath), false);
    assert.equal(serializedStatus.includes(documentSecret), false);

    await sleep(150);
    const logs = await readAllLogs(headless.logDir);
    assert.ok(logs.includes("incident-42:retry.1"));
    assert.equal(logs.includes(token), false);
    assert.equal(logs.includes(secret), false);
    assert.equal(logs.includes(localRestSecret), false);
    assert.equal(logs.includes(documentSecret), false);
    assert.equal(logs.includes(headless.vaultPath), false);
    assert.equal(logs.includes("invalid incident with spaces"), false);
  } finally {
    await stopBackend(headless);
  }

  const liveWithoutProof = await startBackend(sandbox, "live", "live");
  try {
    const liveness = await fetch(new URL("/healthz", liveWithoutProof.baseUrl));
    assert.equal(liveness.status, 200);
    const readiness = await fetch(new URL("/readyz", liveWithoutProof.baseUrl));
    assert.equal(readiness.status, 503);
    const body = await readiness.json();
    assert.equal(body.state, "critical");
    assert.equal(body.ready, false);
    assert.equal(body.provenance.source, "unknown");
  } finally {
    await stopBackend(liveWithoutProof);
  }

  console.log(
    "PASS: healthz remains backward-compatible liveness, readyz distinguishes ready and critical profiles, statusz requires authentication and exposes sanitized aggregate controls, structured logs carry bounded correlation without bearer tokens, vault paths or document content",
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
