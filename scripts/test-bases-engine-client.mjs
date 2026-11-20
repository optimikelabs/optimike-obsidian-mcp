#!/usr/bin/env node

// Bases Bridge engine routes through the real REST client: request shape,
// response decoding and every way the engine can be unavailable. Unavailable
// must come back as a result with a closed reason, never as a pass.

import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
let reply = () => [404, { error: "fixture route not found" }];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      url: req.url,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const [status, payload] = reply(req);
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");

process.env.NODE_ENV = "test";
process.env.OBSIDIAN_RUNTIME_MODE = "live";
process.env.OBSIDIAN_API_KEY = "hermetic-not-a-secret";
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.OBSIDIAN_VERIFY_SSL = "false";
process.env.MCP_LOG_LEVEL = "error";
const { ObsidianRestApiService } = await import(
  "../dist/services/obsidianRestAPI/service.js"
);
const rest = new ObsidianRestApiService();
const context = { requestId: "engine-client-test", timestamp: new Date().toISOString() };
const EVALUATE = "/extensions/obsidian-bases-bridge/engine/evaluate";
const FUNCTIONS = "/extensions/obsidian-bases-bridge/engine/functions";

async function evaluate(payload, status, body) {
  requests.length = 0;
  reply = () => [status, body];
  const result = await rest.evaluateBaseEngine(payload, context);
  assert.equal(requests.length, 1);
  return { result, request: requests[0] };
}

try {
  // Available engine: request shape and decoded, bounded samples.
  const longMessage = `Error: bad\u0000 value\n${"x".repeat(400)}`;
  const available = await evaluate(
    { path: "Folder/X.base", yaml: "formulas:\n  a: 1\n" },
    200,
    {
      available: true,
      engine: "obsidian",
      obsidianVersion: "1.15.1",
      canary: { ok: true },
      formulas: {
        a: { status: "ok", rows: 120, errorRows: 0, nullRows: 3, samples: [] },
        b: {
          status: "runtime_error",
          rows: 4,
          errorRows: 4,
          nullRows: 0,
          samples: [
            { path: "a.md", message: longMessage },
            { path: "b.md", message: "\u0001" },
            { path: "c.md", message: "Error: 2" },
            { path: "d.md", message: "Error: 3" },
            { path: "e.md", message: "Error: 4" },
          ],
        },
      },
      warnings: [],
    },
  );
  assert.deepEqual(available.request, {
    method: "POST",
    url: EVALUATE,
    body: { path: "Folder/X.base", yaml: "formulas:\n  a: 1\n" },
  });
  assert.equal(available.result.available, true);
  assert.equal(available.result.obsidianVersion, "1.15.1");
  assert.deepEqual(available.result.formulas.a, {
    status: "ok", rows: 120, errorRows: 0, nullRows: 3, samples: [],
  });
  const samples = available.result.formulas.b.samples;
  assert.deepEqual(
    samples.map((sample) => sample.path),
    ["a.md", "c.md", "d.md"],
    "blank messages are dropped and at most three samples are kept",
  );
  assert.equal(samples[0].message.length, 300);
  assert.doesNotMatch(samples[0].message, /[\u0000-\u001f]/u);

  // Every unavailable path is a closed reason, not an exception or a pass.
  for (const [label, status, body, reason] of [
    ["Bridge reason", 200, { available: false, reason: "base_not_found", formulas: {} }, "base_not_found"],
    ["unknown Bridge reason", 200, { available: false, reason: "new_reason", formulas: {} }, "engine_unavailable"],
    ["failed canary", 200, { available: true, engine: "obsidian", obsidianVersion: "1.15.1", canary: { ok: false }, formulas: {}, warnings: [] }, "canary_failed"],
    ["older Bridge without the route", 404, { error: "not found" }, "bridge_route_missing"],
    ["Bridge failure", 500, { error: "boom" }, "engine_request_failed"],
    ["unknown formula status", 200, { available: true, engine: "obsidian", obsidianVersion: "1.15.1", canary: { ok: true }, formulas: { a: { status: "maybe" } }, warnings: [] }, "engine_response_invalid"],
  ]) {
    const { result } = await evaluate({ path: "Folder/X.base" }, status, body);
    assert.deepEqual(result, { available: false, reason }, label);
  }

  // Function registry: type filter in the query, unusable entries dropped.
  requests.length = 0;
  reply = () => [200, {
    available: true,
    obsidianVersion: "1.15.1",
    source: "obsidian-app-bundle",
    functions: [
      { name: "lower", on: "String", params: [], doc: "Lowercase." },
      { name: "round", on: "Number", params: [{ name: "digits", types: ["Number"], optional: true, variadic: false }] },
      // As the Bridge sends them: generic methods on `Any`, no description as null.
      { name: "if", on: "Global", params: [], doc: null },
      { name: "toString", on: "Any", params: [], doc: null },
      { name: "future", on: "Duration", params: [] },
      { name: "bad name", on: "String", params: [] },
    ],
  }];
  const registry = await rest.listBaseEngineFunctions("String", context);
  assert.deepEqual(requests[0], { method: "GET", url: `${FUNCTIONS}?on=String`, body: undefined });
  assert.deepEqual(registry, {
    available: true,
    obsidianVersion: "1.15.1",
    functions: [{ name: "lower", on: "String", params: [], doc: "Lowercase." }],
  });
  assert.deepEqual(
    (await rest.listBaseEngineFunctions(undefined, context)).functions.map((fn) => `${fn.on}.${fn.name}`),
    ["String.lower", "Number.round", "Global.if", "Any.toString"],
    "doc: null and on: Any entries are kept",
  );

  // A registry with entries but none usable is a broken answer, not an empty registry.
  reply = () => [200, {
    available: true,
    obsidianVersion: "1.15.1",
    functions: [{ name: "bad name", on: "String", params: [] }, { name: "future", on: "Duration" }],
  }];
  assert.deepEqual(await rest.listBaseEngineFunctions(undefined, context), {
    available: false,
    reason: "engine_response_invalid",
  });
  reply = () => [404, { error: "not found" }];
  assert.deepEqual(await rest.listBaseEngineFunctions(undefined, context), {
    available: false,
    reason: "bridge_route_missing",
  });
  assert.equal(requests.at(-1).url, FUNCTIONS);
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

console.log("PASS: Bases engine client decodes the Bridge routes and reports unavailability as a closed reason");
