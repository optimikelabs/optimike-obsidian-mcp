# Optimike Operon Bridge — REST contract v1

## Scope

The Bridge projects the active Operon-compatible engine's live index through Obsidian Local REST API. Reads work with official Operon `2.4.0` and `2.5.0`, with certified official Operon `3.0.1`, `3.1.0`, `3.1.1`, `3.2.0`, and `3.2.1`, and provisionally with non-denied `3.3.2` and `3.5.2` when the Developer API V1 accessor is present. Kairélys legacy support remains bounded to the documented allowlist. Developer API mutations use official opaque preview/apply/recovery plans; legacy Kairélys mutations use Public API v1. There is no raw Markdown or private-reflection fallback.

Prefix:

```text
/extensions/optimike-operon-bridge/v1
```

All routes inherit Local REST API authentication and TLS behavior.

## Compatibility and capabilities

- Bridge contract: `1`
- Certified compatibility through official Operon `3.2.1`; completed provisional live pilot: `3.3.2` with CLI `1.1.2`; current provisional candidate: `3.5.2` with CLI `1.2.0` and Bridge `0.8.0`. Its patched acceptance build passed the exact live canary on 2026-08-24; stock admission still awaits the upstream fixes and a stock rerun
- Official Operon legacy read allowlist: `2.4.0`, `2.5.0`
- Official Operon Developer API V1 allowlist: `3.0.1`, `3.1.0`, `3.1.1`, `3.2.0`, `3.2.1`
- Kairélys read allowlist: `2.5.1`, `2.5.2`, `2.5.3`, `2.6.1`, `2.6.2`, `2.6.3`
- Legacy mutation contract: Operon Public API `1`
- Official Operon `2.5.0`: read-only
- Official Operon `3.x` with the negotiated V1 boundary: typed create/update/transition/relationship/recurrence/convert/relocate through Developer API V1, plus saved-filter execution, adoption and Daily/Weekly workflows through the additive task-workflow API when their exact grants are active. The grant state and capability advertisement are both reported in `/status`; an uncertain apply is returned as such and is never retried blindly.
- Kairélys `2.5.1` through `2.5.3` and `2.6.1` through `2.6.3` with Public API v1: read-write

`GET /status` reports `bridge.mode` as `read-only` or `read-write` and exposes each capability independently. A future non-denied Operon version is admitted provisionally when its Developer API V1 accessor is present; Markdown similarity is irrelevant. Live use remains independently gated by successful negotiation, `developerApi`, top-level `ok`, `index.ready`, and the exact advertised capability.

The adapter certifies official `3.2.1` and provisionally admits later non-denied V1 releases. The complete `3.3.2` live acceptance remains historical green evidence with Bridge `0.7.0` and CLI `1.1.2`. The `3.5.2` / CLI `1.2.0` / Bridge `0.8.0` candidate adds official adoption, periodic-note routing and typed task media fields. Its patched acceptance build passed the live canary, but the stock release remains `compatible-provisional` until upstream fixes `#182`, `#183` and `#184` ship and the released artifact passes the same gate. Task Type and Task Image are scalar, Task Gallery is an ordered array and `__taskDataType` is read-only. No Markdown or private-API fallback is introduced.

Stock `3.5.2` remains readable after successful negotiation but reports no
mutation capabilities. The disposable Pilot 2 acceptance artifact is
distinguished by the synthetic manifest version `3.5.240438`; that exact local
identity alone is admitted for 3.5 mutations and is never an upstream release.

Readiness requires a compatible plugin, positive generation, healthy idle V8 index, zero dirty sources, and a task count matching diagnostics. A duplicate-ID conflict is reported separately and causes MCP snapshot refresh refusal.

## Stable task projection

Each task includes durable `operonId`, inline/file source, path and one-based line, description, checkbox, workflow, priority, tags, parent, dependency edges, normalized dates, managed fields, source mtime, and deterministic `revision`. Managed values preserve arrays: `taskGallery` remains ordered rather than being delimiter-encoded. Workflow projection includes both visible values (`pipeline`, `status`, `statusLabel`) and language-stable `pipelineId` / `statusId` values resolved from the live Operon settings.

For file tasks, `includeProperties=true` also returns unmanaged YAML properties such as `north_star` and `rang`. Raw note bodies and raw task lines are never exposed.

The `revision` covers the normalized projection and source mtime. Every existing-task mutation requires the exact live revision.

## Read routes

- `GET /status`
- `GET /configuration`
- `GET /diagnostics`
- `GET /tasks?cursor=0&limit=100&includeProperties=false`
- `GET /tasks/:operonId?includeProperties=false`
- `POST /tasks/query`
- `POST /tasks/finder`
- `POST /entities/resolve`
- `POST /relationships`
- `POST /context`
- `GET /timers`
- `POST /tasks/filter`
- `GET /validate?includeProperties=false`

Query supports task IDs, language-stable `statusIds` / `pipelineIds`, visible status/pipeline values, text, source, checkbox, priority, tier, paths, tags, parent, ISO dates, managed-field equality, unmanaged-property equality, sorting, cursor, and limit. Agents should prefer stable workflow IDs whenever the intent is semantic rather than presentational.

`GET /configuration` is the live source of task semantics. It exposes only an explicit safe subset of Operon settings: UI language; pipeline/status IDs, labels and semantic flags; priorities; canonical-to-visible key mappings; creation targets and available file-task templates; task automation rules; excluded folders; and Operon Docs location. Saved-filter definitions are included only when the loaded official API exposes them; Operon 3.2.0 does not. Its deterministic `settingsSignature` is also attached to task pages. A semantic setting change therefore invalidates an in-flight read instead of being silently interpreted with stale assumptions.

`POST /tasks/filter` accepts an exact saved `filterSetId` supplied by the caller plus optional scope and opaque pagination. It evaluates through Operon's native task-workflow filter engine after the exact `tasks.filter-query` grant and is never synthesized from the stale MCP snapshot. Operon 3.2.0 does not expose the filter catalog through the official API, so the ID must come from its UI/configuration or an operator workflow.

The six native Developer API read routes return the official result inside a
versioned `{ operation, result }` Bridge envelope. Finder is capped at 50 rows;
relationship and context results at 100 entities/edges with depth at most 3.
Context hydration allows only notes, links, and custom fields. These routes are
unavailable on legacy Operon/Kairélys engines and never fall back to the CLI,
Markdown parsing, or private APIs.

Live validation reports duplicate IDs, missing sources, unknown workflow statuses, missing parents, and missing blockers. P0 prevents a new MCP snapshot from replacing the last known-good one.

## Mutation controls

All mutation routes require `idempotencyKey`. The Bridge reserves the key atomically before native dispatch and binds it to the canonical request: an identical replay returns the recorded result, while reuse for different input returns HTTP 409 with `idempotency_key_reused` before later payload validation. Concurrent identical callers join the same in-flight result instead of dispatching twice. Existing-task routes also require `expectedRevision`. `dryRun` defaults to `true`; apply occurs only with `dryRun: false`.

Every mutation destination is validated without normalization at both the MCP and Bridge boundaries. `targetPath` must be an exact vault-relative Markdown path; `targetFolder` must be an exact vault-relative folder path. Leading or trailing whitespace, backslashes, absolute paths, empty segments, trailing separators, `.` and `..` are rejected before any call to the task engine.

Mutation capabilities remain false until **Allow task mutations** is explicitly enabled in Bridge settings. The MCP has a separate `OPERON_MUTATIONS_ENABLED` apply opt-in. On official Operon 3.2.0, the Bridge requests the typed mutation grant only while that setting is enabled; a pending or revoked grant remains a live `503`/read-only condition. The additive filter grant is requested separately so a pending filter authorization cannot hide already-approved core reads or mutations.

Responses use:

```json
{
  "ok": true,
  "contractVersion": "1",
  "operationId": "uuid",
  "idempotencyKey": "client-key",
  "status": "planned | applied | already-applied | outcome-unknown | conflict | not-ready | not-found | invalid-input | rejected | failed",
  "before": {},
  "requested": {},
  "after": {},
  "retryable": false,
  "recoveryRequired": false,
  "planDigest": "optional sealed-plan digest",
  "recoveryRef": "optional same-plan recovery reference",
  "nativeProof": {},
  "source": "operon-live",
  "stale": false
}
```

For official Operon, the Bridge sends the exact preview plan to `apply`; it never reconstructs or retries a plan after the host reports `outcome-unknown`. Task Workflow results are validated as a strict V1 discriminated result: terminal status, side-effect flags, group results, sealed receipt digest and postflight status must agree. Any malformed or contradictory result becomes non-retryable `outcome-unknown`. `nativeProof` is a bounded proof projection of the validated native result, not the unrestricted Operon payload. The response carries `recoveryRef`, `planDigest`, `recoveryRequired` and `mutationMayHaveApplied` when recovery is required. The Bridge waits for Operon's index to return to a verified idle state before proving `after`. If the final state cannot be proven, it records `failed/outcome_unverified` and does not invite a blind retry. A Bridge apply is bounded at 120 seconds; a timeout is uncertain, not a permission to retry.

### Local Bridge idempotency journal

Bridge 0.8 persists its version-1 journal in local Obsidian plugin data before dispatch. It retains at most 500 entries and only entries updated during the last 30 days. On restart, a persisted `in-progress` reservation is projected to non-retryable `outcome-unknown` with `recoveryRequired: true`; callers must inspect pending recoveries and recover the same native plan. This is a bounded local replay/restart guarantee, not permanent storage: there is no promise after expiry, eviction, plugin-data loss/reset, failed persistence, or movement to another vault/device. If the reservation cannot be persisted before dispatch, no native mutation is sent.

### `GET /mutations/pending-recoveries`

Returns the durable recovery references currently owned by this Bridge consumer. It is read-only and requires the official Developer API recovery surface.

When `OPERON_MUTATION_ALLOWED_PATH_PREFIXES` is non-empty, this listing fails
closed. Recovery records do not expose a canonical route that the MCP can prove
against the path allowlist, so it must not return an unscoped inventory.

### `POST /mutations/recover`

```json
{
  "idempotencyKey": "recovery-001",
  "recoveryRef": "dvr1_...",
  "recovery": {
    "kind": "developer-api"
  }
}
```

For a Task Workflow recovery, the public request instead uses the nested union:

```json
{
  "idempotencyKey": "recovery-002",
  "recoveryRef": "twr1_...",
  "recovery": {
    "kind": "adopt",
    "planDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

`recovery.kind` is mandatory and prevents the Bridge from guessing which native
recovery surface owns the reference. `developer-api` uses Developer API V1
recovery and its object must contain only `kind`. The three Task Workflow kinds
(`adopt`, `periodic-create`, and `periodic-update`) accept optional `planDigest`.
It must be an exact lowercase SHA-256 digest and binds the request to the sealed
receipt/replay. Without it, the Bridge dispatches only if
the same digest can be proven from `pendingRecoveries`; it does not guess or
derive a digest from `recoveryRef`. Top-level `kind` and `planDigest` fields are
not part of the public wire contract; that flat representation exists only as
an internal candidate/legacy migration shape. When
`OPERON_MUTATION_ALLOWED_PATH_PREFIXES` is non-empty, apply also fails closed
before native dispatch because the recovery reference has no canonical route
that can be proved inside the allowlist. Recovery never accepts a new mutation
spec, never uses Markdown or private APIs, keeps the same two opt-ins, and is
restricted to the full MCP write mode.

### `POST /tasks/adopt`

```json
{
  "idempotencyKey": "adopt-001",
  "dryRun": false,
  "adoption": {
    "targetPath": "Efforts/Projets/Projet.md",
    "line": 42,
    "expectedLine": "- [ ] Publier la version validée 📅 2026-07-31",
    "statusId": "st_project_planned"
  }
}
```

Adoption upgrades one existing checkbox in place through Operon. `line` is one-based and `expectedLine` is an exact optimistic-lock precondition. A moved or edited line returns HTTP 409 without writing. Operon converts supported Tasks metadata, creates the durable identity, applies the optional stable status ID, reindexes the source, and the Bridge proves the resulting task at the same path and line.

### `POST /tasks`

```json
{
  "idempotencyKey": "create-001",
  "dryRun": false,
  "task": {
    "source": "file",
    "description": "Ship bridge",
    "statusId": "st_project_planned",
    "tags": ["elysia"],
    "fields": { "priority": "A" },
    "properties": { "north_star": true }
  }
}
```

Creation uses Operon's Task Creator paths, template resolution, identity generation, indexing, dependency reconciliation, aggregates, and workflow transition logic. Official Operon 3.2.0 maps the MCP payload to its typed create plan; unmanaged properties and arbitrary `targetFolder` placement are rejected because they are not part of the official Developer API contract.

`statusId` is preferred over `fields.status`: it remains stable when a vault translates the displayed pipeline and status labels. Supplying both is rejected. `targetDateKey` is projected to the official `dateDue` field; destination selection remains governed by the configured Operon target policy. An explicit inline `targetPath` remains available for vault-specific layouts.

### `POST /tasks/periodic`

Creates exactly one task through Operon's Daily/Weekly Note workflow. `priorityId` is checked against the stable priority projected by the postflight task, not only the display label. If native apply succeeds but periodic creation cannot identify one unique created task, the Bridge preserves `outcome-unknown`; it does not turn an ambiguous creation into success or retry it.

### `POST /tasks/:operonId/periodic-update`

Sets or clears the exact task's scheduled date through Operon's periodic-update workflow. Operon owns retain/detach/realign semantics. The Bridge verifies the final scheduling projection and never treats the route as an implicit Markdown move.

### `POST /tasks/:operonId/update`

```json
{
  "idempotencyKey": "update-001",
  "expectedRevision": "fnv1a32:...",
  "dryRun": false,
  "patch": {
    "fields": { "priority": "B" },
    "tags": ["elysia", "mcp"]
  }
}
```

One request must contain exactly one mutation group:

- description only;
- managed fields and/or tags;
- exactly one unmanaged file property on the legacy Public API path.

This rule prevents false atomicity across Obsidian rename, managed-field, and raw-property write paths.

Status is not accepted by `update`; use the transition route.
Relationship and recurrence fields are also rejected here; use their dedicated routes.

### `POST /tasks/:operonId/transition`

```json
{
  "idempotencyKey": "transition-001",
  "expectedRevision": "fnv1a32:...",
  "dryRun": false,
  "statusId": "st_project_finished"
}
```

Exactly one of stable `statusId` or the current configured `Pipeline.Status` string is required. Checkbox, terminal dates, dependencies, recurrence, aggregates, project serials, archiving, auto-unpin, and view refreshes remain Operon's responsibility.

The route remains documented for the legacy Kairélys/Public API path and is also available for official Operon `3.2.0` when the live Developer API advertises it. A stock runtime that cannot produce a terminal or recoverable result is reported as unavailable/uncertain; the Bridge never retries blindly or falls back to Markdown/private APIs.

### `POST /tasks/:operonId/relationships`

```json
{
  "idempotencyKey": "relationships-001",
  "expectedRevision": "fnv1a32:...",
  "dryRun": false,
  "relationships": {
    "parentTask": null,
    "blocking": ["bcd2345"],
    "blockedBy": []
  }
}
```

Every supplied field is a complete replacement; `null`/an empty array clears it. Duplicates, self-reference, contradictory dependency directions and graph cycles are rejected. The sealed plan includes all affected task resources; postflight verifies the source plus inverse `blocking`/`blockedBy` edges.

### `POST /tasks/:operonId/recurrence`

```json
{
  "idempotencyKey": "recurrence-001",
  "expectedRevision": "fnv1a32:...",
  "dryRun": false,
  "scope": "this-and-following",
  "changes": {
    "repeat": "every week",
    "datetimeRepeatEnd": null
  }
}
```

Scope is mandatory and must be `this-task` or `this-and-following`. Supported fields are `repeat`, `datetimeRepeatEnd`, `dateScheduled`, `dateStarted`, `dateDue`, `datetimeStart`, `datetimeEnd`, and `estimate`; `null` is an explicit clear. Apply requires `MCP_WRITE_MODE=full`.

### `POST /tasks/:operonId/convert`

```json
{
  "idempotencyKey": "convert-001",
  "expectedRevision": "fnv1a32:...",
  "dryRun": false,
  "target": "inline",
  "targetPath": "Pilot.md"
}
```

Inline-to-file accepts an optional `fileTemplateId`. File-to-inline requires an explicit different Markdown `targetPath`. Conversion uses Operon's transition-safe paths; no copy/delete logic lives in the MCP. Official Operon 3.2.0 accepts configured/default template targets for inline-to-file and a configured-target/exact path for file-to-inline; arbitrary `targetFolder` is legacy-only.

### `POST /tasks/:operonId/relocate`

```json
{
  "idempotencyKey": "relocate-001",
  "expectedRevision": "fnv1a32:...",
  "dryRun": false,
  "targetPath": "Efforts/Projets/Projet B.md"
}
```

Relocation is limited to inline tasks. The Bridge asks official Operon 3.2.0 for a live blank placement candidate, then sends the exact destination in the preview plan. Operon writes the target and removes the source through its domain operation, preserving `operonId`; the Bridge then proves the final indexed source/path before returning `applied`.

## Errors

Validation errors use HTTP 400, revision conflicts 409, domain rejection 422, and unavailable live mutation surfaces 503. No error path silently reads or writes Markdown as a fallback.
