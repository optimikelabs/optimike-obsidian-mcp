import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSmartEnv } from "../dist/services/smartEnv.js";
import { detectSmartEnvQueryProvider } from "../dist/services/smartEnvV3.js";
import { getQueryEmbedder } from "../dist/adapters/embed/index.js";

const root = await mkdtemp(path.join(os.tmpdir(), "smart-env-v3-"));
try {
  await mkdir(path.join(root, "embedding_models"));
  await mkdir(path.join(root, "smart_sources"));
  await writeFile(
    path.join(root, "smart_env.json"),
    JSON.stringify({ embedding_models: { default_model_key: "ollama#qwen" } }),
    "utf8",
  );
  await writeFile(
    path.join(root, "embedding_models", "embedding_models.ajson"),
    '"embedding_models:ollama#qwen": ' +
      JSON.stringify({
        provider_key: "ollama",
        model_key: "qwen3-embedding:0.6b",
        dims: 1024,
        max_tokens: 32768,
      }),
    "utf8",
  );
  const fingerprint = "mf_1dq06jj";
  const record = (name, hash, readHash, index) =>
    `"smart_sources:Notes/${name}.md": ` +
    JSON.stringify({
      path: `Notes/${name}.md`,
      last_import: { hash },
      embedding: {
        default: {
          [fingerprint]: { file: fingerprint, file_i: index, read_hash: readHash },
        },
      },
    });
  await writeFile(
    path.join(root, "smart_sources", "smart_sources.ajson"),
    [record("Current", "same", "same", 0), record("Stale", "new", "old", 1)].join(",\n"),
    "utf8",
  );
  const binary = Buffer.alloc(2 * 1024 * 4);
  binary.writeFloatLE(0.25, 0);
  binary.writeFloatLE(0.75, 1024 * 4);
  await writeFile(path.join(root, "smart_sources", fingerprint), binary);
  await writeFile(
    path.join(root, "vectors.json"),
    JSON.stringify([{ path: "Legacy.md", embedding: [1, 0] }]),
    "utf8",
  );
  const vectors = await loadSmartEnv(root);
  assert.equal(vectors.length, 1, "current v3 sources supersede stale legacy data");
  assert.equal(vectors[0].notePath, "Notes/Current.md");
  assert.equal(vectors[0].vec.length, 1024);
  assert.equal(vectors[0].vec[0], 0.25);
  assert.equal(vectors[0].model, "qwen3-embedding:0.6b");
  assert.equal(await detectSmartEnvQueryProvider(root, vectors[0].model), "ollama");
  await writeFile(
    path.join(root, "embedding_models", "embedding_models.ajson"),
    [
      '"embedding_models:ollama#bge": ' + JSON.stringify({
        provider_key: "ollama", model_key: "TaylorAI/bge-micro-v2", dims: 384,
      }),
      '"embedding_models:transformers#bge": ' + JSON.stringify({
        provider_key: "transformers", model_key: "TaylorAI/bge-micro-v2", dims: 384,
      }),
    ].join(",\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "smart_env.json"),
    JSON.stringify({ embedding_models: { default_model_key: "ollama#bge" } }),
    "utf8",
  );
  const bgeModel = "TaylorAI/bge-micro-v2";
  const bgeProvider = await detectSmartEnvQueryProvider(root, bgeModel);
  assert.equal(bgeProvider, "ollama", "selected registry entry wins over the model name");
  const bgeSelection = await getQueryEmbedder({
    provider: "auto", vaultProvider: bgeProvider, vaultModel: bgeModel,
  });
  assert.equal(bgeSelection.provider, "ollama");
  assert.equal(bgeSelection.model, bgeModel);
  await writeFile(
    path.join(root, "smart_env.json"),
    JSON.stringify({ embedding_models: { default_model_key: "transformers#bge" } }),
    "utf8",
  );
  assert.equal(await detectSmartEnvQueryProvider(root, bgeModel), "transformers");
  await assert.rejects(
    getQueryEmbedder({
      provider: "auto", vaultProvider: "transformers", vaultModel: bgeModel,
    }),
    /xenova is disabled/u,
    "a Transformers index must not be queried with a different provider",
  );
  await assert.rejects(
    getQueryEmbedder({
      provider: "auto", vaultProvider: "unsupported-provider", vaultModel: bgeModel,
    }),
    /Unsupported Smart Connections query provider/u,
    "an unknown provider must not silently fall back to Ollama",
  );
  await rm(path.join(root, "smart_sources", fingerprint));
  await assert.rejects(
    loadSmartEnv(root),
    /No current Smart Environment v3 embeddings/,
    "an absent current-model index must not silently use legacy vectors",
  );
  await rm(path.join(root, "smart_sources"), { recursive: true });
  const legacy = await loadSmartEnv(root);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].notePath, "Legacy.md");
  console.log("PASS: current Smart Environment v3 vectors and legacy fallback");
} finally {
  await rm(root, { recursive: true, force: true });
}
