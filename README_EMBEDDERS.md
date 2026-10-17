Embedding-agnostic notes for optimike-obsidian-mcp

What this adds

- QUERY_EMBEDDER=auto (default): query embedding selects a supported provider from the active Smart Connections model metadata in Smart Environment v3.
- QUERY_EMBEDDER can be forced to: transformers | ollama | openai
- QUERY_EMBEDDER_MODEL can force the model name/id
- The Smart Connections built-in model (`provider_key: transformers`) is queried locally through the optional `@huggingface/transformers` package, the same library Smart Connections uses. The former `@xenova/transformers` dependency stays removed: it is unmaintained and its ONNX/protobuf chain fails npm audit.

Smart Environment v3 stores separate vectors for each embedding model. The MCP reads the current `embedding_models.default_model_key`, looks up its `provider_key`, model name and dimensions, then loads only its matching vectors. An Ollama model name containing `/` (for example `TaylorAI/bge-micro-v2`) stays on Ollama when its selected registry entry says `provider_key: ollama`. The same model name selected under `provider_key: transformers` is queried with the built-in Transformers provider.

| Smart Connections setting | MCP semantic query |
| --- | --- |
| Ollama, with the selected model installed and reachable | Supported |
| OpenAI or a compatible embedding endpoint, with matching credentials and dimensions | Supported through the OpenAI adapter |
| Built-in local model (`provider_key: transformers`), including BGE Micro | Supported when the optional `@huggingface/transformers` package is installed |

The MCP does not call the plugin's in-process model: it loads the same model itself, with the query pooling, normalisation, prefix and revision Smart Connections uses for that model. Only the built-in models Smart Connections ships are accepted; an unknown built-in model is refused rather than queried with a guessed profile. The MCP does not substitute Ollama for a built-in model, even if the model name and vector size look similar.

The query provider must be reachable and have the selected model installed. An existing index alone does not make query embedding available. Model switches may take up to `SMART_ENV_CACHE_TTL_MS` for the MCP snapshot to refresh. Do not delete older model indexes to switch models.
An unrecognized Smart Connections provider fails closed in `auto` mode; configure a supported query provider explicitly only when it produces vectors compatible with the selected index.

Built-in model settings

- Install the optional package next to the MCP: `npm install @huggingface/transformers`. Without it, a built-in index is reported as unavailable and the error names the package.
- The model is downloaded from Hugging Face on first use (BGE Micro: about 66 MB), then cached locally. First use is the background startup prewarm, or the first semantic query when `SEMANTIC_SEARCH_PREWARM=false`. Diagnostics never load it.
- Queries run in fp32 on CPU. On a vault indexed by Smart Connections 4.7.2 with BGE Micro, this reproduced the plugin's top 3 and scores on 10 of 10 queries; q8 reordered the top 3. `scripts/compare-transformers-query-ranking.mjs` repeats this check on another vault.
- The package adds about 470 MB of dependencies (ONNX Runtime), which is why it is optional.

Ollama settings

- OLLAMA_BASE_URL (default: http://127.0.0.1:11434)

OpenAI settings

- OPENAI_API_KEY (required if QUERY_EMBEDDER=openai)
- OPENAI_BASE_URL (optional)
- OPENAI_EMBEDDING_DIMENSIONS (optional, integer)

Recommended default (hands-off)

- Do NOT set QUERY_EMBEDDER.
- Do NOT set QUERY_EMBEDDER_MODEL unless you must identify a model absent from `.smart-env`; an override must match the stored vectors exactly.
- Make sure .smart-env contains model metadata (Smart Connections usually writes it).

If your .smart-env does NOT store the model

- Set:
  QUERY_EMBEDDER=ollama
  QUERY_EMBEDDER_MODEL=snowflake-arctic-embed2
  OLLAMA_BASE_URL=http://127.0.0.1:11434

If your vault embeddings are built with Ollama snowflake-arctic-embed2

- Set:
  QUERY_EMBEDDER=ollama
  QUERY_EMBEDDER_MODEL=snowflake-arctic-embed2
  OLLAMA_BASE_URL=http://127.0.0.1:11434
