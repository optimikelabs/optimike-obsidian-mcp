# Operon tools in Optimike Obsidian MCP

## Surface

The main MCP server registers nine Operon tools:

- `operon_status`
- `operon_list_tasks`
- `operon_get_task`
- `operon_query_tasks`
- `operon_validate`
- `operon_create_task`
- `operon_update_task`
- `operon_transition_task`
- `operon_convert_task`

There is no second MCP server.

## Reads and freshness

Every read response declares `source`, `stale`, snapshot time/age, Operon and Bridge versions, contract version, capabilities, and limitations.

- `operon-live`: complete pagination and validation match one stable Operon generation/settings signature.
- `operon-cache`: last validated SQLite snapshot; always stale and never proof of a mutation.

SQLite cache state lives in `operon_task_snapshot` and `operon_snapshot_meta`. Malformed payloads, incomplete pagination, generation drift, duplicate IDs, incompatible versions, unready index, or P0 validation never replace the last known-good snapshot.

## Mutations

Mutation tools call Bridge REST routes backed by Operon Public API v1. They do not edit Markdown, call `TaskWriter` directly, invoke UI commands, or reflect into private methods.

Common controls:

- `dryRun` defaults to `true`;
- `idempotencyKey` is mandatory;
- existing tasks require `expectedRevision`;
- after apply, the Bridge rereads the verified live index;
- the MCP refreshes its SQLite snapshot;
- no mutation is available from a stale/headless snapshot.

Durable results are stored in `operon_mutation_journal`. Reusing an idempotency key with the same canonical request returns the original `operationId` and result without calling the Bridge again. Reusing it for a different request is rejected as `CONFLICT`. Revision mismatch returns `conflict` without writing.

### Write policy

- `MCP_WRITE_MODE=readonly`: dry-run only.
- `MCP_WRITE_MODE=guarded`: create, update, and transition apply are allowed with their normal preconditions.
- `MCP_WRITE_MODE=full`: conversion apply is additionally allowed.

`OPERON_MUTATION_ALLOWED_PATH_PREFIXES` optionally limits every Operon mutation to a comma-separated set of vault-relative folders. When configured, existing tasks must already live under one of those prefixes, and creation requires an explicit allowed destination: `targetFolder` for file tasks or `targetPath` for inline tasks. Scoped conversion apply is allowed in guarded mode only when the current source and explicit destination are both inside the allowlist.

Conversion remains classified as destructive because file-to-inline moves the source file to trash and inline-to-file replaces the source line with a durable link.

### Tool-specific rules

`operon_create_task` creates inline or file tasks through Operon's creator services. File tasks may include unmanaged YAML properties and an explicit vault-relative `targetFolder`; inline tasks may use an explicit vault-relative Markdown `targetPath`.

`operon_update_task` accepts exactly one group per call: description, managed fields/tags, or one unmanaged file property. Status transitions use the dedicated tool.

`operon_transition_task` accepts an exact configured workflow status and preserves Operon's dependency, recurrence, aggregate, terminal-date, archive, and auto-unpin semantics.

`operon_convert_task` converts inline ↔ file through Operon's transition-safe paths. File-to-inline requires an explicit `targetPath`; scoped inline-to-file conversion requires an explicit `targetFolder`.

## Verified pilot behavior

On Operon `2.5.0` in a disposable vault, direct MCP calls proved:

- file and inline creation;
- managed fields, tags, and unmanaged ÉLYSIA properties;
- parent and blocker relationships plus reverse dependency reconciliation;
- blocked terminal transition rejection;
- successful transition after blocker completion;
- inline-to-file and file-to-inline conversion with identity preserved;
- durable idempotency replay;
- stale-revision conflict detection;
- full reindex and plugin restart parity;
- explicit live-to-stale cache fallback;
- duplicate-ID P0 detection and refusal to replace the last good snapshot.

Production activation and Tasks/TaskNotes migration remain separate manual gates.
