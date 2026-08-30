#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const jwtSecret =
  "headless-multiclient-test-secret-must-be-at-least-32-characters";

async function hashDirectory(root) {
  const hash = createHash("sha256");
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(root, candidate).replaceAll("\\", "/");
      hash.update(entry.isDirectory() ? `d:${relative}\n` : `f:${relative}\n`);
      if (entry.isDirectory()) await walk(candidate);
      else hash.update(await readFile(candidate));
    }
  }
  await walk(root);
  return hash.digest("hex");
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
    .setIssuer("https://headless-pilot.optimike.test")
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(jwtSecret));
}

function parseProtocolPayload(text, contentType, expectedId) {
  if (contentType.includes("application/json")) return JSON.parse(text);
  const candidates = [];
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      candidates.push(JSON.parse(data));
    } catch {
      // Ignore keepalive and non-JSON events.
    }
  }
  return (
    candidates.find((candidate) => candidate?.id === expectedId) ??
    candidates[0] ??
    null
  );
}

async function protocolRequest({
  baseUrl,
  token,
  body,
  sessionId,
  requestBody,
}) {
  // This broad multiclient runtime test exercises the complete headless surface.
  // The unqualified /mcp standard default is covered by profile-route tests.
  const response = await fetch(new URL("/mcp/full", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: requestBody ?? JSON.stringify(body),
    ...(requestBody ? { duplex: "half" } : {}),
  });
  const text = await response.text();
  const payload = text
    ? parseProtocolPayload(
        text,
        response.headers.get("content-type") ?? "",
        body?.id,
      )
    : null;
  return { response, payload, text };
}

async function initializeClient(baseUrl, token, name, id) {
  const initialized = await protocolRequest({
    baseUrl,
    token,
    body: {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name, version: "0" },
      },
    },
  });
  assert.equal(initialized.response.status, 200, initialized.text);
  assert.equal(
    initialized.payload?.result?.serverInfo?.name !== undefined,
    true,
  );
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId, `${name} did not receive an MCP session id`);

  const notification = await protocolRequest({
    baseUrl,
    token,
    sessionId,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.ok(
    [200, 202, 204].includes(notification.response.status),
    `${name} initialization notification failed: ${notification.response.status} ${notification.text}`,
  );
  return { token, sessionId, nextId: id + 100 };
}

async function call(client, baseUrl, method, params = {}) {
  const id = client.nextId++;
  const result = await protocolRequest({
    baseUrl,
    token: client.token,
    sessionId: client.sessionId,
    body: { jsonrpc: "2.0", id, method, params },
  });
  assert.equal(
    result.response.status,
    200,
    `${method} failed: ${result.response.status} ${result.text}`,
  );
  assert.equal(
    result.payload?.error,
    undefined,
    `${method} returned a JSON-RPC error: ${result.text}`,
  );
  return result.payload;
}

async function callTool(client, baseUrl, name, args = {}) {
  return call(client, baseUrl, "tools/call", {
    name,
    arguments: args,
  });
}

function toolText(payload) {
  return (
    payload?.result?.content
      ?.map((item) => (item?.type === "text" ? item.text : ""))
      .join("\n") ?? ""
  );
}

function assertToolIncludes(payload, expected, label) {
  const text = toolText(payload);
  assert.ok(
    text.includes(expected),
    `${label} did not include ${JSON.stringify(expected)}: ${text}`,
  );
}

async function createPilotVault(sandbox) {
  const vaultPath = path.join(sandbox, "pilot-vault");
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await mkdir(path.join(vaultPath, "Projects"), { recursive: true });
  await writeFile(
    path.join(vaultPath, "Projects", "Pilot.md"),
    [
      "---",
      "type: pilot",
      "status: active",
      "---",
      "",
      "# Headless multi-client pilot",
      "",
      "Search marker: multiclient-headless-proof.",
      "- [ ] Verify concurrent agents #pilot",
      "- [x] Create a disposable vault",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(vaultPath, "Reference.md"),
    [
      "---",
      "type: reference",
      "---",
      "",
      "A second file proves list and Bases queries.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(vaultPath, "Pilot.base"),
    [
      "properties:",
      "  file.name:",
      "    displayName: Name",
      "  type:",
      "    displayName: Type",
      "filters:",
      "  and:",
      "    - 'file.ext == \"md\"'",
      "views:",
      "  - type: table",
      "    name: Pilot",
      "    order:",
      "      - file.name",
      "      - type",
      "",
    ].join("\n"),
    "utf8",
  );
  return vaultPath;
}

async function waitForEndpoint(url, expectedStatus, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `headless backend exited with ${child.exitCode}: ${child.stderrText}`,
      );
    }
    try {
      const response = await fetch(url);
      lastStatus = response.status;
      if (response.status === expectedStatus) return response;
    } catch {
      // Backend or filesystem cache is still starting.
    }
    await sleep(75);
  }
  throw new Error(
    `timed out waiting for ${url} to return ${expectedStatus}; last status=${lastStatus}`,
  );
}

async function startBackend(sandbox, vaultPath) {
  const port = await unusedPort();
  const logDir = path.join(
    process.cwd(),
    ".tmp",
    `headless-multiclient-${port}`,
  );
  const cachePath = path.join(sandbox, "cache", "shared-cache.sqlite");
  await mkdir(logDir, { recursive: true });
  await mkdir(path.dirname(cachePath), { recursive: true });

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OBSIDIAN_RUNTIME_MODE: "headless-readonly",
      OBSIDIAN_VAULT: vaultPath,
      OBSIDIAN_CACHE_SOURCE: "filesystem",
      OBSIDIAN_SHARED_CACHE_DB_PATH: cachePath,
      OBSIDIAN_ENABLE_CACHE: "true",
      MCP_WRITE_MODE: "readonly",
      SEMANTIC_SEARCH_PREWARM: "false",
      MCP_TRANSPORT_TYPE: "http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_PORT_RETRIES: "0",
      MCP_LOG_LEVEL: "info",
      LOGS_DIR: logDir,
      MCP_AUTH_MODE: "jwt",
      MCP_AUTH_SECRET_KEY: jwtSecret,
      MCP_ALLOWED_ORIGINS: "",
      MCP_HTTP_LOOPBACK_POLICY: "shared",
      MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1000",
      MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "1000",
      MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS: "100",
      MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS: "100",
      MCP_HTTP_MAX_IN_FLIGHT: "8",
      MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY: "4",
      MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT: "4",
      MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY: "2",
      MCP_HTTP_MUTATION_MAX_IN_FLIGHT: "2",
      MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY: "1",
      MCP_HTTP_MAX_QUEUED: "8",
      MCP_HTTP_MAX_QUEUED_PER_IDENTITY: "4",
      MCP_OBSERVABILITY_STALE_AFTER_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderrText = "";
  child.stdoutText = "";
  child.stdout?.on("data", (chunk) => {
    child.stdoutText += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    child.stderrText += String(chunk);
  });

  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const instance = { baseUrl, child, logDir };
  try {
    await waitForEndpoint(new URL("/healthz", baseUrl), 200, child);
    await waitForEndpoint(new URL("/readyz", baseUrl), 200, child);
    return instance;
  } catch (error) {
    await stopBackend(instance);
    throw error;
  }
}

async function stopBackend(instance) {
  if (instance.child.exitCode === null) instance.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => {
      if (instance.child.exitCode !== null) return resolve();
      instance.child.once("exit", resolve);
    }),
    sleep(3000),
  ]);
  if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
  await rm(instance.logDir, { recursive: true, force: true });
}

async function status(baseUrl, token) {
  const response = await fetch(new URL("/statusz", baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) {
    throw new Error(
      `/statusz failed with ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function proveConcurrentClients(baseUrl, clientA, clientB, monitorToken) {
  const before = await status(baseUrl, monitorToken);
  const bodyA = {
    jsonrpc: "2.0",
    id: clientA.nextId++,
    method: "tools/list",
    params: {},
  };
  const bodyB = {
    jsonrpc: "2.0",
    id: clientB.nextId++,
    method: "tools/list",
    params: {},
  };
  const [resultA, resultB] = await Promise.all([
    protocolRequest({
      baseUrl,
      token: clientA.token,
      sessionId: clientA.sessionId,
      body: bodyA,
    }),
    protocolRequest({
      baseUrl,
      token: clientB.token,
      sessionId: clientB.sessionId,
      body: bodyB,
    }),
  ]);
  assert.equal(resultA.response.status, 200, resultA.text);
  assert.equal(resultB.response.status, 200, resultB.text);
  assert.ok(Array.isArray(resultA.payload?.result?.tools));
  assert.ok(Array.isArray(resultB.payload?.result?.tools));
  const after = await status(baseUrl, monitorToken);
  assert.ok(
    after.controls?.admission?.admitted >=
      before.controls?.admission?.admitted + 2,
    `parallel requests from the two authenticated clients were not both admitted: ${JSON.stringify(
      {
        before: before.controls?.admission,
        after: after.controls?.admission,
      },
    )}`,
  );
}

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "optimike-headless-multiclient-pilot-"),
);
let backend;
try {
  const vaultPath = await createPilotVault(sandbox);
  const vaultHashBefore = await hashDirectory(vaultPath);
  backend = await startBackend(sandbox, vaultPath);
  const tokenA = await signToken("headless-client-a");
  const tokenB = await signToken("headless-client-b");
  const monitorToken = await signToken("headless-monitor");
  const [clientA, clientB] = await Promise.all([
    initializeClient(backend.baseUrl, tokenA, "headless-client-a", 1),
    initializeClient(backend.baseUrl, tokenB, "headless-client-b", 2),
  ]);

  const readiness = await fetch(new URL("/readyz", backend.baseUrl));
  assert.equal(readiness.status, 200);
  const readinessBody = await readiness.json();
  assert.equal(readinessBody.ready, true);
  assert.equal(readinessBody.state, "ready");
  assert.equal(readinessBody.provenance.source, "filesystem");
  assert.equal(readinessBody.capabilities.liveObsidianReads, false);
  assert.equal(readinessBody.capabilities.filesystemReads, true);
  assert.equal(readinessBody.capabilities.mutations, false);

  const statusBody = await status(backend.baseUrl, monitorToken);
  assert.equal(statusBody.state, "ready");
  assert.equal(statusBody.runtimeMode, "headless-readonly");
  assert.equal(statusBody.provenance.source, "filesystem");
  assert.equal(statusBody.capabilities.mutations, false);
  const serializedStatus = JSON.stringify(statusBody);
  for (const secret of [tokenA, tokenB, monitorToken, jwtSecret, vaultPath]) {
    assert.equal(
      serializedStatus.includes(secret),
      false,
      "authenticated status leaked a token, secret or physical vault path",
    );
  }

  const listedTools = await call(clientA, backend.baseUrl, "tools/list");
  const toolNames = (listedTools.result?.tools ?? []).map((tool) => tool.name);
  const expectedReadTools = [
    "obsidian_list_notes",
    "obsidian_read_note",
    "obsidian_global_search",
    "list_all_tasks",
    "query_tasks",
    "bases_list",
    "bases_get_schema",
    "bases_query",
    "obsidian_runtime_status",
  ];
  for (const name of expectedReadTools) {
    assert.ok(toolNames.includes(name), `missing read tool ${name}`);
  }
  const listedResources = await call(
    clientA,
    backend.baseUrl,
    "resources/list",
  );
  const routingResource = (listedResources.result?.resources ?? []).find(
    (resource) => resource.uri === "optimike://guides/tool-routing",
  );
  assert.equal(routingResource?.mimeType, "text/markdown");
  const readRoutingResource = await call(
    clientB,
    backend.baseUrl,
    "resources/read",
    { uri: "optimike://guides/tool-routing" },
  );
  const routingText = (readRoutingResource.result?.contents ?? [])
    .map((content) => content.text ?? "")
    .join("\n");
  assert.match(routingText, /obsidian_note_replace_plan/u);
  assert.match(routingText, /obsidian_frontmatter_patch_plan/u);
  assert.match(routingText, /bases_formula_patch_plan/u);
  const forbiddenWriteTools = [
    "obsidian_update_note",
    "obsidian_search_replace",
    "obsidian_delete_note",
    "obsidian_manage_frontmatter",
    "obsidian_manage_tags",
    "obsidian_move_note",
    "obsidian_batch_frontmatter",
    "obsidian_admin_filesystem",
    "obsidian_manage_canvas",
    "bases_create",
    "bases_upsert_config",
    "bases_upsert_rows",
  ];
  for (const name of forbiddenWriteTools) {
    assert.equal(
      toolNames.includes(name),
      false,
      `headless-readonly exposed write tool ${name}`,
    );
  }
  // Operon keeps a stable cross-mode registry so clients can inspect one
  // contract, but its mutation handlers require the live Desktop Bridge. Prove
  // that the headless-readonly pilot cannot use that advertised surface.
  const deniedOperonWrite = await callTool(
    clientA,
    backend.baseUrl,
    "operon_create_task",
    {
      idempotencyKey: "headless-write-denial-proof",
      dryRun: false,
      task: {
        source: "inline",
        description: "This must never be created",
        targetPath: "Projects/Pilot.md",
      },
    },
  );
  assert.equal(deniedOperonWrite.result?.isError, true);
  const operonDenial = JSON.parse(toolText(deniedOperonWrite));
  assert.equal(operonDenial.ok, false);
  assert.equal(operonDenial.error?.code, "SERVICE_UNAVAILABLE");
  assert.equal(
    operonDenial.error?.message,
    "The service is temporarily unavailable. Retry later.",
  );
  assert.match(
    operonDenial.error?.details?.requestId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );

  const runtime = await callTool(
    clientB,
    backend.baseUrl,
    "obsidian_runtime_status",
  );
  assertToolIncludes(runtime, "headless-readonly", "runtime status");
  assertToolIncludes(runtime, "filesystem", "runtime provenance");

  const notes = await callTool(
    clientA,
    backend.baseUrl,
    "obsidian_list_notes",
    { dirPath: "/", responseMode: "compact" },
  );
  assertToolIncludes(notes, "Projects/Pilot.md", "list notes");

  const note = await callTool(clientB, backend.baseUrl, "obsidian_read_note", {
    filePath: "Projects/Pilot.md",
    format: "markdown",
  });
  assertToolIncludes(note, "Headless multi-client pilot", "read note");

  const search = await callTool(
    clientA,
    backend.baseUrl,
    "obsidian_global_search",
    {
      query: "multiclient-headless-proof",
      page: 1,
      pageSize: 10,
      maxMatchesPerFile: 3,
      responseMode: "compact",
    },
  );
  assertToolIncludes(search, "Projects/Pilot.md", "global search");

  const tasks = await callTool(clientB, backend.baseUrl, "list_all_tasks", {
    path: "/",
    responseFormat: "json",
    responseMode: "compact",
  });
  assertToolIncludes(tasks, "Verify concurrent agents", "list tasks");

  const queriedTasks = await callTool(clientA, backend.baseUrl, "query_tasks", {
    path: "/",
    query: "not done",
    responseFormat: "json",
    responseMode: "compact",
  });
  assertToolIncludes(queriedTasks, "Verify concurrent agents", "query tasks");

  const bases = await callTool(clientB, backend.baseUrl, "bases_list");
  assertToolIncludes(bases, "Pilot.base", "Bases list");
  assertToolIncludes(bases, "local-fallback", "Bases list provenance");

  const schema = await callTool(clientA, backend.baseUrl, "bases_get_schema", {
    base_id: "Pilot.base",
  });
  assertToolIncludes(schema, "file.name", "Bases schema");

  const baseQuery = await callTool(clientB, backend.baseUrl, "bases_query", {
    base_id: "Pilot.base",
    filter: { type: "pilot" },
    sort: [{ prop: "file.name", dir: "asc" }],
    limit: 10,
    page: 1,
  });
  assertToolIncludes(baseQuery, "Projects/Pilot.md", "Bases query");

  await proveConcurrentClients(backend.baseUrl, clientA, clientB, monitorToken);

  assert.equal(
    await hashDirectory(vaultPath),
    vaultHashBefore,
    "headless-readonly pilot changed the disposable vault",
  );
  const allLogs = await readAllLogs(backend.logDir);
  const completionLogs = allLogs
    .split(/\r?\n/u)
    .filter((line) => line.includes("HTTP request completed."))
    .join("\n");
  for (const secret of [
    tokenA,
    tokenB,
    monitorToken,
    jwtSecret,
    "Headless multi-client pilot",
  ]) {
    assert.equal(
      allLogs.includes(secret),
      false,
      "server logs leaked a token, authentication secret or note content",
    );
  }
  assert.equal(
    completionLogs.includes(vaultPath),
    false,
    "structured request logs leaked the physical vault path",
  );

  console.log(
    "PASS: a disposable headless-readonly filesystem vault served two distinct authenticated HTTP clients concurrently; the canonical routing resource was listable/readable across sessions; readiness and status reported filesystem provenance without live Obsidian or mutations; notes, search, tasks and Bases reads succeeded; the vault hash stayed unchanged, structured logs disclosed no secrets or content, vault/Bases write tools were absent, and the stable Operon registry denied mutation without its live Desktop Bridge",
  );
} finally {
  if (backend) await stopBackend(backend);
  await rm(sandbox, { recursive: true, force: true });
}
