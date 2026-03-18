# Optimike Obsidian MCP

French version: [README.fr.md](README.fr.md)

MCP (Model Context Protocol) server for Obsidian with semantic search powered by Smart Connections.

## TL;DR

```bash
npm install
npm run build
node dist/stdio-proxy.js
```

## Why

- Connect Obsidian to MCP agents (Codex, IDEs, etc.)
- Expose Obsidian REST tools (read/write, frontmatter, tags, search)
- Provide local vector search via Smart Connections (`.smart-env`)

## Highlights

- Complete MCP toolset (notes, frontmatter, tags, global search, etc.)
- Local semantic search `smart_semantic_search`
- Embedder‑agnostic: query embedding aligned to the vault model
- Ollama / Xenova / OpenAI support (env overrides)

## Architecture (overview)

1) **Obsidian** + plugins (Local REST API, Bases Bridge, Smart Connections)  
2) **Optimike Obsidian MCP** (this server)  
3) **MCP Agents** (Codex, IDEs, etc.)

The server acts as a **bridge** between agents and Obsidian, and adds a “Base” layer for `.base` files.

## Bases Bridge (REST) — why & how

Obsidian has no native API for Bases (`.base`).  
The **Bases Bridge (REST)** plugin fills the gap by adding dedicated REST endpoints.

### Endpoints exposed by Bases Bridge

Official prefix (recommended):

- `GET /extensions/obsidian-bases-bridge/bases`  
  List all available bases.
- `GET /extensions/obsidian-bases-bridge/bases/:id/schema`  
  Return the schema (properties, formulas, views).
- `POST /extensions/obsidian-bases-bridge/bases/:id/query`  
  Query a base (filters, sorting, pagination, evaluate).
- `POST /extensions/obsidian-bases-bridge/bases/:id/upsert`  
  Bulk frontmatter upsert.
- `POST /extensions/obsidian-bases-bridge/bases`  
  Create/validate a `.base` file.
- `GET /extensions/obsidian-bases-bridge/bases/:id/config`  
  Read the base YAML.
- `PUT /extensions/obsidian-bases-bridge/bases/:id/config`  
  Update the base YAML.

Legacy aliases (MCP compat):

- `GET /bases`
- `GET /bases/:id/schema`
- `POST /bases/:id/query`
- `POST /bases/:id/upsert`
- `POST /bases`
- `GET /bases/:id/config`
- `PUT /bases/:id/config`

### Engine / Evaluate

When `evaluate: true`, the bridge returns:
- `source: "engine"`: auto‑cache + formula evaluation (no Bridge view)
- `source: "fallback"`: partial on‑disk evaluation if engine is OFF

## MCP tools for Bases

This server exposes “Base” MCP tools:

- `bases_list` : list bases
- `bases_get_schema` : fetch schema
- `bases_query` : paged query with filters/sort
- `bases_upsert_rows` : bulk frontmatter update
- `bases_get_config` / `bases_upsert_config` : read/write YAML
- `bases_create` : create/validate a `.base`

## Runtime modes

The repo now supports two local runtime modes:

- `stdio proxy` (recommended for Codex): a lightweight stdio process that auto-starts a local Streamable HTTP backend if needed
- `http backend`: the actual long-lived backend process that owns the heavy cache / warmup work

The backend now persists vault content to a shared SQLite cache and keeps only a bounded hot set in RAM. By default the cache lives at:

```text
<vault>/.obsidian/optimike-mcp/shared-cache.sqlite
```

If `OBSIDIAN_VAULT` is not set, the server falls back to the parent vault inferred from `SMART_ENV_DIR`, then to the project root.

Useful env overrides:

- `OBSIDIAN_SHARED_CACHE_DB_PATH` to move the shared SQLite file
- `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT` to tune the bounded in-memory hot set

Useful scripts:

```bash
npm run build
npm run start:proxy
npm run start:http
```

Health endpoint when running the backend directly:

```bash
curl http://127.0.0.1:3010/healthz
```

## Minimal config (Codex)

In `~/.codex/config.toml`:

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js"]

tool_timeout_sec = 900

[mcp_servers.optimike-obsidian-mcp-stdio.env]
MCP_HTTP_HOST = "127.0.0.1"
MCP_HTTP_PORT = "3010"
MCP_PROXY_START_TIMEOUT_MS = "20000"
OBSIDIAN_VAULT = "/path/to/<vault>"

# Smart Connections
SMART_ENV_DIR = "/path/to/<vault>/.smart-env"
ENABLE_QUERY_EMBEDDING = "true"

# Recommended: auto (do not set)
# QUERY_EMBEDDER = "auto"

# Obsidian REST (if Local REST API plugin is active)
OBSIDIAN_BASE_URL = "http://localhost:27123"
OBSIDIAN_API_KEY  = "<token>"

# Startup behavior (optional, recommended for faster startup in WSL setups)
# OBSIDIAN_STARTUP_BLOCKING=false starts MCP immediately and runs health check in background.
OBSIDIAN_STARTUP_MAX_RETRIES = "2"
OBSIDIAN_STARTUP_RETRY_DELAY_MS = "1200"
OBSIDIAN_STARTUP_BLOCKING = "false"

# Shared cache tuning (optional)
# OBSIDIAN_SHARED_CACHE_DB_PATH = "/path/to/<vault>/.obsidian/optimike-mcp/shared-cache.sqlite"
# OBSIDIAN_CONTENT_HOT_CACHE_LIMIT = "64"
```

Notes:
- Keep this config local in `~/.codex/config.toml` (do not commit personal machine paths).
- Use logical placeholders in documentation (`/path/to/...`) and keep real paths only in local config.
- `dist/index.js` is still the backend entrypoint, but Codex should point to `dist/stdio-proxy.js`.

## Obsidian companions (recommended)

Plugins required for full functionality:
- **Local REST API**: Obsidian API used by MCP.
- **MCP Tools** (Jack Steam): exposes MCP tools in Obsidian.
- **Bases Bridge (REST)**: `.base` support via REST.
- **Smart Connections**: vector index and `.smart-env` for semantic search.

## Semantic search (Smart Connections)

Tool: `smart_semantic_search` (aliases: `smart_search`, `smart-search`).

Example:

```json
{ "query": "publication X threads", "top_k": 10, "with_snippets": false }
```

The server:
- reads `.smart-env/multi/*.ajson`
- selects the dominant dimension
- embeds the query with the same model as the vault

## Providers (optional override)

**Ollama (local)**

```bash
export QUERY_EMBEDDER=ollama
export QUERY_EMBEDDER_MODEL=snowflake-arctic-embed2
export OLLAMA_BASE_URL=http://127.0.0.1:11434
```

**Xenova (Transformers)**

```bash
export QUERY_EMBEDDER=xenova
export QUERY_EMBEDDER_MODEL_HINT=bge-384   # or e5 / snowflake / etc.
```

**OpenAI (cloud)**

```bash
export QUERY_EMBEDDER=openai
export QUERY_EMBEDDER_MODEL=text-embedding-3-small
export OPENAI_API_KEY=...
# export OPENAI_EMBEDDING_DIMENSIONS=1024
```

## MCP sharing: portability

For shared MCP setups, avoid hard‑coding `OLLAMA_BASE_URL` inside the vault.
Keep auto mode and let each user override via env vars.

## WSL + Ollama Windows (recommended)

If Obsidian runs on Windows and Ollama too:

1) set `OLLAMA_HOST=0.0.0.0:11434` on Windows
2) restart Ollama
3) test from WSL:

```bash
GW=$(ip route | awk '/default/ {print $3; exit}')
curl http://$GW:11434/api/tags
```

Then, if needed:

```bash
export OLLAMA_BASE_URL=http://$GW:11434
```

## Credits

- Created by **Optimike** (Mickaël Ahouansou)
- Technical base inspired by `cyanheads/obsidian-mcp-server`

## License

See `LICENSE`.
