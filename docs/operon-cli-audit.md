# Operon CLI / Developer API audit

Date: 2026-08-08
Reference: official Operon `3.1.1`, Operon CLI `1.0.9`, Developer API V1 and `cli-manifest-v1.json`.

The original 2026-08-01 CLI observations were made against Operon `3.0.1` and
remain historical evidence. The current MCP adapter targets `3.1.1`; its full
acceptance proof uses the patched local Operon build while upstream fixes are
under review in [#135](https://github.com/hasanyilmaz/operon/pull/135),
[#137](https://github.com/hasanyilmaz/operon/pull/137), and
[#139](https://github.com/hasanyilmaz/operon/pull/139). Stock `3.1.1` remains
the supported production target for reads and most governed mutations, with
uncertain transition settlement tracked by [#99](https://github.com/hasanyilmaz/operon/issues/99)
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

The MCP currently exposes the governed task surface plus native saved-filter
evaluation and six bounded Developer API reads:

- reads: status, configuration, list/get/query, saved filters, validation;
- native reasoning reads: diagnostics, finder, resolve, relationships, context,
  and timer state;
- mutations: adopt, create, update, transition, relationships, recurrence, convert, relocate;
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

Official Operon `3.1.1` native Developer API acceptance on the patched local
build passed host grant and identity checks, live reads, typed preview/apply,
receipt/postflight, idempotent replay, restart, and same-plan recovery. The
production Bridge pilot also passed live read, typed create/update/transition
preview/apply, replay, and stale revision conflict.

The relationship and recurrence extensions pass the adapter, Bridge contract,
service, policy, idempotency/restart and documentation suites. Their new live
acceptance remains pending: the isolated 3.1.1 pilot persists the exact nine-
capability expansion request, but the Operon settings panel currently renders
no consumer row or approval controls. The grant is not edited or bypassed.

Stock `3.1.1` may still return the bounded `outcome-unknown` transition result
tracked by [Operon #99](https://github.com/hasanyilmaz/operon/issues/99) and
[#101](https://github.com/hasanyilmaz/operon/pull/101). The patched local build
passes the terminal/recovery proof; when the stock runtime cannot prove its
result, the Bridge reports the uncertainty and does not retry or fall back to
Markdown/private APIs. This remains a capability gate, not a hidden bypass.

The read audit and implementation of the two useful advanced writes are complete; live promotion waits for the official grant UI. Other advanced writes remain outside MCP until each has a
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

Conclusion: the CLI is a broader operator surface, but it is not a dependable
transport layer for MCP on this Windows installation. Keep the MCP/Bridge
contract independent and bounded; keep the CLI for operator diagnostics,
native acceptance and recovery investigation until Operon fixes the affected
Windows handlers. No real mutation was applied during this audit.
