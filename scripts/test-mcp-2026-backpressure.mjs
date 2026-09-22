import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import {
  freePort,
  token,
  envelope,
  headers,
  raw,
  pause,
  secret,
} from "./fixtures/mcp-2026/runtime.mjs";
const root = await mkdtemp(path.join(tmpdir(), "optimike-modern-admission-"));
const logs = path.join(process.cwd(), ".tmp", path.basename(root));
await mkdir(logs, { recursive: true });
const port = await freePort();
Object.assign(process.env, {
  NODE_ENV: "test",
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: root,
  OBSIDIAN_ENABLE_CACHE: "false",
  SEMANTIC_SEARCH_PREWARM: "false",
  MCP_TRANSPORT_TYPE: "http",
  MCP_PROTOCOL_MODE: "dual",
  MCP_AUTH_MODE: "jwt",
  MCP_AUTH_SECRET_KEY: secret,
  MCP_HTTP_HOST: "127.0.0.1",
  MCP_HTTP_PORT: String(port),
  MCP_HTTP_PORT_RETRIES: "0",
  MCP_ALLOWED_ORIGINS: "",
  MCP_LOG_LEVEL: "error",
  LOGS_DIR: logs,
  MCP_HTTP_PREAUTH_RATE_LIMIT_MAX: "10000",
  MCP_HTTP_IDENTITY_RATE_LIMIT_MAX: "10000",
  MCP_HTTP_MAX_IN_FLIGHT: "2",
  MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY: "1",
  MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT: "2",
  MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY: "1",
  MCP_HTTP_MUTATION_MAX_IN_FLIGHT: "2",
  MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY: "1",
  MCP_HTTP_MAX_QUEUED: "1",
  MCP_HTTP_MAX_QUEUED_PER_IDENTITY: "1",
  MCP_HTTP_QUEUE_WAIT_TIMEOUT_MS: "800",
  MCP_HTTP_MUTATION_TOOLS: "mutation_probe",
});
const { startHttpTransport } = await import(
  "../dist/mcp-server/transports/httpTransport.js"
);
const { httpAdmissionController } = await import(
  "../dist/mcp-server/transports/httpBackpressure.js"
);
const { authContext } = await import(
  "../dist/mcp-server/transports/auth/core/authContext.js"
);
const { mcpSchema } = await import("../dist/mcp-server/mcpSchema.js");
const gates = new Map(),
  dispatches = new Map(),
  cancellations = new Set();
const server = await startHttpTransport(
  async (context) => {
    const mcp = new McpServer({ name: "admission-fixture", version: "1" });
    const factoryIdentity = context?.authInfo?.clientId;
    mcp.registerTool(
      "mutation_probe",
      {
        inputSchema: mcpSchema(
          z.object({
            key: z.string(),
            hold: z.boolean().default(false),
            stream: z.boolean().default(false),
          }),
        ),
        annotations: { readOnlyHint: false },
      },
      async ({ key, hold, stream }, ctx) => {
        dispatches.set(key, (dispatches.get(key) ?? 0) + 1);
        if (hold) {
          const held = new Promise((resolve) => {
            const finish = () => {
              gates.delete(key);
              resolve();
            };
            gates.set(key, finish);
            ctx.mcpReq.signal.addEventListener(
              "abort",
              () => {
                cancellations.add(key);
                finish();
              },
              { once: true },
            );
          });
          if (stream)
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken: "fixture-progress",
                progress: 1,
                total: 2,
              },
            });
          await held;
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                factoryIdentity,
                handlerIdentity: ctx.http?.authInfo?.clientId,
                asyncIdentity: authContext.getStore()?.authInfo.clientId,
              }),
            },
          ],
        };
      },
    );
    return mcp;
  },
  { requestId: "fixture-admission", operation: "fixture" },
);
const base = `http://127.0.0.1:${port}`,
  a = await token("identity-a"),
  b = await token("identity-b");
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await pause(20);
  }
  throw Error("Timed out: " + label);
}
const post = (key, bearer, hold = false, stream = false, signal) => {
  const body = envelope(
    "tools/call",
    {
      name: "mutation_probe",
      arguments: { key, hold, stream },
      _meta: { progressToken: "fixture-progress" },
    },
    key,
    "same-untrusted-client",
  );
  return fetch(base + "/mcp/full", {
    method: "POST",
    headers: headers(body, bearer),
    body: JSON.stringify(body),
    signal,
  });
};
const watchdog = setTimeout(() => {
  console.error("modern backpressure watchdog");
  process.exit(2);
}, 30000);
try {
  const first = post("held-a", a, true);
  await waitFor(() => gates.has("held-a"), "A admitted");
  const other = await post("fast-b", b);
  assert.equal(other.status, 200);
  const otherBody = await other.text();
  assert.ok(otherBody.includes("identity-b"));
  assert.equal(
    otherBody.includes("identity-a"),
    false,
    "verified auth contexts cannot bleed across requests",
  );
  const abortQueued = new AbortController();
  const queued = post("queued-a", a, false, false, abortQueued.signal).catch(
    (error) => error,
  );
  await waitFor(
    () => httpAdmissionController.getSnapshot().queued === 1,
    "A queued",
  );
  const rejected = await post("rejected-a", a);
  assert.equal(rejected.status, 503);
  assert.ok(rejected.headers.get("retry-after"));
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error.code, -32015);
  assert.equal(dispatches.has("rejected-a"), false);
  abortQueued.abort();
  await queued;
  await waitFor(
    () => httpAdmissionController.getSnapshot().queued === 0,
    "cancelled queue released",
  );
  assert.equal(
    dispatches.has("queued-a"),
    false,
    "cancellation before admission performs no dispatch",
  );
  gates.get("held-a")();
  const firstResponse = await first;
  const firstText = await firstResponse.text();
  assert.ok(firstText.includes("identity-a"));
  await waitFor(
    () => httpAdmissionController.getSnapshot().inFlight === 0,
    "normal response releases lease",
  );
  const second = post("held-timeout", a, true);
  await waitFor(() => gates.has("held-timeout"), "timeout holder admitted");
  const timed = await post("timed-out", a);
  assert.equal(timed.status, 503);
  assert.equal((await timed.json()).error.data.admission, "timeout");
  assert.equal(dispatches.has("timed-out"), false);
  gates.get("held-timeout")();
  await (await second).text();
  await waitFor(
    () => httpAdmissionController.getSnapshot().inFlight === 0,
    "timeout holder released",
  );
  const abortStream = new AbortController();
  const streaming = await post(
    "stream-cancel",
    a,
    true,
    true,
    abortStream.signal,
  );
  assert.equal(streaming.status, 200);
  assert.ok(
    streaming.headers.get("content-type").startsWith("text/event-stream"),
  );
  const reader = streaming.body.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(
    httpAdmissionController.getSnapshot().mutationInFlight,
    1,
    "stream holds its mutation admission lease",
  );
  abortStream.abort();
  await reader.cancel().catch(() => {});
  reader.releaseLock();
  await waitFor(
    () => cancellations.has("stream-cancel"),
    "SSE cancellation reaches SDK request signal",
  );
  await waitFor(
    () => httpAdmissionController.getSnapshot().inFlight === 0,
    "cancelled stream releases lease",
  );
  assert.equal(
    dispatches.get("stream-cancel"),
    1,
    "cancellation never redispatches the mutation",
  );
  const after = await post("healthy-after-cancel", b);
  assert.equal(after.status, 200);
  await after.text();
  const s = httpAdmissionController.getSnapshot();
  assert.ok(s.maxObservedInFlight <= 2);
  assert.ok(s.maxObservedQueued <= 1);
  console.log(
    "PASS: actual dual HTTP boundary enforces verified identities, bounded admission/queue/timeout, no pre-admission dispatch, request-scoped SSE cancellation, lease release and no replay",
  );
} finally {
  clearTimeout(watchdog);
  for (const release of gates.values()) release();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  await rm(logs, { recursive: true, force: true });
}
