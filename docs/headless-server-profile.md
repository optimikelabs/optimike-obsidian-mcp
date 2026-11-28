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
- Move/delete, minimal Bases writes, format validation and minimal Canvas helpers have bounded filesystem contracts.

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
4. Seal follow-up body and frontmatter edits with the governed patch tools.
5. Confirm stale hash and traversal writes are blocked.

Before a write test, snapshot the dedicated vault:

```bash
HEADLESS_SERVER_VAULT=/path/to/dedicated-or-copied-vault npm run snapshot:vault
```

The snapshot is not a full backup strategy, but it gives a fast local rollback point for server tests.

## Filesystem Features

Only after the `headless-guarded` step, switch a copied or dedicated vault to `OBSIDIAN_RUNTIME_MODE=headless-filesystem`.

1. For move/delete, require `expectedHash` or `expectedMtime`.
2. For Bases, the filesystem tools create and configure `.base` YAML files. Edit row properties with governed frontmatter patches. `bases_upsert_rows` requires live mode.
3. For Canvas, limit the contract to JSON Canvas structure: create, add text node, connect nodes, validate.
4. Validate with `npm run smoke:headless-filesystem`.

See [Runtime Modes](../OPERATIONS.md#runtime-modes) for same-file write ordering,
conflict detection, and the remaining race with other processes.

Never use this phase to edit existing production notes until the server profile has its own rollback and monitoring story.

## Governed Markdown writes

`headless-guarded` exposes `obsidian_text_patch_*`, `obsidian_frontmatter_patch_*`,
`obsidian_note_create_*` and `obsidian_list_pending_operations` in authoring
profiles. `headless-filesystem` adds `obsidian_note_replace_*` and
`obsidian_operation_revert_*`. Use the same plan, apply, status and recover
calls as live for supported note families. Creation uses plan, apply and status.
Direct append/prepend, search/replace, frontmatter and tag editors are live-only.
Use governed text and frontmatter patches for those edits. Headless omits the
direct batch frontmatter tool.

Plans bind the vault and the SHA-256 of the bytes read from disk, or path
absence for creation. Apply uses the sealed reference and idempotency key.
The filesystem authority serializes cooperating processes on the same host. For
an existing note it fsyncs the stage and exchanges its name with the target in
one filesystem call. This uses `renameat2(RENAME_EXCHANGE)` on supported Linux
filesystems and `renamex_np(RENAME_SWAP)` on supported macOS filesystems. Readers
always have a path to open during that exchange. Creation uses an exclusive
hard link and never replaces an existing note.

The plan probes atomic exchange with two empty temporary files in the target
directory and removes them before returning. If the host or filesystem cannot
exchange names atomically, replacement is refused by default. Windows `ReplaceFileW` with a backup exposed a missing
path to a concurrent reader, so Windows also defaults to refusal. For a vault
without active bidirectional synchronization, you can explicitly set
`MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE=true` to allow the legacy move-aside and
exclusive-link sequence. **Do not use this option with active bidirectional
synchronization.** That sequence has an observable absent path. Its Windows
sharing-violation retries take about three seconds and recheck the sealed hash.

Postflight verifies the displaced bytes against the sealed hash and re-reads the published file. Receipts
identify `headless-filesystem`. If an external edit was displaced and the target
still contains the unchanged staged inode, a second atomic exchange restores the
edit and ends in `conflict`. The journal retains the staged version. If the
second exchange races with another write, the journal retains the available
versions. `headless_displaced_edit` identifies an `outcome_unknown` receipt
when the initial stage is still in place or when the second exchange itself
displaced a write and the restored target is intact. In full write mode, use
`obsidian_operation_revert_plan/apply` with the original plan reference to
restore that displaced edit byte-for-byte. The revert is sealed against the
recorded target hash. If a newer edit already occupies the note, the operation
ends in `conflict` and keeps the journal evidence without offering restoration.
A process holding an old file open can still write to it after its final check.

Put the shared cache outside the vault. The default governed journal is next
to it and uses the vault identity across writable modes. It falls back to local
state when the cache is inside the vault. The per-vault lock directory lives
in local state independently of the journal override. Cooperating processes
must share local state. `MCP_HEADLESS_GOVERNED_JOURNAL_PATH` selects an absolute
path outside the vault. Committed before images and settled divergence evidence
follow the terminal retention period (30 days). Treat the journal like vault data.

Keep the vault's `.obsidian` configuration available, including its enabled
plugins list and Frontmatter Date Manager settings. The authority reads
property names, the supported local-time format (minute or second precision)
and ordered exclusion rules. It honors the core Templates and Templater
folders. Managed creation uses the application timestamp on new notes and file birth
time when initializing a missing creation property on an existing note.
Set `OPTIMIKE_VAULT_TIMEZONE` to the IANA timezone used by the devices that edit
the vault. Set the server process `TZ` to the same zone. An explicit plugin zone
must also agree. If you use the headless Operon reader, set its `OPERON_TIMEZONE`
to the same value. Process `TZ` alone does not qualify the date policy. The authority writes
plain YAML date scalars and respects the selected content hash scope, the
Canvas.md exclusion and the drawing toggle. Edits inside the configured minimum
interval still apply and preserve the existing modification timestamp. Agents cannot supply manager-owned fields. Missing or
unsupported settings close the write path.
The headless compiler validates local YAML and preserves BOM and line endings.
Desktop provides native YAML serialization and metadata types in live mode.

After an interrupted apply, call status on the original reference. It can
settle a write that never published, or reclaim the staged hard link after
creation. An interrupted native exchange leaves a complete file at the target.
Startup also reconciles its journaled temporary witness before serving tools
and removes empty files with the exact exchange-probe name pattern in the
vault root and visible folders.
For the opt-in legacy sequence, startup and the first status restore a missing
original through an exclusive link and report a conflict. A staged write never replays.
To undo a committed write, plan a revert using its original plan reference
and path, then apply the new plan. The current hash must match the original
operation's after hash. Existing notes restore the retained content with
date policy applied. Undoing a creation restores path absence and requires
`MCP_WRITE_MODE=full` and journal storage on the same filesystem as the vault.

## Server Go/No-Go

Go when `test:runtime`, `smoke:headless-server-profile`, a short then longer long-run validation, and `npm pack --dry-run` are green. No-go if the server vault still shares the live Desktop location, the cache lives inside the vault, or writes are enabled before snapshot/rollback.
