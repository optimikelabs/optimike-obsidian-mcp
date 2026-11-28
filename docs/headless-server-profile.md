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
- Large notes are parsed in bounded sections at paragraph boundaries when possible. An unclosed comment stays hidden to the end of the note. On a parse timeout, the worker tries smaller sections. When the fallback is limited, the index keeps its usable references and schedules a retry with backoff. Storage errors delay indexing and leave existing references intact.
- When a limited source affects a response, `indexCoverage.sourceComplete` describes its outgoing and unresolved links. `backlinksComplete` is false when a limited source is known or could link to the requested note. Limited sources may yield missing or extra links. Their returned entries carry `confidence: "uncertain"`. `limitedSourceCount` counts the sources relevant to the response and `limitedSources` lists up to 20 vault-relative note paths with a reason (`cap`, `region`, `timeout`, or `oom`). The `region` reason includes unsafe sections and other extraction failures.

Tune the filesystem link index with `OBSIDIAN_LINK_LARGE_NOTE_BYTES` (default 262144), `OBSIDIAN_LINK_SECTION_BYTES` (65536), `OBSIDIAN_LINK_MAX_REFERENCES` (8192 per bounded source), and `OBSIDIAN_LINK_BATCH_BYTES` (262144 of source data per batch). Changes to extraction limits cause the link index to rebuild after the text cache is ready.
Set `OBSIDIAN_LINK_PARSE_TIMEOUT_MS` to tune the initial parse budget (10000 by default). The budget grows with source size. The fallback allows up to 32768 references for notes below the large-note threshold.
Pass `requireComplete: true` to `obsidian_note_links` for a filesystem read that refuses incomplete coverage with `headless_link_coverage_incomplete` and its source diagnostics.
Use the same `OBSIDIAN_LINK_*` settings for processes sharing a cache database, since different extraction settings cause the processes to re-index each other's notes.
- When a process sharing the text cache is reconciling it, the link tool returns a retryable reason for the cache itself. `headless_link_cache_refreshing` means a full or periodic refresh is running. `headless_link_cache_events_pending` means file events are still being processed. `headless_link_cache_uncertain` means the cache needs a successful refresh.
- When several Markdown paths match, the filesystem resolver prefers the source folder, then the shortest path, then alphabetical order. It sets `resolution.ambiguous: true` when it chooses among several candidates. The tie-break remains unverified against Desktop. Explicit relative and vault-root paths select that location. The scanner resolves attachment names and user-excluded paths without caching their contents. Technical exclusions such as `node_modules`, `dist`, `build`, `tmp`, and `coverage` stay outside the inventory. Dot-prefixed paths require an explicit gitignore-style reinclusion.
- The counts group references by destination path, including links with different fragments. Heading and block fragments have validation `unknown`. Headless pairs inline HTML tags within a single Markdown block. It follows the [Pandoc dollar delimiter rule](https://pandoc.org/MANUAL.html#extension-tex_math_dollars) for inline math and preserves dollar signs inside link destinations, autolinks, and wikilinks. The exact Desktop metadata rules for inline HTML and dollar delimiters remain unverified.
- The filesystem backend reads the shared cache, which may contain Markdown refreshed through Local REST. After a REST update it reindexes changed rows by content hash without reopening vault notes. A change to the vault root or exclusion scope requires a new filesystem inventory.
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
