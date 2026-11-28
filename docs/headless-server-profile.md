# Headless Server Profile

French version: [headless-server-profile.fr.md](headless-server-profile.fr.md)

Related docs: [README](../README.md), [Operations](../OPERATIONS.md), [Runtime Capability Matrix](runtime-capability-matrix.md), [MCP Routing Guide](mcp-routing-guide.md), [Linux Headless Multi-client Pilot](headless-multiclient-pilot.md)

This profile is for a dedicated server or copied Sync vault. It keeps the stable release posture: read-only first, guarded writes only after the read-only profile is proven.

## Contract

- Use a dedicated or copied vault, not the live desktop vault.
- Keep Obsidian Headless Sync in `pull-only` for the first server validation.
- Keep Optimike MCP in `headless-readonly` until list/read/search/tasks/Bases/status are green.
- With the shared cache enabled, `obsidian_get_frontmatter` reads one YAML key and `obsidian_note_links` reads outgoing references, unresolved counts, and backlinks. The index covers wikilinks, local Markdown links and embeds, and quoted YAML wikilinks. It skips links inside code, comments, inline or block math, and HTML elements. Desktop metadata behavior inside inline HTML is unverified.
- The link index builds in the background after the text cache is ready. Note reads, listings, search, and frontmatter are available while it builds. During that time `obsidian_note_links` returns `SERVICE_UNAVAILABLE` with `reasonCode: headless_link_index_building` and `retryable: true`. A successful response uses the complete index.
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

1. Use the governed move and trash tools below. The compatibility tools require `expectedHash` or `expectedMtime`.
2. For tags, limit the contract to Markdown text: YAML frontmatter `tags`, inline `#tags`, and cache-backed local index.
3. For batch frontmatter, keep dry-run as the default and allow only `set`.
4. For Bases, limit the contract to `.base` YAML files and Markdown frontmatter properties.
5. For Canvas, limit the contract to JSON Canvas structure: create, add text node, connect nodes, validate.
6. Validate with `npm run smoke:headless-filesystem`.

Never use this phase to edit existing production notes until the server profile has its own rollback and monitoring story.

### Governed move and trash

In `headless-filesystem` with the filesystem cache and `MCP_WRITE_MODE=full`, call
`obsidian_note_move_plan` with exact source and destination paths and an idempotency key.
The plan uses the indexed Markdown links, including supported quoted YAML links and
attachment embeds. Its preview includes the rewrite count, affected notes and bounded
examples. The link preferences in `.obsidian/app.json` control whether links are updated
and how paths are rendered. Apply with the original key. The source and all rewritten
notes are checked before the first write. A stale plan returns `outcome: conflict`.

Call `obsidian_note_delete_plan` to see the total incoming link count and capped
source list. If backlinks exist, inspect them and submit a new plan with
`acknowledgeBacklinks: true`. Apply moves the original bytes to a collision-safe
path under `.trash` or the vault-relative `trashFolder` / `trashFolderPath` in
`app.json`. Existing links are retained. The destination is always a vault folder
regardless of the Desktop system-trash or permanent-delete preference.

Both operations refresh the shared cache and link index before returning a successful
cache receipt. After an interruption, call the matching `*_status` and use
`*_recover` with the same reference and key when `recoveryAllowed` is true. Other
processes outside the governed tools do not share their locks. Each replacement
is atomic, while a multi-file change is recoverable and can be visible partway
through. Moves preserve the date properties. Coverage follows the filesystem link
inventory, including its Markdown-source exclusions.

`operational` prefers these tools. The `full` profile also retains the older
direct move and delete tools, whose hash/mtime checks apply to a single file.

## Server Go/No-Go

Go when `test:runtime`, `smoke:headless-server-profile`, a short then longer long-run validation, and `npm pack --dry-run` are green. No-go if the server vault still shares the live Desktop location, the cache lives inside the vault, or writes are enabled before snapshot/rollback.
