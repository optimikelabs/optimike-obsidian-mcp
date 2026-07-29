#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const jwtSecret = "gateway-e2e-secret-must-be-at-least-thirty-two-characters";
const fixtureRootId = "gateway-fixture";
const fixtureRelativePath = "artifact.txt";
const fixtureContent = "Optimike gateway handoff fixture\n";
const physicalPathSentinel = "PHYSICAL-GATEWAY-FIXTURE-PATH";

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
  return new SignJWT({
    cid: clientId,
    scp: ["vault:read", "external:read"],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://gateway-e2e.optimike.test")
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(jwtSecret));
}

function recursivelyRewriteRoot(value, rootPath) {
  if (Array.isArray(value)) {
    return value.map((item) => recursivelyRewriteRoot(item, rootPath));
  }
  if (!value || typeof value !== "object") return value;

  const copy = {};
  const keys = Object.keys(value);
  const lower = keys.map((key) => key.toLowerCase());
  const looksLikeRoot = lower.some((key) =>
    ["path", "rootpath", "basepath", "directory"].includes(key),
  );
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      looksLikeRoot &&
      ["path", "rootpath", "basepath", "directory"].includes(normalized)
    ) {
      copy[key] = rootPath;
    } else if (
      looksLikeRoot &&
      ["id", "rootid", "name", "slug"].includes(normalized)
    ) {
      copy[key] = fixtureRootId;
    } else if (
      looksLikeRoot &&
      ["displayname", "label", "description"].includes(normalized)
    ) {
      copy[key] = "Gateway fixture";
    } else if (
      looksLikeRoot &&
      ["permissions", "operations", "allowedoperations"].includes(normalized) &&
      Array.isArray(item)
    ) {
      copy[key] = item.filter((entry) =>
        /read|handoff|download/i.test(String(entry)),
      );
      if (copy[key].length === 0) copy[key] = ["read"];
    } else if (looksLikeRoot && normalized.includes("write")) {
      copy[key] = false;
    } else {
      copy[key] = recursivelyRewriteRoot(item, rootPath);
    }
  }
  return copy;
}

function containsExactString(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsExactString(item, expected));
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) =>
    containsExactString(item, expected),
  );
}

async function createExternalRootConfig(sandbox, externalRoot) {
  const examplePath = path.join(
    projectRoot,
    "docs",
    "external-roots.example.json",
  );
  const parsed = JSON.parse(await readFile(examplePath, "utf8"));
  const rewritten = recursivelyRewriteRoot(parsed, externalRoot);
  const serialized = JSON.stringify(rewritten, null, 2);
  assert.ok(
    containsExactString(rewritten, externalRoot),
    "example root path was not rewritten",
  );
  assert.ok(
    containsExactString(rewritten, fixtureRootId),
    "example root id was not rewritten",
  );
  const configPath = path.join(sandbox, "external-roots.json");
  await writeFile(configPath, serialized + "\n", "utf8");
  return configPath;
}

async function discoverHandoffTtlEnv() {
  const directory = path.join(projectRoot, "src", "services");
  const matches = new Set();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (/\.(?:ts|js)$/u.test(entry.name)) {
        const text = await readFile(candidate, "utf8");
        for (const match of text.matchAll(
          /MCP_[A-Z0-9_]*HANDOFF[A-Z0-9_]*TTL[A-Z0-9_]*/gu,
        )) {
          matches.add(match[0]);
        }
        for (const match of text.matchAll(
          /MCP_[A-Z0-9_]*TICKET[A-Z0-9_]*TTL[A-Z0-9_]*/gu,
        )) {
          matches.add(match[0]);
        }
      }
    }
  }
  await walk(directory);
  return [...matches];
}

async function waitForUrl(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(
        `process exited with ${child.exitCode}: ${child.stderrText ?? ""}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
    } catch {
      // Still starting.
    }
    await sleep(75);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function gatewayCandidates(gatewayPort, backendPort) {
  const socket = `127.0.0.1:${backendPort}`;
  const host = `http://127.0.0.1:${backendPort}`;
  return [
    {
      name: "v1.4-transparent-http",
      yaml: `# yaml-language-server: $schema=https://agentgateway.dev/schema/config\ngateways:\n  optimike:\n    port: ${gatewayPort}\n    protocol: HTTP\nroutes:\n- name: optimike-all\n  gateways: [optimike]\n  matches:\n  - path:\n      pathPrefix: /\n  backends:\n  - host: ${socket}\n`,
    },
    {
      name: "minimal-host",
      yaml: `binds:\n- port: ${gatewayPort}\n  listeners:\n  - routes:\n    - backends:\n      - host: ${host}\n`,
    },
    {
      name: "path-prefix-host",
      yaml: `binds:\n- port: ${gatewayPort}\n  listeners:\n  - routes:\n    - matches:\n      - path:\n          pathPrefix: /\n      backends:\n      - host: ${host}\n`,
    },
    {
      name: "http-protocol-host",
      yaml: `binds:\n- port: ${gatewayPort}\n  listeners:\n  - protocol: HTTP\n    routes:\n    - backends:\n      - host: ${host}\n`,
    },
    {
      name: "named-route-host",
      yaml: `binds:\n- port: ${gatewayPort}\n  listeners:\n  - name: optimike-http\n    routes:\n    - name: optimike-all\n      backends:\n      - host: ${host}\n`,
    },
  ];
}

function gatewayArgumentCandidates(binary, configPath) {
  return [
    [binary, "-f", configPath],
    [binary, "--file", configPath],
    [binary, "--config", configPath],
    [binary, "--config-file", configPath],
    [binary, configPath],
  ];
}

async function startGateway(binary, sandbox, gatewayPort, backendPort) {
  const attempts = [];
  for (const candidate of gatewayCandidates(gatewayPort, backendPort)) {
    const configPath = path.join(
      sandbox,
      `agentgateway-${candidate.name}.yaml`,
    );
    await writeFile(configPath, candidate.yaml, "utf8");
    for (const [command, ...args] of gatewayArgumentCandidates(
      binary,
      configPath,
    )) {
      const child = spawn(command, args, {
        cwd: sandbox,
        env: { ...process.env, RUST_LOG: "info" },
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
      let accepted = false;
      try {
        const probe = await waitForUrl(
          new URL(`http://127.0.0.1:${gatewayPort}/healthz`),
          child,
          6000,
        );
        if (probe.status < 500) {
          accepted = true;
          return { child, configPath, candidate: candidate.name, args };
        }
      } catch (error) {
        attempts.push({
          candidate: candidate.name,
          args,
          error: error instanceof Error ? error.message : String(error),
          stderr: child.stderrText.slice(-3000),
        });
      } finally {
        if (!accepted && child.exitCode === null) await stopChild(child);
      }
    }
  }
  throw new Error(
    `agentgateway did not accept a transparent HTTP configuration: ${JSON.stringify(attempts)}`,
  );
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
      // Ignore keepalive/non-JSON events.
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
  headers = {},
}) {
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    payload = parseProtocolPayload(
      text,
      response.headers.get("content-type") ?? "",
      body.id,
    );
  }
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
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId, "gateway did not preserve Mcp-Session-Id");
  const notification = await protocolRequest({
    baseUrl,
    token,
    sessionId,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.ok(
    [200, 202, 204].includes(notification.response.status),
    `initialized notification failed: ${notification.response.status} ${notification.text}`,
  );
  return { token, sessionId, nextId: id + 100 };
}

async function call(client, baseUrl, method, params = {}) {
  const id = client.nextId++;
  return protocolRequest({
    baseUrl,
    token: client.token,
    sessionId: client.sessionId,
    body: { jsonrpc: "2.0", id, method, params },
  });
}

function toolList(payload) {
  return payload?.result?.tools ?? payload?.tools ?? [];
}

function chooseEnum(schema, fallback) {
  return Array.isArray(schema?.enum) && schema.enum.length > 0
    ? schema.enum[0]
    : fallback;
}

function generatedArguments(schema, context, propertyName = "") {
  if (!schema || typeof schema !== "object") return undefined;
  const normalized = propertyName.toLowerCase();
  if (normalized.includes("root") && normalized.includes("id")) {
    return fixtureRootId;
  }
  if (normalized === "root" && (schema.type === "string" || !schema.type)) {
    return fixtureRootId;
  }
  if (normalized.includes("relative") && normalized.includes("path")) {
    return fixtureRelativePath;
  }
  if (
    normalized.includes("path") ||
    normalized.includes("file") ||
    normalized.includes("note")
  ) {
    return context.notePath;
  }
  if (normalized.includes("query")) return "Gateway";
  if (normalized.includes("content") || normalized.includes("body")) {
    return context.content;
  }
  if (normalized.includes("idempotency")) return context.idempotencyKey;
  if (normalized.includes("expected") && normalized.includes("hash")) {
    return context.expectedHash ?? "";
  }
  if (normalized.includes("mode") || normalized.includes("operation")) {
    return chooseEnum(schema, "overwrite");
  }
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
  if (schema.type === "object" || schema.properties) {
    const result = {};
    const required = new Set(schema.required ?? []);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (
        required.has(name) ||
        /root|path|file|content|idempotency|expected|mode|operation/i.test(name)
      ) {
        const value = generatedArguments(child, context, name);
        if (value !== undefined) result[name] = value;
      }
    }
    return result;
  }
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "string") return "fixture";
  return undefined;
}

function recursivelyParseJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function findNamedValue(value, matcher, seen = new Set()) {
  value = recursivelyParseJson(value);
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNamedValue(item, matcher, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (matcher(key, item)) return item;
    const found = findNamedValue(item, matcher, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function normalizeToolResult(payload) {
  const result = payload?.result ?? payload;
  const content = result?.content;
  if (Array.isArray(content)) {
    return {
      ...result,
      decodedContent: content.map((item) =>
        item?.type === "text" ? recursivelyParseJson(item.text) : item,
      ),
    };
  }
  return result;
}

async function callTool(client, baseUrl, name, argumentsValue) {
  return call(client, baseUrl, "tools/call", {
    name,
    arguments: argumentsValue,
  });
}

async function readRetryProof(client, baseUrl, tools) {
  const tool =
    tools.find((candidate) => candidate.name === "obsidian_read_note") ??
    tools.find((candidate) => /read.*note|note.*read/i.test(candidate.name));
  assert.ok(tool, "read-note tool is unavailable through the gateway");
  const args = generatedArguments(tool.inputSchema, {
    notePath: "Gateway.md",
    content: "",
    idempotencyKey: "gateway-read",
  });
  const first = await callTool(client, baseUrl, tool.name, args);
  const second = await callTool(client, baseUrl, tool.name, args);
  assert.equal(first.response.status, 200, first.text);
  assert.equal(second.response.status, 200, second.text);
  assert.deepEqual(
    normalizeToolResult(first.payload),
    normalizeToolResult(second.payload),
    "a retried read changed its result",
  );
  return { tool: tool.name, args };
}

async function externalHandoffProof({
  issuer,
  other,
  baseUrl,
  tools,
  externalRoot,
  ttlWaitMs,
}) {
  const tool =
    tools.find((candidate) => candidate.name === "external_handoff") ??
    tools.find((candidate) => /external.*handoff/i.test(candidate.name));
  assert.ok(tool, "external_handoff is unavailable through the gateway");
  const generated = generatedArguments(tool.inputSchema, {
    notePath: fixtureRelativePath,
    content: "",
    idempotencyKey: "gateway-handoff",
  });
  const candidates = [
    generated,
    { rootId: fixtureRootId, relativePath: fixtureRelativePath },
    { root: fixtureRootId, relativePath: fixtureRelativePath },
    { rootId: fixtureRootId, path: fixtureRelativePath },
    { root: fixtureRootId, path: fixtureRelativePath },
  ].filter(Boolean);

  async function issueTicket(client) {
    const errors = [];
    for (const args of candidates) {
      const result = await callTool(client, baseUrl, tool.name, args);
      const normalized = normalizeToolResult(result.payload);
      const ticket = findNamedValue(
        normalized,
        (key, item) =>
          /ticket/i.test(key) &&
          !/header|name/i.test(key) &&
          typeof item === "string" &&
          item.length >= 16,
      );
      if (result.response.status === 200 && typeof ticket === "string") {
        assert.equal(result.text.includes(externalRoot), false);
        assert.equal(result.text.includes(physicalPathSentinel), false);
        return { ticket, args, raw: result };
      }
      errors.push({
        args,
        status: result.response.status,
        text: result.text.slice(0, 1000),
      });
    }
    throw new Error(
      `could not issue external handoff ticket: ${JSON.stringify(errors)}`,
    );
  }

  async function download(token, ticket) {
    return fetch(new URL("/external-handoff", baseUrl), {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-External-Handoff-Ticket": ticket,
      },
    });
  }

  const first = await issueTicket(issuer);
  const wrongIdentity = await download(other.token, first.ticket);
  assert.equal(wrongIdentity.status, 404, "ticket crossed verified identities");
  const delivered = await download(issuer.token, first.ticket);
  assert.equal(delivered.status, 200);
  assert.equal(await delivered.text(), fixtureContent);
  const headerDump = JSON.stringify([...delivered.headers.entries()]);
  assert.equal(headerDump.includes(externalRoot), false);
  assert.equal(headerDump.includes(physicalPathSentinel), false);
  const replay = await download(issuer.token, first.ticket);
  assert.equal(replay.status, 404, "one-use ticket replay was accepted");

  const expiring = await issueTicket(issuer);
  await sleep(ttlWaitMs);
  const expired = await download(issuer.token, expiring.ticket);
  assert.equal(expired.status, 404, "expired ticket was accepted");
  return { tool: tool.name, args: first.args };
}

async function streamCancellationProof(client, baseUrl) {
  const controller = new AbortController();
  const response = await Promise.race([
    fetch(new URL("/mcp", baseUrl), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${client.token}`,
        "Mcp-Session-Id": client.sessionId,
      },
      signal: controller.signal,
    }),
    sleep(4000).then(() => {
      throw new Error("gateway did not establish an MCP event stream");
    }),
  ]);
  assert.equal(response.status, 200);
  controller.abort();
  await response.body?.cancel().catch(() => undefined);
  const ping = await call(client, baseUrl, "ping");
  assert.equal(ping.response.status, 200, ping.text);
}

async function quotaIsolationProof(baseUrl) {
  const tokenA = await signToken("quota-a");
  const tokenB = await signToken("quota-b");
  const a = await initializeClient(baseUrl, tokenA, "quota-a", 700);
  const b = await initializeClient(baseUrl, tokenB, "quota-b", 800);
  let limited;
  for (let index = 0; index < 80; index += 1) {
    const result = await call(a, baseUrl, "ping");
    if (result.response.status === 429) {
      limited = result;
      break;
    }
    assert.equal(result.response.status, 200, result.text);
  }
  assert.ok(limited, "configured identity quota was never reached");
  assert.ok(limited.response.headers.get("retry-after"));
  const isolated = await call(b, baseUrl, "ping");
  assert.equal(
    isolated.response.status,
    200,
    "a second verified identity behind the same gateway inherited the first quota",
  );
  return { limitedStatus: limited.response.status };
}

async function sameSessionIdentityProof(owner, intruder, baseUrl) {
  const result = await protocolRequest({
    baseUrl,
    token: intruder.token,
    sessionId: owner.sessionId,
    body: { jsonrpc: "2.0", id: 900, method: "ping" },
  });
  assert.equal(result.response.status, 404);
}

async function concurrentProof(a, b, baseUrl) {
  const calls = Array.from({ length: 24 }, (_, index) =>
    call(index % 2 === 0 ? a : b, baseUrl, "ping"),
  );
  const results = await Promise.all(calls);
  for (const result of results) {
    assert.ok(
      [200, 429, 503].includes(result.response.status),
      `unexpected concurrent status ${result.response.status}: ${result.text}`,
    );
    if (result.response.status === 429 || result.response.status === 503) {
      assert.ok(result.response.headers.get("retry-after"));
    }
  }
}

async function mutationReplayHarnessStatus(client, baseUrl, tools) {
  const tool = tools.find(
    (candidate) => candidate.name === "obsidian_update_note",
  );
  if (!tool) return { status: "tool-unavailable" };
  const args = generatedArguments(tool.inputSchema, {
    notePath: "Gateway.md",
    content: "# Gateway\n\nmutation replay fixture\n",
    idempotencyKey: "gateway-fixed-mutation-key",
  });
  const result = await callTool(client, baseUrl, tool.name, args);
  const normalized = JSON.stringify(normalizeToolResult(result.payload));
  if (
    result.response.status !== 200 ||
    /read.?only|live obsidian|required|mutation.*disabled|forbidden/i.test(
      normalized,
    )
  ) {
    return {
      status: "blocked-by-readonly-headless-profile",
      tool: tool.name,
      reusableArguments: args,
    };
  }
  const replay = await callTool(client, baseUrl, tool.name, args);
  return {
    status: "executed",
    tool: tool.name,
    firstStatus: result.response.status,
    replayStatus: replay.response.status,
    sameResult:
      JSON.stringify(normalizeToolResult(result.payload)) ===
      JSON.stringify(normalizeToolResult(replay.payload)),
  };
}

async function main() {
  const gatewayBinary = process.env.AGENTGATEWAY_BIN;
  assert.ok(gatewayBinary, "AGENTGATEWAY_BIN is required");
  const sandbox = await mkdtemp(
    path.join(os.tmpdir(), "optimike-agentgateway-"),
  );
  const vaultPath = path.join(sandbox, "vault");
  const externalRoot = path.join(sandbox, physicalPathSentinel);
  const runArtifactsDir = path.join(
    projectRoot,
    ".tmp",
    path.basename(sandbox),
  );
  const logDir = path.join(runArtifactsDir, "logs");
  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(vaultPath, "Gateway.md"),
    "# Gateway\n\nRead retry fixture.\n",
    "utf8",
  );
  await writeFile(
    path.join(externalRoot, fixtureRelativePath),
    fixtureContent,
    "utf8",
  );
  const externalRootsFile = await createExternalRootConfig(
    sandbox,
    externalRoot,
  );
  const ttlVariables = await discoverHandoffTtlEnv();
  const backendPort = await unusedPort();
  const gatewayPort = await unusedPort();
  const ttlMs = 1000;
  const backendEnv = {
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
    MCP_HTTP_PORT: String(backendPort),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_LOG_LEVEL: "info",
    LOGS_DIR: logDir,
    MCP_AUTH_MODE: "jwt",
    MCP_AUTH_SECRET_KEY: jwtSecret,
    MCP_ALLOWED_ORIGINS: "",
    MCP_EXTERNAL_ROOTS_FILE: externalRootsFile,
    MCP_HTTP_HANDOFF_ENABLED: "true",
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "1000",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "40",
    MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS: "1000",
    MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS: "1000",
    MCP_HTTP_MAX_IN_FLIGHT: "2",
    MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY: "1",
    MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT: "1",
    MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY: "1",
    MCP_HTTP_MUTATION_MAX_IN_FLIGHT: "1",
    MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY: "1",
    MCP_HTTP_MAX_QUEUED: "8",
    MCP_HTTP_MAX_QUEUED_PER_IDENTITY: "4",
    MCP_HTTP_QUEUE_WAIT_TIMEOUT_MS: "1000",
  };
  for (const variable of ttlVariables) backendEnv[variable] = String(ttlMs);

  const backend = spawn(
    process.execPath,
    [path.join(projectRoot, "dist", "index.js")],
    {
      cwd: projectRoot,
      env: backendEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  backend.stderrText = "";
  backend.stdoutText = "";
  backend.stdout?.on("data", (chunk) => {
    backend.stdoutText += String(chunk);
  });
  backend.stderr?.on("data", (chunk) => {
    backend.stderrText += String(chunk);
  });

  let gateway;
  try {
    await waitForUrl(
      new URL(`http://127.0.0.1:${backendPort}/healthz`),
      backend,
    );
    gateway = await startGateway(
      gatewayBinary,
      sandbox,
      gatewayPort,
      backendPort,
    );
    const baseUrl = new URL(`http://127.0.0.1:${gatewayPort}`);
    const tokenA = await signToken("gateway-client-a");
    const tokenB = await signToken("gateway-client-b");
    const clientA = await initializeClient(baseUrl, tokenA, "gateway-a", 1);
    const clientB = await initializeClient(baseUrl, tokenB, "gateway-b", 2);

    await sameSessionIdentityProof(clientA, clientB, baseUrl);
    const listed = await call(clientA, baseUrl, "tools/list");
    assert.equal(listed.response.status, 200, listed.text);
    const tools = toolList(listed.payload);
    assert.ok(tools.length > 0, "gateway returned no MCP tools");
    const read = await readRetryProof(clientA, baseUrl, tools);
    await streamCancellationProof(clientA, baseUrl);
    await concurrentProof(clientA, clientB, baseUrl);
    const handoff = await externalHandoffProof({
      issuer: clientA,
      other: clientB,
      baseUrl,
      tools,
      externalRoot,
      ttlWaitMs: ttlVariables.length > 0 ? ttlMs + 350 : 65_000,
    });
    const mutation = await mutationReplayHarnessStatus(clientA, baseUrl, tools);
    const quota = await quotaIsolationProof(baseUrl);

    const status = await fetch(new URL("/statusz", baseUrl), {
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "X-Correlation-Id": "gateway-e2e:status.1",
        "X-Incident-Id": "gateway-e2e-001",
      },
    });
    assert.equal(status.status, 200);
    const statusText = await status.text();
    assert.equal(statusText.includes(jwtSecret), false);
    assert.equal(statusText.includes(externalRoot), false);

    const selectedConfigOut = process.env.AGENTGATEWAY_SELECTED_CONFIG_OUT;
    if (selectedConfigOut) {
      await mkdir(path.dirname(selectedConfigOut), { recursive: true });
      await cp(gateway.configPath, selectedConfigOut);
    }
    const report = {
      schemaVersion: 1,
      gateway: "agentgateway",
      upstreamCommit: process.env.AGENTGATEWAY_COMMIT ?? "unknown",
      selectedConfig: gateway.candidate,
      invocationArgs: gateway.args,
      directBackendPort: backendPort,
      gatewayPort,
      checks: {
        streamableHttpInitialize: "passed",
        sessionHeader: "passed",
        verifiedIdentityIsolation: "passed",
        sessionIdentityBinding: "passed",
        concurrentRequests: "passed",
        retryAfterPropagation: "passed",
        readRetry: { status: "passed", tool: read.tool },
        streamCancellation: "passed",
        externalHandoff: { status: "passed", tool: handoff.tool },
        externalHandoffWrongIdentity: "passed",
        externalHandoffReplay: "passed",
        externalHandoffExpiry:
          ttlVariables.length > 0 ? "passed" : "passed-with-default-ttl",
        auxiliaryAuthorizationHeader: "passed",
        auxiliaryTicketHeader: "passed",
        physicalPathDisclosure: "not-observed",
        mutationReplay: mutation,
        quotaIsolation: quota,
        authenticatedStatusAndCustomHeaders: "passed",
      },
    };
    const reportOut = process.env.AGENTGATEWAY_REPORT_OUT;
    if (reportOut) {
      await mkdir(path.dirname(reportOut), { recursive: true });
      await writeFile(
        reportOut,
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await stopChild(gateway?.child);
    await stopChild(backend);
    await rm(sandbox, { recursive: true, force: true });
    await rm(runArtifactsDir, { recursive: true, force: true });
  }
}

await main();
