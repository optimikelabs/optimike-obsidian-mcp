import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  fixture,
  token,
  payload,
  revision,
} from "./fixtures/mcp-2026/runtime.mjs";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const note = "Fixture/Lost Modern Response.md",
  initial = "---\ncréation: 2026-09-22\n---\nbefore\n",
  next = "---\ncréation: 2026-09-22\n---\ncommitted exactly once\n";
const binding = hash("modern-loss-fixture");
let content = initial,
  cas = 0,
  applied = 0;
const json = (res, status, value) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
const fake = createServer(async (req, res) => {
  try {
    const route = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && route === "/") {
      json(res, 200, {
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "fixture", self: "5.0.2" },
      });
      return;
    }
    if (req.method === "GET" && route.endsWith("/status")) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        plugin: { id: "obsidian-atomic-write-bridge", version: "0.1.0" },
        backend: {
          kind: "obsidian-vault-process",
          bindingFingerprint: binding,
          atomicCas: true,
          writeEnabled: true,
        },
        limits: { markdownOnly: true },
      });
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (route.endsWith("/notes/read") && body.path === note) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: note,
        content,
        sha256: hash(content),
        size: Buffer.byteLength(content),
        bindingFingerprint: binding,
      });
      return;
    }
    if (route.endsWith("/notes/cas")) {
      cas++;
      assert.equal(body.path, note);
      assert.equal(body.bindingFingerprint, binding);
      assert.equal(body.expectedSha256, hash(content));
      const beforeSha256 = hash(content);
      content = body.nextContent;
      applied++;
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: note,
        beforeSha256,
        afterSha256: hash(content),
        size: Buffer.byteLength(content),
        bindingFingerprint: binding,
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: "fixture_assertion" });
    console.error(error);
  }
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const f = await fixture({
  OBSIDIAN_RUNTIME_MODE: "live",
  OBSIDIAN_BASE_URL: `http://127.0.0.1:${fake.address().port}`,
  OBSIDIAN_API_KEY: "fixture-api-key",
  OBSIDIAN_VERIFY_SSL: "false",
  OBSIDIAN_ENABLE_CACHE: "false",
  OBSIDIAN_STARTUP_BLOCKING: "true",
  OBSIDIAN_STARTUP_MAX_RETRIES: "1",
  OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
  MCP_WRITE_MODE: "full",
});
const bearer = await token("governed-operator"),
  clients = [];
let lost = 0,
  applyRequests = 0;
const relay = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const rpc = body ? JSON.parse(body) : undefined;
    const upstream = await fetch(f.base + req.url, {
      method: req.method,
      headers: req.headers,
      ...(body ? { body } : {}),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (
      rpc?.method === "tools/call" &&
      rpc.params.name === "obsidian_note_replace_apply"
    ) {
      applyRequests++;
      assert.equal(applied, 1, "drop must happen after the real CAS effect");
      lost++;
      res.destroy();
      return;
    }
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    res.end(bytes);
  } catch (error) {
    res.destroy();
  }
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
async function client(base, name) {
  const c = new Client(
    { name, version: "1" },
    { versionNegotiation: { mode: { pin: revision } } },
  );
  const t = new StreamableHTTPClientTransport(new URL(base + "/mcp/standard"), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await c.connect(t);
  assert.equal(t.sessionId, undefined);
  clients.push(c);
  return c;
}
try {
  const first = await client(f.base, "plan-client");
  const plan = payload(
    await first.callTool({
      name: "obsidian_note_replace_plan",
      arguments: {
        path: note,
        nextContent: next,
        idempotencyKey: "modern-lost-response",
      },
    }),
  );
  assert.equal(plan.phase, "planned");
  await first.close();
  const second = await client(
    `http://127.0.0.1:${relay.address().port}`,
    "apply-client",
  );
  await assert.rejects(
    second.callTool({
      name: "obsidian_note_replace_apply",
      arguments: {
        planRef: plan.planRef,
        idempotencyKey: "modern-lost-response",
      },
    }),
  );
  assert.equal(lost, 1);
  assert.equal(applyRequests, 1);
  assert.equal(cas, 1);
  assert.equal(applied, 1);
  assert.equal(content, next);
  await second.close();
  await f.stop();
  await f.start();
  const third = await client(f.base, "new-process-status-client");
  const receipt = payload(
    await third.callTool({
      name: "obsidian_note_replace_status",
      arguments: { planRef: plan.planRef },
    }),
  );
  assert.equal(receipt.outcome, "committed");
  assert.equal(receipt.planDigest, plan.planDigest);
  assert.equal(receipt.operationId, plan.operationId);
  assert.equal(cas, 1);
  assert.equal(applied, 1);
  assert.equal(hash(content), hash(next));
  assert.equal(JSON.stringify(receipt).includes(next), false);
  const runtime = payload(
    await third.callTool({ name: "obsidian_runtime_status", arguments: {} }),
  );
  assert.equal(runtime.capabilityManifest.profile, "standard");
  console.log(
    "PASS: modern plan/apply/status span independent clients and a process restart, durable SQLite receipt survives lost HTTP response after CAS, exactly one dispatch/effect and no mutation replay",
  );
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  relay.closeAllConnections?.();
  await new Promise((r) => relay.close(r));
  await f.close();
  fake.closeAllConnections?.();
  await new Promise((r) => fake.close(r));
}
