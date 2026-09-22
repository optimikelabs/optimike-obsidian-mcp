import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  fixture,
  token,
  envelope,
  raw,
  headers,
  prefix,
  revision,
  payload,
} from "./fixtures/mcp-2026/runtime.mjs";

const f = await fixture();
const a = await token("a"),
  b = await token("b");
const sessions = [],
  seen = [];
async function connect(profile, modern = true, bearer = a) {
  const T = modern ? StreamableHTTPClientTransport : LegacyTransport;
  const C = modern ? Client : LegacyClient;
  const transport = new T(new URL(f.base + "/mcp/" + profile), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const response = await fetch(url, init);
      seen.push({
        modern,
        body,
        method: init?.method,
        headers: new Headers(init?.headers),
        session: response.headers.get("mcp-session-id"),
      });
      return response;
    },
  });
  const client = new C(
    { name: "concurrent-client", version: "1" },
    modern ? { versionNegotiation: { mode: { pin: revision } } } : {},
  );
  await client.connect(transport);
  sessions.push({ client, transport });
  return { client, transport };
}
async function status() {
  return (
    await fetch(f.base + "/statusz", {
      headers: { Authorization: `Bearer ${a}` },
    })
  ).json();
}
try {
  const legacy = await connect("standard", false);
  assert.ok(legacy.transport.sessionId);
  const before = (await status()).controls.sessions.active;
  const standard = await connect("standard"),
    tasks = await connect("tasks", true, b),
    full = await connect("full");
  for (const item of [standard, tasks, full]) {
    assert.equal(item.client.getProtocolEra(), "modern");
    assert.equal(item.transport.sessionId, undefined);
  }
  const catalogs = await Promise.all(
    [legacy, standard, tasks, full].map(({ client }) => client.listTools()),
  );
  catalogs[0].tools.forEach((tool) =>
    assert.deepEqual(tool.execution, { taskSupport: "forbidden" }),
  );
  const schemaAndBehavior = (tools) =>
    JSON.parse(JSON.stringify(tools.map(({ execution, ...tool }) => tool)));
  assert.deepEqual(
    schemaAndBehavior(catalogs[1].tools),
    schemaAndBehavior(catalogs[0].tools),
    "legacy and modern schemas/annotations must be identical; legacy Tasks stays explicitly forbidden only on the legacy wire",
  );
  assert.deepEqual(
    catalogs.map((r) => r.tools.length),
    [9, 9, 14, 48],
  );
  for (const { client } of [standard, tasks, full])
    assert.match(
      payload(
        await client.callTool({
          name: "obsidian_read_note",
          arguments: { filePath: "Sentinel.md" },
        }),
      ).content,
      /Dual stack sentinel/,
    );
  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      raw(
        f.base,
        envelope(
          "tools/call",
          { name: "obsidian_runtime_status", arguments: {} },
          100 + i,
          "same-untrusted-name",
        ),
        i % 2 ? a : b,
        {},
        i % 2 ? "/mcp/standard" : "/mcp/tasks",
      ),
    ),
  );
  concurrent.forEach(({ response, payload: r }, i) => {
    assert.equal(response.status, 200);
    assert.equal(
      payload(r.result).capabilityManifest.profile,
      i % 2 ? "standard" : "tasks",
    );
  });
  assert.equal(
    (await status()).controls.sessions.active,
    before,
    "modern requests allocate no legacy sessions",
  );
  for (const item of seen.filter((v) => v.modern && v.body)) {
    assert.notEqual(item.body.method, "initialize");
    assert.notEqual(item.body.method, "notifications/initialized");
    assert.equal(item.session, null);
    assert.equal(item.headers.get("mcp-protocol-version"), revision);
    assert.equal(item.headers.get("mcp-method"), item.body.method);
    assert.equal(item.body.params._meta[prefix + "protocolVersion"], revision);
    assert.ok(item.body.params._meta[prefix + "clientCapabilities"]);
  }
  assert.ok(seen.some((v) => v.modern && v.body?.method === "server/discover"));
  // The three mirrored header fields are independently validated.
  for (const extra of [
    { "MCP-Protocol-Version": "2025-11-25" },
    { "Mcp-Method": "tools/list" },
    { "Mcp-Name": "other_tool" },
  ]) {
    const r = await raw(
      f.base,
      envelope("tools/call", {
        name: "obsidian_runtime_status",
        arguments: {},
      }),
      a,
      extra,
    );
    assert.equal(r.response.status, 400, r.text);
    assert.equal(r.payload.error.code, -32020, r.text);
  }
  for (const key of ["MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"]) {
    const body = envelope("tools/call", {
      name: "obsidian_runtime_status",
      arguments: {},
    });
    const h = headers(body, a);
    delete h[key];
    const r = await fetch(f.base + "/mcp/full", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, `missing ${key}`);
    assert.equal((await r.json()).error.code, -32020);
  }
  const unsupported = envelope("tools/list");
  unsupported.params._meta[prefix + "protocolVersion"] = "2099-01-01";
  const noVersion = await raw(f.base, unsupported, a, {
    "MCP-Protocol-Version": "2099-01-01",
  });
  assert.equal(noVersion.response.status, 400);
  assert.equal(noVersion.payload.error.code, -32022);
  assert.ok(JSON.stringify(noVersion.payload.error.data).includes(revision));
  const noCaps = envelope("tools/list");
  delete noCaps.params._meta[prefix + "clientCapabilities"];
  const nc = await raw(f.base, noCaps, a);
  assert.equal(nc.response.status, 400);
  assert.equal(nc.payload.error.code, -32602);
  const noInfo = envelope("tools/list");
  delete noInfo.params._meta[prefix + "clientInfo"];
  assert.equal(
    (await raw(f.base, noInfo, a)).response.status,
    200,
    "clientInfo is SHOULD, not a mandatory admission condition",
  );
  const freshWithoutCaps = await raw(f.base, noCaps, a);
  assert.equal(
    freshWithoutCaps.response.status,
    400,
    "prior requests must not lend capabilities",
  );
  const forged = await raw(f.base, envelope("tools/list"), a, {
    "Mcp-Session-Id": legacy.transport.sessionId,
    "Last-Event-ID": "private-event",
  });
  assert.equal(forged.response.status, 200);
  assert.equal(forged.response.headers.get("mcp-session-id"), null);
  assert.equal((await status()).controls.sessions.active, before);
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(f.base + "/mcp/full", {
      method,
      headers: {
        Authorization: `Bearer ${a}`,
        "MCP-Protocol-Version": revision,
      },
    });
    assert.equal(r.status, 405);
    await r.text();
  }
  assert.equal(
    (await raw(f.base, envelope("tools/list"), undefined)).response.status,
    401,
  );
  assert.equal(
    (await raw(f.base, envelope("tools/list"), "invalid-token")).response
      .status,
    401,
  );
  assert.equal(
    (
      await raw(f.base, envelope("tools/list"), a, {
        Origin: "https://unapproved.invalid",
      })
    ).response.status,
    403,
  );
  const unknown = await raw(f.base, envelope("fixture/unknown"), a);
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.payload.error.code, -32601);
  const marker = "PRIVATE_TOOL_ARGUMENT_SENTINEL";
  const badTool = await raw(
    f.base,
    envelope("tools/call", { name: marker, arguments: { secret: marker } }, 0),
    a,
  );
  assert.equal(badTool.payload.id, 0);
  assert.equal(badTool.payload.error.code, -32602);
  assert.equal(badTool.text.includes(marker), false);
  const badArg = await raw(
    f.base,
    envelope(
      "tools/call",
      { name: "obsidian_read_note", arguments: { filePath: { marker } } },
      10,
    ),
    a,
  );
  assert.equal(badArg.payload.result.isError, true);
  assert.equal(badArg.text.includes(marker), false);
  const err = JSON.parse(badArg.payload.result.content[0].text);
  assert.equal(err.requestId, badArg.response.headers.get("x-request-id"));
  const invalidJson = await fetch(f.base + "/mcp/full", {
    method: "POST",
    headers: headers(envelope("tools/list"), a),
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error.code, -32700);
  const batch = await fetch(f.base + "/mcp/full", {
    method: "POST",
    headers: headers(envelope("tools/list"), a),
    body: JSON.stringify([envelope("tools/list")]),
  });
  assert.equal(batch.status, 400);
  assert.ok(Number.isInteger((await batch.json()).error.code));
  assert.equal(
    (await legacy.client.listTools()).tools.length,
    9,
    "modern errors do not invalidate a legacy session",
  );
  assert.equal(
    await readFile(f.root + "/Sentinel.md", "utf8"),
    "# untouched\nDual stack sentinel.\n",
  );
  const preflight = await fetch(f.base + "/mcp/full", {
    method: "OPTIONS",
    headers: {
      Origin: "http://approved-fixture.invalid",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "mcp-protocol-version,mcp-method,mcp-name,authorization",
    },
  });
  const allowed = preflight.headers
    .get("access-control-allow-headers")
    .toLowerCase();
  for (const h of ["mcp-protocol-version", "mcp-method", "mcp-name"])
    assert.ok(allowed.includes(h));
  console.log(
    "PASS: modern HTTP discovery/envelopes/header validation, v1 coexistence, 4 profiles, concurrent identity isolation, auth/CORS, statelessness, errors/privacy and no legacy session contamination",
  );
} finally {
  await Promise.allSettled(sessions.map(({ client }) => client.close()));
  await f.close();
}
