# Operon tools in Optimike Obsidian MCP

## Surface

The main MCP server registers five Operon tools:

- `operon_status`
- `operon_list_tasks`
- `operon_get_task`
- `operon_query_tasks`
- `operon_validate`

There is no second MCP server and no mutation tool in contract v1.

## Source and freshness envelope

Every task response includes:

- `source: "operon-live" | "operon-cache"`
- `stale: boolean`
- `snapshotAt`
- `snapshotAgeMs`
- `operonVersion`
- `bridgeVersion`
- `contractVersion`
- capabilities
- limitations

Semantics:

### `operon-live`

Obsidian Desktop and Local REST API are reachable. The Bridge status is compatible. The MCP snapshot either:

- was rebuilt from a complete live pagination; or
- was validated against the same live index generation, settings signature, Operon version, Bridge version, and task count.

### `operon-cache`

The Bridge is unavailable or the runtime is headless. The response is the last successfully validated snapshot and is always marked stale.

A cached response is suitable for discovery and planning. It is not proof of current Desktop state and must never be used to assert a mutation succeeded.

## SQLite ownership

The existing shared SQLite database receives two reconstructible tables:

```sql
operon_task_snapshot
operon_snapshot_meta
```

A refresh is transactional. The previous snapshot survives malformed payloads, incomplete pagination, duplicate IDs, version incompatibility, or P0 validation failures.

The tables are cache state, not canonical task storage.

## `operon_status`

Input:

```json
{ "forceRefresh": false }
```

`forceRefresh=true` requests a complete live snapshot rebuild. It fails if the live Bridge is unavailable and no valid cache exists.

## `operon_list_tasks`

Uses the same filter/pagination schema as `operon_query_tasks`. Calling it with no filters lists tasks in stable path/line order.

## `operon_query_tasks`

Supported filters:

- IDs;
- search text;
- inline/file source;
- checkbox state;
- workflow status and pipeline;
- priority and hot/warm/cold tier;
- include/exclude paths;
- tags any/all;
- parent;
- ISO date conditions;
- canonical/custom `fields` equality;
- unmanaged file-task `properties` equality;
- sort rules;
- cursor/limit;
- `includeProperties`;
- `forceRefresh`.

Properties are stripped from returned tasks unless `includeProperties=true`.

## `operon_get_task`

Input:

```json
{
  "operonId": "abc1234",
  "includeProperties": false,
  "forceRefresh": false
}
```

Lookup is by durable `operonId`, never by title or line number.

## `operon_validate`

When live, delegates to Bridge validation. When only a snapshot is available, performs a limited graph validation and states that it cannot prove source-file existence or current duplicate-registry health.

## Mutation posture

The following tools are deliberately absent:

- `operon_create_task`
- `operon_update_task`
- `operon_transition_task`
- `operon_convert_task`

Reason: at the audited Operon SHA, no public versioned API guarantees the complete mutation path. Direct Markdown edits, direct `TaskWriter` calls, command invocations, or reflective calls to private methods are not accepted as a production contract.

The next mutation gate is documented in `docs/adr/ADR-Operon-Bridge.md`.
