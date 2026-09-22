import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { get_encoding } from "tiktoken";

const protocolEra = process.env.MCP_CANARY_PROTOCOL_ERA ?? "legacy";
assert.ok(
  ["legacy", "modern"].includes(protocolEra),
  "Invalid canary protocol era",
);
assert.equal(process.env.VNEXT_PILOT_CONFIRM, "DISPOSABLE_VAULT_ONLY");
const vault = path.resolve(process.env.VNEXT_PILOT_VAULT),
  vaultName = process.env.VNEXT_PILOT_NAME;
assert.ok(vaultName?.includes("pilot"));
assert.ok(!vault.includes("ÉLYSIA"));
assert.equal(
  (await fs.realpath(vault)).toLowerCase(),
  vault.toLowerCase(),
  "Pilot vault may not be a link",
);
const proof = path.resolve(process.env.VNEXT_PROOF_DIR);
await fs.mkdir(proof, { recursive: true });
const run =
    "VNEXT-" +
    new Date().toISOString().slice(0, 10) +
    "-" +
    randomUUID().slice(0, 8),
  folder = path.join(vault, run);
await fs.mkdir(folder);
assert.equal((await fs.realpath(folder)).toLowerCase(), folder.toLowerCase());
const cli = (code) => {
  const r = spawnSync(
    "C:/Program Files/Obsidian/Obsidian.com",
    ["vault=" + vaultName, "eval", "code=" + code],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  assert.equal(r.status, 0, "Obsidian CLI unavailable");
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("=> "));
  assert.ok(line, "Obsidian CLI did not return a value");
  return JSON.parse(line.slice(3));
};
const original = cli(
  "JSON.stringify({vault:app.vault.getName(),updateLinks:app.vault.getConfig('alwaysUpdateLinks'),moves:app.plugins.plugins['obsidian-atomic-write-bridge'].allowNativeMoves,creates:app.plugins.plugins['obsidian-atomic-write-bridge'].allowNoteCreates,base:app.plugins.plugins['obsidian-bases-bridge'].settings.engineEnabled})",
);
assert.equal(original.vault, vaultName);
await fs.writeFile(
  path.join(proof, run + "-settings-before.json"),
  JSON.stringify(original, null, 2),
  "utf8",
);
const restConfig = JSON.parse(
  await fs.readFile(
    path.join(vault, ".obsidian/plugins/obsidian-local-rest-api/data.json"),
    "utf8",
  ),
);
assert.equal(restConfig.enableInsecureServer, true);
const upstream = "http://127.0.0.1:" + restConfig.insecurePort;
let fault = "none",
  createDispatches = 0;
const proxy = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const creation = req.url.endsWith("/note-create/apply");
    const parsed = body.length ? JSON.parse(body.toString("utf8")) : undefined;
    if (creation) {
      assert.ok(parsed.path.startsWith(run + "/"));
      createDispatches++;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    const response = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (creation && response.ok && fault !== "none") {
      const injected = fault;
      fault = "none";
      if (injected === "drift")
        await fs.appendFile(
          path.join(vault, parsed.path),
          "\nUNQUALIFIED-DRIFT\n",
          "utf8",
        );
      if (injected === "lost") {
        res.destroy();
        return;
      }
    }
    res.writeHead(response.status, {
      "content-type":
        response.headers.get("content-type") || "application/json",
    });
    res.end(bytes);
  } catch {
    res.writeHead(502);
    res.end("{}");
  }
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const index = path.join(proof, run + "-semantic");
await fs.mkdir(index);
const target = run + "/Find/Alpha/VNext.md",
  other = run + "/Find/Beta/VNext.md",
  source = run + "/Move/Source.md",
  refs = run + "/Refs.md";
const seed = async (p, text) => {
  await fs.mkdir(path.dirname(path.join(vault, p)), { recursive: true });
  await fs.writeFile(path.join(vault, p), text, "utf8");
};
await seed(
  target,
  "---\naliases:\n  - VNextPilotAlias\nkind: canary\n---\n\nVNext VNext E2E-KEY\n\n## Anchor\n\nA semantic reliability canary about governed Obsidian operations. ^canaryblock\n",
);
await seed(other, "---\nkind: canary\n---\n\nvnext LowerOnly\n");
await seed(source, "---\nkind: canary\n---\n\nMove canary.\n");
await seed(
  refs,
  "---\nkind: canary\n---\n\n[[" +
    target +
    "#Anchor|Alias]]\n![[" +
    target +
    "#^canaryblock]]\n[[" +
    source +
    "]]\n",
);
await seed(run + "/Edit.md", "---\nkind: canary\n---\n\nBEFORE-EDIT\n");
await seed(run + "/Tasks.md", "---\nkind: canary\n---\n\n");
await seed(
  run + "/Base/Row.md",
  "---\nkind: canary\nowner: fixture\n---\n\nBASE-BODY\n",
);
await seed(
  run + "/Base/Fixture.base",
  "filters:\n  and:\n    - 'file.inFolder(\"" +
    run +
    "/Base\")'\nviews:\n  - type: table\n    name: Fixture\n    order:\n      - file.name\n      - kind\n      - qualified\n      - owner\n",
);
await fs.mkdir(path.join(folder, "Created"));
const embedding = async (text) => {
  const r = await fetch("http://127.0.0.1:11434/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3-embedding:0.6b", input: text }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(r.ok, "Local embedder unavailable");
  return (await r.json()).embeddings[0];
};
const semanticQuery =
  "A semantic reliability canary about governed Obsidian operations.";
const vec = await embedding(semanticQuery),
  otherVec = await embedding("Cooking a mushroom soup with vegetables.");
await fs.writeFile(
  path.join(index, "vectors.json"),
  JSON.stringify([
    { path: target, model: "qwen3-embedding:0.6b", embedding: vec },
    { path: other, model: "qwen3-embedding:0.6b", embedding: otherVec },
  ]),
  "utf8",
);
const env = {
  ...process.env,
  OBSIDIAN_VAULT: vault,
  OBSIDIAN_BASE_URL: "http://127.0.0.1:" + proxy.address().port,
  OBSIDIAN_API_KEY: restConfig.apiKey,
  OBSIDIAN_RUNTIME_MODE: "live",
  MCP_TRANSPORT_TYPE: "stdio",
  MCP_PROTOCOL_MODE: protocolEra === "modern" ? "dual" : "legacy",
  MCP_WRITE_MODE: "full",
  MCP_TOOL_PROFILE: "full",
  OPERON_MUTATIONS_ENABLED: "true",
  OPERON_MUTATION_ALLOWED_PATH_PREFIXES: run,
  SEMANTIC_SEARCH_PREWARM: "false",
  ENABLE_QUERY_EMBEDDING: "true",
  SMART_ENV_DIR: index,
  QUERY_EMBEDDER: "ollama",
  QUERY_EMBEDDER_MODEL: "qwen3-embedding:0.6b",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  MCP_LOG_LEVEL: "error",
  OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(proof, run + "-cache.sqlite"),
  MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH: path.join(
    proof,
    run + "-journal.sqlite",
  ),
};
delete env.MCP_BACKEND_BEARER_TOKEN;
delete env.OPENAI_API_KEY;
let client, transport;
const connect = async () => {
  client = new Client(
    { name: "vnext-disposable-pilot", version: "1" },
    {
      versionNegotiation: {
        mode: protocolEra === "modern" ? { pin: "2026-07-28" } : "legacy",
      },
    },
  );
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/index.js")],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), protocolEra);
};
const tokenizer = get_encoding("cl100k_base"),
  evidence = {
    run,
    protocolEra,
    scope:
      "Disposable Obsidian Desktop Pilot2; candidate stdio MCP; real Bridges; local Ollama on two synthetic fixture embeddings",
    calls: [],
    journeys: [],
  };
async function call(name, args) {
  const start = performance.now(),
    r = await client.callTool(
      { name, arguments: args },
      {
        timeout: 60000,
      },
    );
  const text = r.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
    p = JSON.parse(text);
  evidence.calls.push({
    name,
    ms: performance.now() - start,
    bytes: Buffer.byteLength(text),
    tokens: tokenizer.encode(text).length,
    error: !!r.isError,
    outcome: p.outcome ?? p.status,
  });
  if (r.isError) throw Error(name + ": " + JSON.stringify(p));
  return p;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(name, ref, accept) {
  let last;
  for (let n = 0; n < 20; n++) {
    last = await call(name, { planRef: ref });
    if (accept(last)) return last;
    await pause(500);
  }
  throw Error(name + " unexpected terminal: " + JSON.stringify(last));
}
async function journey(name, fn) {
  const before = evidence.calls.length,
    start = performance.now();
  try {
    await fn();
    evidence.journeys.push({
      name,
      pass: true,
      ms: performance.now() - start,
      calls: evidence.calls.length - before,
    });
    console.log("PASS " + name);
  } catch (e) {
    evidence.journeys.push({
      name,
      pass: false,
      ms: performance.now() - start,
      calls: evidence.calls.length - before,
      error: String(e.message).replaceAll(restConfig.apiKey, "[REDACTED]"),
    });
    console.log(
      "FAIL " +
        name +
        ": " +
        String(e.message).replaceAll(restConfig.apiKey, "[REDACTED]"),
    );
  }
}
try {
  cli(
    "(()=>{const p=app.plugins.plugins['obsidian-atomic-write-bridge'];p.allowNativeMoves=true;p.allowNoteCreates=true;app.plugins.plugins['obsidian-bases-bridge'].settings.engineEnabled=true;app.vault.setConfig('alwaysUpdateLinks',true);return JSON.stringify({ok:true})})()",
  );
  await pause(2500);
  await connect();
  // Verify actual backend identity with a new random fixture, before any governed mutation.
  const observed = await call("obsidian_read_note", { filePath: target });
  assert.ok(observed.content.includes("E2E-KEY"));
  await journey("1 exact alias and homonym retrieval", async () => {
    const listed = await call("obsidian_list_notes", {
      dirPath: run,
      nameRegexFilter: "^VNext\\.md$",
      responseMode: "compact",
    });
    assert.equal(listed.entries.filter((e) => e.type === "file").length, 2);
    const r = await call("obsidian_global_search", {
      query: "VNextPilotAlias",
      searchInPath: run,
      responseMode: "compact",
    });
    assert.equal(r.results[0].path, target);
    assert.ok(
      (
        await call("obsidian_read_note", { filePath: r.results[0].path })
      ).content.includes("E2E-KEY"),
    );
  });
  await journey("2 semantic concept retrieval", async () => {
    const r = await call("smart_semantic_search", {
      query: semanticQuery,
      folders: [run + "/Find/"],
      top_k: 1,
      with_snippets: true,
    });
    assert.equal(r.results[0].path, target);
    assert.ok(r.results[0].snippet);
  });
  await journey("3 native links heading block embed", async () => {
    const r = await call("obsidian_note_links", { filePath: refs, limit: 20 });
    const text = JSON.stringify(r);
    assert.ok(text.includes("Anchor"));
    assert.ok(text.includes("canaryblock"));
    assert.ok(text.includes(target));
  });
  await journey("4 governed exact edit", async () => {
    const before = await fs.readFile(
        path.join(vault, run + "/Edit.md"),
        "utf8",
      ),
      key = run + "-edit";
    const p = await call("obsidian_note_replace_plan", {
      path: run + "/Edit.md",
      nextContent: before.replace("BEFORE-EDIT", "AFTER-EDIT"),
      idempotencyKey: key,
    });
    await call("obsidian_note_replace_apply", {
      planRef: p.planRef,
      idempotencyKey: key,
    });
    await poll(
      "obsidian_note_replace_status",
      p.planRef,
      (r) => r.outcome === "committed",
    );
    assert.ok(
      (await fs.readFile(path.join(vault, run + "/Edit.md"), "utf8")).includes(
        "AFTER-EDIT",
      ),
    );
  });
  await journey("5 native move and graph postflight", async () => {
    const dest = run + "/Move/Moved.md",
      key = run + "-move",
      p = await call("obsidian_note_move_plan", {
        sourcePath: source,
        destinationPath: dest,
        idempotencyKey: key,
      });
    await call("obsidian_note_move_apply", {
      planRef: p.planRef,
      idempotencyKey: key,
    });
    await poll(
      "obsidian_note_move_status",
      p.planRef,
      (r) => r.outcome === "committed" && r.graph_postflight === "verified",
    );
    await assert.rejects(fs.access(path.join(vault, source)));
    await fs.access(path.join(vault, dest));
    assert.ok(
      (await fs.readFile(path.join(vault, refs), "utf8")).includes(
        run + "/Move/Moved",
      ),
    );
  });
  async function create(mode) {
    const pth = run + "/Created/" + mode + ".md",
      key = run + "-" + mode,
      content = "---\nkind: canary\n---\n\nCREATE-" + mode + "\n";
    const p = await call("obsidian_note_create_plan", {
      path: pth,
      content,
      idempotencyKey: key,
    });
    fault = mode === "drift" ? "drift" : mode === "lost" ? "lost" : "none";
    const before = createDispatches;
    await call("obsidian_note_create_apply", {
      planRef: p.planRef,
      idempotencyKey: key,
    });
    await poll(
      "obsidian_note_create_status",
      p.planRef,
      (r) => r.outcome === (mode === "drift" ? "outcome_unknown" : "committed"),
    );
    if (mode === "lost") {
      await client.close();
      await connect();
    }
    const status = await call("obsidian_note_create_status", {
      planRef: p.planRef,
    });
    assert.equal(
      status.outcome,
      mode === "drift" ? "outcome_unknown" : "committed",
    );
    await call("obsidian_note_create_apply", {
      planRef: p.planRef,
      idempotencyKey: key,
    });
    assert.equal(createDispatches, before + 1);
    assert.equal(status.recoveryAllowed, false);
    assert.equal(status.applyAllowed, false);
    await fs.access(path.join(vault, pth));
  }
  await journey("6 absent-only durable creation", () => create("exact"));
  await journey("7 existing Base row patch", async () => {
    const key = run + "-base",
      p = await call("bases_rows_patch_plan", {
        baseId: run + "/Base/Fixture.base",
        view: "Fixture",
        path: run + "/Base/Row.md",
        operations: [
          { op: "set", key: "qualified", value: true },
          { op: "delete", key: "owner" },
        ],
        idempotencyKey: key,
      });
    await call("bases_rows_patch_apply", {
      planRef: p.planRef,
      idempotencyKey: key,
    });
    await poll(
      "bases_rows_patch_status",
      p.planRef,
      (r) => r.outcome === "committed",
    );
    const body = await fs.readFile(
      path.join(vault, run + "/Base/Row.md"),
      "utf8",
    );
    assert.match(body, /qualified: true/);
    assert.ok(!body.includes("owner:"));
    assert.ok(body.includes("BASE-BODY"));
  });
  await journey("8 Operon read create update", async () => {
    await call("operon_get_configuration", {});
    const task = {
        source: "inline",
        description: "VNext pilot task",
        targetPath: run + "/Tasks.md",
      },
      key = run + "-task";
    const dry = await call("operon_create_task", {
      idempotencyKey: key + "-dry",
      dryRun: true,
      task,
    });
    assert.equal(dry.status, "planned");
    const created = await call("operon_create_task", {
      idempotencyKey: key,
      dryRun: false,
      task,
    });
    assert.equal(created.status, "applied");
    assert.ok(created.after.operonId);
    const id = created.after.operonId,
      patch = { description: "VNext pilot verified" };
    let revision, previous;
    for (let n = 0; n < 12; n++) {
      const observed = await call("operon_get_task", {
        operonId: id,
        forceRefresh: true,
      });
      revision = observed.task.revision;
      if (revision === previous) break;
      previous = revision;
      await pause(750);
    }
    assert.ok(revision);
    const planned = await call("operon_update_task", {
      operonId: id,
      expectedRevision: revision,
      idempotencyKey: key + "-update-dry",
      dryRun: true,
      patch,
    });
    assert.equal(planned.status, "planned");
    const updated = await call("operon_update_task", {
      operonId: id,
      expectedRevision: revision,
      idempotencyKey: key + "-update",
      dryRun: false,
      patch,
    });
    assert.equal(updated.status, "applied");
    assert.ok(
      (await fs.readFile(path.join(vault, run + "/Tasks.md"), "utf8")).includes(
        "VNext pilot verified",
      ),
    );
  });
  await journey("9 lost reply restart no replay", () => create("lost"));
  await journey("10 availability and authorization", async () => {
    await call("smart_semantic_search", {
      query: semanticQuery,
      top_k: 1,
      with_snippets: false,
    });
    const r = await call("obsidian_runtime_status", {}),
      caps = r.capabilityManifest.capabilities;
    const semantic = caps.find((c) => c.id === "semantic-search");
    assert.equal(semantic.state, "ready");
    assert.equal(semantic.available, true);
    const create = caps.find((c) => c.id === "governed-note-create");
    assert.equal(create.discoverable, true);
    assert.equal(create.authorized, true);
  });
  await journey("R1-A real settled drift no replay", () => create("drift"));
  await journey("F2/F3 regex case and compact", async () => {
    const base = {
      query: "V[N]ext",
      useRegex: true,
      searchInPath: run + "/Find",
      responseMode: "compact",
      pageSize: 1,
      maxMatchesPerFile: 1,
    };
    const r = await call("obsidian_global_search", base);
    assert.equal(r.totalFilesFound, 2);
    assert.equal(r.alsoFoundInFiles, undefined);
    assert.equal(r.hasMore, true);
    const cs = await call("obsidian_global_search", {
      ...base,
      caseSensitive: true,
      pageSize: 20,
    });
    assert.equal(cs.totalFilesFound, 1);
    assert.equal(cs.results[0].matchCount, 3);
  });
} finally {
  await client?.close().catch(() => {});
  cli(
    "(()=>{const p=app.plugins.plugins['obsidian-atomic-write-bridge'];p.allowNativeMoves=" +
      original.moves +
      ";p.allowNoteCreates=" +
      original.creates +
      ";app.plugins.plugins['obsidian-bases-bridge'].settings.engineEnabled=" +
      original.base +
      ";app.vault.setConfig('alwaysUpdateLinks'," +
      original.updateLinks +
      ");return JSON.stringify({ok:true})})()",
  );
  evidence.settingsRestored = cli(
    "JSON.stringify({updateLinks:app.vault.getConfig('alwaysUpdateLinks'),moves:app.plugins.plugins['obsidian-atomic-write-bridge'].allowNativeMoves,creates:app.plugins.plugins['obsidian-atomic-write-bridge'].allowNoteCreates,base:app.plugins.plugins['obsidian-bases-bridge'].settings.engineEnabled})",
  );
  assert.deepEqual(evidence.settingsRestored, {
    updateLinks: original.updateLinks,
    moves: original.moves,
    creates: original.creates,
    base: original.base,
  });
  proxy.closeAllConnections();
  await new Promise((r) => proxy.close(r));
  tokenizer.free();
  await fs.writeFile(
    path.join(proof, run + "-pilot.json"),
    JSON.stringify(evidence, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      run,
      passed: evidence.journeys.filter((x) => x.pass).length,
      total: evidence.journeys.length,
      settingsRestored: true,
    }),
  );
  if (evidence.journeys.some((x) => !x.pass)) process.exitCode = 1;
}
