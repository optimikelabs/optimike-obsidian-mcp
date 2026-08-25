# ADR — Operon Bridge for Optimike Obsidian MCP

- Status: accepted and implemented on `main`
- Date: 2026-07-21
- Amended: 2026-08-24
- MCP baseline: `optimikelabs/optimike-obsidian-mcp@8cea94610a526e50a017d334be6008b8dab79500`
- Operon baselines: upstream `2.4.0@76d251973b149afc69192ef565d626740aa7b7cf`, `2.5.0@31099cc3d5231b320cd8520424fc29449b003778`, certified official `3.2.1`, historical live `3.3.2`, and provisional candidate `3.5.3` / CLI `1.2.0`

## Problem

Operon unifies inline and file tasks around stable identity and one domain model. Earlier releases exposed no public versioned mutation API; official Operon `3.5.3` exposes Developer API V1 plus additive saved-filter, adoption and Daily/Weekly task workflows. Agent writes must still preserve workflow normalization, dependencies, recurrence, aggregates, project serials, archiving, auto-unpin, conversions, ordered task media and index/view reconciliation. Direct Markdown edits or direct `TaskWriter` calls do not satisfy that contract.

## Decision

Use one MCP server and three explicit layers:

```text
Official Operon 3.x / legacy Kairélys
    ↓ Developer API V1 / PublicApiV1
Optimike Operon Bridge
    ↓ Local REST API contract v1
Optimike Obsidian MCP
    ↓ tools, write policy, durable journal and validated snapshot
Agents
```

Official Operon `2.4.0` and `2.5.0` remain supported for reads. Official Operon `3.2.x` uses its host-verified Developer API V1 for typed mutation plans and exact-grant saved-filter execution; legacy Kairélys uses Public API v1. No fallback crosses either capability boundary.

## Component decisions

- `KEEP` — Optimike Obsidian MCP as the only MCP server.
- `KEEP` — existing runtime modes, REST client, logger, errors, stdio/HTTP transports, write policy, and shared SQLite.
- `KEEP DISABLED` — Tasks and TaskNotes only as reversible rollback assets after the completed cutover.
- `ADD` — companion Bridge for live reads and guarded mutations.
- `KEEP` — the legacy Kairélys/Public API v1 path only as a bounded rollback compatibility surface.
- `ADD` — twenty-five governed Operon MCP tools, including six bounded native reads, relationship and recurrence writes, official adoption, Daily/Weekly workflows, snapshot tables, durable mutation journal, and same-plan recovery.
- `REJECT` — MCP-side Operon parser/domain reimplementation.
- `REJECT` — raw Markdown/YAML mutation fallback.
- `REJECT` — reflective production calls to private Operon methods.
- `DEFER` — production migration, Tasks/TaskNotes removal, and Sync-topology acceptance.

## Public API boundary

`OperonPublicApiV1` remains the legacy Kairélys boundary. Official Operon `3.x` exposes host-verified Developer API V1 reads plus preview/apply/recovery for typed create, update, transition, relationship replacement, recurrence update, conversion, and inline relocation. Operon `3.5.3` exposes exact-grant adoption and Daily/Weekly workflows through the additive task-workflow API. Those plans are opaque and session-bound; recovery continues only the same `recoveryRef`. Task Type and Task Image remain scalar, Task Gallery remains ordered, and `__taskDataType` remains read-only. Elevated or destructive applies require fresh host-owned consent in the owning vault window and fail closed after a bounded timeout.

No ÉLYSIA-specific workflow, UX, view, calendar, Kanban, or data-model logic belongs in Operon. Compatibility fixes remain generic upstream PRs; the MCP never depends on private methods or an ÉLYSIA-specific Operon fork.

## Read model

The Bridge reads Operon's V8 index and accepts only a compatible, healthy, idle, clean generation. The MCP replaces its SQLite snapshot only after complete pagination, coherent generation/settings/version checks, and zero P0 validation.

If live access fails, the last snapshot may be returned only as `operon-cache` with `stale: true`. A stale snapshot is never mutation evidence.

## Mutation model

Every apply requires a live Bridge, the matching official mutation surface, the Bridge mutation toggle, and `OPERON_MUTATIONS_ENABLED=true`. Existing Operon-task mutations require `expectedRevision`; adoption requires an exact source path, one-based line and `expectedLine`; every request requires `idempotencyKey`; `dryRun` defaults to true. Official Operon applies only the exact opaque host-sealed preview plan and surfaces `outcome-unknown` with recovery metadata. Recovery is a separate same-plan route, never a new mutation. The public input nests ownership under `recovery`: `{ kind: "developer-api" }` or `{ kind: "adopt" | "periodic-create" | "periodic-update", planDigest?: sha256 }`. The flat top-level kind/digest shape is internal migration state only. A non-empty mutation path allowlist disables pending-recovery listing and apply because the recovery record exposes no canonical route that can be proved inside that scope.

The Bridge returns before/requested/after and waits for a verified idle index after apply. The MCP reserves the idempotency key durably before the Bridge call, stores the result in `operon_mutation_journal`, and blocks blind retry after an uncertain timeout/restart. The same completed key and request never call the Bridge twice, while reuse with a different request is rejected as a conflict.

To avoid false atomicity, update accepts exactly one group per operation: description, managed fields/tags, or one unmanaged file property. Status uses the dedicated transition operation. Conversion requires full write mode.

## Runtime policy

- Live/hybrid with API: exact reads and mutations according to capabilities.
- Headless: cached reads only; no mutation.
- `readonly`: dry-run only.
- `guarded`: capability-backed adopt/create/Daily-Weekly/periodic-scheduling/update/transition/relationship/relocate apply with normal preconditions and fresh consent when the sealed plan is elevated.
- `full`: conversion, recurrence and exact-plan recovery apply in addition.

## Evidence gates

The disposable Operon 2.5 vault remains historical evidence for the legacy Public API path. The local Operon 3.2.0 acceptance build passed host grant/identity checks, live exact reads, saved-filter execution with opaque pagination, typed preview/apply for the validated mutation families, relationship inverse-edge verification, scoped recurrence add/change/clear, postflight, idempotent replay, exact restoration, and restart/recovery without a Markdown/private-API fallback. The build differs from the release only by the settings-renderer fix that restores Developer API grant controls.

The patched Operon `3.5.2` acceptance candidate combining upstream PRs `#182`,
`#183` and `#184` passed the complete Pilot 2 canary on 2026-08-24. It proved
non-blocking startup before Obsidian, exact-grant auth, Daily/Weekly creation,
periodic scheduling with a configured modified-time plugin, same-source graph
ordering, durable concurrent replay, zero validation violations, zero pending
recoveries and exact restoration. This remains historical evidence for the
pre-release candidate; Operon `3.5.3` ships superseding implementations and is
the current official validation target.

Still outside this local acceptance proof:

- actual Sync topology test;
- upstream review of the settings-renderer patch and remaining #99/#101/#139 paths;
- separate Kairélys non-dependency/removal decision.

## Security and licensing

- Local REST API owns bearer authentication and TLS.
- The MCP owns write policy and durable idempotency.
- The Bridge exposes no note bodies or raw task lines.
- The MCP remains Apache-2.0.
- The Operon fork remains GPL-3.0-or-later.
- No Operon source is copied into the MCP.

## Stop rules

Stop and keep Tasks + TaskNotes if the fork must absorb product UX/domain changes, two consecutive upstream releases break the thin API, a mutation cannot prove final indexed state, Sync creates silent loss/duplication, or Operon fails to remove the existing duplicate task layers.
