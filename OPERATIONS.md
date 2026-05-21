# Optimike Obsidian MCP Operations Guide

French version: [OPERATIONS.fr.md](OPERATIONS.fr.md)

![Optimike Obsidian MCP runtime architecture](docs/assets/runtime-architecture-optimike-obsidian-mcp.png)

This guide explains how the server actually runs, what it depends on, how Tasks and semantic search work, and what keeps the runtime memory footprint low.

## Runtime Model

The final runtime uses two layers:

1. `dist/stdio-proxy.js`
   - short-lived stdio wrapper for Codex and similar MCP clients
   - starts or reuses the local backend
   - keeps the MCP client side cheap
2. `dist/index.js` in HTTP mode
   - long-lived local backend
   - owns the shared SQLite store
   - owns cache refresh, degraded mode, and runtime health

This is the main reason the server now uses much less memory in Codex sessions: heavy vault state is no longer rebuilt inside every stdio child process.

## What Lives On Disk

Default shared store:

```text
<vault>/.obsidian/optimike-mcp/shared-cache.sqlite
```

The shared store contains:

- `file_cache`: persisted note content and metadata
- `task_file_cache`: parsed Tasks data reused by `list_all_tasks` and `query_tasks`
- `semantic_manifest`: semantic metadata used to avoid unnecessary `.smart-env` rescans
- `semantic_vectors`: persisted vector-side metadata

What stays in RAM:

- only the active backend process
- a bounded hot content cache
- small runtime state for degraded mode, semantic readiness, and recent refreshes

## How Memory Is Kept Low

The final design reduces memory usage in four ways:

1. `stdio` is now cheap

   - Codex talks to `stdio-proxy.js`
   - the heavy backend is reused instead of respawned

2. note content is persisted

   - the server does not keep the whole vault hot in memory
   - note content is loaded from SQLite first, then from disk or REST only when needed

3. Tasks reuse the same persisted content

   - task parsing reads from shared cached note content
   - the server avoids a second brute-force scan path for a separate Tasks MCP

4. semantic refreshes are incremental
   - semantic metadata is persisted
   - warm refreshes consult SQLite first instead of fully rebuilding from `.smart-env`

Useful tuning:

- `OBSIDIAN_RUNTIME_MODE=live|hybrid|headless-readonly|headless-guarded`
- `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT`
- `OBSIDIAN_SHARED_CACHE_DB_PATH`
- `OBSIDIAN_CACHE_SOURCE=auto|filesystem|rest`
- `OBSIDIAN_CACHE_CONCURRENCY`
- `OBSIDIAN_VAULT_EXCLUDE_PATTERNS`
- `MCP_WRITE_MODE=readonly|guarded|full`
- `MCP_GUARDED_MAX_WRITE_CHARS`
- `MCP_GUARDED_MAX_BATCH_OPERATIONS`
- `OBSIDIAN_STARTUP_BLOCKING=false` for faster non-blocking startup in WSL-heavy setups

Default write behavior is `MCP_WRITE_MODE=full`. Hosts that want a stricter public/runtime posture can explicitly set `MCP_WRITE_MODE=guarded` or `MCP_WRITE_MODE=readonly`; agents do not need to choose a mode per write.

For real-vault validation, keep `OBSIDIAN_SHARED_CACHE_DB_PATH` outside the synced vault. This lets you test readonly, hybrid, and guarded sandbox flows without adding validation databases to the vault itself.

## Vault exclusion policy

The server has a built-in exclusion policy for filesystem-backed runtime scans. It skips operational noise and unsafe validation material before indexing:

- `.obsidian`, `.trash`, `.git`
- `.tmp`, `tmp`, `node_modules`
- screenshot folders, build/cache folders, SQLite/DB files, and log files

Add local rules with `OBSIDIAN_VAULT_EXCLUDE_PATTERNS`, using comma- or newline-separated gitignore-style patterns. Example:

```bash
OBSIDIAN_VAULT_EXCLUDE_PATTERNS="tmp/**,**/tmp/**,Efforts/Archives/**"
npm run check:vault-exclusions -- --vault=/path/to/vault
```

This policy protects Optimike cache, search, Tasks, and local Bases fallback behavior. It does not stop Obsidian Headless/Sync from downloading files. For a durable server, use a pull-only copied vault first, then clean Sync-side content or use a server-specific vault/profile before any guarded write validation.

## Runtime Modes

- `live`: default full-power mode. Requires Obsidian Desktop + Local REST API + `OBSIDIAN_API_KEY`.
- `hybrid`: Local REST API is optional and non-blocking. If API credentials are configured, live tools are exposed; otherwise `OBSIDIAN_VAULT` is required and the server keeps the cache/filesystem read surface available.
- `headless-readonly`: requires `OBSIDIAN_VAULT`; does not require Obsidian Desktop, Local REST API, or `OBSIDIAN_API_KEY`; exposes read/list/search/tasks/semantic/runtime tools plus readonly local Bases fallback.
- `headless-guarded`: same headless read surface plus guarded filesystem writes for `obsidian_update_note`, `obsidian_search_replace`, and `obsidian_manage_frontmatter`. Note updates are append/prepend only; overwrite remains blocked by guarded policy. Readonly local Bases fallback is also available.

Operational rule: headless modes mean Optimike MCP over a synchronized Markdown vault. They do not load Obsidian community plugins or provide active file, command palette, or Bases Bridge without Desktop.

Runtime smokes:

```bash
npm run test:runtime
npm run smoke:headless-readonly
npm run smoke:hybrid-unavailable
npm run smoke:hybrid-api-available
npm run smoke:headless-guarded
npm run smoke:headless-status
npm run check:vault-exclusions -- --vault=/path/to/vault
```

`npm run test:runtime` is the durable local gate for this runtime family. It runs `npm run build`, all mode smokes, and the HTTP health/status smoke on temporary vaults. The headless smokes also check that excluded `tmp/**` content is not indexed.

The detailed mode comparison lives in [Runtime Capability Matrix](docs/runtime-capability-matrix.md).

## Required Dependencies

The final server can expose different capabilities depending on which Obsidian plugins and local services are available.

### Core Obsidian dependency

- Obsidian vault access through `OBSIDIAN_VAULT`

### Obsidian plugins

- Local REST API

  - used for most live Obsidian note operations
  - configured through `OBSIDIAN_BASE_URL` and `OBSIDIAN_API_KEY`

- Bases Bridge (REST)

  - required for live `.base` write support and full bridge-backed query behavior
  - exposes the Bases endpoints used by this MCP

- Local Bases fallback

  - available in headless modes for `bases_list`, `bases_get_schema`, and `bases_query`
  - returns `source: "local-fallback"`
  - supports direct equality filters, simple sorting, pagination, and schema inspection
  - does not evaluate formulas, plugin filters, calculated properties, or exact UI view semantics

- Smart Connections
  - required for semantic search
  - expected semantic artifacts live under:

```text
<vault>/.smart-env
```

- Obsidian Tasks plugin
  - required for canonical Tasks parsing behavior
  - expected config file:

```text
<vault>/.obsidian/plugins/obsidian-tasks-plugin/data.json
```

## Tasks: How It Works Now

Tasks are no longer a separate MCP requirement for Codex.

The main MCP now exposes:

- `list_all_tasks`
- `query_tasks`

Execution path:

1. note content is synchronized into `file_cache`
2. Tasks parsing reuses that content
3. parsed task data is written into `task_file_cache`
4. task queries reuse the persisted layer instead of rescanning the whole vault on the hot path

This means:

- one MCP entry in Codex
- one local backend
- one shared persisted data model

The legacy `optimike-obsidian-tasks-mcp` repo can still exist, but Codex does not need it when this server is used.

## Semantic Search: What Is Persisted and What Is Not

Semantic search is faster and more stable than before, but one dependency still remains live at query time.

Persisted:

- semantic manifest
- semantic vector metadata
- dominant dimension and related semantic cache state
- in-process semantic snapshot during `SMART_ENV_CACHE_TTL_MS`
- vector norms for faster repeated ranking

Still live at query time:

- the query embedding provider

Examples:

- if your vault semantic setup relies on Ollama, Ollama still needs to be reachable for semantic queries
- if Ollama is down, the MCP now returns a clean error instead of silently hanging

At startup, the backend prewarms semantic search by loading the semantic snapshot and sending a small embedding request to the configured provider. Disable it with `SEMANTIC_SEARCH_PREWARM=false`; override the warmup text with `SEMANTIC_SEARCH_PREWARM_TEXT`.

## Degraded Mode

If Obsidian REST is unavailable but the shared cache is warm, the backend can still serve read-only operations for:

- `obsidian_read_note`
- `obsidian_list_notes`

This is meant to keep the MCP useful when Obsidian is temporarily down, while still making the failure mode explicit.

If a first read/search request arrives while the filesystem cache is still building, the tool waits briefly for cache readiness and then returns cache stats if the vault is still unavailable. Use `obsidian_runtime_maintenance` with `refresh_all` as a manual readiness gate on large vaults.

## Health and Maintenance

### HTTP health

```bash
curl http://127.0.0.1:3010/healthz
curl http://127.0.0.1:3010/healthz?integrity=1
```

What you get:

- runtime mode
- runtime fingerprint: package version, git sha, Node.js version, `dist` paths, non-sensitive config hash
- degraded mode state
- cache stats
- semantic stats
- optional SQLite integrity result

### MCP runtime tools

- `obsidian_runtime_status`
- `obsidian_runtime_maintenance`

Supported maintenance actions:

- `integrity_check`
- `run_maintenance`
- `refresh_vault_cache`
- `refresh_semantic_cache`
- `refresh_tasks_cache`
- `refresh_all`

### Automated local verification

The local smoke script checks the runtime exactly as Codex uses it:

```bash
npm run smoke:runtime
```

It verifies:

- `/healthz?integrity=1`
- runtime fingerprint
- process freshness compared with the current `dist` files
- SQLite integrity
- tool discovery through MCP HTTP
- tool discovery through `stdio-proxy`

To verify code before a PR or merge:

```bash
npm run test:runtime
npm run verify:code
```

`npm run test:runtime` runs:

- `npm run build`
- headless readonly smoke
- hybrid without API smoke
- hybrid with mocked API smoke
- headless guarded smoke

`npm run verify:code` runs:

- `npm audit`
- `npm run build`

Then restart the backend if the build changed `dist`, and run:

```bash
npm run smoke:runtime
```

The smoke intentionally fails when the backend process is older than the current `dist` files.

## Minimal Codex Setup

Codex should point to:

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js"]
```

Important environment variables:

- `MCP_HTTP_HOST`
- `MCP_HTTP_PORT`
- `MCP_PROXY_START_TIMEOUT_MS`
- `OBSIDIAN_VAULT`
- `SMART_ENV_DIR`
- `OBSIDIAN_BASE_URL`
- `OBSIDIAN_API_KEY`

Recommended startup behavior:

```toml
OBSIDIAN_STARTUP_BLOCKING = "false"
```

That keeps Codex startup responsive while the backend health check completes in the background.

## Troubleshooting

### Semantic search fails

Check:

- `SMART_ENV_DIR`
- query embedding provider availability
- runtime status via `obsidian_runtime_status`

### Tasks results look stale

Run:

- `obsidian_runtime_maintenance` with `refresh_tasks_cache`

### Notes can be read but live updates fail

Likely state:

- degraded read mode is active
- Obsidian REST is down or unreachable

Check:

- `OBSIDIAN_BASE_URL`
- Local REST API plugin
- `obsidian_runtime_status`

### Memory usage climbs too high

Check:

- whether clients point to `dist/stdio-proxy.js` instead of `dist/index.js`
- hot cache limit via `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT`
- whether another old MCP backend is still running

## Recommended Mental Model

Think of the server as:

- one MCP surface
- one reusable backend
- one shared persisted local state
- optional live semantic provider

That is the final intended shape of the product.
