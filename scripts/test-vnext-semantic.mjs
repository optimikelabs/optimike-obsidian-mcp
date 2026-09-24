import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

const dist = pathToFileURL(
  path.resolve(process.env.VNEXT_DIST_ROOT || "dist") + path.sep,
).href;
const root = await mkdtemp(path.join(os.tmpdir(), "vnext-semantic-"));
const source = path.join(root, ".smart-env");
const modelName = "TaylorAI/bge-micro-v2";
await mkdir(source);
await writeFile(
  path.join(source, "vectors.json"),
  JSON.stringify([
    { path: "Notes/Fixture.md", embedding: [1, 0], model: modelName },
    { path: "Other/Fixture.md", embedding: [0, 1], model: modelName },
  ]),
  "utf8",
);
let behavior = "ok",
  requests = 0;
const http = createServer(async (req, res) => {
  for await (const chunk of req) {
    /* consume, never log query */
  }
  requests++;
  res.writeHead(behavior === "failure" ? 500 : 200, {
    "Content-Type": "application/json",
  });
  res.end(
    JSON.stringify(
      behavior === "failure"
        ? { error: "PRIVATE-provider-detail" }
        : {
            embeddings: [
              behavior === "dimension"
                ? [1, 0, 0]
                : behavior === "zero"
                  ? [0, 0]
                  : [1, 0],
            ],
          },
    ),
  );
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
Object.assign(process.env, {
  NODE_ENV: "test",
  OBSIDIAN_RUNTIME_MODE: "headless-readonly",
  OBSIDIAN_VAULT: root,
  SMART_ENV_DIR: source,
  OBSIDIAN_SHARED_CACHE_DB_PATH: path.join(root, "cache.sqlite"),
  SEMANTIC_SEARCH_PREWARM: "false",
  ENABLE_QUERY_EMBEDDING: "true",
  MCP_LOG_LEVEL: "error",
  QUERY_EMBEDDER: "auto",
});
delete process.env.QUERY_EMBEDDER_MODEL;
// Exercise the same inferred provider URL in the tool and doctor.
delete process.env.OLLAMA_BASE_URL;
await mkdir(path.join(source, "embedding_models"));
await writeFile(
  path.join(source, "smart_env.json"),
  JSON.stringify({ embedding_models: { default_model_key: "ollama#bge" } }),
  "utf8",
);
await writeFile(
  path.join(source, "embedding_models", "embedding_models.ajson"),
  '"embedding_models:ollama#bge":' +
    JSON.stringify({
      provider_key: "ollama",
      model_key: modelName,
      host: `http://127.0.0.1:${http.address().port}`,
    }),
  "utf8",
);
const { registerSemanticSearchTool } = await import(
  dist + "mcp-server/tools/semanticSearchTool/registration.js"
);
const { collectCapabilityManifest } = await import(
  dist + "services/capabilityManifest.js"
);
const { getSemanticCacheService } = await import(
  dist + "services/semanticCache.js"
);

const server = new McpServer({ name: "vnext", version: "1" });
const client = new Client({ name: "vnext-test", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
const doctor = async () =>
  (
    await collectCapabilityManifest({
      profile: "full",
      registrationMode: "headless-readonly",
      runtimeStatus: { semanticCache: { enabled: true } },
      vaultCacheAvailable: true,
      governedRuntimes: { note: false, canvas: false, base: false },
      probes: { operon: async () => ({ source: "unavailable" }) },
    })
  ).capabilities.find((c) => c.id === "semantic-search");
const call = async () => {
  const response = await client.callTool({
    name: "smart_semantic_search",
    arguments: {
      query: "PRIVATE-query",
      top_k: 1,
      folders: ["Notes/"],
      with_snippets: false,
    },
  });
  return { response, value: JSON.parse(response.content[0].text) };
};
try {
  await registerSemanticSearchTool(server);
  await server.connect(st);
  await client.connect(ct);
  assert.equal((await doctor()).reasonCode, "semantic_query_unverified");
  assert.equal((await doctor()).state, "degraded");
  assert.equal(
    requests,
    0,
    "doctor must not send a paid/network embedding probe",
  );
  const good = await call();
  assert.equal(good.response.isError, false);
  assert.equal(good.value.query_provider, "ollama");
  assert.equal(good.value.query_model, modelName);
  assert.equal(good.value.results[0].path, "Notes/Fixture.md");
  assert.equal(good.value.results[0].score, 1);
  assert.equal((await doctor()).reasonCode, "ready");
  for (const [mode, reason] of [
    ["failure", "semantic_query_embedding_failed"],
    ["dimension", "semantic_query_vector_invalid"],
    ["zero", "semantic_query_vector_invalid"],
  ]) {
    behavior = mode;
    const bad = await call();
    assert.equal(bad.response.isError, true);
    assert.equal(bad.value.error.details.reasonCode, reason);
    assert.doesNotMatch(
      JSON.stringify(bad),
      /PRIVATE-query|PRIVATE-provider-detail/,
    );
    assert.equal((await doctor()).reasonCode, "semantic_embedder_unavailable");
  }
  behavior = "ok";
  await call();
  assert.equal((await doctor()).available, true);
  const { semanticSearchHealth, recordSemanticSearch } = await import(
    dist + "services/semanticSearchHealth.js"
  );
  const embed = async () => [1, 0];
  recordSemanticSearch(embed, 2, true, 100);
  assert.equal(semanticSearchHealth(embed, 2, 60101), "unverified");
  assert.equal(semanticSearchHealth(embed, 3, 101), "unverified");
  await writeFile(
    path.join(source, "embedding_models", "embedding_models.ajson"),
    '"embedding_models:ollama#bge":' +
      JSON.stringify({ provider_key: "transformers", model_key: modelName }),
    "utf8",
  );
  assert.equal((await doctor()).reasonCode, "semantic_embedder_unavailable");
  const builtIn = await call();
  assert.equal(builtIn.response.isError, true);
  assert.equal(
    builtIn.value.error.details.reasonCode,
    "semantic_embedder_configuration_invalid",
  );
  console.log(
    "PASS: semantic MCP BGE via Ollama, built-in provider refusal, ranking, diagnostics and recovery; no provider call from doctor",
  );
} finally {
  await client.close();
  await server.close();
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
  getSemanticCacheService().db.close();
  await rm(root, { recursive: true, force: true });
}
