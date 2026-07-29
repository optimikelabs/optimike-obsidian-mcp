#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
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
const operationSecret = "OPERATION-SECRET-MUST-NOT-ENTER-LOGS";

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

async function startFakeObsidianRest() {
  const server = createHttpServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          service: "Obsidian Local REST API",
          authenticated: true,
          versions: { obsidian: "observability", self: "observability" },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
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

async function startBackend(
  sandbox,
  name,
  runtimeMode,
  {
    enableCache = runtimeMode.startsWith("headless"),
    obsidianBaseUrl = "http://127.0.0.1:1",
    writeMode = "readonly",
    observabilityStaleAfterMs = 60_000,
  } = {},
) {
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

  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    OBSIDIAN_RUNTIME_MODE: runtimeMode,
    OBSIDIAN_VAULT: vaultPath,
    OBSIDIAN_BASE_URL: obsidianBaseUrl,
    OBSIDIAN_API_KEY: localRestSecret,
    OBSIDIAN_STARTUP_BLOCKING: "false",
    OBSIDIAN_CACHE_SOURCE: runtimeMode === "live" ? "rest" : "filesystem",
    OBSIDIAN_ENABLE_CACHE: String(enableCache),
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
    MCP_OBSERVABILITY_STALE_AFTER_MS: String(observabilityStaleAfterMs),
  };
  if (writeMode === null) delete childEnv.MCP_WRITE_MODE;
  else childEnv.MCP_WRITE_MODE = writeMode;

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: childEnv,
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

async function waitForReadiness(baseUrl, expectedStatus) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/readyz", baseUrl));
    if (response.status === expectedStatus) return response;
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for /readyz to return ${expectedStatus} at ${baseUrl}`,
  );
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

    const readiness = await waitForReadiness(headless.baseUrl, 200);
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

    const maliciousOperation = await fetch(new URL("/mcp", headless.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: `${operationSecret}\ncontrol` },
      }),
    });
    await maliciousOperation.text();

    const mappedError = await fetch(new URL("/mcp", headless.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": "expired-observability-test-session",
        "X-Correlation-Id": "mapped-error-404",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/list",
      }),
    });
    assert.equal(mappedError.status, 404);
    const mappedErrorBody = await mappedError.json();
    assert.equal(mappedErrorBody.id, 8);

    const rejectedOrigin = await fetch(new URL("/healthz", headless.baseUrl), {
      headers: {
        Origin: "https://blocked-origin.example",
        "X-Correlation-Id": "rejected-origin-403",
      },
    });
    assert.equal(rejectedOrigin.status, 403);

    await sleep(150);
    const logs = await readAllLogs(headless.logDir);
    const completionLogs = logs
      .split(/\r?\n/u)
      .filter((line) => line.includes("HTTP request completed."))
      .join("\n");
    assert.ok(completionLogs.includes("incident-42:retry.1"));
    assert.ok(
      completionLogs.includes("rejected-origin-403"),
      "origin rejection must still emit its completion event",
    );
    assert.equal(completionLogs.includes(token), false);
    assert.equal(completionLogs.includes(secret), false);
    assert.equal(completionLogs.includes(localRestSecret), false);
    assert.equal(completionLogs.includes(documentSecret), false);
    assert.equal(completionLogs.includes(operationSecret), false);
    assert.equal(completionLogs.includes(headless.vaultPath), false);
    assert.equal(
      completionLogs.includes("invalid incident with spaces"),
      false,
    );
    const mappedErrorLog = completionLogs
      .split(/\r?\n/u)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry?.correlationId === "mapped-error-404");
    assert.ok(mappedErrorLog, "mapped error must emit a completion event");
    assert.equal(mappedErrorLog.httpStatus, 404);
    assert.equal(mappedErrorLog.result, "client_error");
  } finally {
    await stopBackend(headless);
  }

  const headlessWithoutCache = await startBackend(
    sandbox,
    "headless-without-cache",
    "headless-readonly",
    { enableCache: false },
  );
  try {
    const readiness = await waitForReadiness(headlessWithoutCache.baseUrl, 503);
    const body = await readiness.json();
    assert.equal(body.state, "critical");
    assert.equal(body.ready, false);
    assert.equal(body.capabilities.filesystemReads, false);
    assert.ok(body.reasons.includes("headless_cache_unavailable"));
  } finally {
    await stopBackend(headlessWithoutCache);
  }

  const hybridWithoutSource = await startBackend(
    sandbox,
    "hybrid-without-source",
    "hybrid",
    { enableCache: false },
  );
  try {
    const readiness = await waitForReadiness(hybridWithoutSource.baseUrl, 503);
    const body = await readiness.json();
    assert.equal(body.state, "critical");
    assert.equal(body.ready, false);
  } finally {
    await stopBackend(hybridWithoutSource);
  }

  const liveWithoutProof = await startBackend(sandbox, "live", "live", {
    enableCache: false,
  });
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

  const fakeRest = await startFakeObsidianRest();
  const liveWithoutCache = await startBackend(
    sandbox,
    "live-without-cache",
    "live",
    {
      enableCache: false,
      obsidianBaseUrl: fakeRest.baseUrl,
      writeMode: null,
      observabilityStaleAfterMs: 1000,
    },
  );
  try {
    const readiness = await waitForReadiness(liveWithoutCache.baseUrl, 200);
    const body = await readiness.json();
    assert.equal(body.state, "ready");
    assert.equal(body.provenance.source, "live-obsidian");
    assert.equal(body.capabilities.liveObsidianReads, true);
    assert.equal(
      body.capabilities.mutations,
      true,
      "validated live default write mode is full",
    );
    assert.equal(body.capabilities.cacheReads, false);
    await sleep(1600);
    const stillReady = await fetch(
      new URL("/readyz", liveWithoutCache.baseUrl),
    );
    assert.equal(
      stillReady.status,
      200,
      "probe cadence must keep a healthy live API inside its freshness window",
    );
  } finally {
    await stopBackend(liveWithoutCache);
    await fakeRest.close();
  }

  console.log(
    "PASS: readyz requires a usable source for headless and hybrid profiles, a verified live API works without optional cache using the validated write mode, and streamed completion logs sanitize caller-controlled operations and rejected origins",
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
