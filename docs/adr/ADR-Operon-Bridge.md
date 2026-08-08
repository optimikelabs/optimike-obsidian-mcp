# ADR — Operon Bridge for Optimike Obsidian MCP

- Status: accepted and implemented on `main`
- Date: 2026-07-21
- Amended: 2026-08-08
- MCP baseline: `optimikelabs/optimike-obsidian-mcp@8cea94610a526e50a017d334be6008b8dab79500`
- Operon baselines: upstream `2.4.0@76d251973b149afc69192ef565d626740aa7b7cf`, `2.5.0@31099cc3d5231b320cd8520424fc29449b003778`, and official `3.1.1` Developer API V1

## Problem

Operon unifies inline and file tasks around stable identity and one domain model. Earlier releases exposed no public versioned mutation API; official Operon `3.1.1` now exposes Developer API V1. Agent writes must still preserve workflow normalization, dependencies, recurrence, aggregates, project serials, archiving, auto-unpin, conversions, and index/view reconciliation. Direct Markdown edits or direct `TaskWriter` calls do not satisfy that contract.

## Decision

Use one MCP server and three explicit layers:

```text
Official Operon 3.1.1 / legacy Kairélys
    ↓ Developer API V1 / PublicApiV1
Optimike Operon Bridge
    ↓ Local REST API contract v1
Optimike Obsidian MCP
    ↓ tools, write policy, durable journal and validated snapshot
Agents
```

Official Operon `2.4.0` and `2.5.0` remain supported for reads. Official Operon `3.1.1` uses its host-verified Developer API V1 for typed mutation plans; legacy Kairélys uses Public API v1. No fallback crosses either capability boundary.

## Component decisions

- `KEEP` — Optimike Obsidian MCP as the only MCP server.
- `KEEP` — existing runtime modes, REST client, logger, errors, stdio/HTTP transports, write policy, and shared SQLite.
- `KEEP` — Tasks and TaskNotes during the pilot and until a separate production cutover gate.
- `ADD` — companion Bridge for live reads and guarded mutations.
- `KEEP` — the legacy Kairélys/Public API v1 path only as a bounded rollback compatibility surface.
- `ADD` — twenty-three governed Operon MCP tools, including six bounded native reads, relationship and recurrence writes, snapshot tables, durable mutation journal, and same-plan recovery.
- `REJECT` — MCP-side Operon parser/domain reimplementation.
- `REJECT` — raw Markdown/YAML mutation fallback.
- `REJECT` — reflective production calls to private Operon methods.
- `DEFER` — production migration, Tasks/TaskNotes removal, and Sync-topology acceptance.

## Public API boundary

`OperonPublicApiV1` remains the legacy Kairélys boundary. Official Operon `3.1.1` exposes host-verified Developer API V1 reads plus preview/apply/recovery for typed create, update, transition, relationship replacement, recurrence update, conversion, and inline relocation. Elevated or destructive applies require fresh host-owned consent in the owning vault window and fail closed after a bounded timeout. The implementation stays inside Operon and calls its existing parser/converter, creator, workflow, writer, dependency, recurrence, aggregate, archive, and conversion paths.

No ÉLYSIA-specific workflow, UX, view, calendar, Kanban, or data-model logic belongs in Operon. Compatibility fixes remain generic upstream PRs; the MCP never depends on private methods or an ÉLYSIA-specific Operon fork.

## Read model

The Bridge reads Operon's V8 index and accepts only a compatible, healthy, idle, clean generation. The MCP replaces its SQLite snapshot only after complete pagination, coherent generation/settings/version checks, and zero P0 validation.

If live access fails, the last snapshot may be returned only as `operon-cache` with `stale: true`. A stale snapshot is never mutation evidence.

## Mutation model

Every apply requires a live Bridge, the matching official mutation surface, the Bridge mutation toggle, and `OPERON_MUTATIONS_ENABLED=true`. Existing Operon-task mutations require `expectedRevision`; legacy checkbox adoption requires an exact source path, one-based line and `expectedLine`; every request requires `idempotencyKey`; `dryRun` defaults to true. Official Operon 3.1.1 applies only the exact host-sealed preview plan and surfaces `outcome-unknown` with recovery metadata. Recovery is a separate same-plan route, never a new mutation.

The Bridge returns before/requested/after and waits for a verified idle index after apply. The MCP reserves the idempotency key durably before the Bridge call, stores the result in `operon_mutation_journal`, and blocks blind retry after an uncertain timeout/restart. The same completed key and request never call the Bridge twice, while reuse with a different request is rejected as a conflict.

To avoid false atomicity, update accepts exactly one group per operation: description, managed fields/tags, or one unmanaged file property. Status uses the dedicated transition operation. Conversion requires full write mode.

## Runtime policy

- Live/hybrid with API: exact reads and mutations according to capabilities.
- Headless: cached reads only; no mutation.
- `readonly`: dry-run only.
- `guarded`: capability-backed adopt/create/update/transition/relationship/relocate apply with normal preconditions and fresh consent when the sealed plan is elevated.
- `full`: conversion, recurrence and exact-plan recovery apply in addition.

## Evidence gates

The disposable Operon 2.5 vault passed file/inline creation, ÉLYSIA properties, hierarchy, dependency rejection/release, status transitions, identity-preserving conversions, reindex, plugin restart, live/stale cache, idempotency, revision conflicts, and duplicate-ID P0 refusal. The patched local Operon 3.1.1 acceptance build passed host grant/identity checks, live exact reads, typed preview/apply for the validated mutation families, relationship inverse-edge verification, scoped recurrence add/change/clear, transition consent in the owning vault window, postflight, idempotent replay, exact restoration, and restart/recovery without a Markdown/private-API fallback. Stock 3.1.1 retains the upstream limitations linked from the Operon MCP contract.

Still required before production cutover:

- actual Sync topology test;
- reconstruction of Now, Inbox, Étoile du Nord, and Audit views;
- bounded real-project usability pilot;
- upstream/fork maintenance decision;
- explicit Mike approval for production plugin installation and mutation enablement;
- separate migration/rollback approval.

## Security and licensing

- Local REST API owns bearer authentication and TLS.
- The MCP owns write policy and durable idempotency.
- The Bridge exposes no note bodies or raw task lines.
- The MCP remains Apache-2.0.
- The Operon fork remains GPL-3.0-or-later.
- No Operon source is copied into the MCP.

## Stop rules

Stop and keep Tasks + TaskNotes if the fork must absorb product UX/domain changes, two consecutive upstream releases break the thin API, a mutation cannot prove final indexed state, Sync creates silent loss/duplication, or Operon fails to remove the existing duplicate task layers.
