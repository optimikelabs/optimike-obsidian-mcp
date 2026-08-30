# Operon CLI / Developer API audit

French version: [operon-cli-audit.fr.md](operon-cli-audit.fr.md)

Updated: 2026-08-30
Candidate target: Optimike MCP `3.2.0` uses Bridge `0.8.3` with official Operon `3.6.0`, Operon CLI `1.2.0`, Local REST API `5.1.0`, Developer API V1 and the additive task-workflow API. Working-tree Pilot 2 runs exercised that stack; release admission still requires the same gate on the clean final SHA. The public Developer API V1 contract did not drift between Operon `3.5.3` and `3.6.0`. `compatible-provisional` describes certification evidence only; mutation admission follows the negotiated contract and exact live capabilities rather than a product-version allowlist. Additive task workflows negotiate their exact grant on first use after a cold start.

Operon CLI `1.2.0` adds operator access to Daily/Weekly routing and the typed
Task Type, Task Image and ordered Task Gallery fields. The MCP does not relay
the CLI generically: it exposes only the two bounded periodic operations and
official adoption after their exact grants. Operon owns every opaque sealed
plan and same-plan recovery. `taskType` and `taskImage` remain scalar,
`taskGallery` remains an ordered array, and `__taskDataType` is read-only.

Operon `3.6.0` changes three product behaviors that stay outside the generic MCP
write contract: Task Editor deletion cleans direct child and blocking
relationships; a blocked task may receive a Scheduled Date; and its opt-in
parent-date automation can expand a parent's date range after a child mutation.
The working-tree Pilot 2 behavior gate exercised the Scheduled Date case through
`operon_update_periodic_scheduling`: the blocked relationship and inverse edge
were preserved, and the run-owned periodic parent artifact was removed during
exact restoration. Task Editor deletion remains `SKIP` because no public MCP
delete surface exists. Parent-date expansion remains `SKIP` because Pilot 2's
public configuration does not announce that opt-in automation as active.
Operators enabling those features should test the two skipped behaviors before
depending on them. A postflight never treats unrelated parent or relationship
drift as an accepted write.

## Historical 3.3.2 acceptance

The original 2026-08-01 CLI observations were made against Operon `3.0.1` and
remain historical evidence. The current MCP adapter certifies `3.2.1` and
admits `3.3.2` provisionally after contract negotiation. The complete `3.3.2`
live acceptance run is green with CLI `1.1.2`: Settings grant controls, File
Task rename refusal, and unscoped transition settlement are fixed upstream.
Adoption was unavailable through that Developer API generation and was tracked
in [#140](https://github.com/hasanyilmaz/operon/issues/140). Operon `3.5.3` now
exposes it through exact additive grants. The MCP remains
fail-closed and does not fall back to Markdown or private APIs.

## Decision

Keep the Bridge as the ÉLYSIA-facing control plane. It gives MCP a stable,
normalized task contract, live-generation checks, `expectedRevision`,
idempotency, the two mutation opt-ins, postflight verification, and a narrow
same-plan recovery route. Keep the CLI as an operator/admin surface for
native acceptance, deep recovery investigation, broad administration, and
one-off actions. MCP now exposes the six bounded native reads that agents need
for ordinary reasoning: diagnostics, finder, entity resolution, relationships,
context packs, and timer state.
Do not expose a generic CLI passthrough through MCP.

## Surface comparison

The MCP registers twenty-five governed tools, including six bounded Developer
API reasoning reads. Saved-filter execution is available when the negotiated
task-workflow contract advertises it
after an exact `tasks.filter-query` grant, but the official API does not expose
the saved-filter catalog. Adoption and periodic-note workflows remain
capability-gated:

- reads: status, configuration, list/get/query, capability-gated saved filters, validation;
- native reasoning reads: diagnostics, finder, resolve, relationships, context,
  and timer state;
- mutations: capability-gated adoption, create, Daily/Weekly create, periodic scheduling update, transition, relationships, recurrence, convert, relocate;
- recovery: list pending official recoveries and recover one exact plan.

The official CLI/Developer API additionally exposes:

- `system.health`, `system.capabilities`, `system.diagnostics`, and catalog;
- entity resolution and task finder queries;
- relationship reads and context packs;
- timer reads;
- typed recurrence, relationship, reminder, pinned-state, timer-control,
  timer-session, delete, conversion, relocation, transition, create, and update
  mutation plans.

The difference is intentional: CLI availability is not enough to make a
function safe or useful as an agent tool. MCP should expose a bounded semantic
operation with a clear ÉLYSIA use case and a matching proof/guard.

## Extension ranking

| Candidate                    | ÉLYSIA utility | Risk        | Decision                                                                                                            |
| ---------------------------- | -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| diagnostics snapshot         | High           | Low         | Implemented read-only through Developer API V1                                                                      |
| task finder / entity resolve | High           | Low         | Implemented with bounded candidates/results                                                                         |
| relationships read           | High           | Medium      | Implemented with one exact root, depth ≤ 3 and result cap                                                           |
| context pack                 | High           | Medium      | Implemented with projections, size caps and hydration allowlist                                                     |
| timer read                   | Medium         | Low         | Implemented as observation only; no timer control                                                                   |
| relationship writes          | High           | Medium-High | Implemented as complete typed replacement with revision, sealed preview/apply, inverse-edge postflight and recovery |
| recurrence writes            | Medium-High    | High        | Implemented as scoped typed update; apply requires full mode, postflight and recovery                               |
| reminder writes              | Medium         | High        | Defer; keep in CLI until a concrete agent use case and dedicated contract exist                                     |
| timer control/session        | Medium         | High        | Defer; changes active execution state and needs an explicit human gate                                              |
| pinned state                 | Low-Medium     | Medium      | Defer; presentation/state preference, not a core ÉLYSIA action                                                      |
| delete                       | Medium         | Destructive | Do not expose until a dedicated reversible-trash contract exists                                                    |
| generic CLI command          | Unbounded      | High        | Reject; it bypasses the Bridge contract and makes capability drift invisible                                        |

## Current proof boundary

Official Operon `3.2.0` native Developer API acceptance on the local
build passed host grant and identity checks, live reads, typed preview/apply,
receipt/postflight, idempotent replay, restart, and same-plan recovery. The
production Bridge pilot also passed live read, typed create/update/transition
preview/apply, replay, and stale revision conflict.

The relationship and recurrence extensions pass the adapter, Bridge contract,
service, policy, idempotency/restart and documentation suites. Their dedicated
live Operon `3.2.0` acceptance also passed on the local build:
relationship dry-run/apply, inverse-edge verification, idempotent replay,
stale-revision conflict, blocked terminal transition, exact restoration,
recurrence add/scope-change/clear, restart/recovery stability, saved-filter
execution with opaque pagination, live source, 25 tasks after fixture cleanup,
no residual relationship/recurrence state, and `P0/P1/P2 = 0/0/0`.

Operon `3.3.2` live acceptance additionally proved a non-terminal transition
from planned to in-progress and exact restoration to planned through the
official Developer API. Both applies returned terminal results; the fixture was
removed through the operator CLI after backup. The vault returned to 30 tasks,
no recovery remained, and validation returned `P0/P1/P2 = 0/0/0`.

The read audit, implementation and live acceptance of the two useful advanced
writes are complete. Other advanced writes remain outside MCP until each has a
dedicated preview/apply, revision, postflight, recovery and human-gate contract;
CLI availability alone is not sufficient evidence to expose them to agents.

## Windows CLI pilot evidence

On 2026-08-01, the official `operon-cli` `1.0.0` was configured against the
live ÉLYSIA vault with an isolated temporary profile. The local surface passed
version/manifest/schema inspection, setup, profile and offline doctor checks.
The live transport also passed `health`, exact `task.get`, `tasks.query`, and
`context.build`; these responses reported Operon `3.0.1`, a matching vault
identity, and verified live-runtime coherence.

The same live Windows transport returned a pre-handler failure for
`capabilities`, `diagnostics`, `catalog`, `entity.resolve`,
`relationships.get`, `tasks.finder`, `timers.read`, and typed
`mutation.preview`. The failures were reported as `obsidian-cli-exit-failed`
(`processExitCode: 4294967295`) or `persistent-write-failed`, not as an
unsupported capability. This matters because `health` advertises those
capabilities as available, while the CLI invocation itself is not reliable for
them on this pilot. `tasks.query` also emitted strict-V1 warnings for malformed
datetime metadata, omitting those fields rather than failing the whole query.

Conclusion: the CLI is a broader operator surface, but it was not a dependable
transport layer for MCP on that historical Windows installation. The current
paired package is `1.1.2`; its Windows bootstrap/health path and exact operator
deletion were validated during the `3.3.2` acceptance. This does not reclassify
every historical `1.0.0` handler observation. Keep the MCP/Bridge contract
independent and bounded; keep the CLI for operator diagnostics, native
acceptance and recovery investigation.
