#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const vaultFixtureContent = "# Gateway\n\nRead retry fixture.\n";
const physicalPathSentinel = "PHYSICAL-GATEWAY-FIXTURE-PATH";

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

async function waitForCompletionLog(
  logDir,
  correlationId,
  incidentId,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await readAllLogs(logDir);
    const completion = logs
      .split(/\r?\n/u)
      .find(
        (line) =>
          line.includes("HTTP request completed.") &&
          line.includes(correlationId) &&
          line.includes(incidentId),
      );
    if (completion) return completion;
    await sleep(50);
  }
  throw new Error(
    `backend did not log forwarded correlation identifiers ${correlationId}/${incidentId}`,
  );
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

function containsStringFragment(value, expectedFragments) {
  if (typeof value === "string") {
    return expectedFragments.some((fragment) => value.includes(fragment));
  }
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsStringFragment(item, expectedFragments),
    );
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) =>
    containsStringFragment(item, expectedFragments),
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

async function waitForStatus(url, child, expectedStatus, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(
        `process exited with ${child.exitCode}: ${child.stderrText ?? ""}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.status === expectedStatus) return response;
    } catch {
      // Still starting.
    }
    await sleep(75);
  }
  throw new Error(`timed out waiting for ${url} to return ${expectedStatus}`);
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

function replaceExactOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  assert.notEqual(first, -1, `${label} placeholder is missing`);
  assert.equal(
    source.indexOf(expected, first + expected.length),
    -1,
    `${label} placeholder is ambiguous`,
  );
  return (
    source.slice(0, first) + replacement + source.slice(first + expected.length)
  );
}

async function materializePublishedGatewayConfig(
  sandbox,
  gatewayPort,
  backendPort,
) {
  const publishedConfigPath = path.join(
    projectRoot,
    "docs",
    "agentgateway.transparent.example.yaml",
  );
  let yaml = await readFile(publishedConfigPath, "utf8");
  yaml = replaceExactOnce(
    yaml,
    "port: 3100",
    `port: ${gatewayPort}`,
    "gateway port",
  );
  yaml = replaceExactOnce(
    yaml,
    "host: 127.0.0.1:3101",
    `host: 127.0.0.1:${backendPort}`,
    "backend endpoint",
  );
  const configPath = path.join(
    sandbox,
    "agentgateway.transparent.example.resolved.yaml",
  );
  await writeFile(configPath, yaml, "utf8");
  return configPath;
}

async function startGateway(binary, sandbox, gatewayPort, backendPort) {
  const configPath = await materializePublishedGatewayConfig(
    sandbox,
    gatewayPort,
    backendPort,
  );
  const args = ["-f", configPath];
  const child = spawn(binary, args, {
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
  try {
    const probe = await waitForUrl(
      new URL(`http://127.0.0.1:${gatewayPort}/healthz`),
      child,
      6000,
    );
    assert.ok(
      probe.status < 500,
      `published agentgateway config returned ${probe.status}`,
    );
    return {
      child,
      configPath,
      candidate: "docs/agentgateway.transparent.example.yaml",
      args,
    };
  } catch (error) {
    await stopChild(child);
    throw new Error(
      `agentgateway rejected the published transparent HTTP configuration: ${
        error instanceof Error ? error.message : String(error)
      }\n${child.stderrText.slice(-3000)}`,
    );
  }
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

function assertSuccessfulToolResultContaining(result, expectedContent, label) {
  assert.equal(result.response.status, 200, result.text);
  assert.equal(
    result.payload?.error,
    undefined,
    `${label} returned a JSON-RPC error: ${result.text}`,
  );
  const normalized = normalizeToolResult(result.payload);
  assert.notEqual(
    normalized?.isError,
    true,
    `${label} returned an MCP tool error: ${result.text}`,
  );
  assert.ok(
    containsStringFragment(normalized, [expectedContent]),
    `${label} did not return the fixture content: ${result.text}`,
  );
  return normalized;
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
  const normalizedFirst = assertSuccessfulToolResultContaining(
    first,
    vaultFixtureContent,
    "first fixture read",
  );
  const normalizedSecond = assertSuccessfulToolResultContaining(
    second,
    vaultFixtureContent,
    "retried fixture read",
  );
  assert.deepEqual(
    normalizedFirst,
    normalizedSecond,
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

async function statusSnapshot(baseUrl, token, headers = {}) {
  const response = await fetch(new URL("/statusz", baseUrl), {
    headers: {
      Authorization: `Bearer ${token}`,
      ...headers,
    },
  });
  if (response.status !== 200) {
    throw new Error(
      `authenticated status failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

async function waitForActiveRequests(baseUrl, token, predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await statusSnapshot(baseUrl, token);
    const activeRequests = status.controls?.sessions?.activeRequests;
    if (typeof activeRequests === "number" && predicate(activeRequests)) {
      return activeRequests;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for upstream active requests: ${label}`);
}

async function waitForAdmission(baseUrl, token, predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await statusSnapshot(baseUrl, token);
    const admission = status.controls?.admission;
    if (admission && predicate(admission)) return admission;
    await sleep(50);
  }
  throw new Error(`timed out waiting for upstream admission state: ${label}`);
}

async function openEventStream(client, baseUrl, correlationId, incidentId) {
  const controller = new AbortController();
  const response = await Promise.race([
    fetch(new URL("/mcp", baseUrl), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${client.token}`,
        "Mcp-Session-Id": client.sessionId,
        "X-Correlation-Id": correlationId,
        "X-Incident-Id": incidentId,
      },
      signal: controller.signal,
    }),
    sleep(4000).then(() => {
      throw new Error("gateway did not establish an MCP event stream");
    }),
  ]);
  assert.equal(response.status, 200);
  return { controller, response };
}

async function closeEventStream(stream) {
  stream.controller.abort();
  await stream.response.body?.cancel().catch(() => undefined);
}

async function streamCancellationProof(client, baseUrl, logDir) {
  const baseline = await statusSnapshot(baseUrl, client.token);
  const baselineActive = baseline.controls.sessions.activeRequests;
  const correlationId = "gateway-e2e:cancel.1";
  const incidentId = "gateway-e2e-cancel-001";
  const stream = await openEventStream(
    client,
    baseUrl,
    correlationId,
    incidentId,
  );
  await waitForActiveRequests(
    baseUrl,
    client.token,
    (active) => active >= baselineActive + 1,
    "gateway stream reached Optimike",
  );
  await closeEventStream(stream);
  await waitForActiveRequests(
    baseUrl,
    client.token,
    (active) => active <= baselineActive,
    "gateway cancellation reached Optimike",
  );
  await waitForCompletionLog(logDir, correlationId, incidentId);
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

function startBlockedProtocolRequest(client, baseUrl, id) {
  const encoder = new TextEncoder();
  let bodyController;
  const body = new ReadableStream({
    start(controller) {
      bodyController = controller;
      controller.enqueue(
        encoder.encode(`{"jsonrpc":"2.0","id":${id},"method":"ping"`),
      );
    },
  });
  const responsePromise = fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.token}`,
      "Mcp-Session-Id": client.sessionId,
    },
    body,
    duplex: "half",
  });
  return {
    responsePromise,
    release() {
      bodyController.enqueue(encoder.encode("}"));
      bodyController.close();
    },
  };
}

async function concurrentProof(a, b, baseUrl) {
  const blockedA = startBlockedProtocolRequest(a, baseUrl, 1200);
  const blockedB = startBlockedProtocolRequest(b, baseUrl, 1201);
  await waitForAdmission(
    baseUrl,
    a.token,
    (admission) => admission.inFlight >= 2,
    "both slow request bodies reached Optimike",
  );
  const rejected = await call(a, baseUrl, "ping");
  assert.equal(
    rejected.response.status,
    503,
    `synchronized overload was not rejected: ${rejected.text}`,
  );
  assert.ok(rejected.response.headers.get("retry-after"));
  assert.ok(rejected.response.headers.get("x-optimike-backpressure"));
  blockedA.release();
  blockedB.release();
  const completed = await Promise.all([
    blockedA.responsePromise,
    blockedB.responsePromise,
  ]);
  for (const response of completed) {
    if (response.status !== 200) {
      throw new Error(
        `blocked request failed after release: ${response.status} ${await response.text()}`,
      );
    }
    await response.arrayBuffer();
  }
  await waitForAdmission(
    baseUrl,
    a.token,
    (admission) => admission.inFlight === 0,
    "slow request bodies completed upstream",
  );
  const recovered = await call(a, baseUrl, "ping");
  assert.equal(recovered.response.status, 200, recovered.text);
  return {
    rejectedStatus: rejected.response.status,
    retryAfter: rejected.response.headers.get("retry-after"),
  };
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

async function verifyGatewayBinary(binary, expectedSha256) {
  assert.match(
    expectedSha256,
    /^[a-f0-9]{64}$/iu,
    "AGENTGATEWAY_SHA256 must be an explicit 64-character SHA-256 digest",
  );
  const bytes = await readFile(binary);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    actualSha256,
    expectedSha256.toLowerCase(),
    `agentgateway binary checksum mismatch: expected ${expectedSha256.toLowerCase()}, received ${actualSha256}`,
  );
  return actualSha256;
}

async function main() {
  const gatewayBinary = process.env.AGENTGATEWAY_BIN;
  assert.ok(gatewayBinary, "AGENTGATEWAY_BIN is required");
  const expectedGatewaySha256 = process.env.AGENTGATEWAY_SHA256;
  assert.ok(
    expectedGatewaySha256,
    "AGENTGATEWAY_SHA256 is required and must match AGENTGATEWAY_BIN",
  );
  const gatewaySha256 = await verifyGatewayBinary(
    gatewayBinary,
    expectedGatewaySha256,
  );
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
    vaultFixtureContent,
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
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(runArtifactsDir, "cache.sqlite"),
    OBSIDIAN_ENABLE_CACHE: "true",
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
    await waitForStatus(
      new URL(`http://127.0.0.1:${backendPort}/readyz`),
      backend,
      200,
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
    await streamCancellationProof(clientA, baseUrl, logDir);
    const concurrency = await concurrentProof(clientA, clientB, baseUrl);
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
    const statusPayload = JSON.parse(statusText);
    assert.equal(
      containsStringFragment(statusPayload, [jwtSecret]),
      false,
      "authenticated status disclosed the JWT secret",
    );
    assert.equal(
      containsStringFragment(statusPayload, [
        externalRoot,
        physicalPathSentinel,
      ]),
      false,
      "authenticated status disclosed the physical external-root path",
    );
    await waitForCompletionLog(
      logDir,
      "gateway-e2e:status.1",
      "gateway-e2e-001",
    );

    const selectedConfigOut = process.env.AGENTGATEWAY_SELECTED_CONFIG_OUT;
    if (selectedConfigOut) {
      await mkdir(path.dirname(selectedConfigOut), { recursive: true });
      await cp(gateway.configPath, selectedConfigOut);
    }
    const report = {
      schemaVersion: 1,
      gateway: "agentgateway",
      upstreamCommit: process.env.AGENTGATEWAY_COMMIT ?? "unknown",
      binarySha256: gatewaySha256,
      selectedConfig: gateway.candidate,
      invocationArgs: gateway.args,
      directBackendPort: backendPort,
      gatewayPort,
      checks: {
        streamableHttpInitialize: "passed",
        sessionHeader: "passed",
        verifiedIdentityIsolation: "passed",
        sessionIdentityBinding: "passed",
        concurrentRequests: {
          status: "passed-with-synchronized-overload",
          ...concurrency,
        },
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
        authenticatedStatusAndCorrelationHeaders: "passed",
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
