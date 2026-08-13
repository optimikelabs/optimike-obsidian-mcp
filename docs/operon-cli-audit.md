# Operon CLI / Developer API audit

French version: [operon-cli-audit.fr.md](operon-cli-audit.fr.md)

Date: 2026-08-13
Reference: official Operon `3.3.0` provisionally admitted by contract, certified Operon `3.2.1`, Operon CLI `1.1.0`, Developer API V1 and `cli-manifest-v1.json`.

The original 2026-08-01 CLI observations were made against Operon `3.0.1` and
remain historical evidence. The current MCP adapter certifies `3.2.1` and
admits `3.3.0` provisionally after contract negotiation. The complete `3.3.0`
live acceptance run is green; the missing settings renderer is tracked in
[#145](https://github.com/hasanyilmaz/operon/issues/145) and
[#146](https://github.com/hasanyilmaz/operon/pull/146). Fixes #135 and #137 are already merged. File Task rename safety
remains tracked in [#139](https://github.com/hasanyilmaz/operon/pull/139), and
uncertain transition settlement in [#99](https://github.com/hasanyilmaz/operon/issues/99)
and [#101](https://github.com/hasanyilmaz/operon/pull/101). The MCP remains
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

The MCP registers twenty-three governed tools, including six bounded Developer
API reasoning reads. Saved-filter execution is available when the negotiated
task-workflow contract advertises it
after an exact `tasks.filter-query` grant, but the official API does not expose
the saved-filter catalog. Adoption remains an unavailable compatibility tool:

- reads: status, configuration, list/get/query, capability-gated saved filters, validation;
- native reasoning reads: diagnostics, finder, resolve, relationships, context,
  and timer state;
- mutations: capability-gated adoption, create, update, transition, relationships, recurrence, convert, relocate;
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

| Candidate | ÉLYSIA utility | Risk | Decision |
| --- | --- | --- | --- |
| diagnostics snapshot | High | Low | Implemented read-only through Developer API V1 |
| task finder / entity resolve | High | Low | Implemented with bounded candidates/results |
| relationships read | High | Medium | Implemented with one exact root, depth ≤ 3 and result cap |
| context pack | High | Medium | Implemented with projections, size caps and hydration allowlist |
| timer read | Medium | Low | Implemented as observation only; no timer control |
| relationship writes | High | Medium-High | Implemented as complete typed replacement with revision, sealed preview/apply, inverse-edge postflight and recovery |
| recurrence writes | Medium-High | High | Implemented as scoped typed update; apply requires full mode, postflight and recovery |
| reminder writes | Medium | High | Defer; keep in CLI until a concrete agent use case and dedicated contract exist |
| timer control/session | Medium | High | Defer; changes active execution state and needs an explicit human gate |
| pinned state | Low-Medium | Medium | Defer; presentation/state preference, not a core ÉLYSIA action |
| delete | Medium | Destructive | Do not expose until a dedicated reversible-trash contract exists |
| generic CLI command | Unbounded | High | Reject; it bypasses the Bridge contract and makes capability drift invisible |

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

The remaining official transition edge may still return the bounded `outcome-unknown` result
tracked by [Operon #99](https://github.com/hasanyilmaz/operon/issues/99) and
[#101](https://github.com/hasanyilmaz/operon/pull/101). When the runtime cannot
prove its result, the Bridge reports the uncertainty and does not retry or fall
back to Markdown/private APIs. This remains a capability gate, not a hidden bypass.

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
package version is `1.1.0`, but this update does not claim every former handler
failure was requalified through the CLI. Keep the MCP/Bridge contract independent
and bounded; keep the CLI for operator diagnostics, native acceptance and
recovery investigation. No real mutation was applied during the historical audit.
