# Operon integration decision report

## Current status — 2026-08-09

Optimike Obsidian MCP targets official Operon `3.2.1` through Bridge `0.6.0`
and Developer API V1. The canonical server registers twenty-three
governed Operon tools. Kairélys remains disabled and retained only for bounded
rollback compatibility.

The complete local acceptance run is green on a contract-compatible Operon `3.2.0` build carrying
only the settings-renderer fix that restores Developer API grant controls. The
equivalent 3.2.1 fix is tracked in upstream #145/#146. Remaining fail-closed
limitations are tracked in:

- transition settlement: [#99](https://github.com/hasanyilmaz/operon/issues/99)
  and [#101](https://github.com/hasanyilmaz/operon/pull/101);
- implicit File Task description/rename behavior:
  [#139](https://github.com/hasanyilmaz/operon/pull/139).

No MCP or Bridge route falls back to raw Markdown, private Operon methods or UI
commands when a capability is missing or an outcome is uncertain.

## Implemented surface

- official Operon `3.2.0` Developer API V1 adapter;
- Bridge status/configuration/list/get/query/validate and complete pagination;
- six bounded native reasoning reads: diagnostics, finder, entity resolution,
  relationships, context and timer state;
- governed create, update, transition, relationship replacement, recurrence,
  conversion and inline relocation;
- saved-filter execution through `tasks.filter-query` after an exact grant and
  caller-supplied filter ID; adoption remains an unavailable compatibility tool;
- durable pending-recovery listing and exact-plan recovery;
- dry-run by default, live `expectedRevision`, durable idempotency and postflight;
- SQLite live/stale snapshots and mutation journal;
- double mutation opt-in and mode-based write policy;
- no generic CLI passthrough.

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

The 2026-08-01 Operon `3.0.1` cutover and CLI `1.0.0` Windows observations also
remain historical. Current targets are Operon `3.2.0` and CLI `1.1.0`.

## Deliberately excluded or unavailable

- deletion: CLI operator action until a reversible `operon_trash_task` contract
  exists;
- reminders, pinned state and timer control/session: retained in the CLI;
- adoption remains unavailable in the official Developer API;
- saved-filter execution is available with an exact ID and grant, while catalog
  discovery and filter creation/editing remain unavailable;
- generic CLI execution: rejected;
- actual multi-device Sync topology: not run by this local acceptance pilot.

## Decision

Keep the current Operon integration active. Use MCP/Bridge for governed agent
workflows and CLI for broad operator work. Keep Kairélys disabled but available
for rollback until a separate non-dependency proof authorizes removal.

The code and local acceptance work are complete. Remaining work is reviewing
and publishing the prepared MCP and Operon settings patches under separate
authorization, plus the separate real Sync/non-dependency decision.
