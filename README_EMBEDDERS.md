Embedding-agnostic notes for optimike-obsidian-mcp

What this adds
- QUERY_EMBEDDER=auto (default): query embedder auto-matches the vault embedding model found in .smart-env
- QUERY_EMBEDDER can be forced to: ollama | openai
- QUERY_EMBEDDER_MODEL can force the model name/id
- Xenova / Transformers is disabled for now because its ONNX/protobuf dependency chain was affected by npm audit vulnerabilities.

Ollama settings
- OLLAMA_BASE_URL (default: http://127.0.0.1:11434)

OpenAI settings
- OPENAI_API_KEY (required if QUERY_EMBEDDER=openai)
- OPENAI_BASE_URL (optional)
- OPENAI_EMBEDDING_DIMENSIONS (optional, integer)

Recommended default (hands-off)
- Do NOT set QUERY_EMBEDDER.
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
