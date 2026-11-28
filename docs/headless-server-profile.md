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
- Notes over 256 KiB use bounded Markdown sections. Syntax that spans sections can be interpreted differently or omitted. Sections and references beyond the extraction budget are skipped. When the index contains these notes, responses include `indexCoverage` with the number of limited sources and `backlinksComplete: false`. For a limited source, `sourceComplete: false` applies to the outgoing and unresolved results.
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
The plan inspects indexed Markdown links and attachment embeds. It preserves
the syntax and labels of existing links, including YAML scalars, and adjusts
resolved links in a moved note when they would otherwise lose their target.
It refuses a move that would retarget another note's resolved link. The preview
is capped. More than 100 notes requiring rewrites or 100 backlink sources for
a deletion return `headless_backlink_limit`. The separate safety scan can
inspect up to 1,000 candidate notes, including links to the destination name.
Above that, it returns `headless_backlink_inspection_limit`.
If any large note received bounded extraction, plans that need complete
backlinks return `headless_link_coverage_incomplete`. Moves with
`alwaysUpdateLinks: false` can still proceed.
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
