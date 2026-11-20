#!/usr/bin/env node

import "./test-support/isolated-state.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const fixturePath = "Canary/PROJETS-P2.base";
const bindingFingerprint = sha256("governed-base-mcp-fixture");
let yaml =
  "formulas:\n  score: old\nviews:\n  - type: table\n    name: Préservée\n";
let writes = 0;

// Replay of the Bases Bridge engine routes. Statuses follow the live check of
// 2026-11-20; an older Bridge (engine off) answers 404.
let engineEnabled = false;
const ENGINE_RESULTS = new Map([
  ["fooBar(file.name)", ["runtime_error", 'Error: Unknown function "fooBar"']],
  ["fooBar(1)", ["runtime_error", 'Error: Unknown function "fooBar"']],
  ['if(file.name == "x", 1', ["syntax_error", 'Error: Expected ")"']],
  ["formula.inexistante + 1", ["runtime_error", 'Error: Unknown formula "inexistante"']],
  ["file.name.round()", ["runtime_error", "Error: round is not a function"]],
  ["file.name.lowr()", ["runtime_error", "Error: lowr is not a function"]],
  ["file.name.LOWER()", ["runtime_error", "Error: LOWER is not a function"]],
  ["file.toString.foo()", ["runtime_error", "Error: foo is not a function"]],
  ["note.champ_inexistant_zz", ["all_null"]],
]);
// Registry as the Bridge sends it: generic value methods on `Any`, and
// `doc: null` for functions without a description.
const REGISTRY = [
  ...["if", "now", "today", "date", "number", "list", "link", "max", "min"].map((name) => ({ name, on: "Global" })),
  ...["contains", "lower", "upper", "trim", "replace", "split", "startsWith"].map((name) => ({ name, on: "String" })),
  ...["round", "abs", "ceil", "floor", "toFixed"].map((name) => ({ name, on: "Number" })),
  ...["isTruthy", "isType", "toString"].map((name) => ({ name, on: "Any" })),
].map((fn) =>
  fn.name === "round"
    ? { ...fn, params: [{ name: "digits", types: ["Number"], optional: true, variadic: false }], doc: "Rounds the number." }
    : { ...fn, params: [], doc: null },
);

function engineEvaluate(source) {
  const formulas = {};
  for (const [name, expression] of Object.entries(parseYaml(source)?.formulas ?? {})) {
    const [status, message] = ENGINE_RESULTS.get(String(expression)) ?? ["ok"];
    formulas[name] = {
      status,
      rows: 2,
      errorRows: message ? 2 : 0,
      nullRows: status === "all_null" ? 2 : 0,
      samples: message ? [{ path: "Canary/row.md", message }] : [],
    };
  }
  return { available: true, engine: "obsidian", obsidianVersion: "1.15.1", canary: { ok: true }, formulas, warnings: [] };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      json(res, 200, {
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "fixture", self: "5.0.2" },
      });
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/status"
    ) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        plugin: { id: "obsidian-bases-bridge", version: "1.1.0" },
        backend: {
          kind: "obsidian-vault-process-base",
          bindingFingerprint,
          atomicCas: true,
          writeEnabled: true,
        },
        limits: { baseOnly: true, sourcePreservingCompilerRequired: true },
        migration: { legacyConfigWritesEnabled: false },
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/bases/read"
    ) {
      const request = await body(req);
      if (request.path !== fixturePath)
        return json(res, 404, { error: { code: "base_not_found" } });
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: fixturePath,
        yaml,
        sha256: sha256(yaml),
        size: Buffer.byteLength(yaml),
        bindingFingerprint,
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/bases/cas"
    ) {
      const request = await body(req);
      const actual = sha256(yaml);
      if (
        request.bindingFingerprint !== bindingFingerprint ||
        request.expectedSha256 !== actual
      ) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "hash_conflict",
            message: "Base changed",
            details: { actualSha256: actual },
          },
        });
        return;
      }
      yaml = request.nextYaml;
      writes += 1;
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: fixturePath,
        beforeSha256: actual,
        afterSha256: sha256(yaml),
        size: Buffer.byteLength(yaml),
        bindingFingerprint,
      });
      return;
    }
    if (
      engineEnabled &&
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-bases-bridge/engine/evaluate"
    ) {
      const request = await body(req);
      if (request.path !== fixturePath)
        return json(res, 200, { available: false, reason: "base_not_found", formulas: {} });
      return json(res, 200, engineEvaluate(request.yaml ?? yaml));
    }
    if (
      engineEnabled &&
      req.method === "GET" &&
      url.pathname === "/extensions/obsidian-bases-bridge/engine/functions"
    ) {
      const on = url.searchParams.get("on");
      return json(res, 200, {
        available: true,
        obsidianVersion: "1.15.1",
        source: "obsidian-app-bundle",
        functions: REGISTRY.filter((fn) => !on || fn.on === on),
      });
    }
    if (req.method === "GET" && url.pathname === "/bases") {
      return json(res, 200, {
        bases: [fixturePath, "Canary/Missing.base"].map((path) => ({ id: path, name: path, path })),
      });
    }
    json(res, 404, { error: "fixture route not found" });
  })().catch((error) => json(res, 500, { error: String(error) }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const testParent = path.join(process.cwd(), ".tmp");
mkdirSync(testParent, { recursive: true });
const root = mkdtempSync(path.join(testParent, "optimike-base-mcp-"));
const logs = path.join(root, "logs");
mkdirSync(logs);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_TOOL_PROFILE: "authoring",
    MCP_LOG_LEVEL: "error",
    LOGS_DIR: logs,
    MCP_WRITE_MODE: "full",
    MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(root, "notes.sqlite"),
    MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH: path.join(root, "bases.sqlite"),
    OBSIDIAN_RUNTIME_MODE: "live",
    OBSIDIAN_API_KEY: "fixture-key",
    OBSIDIAN_BASE_URL: `http://127.0.0.1:${address.port}`,
    OBSIDIAN_VERIFY_SSL: "false",
    OBSIDIAN_ENABLE_CACHE: "false",
    OBSIDIAN_STARTUP_MAX_RETRIES: "1",
    OBSIDIAN_STARTUP_RETRY_DELAY_MS: "10",
    SEMANTIC_SEARCH_PREWARM: "false",
    ENABLE_QUERY_EMBEDDING: "false",
    OPERON_MUTATIONS_ENABLED: "false",
  },
  stderr: "pipe",
});
let childStderr = "";
transport.stderr?.on("data", (chunk) => {
  childStderr += chunk.toString("utf8");
});
const client = new Client(
  { name: "governed-base-p2", version: "1.0.0" },
  { capabilities: {} },
);

function parsed(result) {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("bases_formula_patch_"))
      .sort(),
    [
      "bases_formula_patch_apply",
      "bases_formula_patch_plan",
      "bases_formula_patch_recover",
      "bases_formula_patch_status",
    ],
  );
  assert.equal(
    tools.tools.some(
      (tool) => tool.name === "obsidian_list_pending_operations",
    ),
    true,
  );
  const plannedResult = await client.callTool({
    name: "bases_formula_patch_plan",
    arguments: {
      path: fixturePath,
      operations: [{ op: "set_formula", name: "score", expression: "new" }],
      idempotencyKey: "p2-mcp-1",
    },
  });
  assert.equal(plannedResult.isError, false);
  const planned = parsed(plannedResult);
  assert.equal(planned.phase, "planned");
  assert.deepEqual(
    planned.engineCheck,
    { status: "unverified", reason: "bridge_route_missing" },
    "an older Bridge leaves the plan unverified, never verified",
  );
  assert.equal(writes, 0);
  const pending = parsed(
    await client.callTool({
      name: "obsidian_list_pending_operations",
      arguments: { limit: 100 },
    }),
  );
  const pendingBase = pending.operations.find(
    (item) => item.planRef === planned.planRef,
  );
  assert.deepEqual(
    pendingBase && {
      operationKind: pendingBase.operationKind,
      state: pendingBase.state,
      nextAction: pendingBase.nextAction,
    },
    {
      operationKind: "obsidian.base.formula.patch",
      state: "planned",
      nextAction: "apply",
    },
  );
  const appliedResult = await client.callTool({
    name: "bases_formula_patch_apply",
    arguments: { planRef: planned.planRef, idempotencyKey: "p2-mcp-1" },
  });
  assert.equal(appliedResult.isError, false);
  assert.equal(parsed(appliedResult).outcome, "committed");
  assert.equal(writes, 1);
  assert.match(yaml, /score: "new"/u);
  assert.match(yaml, /name: Préservée/u);
  const status = parsed(
    await client.callTool({
      name: "bases_formula_patch_status",
      arguments: { planRef: planned.planRef },
    }),
  );
  assert.equal(status.outcome, "committed");
  assert.equal(status.idempotencyKey, undefined);
  assert.deepEqual(status.engineCheck, planned.engineCheck, "the sealed check survives apply");
  assert.equal(
    parsed(
      await client.callTool({
        name: "obsidian_list_pending_operations",
        arguments: { limit: 100 },
      }),
    ).operations.some((item) => item.planRef === planned.planRef),
    false,
  );

  // Engine available. The Base already has a formula broken before the edit.
  engineEnabled = true;
  yaml = 'formulas:\n  score: "new"\n  legacy: fooBar(1)\nviews:\n  - type: table\n    name: Préservée\n';
  const before = yaml;
  const pendingCount = async () =>
    parsed(await client.callTool({ name: "obsidian_list_pending_operations", arguments: { limit: 100 } }))
      .operations.length;
  const pendingBefore = await pendingCount();
  const plan = (tool, operations, idempotencyKey) =>
    client.callTool({ name: tool, arguments: { path: fixturePath, operations, idempotencyKey } });
  const refusal = async (tool, expression, key) => {
    const result = await plan(tool, [{ op: "set_formula", name: "score", expression }], key);
    assert.equal(result.isError, true, `${expression} must be refused`);
    const payload = parsed(result);
    assert.equal(payload.error.code, "VALIDATION_ERROR");
    assert.equal(payload.error.details.reasonCode, "base_formula_engine_error");
    assert.match(payload.error.message, /https:\/\/help\.obsidian\.md\/bases\/functions/u);
    const check = payload.error.details.formulaCheck;
    assert.equal(check.obsidianVersion, "1.15.1");
    assert.deepEqual(check.docs, ["https://help.obsidian.md/bases/functions", "https://help.obsidian.md/bases/syntax"]);
    assert.deepEqual(check.formulas.map((formula) => formula.name), ["score"], "the pre-existing legacy error is not blamed");
    const [formula] = check.formulas;
    assert.deepEqual(formula.messages, [ENGINE_RESULTS.get(expression)[1]]);
    assert.equal(formula.previousStatus, "ok");
    return formula;
  };

  const unknownGlobal = await refusal("bases_formula_patch_plan", "fooBar(file.name)", "engine-refuse-1");
  assert.equal(unknownGlobal.status, "runtime_error");
  assert.deepEqual(unknownGlobal.unknownFunctions, [{ name: "fooBar", on: "Global", definedOn: [] }]);
  assert.equal(unknownGlobal.validFunctions.on, "Global");
  assert.ok(unknownGlobal.validFunctions.names.includes("if"));

  const syntax = await refusal("bases_formula_patch_plan", 'if(file.name == "x", 1', "engine-refuse-2");
  assert.equal(syntax.status, "syntax_error");
  assert.deepEqual(syntax.unknownFunctions, [], "if is a known global function");

  const missingFormula = await refusal("bases_formula_patch_plan", "formula.inexistante + 1", "engine-refuse-3");
  assert.deepEqual(missingFormula.unknownFunctions, []);

  const wrongType = await refusal("bases_formula_patch_plan", "file.name.round()", "engine-refuse-4");
  assert.deepEqual(wrongType.unknownFunctions, [{ name: "round", on: "String", definedOn: ["Number"] }]);
  assert.equal(wrongType.validFunctions.on, "String");
  assert.ok(wrongType.validFunctions.names.includes("lower") && wrongType.validFunctions.names.includes("toString"));

  const nearMiss = await refusal("bases_config_patch_plan", "file.name.lowr()", "engine-refuse-5");
  assert.deepEqual(nearMiss.suggestions, ["lower"]);

  const caseOnly = await refusal("bases_formula_patch_plan", "file.name.LOWER()", "engine-refuse-6");
  assert.equal(caseOnly.suggestions[0], "lower", "a case-only typo suggests the exact name first");

  const prototypeKey = await refusal("bases_formula_patch_plan", "file.toString.foo()", "engine-refuse-7");
  assert.deepEqual(
    prototypeKey.unknownFunctions,
    [{ name: "foo", on: "any", definedOn: [] }],
    "an Object.prototype key is not a file property type",
  );

  assert.equal(writes, 1, "a refused plan writes nothing");
  assert.equal(yaml, before);
  assert.equal(await pendingCount(), pendingBefore, "a refused plan seals nothing");

  const accepted = { op: "set_formula", name: "score", expression: '"ok " + file.name' };
  const verified = parsed(await plan("bases_formula_patch_plan", [accepted], "engine-accept-1"));
  assert.equal(verified.phase, "planned", "a pre-existing engine error does not block");
  assert.deepEqual(verified.engineCheck, { status: "verified", obsidianVersion: "1.15.1" });

  const allNull = parsed(
    await plan("bases_config_patch_plan", [{ op: "set_formula", name: "score", expression: "note.champ_inexistant_zz" }], "engine-accept-2"),
  );
  assert.equal(allNull.phase, "planned", "all_null is a warning, never a refusal");
  assert.deepEqual(allNull.engineCheck, {
    status: "verified",
    obsidianVersion: "1.15.1",
    warnings: [{ formula: "score", status: "all_null" }],
  });

  // A replayed plan reports the check sealed with it, not a fresh one.
  engineEnabled = false;
  const replayed = parsed(await plan("bases_formula_patch_plan", [accepted], "engine-accept-1"));
  assert.equal(replayed.planRef, verified.planRef);
  assert.deepEqual(replayed.engineCheck, verified.engineCheck);

  // Read tools: an unavailable engine is unverified, never healthy.
  const read = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.content)}`);
    return parsed(result);
  };
  assert.deepEqual((({ status, reason }) => ({ status, reason }))(await read("bases_check")), {
    status: "unverified",
    reason: "bridge_route_missing",
  });
  assert.equal((await read("bases_check", { path: fixturePath })).status, "unverified");
  assert.equal((await read("bases_functions")).status, "unverified");

  engineEnabled = true;
  const grouped = await read("bases_functions");
  assert.deepEqual(grouped.functions.Number, ["abs", "ceil", "floor", "round", "toFixed"]);
  assert.ok(grouped.functions.Global.includes("if"), "doc: null functions are listed");
  assert.deepEqual(grouped.functions.Any, ["isTruthy", "isType", "toString"]);
  const anyMethods = await read("bases_functions", { on: "Any" });
  assert.deepEqual(anyMethods.functions, [
    { signature: "isTruthy()" },
    { signature: "isType()" },
    { signature: "toString()" },
  ], "on accepts Any; a null doc is omitted");
  const numbers = await read("bases_functions", { on: "Number" });
  assert.equal(numbers.on, "Number");
  assert.deepEqual(numbers.functions.find((fn) => fn.signature.startsWith("round(")), {
    signature: "round(digits?: Number)",
    doc: "Rounds the number.",
  });

  const one = await read("bases_check", { path: fixturePath });
  assert.equal(one.status, "verified");
  assert.deepEqual(
    one.formulas.map(({ name, status }) => [name, status]),
    [["score", "ok"], ["legacy", "runtime_error"]],
    "one Base lists every formula",
  );
  assert.equal(one.formulas[1].message, 'Error: Unknown function "fooBar"');

  const all = await read("bases_check");
  assert.deepEqual(all.summary, {
    bases: 2,
    unverifiedBases: 1,
    formulas: { ok: 1, syntax_error: 0, runtime_error: 1, all_null: 0, not_evaluated: 0 },
  });
  assert.deepEqual(
    all.problems.map((problem) => [problem.path, problem.status, problem.reason ?? problem.formulas.map((formula) => formula.name)]),
    [
      ["Canary/Missing.base", "unverified", "base_not_found"],
      [fixturePath, "verified", ["legacy"]],
    ],
    "all Bases lists only problems; the healthy formula is only counted",
  );
  assert.equal(yaml, before, "read tools write nothing");
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nMCP stderr:\n${childStderr}`,
  );
} finally {
  await client.close().catch(() => undefined);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

console.log(
  "PASS: governed Base formula tools and Bases engine reads traverse the live stdio MCP surface and atomic Base backend",
);
