# ADR — Operon Bridge for Optimike Obsidian MCP

- Status: accepted for bounded pilot
- Date: 2026-07-21
- MCP baseline: `optimikelabs/optimike-obsidian-mcp@8cea94610a526e50a017d334be6008b8dab79500`
- Operon baselines: upstream `2.4.0@76d251973b149afc69192ef565d626740aa7b7cf` and `2.5.0@31099cc3d5231b320cd8520424fc29449b003778`

## Problem

Operon unifies inline and file tasks around stable identity and one domain model, but official releases expose no public versioned mutation API. Agent writes must preserve workflow normalization, dependencies, recurrence, aggregates, project serials, archiving, auto-unpin, conversions, and index/view reconciliation. Direct Markdown edits or direct `TaskWriter` calls do not satisfy that contract.

## Decision

Use one MCP server and three explicit layers:

```text
Optimike Operon 2.5.0 minimal GPL fork
    ↓ OperonPublicApiV1
Optimike Operon Bridge
    ↓ Local REST API contract v1
Optimike Obsidian MCP
    ↓ tools, write policy, durable journal and validated snapshot
Agents
```

Official Operon `2.4.0` and `2.5.0` remain supported for reads. Mutations appear only when Public API v1 is present. No fallback crosses that capability boundary.

## Component decisions

- `KEEP` — Optimike Obsidian MCP as the only MCP server.
- `KEEP` — existing runtime modes, REST client, logger, errors, stdio/HTTP transports, write policy, and shared SQLite.
- `KEEP` — Tasks and TaskNotes during the pilot and until a separate production cutover gate.
- `ADD` — companion Bridge for live reads and guarded mutations.
- `ADD` — minimal Operon GPL fork exposing only generic Public API v1 wrappers over existing domain orchestrators.
- `ADD` — nine Operon MCP tools, snapshot tables, and mutation journal.
- `REJECT` — MCP-side Operon parser/domain reimplementation.
- `REJECT` — raw Markdown/YAML mutation fallback.
- `REJECT` — reflective production calls to private Operon methods.
- `DEFER` — production migration, Tasks/TaskNotes removal, and Sync-topology acceptance.

## Public API boundary

`OperonPublicApiV1` exposes capability discovery plus create, update, transition, and convert. The implementation stays inside Operon and calls its existing creator, workflow, writer, dependency, recurrence, aggregate, archive, and conversion paths.

The fork delta must remain limited to this generic API and contract tests. No ÉLYSIA-specific workflow, UX, view, calendar, Kanban, or data-model logic belongs in the fork. An upstream PR remains preferred; the fork is the production fallback.

## Read model

The Bridge reads Operon's V8 index and accepts only a compatible, healthy, idle, clean generation. The MCP replaces its SQLite snapshot only after complete pagination, coherent generation/settings/version checks, and zero P0 validation.

If live access fails, the last snapshot may be returned only as `operon-cache` with `stale: true`. A stale snapshot is never mutation evidence.

## Mutation model

Every apply requires a live Bridge and Public API v1. Existing-task mutations require `expectedRevision`; every request requires `idempotencyKey`; `dryRun` defaults to true.

The Bridge returns before/requested/after and waits for a verified idle index after apply. The MCP stores the result in `operon_mutation_journal`; the same idempotency key and request never call the Bridge twice, while reuse with a different request is rejected as a conflict.

To avoid false atomicity, update accepts exactly one group per operation: description, managed fields/tags, or one unmanaged file property. Status uses the dedicated transition operation. Conversion requires full write mode.

## Runtime policy

- Live/hybrid with API: exact reads and mutations according to capabilities.
- Headless: cached reads only; no mutation.
- `readonly`: dry-run only.
- `guarded`: create/update/transition apply.
- `full`: conversion apply in addition.

## Evidence gates

The disposable Operon 2.5 vault has passed file/inline creation, ÉLYSIA properties, hierarchy, dependency rejection/release, status transitions, identity-preserving conversions, reindex, plugin restart, live/stale cache, idempotency, revision conflicts, and duplicate-ID P0 refusal.

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
