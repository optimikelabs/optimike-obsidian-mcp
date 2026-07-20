# ADR — Operon Bridge for Optimike Obsidian MCP

- Status: proposed for pilot
- Date: 2026-07-20
- MCP baseline: `optimikelabs/optimike-obsidian-mcp@8cea94610a526e50a017d334be6008b8dab79500`
- Operon baseline: `hasanyilmaz/operon@76d251973b149afc69192ef565d626740aa7b7cf` (`2.4.0`)
- Historical lab baseline: Operon `1.6.2`; evidence only, not an implementation source

## Problem

ÉLYSIA currently uses Obsidian Tasks as the canonical lightweight execution layer and TaskNotes for bounded rich missions. Operon offers a more coherent human model: inline tasks and file tasks share a stable `operonId`, one index, pipelines, filters, Table, Calendar, Kanban, recurrence, dependencies, hierarchy, and time tracking.

The missing boundary is agent operation. At the audited upstream SHA, Operon exposes a useful runtime index but no public, versioned JavaScript API, REST API, or MCP surface. Its documented agent workflow remains direct Markdown/YAML access. A safe integration must not pretend that `TaskWriter.writeTaskFields()` alone represents Operon's complete mutation semantics.

## Current evidence

### Current upstream code

Operon `2.4.0` exposes these runtime objects on the plugin instance:

- `indexer`
- `writer`
- `dependencyManager`
- `aggregateCoordinator`
- `recurrenceService`
- `timeTracker`
- `formatConverter`
- `settings`

The indexer exposes stable read operations such as `getAllTasks()`, `getTask()`, generation data, and duplicate-ID diagnostics. `IndexedTask` includes `operonId`, description, checkbox state, canonical/custom field values, tags, source location, modification time, tier, and optional checkbox progress.

The complete mutation path remains orchestrated inside private plugin methods. It coordinates normalization, direct writes, reindexing, dependencies, recurrence materialization, aggregate updates, project serial reconciliation, archiving/auto-unpin behavior, and UI refreshes. Calling a writer or editing Markdown externally would bypass part of that contract.

### Historical local lab

The ÉLYSIA lab validated only:

- simple inline scanning;
- stable extraction of two `operonId` values;
- parent reference extraction;
- a no-write inline patch preview.

File tasks, duplicate handling, MCP queries, mutation verification, rollback, project sleep/closure, and migration were not validated. The lab targeted Operon `1.6.2`, so none of its internal assumptions are authoritative for `2.4.0`.

## Decision drivers

1. Markdown remains the durable source of truth.
2. Live reads should use Operon's own index rather than reimplementing its parser.
3. Headless reads may use a persisted snapshot but must declare staleness.
4. Live mutations must pass through the full Operon domain path.
5. No silent fallback from an Operon mutation to raw Markdown editing.
6. One MCP server remains canonical.
7. Tasks and TaskNotes remain installed until a bounded pilot proves replacement.
8. No production-vault migration is part of this change.

## Options considered

### A — Companion Bridge, no Operon fork

Operon remains official and unmodified. A small Obsidian plugin reads its public runtime index and exposes a versioned Local REST API extension.

- Safety: high for reads
- Domain fidelity: high for reads
- Maintenance: moderate; runtime shape is not an official API
- Headless: snapshot only
- License boundary: clean process/API separation
- Decision: **ADD for read-only pilot**

### B — Minimal public API upstream

Add a versioned API that wraps Operon's existing full mutation orchestrators.

- Safety: potentially high
- Domain fidelity: highest
- Maintenance: lowest if accepted upstream
- Headless: live Desktop only for mutations
- Decision: **PREFERRED future mutation path, not currently available**

### C — Minimal Operon fork

Fork only to expose the same public API if upstream does not accept it.

- Safety: potentially high
- Domain fidelity: high if wrappers remain thin
- Maintenance: recurring upstream merge tax
- License: GPL-3.0-or-later
- Decision: **DEFER; gate not yet passed**

### D — MCP parser and mutation engine

Reimplement Operon parsing, workflow logic, recurrence, hierarchy, dependencies, aggregates, and conversions in the MCP.

- Safety: low
- Domain fidelity: low over time
- Maintenance: unacceptable duplication
- Decision: **REJECT**

### E — Human-only Operon

Use Operon manually and keep agent operation on Tasks/TaskNotes.

- Safety: high
- Simplification: low; three task systems could coexist
- Decision: **fallback if read pilot fails**

## Decision

Implement Option A as a strict read-only integration:

```text
Operon official 2.4.x
    ↓ live runtime index
Optimike Operon Bridge (Obsidian companion plugin)
    ↓ Local REST API extension, contract v1
Optimike Obsidian MCP
    ↓ generation-validated SQLite snapshot
MCP agents
```

The following MCP tools are added:

- `operon_status`
- `operon_list_tasks`
- `operon_get_task`
- `operon_query_tasks`
- `operon_validate`

No Operon mutation tool is registered in this decision.

## Classification by component

- `KEEP` — `optimikelabs/optimike-obsidian-mcp` as the only MCP server.
- `KEEP` — current runtime modes, Local REST client, logger, errors, stdio proxy, HTTP backend, and shared SQLite.
- `KEEP` — Obsidian Tasks and its existing MCP tools during the pilot.
- `KEEP` — TaskNotes for bounded rich missions during the pilot.
- `KEEP` — Operon official plugin; no fork in this branch.
- `ADD` — `plugins/obsidian-operon-bridge` read-only REST adapter.
- `ADD` — five read/diagnostic Operon MCP tools.
- `ADD` — `operon_task_snapshot` and `operon_snapshot_meta` tables in the existing SQLite database.
- `CHANGE` — runtime tool registration delegates to Operon tool registration.
- `DELETE` — nothing in the pilot.
- `UNVERIFIED` — full Desktop parity, Sync conflict behavior, migration equivalence, rich TaskNotes replacement, and safe mutations.

## REST compatibility contract

The Bridge is tested against Operon `2.4.0` and accepts `>=2.4.0 <3.0.0`. This is a compatibility claim for the specific read surface only, not a guarantee about future Operon releases.

The Bridge probes:

- plugin presence and version;
- `indexer.getAllTasks()`;
- `indexer.getTask()`;
- optional generation and duplicate-registry methods;
- configured pipelines and key mappings.

An absent, incompatible, or incomplete runtime returns a structured unavailable status. It never falls back to parsing Markdown inside the Bridge.

## Snapshot model

The MCP stores a reconstructible snapshot in the existing shared SQLite database.

A refresh is accepted only when:

1. the Bridge status contract validates;
2. Operon reports a compatible and ready index;
3. no duplicate `operonId` conflict is reported;
4. pagination is stable and complete;
5. every task validates against contract v1;
6. live validation reports zero P0 violations.

The previous snapshot is preserved if any condition fails.

A reachable live Bridge with the same index generation and settings signature validates the existing snapshot without rewriting it. If the Bridge is unavailable, the last snapshot may be served with:

- `source: "operon-cache"`;
- `stale: true`;
- `snapshotAgeMs`;
- explicit limitations.

A stale snapshot is never evidence that a mutation succeeded.

## Query contract

Queries can filter by:

- `operonId`;
- description/full-text search;
- inline or file source;
- checkbox state;
- status and pipeline;
- priority and tier;
- include/exclude path;
- any/all tags;
- parent task;
- date comparisons;
- canonical or custom indexed fields;
- unmanaged file-task frontmatter properties;
- stable sort and cursor pagination.

Unmanaged properties are opt-in through `includeProperties=true`.

## Security

- The Bridge inherits Local REST API bearer authentication and local TLS behavior.
- It registers no write route.
- The MCP registers no Operon mutation tool.
- The Bridge exposes indexed task data and optional file-task frontmatter, never note bodies or raw task lines.
- Duplicate-ID conflicts block snapshot refresh.
- Headless behavior is read-only and explicitly stale.

## Licensing

- The MCP remains Apache-2.0.
- Operon remains GPL-3.0-or-later and is not copied or modified in this branch.
- The Bridge calls a runtime interface by name and communicates with the MCP through REST. No Operon source is copied into the MCP or Bridge.
- A future Operon fork must remain GPL-3.0-or-later and follow Operon trademark guidance.
- Commercial distribution should still receive legal review before treating this architectural separation as a final licensing opinion.

## ÉLYSIA pilot boundary

The pilot must preserve the existing canon:

- active execution: `Efforts/Projets/` and `Efforts/Créations/`;
- short captures: daily notes;
- no active task pollution in Atlas;
- ritual checklists remain distinct from executable tasks;
- one task owner at a time;
- no Tasks ↔ Operon mirror writes;
- no production migration without a separate explicit apply decision.

The four required views are:

- Now
- Inbox
- Étoile du Nord
- Audit

`north_star` should remain an orthogonal field rather than an execution status unless the pilot disproves that model.

## Mutation gate

Mutation work may start only when one of these is true:

1. Operon exposes a public versioned API wrapping the full domain path; or
2. a minimal GPL fork adds only that API and its contract tests.

Private method calls, direct `TaskWriter` calls, command-palette automation, and raw Markdown/YAML writes do not pass the gate.

## Read pilot gates

- 100% task identity parity on the bounded fixture.
- No silent duplicate.
- Inline and file tasks both represented.
- ÉLYSIA properties preserved when requested.
- Operon absence and version incompatibility fail cleanly.
- Cache fallback always declares staleness.
- The existing Tasks surface remains unchanged.
- Desktop validation recipe passes after restart and reindex.

## Stop rules

Stop and recommend `KEEP Tasks + TaskNotes` if:

- the Bridge needs to copy Operon parser or domain logic;
- routine Operon updates repeatedly break the read contract;
- live index and Markdown cannot be reconciled;
- the four ÉLYSIA cockpits cannot be reproduced;
- using Operon would retain rather than remove task-system layers;
- a task can disappear or duplicate silently.

## Rollback

1. Disable `optimike-operon-bridge` in the disposable vault.
2. Remove the five Operon tools by reverting this branch/PR.
3. Delete only the reconstructible SQLite tables if desired.
4. Keep Tasks and TaskNotes unchanged.
5. No production Markdown has been migrated or mutated by this branch.

## Consequence

This branch can support a real, low-risk read pilot and produce evidence for the migration decision. It deliberately does not claim `SWITCH Operon`.

Current decision: **PILOT Operon**.
