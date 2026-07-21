# Optimike Operon Bridge — REST contract v1

## Scope

The Bridge projects the active Operon-compatible engine's live index through Obsidian Local REST API. Reads work with official Operon `2.4.0` and `2.5.0`, and with Kairélys `2.5.1` or `2.5.2` (based on Operon `2.5.0`). Mutations are exposed only when the loaded instance implements `OperonPublicApiV1`; there is no raw Markdown or private-reflection fallback.

Prefix:

```text
/extensions/optimike-operon-bridge/v1
```

All routes inherit Local REST API authentication and TLS behavior.

## Compatibility and capabilities

- Bridge contract: `1`
- Latest tested compatible engine version: Kairélys `2.5.2`
- Read allowlist: `2.4.0`, `2.5.0`, `2.5.1`, `2.5.2`
- Mutation contract: Operon Public API `1`
- Official Operon `2.5.0`: read-only
- Kairélys `2.5.1` or `2.5.2` with Public API v1: read-write

`GET /status` reports `bridge.mode` as `read-only` or `read-write` and exposes each capability independently. A future Operon version is not assumed compatible merely because its Markdown looks similar.

Readiness requires a compatible plugin, positive generation, healthy idle V8 index, zero dirty sources, and a task count matching diagnostics. A duplicate-ID conflict is reported separately and causes MCP snapshot refresh refusal.

## Stable task projection

Each task includes durable `operonId`, inline/file source, path and one-based line, description, checkbox, workflow, priority, tags, parent, dependency edges, normalized dates, managed fields, source mtime, and deterministic `revision`. Workflow projection includes both visible values (`pipeline`, `status`, `statusLabel`) and language-stable `pipelineId` / `statusId` values resolved from the live Operon settings.

For file tasks, `includeProperties=true` also returns unmanaged YAML properties such as `north_star` and `rang`. Raw note bodies and raw task lines are never exposed.

The `revision` covers the normalized projection and source mtime. Every existing-task mutation requires the exact live revision.

## Read routes

- `GET /status`
- `GET /configuration`
- `GET /tasks?cursor=0&limit=100&includeProperties=false`
- `GET /tasks/:operonId?includeProperties=false`
- `POST /tasks/query`
- `POST /tasks/filter`
- `GET /validate?includeProperties=false`

Query supports task IDs, language-stable `statusIds` / `pipelineIds`, visible status/pipeline values, text, source, checkbox, priority, tier, paths, tags, parent, ISO dates, managed-field equality, unmanaged-property equality, sorting, cursor, and limit. Agents should prefer stable workflow IDs whenever the intent is semantic rather than presentational.

`GET /configuration` is the live source of task semantics. It exposes only an explicit safe subset of Operon settings: UI language; pipeline/status IDs, labels and semantic flags; priorities; canonical-to-visible key mappings; creation targets and available file-task templates; task automation rules; excluded folders; Operon Docs location; and saved filter definitions. Its deterministic `settingsSignature` is also attached to task pages. A semantic setting change therefore invalidates an in-flight read instead of being silently interpreted with stale assumptions.

`POST /tasks/filter` accepts a saved `filterSetId` plus optional scope and pagination. It evaluates through Operon's native filter engine and is never synthesized from the stale MCP snapshot.

Live validation reports duplicate IDs, missing sources, unknown workflow statuses, missing parents, and missing blockers. P0 prevents a new MCP snapshot from replacing the last known-good one.

## Mutation controls

All mutation routes require `idempotencyKey`. The key is bound to the canonical request: an identical replay returns the cached result, while reuse for different input returns HTTP 409 with `idempotency_key_reused`. Existing-task routes also require `expectedRevision`. `dryRun` defaults to `true`; apply occurs only with `dryRun: false`.

Mutation capabilities remain false until **Allow task mutations** is explicitly enabled in Bridge settings. The MCP has a separate `OPERON_MUTATIONS_ENABLED` apply opt-in.

Responses use:

```json
{
  "ok": true,
  "contractVersion": "1",
  "operationId": "uuid",
  "idempotencyKey": "client-key",
  "status": "planned | applied | conflict | rejected | failed",
  "before": {},
  "requested": {},
  "after": {},
  "retryable": false,
  "source": "operon-live",
  "stale": false
}
```

The Bridge waits for Operon's index to return to a verified idle state before proving `after`. If the final state cannot be proven, it records `failed/outcome_unverified` and does not invite a blind retry.

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

Creation uses Operon's Task Creator paths, template resolution, identity generation, indexing, dependency reconciliation, aggregates, and workflow transition logic.

`statusId` is preferred over `fields.status`: it remains stable when a vault translates the displayed pipeline and status labels. Supplying both is rejected. An explicit `targetDateKey` forces the configured Obsidian daily-note path rather than opening Operon's interactive target picker; an explicit `targetPath` remains available for vault-specific periodic-note layouts.

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
- exactly one unmanaged file property.

This rule prevents false atomicity across Obsidian rename, managed-field, and raw-property write paths.

Status is not accepted by `update`; use the transition route.

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

Inline-to-file accepts an optional `fileTemplateId`. File-to-inline requires an explicit different Markdown `targetPath`. Conversion uses Operon's transition-safe paths; no copy/delete logic lives in the MCP.

### `POST /tasks/:operonId/relocate`

```json
{
  "idempotencyKey": "relocate-001",
  "expectedRevision": "fnv1a32:...",
  "dryRun": false,
  "targetPath": "Efforts/Projets/Projet B.md"
}
```

Relocation is limited to inline tasks. Operon writes the target and removes the source through a compensated domain operation, preserving `operonId`; the Bridge then proves the final indexed source/path before returning `applied`.

## Errors

Validation errors use HTTP 400, revision conflicts 409, domain rejection 422, and unavailable live mutation surfaces 503. No error path silently reads or writes Markdown as a fallback.
