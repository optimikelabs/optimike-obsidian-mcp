# Operon Bridge — local validation recipe

This recipe is the Desktop proof. Run destructive fixtures only in a disposable or copied vault. In production ÉLYSIA, use the backed-up, reversible smoke scope defined by the migration plan and never touch unrelated tasks.

## Preconditions

- Node.js `>=22.7.5`
- Obsidian Desktop
- Local REST API enabled
- Operon `3.1.1` enabled for the official Developer API V1 pilot; `2.4.0` / `2.5.0` remain legacy-read fixtures
- Optimike Operon Bridge built from this branch
- Optimike Obsidian MCP built from this branch
- a backup or disposable vault

The adapter targets official Operon `3.1.1`. The complete acceptance evidence
listed below uses the patched local Operon build while upstream fixes are under
review in [#135](https://github.com/hasanyilmaz/operon/pull/135),
[#137](https://github.com/hasanyilmaz/operon/pull/137), and
[#139](https://github.com/hasanyilmaz/operon/pull/139). Stock `3.1.1` remains
usable for reads and most governed mutations, but unsupported or uncertain
settlement is fail-closed; this recipe never authorizes a Markdown/private-API
fallback or a blind retry.

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
- official Operon `3.1.1` reports the exact grant and typed Developer API
  surface; the Bridge advertises only the mutation capabilities that the live
  runtime proves, and bounds uncertain applies without a blind retry;
- `adopt` remains false on official Operon; legacy Kairélys/Public API probes
  are tested separately;
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
operon_get_configuration
operon_list_tasks
operon_get_task
operon_query_tasks
operon_query_saved_filter
operon_validate
operon_adopt_task
operon_create_task
operon_update_task
operon_transition_task
operon_convert_task
operon_relocate_task
operon_list_pending_recoveries
operon_recover_mutation
```

PASS when:

- all twenty-one tools are registered;
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

Disable Operon or use any test manifest version outside the explicit allowlist
(`2.4.0`, `2.5.0`, and official `3.1.1`).

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

## 14. Mutation boundary

Review Local REST routes, MCP tools, and the loaded Operon capability probe.

PASS:

- official Operon without an active Developer API V1 grant remains read-only;
- official Operon 3.1.1 exposes typed create/update/transition/convert/relocate
  only after the grant; an uncertain transition apply is bounded by the Bridge,
  while `adopt`, unmanaged properties, and arbitrary
  `targetFolder` remain explicitly unsupported;
- the minimal Operon fork exposes native saved-filter queries plus adopt/create/update/transition/convert/relocate through its versioned Public API;
- dry-run is the default;
- apply requires live capabilities and an idempotency key;
- existing Operon-task apply requires the live expected revision;
- legacy checkbox adoption requires an exact path, one-based line, and source-line precondition;
- the MCP write policy blocks conversion outside `full` mode;
- no raw Markdown, direct writer, UI command, or private-reflection fallback exists.

## 15. Rich mutation recipe

Run `scripts/smoke-operon-mutations.mjs` in guarded mode, then
`scripts/smoke-operon-rich-mutations.mjs` in full mode against a disposable
vault when validating the legacy Kairélys/Public API path. For official
Operon 3.1.1 use section 16; do not expect unmanaged properties or arbitrary
`targetFolder` values to map to Developer API V1.

PASS:

- file and inline creation;
- managed fields/tags and one unmanaged file property;
- blocked terminal transition is rejected;
- blocker completion then child completion succeeds;
- inline → file → inline preserves `operonId`;
- idempotency replay returns the original `operationId`;
- stale revision returns conflict without writing.

## 16. Official Operon 3.1.1 native Developer API pilot

Use a copied/disposable vault and the official `3.1.1` plugin assets. Do not
edit Operon's `data.json` directly: register the consumer through the official
Developer API integration UI/wrapper and approve the exact pending grant.

PASS requires one complete native routine covering:

- host-verified consumer identity and rejection of a forged copy;
- health, capabilities, catalog, and exact live task read;
- typed `tasks.*.preview` followed by `mutations.apply`;
- stable plan digest, receipt, postflight, and final state;
- replay of the same completed plan as `already-applied`;
- restart with a changed `sessionId`/instance epoch and recovery of the same
  plan reference, without a blind retry;
- no Markdown/private-method fallback.

The 2026-08-01 disposable pilot passed all checks, including Windows-native
path mutation and restart/recovery. Official package evidence was verified
against the 3.1.1 release assets before installation. This proves the native
Operon contract; it does not authorize production mutation enablement. The
current complete acceptance record uses the patched local build while the
upstream fixes linked above remain under review.

## 17. Official Operon 3.1.1 Bridge/MCP adapter pilot

The same disposable vault was then used with the production Bridge build and
the official grant, without changing the real vault or pushing the repository.

PASS:

- live read through the Bridge with `operonVersion=3.1.1` and hydrated writable
  fields/tags;
- typed create preview/apply and idempotent replay;
- typed update preview/apply, idempotent replay, and stale
  `expectedRevision` conflict without a write;
- recovery route and adapter unit coverage for same-plan recovery;
- both Bridge and MCP mutation opt-ins remained explicit.

LIMITATION:

- stock `3.1.1` can still expose an uncertain transition settlement on the
  known [Operon #99](https://github.com/hasanyilmaz/operon/issues/99) / [#101](https://github.com/hasanyilmaz/operon/pull/101)
  path. The patched local acceptance build reaches the terminal/recoverable
  proof; no retry or fallback is performed when the stock runtime cannot prove
  its result. The maintenance and frontmatter/window/rename fixes are tracked
  in upstream [#135](https://github.com/hasanyilmaz/operon/pull/135),
  [#137](https://github.com/hasanyilmaz/operon/pull/137), and
  [#139](https://github.com/hasanyilmaz/operon/pull/139).

## Executed pilot result — 2026-07-21

| Check                                     | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Operon 2.5 Public API v1 capability probe | PASS — filterQuery/adopt/create/update/transition/convert/relocate true |
| Guarded MCP smoke                         | PASS — create/update/transition/replay/conflict                         |
| Rich full MCP smoke                       | PASS — hierarchy/dependency/inline/file/conversion                      |
| Full reindex                              | PASS — generation 36 → 37, task count 13 → 13                           |
| Plugin restart                            | PASS — generation reset to 1, 13 tasks, read-write restored             |
| Stale fallback                            | PASS — `operon-live` → `operon-cache`, same ID/path/revision            |
| Duplicate fixture                         | PASS — one P0 `duplicate_operon_id`, last good cache retained           |
| Duplicate cleanup                         | PASS — P0/P1/P2 = 0/0/0, 13 tasks                                       |
| Actual Sync topology                      | NOT RUN                                                                 |

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
