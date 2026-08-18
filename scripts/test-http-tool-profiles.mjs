import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jwtSecret =
  "tool-profile-http-test-secret-must-be-at-least-32-characters";

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
    } catch {}
  }
  return (
    candidates.find((candidate) => candidate?.id === expectedId) ??
    candidates[0] ??
    null
  );
}

async function protocolRequest({
  baseUrl,
  profilePath,
  token,
  body,
  sessionId,
  method = "POST",
}) {
  const response = await fetch(new URL(profilePath, baseUrl), {
    method,
    headers: {
      Accept: "application/json, text/event-stream",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
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

async function initializeClient(baseUrl, profilePath, token, name, id) {
  const initialized = await protocolRequest({
    baseUrl,
    profilePath,
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
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId, `${name} did not receive an MCP session id`);

  const notification = await protocolRequest({
    baseUrl,
    profilePath,
    token,
    sessionId,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.ok(
    [200, 202, 204].includes(notification.response.status),
    `${name} initialization notification failed: ${notification.response.status} ${notification.text}`,
  );
  return { token, sessionId, profilePath, nextId: id + 100 };
}

async function call(client, baseUrl, method, params = {}) {
  const id = client.nextId++;
  const result = await protocolRequest({
    baseUrl,
    profilePath: client.profilePath,
    token: client.token,
    sessionId: client.sessionId,
    body: { jsonrpc: "2.0", id, method, params },
  });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.payload?.error, undefined, result.text);
  return result.payload;
}

async function createVault() {
  const vault = await mkdtemp(
    path.join(os.tmpdir(), "optimike-http-profiles-"),
  );
  await mkdir(path.join(vault, ".obsidian", "optimike-mcp"), {
    recursive: true,
  });
  await writeFile(
    path.join(vault, "Root.md"),
    "# HTTP profile smoke\n",
    "utf8",
  );
  return vault;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `backend exited early with ${child.exitCode}: ${child.stderrText}`,
      );
    }
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`backend did not become healthy: ${child.stderrText}`);
}

function toolNames(payload) {
  return (payload?.result?.tools ?? [])
    .map((tool) => tool.name)
    .sort((a, b) => a.localeCompare(b));
}

const vault = await createVault();
const port = await unusedPort();
const logDir = path.join(process.cwd(), ".tmp", `http-tool-profiles-${port}`);
await mkdir(logDir, { recursive: true });
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    OBSIDIAN_RUNTIME_MODE: "headless-readonly",
    OBSIDIAN_VAULT: vault,
    OBSIDIAN_CACHE_SOURCE: "filesystem",
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(
      vault,
      ".obsidian",
      "optimike-mcp",
      "shared-cache.sqlite",
    ),
    OBSIDIAN_ENABLE_CACHE: "true",
    SEMANTIC_SEARCH_PREWARM: "false",
    MCP_WRITE_MODE: "readonly",
    MCP_TRANSPORT_TYPE: "http",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_LOG_LEVEL: "error",
    LOGS_DIR: logDir,
    MCP_AUTH_MODE: "jwt",
    MCP_AUTH_SECRET_KEY: jwtSecret,
    MCP_ALLOWED_ORIGINS: "",
    MCP_HTTP_LOOPBACK_POLICY: "shared",
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1000",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "1000",
    // A process-wide env profile must not change immutable HTTP profile routes.
    MCP_TOOL_PROFILE: "tasks",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderrText = "";
child.stderr?.on("data", (chunk) => {
  child.stderrText += String(chunk);
});

try {
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  await waitForHealth(baseUrl, child);

  const [standardToken, tasksToken, fullToken, legacyToken] = await Promise.all(
    [
      signToken("profile-standard"),
      signToken("profile-tasks"),
      signToken("profile-full"),
      signToken("profile-legacy"),
    ],
  );

  const [standard, tasks, full, legacy] = await Promise.all([
    initializeClient(baseUrl, "/mcp/standard", standardToken, "standard", 1),
    initializeClient(baseUrl, "/mcp/tasks", tasksToken, "tasks", 2),
    initializeClient(baseUrl, "/mcp/full", fullToken, "full", 3),
    initializeClient(baseUrl, "/mcp", legacyToken, "legacy", 4),
  ]);

  const [standardList, tasksList, fullList, legacyList] = await Promise.all([
    call(standard, baseUrl, "tools/list"),
    call(tasks, baseUrl, "tools/list"),
    call(full, baseUrl, "tools/list"),
    call(legacy, baseUrl, "tools/list"),
  ]);

  const standardNames = toolNames(standardList);
  const tasksNames = toolNames(tasksList);
  const fullNames = toolNames(fullList);
  const legacyNames = toolNames(legacyList);

  assert.equal(standardNames.length, 9);
  assert.equal(tasksNames.length, 14);
  assert.equal(fullNames.length, 46);
  assert.deepEqual(
    legacyNames,
    standardNames,
    "/mcp must use the 3.0 standard default",
  );

  for (const modern of [standardNames, tasksNames]) {
    assert.ok(modern.includes("smart_semantic_search"));
    assert.ok(!modern.includes("smart_search"));
    assert.ok(!modern.includes("smart-search"));
  }
  assert.ok(fullNames.includes("smart_semantic_search"));
  assert.ok(!fullNames.includes("smart_search"));
  assert.ok(!fullNames.includes("smart-search"));

  for (const snapshotSafe of [
    "operon_status",
    "operon_get_configuration",
    "operon_list_tasks",
    "operon_get_task",
    "operon_query_tasks",
    "operon_validate",
  ]) {
    assert.ok(
      tasksNames.includes(snapshotSafe),
      `headless tasks lost ${snapshotSafe}`,
    );
  }
  for (const liveOnly of [
    "operon_query_saved_filter",
    "operon_get_diagnostics",
    "operon_find_tasks",
    "operon_resolve_task",
    "operon_get_relationships",
    "operon_build_context",
    "operon_get_timer_state",
    "operon_create_task",
    "operon_update_task",
    "operon_transition_task",
    "operon_list_pending_recoveries",
    "operon_recover_mutation",
  ]) {
    assert.ok(
      !tasksNames.includes(liveOnly),
      `headless tasks exposed ${liveOnly}`,
    );
  }

  const mismatchPost = await protocolRequest({
    baseUrl,
    profilePath: "/mcp/full",
    token: standard.token,
    sessionId: standard.sessionId,
    body: {
      jsonrpc: "2.0",
      id: 999,
      method: "tools/list",
      params: {},
    },
  });
  assert.equal(mismatchPost.response.status, 404, mismatchPost.text);
  assert.match(mismatchPost.text, /Invalid or expired session ID/);

  const mismatchDelete = await protocolRequest({
    baseUrl,
    profilePath: "/mcp/full",
    token: standard.token,
    sessionId: standard.sessionId,
    method: "DELETE",
  });
  assert.equal(mismatchDelete.response.status, 404, mismatchDelete.text);
  assert.match(mismatchDelete.text, /Invalid or expired session ID/);

  const sameSessionStillWorks = await call(standard, baseUrl, "tools/list");
  assert.equal(toolNames(sameSessionStillWorks).length, 9);

  const unknown = await fetch(new URL("/mcp/nope", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${standardToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1000,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "unknown", version: "0" },
      },
    }),
  });
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /unknown_tool_profile/);

  console.log(
    "PASS: HTTP profile endpoints coexist, /mcp defaults to standard, /mcp/full stays explicit, removed semantic aliases stay absent, and sessions cannot cross profile routes",
  );
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
    }),
    sleep(5_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(logDir, { recursive: true, force: true });
  await rm(vault, { recursive: true, force: true });
}
