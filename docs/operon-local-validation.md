# Operon Bridge — local validation recipe

This recipe is the remaining Desktop proof. Run it only in a disposable validation vault or a copied Sync vault, never directly in the production ÉLYSIA vault.

## Preconditions

- Node.js `>=22.7.5`
- Obsidian Desktop
- Local REST API enabled
- Operon `2.4.0` enabled
- Optimike Operon Bridge built from this branch
- Optimike Obsidian MCP built from this branch
- a backup or disposable vault

## 1. Automated checks

From the MCP repository:

```bash
npm ci
npm run test:runtime
npm run check:operon
npm pack --dry-run
```

Expected: every command exits `0`.

## 2. Install the Bridge

```bash
npm --prefix plugins/obsidian-operon-bridge run build
```

Copy:

```text
plugins/obsidian-operon-bridge/build/main.js
plugins/obsidian-operon-bridge/build/manifest.json
```

into:

```text
<test-vault>/.obsidian/plugins/optimike-operon-bridge/
```

Enable the plugin, then restart Obsidian.

Evidence to capture:

- Operon version;
- Bridge version;
- Local REST API version;
- console line confirming route mounting.

PASS: no startup exception and the Bridge is listed as enabled.

## 3. Status route

```bash
curl -H "Authorization: Bearer $OBSIDIAN_API_KEY" \
  "$OBSIDIAN_BASE_URL/extensions/optimike-operon-bridge/v1/status"
```

PASS when:

- `ok=true`;
- Operon is present and compatible;
- index generation is greater than zero;
- diagnostics report `health=healthy`, `runtimePhase=idle`,
  `verifiedThisSession=true`, and `dirtySourceCount=0`;
- mutation capabilities are all false;
- duplicate conflict count is zero.

FAIL if the route claims compatibility while Operon is absent or incompatible.

## 4. Fixture set

Create fixtures through Operon's UI, not by this recipe's automation:

1. one inline task with priority, due date, tags, and custom field;
2. one file task with unmanaged ÉLYSIA properties such as `rang` and `north_star`;
3. one parent and one child;
4. one dependency pair;
5. one finished task;
6. one cancelled task.

Do not create duplicate IDs in the normal fixture.

Record the expected `operonId` values and UI fields.

## 5. REST parity

```bash
curl -H "Authorization: Bearer $OBSIDIAN_API_KEY" \
  "$OBSIDIAN_BASE_URL/extensions/optimike-operon-bridge/v1/tasks?limit=500&includeProperties=true"
```

For every fixture compare:

- `operonId`;
- source format;
- path/line;
- description;
- checkbox;
- status/pipeline;
- priority;
- tags;
- dates;
- parent/dependencies;
- custom fields;
- unmanaged file-task properties.

PASS: 100% field parity for the fixture set.

## 6. Query behavior

```bash
curl -X POST \
  -H "Authorization: Bearer $OBSIDIAN_API_KEY" \
  -H "Content-Type: application/json" \
  "$OBSIDIAN_BASE_URL/extensions/optimike-operon-bridge/v1/tasks/query" \
  -d '{
    "pathIncludes":["Efforts/Projets/"],
    "checkboxes":["open"],
    "propertyEquals":{"north_star":true},
    "includeProperties":true,
    "limit":100
  }'
```

PASS: only expected tasks are returned; every page reports the same generation
and settings signature; changing a task during a forced multi-page refresh
causes that refresh to be rejected rather than storing a mixed snapshot.

## 7. Live validation

```bash
curl -H "Authorization: Bearer $OBSIDIAN_API_KEY" \
  "$OBSIDIAN_BASE_URL/extensions/optimike-operon-bridge/v1/validate"
```

PASS: P0 is zero. Investigate every P1 before the pilot.

## 8. MCP surface

Run the MCP in `live` or `hybrid` with API credentials and inspect:

```text
operon_status
operon_list_tasks
operon_get_task
operon_query_tasks
operon_validate
```

PASS when:

- all five tools are registered;
- the first complete call creates a snapshot;
- subsequent calls with unchanged generation do not rewrite the full snapshot;
- responses say `source=operon-live`, `stale=false`.

## 9. Restart and reindex

1. Record the status generation and task revisions.
2. Restart Obsidian.
3. Run Operon's reindex/diagnostic validation.
4. Repeat REST and MCP parity.

PASS: same task identities and values; revisions change only when normalized task/source data changes.

## 10. Stale fallback

1. Complete one successful live snapshot.
2. Stop Obsidian or disable Local REST API.
3. Run `operon_list_tasks` again.

PASS when:

- tasks remain readable;
- `source=operon-cache`;
- `stale=true`;
- `snapshotAgeMs` is present;
- limitations explicitly deny current mutation proof.

FAIL if cached data is presented as live.

## 11. Incompatibility test

Disable Operon or use any test manifest version other than `2.4.0`.

PASS:

- Bridge status becomes unavailable/incompatible;
- no exception crashes Obsidian;
- the MCP either serves a stale prior snapshot or returns a structured unavailable error.

## 12. Duplicate-ID safety

In the disposable vault only, duplicate one Operon task including its `operonId`.

PASS:

- Bridge status reports a duplicate conflict;
- `/validate` reports P0;
- MCP refuses to replace the last valid snapshot;
- no task is silently selected as authoritative for a new snapshot.

Remove the duplicate and revalidate.

## 13. Sync observation

On two test devices or two copied vault replicas:

1. edit one task on device A;
2. allow Sync to settle;
3. open device B and reindex;
4. compare identity, source path, status, dates, and revision.

PASS: one task identity, no duplicate conflict, matching normalized data.

This remains `UNVERIFIED` until executed on the actual Sync topology.

## 14. No-write assertion

Review Local REST routes and MCP tools.

PASS:

- no Bridge POST/PATCH/PUT/DELETE mutation route exists;
- no `operon_create/update/transition/convert` MCP tool exists;
- fixture Markdown is unchanged by read/query/validate calls.

## Evidence record

For each step record:

- date/time;
- Operon SHA/version;
- Bridge SHA/version;
- MCP SHA/version;
- action;
- expected result;
- actual result;
- PASS / FAIL / NOT RUN;
- screenshot or JSON excerpt path.
