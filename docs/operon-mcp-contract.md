# Operon tools in Optimike Obsidian MCP

French version: [operon-mcp-contract.fr.md](operon-mcp-contract.fr.md)

## Surface

The main MCP server registers twenty-five Operon tools:

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
- `operon_create_periodic_task`
- `operon_update_periodic_scheduling`
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
  Developer API accessor is present;
- `compatible-provisional`: a non-denied release outside that set whose
  Developer API V1 accessor is present;
- `incompatible`: an absent, denied, or invalid contract boundary.

This compatibility state is independent from live index readiness. Callers
must also require top-level `ok` and `index.ready`. Core capabilities remain
hard route gates; the cold status of an additive first-use capability is
advisory because only its exact operation may negotiate it.

Known behavioral regressions may remain denied by exact version and operation.
Missing optional capabilities disable only dependent tools. A future contract
version is never accepted silently.

`operon_query_saved_filter` is intentionally live-only and capability-gated. On
official Operon `3.5.3`, it delegates to the additive task-workflow Developer
API after an exact `tasks.filter-query` grant. The caller must supply an exact
`filterSetId`: the official API executes saved filters but does not expose their
catalog. A cold cached capability does not block the call: the Bridge negotiates
only `tasks.filter-query` on first exact use. Status/index refreshes request no
optional grant. Headless snapshots never attempt to reproduce plugin filter
semantics.

The six additional Developer API reads are also live-only. They expose native
runtime diagnostics, ranked finder, entity resolution, bounded relationship
graphs, bounded context packs, and timer state. The MCP caps finder results at
50, relationships/context at 100, relationship/context depth at 3, and context
hydration to notes, links, and custom fields. It deliberately excludes raw
source Markdown, tracker/reminder history, placement and mutation-readiness
packs.

The cached metadata also stores the configuration used for that snapshot. Tasks project `statusId` and `pipelineId`, and queries accept `statusIds` / `pipelineIds`. Agents must prefer those stable IDs and canonical key names from `operon_get_configuration`; visible French or English labels are presentation values, not durable API identifiers.

## Mutations

Mutation tools call Bridge REST routes backed by the loaded engine's official mutation surface. Operon 3.x uses Developer API V1 typed preview → apply plans with host-owned recovery; legacy Kairélys versions continue to use their Public API v1 contract. Official task-workflow plans are opaque, session-bound handles: the MCP never reconstructs them and recovery continues only the same plan through its `recoveryRef`. No route edits Markdown, calls `TaskWriter` directly, invokes UI commands, or reflects into private methods.

Common controls:

- `dryRun` defaults to `true`;
- `idempotencyKey` is mandatory;
- existing Operon tasks require `expectedRevision`;
- adoption requires an exact one-based `line` and `expectedLine` precondition;
- any non-denied Operon release with the negotiated V1 contract previews and applies one exact host-sealed opaque plan only after its exact capability, schema, health, settled-index and recovery gates pass;
- `outcome-unknown` is surfaced with its recovery reference and never blind-retried;
- Task Workflow results are strictly validated before projection; malformed or contradictory native evidence remains `outcome-unknown`, while `nativeProof` exposes only the bounded proof projection;
- after apply, the Bridge rereads the verified live index;
- the MCP refreshes its SQLite snapshot;
- no mutation is available from a stale/headless snapshot.

MCP results are stored in `operon_mutation_journal`. A reservation is committed before the Bridge call. Reusing an idempotency key with the same completed request returns the original `operationId` and result without calling the Bridge again. A restart or timeout that leaves the MCP reservation `in_progress` is treated as an uncertain outcome and blocks blind retry. Reusing a key for a different request is rejected as `CONFLICT`. Revision mismatch returns `conflict` without writing.

Bridge 0.9.2 independently reserves idempotency keys atomically and persists its version-2 journal in local Obsidian plugin data before native dispatch. The journal is bounded to 500 entries and 30 days. A restored `in-progress` entry becomes non-retryable `outcome-unknown` with `recoveryRequired: true`. Version 2 stores explicit dispatch provenance. The Bridge may release a same-request receipt only when its durable `proven-pre-dispatch` marker proves `not-ready` before mutation dispatch and the response explicitly states both `ok: false` and `mutationMayHaveApplied: false`; it then persists the removal before reserving again. Version-1 entries are retained during migration but classified as unknown-or-dispatched, because Bridge 0.8.2 could persist those payload fields after native dispatch had begun. Missing or malformed provenance therefore remains replay-only and cannot cause another native call. This supports bounded local replay/restart only; it promises nothing after expiry, eviction, plugin-data reset/loss, failed persistence, or transfer to another vault/device. Failure to persist either the initial reservation or a proven-safe release prevents native dispatch.

Journal restoration is fail-closed. A missing `mutationJournal` property is a
new `absent` store, while a supported and fully validated envelope is `valid`.
Any present unknown version, non-array or oversized envelope, malformed retained
entry, duplicate key, unsupported state, invalid terminal payload or HTTP status
latches the Bridge as `unsafe`. Reads and pending-recovery inspection remain
available, but every new reservation, native mutation and recovery dispatch
returns the stable value-free `mutation_journal_unsafe` diagnostic. No native
mutation is dispatched while this latch is active. Ordinary
settings saves preserve the unsafe journal value unchanged; only an explicit
operator repair followed by Bridge reload can clear the latch.

Apply additionally requires `OPERON_MUTATIONS_ENABLED=true` and the Bridge setting **Allow task mutations**. This two-sided opt-in prevents an accidental package upgrade from enabling writes.

### Write policy

- `MCP_WRITE_MODE=readonly`: dry-run only.
- `MCP_WRITE_MODE=guarded`: adopt, create, Daily/Weekly create, periodic scheduling update, transition, relationship replacement, and inline relocation apply are allowed with their normal preconditions.
- `MCP_WRITE_MODE=full`: conversion and recurrence apply are additionally allowed.
- `operon_recover_mutation` also requires `MCP_WRITE_MODE=full` because it may complete an uncertain prior write; it requires the exact `recoveryRef` and a nested `recovery` union containing one explicit `kind`: `developer-api`, `adopt`, `periodic-create`, or `periodic-update`.

`OPERON_MUTATION_ALLOWED_PATH_PREFIXES` optionally limits every Operon mutation to a comma-separated set of vault-relative folders. When configured, existing tasks must already live under one of those prefixes, and creation requires an explicit allowed destination: `targetFolder` for legacy file-task creation or `targetPath` for inline tasks. Official Operon 3.2.0 still rejects arbitrary `targetFolder` because its Developer API has no exact folder-only target contract. Scoped conversion apply is allowed in guarded mode only when the current source and explicit destination are both inside the allowlist. Because pending recovery records expose no canonical task route that can be proved against this policy, a non-empty path allowlist disables both `operon_list_pending_recoveries` and recovery apply; both fail closed before inventory disclosure or native dispatch.

Conversion remains classified as destructive because file-to-inline moves the source file to trash and inline-to-file replaces the source line with a durable link.

### Tool-specific rules

`operon_adopt_task` uses the official additive task-workflow API only after the exact `tasks.adopt.preview` and `tasks.adopt.apply` grants. Product-version membership is not a second mutation gate. The tool upgrades one exact checkbox through Operon's opaque sealed plan. The target file, one-based line, and exact source line must match; otherwise the operation returns `conflict` without writing. A compatible legacy engine may still advertise its bounded adoption contract, but a missing official grant returns a structured unavailable result and the MCP never simulates adoption with a Markdown edit.

`operon_create_task` creates inline or file tasks through Operon's creator services. On official Operon 3.2.0, typed fields, tags, stable `statusId`, relationships, exact inline `targetPath`, and configured/default file templates are supported. `dateScheduled` is not accepted during creation: set or clear it only afterwards with `operon_update_periodic_scheduling`. Unmanaged YAML properties and arbitrary `targetFolder` placement are legacy-only; the official Developer API path rejects them instead of using a fallback.

`operon_create_periodic_task` creates exactly one inline task in Operon's configured Daily or Weekly Note after the exact periodic preview/apply grants. Operon owns date routing, templates, container identity and receipts; the MCP cannot supply an arbitrary target path or parent. `routeDate` selects the Daily/Weekly Note, while `fields.dateScheduled` may set the task's initial scheduled date through the same native workflow. `priorityId` postflight is verified against the stable projected priority. If apply may have succeeded but no unique created identity can be proven, the result remains `outcome-unknown`; the MCP never retries the ambiguous creation. `operon_update_periodic_scheduling` is the only MCP tool that sets or clears `dateScheduled` on an existing task: Operon may need its additive periodic workflow to retain, detach, or realign the task, and the route never moves the source Markdown as a side effect.

For official Operon `3.6.0`, the public Task Workflow periodic plan is metadata-only: it exposes no pre-apply task-source path. The exact-SHA release canary therefore performs periodic preview and exact-grant negotiation but skips periodic applies with reason `public_task_source_projection_unavailable`. This is a destructive-canary containment and certification boundary, not a disabled runtime tool; the upstream public task-source path projection is a nonblocking follow-up. Do not claim full periodic certification from this gate.

Managed fields preserve their official shape. `taskType` and `taskImage` are scalar strings. `taskGallery` is a lossless ordered string array and delimiter-based strings are rejected. The derived `__taskDataType` field is read-only and cannot enter create or update input.

`operon_update_task` accepts exactly one ordinary group per call: description, managed fields/tags, or one unmanaged file property. It rejects `dateScheduled`, relationship fields, and recurrence fields; callers must use `operon_update_periodic_scheduling`, `operon_set_relationships`, or `operon_update_recurrence` respectively. Status transitions use the dedicated tool. Unmanaged file properties are supported only by the legacy Public API path; official Operon 3.2.0 rejects them explicitly.

`operon_set_relationships` replaces or explicitly clears `parentTask`, `blocking`, and `blockedBy`. It rejects duplicate targets, self-reference, and a target present in both dependency directions before preview. Operon seals the complete affected-resource set and performs graph/cycle validation; after apply the Bridge verifies the source and every changed inverse dependency edge.

`operon_update_recurrence` changes only the official recurrence surface with an explicit `this-task` or `this-and-following` scope. It does not accept `dateScheduled`; set or clear that field only with `operon_update_periodic_scheduling`. `null` clears a supported recurrence field. Recurrence is not simulated through `operon_update_task`; apply requires full mode, and the Bridge rereads every requested normalized field after the sealed plan completes.

`operon_transition_task` prefers a stable status ID from `operon_get_configuration`, while still accepting exactly one current configured workflow value for compatibility. Operon 3.2.0 transition preview/apply is available through the Bridge. Elevated transitions require fresh host-owned consent: the confirmation modal is constructed in the owning vault window and an unattended request fails closed after 45 seconds. The CLI/native official path remains an operator diagnostic surface, not a bypass; no Markdown/private fallback is introduced.

`operon_convert_task` converts inline ↔ file through Operon's transition-safe paths. File-to-inline requires an explicit `targetPath`. Official Operon 3.2.0 uses its configured target/template contract and does not accept arbitrary `targetFolder`; the legacy Public API path retains scoped folder support.

`operon_relocate_task` moves an inline task to an explicit Markdown `targetPath` through Operon while preserving `operonId`. Official Operon 3.2.0 resolves a live blank destination line through `context.build`; it never guesses a line or writes the file directly. Source and target are verified after the index settles.

`operon_list_pending_recoveries` lists durable official recovery references without applying anything, but only while the path allowlist is empty. `operon_recover_mutation` is always same-plan recovery. Its public input is `{ idempotencyKey, recoveryRef, recovery }`, where `recovery` is `{ kind: "developer-api" }` or `{ kind: "adopt" | "periodic-create" | "periodic-update", planDigest?: sha256 }`. The Developer API branch accepts no `planDigest`. Only the three Task Workflow branches accept the optional digest to bind recovery to the sealed receipt/replay. Without that digest, the Bridge can prove the Task Workflow binding only from the matching `pendingRecoveries` entry; otherwise recovery fails closed before dispatch. Top-level `kind`/`planDigest` is an internal candidate/legacy migration shape, not the public tool contract. Any non-empty path allowlist also blocks listing and apply because no canonical recovery route can be proved inside it. The tool requires both opt-ins plus full MCP write mode and preserves the original `planDigest`/`recoveryRef` evidence when present.

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

Deletion, reminders, pinned state, timer control/session, and
saved-filter management remain outside the official agent mutation surface.
Saved-filter **execution** is available on Operon `3.5.3` when the exact ID and
grant are present; catalog discovery and filter creation/editing are not.
Adoption is available after its exact additive grants and the shared live contract gates. Delete remains an
operator CLI action. A future `operon_trash_task` may be considered only with
guaranteed restoration under the same `operonId`, reconciled relations, durable
journal evidence, and an explicit human confirmation; it is not implemented.

## 3.2.0 admission

Optimike MCP `3.2.0`, Bridge `0.8.3`, Operon `3.6.0`,
Operon CLI `1.2.0` and Local REST API `5.1.0` form the current validation set;
they do not claim a published `3.2.0` tag. Operon `3.6.0` remains
`compatible-provisional` until it joins the explicit certified evidence set,
but that label no longer masks valid mutation capabilities. Product version is
diagnostic metadata and may select an explicit deny or narrowly blocked path;
it is not a positive mutation allowlist. Contract negotiation, exact grants,
schemas, live health, settled index, write policy and recovery remain mandatory.

Task-workflow status is advisory rather than a preflight denylist. The first
adoption or periodic operation reaches the Bridge, which requests only that
workflow's exact additive grant, but only when status still proves the global
Bridge mutation setting is enabled. That setting is reported separately from
the currently warm write capabilities, so a fully cold session is not mistaken
for a globally read-only Bridge. Bridges that predate this explicit field keep
their advertised capability gate and do not receive the new cold-grant bypass.
Pending, refused or malformed grants fail
closed without revoking established core sessions. Periodic creation persists
no idempotency reservation before that negotiation succeeds, so the same request
and key can be retried after manual approval. The MCP journal likewise releases
only a Bridge-certified pre-dispatch reservation (`mutationMayHaveApplied: false`);
all ambiguous transport or post-dispatch failures remain durable and fail closed.
Ordinary healthy or degraded status polls never negotiate additive filter,
workflow, or recovery grants; only the exact operation or dedicated recovery
surface may do so.

The public Developer API V1 contract did not drift from Operon `3.5.3` to
`3.6.0`. The latter nevertheless changes Task Editor relation cleanup, permits
Scheduled Date on a blocked task, and optionally expands a parent's date range
after a child mutation. These behaviors must be tested in the enabled vault
configuration; they never authorize accepting unrelated postflight drift.
