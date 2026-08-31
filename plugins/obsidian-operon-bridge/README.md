# Optimike Kairélys / Operon Bridge

Obsidian companion plugin exposing Kairélys or Operon's live task engine through the extension API of Obsidian Local REST API.

Reads use the loaded engine's in-memory V8 index. Official Operon 3.x reads and typed mutations go through its host-verified Developer API V1; they do not inspect private index/settings fields. Mutations are advertised only when the loaded plugin exposes the supported preview/apply contract and the operator enables them in Bridge settings. No Markdown/private-method fallback exists.

The Bridge accepts exactly one loaded task engine:

- Kairélys (`kairelys`), the temporary Optimike fork;
- official Operon (`operon`), for upstream convergence and rollback.

If both plugins are enabled, the Bridge refuses to choose an owner. Disable one before reading or mutating tasks.

## Requirements

- Obsidian Desktop
- Operon `2.4.0` or `2.5.0` for legacy reads
- Operon exposing the negotiated Developer API V1 contract (`contractVersion: 1`, `runtimeApi: 1`)
- certified Developer API releases: `3.0.1`, `3.1.0`, `3.1.1`, `3.2.0`, and `3.2.1`; later non-denied releases such as the current live target Operon `3.6.0` are admitted provisionally through the same negotiated Developer API V1 contract
- Kairélys `2.5.1` through `2.5.3` (based on Operon `2.5.0`) and Kairélys `2.6.1` through `2.6.3`
  (based on Operon `2.6.0`) with Public API v1 for mutations
- Obsidian Local REST API

Operon `3.2.0` and `3.2.1` use the official Developer API V1 for live reads, previews,
applies, durable recovery, and the additive `tasks.filter-query` capability.
Saved-filter execution requires an exact grant and exact `filterSetId`; the
official API does not expose the saved-filter catalog. Adoption, unmanaged
properties, and arbitrary `targetFolder` destinations remain unsupported and
are rejected explicitly. The complete live pilot used the local 3.2.0 build.
Operon `3.3.2` with Operon CLI `1.1.2` is admitted as
`compatible-provisional` because the non-denied version exposes the Developer
API V1 accessor. Its complete live pilot passed the separate Developer API,
schema, index, capability, readiness, saved-filter, transition, restoration,
and recovery gates with Bridge `0.7.0`. Operon `3.3.2` restores the Settings
grant controls, rejects implicit File Task renames, and fixes the unscoped
Project Serial transition edge. Uncertain outcomes
remain fail-closed; the Bridge never retries blindly or falls back to
Markdown/private APIs.

Bridge `0.9.2` supports the separate task-workflow Developer API sessions
introduced by Operon `3.5.3` and retained by the current `3.6.0` target.
Adoption, daily/weekly periodic-note
creation, and periodic-note-aware updates each negotiate their own exact grant
on first use, even when the last status snapshot reported the capability cold;
a pending or malformed optional grant cannot revoke the established core read
or mutation sessions. Saved-filter execution follows the same operation-scoped
rule for `tasks.filter-query`: ordinary status/index refreshes request no
optional grant. Apply receives the exact opaque plan handle returned by
preview, and recovery accepts only the matching durable `recoveryRef` and
workflow kind. The Bridge converts its public one-based adoption line to the
official zero-based locator exactly once. `taskType` and `taskImage` remain
scalars, while `taskGallery` crosses the Bridge as an ordered `string[]`; the
Bridge never guesses media boundaries by splitting a string. Operon `3.5.3`
remains historical rollout evidence, while the current `3.6.0` target reports
`compatible-provisional` because certification metadata remains explicit; product-
version membership is not a second mutation gate. A
non-denied future release remains writable only after the exact negotiated
contract, capabilities, schemas, health, settled index and recovery checks pass.

Working-tree Pilot 2 runs exercised stock Operon `3.6.0`, Operon CLI `1.2.0`
and Bridge `0.8.3` without a public-contract migration: degraded startup and
same-client recovery, operation-scoped grants, adoption, periodic routing and
scheduling, replay, stale conflicts, concurrent apply, validation,
modified-time settlement, pending recovery and exact fixture restoration. The
periodic applies in those working-tree runs are historical/diagnostic evidence
only. The exact-SHA release canary performs periodic preview and exact-grant
negotiation but skips periodic applies with reason
`public_task_source_projection_unavailable`, because the public Task Workflow
plan is metadata-only and exposes no pre-apply task-source path. This is a
destructive-canary containment/certification boundary, not a runtime tool
disablement: the runtime tools remain available, upstream public path projection
is a nonblocking follow-up, and no full periodic certification is claimed. The
release still requires the applicable gate on the clean final SHA. Operon
therefore remains `compatible-provisional`, admitted by the same contract-first
checks rather than by a positive product-version allowlist.

Bridge `0.9.2` permanently supervises its Local REST extension registration
and is distributed through the exact-SHA Optimike Bridge bundle.
It mounts after late Local REST startup, detects a disabled/reloaded provider,
unregisters the previous generation and remounts without requiring an MCP
restart. The additive `lifecycle` status is route readiness only: Operon index,
grant and mutation gates remain independent and fail closed.

Compatibility is reported explicitly:

- `certified`: the product version belongs to the Bridge's explicit certified
  set and its Developer API boundary is admitted;
- `compatible-provisional`: the product version is outside that set but is not
  denied and its Developer API V1 boundary is admitted;
- `incompatible`: the contract boundary is absent, denied, or fails validation.

Compatibility is admission, not live readiness. Check top-level `ok`,
`index.ready`, and the advertised `capabilities` before using a route; an
admitted runtime can still be temporarily unready while its index settles or
recovers.

Status also reports `bridge.mutationJournal.state` as `absent`, `valid`, or
`unsafe`. An unsafe persisted journal never gets ignored or replaced during a
settings save: reads stay available, all mutation and recovery capabilities are
withdrawn, and mutation routes return `mutation_journal_unsafe` without a
reservation or native Operon call. Repair requires an explicit operator edit
and Bridge reload.

The product version remains diagnostic metadata and may select a narrowly
documented denylist entry. It is not the primary admission key for Operon 3.x.
An unavailable optional capability removes only the dependent route; it does
not tear down already verified core reads or mutations.

## Routes

Prefix: `/extensions/optimike-operon-bridge/v1`

- `GET /status`
- `GET /recovery-status`
- `GET /tasks`
- `GET /tasks/:operonId`
- `POST /tasks/query`
- `POST /tasks/filter`
- `GET /validate`
- `POST /tasks/adopt`
- `POST /tasks/periodic`
- `POST /tasks`
- `POST /tasks/:operonId/update`
- `POST /tasks/:operonId/periodic-update`
- `POST /tasks/:operonId/transition`
- `POST /tasks/:operonId/convert`
- `POST /tasks/:operonId/relocate`
- `POST /tasks/:operonId/relationships`
- `POST /tasks/:operonId/recurrence`
- `GET /mutations/pending-recoveries`
- `POST /mutations/recover`
- `GET /task-workflows/pending-recoveries`
- `POST /task-workflows/recover`

All routes inherit Local REST API authentication and local TLS settings. `/recovery-status` negotiates only exact recovery capabilities and never waits for health, catalog or task-index reads, so an uncertain operation remains recoverable while `/status` is degraded. Saved filters run through Operon's native filter evaluator with an exact caller-supplied `filterSetId`; the official task-workflow API does not list saved filters. A cold status capability is advisory: the first exact saved-filter call negotiates only `tasks.filter-query`. Mutations require idempotency; an idempotency key is bound to one canonical request and conflicting reuse is rejected before later payload validation. No periodic-create reservation is persisted until its exact grant negotiation succeeds, so approval can be followed by a safe same-key retry. Existing-task mutations require the live revision; in-place adoption instead requires an exact one-based line plus `expectedLine` on engines that advertise it. Periodic creation requires `periodicKind: daily | weekly` and may include an exact ISO `routeDate`; periodic updates keep the existing task identity and let Operon seal the retain/detach/realign routing decision. Dry-run is the default.

Ordinary `/status` calls, including degraded startup polls, request no additive
workflow, saved-filter, or recovery grant. `/recovery-status` is a separate
operator surface and may negotiate the recovery contracts it reports.

Mutation paths are strict, exact vault-relative paths. The MCP and Bridge reject leading or trailing whitespace, backslashes, absolute paths, empty segments, traversal, and non-Markdown `targetPath` values; they never trim or rewrite an invalid destination into a valid one.

Mutation apply is disabled by default. Operon 3.x mutation routes are advertised only when the Bridge setting is enabled, the official grant exposes the matching preview/apply capabilities, and the MCP runtime has the separate `OPERON_MUTATIONS_ENABLED` opt-in. Relationship apply rereads the source and inverse dependency edges; recurrence uses the official scoped recurrence plan and never passes through the generic update route.

## Build

```bash
npm ci
npm run check
```

CI publishes `optimike-operon-bridge` containing `main.js` and `manifest.json`. Install only in a disposable validation vault until the manual recipe in `docs/operon-local-validation.md` passes and production activation is explicitly approved.

The CLI/Developer API comparison and the intentionally limited MCP extension
plan live in `docs/operon-cli-audit.md`.
