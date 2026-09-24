Embedding-agnostic notes for optimike-obsidian-mcp

What this adds

- QUERY_EMBEDDER=auto (default): query embedding selects a supported provider from the active Smart Connections model metadata in Smart Environment v3.
- QUERY_EMBEDDER can be forced to: ollama | openai
- QUERY_EMBEDDER_MODEL can force the model name/id
- Xenova / Transformers is disabled for now because its ONNX/protobuf dependency chain was affected by npm audit vulnerabilities. A Transformers index is reported as unavailable for MCP semantic queries; the index remains untouched.

Smart Environment v3 stores separate vectors for each embedding model. The MCP reads the current `embedding_models.default_model_key`, looks up its `provider_key`, model name and dimensions, then loads only its matching vectors. An Ollama model name containing `/` (for example `TaylorAI/bge-micro-v2`) stays on Ollama when its selected registry entry says `provider_key: ollama`. The same model name selected under `provider_key: transformers` cannot currently be queried by this MCP.

| Smart Connections setting | MCP semantic query |
| --- | --- |
| Ollama, with the selected model installed and reachable | Supported |
| OpenAI or a compatible embedding endpoint, with matching credentials and dimensions | Supported through the OpenAI adapter |
| Built-in local model (`provider_key: transformers`), including BGE Micro | Index is readable; query embedding is unavailable in the MCP |

Smart Connections can search its own built-in model index inside Obsidian. That does not imply this separate MCP process can call the plugin's in-process model. The MCP does not substitute Ollama for a built-in model, even if the model name and vector size look similar.

The query provider must be reachable and have the selected model installed. An existing index alone does not make query embedding available. Model switches may take up to `SMART_ENV_CACHE_TTL_MS` for the MCP snapshot to refresh. Do not delete older model indexes to switch models.
An unrecognized Smart Connections provider fails closed in `auto` mode; configure a supported query provider explicitly only when it produces vectors compatible with the selected index.

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
