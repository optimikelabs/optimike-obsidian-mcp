# Optimike Operon Bridge — REST contract v1

## Scope

The Bridge projects the active Operon-compatible engine's live index through Obsidian Local REST API. Reads work with official Operon `2.4.0` and `2.5.0`, with official Operon `3.0.1`, `3.1.0`, `3.1.1`, `3.2.0`, and `3.2.1` through Developer API V1, with Kairélys `2.5.1` through `2.5.3` (based on Operon `2.5.0`), and with Kairélys `2.6.1` through `2.6.3` (based on Operon `2.6.0`). Compatibility is decided by plugin ID and version together. Operon 3.2.x mutations use the official Developer API V1 preview/apply/recovery surface; legacy Kairélys mutations use Public API v1. There is no raw Markdown or private-reflection fallback.

Prefix:

```text
/extensions/optimike-operon-bridge/v1
```

All routes inherit Local REST API authentication and TLS behavior.

## Compatibility and capabilities

- Bridge contract: `1`
- Latest contract compatibility target: official Operon `3.2.1`; complete live read/write pilot: `3.2.0`
- Official Operon legacy read allowlist: `2.4.0`, `2.5.0`
- Official Operon Developer API V1 allowlist: `3.0.1`, `3.1.0`, `3.1.1`, `3.2.0`, `3.2.1`
- Kairélys read allowlist: `2.5.1`, `2.5.2`, `2.5.3`, `2.6.1`, `2.6.2`, `2.6.3`
- Legacy mutation contract: Operon Public API `1`
- Official Operon `2.5.0`: read-only
- Official Operon `3.2.x`: typed create/update/transition/relationship/recurrence/convert/relocate through Developer API V1, plus saved-filter execution through the additive task-workflow API, when the exact grants are active. The grant state and capability advertisement are both reported in `/status`; an uncertain apply is returned as such and is never retried blindly.
- Kairélys `2.5.1` through `2.5.3` and `2.6.1` through `2.6.3` with Public API v1: read-write

`GET /status` reports `bridge.mode` as `read-only` or `read-write` and exposes each capability independently. A future Operon version is not assumed compatible merely because its Markdown looks similar.

The adapter targets the official `3.2.1` contract while the complete live acceptance evidence remains on the compatible local `3.2.0` build. The missing 3.2.1 settings renderer is tracked by [#145](https://github.com/hasanyilmaz/operon/issues/145) and [#146](https://github.com/hasanyilmaz/operon/pull/146). Modified-time settlement and multi-window consent fixes from #135 and #137 are already merged. File Task rename safety remains tracked by [#139](https://github.com/hasanyilmaz/operon/pull/139), and the transition investigation by [#99](https://github.com/hasanyilmaz/operon/issues/99) and [#101](https://github.com/hasanyilmaz/operon/pull/101). Those paths stay fail-closed. No Markdown or private-API fallback is introduced.

Readiness requires a compatible plugin, positive generation, healthy idle V8 index, zero dirty sources, and a task count matching diagnostics. A duplicate-ID conflict is reported separately and causes MCP snapshot refresh refusal.

## Stable task projection

Each task includes durable `operonId`, inline/file source, path and one-based line, description, checkbox, workflow, priority, tags, parent, dependency edges, normalized dates, managed fields, source mtime, and deterministic `revision`. Workflow projection includes both visible values (`pipeline`, `status`, `statusLabel`) and language-stable `pipelineId` / `statusId` values resolved from the live Operon settings.

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

All mutation routes require `idempotencyKey`. The key is bound to the canonical request: an identical replay returns the cached result, while reuse for different input returns HTTP 409 with `idempotency_key_reused` before later payload validation. Existing-task routes also require `expectedRevision`. `dryRun` defaults to `true`; apply occurs only with `dryRun: false`.

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
  "source": "operon-live",
  "stale": false
}
```

For Operon 3.2.0, the Bridge sends the exact preview plan to `apply`; it never reconstructs or retries a plan after the host reports `outcome-unknown`. The response carries `recoveryRef`, `planDigest`, and `mutationMayHaveApplied` when recovery is required. The Bridge waits for Operon's index to return to a verified idle state before proving `after`. If the final state cannot be proven, it records `failed/outcome_unverified` and does not invite a blind retry. A Bridge apply is bounded at 120 seconds; a timeout is uncertain, not a permission to retry.

### `GET /mutations/pending-recoveries`

Returns the durable recovery references currently owned by this Bridge consumer. It is read-only and requires the official Developer API recovery surface.

### `POST /mutations/recover`

```json
{
  "idempotencyKey": "recovery-001",
  "recoveryRef": "dvr1_..."
}
```

This calls Operon's official `mutations.recover({ recoveryRef })` for the same plan. It never accepts a new mutation spec and never uses Markdown or private APIs. Recovery keeps the same two opt-ins and is restricted to the full MCP write mode.

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
