# Operon integration decision report

## 3.2.0 candidate admission — 2026-08-30

The Optimike MCP `3.2.0` candidate and Bridge `0.8.3` target official Operon
`3.6.0`, Operon CLI `1.2.0` and Local REST API `5.1.0`. This is not yet a
published Optimike MCP release, and only an exact-SHA Pilot 2 run after a clean
rebuild is release evidence. The candidate preserves ordered `taskGallery` values,
keeps `taskType` and `taskImage` scalar, rejects writes to `__taskDataType`, and
adds two bounded Daily/Weekly operations. Official adoption and periodic
workflows negotiate their exact additive grants on first use; missing grants fail closed and
never activate a Markdown fallback. Operon remains the owner of every opaque
sealed plan and same-plan recovery.

The deterministic contract remains `compatible-provisional`: this label
describes certification evidence, not mutation admission. A non-denied future
Operon release remains writable when the exact Developer API V1 contract,
capabilities, schemas, live health, settled index and recovery support validate.
Malformed or incomplete negotiation still fails closed.
The disposable Pilot 2 vault is upgraded and tested directly after recording
its initial state and keeping only the minimal diagnostic/rollback evidence.
The real startup-order sub-gate is green: one MCP client survived the initial
degraded status and became live after Pilot 2 opened. The final patched
candidate (`#182` + `#183` + `#184`, combined code head `4412a20`, local
attested manifest version `3.5.240438`) also passed the
complete canary with exact restoration, zero retained periodic artifacts and
zero pending recoveries. Operon `3.5.3` historically ships superseding
implementations of those fixes. Working-tree Pilot 2 runs subsequently exercised
stock Operon `3.6.0` with Bridge `0.8.3`, including startup-order continuity on
one MCP connection, mutation/replay/stale-conflict/recovery, adoption,
Frontmatter Date Manager settlement, zero validation violations and exact
restoration. Periodic runs are historical/diagnostic only: the exact-SHA canary
performs periodic preview and exact-grant negotiation but skips periodic applies
because the public plan exposes no pre-apply task-source path
(`public_task_source_projection_unavailable`). The tools remain available; this
is a destructive-canary containment/certification boundary, not full periodic
certification. The upstream public path projection is a nonblocking follow-up.
Those runs are diagnostic rather than evidence for the final
candidate SHA. The exact release gate and execution journal live in [the local
validation recipe](operon-local-validation.md).

The `3.6.0` public Developer API V1 contract directory is unchanged from
`3.5.3`, so its provisional admission remains contract-first rather than a
product-version allowlist. Its Task Editor relation cleanup, Scheduled Date on
blocked tasks and opt-in parent-date expansion are observable product behavior.
The dedicated working-tree Pilot 2 gate historically exercised the Scheduled
Date case through the periodic workflow while preserving `blockedBy` and inverse
`blocking`, then restored the fixture and removed the run-owned periodic parent
artifact. This apply is historical/diagnostic evidence only. The exact-SHA
release canary does not repeat Scheduled Date apply: it performs periodic preview
and exact-grant negotiation, then records `SKIP` with reason
`public_task_source_projection_unavailable` because the public plan exposes no
pre-apply task-source path. Task Editor deletion is explicitly `SKIP` without a
public delete surface, and parent-date expansion is explicitly `SKIP` while the
public configuration does not announce the opt-in automation as active. These
are bounded behavior results, not broadened MCP postflight acceptance.

## Historical status — 2026-08-17

Optimike Obsidian MCP Bridge `0.7.0` certifies Operon through `3.2.1` and admits
the non-denied Operon `3.3.2` version with its Developer API V1 accessor as
`compatible-provisional`. Developer API status, schema, index readiness, and
capabilities remain separate live-use gates. The canonical server registers
twenty-three governed Operon tools at that historical baseline. Kairélys remains disabled and retained only
for bounded rollback compatibility.

The complete local acceptance run is green on Operon `3.3.2`, Operon CLI
`1.1.2`, and Bridge `0.7.0`: persisted grants, governed
apply/replay/conflict/postflight, saved-filter execution, a non-terminal
transition and exact restoration, thirty tasks, zero validation violations and
zero recovery. Settings grant controls, implicit File Task rename refusal, and
unscoped transition settlement are fixed upstream. Adoption remains the only
tracked official API gap ([#140](https://github.com/hasanyilmaz/operon/issues/140)).

No MCP or Bridge route falls back to raw Markdown, private Operon methods or UI
commands when a capability is missing or an outcome is uncertain.

## Implemented surface: historical baseline and 3.1 extension

- official Operon `3.2.0` Developer API V1 adapter;
- Bridge status/configuration/list/get/query/validate and complete pagination;
- six bounded native reasoning reads: diagnostics, finder, entity resolution,
  relationships, context and timer state;
- governed create, update, transition, relationship replacement, recurrence,
  conversion and inline relocation;
- saved-filter execution through `tasks.filter-query` after an exact grant and
  caller-supplied filter ID; at the historical 3.3.2 baseline, adoption was
  an unavailable compatibility tool;
- durable pending-recovery listing and exact-plan recovery;
- dry-run by default, live `expectedRevision`, durable idempotency and postflight;
- SQLite live/stale snapshots and mutation journal;
- double mutation opt-in and mode-based write policy;
- no generic CLI passthrough.

The 3.1 release extends that list to twenty-five tools with
`operon_create_periodic_task` and `operon_update_periodic_scheduling`; adoption
is now official but still grant-gated.

## Why MCP and CLI remain separate

The MCP is the agent control plane. It exposes only bounded semantic operations
with least-privilege capabilities, revision locking, idempotency, postflight and
recovery evidence.

The CLI is the operator/admin surface. It remains appropriate for native
acceptance, broad diagnostics, recovery investigation, one-off administration,
delete, reminders, pinned state and timer control/session.

CLI availability alone is not sufficient to expose a function to agents. A
generic passthrough would bypass the Bridge contract and hide capability drift.

## Operon 3.2.0 acceptance evidence

The patched local acceptance build passed:

- host-owned grant and consumer identity checks;
- live configuration, exact reads and coherent 25-task inventory;
- native saved-filter execution with opaque pagination;
- typed preview/apply, postflight and receipt evidence;
- stale-revision conflict and idempotent replay without a second write;
- transition and same-plan recovery after restart;
- relationship replacement, inverse-edge verification and blocked terminal
  transition enforcement;
- recurrence add, scope change and explicit clear;
- exact restoration of the two relationship tasks;
- fixture removal through the operator CLI;
- restart with live source, no residual relationship or recurrence state, no
  pending recovery and `P0/P1/P2 = 0/0/0`.

The MCP repository passed its full local Operon, runtime, profile, annotation,
documentation and package checks. Remote CI is a separate publication gate.

## Historical evidence

The disposable Operon `2.5.0`/Kairélys pilot remains historical evidence for
legacy Public API v1 only. It proved file/inline creation, managed and unmanaged
properties, hierarchy/dependencies, blocked/released transitions, conversion,
idempotency, stale-revision conflict, reindex/restart, stale cache and duplicate
ID refusal. It is not presented as Developer API V1 evidence.

## Operon 3.3.2 acceptance evidence

The production-shaped ÉLYSIA baseline was upgraded through official Operon
`3.3.2` with Operon CLI `1.1.2`, Bridge `0.7.0`, both mutation opt-ins, and
Developer API V1. Pre-cutover backups and paired rollback paths were verified
before installation.

Observed results:

- two complete Obsidian restarts retained the active Bridge consumer grant at
  revision 6 with no pending capability and required no manual re-exposure;
- Bridge status reported `compatible-provisional`, a valid V1 channel, a ready
  live index, and 30 tasks;
- `operon_validate` returned `P0/P1/P2 = 0/0/0`, and the exact saved-filter
  route `fs_elysia_now` executed successfully;
- smoke task `1dbefy1` passed sealed preview/apply, idempotent replay,
  stale-revision conflict, semantic restoration, and postflight re-read;
- final pending recovery inventory was empty after restoration.
- a temporary task passed `Planifié → En cours → Planifié` with two terminal
  applies and fresh host consent; it was then removed through the operator CLI
  after backup;
- the final live snapshot returned to 30 tasks and `P0/P1/P2 = 0/0/0`.

The lost-response path was not forced against the live vault. Its exact-plan
reconciliation remains fixture evidence, not part of this live acceptance
claim.

The 2026-08-01 Operon `3.0.1` cutover and CLI `1.0.0` Windows observations also
remain historical. The `3.5.3` / Bridge `0.8.2` evidence is historical;
Optimike MCP `3.8.1` targets Operon `3.6.1`, Bridge `0.9.2` and CLI `1.2.0`,
subject to its exact-SHA release gate.

## Deliberately excluded or unavailable

- deletion: CLI operator action until a reversible `operon_trash_task` contract
  exists;
- reminders, pinned state and timer control/session: retained in the CLI;
- official adoption in the 3.5.3 release remains capability- and grant-gated;
  it was unavailable in the historical 3.3.2 Developer API generation;
- saved-filter execution is available with an exact ID and grant, while catalog
  discovery and filter creation/editing remain unavailable;
- generic CLI execution: rejected;
- actual multi-device Sync topology: not run by this local acceptance pilot.

## Decision

Keep the current Operon integration active. Use MCP/Bridge for governed agent
workflows and CLI for broad operator work. Keep Kairélys disabled but available
for rollback until a separate non-dependency proof authorizes removal.

The 3.1.1 implementation is released from merge commit
`77322f84903fddfdc1bb056981b997a96bdeebca`. Its stock Operon 3.5.3 / Bridge
0.8.1 Pilot 2 evidence remains valid. Bridge 0.8.2 repeated the complete
Pilot 2 canary with exact fixture and inventory restoration, zero validation
violations, zero pending recoveries and zero retained periodic artifacts while
adding cold first-use negotiation for the exact additive workflow grant.
Bridge 0.8.3 is the current 3.2.0 candidate and preserves those gates while
hardening public failure and replay semantics. The
separate real
Sync/non-dependency decision remains outside this integration scope.
