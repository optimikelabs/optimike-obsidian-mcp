# Headless Server Profile

French version: [headless-server-profile.fr.md](headless-server-profile.fr.md)

Related docs: [README](../README.md), [Operations](../OPERATIONS.md), [Runtime Capability Matrix](runtime-capability-matrix.md), [MCP Routing Guide](mcp-routing-guide.md), [Linux Headless Multi-client Pilot](headless-multiclient-pilot.md)

This profile is for a dedicated server or copied Sync vault. It keeps the stable release posture: read-only first, guarded writes only after the read-only profile is proven.

## Contract

- Use a dedicated or copied vault, not the live desktop vault.
- Keep Obsidian Headless Sync in `pull-only` for the first server validation.
- Keep Optimike MCP in `headless-readonly` until list/read/search/tasks/Bases/status are green.
- With the shared cache enabled, `obsidian_get_frontmatter` reads one YAML key and `obsidian_note_links` reads outgoing references, unresolved counts, and backlinks. The index covers wikilinks, local Markdown links and embeds, and quoted YAML wikilinks. It skips links inside code, comments, inline or block math, and HTML elements. Desktop metadata behavior inside inline HTML is unverified.
- In headless wikilinks, an unescaped `[[` starts a new link if the current alias is unfinished. Single square brackets may appear in aliases. In the body of a note, comments are stripped from targets and aliases. Source spans still refer to the original note.
- The link index builds on a separate worker after the text cache is ready. Note reads, listings, search, and frontmatter are available while it builds. During that time `obsidian_note_links` returns `SERVICE_UNAVAILABLE` with `reasonCode: headless_link_index_building` and `retryable: true`.
- Large notes are parsed in bounded sections at paragraph boundaries when possible. A section can grow up to four times the target size. An oversized line uses a wikilink-only fallback. An unsafe boundary, a cap on retained references, or a worker heap failure marks that source as limited. The worker continues indexing the rest of the vault.
- When a limited source affects a response, `indexCoverage.sourceComplete` describes its outgoing and unresolved links. `backlinksComplete` is false when a limited source is known or could link to the requested note. `limitedSourceCount` counts the sources relevant to the response.

Tune the filesystem link index with `OBSIDIAN_LINK_LARGE_NOTE_BYTES` (default 262144), `OBSIDIAN_LINK_SECTION_BYTES` (65536), `OBSIDIAN_LINK_MAX_REFERENCES` (8192 per bounded source), and `OBSIDIAN_LINK_BATCH_BYTES` (262144 of source data per batch). Changes to extraction limits cause the link index to rebuild after the text cache is ready.
- When a process sharing the text cache is reconciling it, the link tool returns a retryable reason for the cache itself. `headless_link_cache_refreshing` means a full or periodic refresh is running. `headless_link_cache_events_pending` means file events are still being processed. `headless_link_cache_uncertain` means the cache needs a successful refresh.
- When several Markdown paths match, the filesystem resolver prefers the source folder, then the shortest path, then alphabetical order. It sets `resolution.ambiguous: true` when it chooses among several candidates. The tie-break remains unverified against Desktop. Explicit relative and vault-root paths select that location. The scanner resolves attachment names and user-excluded paths without caching their contents. Technical exclusions such as `node_modules`, `dist`, `build`, `tmp`, and `coverage` stay outside the inventory. Dot-prefixed paths require an explicit gitignore-style reinclusion.
- The counts group references by destination path, including links with different fragments. Heading and block fragments have validation `unknown`. Headless pairs inline HTML tags within a single Markdown block. It follows the [Pandoc dollar delimiter rule](https://pandoc.org/MANUAL.html#extension-tex_math_dollars) for inline math and preserves dollar signs inside link destinations, autolinks, and wikilinks. The exact Desktop metadata rules for inline HTML and dollar delimiters remain unverified.
- The filesystem backend reads the shared cache, which may contain Markdown refreshed through Local REST. After a REST update it reindexes changed rows by content hash without reopening vault notes. A change to the vault root or exclusion scope requires a new filesystem inventory.
- Keep MCP cache outside the synchronized vault.
- Use vault exclusions for operational noise, but do not rely on them to stop Obsidian Sync downloads.
- Do not claim Desktop parity. Frontmatter or inline tags, batch frontmatter, minimal Bases writes, format validation, and minimal Canvas helpers exist as bounded filesystem/local features, not as Obsidian Desktop behavior.

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

## Upstream Sync evidence

Runtime status, note provenance and both HTTP status endpoints expose
`upstreamSync`, `lastSuccessfulPullAt`, `lagSecondsUpperBound` and
`evidenceSource`. Existing HTTP `freshnessScope: "local-cache"` and readiness
codes still describe the local serving path. A successful Sync run does not
imply the MCP cache has refreshed. Compare the last pull with the start of the
local scan. `lagSecondsUpperBound` rounds up the elapsed seconds since the
successful run **started**, bounding the age of the observation of the remote
vault. It cannot bound the time for unsent changes from a user's devices,
excluded files or a disconnected device.

| Evidence | What the adapter can use |
| --- | --- |
| One-shot `ob sync` process | A normal zero exit records completion of a sync pass, including passes with no downloads. Nonzero exit, termination and timeout record failure. |
| `ob sync --continuous` | Process liveness only. Its exit does not attest to a successful pull. |
| `ob sync-status --json` | Machine-readable configuration, without a documented last successful pull or remote watermark. |
| CLI and Sync logs | Diagnostic output without a stable correlation, completion or timestamp schema for ingestion. |
| Internal state files and file mtimes | No documented stable state schema or pull timestamp. Replicated files can preserve source times. |

See [Obsidian Headless Sync](https://obsidian.md/help/sync/headless),
[CLI reference](https://github.com/obsidianmd/obsidian-headless#commands) and
[Sync conflicts](https://obsidian.md/help/sync/troubleshoot).

Set `OBSIDIAN_SYNC_HEARTBEAT_FILE` to an absolute path outside the vault, in an
operator-controlled directory. The reader supports the following versioned
receipt. Write a sibling temporary file and atomically replace the configured
file. The bundled wrapper creates a private receipt. Run it and MCP under the
same dedicated account, or use platform permissions that allow the MCP
account to read each replacement.

```json
{
  "version": 2,
  "vaultBinding": "<64 lowercase hex digits: SHA-256 of the UTF-8 real vault path>",
  "heartbeatAt": "2026-01-02T03:04:07.000Z",
  "state": "ok",
  "lastSuccessfulPull": {
    "startedAt": "2026-01-02T03:04:00.000Z",
    "completedAt": "2026-01-02T03:04:07.000Z"
  }
}
```

Compute `vaultBinding` from the canonical absolute path returned by `realpath`,
with no trailing newline. Receipts for another vault and legacy unbound receipts
yield `unknown`. Use UTC ISO timestamps with milliseconds. State is `running` at the start,
`ok` after success or `error` after failure. Retain the previous successful
pull during a run and after a failure, or use `null` until the first success.
The backend reports `unknown` for missing, malformed, future or out-of-order
evidence, and when a healthy wrapper has no successful pull yet. A heartbeat
older than `OBSIDIAN_SYNC_STALL_SECONDS` (600 by default) yields `stalled`.
A fresh heartbeat reporting failure yields `error`. Otherwise a recorded pull
within `OBSIDIAN_SYNC_CURRENT_SECONDS` (180 by default) yields `current`.
An older pull yields `lagging`. A running sync can retain the state established
by its previous successful pass.

Set `OBSIDIAN_SYNC_WRITE_MAX_AGE_SECONDS` to enable the optional headless
write guard. A filesystem write refuses with `upstream_sync_write_blocked`
when the evidence is `unknown`, `stalled`, `error`, or past that age limit.
The error details include `upstreamSync` and a `syncWriteRefusal` code.
Reads and dry runs continue, and existing write permission and preconditions
still apply. Runtime status and authenticated `/statusz` list indexed,
vault-relative `syncConflictFiles` matching Obsidian's dated Markdown conflict
names, capped at 100, and `syncConflictCount` for the full indexed count.
Obsidian's default automatic merge does not create conflict files. An empty
list only means the cache contains no matching files. Public `/readyz` contains
no filenames.

The packaged `scripts/obsidian-sync-heartbeat.mjs` runs the configured Obsidian CLI
once, with a timeout, and writes this receipt. Schedule it for the vault
under the account that has already completed `ob sync-setup`. Run only one
Sync service per vault. Use pull-only for a read-only replica. Follow the
[service deployment examples](../OPERATIONS.md#headless-sync-and-semantic-services).

## Operon without Desktop

Set `MCP_TOOL_PROFILE=tasks` (or use `operational` or `full`). In all three headless modes, `operon_list_tasks`, `operon_query_tasks`, `operon_get_task`, `operon_find_tasks`, `operon_get_relationships`, `operon_get_configuration`, `operon_status`, and `operon_validate` read the synchronized copy. `operon_query_saved_filter` takes an exact ID from `operon_get_configuration`.

The reader scans cached Markdown for inline checkboxes with an `operonId` and `{{key:: value}}` fields, and file tasks identified by YAML frontmatter. A folder such as `_Operon` is a creation destination. An identified file task can live elsewhere. Task IDs, dates, recurrence rules and occurrence IDs, stored relationships, and managed fields come from those two formats. The reader ignores fenced examples and comments. Indentation alone does not assign a parent.

Sync `.obsidian/plugins/operon/data.json` as well as the notes. It supplies workflow pipelines, status IDs and terminal flags, priorities, key mappings, excluded folders, creation settings, and saved filters. Both flat settings and versioned packages (2 and 3) are supported. Without this file the reader can decode canonical fields, and the configuration and saved-filter tools report `operon_filesystem_configuration_missing`. The plugin manifest supplies the version when present. Pins can be read from the data package or the older `state/pinned-tasks.json` sidecar. Runtime indexes, active trackers, recurrence-series automation, reminder delivery, serial allocation, and calendar caches stay with the plugin.

The upstream [storage specification](https://www.operon.cc/docs/docs-046-plugin-data-and-state-files/) describes the plugin-side state, including separate recurrence and tracker JSON files, reminder delivery records, and the rebuildable runtime index.

Every filesystem read reports `source: "filesystem"`, `freshness`, `cacheStatus`, `lastRefreshAt`, `lastRefreshCompletedAt`, and `partial`. Treat `partial: true` as an incomplete index during startup, refresh, or a cache error. Where exposed, `forceRefresh` updates the shared index from disk. A completed refresh describes the local copy. Older settings without a pipeline list still allow task reads and report that workflow resolution is unavailable.

Set `OPERON_TIMEZONE` to the Desktop vault's IANA zone if the server uses a different zone. The reader checks this override and the plugin setting if present. A nonempty invalid `OPERON_TIMEZONE` prevents startup. Process `TZ` affects the server default and still produces a warning. It applies the same zone to file timestamps and relative date filters. Responses include `timeZone` and `timeZoneSource`. They include `timeZoneWarning` when the reader uses the server's default zone or falls back to UTC because that zone is unavailable.

The finder uses local ranking and stored dates. Relationship reads expose stored edges and their derived inverses and hierarchy. Validation, finder scores, revision tokens and configuration metadata can differ from Desktop. The capability doctor reports Operon reads as ready when the cache is ready and `data.json` is valid. Native mutation authority, runtime relationship inference, folder-template discovery and active timers require Desktop. The compatibility timer tool returns `operon_filesystem_live_required`. Saved filters support nested groups, folder trees alongside common checkbox, text, date, list, tag and persisted pin conditions. `thisWeek` follows Operon 4.6's Monday-to-Sunday rule. Ascending date sorts put empty values first. Empty statuses come last in either direction. A folder sort leaves the order to the next criterion or the input order. Runtime-dependent fields and unsupported operators or sorts return `operon_filesystem_filter_unsupported`. Operon writes continue to require the live Bridge.

The task list uses the Developer API V1 Bridge's `warm` tier and canonical priority IDs, and omits native checklist progress. File-task creation falls back to filesystem birthtime when available. A limitation warns that this can reflect the arrival of a synchronized file. A file task uses the later of its stored modification time and its file mtime in the configured zone, as Operon 4.6 does. An inline task uses its own stored modification time. The index skips dot paths and applies Operon exclusions over the available shared-cache files. A configured cache exclusion produces a warning that the two scopes may differ. Grouped and dynamic saved filters return an explicit unsupported error, and continuation cursors bind to the generation that produced them.

Headless `operon_get_configuration` reports known differences and their reasons in `configurationDifferences`. It adds the seven fixed Developer API fields and derives minimal file templates from the pipelines. The response marks Desktop's folder-template candidates as `unknown`. It retains stored sync directions, language, parent targets, index settings, and documentation settings. Headless reads saved filters directly from disk, including when Bridge 0.9.9 reads the catalog's top-level `filters` while Operon 4.6 publishes its definitions under `policies.filters`.

### Operon parity harness

Run `npm run build` and `npm run test:operon-headless` to exercise MCP against a synthetic vault and a stubbed Local REST Bridge. For a manual comparison, open a disposable copy in Desktop, enable Operon and its read-only Bridge, and wait for its index. Put a file named `operon-parity-copy.md` at the copy's root with a single line `operon-parity-copy: <new UUID>`. Set `OPERON_PARITY_LOCAL_REST_URL` to the loopback endpoint and `OPERON_PARITY_LOCAL_REST_KEY` to its key, then run:

```bash
node scripts/operon-headless-parity.mjs /path/to/disposable-vault-copy
```

Use `OPERON_PARITY_VERIFY_SSL=false` only for a self-signed loopback endpoint. The harness checks the marker through REST, uses private temporary caches, pages both versions of `operon_list_tasks`, and compares configuration and validation. It checks the first finder page, depth-one relationships for up to ten tasks, and the first page of each saved filter. The output reports separate aggregate counts for known configuration differences and unavailable comparisons. Runtime versions, revision tokens, the source kind and the `sourceMtime` transport field are excluded. Unexpected differences give a nonzero exit status. Keep the copy unchanged for the comparison.

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

1. Use the governed move and trash tools below. The compatibility tools require `expectedHash` or `expectedMtime`.
2. For tags, limit the contract to Markdown text: YAML frontmatter `tags`, inline `#tags`, and cache-backed local index.
3. For batch frontmatter, keep dry-run as the default and allow only `set`.
4. For Bases, limit the contract to `.base` YAML files and Markdown frontmatter properties.
   `bases_query.filter` accepts property tables such as `{"status":"open"}`,
   and `and`, `or`, and `not` groups with nested tables or simple expressions.
   An unsupported node or a bare string returns `VALIDATION_ERROR`.
   [See the filter syntax](obsidian_mcp_tools_spec.md#bases).
5. For Canvas, limit the contract to JSON Canvas structure: create, add text node, connect nodes, validate.
6. Validate with `npm run smoke:headless-filesystem`.

See [Runtime Modes](../OPERATIONS.md#runtime-modes) for same-file write ordering,
conflict detection, and the remaining race with other processes.

Never use this phase to edit existing production notes until the server profile has its own rollback and monitoring story.

### Governed move and trash

In `headless-filesystem` with the filesystem cache and `MCP_WRITE_MODE=full`, call
`obsidian_note_move_plan` with exact source and destination paths and an idempotency key.
The plan inspects indexed Markdown links and attachment embeds. It preserves
the syntax and labels of existing links, including YAML scalars, and adjusts
resolved links in a moved note when they would otherwise lose their target.
It refuses a move that would retarget another note's resolved link. The preview
is capped. More than 100 notes requiring rewrites or 100 backlink sources for
a deletion return `headless_backlink_limit`. The separate safety scan can
inspect up to 1,000 candidate notes, including links to the destination name.
Above that, it returns `headless_backlink_inspection_limit`.
Plans use the same sections as the filesystem link index. If an incomplete
source could affect the paths in the plan, the plan returns
`headless_link_coverage_incomplete`. Moves with `alwaysUpdateLinks: false`
can still proceed.
The plan probes exclusive hard-link publication
before admission. Apply with the original key. A stale plan returns
`headless_plan_stale`.

`app.json` controls link updates through `alwaysUpdateLinks` and paths through
`newLinkFormat`. `useMarkdownLinks` concerns newly generated links. Headless
moves keep existing wikilinks and Markdown links in their original syntax.
See [Obsidian's Files and links settings](https://obsidian.md/help/settings#files-and-links).

Call `obsidian_note_delete_plan` to inspect incoming links. Submit a new plan
with `acknowledgeBacklinks: true` after examining nonempty backlinks.
The original file moves to a free path under `.trash` by default. The MCP also
accepts `trashFolder` or `trashFolderPath` as local folder overrides.
Explicit `trashOption: "system"` and `trashOption: "none"` are refused.
When the setting is absent, the MCP uses vault trash to provide a restorable
destination inside the vault without a Desktop system-trash adapter.
[Obsidian Desktop defaults to system trash](https://obsidian.md/help/manage-notes).

Both operations update the affected cache and index paths and re-read the
filesystem for the postflight receipt. Later status calls return that completion
evidence with `cache: "recorded"` and `postflightSource: "recorded"`. After
interruption, call `*_status`.
Use `*_recover` with the same reference and key when `recoveryAllowed` is true.
If an external edit prevents recovery, `abandonAllowed` permits
`*_recover` with `action: "abandon"`. This releases the reservation for manual
repair. The receipt retains `nextAction: "manual_repair"` and includes
`repairProofs` with paths, SHA-256 hashes and inverse edits. The inverse ranges
are UTF-16 offsets into the rewritten file and are ordered from the end to the
start of the file. Compare the current hash with `afterSha256` before using
the inverse edits. The private journal retains the original text
(`headless_file_operations.payload.rewrites`).
An attempt with no published file effect releases the reservation and reports
a conflict. Recovery or abandonment cleans the operation's addressable staging files.

The same-filesystem hard-link probe uses its own temporary files and can return
`hard_links_unsupported`. One background startup sweep checks for leftovers.
Recovery checks the vault root and folders on paths recorded in the plan.
A legacy probe with a single link is preserved. Status lists such paths under
`probeCleanup.orphanedLegacyProbes` for manual review.
Each replacement is atomic. Other file writers remain outside these locks, and
several replacements can be visible partway through. The workflow is scoped to
a copied or dedicated vault. See the [ADR](adr/ADR-External-Reference-Integrity.md#vault-only-moves)
for its distinction from external-document relocation.

`operational` prefers these tools. The `full` profile also retains the older
direct move and delete tools, whose hash/mtime checks apply to a single file.

## Server Go/No-Go

Go when `test:runtime`, `smoke:headless-server-profile`, a short then longer long-run validation, and `npm pack --dry-run` are green. No-go if the server vault still shares the live Desktop location, the cache lives inside the vault, or writes are enabled before snapshot/rollback.
