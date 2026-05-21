# Optimike Obsidian MCP

French version: [README.fr.md](README.fr.md)
Operations guide: [OPERATIONS.md](OPERATIONS.md)
Guide d’exploitation (FR): [OPERATIONS.fr.md](OPERATIONS.fr.md)

![Optimike Obsidian MCP hero](docs/assets/hero-optimike-obsidian-mcp.png)

MCP (Model Context Protocol) server for Obsidian with shared local caching, integrated Tasks tools, and semantic search powered by Smart Connections.

## TL;DR

```bash
npm install
npm run build
node dist/stdio-proxy.js
```

Recommended for Codex: point your MCP config to `dist/stdio-proxy.js`, not directly to `dist/index.js`.

## Prerequisites

- Node.js >= 22.7.5
- Obsidian Desktop for `live` mode. Headless modes only require a local vault path.
- Plugins:
  - Local REST API (required for REST tools): https://github.com/coddingtonbear/obsidian-local-rest-api
  - Smart Connections (required for semantic search): https://github.com/brianpetro/obsidian-smart-connections
  - Bases Bridge (REST) (required for `.base` tools, bundled in this repo)
  - Obsidian Tasks plugin (required for canonical Tasks behavior)
- For semantic search, make sure your vault has a `.smart-env` folder

## Installation

From source:

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
```

Run the recommended local MCP entrypoint:

```bash
node dist/stdio-proxy.js
```

## Why

- Connect Obsidian to MCP agents (Codex, IDEs, etc.)
- Expose Obsidian REST tools (read/write, frontmatter, tags, search)
- Provide local vector search via Smart Connections (`.smart-env`)
- Keep one durable local backend instead of re-spawning heavy state on every stdio run

## What it can do

Optimike Obsidian MCP gives agents a structured way to work with an Obsidian vault:

- read, list, update, and search notes
- manage frontmatter and tags
- query and update Obsidian Bases through the bundled Bases Bridge
- inspect and query Obsidian Tasks
- run semantic search against a Smart Connections index
- check server health, cache state, degraded mode, and write policy

In short: it does more than read notes. It exposes the vault as an operational MCP surface, with read/write tools, structured metadata operations, Tasks, Bases, semantic search, and server health/status observability.

## Shared backend use

The durable backend is useful in local setups, but it becomes especially valuable in shared or remote backend setups.

Instead of syncing and indexing the vault separately for every agent client, clients can talk to one MCP backend that owns the cache, semantic metadata, task cache, and Obsidian operations. The backend still needs access to the vault itself, a mounted vault path, or the Obsidian REST API, but the agent clients do not each need their own full vault sync or indexing layer.

This makes the MCP a practical boundary between agents and Obsidian: agents call tools, the backend handles the vault.

## Highlights

- Complete MCP toolset (notes, frontmatter, tags, global search, etc.)
- Integrated Tasks tools: `list_all_tasks` and `query_tasks`
- Local semantic search `smart_semantic_search`
- Server health/status tools: `obsidian_runtime_status` and `obsidian_runtime_maintenance`
- Read-only degraded mode for `obsidian_read_note` and `obsidian_list_notes` when Obsidian REST is down
- Shared SQLite store for vault content, task cache, and semantic manifest data
- Embedder‑agnostic: query embedding aligned to the vault model
- Ollama / OpenAI support (env overrides); Xenova / Transformers is disabled until its vulnerable ONNX/protobuf chain can be safely reintroduced

## Architecture (overview)

1) **Obsidian** + plugins (Local REST API, Bases Bridge, Smart Connections)  
2) **Optimike Obsidian MCP** (this server)  
3) **MCP Agents** (Codex, IDEs, etc.)

The server acts as a **bridge** between agents and Obsidian, adds a “Base” layer for `.base` files, and persists shared runtime state locally so Codex can stay fast and stable across runs.

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
- `bases_upsert_config` : validate or update base YAML/JSON config
- `bases_create` : create/validate a `.base`

## Final Runtime Model

The repo supports two local runtime modes:

- `stdio proxy` (recommended for Codex): a lightweight stdio process that auto-starts a local Streamable HTTP backend if needed
- `http backend`: the actual long-lived backend process that owns the heavy cache / warmup work

The backend persists vault content to a shared SQLite store and keeps only a bounded hot set in RAM. By default the cache lives at:

```text
<vault>/.obsidian/optimike-mcp/shared-cache.sqlite
```

The same database also stores:

- `file_cache` for note content
- `task_file_cache` for parsed Tasks data
- `semantic_manifest` and `semantic_vectors` for semantic metadata

If `OBSIDIAN_VAULT` is not set, the server falls back to the parent vault inferred from `SMART_ENV_DIR`, then to the project root.

Useful env overrides:

- `OBSIDIAN_RUNTIME_MODE=live|hybrid|headless-readonly|headless-guarded` to choose the runtime contract
- `OBSIDIAN_SHARED_CACHE_DB_PATH` to move the shared SQLite file
- `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT` to tune the bounded in-memory hot set
- `OBSIDIAN_CACHE_SOURCE=auto|filesystem|rest` to choose cache refresh source (`auto` prefers the local vault path when available)
- `OBSIDIAN_CACHE_CONCURRENCY` to bound local filesystem refresh work
- `OBSIDIAN_VAULT_EXCLUDE_PATTERNS` to add comma- or newline-separated gitignore-style exclusions on top of the built-in vault safety policy
- `MCP_WRITE_MODE=readonly|guarded|full` to enforce server-side write safety (`full` is the default; set `guarded` or `readonly` explicitly to harden a host)
- `MCP_GUARDED_MAX_WRITE_CHARS` and `MCP_GUARDED_MAX_BATCH_OPERATIONS` to tune guarded-mode limits

For production-like tests on a real vault, set `OBSIDIAN_SHARED_CACHE_DB_PATH` outside the vault so validation databases do not pollute the synced note tree.

Vault exclusion policy:

- Built-in filesystem/cache exclusions cover `.obsidian`, `.trash`, `.git`, `.tmp`, `tmp`, `node_modules`, screenshots folders, build/cache folders, SQLite/DB files, and log files.
- `OBSIDIAN_VAULT_EXCLUDE_PATTERNS` lets an operator add project-specific exclusions, for example `tmp/**,**/tmp/**,Efforts/Archives/**`.
- Exclusions apply to filesystem cache refreshes and local Bases fallback scans. They do not claim Desktop parity and they do not stop Obsidian Sync itself from downloading files; use a clean server vault or Sync-side hygiene for that.
- `npm run check:vault-exclusions -- --vault=/path/to/vault` prints the policy effect before running a long headless validation.

This runtime exposes the Tasks surface directly from the main MCP, so Codex no longer needs a second dedicated `optimike-obsidian-tasks-mcp` entry when using this server.
Warm semantic refreshes now load from SQLite first instead of re-reading the whole `.smart-env` path every time.

## Runtime modes

- `live` (default): Obsidian Desktop + Local REST API. Full REST, write, and Bases Bridge surface.
- `hybrid`: starts from the local vault/cache and uses Local REST API when `OBSIDIAN_API_KEY` is configured. The API startup check is non-blocking. If no API key is configured, `OBSIDIAN_VAULT` is required.
- `headless-readonly`: no Obsidian Desktop, no Local REST API, no `OBSIDIAN_API_KEY`. Requires `OBSIDIAN_VAULT` and `OBSIDIAN_CACHE_SOURCE=filesystem`; exposes read/list/search/tasks/semantic/runtime tools plus local readonly `bases_list`, `bases_get_schema`, and `bases_query`.
- `headless-guarded`: no Obsidian Desktop; exposes the headless read surface plus guarded filesystem writes for `obsidian_update_note`, `obsidian_search_replace`, and `obsidian_manage_frontmatter`. Note updates are append/prepend only; overwrite remains blocked by the guarded write policy. Local readonly Bases fallback is also available.

Headless means Optimike MCP running over a synchronized Markdown vault. It does not mean Obsidian Desktop, community plugins, command palette, active file, or Bases Bridge are available without Desktop.

Smoke tests and runtime contract:

```bash
npm run test:runtime
npm run smoke:headless-readonly
npm run smoke:hybrid-unavailable
npm run smoke:hybrid-api-available
npm run smoke:headless-guarded
npm run smoke:headless-status
npm run check:vault-exclusions -- --vault=/path/to/vault
```

`npm run test:runtime` runs the build, all runtime mode smokes, and the HTTP health/status smoke. It uses temporary vaults and does not require a real Obsidian vault or API key. The headless smokes also assert that excluded `tmp/**` content is not indexed.

For a mode-by-mode comparison, see [Runtime Capability Matrix](docs/runtime-capability-matrix.md).

Local Bases fallback:

- `bases_list`, `bases_get_schema`, and `bases_query` are available in headless modes with `source: "local-fallback"`.
- The fallback reads `.base` YAML from `OBSIDIAN_VAULT` and cached Markdown frontmatter from the shared cache.
- It supports direct equality filters, simple sorting, pagination, and schema inspection.
- It does not evaluate Obsidian formulas, plugin-specific filters, calculated properties, or exact UI view semantics.

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

Extended health / maintenance:

- `GET /healthz?integrity=1` adds a SQLite integrity check
- MCP tool `obsidian_runtime_status` returns process, cache, semantic, and degraded-mode status
- MCP tool `obsidian_runtime_maintenance` supports:
  - `integrity_check`
  - `run_maintenance`
  - `refresh_vault_cache`
  - `refresh_semantic_cache`
  - `refresh_tasks_cache`
  - `refresh_all`

Runtime write safety:

- `readonly` blocks all write tools except validation-only operations
- `guarded` allows bounded explicit writes and blocks destructive operations such as delete, overwrite, frontmatter unset, broad regex replace-all, and large batches
- `full` is the default and keeps unrestricted write behavior for trusted local environments

Guarded filesystem writes support optional `expectedHash` and `expectedMtime` preconditions. Use `expectedHash` for multi-agent or synced-vault writes so stale updates fail as explicit conflicts instead of overwriting newer content.

Agent-context controls:

- `obsidian_list_notes` supports `responseMode="compact"`, `limit`, and `cursor`
- `obsidian_global_search` supports `responseMode="compact"` while keeping existing page/pageSize pagination
- `list_all_tasks` and `query_tasks` support `responseMode="compact"|"detailed"`, `responseLimit`, and `cursor`
- reading an identified note remains full-fidelity through `obsidian_read_note`

Typical checks:

```bash
curl http://127.0.0.1:3010/healthz
curl http://127.0.0.1:3010/healthz?integrity=1
```

## Minimal Codex Config

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

## Obsidian Local REST API Setup

Local REST API plugin repo:
https://github.com/coddingtonbear/obsidian-local-rest-api

In Obsidian:

1. install and enable **Local REST API**
2. enable the HTTP server
3. copy the API key
4. set `OBSIDIAN_BASE_URL` and `OBSIDIAN_API_KEY` in your MCP env

Example:

```bash
export OBSIDIAN_BASE_URL=http://127.0.0.1:27123
export OBSIDIAN_API_KEY=<your_api_key>
```

## Security

- Keep `OBSIDIAN_API_KEY` private and local.
- Do not expose the Obsidian REST API to the public internet.
- Keep `OBSIDIAN_API_KEY` and `OPENAI_API_KEY` in environment variables, not committed config files.

## WSL2 + Obsidian on Windows (Local REST API)

If Obsidian runs on Windows and Codex runs in WSL2:

- `127.0.0.1` from WSL points to WSL, not Windows
- use the Windows host IP (the WSL gateway) for `OBSIDIAN_BASE_URL`

Example:

```bash
GW=$(ip route | awk '/default/ {print $3; exit}')
export OBSIDIAN_BASE_URL=http://$GW:27123
```

If you use a Windows portproxy, adapt the port accordingly.

## Main MCP Surface

The main MCP now includes:

- note tools: read, list, update, search-replace, tags, frontmatter
- Bases tools: list, schema, query, create, upsert config, upsert rows
- Tasks tools: `list_all_tasks`, `query_tasks`
- semantic tools: `smart_semantic_search`, `smart_search`, `smart-search`
- server health/status tools: `obsidian_runtime_status`, `obsidian_runtime_maintenance`

## Tasks Integration

The main MCP now owns the Tasks surface directly.

What this means:

- Codex does not need a separate `optimike-obsidian-tasks-mcp` entry anymore
- `list_all_tasks` and `query_tasks` are exposed by this main server
- parsed task data is persisted in `task_file_cache` inside the shared SQLite database

Dependencies for Tasks support:

- Obsidian vault access
- shared cache database
- Obsidian Tasks plugin configuration file at:

```text
<vault>/.obsidian/plugins/obsidian-tasks-plugin/data.json
```

How it works:

1. note content is indexed in `file_cache`
2. task parsing reuses that content instead of rescanning the vault from scratch
3. parsed tasks are stored in `task_file_cache`
4. `list_all_tasks` and `query_tasks` reuse that persisted layer

This gives you one MCP surface, one runtime, and one durable local data path.

## Required and useful Obsidian plugins

Required depending on the MCP surfaces you use:
- **Local REST API**: Obsidian API used by MCP.
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
- persists a semantic manifest in SQLite for faster warm refreshes
- prewarms semantic search on startup by loading the snapshot and warming the query embedder
- returns `timings_ms`, `vector_count`, and `filtered_count` for operational diagnosis

Important:
- semantic query execution still requires a reachable query embedder provider
- if the vault was built with Ollama embeddings, an unreachable Ollama instance will produce a clear error instead of a silent hang
- set `SEMANTIC_SEARCH_PREWARM=false` to disable startup prewarm

That means:

- the semantic metadata path is now durable and observable
- the final query still depends on a live embedding provider at request time

## Providers (optional override)

**Ollama (local)**

```bash
export QUERY_EMBEDDER=ollama
export QUERY_EMBEDDER_MODEL=snowflake-arctic-embed2
export OLLAMA_BASE_URL=http://127.0.0.1:11434
```

**Xenova / Transformers**

The local Xenova provider is disabled for now because its ONNX/protobuf dependency chain was affected by npm audit vulnerabilities. Use Ollama locally, or OpenAI in cloud mode.

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

## Legacy Tasks Repo

`optimike-obsidian-tasks-mcp` can still exist as a legacy standalone repo, but Codex no longer needs it when using this main server. The main MCP is now the canonical surface.

## More Documentation

- Product overview and install: this README
- Runtime and maintenance guide: [OPERATIONS.md](OPERATIONS.md)

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
