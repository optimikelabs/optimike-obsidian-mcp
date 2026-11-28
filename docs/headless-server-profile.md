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

See [Runtime Modes](../OPERATIONS.md#runtime-modes) for same-file write ordering,
conflict detection, and the remaining race with other processes.

Never use this phase to edit existing production notes until the server profile has its own rollback and monitoring story.

## Governed Markdown writes

`headless-guarded` exposes `obsidian_text_patch_*`, `obsidian_frontmatter_patch_*`,
`obsidian_note_create_*` and `obsidian_list_pending_operations` in authoring
profiles. `headless-filesystem` adds `obsidian_note_replace_*` and
`obsidian_operation_revert_*`. Use the same plan, apply, status and recover
calls as live for supported note families. Creation uses plan, apply and status.

Plans bind the vault and the SHA-256 of the bytes read from disk, or path
absence for creation. Apply uses the sealed reference and idempotency key.
The filesystem authority serializes cooperating processes on the same host,
syncs staged bytes, checks the target again immediately before publication and
publishes atomically. A Sync edit visible at that check conflicts. On Windows,
the authority retries `EPERM` and `EBUSY` from rename up to four times and checks
the hash again before each attempt. Commit receipts identify `headless-filesystem`
and require a verified re-read from disk.

An external writer can still edit between the final hash read and rename. An
edit overwritten entirely in that interval may leave no observable evidence.
If postflight detects a different file after publication, the operation stays
`outcome_unknown`. The private journal retains the original before image, the
exact bytes published, and the different bytes observed. Status and recover
preserve the external edit. In `headless-filesystem` with `MCP_WRITE_MODE=full`,
a separate revert can restore the original state if the current note still
matches the recorded external hash. Review that edit before applying the revert.

Put the shared cache outside the vault. The default governed journal is next
to it, with a fallback to the local note-journal state directory if the cache
is inside the vault. `MCP_HEADLESS_GOVERNED_JOURNAL_PATH` selects an absolute
path outside the vault. All cooperating processes must share it and its lock
directory on local storage. The journal contains private before images for
the existing terminal retention period (30 days). Treat the journal like
vault data.

Keep the vault's `.obsidian` configuration available, including its enabled
plugins list and Frontmatter Date Manager settings. The authority reads
property names, the supported local-time format (minute or second precision)
and ordered exclusion rules. It honors the core Templates and Templater
folders. Managed creation uses the application timestamp on new notes and file birth
time when initializing a missing creation property on an existing note.
Set the server's `TZ` to the vault's intended local time zone. The plan seals
the date policy. Apply sets modification from the server clock
and records the exact staged hash before publication. Agents cannot supply
those changes. Missing or ambiguous date settings close the write path.
The headless compiler validates local YAML and preserves BOM and line endings.
Desktop provides native YAML serialization and metadata types in live mode.

After an interrupted apply, call status on the original reference. Recover
can resume a write if the journal shows it never reached staging. Once staged,
status and recover can certify the effect only from the recorded disk proof.
To undo a committed write, plan a revert using its original plan reference
and path, then apply the new plan. The current hash must match the original
operation's after hash. Existing notes restore the retained content with
date policy applied. Undoing a creation restores path absence and requires
`MCP_WRITE_MODE=full` and journal storage on the same filesystem as the vault.

## Server Go/No-Go

Go when `test:runtime`, `smoke:headless-server-profile`, a short then longer long-run validation, and `npm pack --dry-run` are green. No-go if the server vault still shares the live Desktop location, the cache lives inside the vault, or writes are enabled before snapshot/rollback.
