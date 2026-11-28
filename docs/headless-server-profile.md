# Headless Server Profile

French version: [headless-server-profile.fr.md](headless-server-profile.fr.md)

Related docs: [README](../README.md), [Operations](../OPERATIONS.md), [Runtime Capability Matrix](runtime-capability-matrix.md), [MCP Routing Guide](mcp-routing-guide.md), [Linux Headless Multi-client Pilot](headless-multiclient-pilot.md)

This profile is for a dedicated server or copied Sync vault. It keeps the stable release posture: read-only first, guarded writes only after the read-only profile is proven.

## Contract

- Use a dedicated or copied vault, not the live desktop vault.
- Keep Obsidian Headless Sync in `pull-only` for the first server validation.
- Keep Optimike MCP in `headless-readonly` until list/read/search/tasks/Bases/status are green.
- Keep MCP cache outside the synchronized vault.
- Use vault exclusions for operational noise, but do not rely on them to stop Obsidian Sync downloads.
- Do not claim Desktop parity. Move/delete, frontmatter or inline tags, batch frontmatter, minimal Bases writes, format validation, and minimal Canvas helpers exist as bounded filesystem/local features, not as Obsidian Desktop behavior.

## Environment

An adaptable example is provided in `.env.server.example`.

```bash
OBSIDIAN_RUNTIME_MODE=headless-readonly
OBSIDIAN_VAULT=/path/to/dedicated-or-copied-vault
OBSIDIAN_CACHE_SOURCE=filesystem
OBSIDIAN_SHARED_CACHE_DB_PATH=/path/outside/vault/shared-cache.sqlite
OBSIDIAN_ENABLE_CACHE=true
MCP_WRITE_MODE=readonly
OBSIDIAN_VAULT_EXCLUDE_PATTERNS="tmp/**,**/tmp/**,**/screenshots/**,**/*screenshots*/**"
SEMANTIC_SEARCH_PREWARM=false
```

## Operon without Desktop

Set `MCP_TOOL_PROFILE=tasks` (or use `operational` or `full`). In all three headless modes, `operon_list_tasks`, `operon_query_tasks`, `operon_get_task`, `operon_find_tasks`, `operon_get_relationships`, `operon_get_configuration`, `operon_status`, and `operon_validate` read the synchronized copy. `operon_query_saved_filter` takes an exact ID from `operon_get_configuration`.

The reader scans cached Markdown for inline checkboxes with an `operonId` and `{{key:: value}}` fields, and file tasks identified by YAML frontmatter. A folder such as `_Operon` is a creation destination. An identified file task can live elsewhere. Task IDs, dates, recurrence rules and occurrence IDs, stored relationships, and managed fields come from those two formats. The reader ignores fenced examples and comments. Indentation alone does not assign a parent.

Sync `.obsidian/plugins/operon/data.json` as well as the notes. It supplies workflow pipelines, status IDs and terminal flags, priorities, key mappings, excluded folders, creation settings, and saved filters. Both flat settings and versioned packages (2 and 3) are supported. Without this file the reader can decode canonical fields, and the configuration and saved-filter tools report `operon_filesystem_configuration_missing`. The plugin manifest supplies the version when present. Pins can be read from the data package or the older `state/pinned-tasks.json` sidecar. Runtime indexes, active trackers, recurrence-series automation, reminder delivery, serial allocation, and calendar caches stay with the plugin.

The upstream [storage specification](https://www.operon.cc/docs/docs-046-plugin-data-and-state-files/) describes the plugin-side state, including separate recurrence and tracker JSON files, reminder delivery records, and the rebuildable runtime index.

Every filesystem read reports `source: "filesystem"`, `freshness`, `cacheStatus`, `lastRefreshAt`, `lastRefreshCompletedAt`, and `partial`. Treat `partial: true` as an incomplete index during startup, refresh, or a cache error. Where exposed, `forceRefresh` updates the shared index from disk. No Desktop or Sync liveness is implied by a completed refresh.

The finder uses local ranking and stored dates. Relationship reads expose stored edges and their derived inverses and hierarchy. Workflow validation, scores, tiers, checkbox progress, revision tokens, and native index projections may differ from Desktop. Native mutation authority, runtime relationship inference, live templates and active timers require Desktop. The compatibility timer tool returns `operon_filesystem_live_required`. Saved filters support nested groups over common checkbox, text, date, list, tag and persisted pin conditions with supported sorts. Runtime-dependent fields and unsupported operators or sorts return `operon_filesystem_filter_unsupported`. Relative dates use the server's time zone. Operon writes continue to require the live Bridge.

### Operon parity harness

Run `npm run build` and `npm run test:operon-headless` to exercise MCP against a synthetic vault and a stubbed Local REST Bridge. For a manual comparison, open a disposable copy in Desktop, enable Operon and its read-only Bridge, and wait for its index. Put a file named `operon-parity-copy.md` at the copy's root with a single line `operon-parity-copy: <new UUID>`. Set `OPERON_PARITY_LOCAL_REST_URL` to the loopback endpoint and `OPERON_PARITY_LOCAL_REST_KEY` to its key, then run:

```bash
node scripts/operon-headless-parity.mjs /path/to/disposable-vault-copy
```

Use `OPERON_PARITY_VERIFY_SSL=false` only for a self-signed loopback endpoint. The harness checks the marker through REST, uses private temporary caches, pages both versions of `operon_list_tasks`, and prints differing field names by task ID. Runtime versions, revision tokens, the source kind and filesystem mtime are excluded. A semantic difference gives a nonzero exit status. Keep the copy unchanged for the comparison.

## Validation

```bash
npm run build
npm run test:runtime
npm run test:http-headless-multiclient
HEADLESS_SERVER_VAULT=/path/to/dedicated-or-copied-vault \
HEADLESS_SERVER_CACHE_DIR=.tmp/headless-server-profile-cache \
npm run smoke:headless-server-profile
```

For long-run validation:

```bash
HEADLESS_SERVER_VAULT=/path/to/dedicated-or-copied-vault \
HEADLESS_SERVER_CACHE_DIR=/path/outside/vault/cache \
HEADLESS_LONG_RUN_MINUTES=120 \
HEADLESS_LONG_RUN_INTERVAL_SECONDS=60 \
npm run test:headless-long-run
```

The report is written to `.tmp/headless-long-run` by default, or to `HEADLESS_LONG_RUN_OUTPUT_DIR`.

The server-profile smoke checks that:

- the server starts in `headless-readonly`;
- write/live tools are not registered;
- `obsidian_runtime_maintenance refresh_all` works;
- runtime status reports readonly write policy;
- list/read/tasks run against the vault;
- local Bases fallback is available.

## Guarded Writes

Only after the read-only server profile is green:

1. Switch a copied or dedicated vault to `OBSIDIAN_RUNTIME_MODE=headless-guarded`.
2. Keep `MCP_WRITE_MODE=guarded`.
3. Create a new sandbox draft only.
4. Require `expectedHash` or `expectedMtime` for follow-up edits.
5. Confirm stale hash and traversal writes are blocked.

Before a write test, snapshot the dedicated vault:

```bash
HEADLESS_SERVER_VAULT=/path/to/dedicated-or-copied-vault npm run snapshot:vault
```

The snapshot is not a full backup strategy, but it gives a fast local rollback point for server tests.

## Filesystem Features

Only after the `headless-guarded` step, switch a copied or dedicated vault to `OBSIDIAN_RUNTIME_MODE=headless-filesystem`.

1. For move/delete, require `expectedHash` or `expectedMtime`.
2. For tags, limit the contract to Markdown text: YAML frontmatter `tags`, inline `#tags`, and cache-backed local index.
3. For batch frontmatter, keep dry-run as the default and allow only `set`.
4. For Bases, limit the contract to `.base` YAML files and Markdown frontmatter properties.
5. For Canvas, limit the contract to JSON Canvas structure: create, add text node, connect nodes, validate.
6. Validate with `npm run smoke:headless-filesystem`.

Never use this phase to edit existing production notes until the server profile has its own rollback and monitoring story.

## Server Go/No-Go

Go when `test:runtime`, `smoke:headless-server-profile`, a short then longer long-run validation, and `npm pack --dry-run` are green. No-go if the server vault still shares the live Desktop location, the cache lives inside the vault, or writes are enabled before snapshot/rollback.
