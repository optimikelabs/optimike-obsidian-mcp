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

## Note read provenance

In all three headless modes, `obsidian_runtime_status` identifies the runtime
mode and reports `headlessRead.source: "filesystem"`. The server reads
from its local filesystem cache without a live Obsidian connection.
`headlessRead.refreshing` shows whether a scan is queued or running.
`headlessRead.newestFileMtimeMs` is the latest modification time among indexed
Markdown files in this process's index, or `null` for an empty index.
`sharedCache.lastRefreshAt` is the completion time of the last successful
refresh known to that index. `headlessRead.lastSuccessfulRefreshStartedAt`
records when that scan began. It is `null` when start evidence is unavailable,
including older SQLite snapshots. `headlessRead.refreshOrigin` identifies the evidence as
`"process-refresh"` or `"startup-snapshot"`, loaded from SQLite at startup.
Each process keeps its own checkpoint across other servers' scans.
Timestamps use milliseconds since the Unix epoch.

`obsidian_read_note`, `obsidian_list_notes` and `obsidian_global_search`
include one `provenance` object on successful reads and cache availability
errors when the headless cache is enabled, including in compact mode.
It contains `source: "filesystem"`, `refreshOrigin` when known,
`lastSuccessfulRefreshStartedAt`, and `lastRefreshAt`. `partial: true`
means results may be incomplete. It also appears when a cold-cache request
waits for a full scan. `refreshing: true` flags refresh activity during the
request, including a scan that finishes before the reply.

Use `now − lastSuccessfulRefreshStartedAt` for the window of disk changes
a scan may have missed because of timing, including immediately after a
restart that reuses its SQLite snapshot. A file can change after its own
read and before the scan completes. Files may be observed at different times,
and this window describes scan timing only.

MCP status, note reads, `/readyz` and `/statusz` report
`upstreamSync: "unknown"`. HTTP status retains its existing `source`
classification and adds `readSource: "filesystem"` for the headless read
path. `freshnessScope: "local-cache"` limits HTTP age and staleness fields to
the local cache. Upstream synchronization health requires separate evidence.

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
- local Bases list and schema inspection are available. Base rows require
  Obsidian and the Bases Bridge. In headless mode, `bases_query` requires
  `property_only: true` for a [Markdown property scan](../OPERATIONS.md#required-dependencies).

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

See [Runtime Modes](../OPERATIONS.md#runtime-modes) for same-file write ordering,
conflict detection, and the remaining race with other processes.

Never use this phase to edit existing production notes until the server profile has its own rollback and monitoring story.

## Server Go/No-Go

Go when `test:runtime`, `smoke:headless-server-profile`, a short then longer long-run validation, and `npm pack --dry-run` are green. No-go if the server vault still shares the live Desktop location, the cache lives inside the vault, or writes are enabled before snapshot/rollback.
