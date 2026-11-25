// Opt-in apply confirmation through the real runtime: the HTTP backend
// (dist/index.js, dual) and the stdio proxy (dist/stdio-proxy.js) are the
// production processes; only Obsidian's Local REST API / Atomic Write Bridge
// is a loopback fixture, which counts every CAS. It proves the relay in both
// generations: a 2025-11-25 upstream answers a classic elicitation/create and
// a 2026-07-28 upstream answers an input_required round, while the proxy hop
// to the backend is 2026-07-28. Rule-level cases (legacy mode, stale plan,
// replay) live in test-governed-text-patch-mcp.mjs.
import "./test-support/isolated-state.mjs";
import { isolatedStateEnv } from "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import path from "node:path";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  envelope,
  fixture,
  prefix,
  raw,
  revision,
  secret,
  token,
} from "./fixtures/mcp-2026/runtime.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const note = "Fixture/Apply Confirmation Canary.md";
const initial = "---\ncréation: 2026-11-24\n---\nbefore\n";
const binding = hash("apply-confirmation-fixture");
let content = initial;
let cas = 0;
const json = (res, status, value) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
const bridge = createServer(async (req, res) => {
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
        plugin: { id: "obsidian-atomic-write-bridge", version: "0.8.4" },
        backend: {
          kind: "obsidian-vault-process",
          bindingFingerprint: binding,
          atomicCas: true,
          writeEnabled: true,
        },
        frontmatterFormat: { contractVersion: 1, supported: true },
        limits: { markdownOnly: true },
      });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (route.endsWith("/frontmatter/format")) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        bindingFingerprint: binding,
        canonicalYaml: body.yaml,
        warnings: [],
      });
      return;
    }
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
      cas += 1;
      assert.equal(body.path, note);
      assert.equal(body.expectedSha256, hash(content));
      const beforeSha256 = hash(content);
      content = body.nextContent;
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
await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
const backend = await fixture({
  OBSIDIAN_RUNTIME_MODE: "live",
  OBSIDIAN_BASE_URL: `http://127.0.0.1:${bridge.address().port}`,
  OBSIDIAN_API_KEY: "fixture-api-key",
  OBSIDIAN_VERIFY_SSL: "false",
  OBSIDIAN_ENABLE_CACHE: "false",
  OBSIDIAN_STARTUP_BLOCKING: "true",
  OBSIDIAN_STARTUP_MAX_RETRIES: "1",
  OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
  MCP_WRITE_MODE: "full",
  MCP_APPLY_CONFIRMATION: "elicit",
  ...isolatedStateEnv(),
});
const bearer = await token("apply-confirmation-operator");
const sessions = [];
const watchdog = setTimeout(() => {
  console.error("apply confirmation fixture watchdog");
  process.exit(2);
}, 150000);

function parse(result) {
  return JSON.parse(
    result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  );
}

async function connectProxy({ modern, elicit, onElicit, proxyConfirmation = "elicit" }) {
  const Transport = modern ? ModernStdio : LegacyStdio;
  const transport = new Transport({
    command: process.execPath,
    args: [path.resolve("dist/stdio-proxy.js"), "--tool-profile", "full"],
    cwd: backend.root,
    env: {
      ...backend.env,
      MCP_TRANSPORT_TYPE: "stdio",
      MCP_APPLY_CONFIRMATION: proxyConfirmation,
      MCP_AUTH_MODE: "jwt",
      MCP_AUTH_SECRET_KEY: secret,
      MCP_BACKEND_BEARER_TOKEN: bearer,
      MCP_PROXY_REQUIRE_EXISTING_BACKEND: "true",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const capabilities = elicit
    ? { elicitation: modern ? { form: {} } : {} }
    : {};
  const client = modern
    ? new ModernClient(
        { name: "upstream-2026", version: "1" },
        { capabilities, versionNegotiation: { mode: { pin: revision } } },
      )
    : new LegacyClient({ name: "upstream-2025", version: "1" }, { capabilities });
  if (onElicit) {
    if (modern) client.setRequestHandler("elicitation/create", onElicit);
    else client.setRequestHandler(ElicitRequestSchema, onElicit);
  }
  sessions.push(client);
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Proxy fixture connect failed: ${stderr}`, { cause: error });
  }
  if (modern) assert.equal(client.getProtocolEra(), "modern");
  return client;
}

async function plan(client, key) {
  const planned = parse(
    await client.callTool({
      name: "obsidian_text_patch_plan",
      arguments: {
        path: note,
        operations: [{ op: "append_body", text: `${key}\n` }],
        idempotencyKey: key,
      },
    }),
  );
  assert.equal(planned.phase, "planned", JSON.stringify(planned));
  return { planRef: planned.planRef, idempotencyKey: key };
}

try {
  for (const modern of [false, true]) {
    const label = modern ? "2026-07-28" : "2025-11-25";
    const asked = [];
    let answer = { action: "decline" };
    const client = await connectProxy({
      modern,
      elicit: true,
      onElicit: async (request) => {
        asked.push(request.params);
        return answer;
      },
    });
    const sealed = await plan(client, `confirmed-${modern ? "modern" : "legacy"}`);
    const before = { cas, content };
    // Catches: a relayed decline writing, or surfacing as a success.
    const declined = await client.callTool({
      name: "obsidian_text_patch_apply",
      arguments: sealed,
    });
    assert.equal(declined.isError, true, `${label} decline is not a success`);
    assert.equal(parse(declined).error.details.reasonCode, "apply_confirmation_declined");
    assert.deepEqual({ cas, content }, before, `${label} decline writes nothing`);
    assert.equal(asked.length, 1, `${label} upstream was asked once`);
    assert.ok(asked[0].message.includes(note));
    assert.ok(asked[0].message.includes(sealed.planRef));
    // Catches: a relayed accept not reaching the backend, or writing other
    // bytes than the plan still pending after the decline.
    answer = { action: "accept", content: {} };
    const accepted = parse(
      await client.callTool({ name: "obsidian_text_patch_apply", arguments: sealed }),
    );
    assert.equal(accepted.outcome, "committed", `${label} accept commits`);
    assert.equal(accepted.confirmation, "elicited");
    assert.equal(cas, before.cas + 1, `${label} accept dispatches one CAS`);
    assert.equal(content, `${before.content}${sealed.idempotencyKey}\n`);
    assert.equal(asked.length, 2);
    await client.close();
  }

  // Catches: a 2025-11-25 host error surfacing as free text, or writing.
  {
    const marker = "HOST-ELICITATION-FAILURE-MARKER";
    const client = await connectProxy({
      modern: false,
      elicit: true,
      onElicit: async () => {
        throw new Error(marker);
      },
    });
    const sealed = await plan(client, "legacy-relay-error");
    const before = { cas, content };
    const failed = await client.callTool({ name: "obsidian_text_patch_apply", arguments: sealed });
    assert.equal(failed.isError, true);
    assert.equal(JSON.stringify(failed).includes(marker), false, "no host text");
    assert.equal(parse(failed).error.details.reasonCode, "apply_confirmation_unavailable");
    assert.deepEqual({ cas, content }, before);
    await client.close();
  }

  // Catches: the proxy declaring elicitation for an upstream that never did.
  {
    const client = await connectProxy({ modern: false, elicit: false });
    const sealed = await plan(client, "upstream-without-capability");
    const applied = parse(
      await client.callTool({ name: "obsidian_text_patch_apply", arguments: sealed }),
    );
    assert.equal(applied.outcome, "committed");
    assert.equal(applied.confirmation, undefined, "unchanged flow, no question");
    await client.close();
  }

  // Catches: a proxy relaying the capability although its own opt-in is off.
  {
    let asked = 0;
    const client = await connectProxy({
      modern: true,
      elicit: true,
      proxyConfirmation: "off",
      onElicit: async () => {
        asked += 1;
        return { action: "decline" };
      },
    });
    const sealed = await plan(client, "proxy-opt-in-off");
    const applied = parse(
      await client.callTool({ name: "obsidian_text_patch_apply", arguments: sealed }),
    );
    assert.equal(applied.outcome, "committed");
    assert.equal(asked, 0);
    await client.close();
  }

  // Direct 2026-07-28 HTTP wire: the round is an input_required result, and
  // the backend accepts an answer only with the state it minted for this
  // exact plan. Catches: a forged or cross-plan requestState writing.
  {
    const capable = { [prefix + "clientCapabilities"]: { elicitation: { form: {} } } };
    let id = 100;
    const call = (name, args, extra = {}) =>
      raw(
        backend.base,
        envelope("tools/call", { name, arguments: args, _meta: capable, ...extra }, ++id),
        bearer,
      );
    const planOverWire = async (key) => {
      const response = await call("obsidian_text_patch_plan", {
        path: note,
        operations: [{ op: "append_body", text: `${key}\n` }],
        idempotencyKey: key,
      });
      return { planRef: parse(response.payload.result).planRef, idempotencyKey: key };
    };
    const first = await planOverWire("wire-first");
    const other = await planOverWire("wire-other");
    const round = (await call("obsidian_text_patch_apply", first)).payload.result;
    assert.equal(round.resultType, "input_required");
    assert.equal(round.inputRequests.apply_confirmation.method, "elicitation/create");
    assert.equal(typeof round.requestState, "string");
    const before = { cas, content };
    const accept = { apply_confirmation: { action: "accept", content: {} } };
    for (const [label, args, requestState] of [
      ["tampered", first, `${round.requestState.slice(0, -2)}AA`],
      ["cross-plan", other, round.requestState],
    ]) {
      const refused = (await call("obsidian_text_patch_apply", args, {
        inputResponses: accept,
        requestState,
      })).payload.result;
      assert.equal(refused.isError, true, `${label} state is not a success`);
      assert.equal(parse(refused).error.details.reasonCode, "apply_confirmation_invalid", label);
    }
    assert.deepEqual({ cas, content }, before, "invalid state writes nothing");
    const committed = parse(
      (await call("obsidian_text_patch_apply", first, {
        inputResponses: accept,
        requestState: round.requestState,
      })).payload.result,
    );
    assert.equal(committed.outcome, "committed");
    assert.equal(committed.confirmation, "elicited");
    assert.equal(cas, before.cas + 1);

    const refusalOf = async (args, extra) => {
      const result = (await call("obsidian_text_patch_apply", args, extra)).payload.result;
      assert.equal(result.isError, true, JSON.stringify(result));
      return parse(result).error.details.reasonCode;
    };
    const decline = { apply_confirmation: { action: "decline" } };
    // Catches: a decline that drops its capability falling back to the
    // ordinary apply path and writing.
    const dropped = await planOverWire("wire-decline-without-capability");
    const droppedRound = (await call("obsidian_text_patch_apply", dropped)).payload.result;
    const beforeDropped = { cas, content };
    assert.equal(
      await refusalOf(dropped, {
        _meta: { [prefix + "clientCapabilities"]: {} },
        inputResponses: decline,
        requestState: droppedRound.requestState,
      }),
      "apply_confirmation_declined",
    );
    // Catches: an answer without state opening a new question or writing.
    assert.equal(
      await refusalOf(dropped, { inputResponses: accept }),
      "apply_confirmation_invalid",
    );
    assert.deepEqual({ cas, content }, beforeDropped, "no write without a valid answer");
    // Catches: a late decline of an already applied plan reported as success.
    const late = await planOverWire("wire-late-decline");
    const lateFirst = (await call("obsidian_text_patch_apply", late)).payload.result;
    const lateSecond = (await call("obsidian_text_patch_apply", late)).payload.result;
    assert.equal(
      parse((await call("obsidian_text_patch_apply", late, {
        inputResponses: accept,
        requestState: lateFirst.requestState,
      })).payload.result).outcome,
      "committed",
    );
    const afterLate = cas;
    assert.equal(
      await refusalOf(late, { inputResponses: decline, requestState: lateSecond.requestState }),
      "apply_confirmation_declined",
    );
    assert.equal(cas, afterLate);

    // Catches: a proxy without its opt-in dropping answer material and
    // forwarding a fresh call that writes.
    const proxyRound = await planOverWire("wire-proxy-opt-in-off");
    const proxyState = (await call("obsidian_text_patch_apply", proxyRound)).payload.result.requestState;
    const offProxy = await connectProxy({ modern: true, elicit: true, proxyConfirmation: "off" });
    const beforeProxy = { cas, content };
    const offResult = await offProxy.callTool({
      name: "obsidian_text_patch_apply",
      arguments: proxyRound,
      inputResponses: decline,
      requestState: proxyState,
    });
    assert.equal(offResult.isError, true);
    assert.equal(parse(offResult).error.details.reasonCode, "apply_confirmation_invalid");
    assert.deepEqual({ cas, content }, beforeProxy);
    await offProxy.close();

    // Catches: a stateless (here wrapped, so SDK-dropped) answer being
    // forwarded by an enabled proxy as an empty, fresh-looking apply.
    let askedWrapped = 0;
    const onProxy = await connectProxy({
      modern: true,
      elicit: true,
      onElicit: async () => {
        askedWrapped += 1;
        return { action: "decline" };
      },
    });
    const wrapped = await onProxy.callTool({
      name: "obsidian_text_patch_apply",
      arguments: proxyRound,
      inputResponses: {
        apply_confirmation: { method: "elicitation/create", result: { action: "decline" } },
      },
    });
    assert.equal(wrapped.isError, true);
    assert.equal(parse(wrapped).error.details.reasonCode, "apply_confirmation_invalid");
    assert.equal(askedWrapped, 0, "refused before reaching the backend");
    assert.deepEqual({ cas, content }, beforeProxy);
    await onProxy.close();

    // Catches: the public manifest disagreeing with what the backend does.
    const status = parse(
      (await call("obsidian_runtime_status", {})).payload.result,
    );
    assert.deepEqual(status.capabilityManifest.applyConfirmation, {
      mode: "elicit",
      tools: ["obsidian_text_patch_apply"],
    });
  }

  console.log(
    "PASS: opt-in apply confirmation through the real backend and stdio proxy: 2025-11-25 elicitation/create and 2026-07-28 input_required relays, decline writes nothing, accept writes the sealed plan once, no relay without upstream capability or proxy opt-in, forged, cross-plan, stateless and capability-dropped answers refused, late decline refused, relay errors closed",
  );
} finally {
  clearTimeout(watchdog);
  await Promise.allSettled(sessions.map((client) => client.close()));
  await backend.close();
  bridge.closeAllConnections?.();
  await new Promise((resolve) => bridge.close(resolve));
}
