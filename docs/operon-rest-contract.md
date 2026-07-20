# Optimike Operon Bridge — REST contract v1

## Scope

The Bridge exposes a read-only projection of the **live Operon index** through Obsidian Local REST API. It does not parse the vault independently and it does not mutate tasks.

Prefix:

```text
/extensions/optimike-operon-bridge/v1
```

All routes inherit Local REST API authentication and TLS behavior.

## Compatibility

- Bridge contract: `1`
- Latest tested Operon version: `2.5.0`
- Accepted read allowlist: `2.4.0`, `2.5.0`
- Mutation capabilities: always `false` in v1

A future Operon version is not assumed compatible merely because its Markdown looks similar.

## `GET /status`

Returns:

```json
{
  "ok": true,
  "contractVersion": "1",
  "bridge": {
    "id": "optimike-operon-bridge",
    "version": "0.1.0",
    "mode": "read-only"
  },
  "operon": {
    "present": true,
    "version": "2.5.0",
    "compatible": true,
    "testedAgainst": "2.5.0",
    "supportedRange": "2.4.0, 2.5.0"
  },
  "index": {
    "ready": true,
    "generation": 42,
    "taskCount": 120,
    "duplicateConflictCount": 0,
    "diagnostics": {
      "health": "healthy",
      "runtimePhase": "idle",
      "verifiedThisSession": true,
      "dirtySourceCount": 0
    }
  },
  "settingsSignature": "fnv1a32:...",
  "capabilities": {
    "status": true,
    "list": true,
    "get": true,
    "query": true,
    "validate": true,
    "create": false,
    "update": false,
    "transition": false,
    "convert": false
  },
  "source": "operon-runtime",
  "stale": false,
  "limitations": []
}
```

`ok=false` is returned when Operon is absent, its runtime index is unavailable,
its diagnostics do not prove a healthy and idle index verified during the
current session, or its version is outside the tested allowlist. Generation
zero is never considered ready.

## Task object

```json
{
  "operonId": "abc1234",
  "source": "inline",
  "path": "Efforts/Projets/Bridge.md",
  "line": 7,
  "sourceMtime": 1784545200000,
  "description": "Ship bridge",
  "checkbox": "open",
  "status": "Project.InProgress",
  "statusLabel": "InProgress",
  "pipeline": "Project",
  "priority": "A",
  "tier": "hot",
  "tags": ["bridge", "elysia"],
  "parentTask": null,
  "blocking": [],
  "blockedBy": [],
  "dates": {
    "due": "2026-07-31",
    "scheduled": null,
    "started": null,
    "completed": null,
    "cancelled": null,
    "datetimeStart": null,
    "datetimeEnd": null,
    "created": "2026-07-20T10:00:00",
    "modified": "2026-07-20T11:00:00"
  },
  "fields": {
    "status": "Project.InProgress",
    "priority": "A"
  },
  "properties": {
    "rang": 4,
    "north_star": true
  },
  "revision": "fnv1a32:...",
  "sourceKind": "operon-index",
  "operonVersion": "2.5.0",
  "bridgeVersion": "0.1.0"
}
```

Rules:

- `line` is one-based for inline tasks and `null` for file tasks.
- `fields` includes indexed canonical and custom fields.
- `properties` contains unmanaged YAML frontmatter only, is file-task-only, and is omitted unless requested.
- `revision` is a deterministic read revision over the normalized task projection and source mtime. It is not yet accepted by a mutation endpoint.
- Raw note bodies and raw task lines are not exposed.

## `GET /tasks`

Parameters:

- `cursor` — numeric offset string, default `0`
- `limit` — `1..500`, default `100`
- `includeProperties` — boolean, default `false`

Response contains `total`, `count`, `cursor`, optional `nextCursor`, `hasMore`,
`generation`, `settingsSignature`, and `tasks`. Every page is tied to the same
live generation and settings signature; the MCP rejects the refresh if either
changes before pagination and validation settle.

## `GET /tasks/:operonId`

Returns one task or a structured `not_found` error.

Optional query parameter:

- `includeProperties`

## `POST /tasks/query`

Body fields:

```json
{
  "operonIds": ["abc1234"],
  "search": "bridge",
  "sources": ["inline", "file"],
  "checkboxes": ["open", "done", "cancelled"],
  "statuses": ["Project.InProgress"],
  "pipelines": ["Project"],
  "priorities": ["A"],
  "tiers": ["hot"],
  "pathIncludes": ["Efforts/Projets/"],
  "pathExcludes": ["Archive/"],
  "tagsAny": ["bridge"],
  "tagsAll": ["elysia"],
  "parentTask": null,
  "dates": [
    { "field": "due", "before": "2026-08-01" }
  ],
  "fieldEquals": {
    "custom": "signal"
  },
  "propertyEquals": {
    "north_star": true
  },
  "sort": [
    { "field": "due", "direction": "asc" },
    { "field": "priority", "direction": "asc" }
  ],
  "includeProperties": true,
  "cursor": "0",
  "limit": 100
}
```

Multiple filters are combined with AND. Values inside `tagsAny` use OR; values inside `tagsAll` use AND.

Date fields:

- `due`
- `scheduled`
- `started`
- `completed`
- `cancelled`
- `datetimeStart`
- `datetimeEnd`
- `created`
- `modified`

Date operators are lexical comparisons over normalized ISO values: `before`, `after`, `on`.

## `GET /validate`

Live validation reports:

- duplicate `operonId` conflicts from Operon's registry;
- missing source files;
- unknown configured workflow statuses;
- missing parents;
- missing blocker references.

The validation response carries the same `generation` and `settingsSignature`
coherence markers as task pages.

Severity:

- P0 — snapshot refresh must be refused;
- P1 — pilot-blocking semantic inconsistency;
- P2 — warning to triage.

## Errors

Errors use:

```json
{
  "ok": false,
  "contractVersion": "1",
  "error": {
    "code": "operon_unavailable",
    "message": "..."
  },
  "limitations": []
}
```

No error path silently reads or writes Markdown as a fallback.
