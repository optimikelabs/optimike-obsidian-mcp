#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";

const CONFIRMATION = "I_UNDERSTAND_THIS_IS_A_READ_ONLY_PILOT_2_CANARY";
assert.equal(
  process.env.CAPABILITY_DOCTOR_CANARY_CONFIRM,
  CONFIRMATION,
  `Set CAPABILITY_DOCTOR_CANARY_CONFIRM=${CONFIRMATION}.`,
);
const apiKey = process.env.OBSIDIAN_API_KEY?.trim();
const localRestBaseUrl = process.env.OBSIDIAN_BASE_URL?.trim();
const vault = process.env.OBSIDIAN_VAULT?.trim();
assert.ok(apiKey, "OBSIDIAN_API_KEY is required.");
assert.ok(localRestBaseUrl, "OBSIDIAN_BASE_URL is required.");
assert.ok(vault, "OBSIDIAN_VAULT must identify the disposable Pilot 2 vault.");

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(packageJson.version, "3.4.0");
const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true,
}).trim();
assert.match(candidateSha, /^[a-f0-9]{40}$/u);

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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`candidate exited before health: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the candidate MCP health endpoint.");
}

function parseToolResult(result) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.notEqual(result.isError, true, text);
  return JSON.parse(text);
}

function capability(status, id) {
  const item = status.capabilityManifest.capabilities.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(item, `missing live capability ${id}`);
  return item;
}

async function startClient(baseUrl, profile, token) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`/mcp/${profile}`, baseUrl),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const client = new Client(
    { name: `capability-doctor-${profile}`, version: "1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

const privateRoot = mkdtempSync(
  path.join(os.tmpdir(), "optimike-capability-doctor-live-"),
);
// The runtime constrains LOGS_DIR to the project boundary. Keep only its
// redacted transient logs under the gitignored logs/ tree; all journals and
// cache state remain in the OS temporary directory.
const transientLogsParent = path.join(
  process.cwd(),
  "logs",
  "capability-doctor-live",
);
mkdirSync(transientLogsParent, { recursive: true });
const logsPath = mkdtempSync(path.join(transientLogsParent, "run-"));
const port = await unusedPort();
const authSecret = `capability-doctor-${randomUUID()}-${randomUUID()}`;
const token = await new SignJWT({ cid: "pilot-2-doctor", scp: ["vault:read"] })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("pilot-2-doctor")
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(new TextEncoder().encode(authSecret));
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "http",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PORT_RETRIES: "0",
    MCP_AUTH_MODE: "jwt",
    MCP_AUTH_SECRET_KEY: authSecret,
    MCP_ALLOWED_ORIGINS: "",
    MCP_HTTP_LOOPBACK_POLICY: "shared",
    MCP_LOG_LEVEL: "error",
    LOGS_DIR: logsPath,
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_VAULT: vault,
    OBSIDIAN_BASE_URL: localRestBaseUrl,
    OBSIDIAN_API_KEY: apiKey,
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(privateRoot, "cache.sqlite"),
    OBSIDIAN_STARTUP_BLOCKING: "true",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    MCP_TOOL_PROFILE: "standard",
    MCP_WRITE_MODE: "full",
    OPERON_MUTATIONS_ENABLED: "true",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(
      privateRoot,
      "note.sqlite",
    ),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(
      privateRoot,
      "base.sqlite",
    ),
    MCP_OBSIDIAN_CANVAS_JOURNAL_PATH: path.join(privateRoot, "canvas.sqlite"),
    MCP_EXTERNAL_MOVE_JOURNAL_PATH: path.join(privateRoot, "external.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const clients = [];
try {
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  await waitForHealth(new URL("/healthz", baseUrl), child);
  const profiles = ["standard", "authoring", "tasks", "full"];
  const statuses = {};
  for (const profile of profiles) {
    const client = await startClient(baseUrl, profile, token);
    clients.push(client);
    const tools = await client.listTools();
    assert.equal(
      tools.tools.filter((tool) => tool.name === "obsidian_runtime_status")
        .length,
      1,
      `${profile} must expose exactly one canonical doctor`,
    );
    statuses[profile] = parseToolResult(
      await client.callTool({
        name: "obsidian_runtime_status",
        arguments: {},
      }),
    );
    assert.equal(statuses[profile].runtime.packageVersion, "3.4.0");
    assert.equal(statuses[profile].capabilityManifest.contractVersion, 1);
    assert.equal(statuses[profile].capabilityManifest.profile, profile);
    assert.equal(statuses[profile].capabilityManifest.registrationMode, "live");
    assert.equal(
      statuses[profile].capabilityManifest.admission.transport,
      "http",
    );
    assert.equal(capability(statuses[profile], "local-rest").state, "ready");
  }

  assert.equal(
    capability(statuses.standard, "governed-note-write").state,
    "ready",
  );
  assert.equal(
    capability(statuses.standard, "governed-frontmatter-write").state,
    "ready",
  );
  assert.equal(
    capability(statuses.standard, "governed-canvas-write").state,
    "hidden",
  );
  assert.equal(
    capability(statuses.authoring, "governed-canvas-write").state,
    "ready",
  );
  assert.equal(
    capability(statuses.authoring, "governed-base-write").state,
    "ready",
  );
  assert.equal(capability(statuses.tasks, "operon-read").state, "ready");
  const operonWrite = capability(statuses.tasks, "operon-write");
  assert.equal(operonWrite.discoverable, true);
  assert.equal(operonWrite.available, true);
  assert.equal(operonWrite.operations.length, 11);
  assert.ok(
    operonWrite.operations.every(
      (operation) =>
        operation.reasonCode !== "runtime_mode_unavailable" &&
        operation.reasonCode !== "runtime_not_initialized",
    ),
  );

  const serialized = JSON.stringify(statuses);
  for (const privateValue of [apiKey, localRestBaseUrl, vault, privateRoot]) {
    assert.equal(serialized.includes(privateValue), false);
    assert.equal(stdout.includes(privateValue), false);
    assert.equal(stderr.includes(privateValue), false);
  }

  const evidence = {
    ok: true,
    contractVersion: 1,
    candidateVersion: packageJson.version,
    candidateSha,
    target: "explicit-pilot-2",
    profiles: Object.fromEntries(
      profiles.map((profile) => [
        profile,
        {
          summary: statuses[profile].capabilityManifest.summary,
          admissionState: statuses[profile].capabilityManifest.admission.state,
        },
      ]),
    ),
    operonReadState: capability(statuses.tasks, "operon-read").state,
    operonWriteState: operonWrite.state,
    bridgeFamilies: {
      note: capability(statuses.standard, "governed-note-write").state,
      frontmatter: capability(statuses.standard, "governed-frontmatter-write")
        .state,
      canvas: capability(statuses.authoring, "governed-canvas-write").state,
      base: capability(statuses.authoring, "governed-base-write").state,
    },
    vaultMutations: 0,
  };
  const evidenceFile = path.join(
    os.tmpdir(),
    `optimike-capability-doctor-${Date.now()}.json`,
  );
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ...evidence, evidenceFile }, null, 2)}\n`,
  );
} finally {
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
  child.kill();
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]).catch(() => undefined);
  }
  rmSync(logsPath, { recursive: true, force: true });
  rmSync(privateRoot, { recursive: true, force: true });
}
