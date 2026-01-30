# Optimike Obsidian MCP

French version: [README.fr.md](README.fr.md)

MCP (Model Context Protocol) server for Obsidian with semantic search powered by Smart Connections.

## TL;DR

```bash
npm install
npm run build
node dist/index.js --stdio
```

## Prerequisites

- Node.js >= 16
- Obsidian Desktop
- Plugins:
  - Local REST API (required for REST tools)
  - Smart Connections (required for semantic search)
  - Bases Bridge (REST) (required for .base tools, bundled in this repo)
- For semantic search, make sure your vault has a `.smart-env` folder (created by Smart Connections)

## Installation

From source:

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
```

Run:

```bash
node dist/index.js --stdio
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

## Minimal config (Codex)

In `~/.codex/config.toml`:

```toml
[mcp_servers.optimike-obsidian-mcp]
command = "node"
args = ["/ABSOLUTE/PATH/optimike-obsidian-mcp/dist/index.js", "--stdio"]

tool_timeout_sec = 900

[mcp_servers.optimike-obsidian-mcp.env]
# Smart Connections
SMART_ENV_DIR = "/ABSOLUTE/PATH/TO/YOUR/VAULT/.smart-env"
ENABLE_QUERY_EMBEDDING = "true" # optional (default: true)

# Recommended: auto (do not set)
# QUERY_EMBEDDER = "auto"

# Obsidian REST (if Local REST API plugin is active)
OBSIDIAN_BASE_URL = "http://localhost:27123"
OBSIDIAN_API_KEY  = "<token>"
```

## Obsidian Local REST API setup

Local REST API plugin repo:
https://github.com/coddingtonbear/obsidian-local-rest-api

In Obsidian, install and enable **Local REST API**.

1) Open the plugin settings  
2) Enable the HTTP server  
3) Copy the API key  
4) Set the base URL + key in your MCP env

Example:

```
OBSIDIAN_BASE_URL=http://127.0.0.1:27123
OBSIDIAN_API_KEY=<your_api_key>
```

Note: in WSL2, `127.0.0.1` points to WSL, not Windows.  
If Obsidian runs on Windows, use the host IP (see WSL section below).

## WSL2 + Obsidian on Windows (Local REST API)

If Obsidian runs on Windows and Codex runs in WSL2:

- `127.0.0.1` from WSL points to WSL, not Windows.
- Use the Windows host IP (WSL gateway) for `OBSIDIAN_BASE_URL`.

Example (WSL):

```bash
GW=$(ip route | awk '/default/ {print $3; exit}')
export OBSIDIAN_BASE_URL=http://$GW:27123
```

If you use a Windows portproxy (e.g. `27124` → `27123`), then set:

```bash
export OBSIDIAN_BASE_URL=http://$GW:27124
```

## Obsidian companions (recommended)

Plugins required for full functionality:
- **Local REST API**: Obsidian API used by MCP.
- **Bases Bridge (REST)**: `.base` support via REST.
- **Smart Connections**: vector index and `.smart-env` for semantic search.

### Bases Bridge (REST) — bundled in this repo

This repo includes the plugin under `plugins/obsidian-bases-bridge`.

Local install (Obsidian):

1) Copy `plugins/obsidian-bases-bridge` to your vault:  
   `<vault>/.obsidian/plugins/obsidian-bases-bridge`
2) In Obsidian: Settings → Community plugins → enable **Obsidian Bases Bridge**

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

More details: README_EMBEDDERS.md

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

## Troubleshooting (quick)

- WSL2 + Obsidian on Windows: use the Windows host IP for `OBSIDIAN_BASE_URL` (see WSL section).
- No `.smart-env`: run Smart Connections to build embeddings, or set `ENABLE_QUERY_EMBEDDING=false`.
- Wrong embedder: keep auto mode, or set `QUERY_EMBEDDER` + `QUERY_EMBEDDER_MODEL` (see README_EMBEDDERS.md).

## Credits

- Created by **Optimike** (Mickaël Ahouansou)
- Technical base inspired by `cyanheads/obsidian-mcp-server`
- Local REST API plugin: `coddingtonbear/obsidian-local-rest-api`
- Semantic search powered by Smart Connections: `brianpetro/obsidian-smart-connections`

## License

See `LICENSE`.
