# Operon Bridge — local validation recipe

This recipe is the Desktop proof. Run destructive fixtures only in a disposable or copied vault. In production ÉLYSIA, use the backed-up, reversible smoke scope defined by the migration plan and never touch unrelated tasks.

## Preconditions

- Node.js `>=22.7.5`
- Obsidian Desktop
- Local REST API enabled
- Operon `3.3.2` with Operon CLI `1.1.2` for the completed contract-first live pilot; `3.2.1` remains in the explicit certified set, and `2.4.0` / `2.5.0` remain legacy-read fixtures
- Optimike Operon Bridge built from this branch
- Optimike Obsidian MCP built from this branch
- a backup or disposable vault

The adapter certifies through Operon `3.2.1` and gives `3.3.2` provisional
version/accessor admission. The `3.3.2` live acceptance run separately proves
the Developer API, schema, index, capability, and readiness gates and is
complete and green; keeping its runtime state provisional preserves the
contract-first policy. Settings grant controls, implicit File Task rename
refusal, and unscoped transition settlement are fixed in `3.3.2`. Adoption
remains unavailable through the official Developer API and is tracked in
[#140](https://github.com/hasanyilmaz/operon/issues/140). Unsupported or uncertain paths stay fail-closed; this
recipe never authorizes a Markdown/private-API fallback or a blind retry.

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
- official Operon `3.2.0` reports the exact grants and typed Developer APIs
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
operon_get_diagnostics
operon_find_tasks
operon_resolve_task
operon_get_relationships
operon_build_context
operon_get_timer_state
operon_adopt_task
operon_create_task
operon_update_task
operon_transition_task
operon_set_relationships
operon_update_recurrence
operon_convert_task
operon_relocate_task
operon_list_pending_recoveries
operon_recover_mutation
```

PASS when:

- all twenty-three tools are registered;
- official Operon `3.2.0` returns a structured unavailable result for adoption;
- saved-filter execution succeeds only after an exact `tasks.filter-query`
  grant and caller-supplied filter ID; the official catalog remains unavailable;
- the first complete call creates a snapshot;
- subsequent calls with unchanged generation do not rewrite the full snapshot;
- responses say `source=operon-live`, `stale=false`.

## 9. Restart and reindex

1. Record the status generation and task revisions.
2. Restart Obsidian.
3. Run Operon's reindex/diagnostic validation.
4. Repeat REST and MCP parity.

PASS: same task identities and values; revisions change only when normalized task/source data changes.

## 9a. Relationship and recurrence pilot

1. Back up the pilot notes before any apply.
2. Dry-run a complete relationship replacement between the two dedicated pilot tasks.
3. Apply with the current `expectedRevision`, reread both tasks, and verify the inverse blocker edge.
4. Replay the exact `idempotencyKey`; the original operation must be returned without another write.
5. Verify an open blocker rejects a terminal transition, then restore both relationship sets exactly.
6. On a dedicated temporary recurrence fixture, dry-run/apply a rule, change scope with a fresh revision, then clear every recurrence field with `null`.
7. Restart Obsidian and MCP; confirm no relationship or recurrence residue and stable recovery state.
8. Remove the fixture only through the operator CLI after backup and explicit confirmation.

PASS: live source, exact inverse edges, scoped recurrence state, idempotent replay, stale-revision conflict, exact restoration, and `P0/P1/P2 = 0/0/0`.

Executed result refreshed on 2026-08-09 with the local Operon `3.2.0`
acceptance build:

- relationship dry-run/apply passed on `oo96ct2` and `1dbefy1`;
- the inverse edge was verified, the same key replayed without a second write,
  a stale revision conflicted, and both tasks were restored;
- a dedicated recurrence fixture passed add, scope change and explicit clear;
- Obsidian and MCP restart preserved a stable recovery state;
- final inventory returned 25 tasks outside the removed fixture, live source,
  no residual relationship/recurrence state, no pending recovery, and
  `P0/P1/P2 = 0/0/0`.

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

Use one of these disposable-vault fixtures:

- disable Operon to exercise the unavailable path;
- set the test manifest to `3.0.0`, which is explicitly denied; or
- remove, break, or return a malformed `getDeveloperApiV1()` contract to make
  Developer API V1 negotiation fail.

Do not use a merely unknown product version as the incompatibility fixture. A
non-denied release exposing the Developer API V1 accessor is admitted as
`compatible-provisional` by design. It is not usable until `developerApi`,
top-level `ok`, `index.ready`, and the requested capability also pass.

PASS:

- Bridge status becomes unavailable for the disabled fixture or incompatible
  for the denied/broken-contract fixture;
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
- official Operon 3.2.0 exposes typed create/update/transition/relationship/recurrence/convert/relocate
  only after the grant; an uncertain transition apply is bounded by the Bridge,
  while `adopt`, unmanaged properties, and arbitrary
  `targetFolder` remain explicitly unsupported; saved-filter execution is
  available after an exact grant and caller-supplied ID, without catalog listing;
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
Operon 3.2.0 use section 18; do not expect unmanaged properties or arbitrary
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

## 18. Official Operon 3.2.0 Bridge/MCP acceptance — 2026-08-09

The production-shaped ÉLYSIA pilot used Operon `3.2.0`, CLI `1.1.0`, Bridge
`0.6.0`, both mutation opt-ins, and the official Developer APIs. The local
Operon build included only the settings-renderer fix required to display grant
controls.

PASS:

- live `operon-live` source, 25 tasks, compatible 3.2.0/0.6.0 runtime;
- all intended capabilities true except adoption;
- exact `tasks.filter-query` grant and saved-filter execution with opaque
  pagination; catalog discovery correctly remains unavailable;
- live `fs_elysia_now` replay returned 11 results, two three-item pages without
  overlap, and remained available during concurrent status/query refreshes;
- service regression coverage preserves Bridge `404` and `422` filter failures
  as `NOT_FOUND` and `VALIDATION_ERROR` instead of `INTERNAL_ERROR`;
- relationship preview/apply, inverse edge, idempotent replay, blocked terminal
  transition and exact restoration;
- recurrence create/change/clear with explicit scopes and normalized postflight;
- temporary recurrence fixture backed up, removed through the operator CLI, and
  verified absent from disk and index;
- Obsidian and MCP backend restart, no pending recovery, no residual relation or
  recurrence, and final `P0/P1/P2 = 0/0/0`.

BOUNDARIES AT THE TIME OF THIS 3.2.0 PILOT:

- adoption is not exposed by the official Developer API;
- saved-filter IDs must come from Operon's UI/configuration or an operator
  workflow because the official API does not list the catalog;
- #99/#101 and #139 were fail-closed paths; Operon `3.3.2` later fixed them;
- no deletion tool, generic CLI passthrough, raw Markdown or private API exists
  in the MCP.

## 19. Official Operon 3.3.0 contract-first acceptance — 2026-08-13

Inputs:

- official Operon `3.3.0`;
- Optimike Operon Bridge `0.7.0`;
- Local REST API and both mutation opt-ins enabled;
- pre-cutover backup and rollback path verified;
- existing ÉLYSIA task corpus, plus one bounded smoke task `1dbefy1` restored
  after the run.

PASS:

- two complete Obsidian restarts retained the active
  `optimike-operon-bridge` Developer API consumer at grant revision 6, with no
  pending capability and no manual re-exposure;
- the first live status recovered through the bounded `cache-ready` startup
  retry and then reported `compatible-provisional`, a valid Developer API V1
  channel, `index.ready=true`, and 30 tasks;
- `operon_validate` returned `P0/P1/P2 = 0/0/0`;
- saved-filter execution for exact ID `fs_elysia_now` succeeded;
- smoke task `1dbefy1` passed sealed preview/apply, idempotent replay
  (`replayed=true`), stale-revision conflict, semantic restoration, and
  postflight re-read;
- `operon_list_pending_recoveries` returned an empty list after restoration.

NOT RUN LIVE:

- forced response loss after apply. This remains covered by the disposable
  operation fixtures; it was not induced against the production vault.

The `compatible-provisional` label records version/accessor admission only.
The successful Developer API status, schema, index, capability, and readiness
checks above are the independent evidence that authorized this pilot.

## 20. Official Operon 3.3.2 / CLI 1.1.2 paired acceptance — 2026-08-17

Inputs:

- official Operon `3.3.2` and Operon CLI `1.1.2`;
- Optimike Operon Bridge `0.7.0` and the 23-tool MCP surface;
- Local REST API, exact Developer API grants, and both mutation opt-ins;
- paired pre-cutover backup and rollback to Operon `3.3.1` / CLI `1.1.1`.

PASS:

- Windows bootstrap progressed through `starting`, `cache-ready`, and `ready`;
- the live source exposed 30 tasks, saved filter `fs_elysia_now`, and no pending
  recovery;
- a temporary task passed a sealed `Planifié → En cours` apply and exact
  `En cours → Planifié` restoration with fresh host consent;
- both transition applies returned terminal `applied` results with matching
  postflight state;
- the fixture was backed up, deleted through the official operator CLI, and
  confirmed absent from the live index;
- the final snapshot returned to 30 tasks, two historical Operon Pilot tasks,
  zero recovery, and `P0/P1/P2 = 0/0/0`.

CURRENT BOUNDARIES:

- adoption remains unavailable through the official Developer API (#140);
- saved-filter execution requires an exact known ID because catalog discovery
  is not exposed;
- delete, reminders, pin state, and timer control/session remain CLI operator
  actions rather than MCP tools;
- no generic CLI passthrough, raw Markdown mutation, or private API fallback is
  permitted.

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
