# Operon tools in Optimike Obsidian MCP

French version: [operon-mcp-contract.fr.md](operon-mcp-contract.fr.md)

## Surface

The main MCP server registers twenty-three Operon tools:

- `operon_status`
- `operon_get_configuration`
- `operon_list_tasks`
- `operon_get_task`
- `operon_query_tasks`
- `operon_query_saved_filter`
- `operon_validate`
- `operon_get_diagnostics`
- `operon_find_tasks`
- `operon_resolve_task`
- `operon_get_relationships`
- `operon_build_context`
- `operon_get_timer_state`
- `operon_adopt_task`
- `operon_create_task`
- `operon_update_task`
- `operon_transition_task`
- `operon_set_relationships`
- `operon_update_recurrence`
- `operon_convert_task`
- `operon_relocate_task`
- `operon_list_pending_recoveries`
- `operon_recover_mutation`

There is no second MCP server.

`operon_get_configuration` is the agent-facing equivalent of the historical Tasks settings loader. It reads the live Operon runtime through the Bridge instead of duplicating `data.json` parsing in Node. The response includes the settings that change task meaning or creation behavior, a deterministic signature, and an explicitly stale cached fallback for headless use.

## Why MCP does not simply call the CLI

The CLI is the broad operator surface for native diagnostics, administration,
recovery investigation and one-off actions. MCP is the agent control plane. A
function enters MCP only with a bounded semantic schema, least-privilege
capability check, dry-run, revision locking, durable idempotency, postflight and
matching recovery/human gates. A generic CLI passthrough would bypass those
guarantees, expose overly broad commands and make capability drift invisible to
agents. CLI availability alone is therefore not an MCP admission criterion.

## Reads and freshness

Every read response declares `source`, `stale`, snapshot time/age, Operon and Bridge versions, contract version, capabilities, and limitations.

- `operon-live`: complete pagination and validation match one stable Operon generation/settings signature.
- `operon-cache`: last validated SQLite snapshot; always stale and never proof of a mutation.

SQLite cache state lives in `operon_task_snapshot` and `operon_snapshot_meta`. Malformed payloads, incomplete pagination, generation drift, duplicate IDs, incompatible versions, unready index, or P0 validation never replace the last known-good snapshot.

### Vacation-safe compatibility

Operon 3.x admission follows the runtime contract, not an exact product-version
allowlist. The Bridge requires the official `getDeveloperApiV1` accessor,
negotiates `contractVersion: 1` with `runtimeApi: 1`, and validates the granted
capabilities, response shapes, live health, catalog, complete task pagination,
and index diagnostics. Status distinguishes:

- `certified`: a product version in the Bridge's explicit certified set whose
  negotiated runtime checks pass;
- `compatible-provisional`: an unknown release whose Developer API V1 boundary
  passes the same runtime checks;
- `incompatible`: an absent, denied, or invalid contract boundary.

Known behavioral regressions may remain denied by exact version and operation.
Missing optional capabilities disable only dependent tools. A future contract
version is never accepted silently.

`operon_query_saved_filter` is intentionally live-only and capability-gated. On
official Operon `3.2.0`, it delegates to the additive task-workflow Developer
API after an exact `tasks.filter-query` grant. The caller must supply an exact
`filterSetId`: the official API executes saved filters but does not expose their
catalog. Headless snapshots never attempt to reproduce plugin filter semantics.

The six additional Developer API reads are also live-only. They expose native
runtime diagnostics, ranked finder, entity resolution, bounded relationship
graphs, bounded context packs, and timer state. The MCP caps finder results at
50, relationships/context at 100, relationship/context depth at 3, and context
hydration to notes, links, and custom fields. It deliberately excludes raw
source Markdown, tracker/reminder history, placement and mutation-readiness
packs.

The cached metadata also stores the configuration used for that snapshot. Tasks project `statusId` and `pipelineId`, and queries accept `statusIds` / `pipelineIds`. Agents must prefer those stable IDs and canonical key names from `operon_get_configuration`; visible French or English labels are presentation values, not durable API identifiers.

## Mutations

Mutation tools call Bridge REST routes backed by the loaded engine's official mutation surface. Operon 3.x uses Developer API V1 typed preview → apply plans with host-owned recovery; legacy Kairélys versions continue to use their Public API v1 contract. No route edits Markdown, calls `TaskWriter` directly, invokes UI commands, or reflects into private methods.

Common controls:

- `dryRun` defaults to `true`;
- `idempotencyKey` is mandatory;
- existing Operon tasks require `expectedRevision`;
- legacy checkbox adoption requires an exact one-based `line` and `expectedLine` precondition;
- Operon 3.2.0 previews and applies one exact host-sealed plan;
- `outcome-unknown` is surfaced with its recovery reference and never blind-retried;
- after apply, the Bridge rereads the verified live index;
- the MCP refreshes its SQLite snapshot;
- no mutation is available from a stale/headless snapshot.

Durable results are stored in `operon_mutation_journal`. A reservation is committed before the Bridge call. Reusing an idempotency key with the same completed request returns the original `operationId` and result without calling the Bridge again. A restart or timeout that leaves the reservation `in_progress` is treated as an uncertain outcome and blocks blind retry. Reusing a key for a different request is rejected as `CONFLICT`. Revision mismatch returns `conflict` without writing.

Apply additionally requires `OPERON_MUTATIONS_ENABLED=true` and the Bridge setting **Allow task mutations**. This two-sided opt-in prevents an accidental package upgrade from enabling writes.

### Write policy

- `MCP_WRITE_MODE=readonly`: dry-run only.
- `MCP_WRITE_MODE=guarded`: adopt, create, update, transition, relationship replacement, and inline relocation apply are allowed with their normal preconditions.
- `MCP_WRITE_MODE=full`: conversion and recurrence apply are additionally allowed.
- `operon_recover_mutation` also requires `MCP_WRITE_MODE=full` because it may complete an uncertain prior write; it only recovers the exact `recoveryRef` plan.

`OPERON_MUTATION_ALLOWED_PATH_PREFIXES` optionally limits every Operon mutation to a comma-separated set of vault-relative folders. When configured, existing tasks must already live under one of those prefixes, and creation requires an explicit allowed destination: `targetFolder` for legacy file-task creation or `targetPath` for inline tasks. Official Operon 3.2.0 still rejects arbitrary `targetFolder` because its Developer API has no exact folder-only target contract. Scoped conversion apply is allowed in guarded mode only when the current source and explicit destination are both inside the allowlist.

Conversion remains classified as destructive because file-to-inline moves the source file to trash and inline-to-file replaces the source line with a durable link.

### Tool-specific rules

`operon_adopt_task` is a registered compatibility tool, not an official Operon `3.2.0` capability. When a compatible legacy engine advertises adoption, it upgrades one existing plain Markdown or Obsidian Tasks checkbox in place. The target file, one-based line, and exact source line must still match; otherwise the operation returns `conflict` without writing. Official Operon `3.2.0` returns a structured unavailable result and the MCP does not simulate adoption with a Markdown edit.

`operon_create_task` creates inline or file tasks through Operon's creator services. On official Operon 3.2.0, typed fields, tags, stable `statusId`, relationships, exact inline `targetPath`, and configured/default file templates are supported. Unmanaged YAML properties and arbitrary `targetFolder` placement are legacy-only; the official Developer API path rejects them instead of using a fallback.

`operon_update_task` accepts exactly one group per call: description, managed fields/tags, or one unmanaged file property. Status transitions use the dedicated tool. Unmanaged file properties are supported only by the legacy Public API path; official Operon 3.2.0 rejects them explicitly.

`operon_set_relationships` replaces or explicitly clears `parentTask`, `blocking`, and `blockedBy`. It rejects duplicate targets, self-reference, and a target present in both dependency directions before preview. Operon seals the complete affected-resource set and performs graph/cycle validation; after apply the Bridge verifies the source and every changed inverse dependency edge.

`operon_update_recurrence` changes only the official recurrence surface with an explicit `this-task` or `this-and-following` scope. `null` clears a field. Recurrence is not simulated through `operon_update_task`; apply requires full mode, and the Bridge rereads every requested normalized field after the sealed plan completes.

`operon_transition_task` prefers a stable status ID from `operon_get_configuration`, while still accepting exactly one current configured workflow value for compatibility. Operon 3.2.0 transition preview/apply is available through the Bridge. Elevated transitions require fresh host-owned consent: the confirmation modal is constructed in the owning vault window and an unattended request fails closed after 45 seconds. The CLI/native official path remains an operator diagnostic surface, not a bypass; no Markdown/private fallback is introduced.

`operon_convert_task` converts inline ↔ file through Operon's transition-safe paths. File-to-inline requires an explicit `targetPath`. Official Operon 3.2.0 uses its configured target/template contract and does not accept arbitrary `targetFolder`; the legacy Public API path retains scoped folder support.

`operon_relocate_task` moves an inline task to an explicit Markdown `targetPath` through Operon while preserving `operonId`. Official Operon 3.2.0 resolves a live blank destination line through `context.build`; it never guesses a line or writes the file directly. Source and target are verified after the index settles.

`operon_list_pending_recoveries` lists durable official recovery references without applying anything. `operon_recover_mutation` invokes the official same-plan recovery, requires both opt-ins plus full MCP write mode, and preserves the original `planDigest`/`recoveryRef` evidence.

## Verified pilot behavior

On legacy Operon `2.5.0`/Kairélys in a disposable vault, direct MCP calls historically proved:

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

The dedicated Operon `3.2.0` pilot passed on the local acceptance build:
saved-filter execution with opaque pagination, relationship dry-run/apply,
inverse-edge verification, idempotent replay, blocked terminal-transition
enforcement, exact restoration, recurrence add/scope-change/clear,
restart/recovery stability, live source, 25 tasks after fixture cleanup, no
residual relationship/recurrence state, and `P0/P1/P2 = 0/0/0`. The build
contains only the settings-renderer fix needed to expose Developer API grant
controls. The remaining upstream limits are #99/#101 and #139; the Bridge
reports uncertainty or unavailability without retrying or falling back.

## Deliberately unavailable or excluded capabilities

Deletion, reminders, pinned state, timer control/session, adoption, and
saved-filter management remain outside the official agent mutation surface.
Saved-filter **execution** is available on Operon `3.2.0` when the exact ID and
grant are present; catalog discovery and filter creation/editing are not.
Adoption remains unavailable on the official Developer API. Delete remains an
operator CLI action. A future `operon_trash_task` may be considered only with
guaranteed restoration under the same `operonId`, reconciled relations, durable
journal evidence, and an explicit human confirmation; it is not implemented.
