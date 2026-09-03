# Operon Bridge — local validation recipe

This recipe is the Desktop proof. Run destructive fixtures only in a disposable or copied vault. In production ÉLYSIA, use the backed-up, reversible smoke scope defined by the migration plan and never touch unrelated tasks.

## Preconditions

- Node.js `>=22.7.5`
- Obsidian Desktop
- Local REST API enabled
- Optimike MCP `3.8.2`, targeting Operon `3.6.2`, Operon CLI `1.2.0` and Local REST API `5.1.0` behind the exact-SHA release gate below; `3.2.1` remains in the explicit certified set, `3.3.2` / CLI `1.1.2` remains completed historical evidence, and `2.4.0` / `2.5.0` remain legacy-read fixtures
- Optimike Operon Bridge `0.9.2`
- Optimike Operon Bridge built from this branch
- Optimike Obsidian MCP built from this branch
- a backup or disposable vault

The adapter certifies through Operon `3.2.1` and gives later non-denied V1
releases provisional version/accessor admission. The `3.3.2` live acceptance run separately proves
the Developer API, schema, index, capability, and readiness gates and is
complete and green; keeping its runtime state provisional preserves the
contract-first policy. Settings grant controls, implicit File Task rename
refusal, and unscoped transition settlement are fixed in `3.3.2`. Adoption was
unavailable through that Developer API generation. Operon `3.5.3` exposes
adoption plus Daily/Weekly workflows through exact additive grants. The 3.1
release preserves `taskGallery` as an ordered array, keeps `taskType` and
`taskImage` scalar, and treats `__taskDataType` as read-only. It remains
`compatible-provisional` as certification metadata, while mutation admission
depends on the negotiated contract and exact live gates rather than a product
version allowlist.
Unsupported or uncertain paths stay fail-closed; this
recipe never authorizes a Markdown/private-API fallback or a blind retry.

For the 3.2.0 candidate, begin one adoption or periodic dry-run from a cold MCP session. The
request must reach the Bridge and create or reuse only the exact additive grant;
before operator approval it must fail closed, and after approval the identical
dry-run must plan successfully without requiring a warm-up status/read call.

For the explicitly disposable Pilot 2 vault, record the initial plugin/runtime
state and retain only minimal diagnostic/rollback evidence, then upgrade and
test that vault directly. Do not create a sibling clone as a release gate.
Obsidian CLI can target and open this vault with `vault=<name>`, but it exposes
no dedicated supported `close` or `quit` command. For this disposable vault,
the CLI can target its window and evaluate `window.close()`. Record the exact
Pilot 2 Local REST port first: the command result alone does not prove that the
intended window closed.

On Windows PowerShell, substitute the exact vault name and the Local REST HTTP
port configured in Pilot 2. The port must identify Pilot 2 rather than another
open vault:

```powershell
$pilotVault = "Operon Bridge Pilot 2"
$pilotRestPort = 27123

if (-not (Test-NetConnection 127.0.0.1 -Port $pilotRestPort -InformationLevel Quiet)) {
  throw "Pilot 2 Local REST port is not listening before close"
}

obsidian vault="$pilotVault" eval code="window.close();'closing-pilot-2'"
if ($LASTEXITCODE -ne 0) { throw "Targeted Pilot 2 close failed" }

$deadline = (Get-Date).AddSeconds(15)
do {
  $pilotPortOpen = Test-NetConnection 127.0.0.1 -Port $pilotRestPort -InformationLevel Quiet
  if ($pilotPortOpen) { Start-Sleep -Milliseconds 250 }
} while ($pilotPortOpen -and (Get-Date) -lt $deadline)

if ($pilotPortOpen) { throw "Pilot 2 Local REST port is still listening after close" }
```

PASS only when the bounded port check reaches `False`. If it remains `True`,
stop and identify the listening vault/process instead of assuming a clean restart.
Reopen the same disposable vault with `obsidian vault="$pilotVault"` and recheck
the same port before continuing the canary. This targeted `eval` is a Pilot 2
test operation, not a generic supported Obsidian `close` command.

## 1. Automated checks

From the MCP repository:

```bash
npm ci
npm --prefix plugins/obsidian-operon-bridge ci
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
- official Operon `3.6.2` reports the exact Developer API V1 and additive
  task-workflow grants; the Bridge advertises only the mutation capabilities
  that the live runtime proves and bounds uncertain applies without a blind
  retry;
- adoption and periodic capabilities are true only after their exact grants;
  missing grants remain structured unavailable results, while historical
  3.2.x and legacy Kairélys/Public API probes are tested separately;
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
operon_create_periodic_task
operon_update_periodic_scheduling
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

- all twenty-five tools are registered;
- official Operon `3.6.2` exposes mutations after Developer API V1 negotiation,
  exact grants, valid response schemas, live health, a settled index, write
  policy and recovery checks; a missing or malformed gate returns a structured
  unavailable result without a Markdown fallback;
- saved-filter execution succeeds only after an exact `tasks.filter-query`
  grant and caller-supplied filter ID; the official catalog remains unavailable;
- recovery requires the public nested `recovery` union: `{ kind:
"developer-api" }` or `{ kind: "adopt" | "periodic-create" |
"periodic-update", planDigest?: sha256 }`; flat top-level kind/digest input is
  internal migration state only;
- with `OPERON_MUTATION_ALLOWED_PATH_PREFIXES` non-empty, both pending-recovery
  listing and apply fail closed before inventory disclosure or native dispatch;
- the first complete call creates a snapshot;
- subsequent calls with unchanged generation do not rewrite the full snapshot;
- responses say `source=operon-live`, `stale=false`.

## 8a. Exact Operon 3.6 live canary

Run only after the exact release Bridge is installed and the Pilot 2 core
status, index and validation gates above are green. Optional task-workflow
capabilities may still be cold: the canary lets the exact invoked operation
negotiate them. The recommended mode proves
the real startup order: MCP connects first while Pilot 2 is closed, the same MCP
connection survives a degraded status, then the CLI opens only Pilot 2 and that
same client becomes live.

From Windows PowerShell in the MCP repository, first close Pilot 2 with the
targeted command and port proof documented above. Then set the exact disposable
vault path required by the script and run:

```powershell
$env:OBSIDIAN_VAULT = "<exact disposable Pilot 2 path required by the script>"
$env:OBSIDIAN_BASE_URL = "http://127.0.0.1:27233"
$env:OBSIDIAN_API_KEY = "<Pilot 2 Local REST API key>"
$env:OPERON_MUTATIONS_ENABLED = "true"
$env:OPERON_35_CANARY_EXPECTED_OPERON_VERSION = "3.6.2"
$env:OPERON_35_CANARY_EXPECTED_BRIDGE_VERSION = "0.9.2"
$env:OPERON_35_CANARY_EXPECTED_MCP_VERSION = "3.8.2"
$env:OPERON_35_CANARY_RELEASE_CANDIDATE = "true"
$env:OPERON_35_CANARY_CONFIRM = "I_CONFIRM_PILOT_2_DISPOSABLE_LIVE_MUTATIONS"
$env:OPERON_35_CANARY_OPEN_VAULT = "true"
$env:OPERON_35_CANARY_CONFIRM_OPEN_VAULT = "I_CONFIRM_OPENING_ONLY_OPERON_PILOT_2"
Remove-Item Env:OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN -ErrorAction SilentlyContinue

npm run build
npm run smoke:operon-35-live
```

If `obsidian` is not on `PATH`, set
`OPERON_35_CANARY_OBSIDIAN_CLI` to its exact executable or launcher first. The
historical script name remains stable; it validates the negotiated contract, not
a product-version allowlist. Its default expected runtime is the current live
target, Operon `3.6.2`; set the explicit variable above so copied acceptance
recipes remain self-describing. To
test an already-open Pilot 2 instead, remove the two `OPEN_VAULT` variables and
set `OPERON_35_CANARY_CONFIRM_PILOT_ALREADY_OPEN=true`; that mode does not prove
the startup-order contract.

### Operon 3.6.1 grant reapproval gate (mandatory)

The automated behavior canary does not click Operon's Settings UI. Before
admitting `3.6.1`, the disposable Pilot 2 vault must therefore record this
operator-gated check:

1. start from an active Bridge `0.9.2` grant and record its consumer version,
   approved major, revision, exact grants and pending-request count;
2. load a test Bridge with a different consumer major so Operon suspends the
   otherwise coherent grant; prove that a mutation remains unavailable and that
   no effect occurred;
3. in **Developer API integrations**, approve the exact pending selection and
   prove that the grant becomes active only for that binding;
4. restore the release Bridge `0.9.2`, repeat the explicit approval, and verify
   `read-write`, zero pending requests, a ready index and zero pending
   recoveries;
5. retain the automated negative contracts that reject stale source revisions,
   revoked authority and binding drift. Reapproval of a coherently suspended
   grant must never broaden those fail-closed cases.

The 2026-08-31 Pilot 2 release gate passed this sequence: the temporary `1.0.0`
Bridge grant became active only after explicit approval, then the restored
`0.9.2` grant became active only after a second explicit approval. The final
runtime reported Operon `3.6.1`, Bridge `0.9.2`, `read-write`, 30 exact grants,
zero pending requests, a ready index and zero pending recoveries.

The script refuses to start unless all of these gates hold:

- the resolved vault is the one exact disposable Pilot 2 compiled into the
  canary, with the expected vault name;
- release-candidate mode names one exact clean Git SHA and rebuilds both MCP and
  Bridge from that checkout before proof. The build manifest is checked against
  the normalized source manifest with its expected generated `main: "main.js"`
  entry (rather than a byte-for-byte source comparison), then the bundle and
  generated manifest must match the files installed in Pilot 2. The SHA, clean
  status, MCP build hash, Bridge build hash, generated-manifest hash and
  installed bundle/manifest hashes are rechecked immediately before every native dispatch;
- every native canary mutation first performs an explicit dry-run/projection and
  an immediate physical source/target attestation. Every parent must resolve
  inside the real Pilot 2 root without a symlink, junction or reparse point, and
  every existing target must be a single-link regular file. A periodic plan that
  does not expose all task-source paths, or any mutation without one resolved
  physical source/target, is refused before dispatch;

A periodic plan that does not expose all task-source paths is refused before dispatch. Official
Operon `3.6.0` currently exposes a metadata-only public periodic plan, so the exact-SHA
release canary performs periodic preview and exact-grant negotiation but skips periodic
applies with reason `public_task_source_projection_unavailable`. This is a destructive-canary
containment/certification boundary; the runtime tools remain available and upstream public
task-source path projection is a nonblocking follow-up. Do not claim full periodic
certification. Core startup, adoption, media, Frontmatter Date Manager, idempotence and
restoration gates remain mandatory.
For a stale-revision or same-key replay, where a new dry-run can only
return the expected conflict because the original apply has already changed the
source, the canary instead re-attests the exact source paths from the first
sealed preflight immediately before replay; it never broadens them.

- Local REST uses exactly `http://127.0.0.1:27233` and a non-empty API key;
- `OPERON_MUTATIONS_ENABLED=true`, the Bridge mutation setting is enabled, and
  the required core Developer API capabilities are live; each task-workflow
  route must negotiate its exact grant when first invoked and fail closed if
  that grant is absent or refused;
- `Canary/Operon-3.5-Live-Canary.md` does not already exist;
- the explicit mutation confirmation is exact; startup-order mode additionally
  requires the exact open-vault confirmation;
- the canary process forces `MCP_WRITE_MODE=full`, an empty mutation path
  allowlist, non-blocking startup, the `tasks` profile, and a private temporary
  cache/backup scope.

This is a fail-closed best-effort TOCTOU fence, not a native handle-relative
filesystem guarantee: Node cannot hold every parent and target by an `openat`-
style handle across the subsequent Operon dispatch on supported Windows/macOS
and Linux runtimes. The canaries therefore re-resolve every relevant path after
the dry-run and immediately before dispatch, re-hash the candidate artifacts at
that same boundary, and re-check observed result paths afterwards. A concurrent
attacker with filesystem write access can still race the gap between that final
check and Operon's own native open; do not treat this canary as authority to run
against a non-disposable vault or an untrusted writable filesystem.

The command writes its JSON evidence under the OS temporary root and prints the
exact `evidenceFile`. Certification is forbidden unless the command exits `0`,
the printed summary has `ok=true`, `fixtureRestored=true` and
`periodicArtifactsRetained=0`, and the evidence confirms the exact release
versions, zero validation violations, zero pending recoveries, byte-exact
artifact restoration, and—when startup-order mode is selected—
`degradedObserved=true`, `connectionAliveAfterDegraded=true`,
`sameClientBecameLive=true`. A failed run retains the private backup path for
diagnosis and is never certification evidence.

### Execution journal — 2026-08-24

The first startup-order attempt produced `MCP error -32000: Connection closed`
in `operon-35-live-evidence-c8a4b93c-6aac-4b62-8b03-5b00cdffd804.json`. This was
a harness false signal: `LOGS_DIR` pointed to an OS-temporary directory outside
the configured `projectRoot`, so startup directory validation terminated the
backend before the startup-order behavior could be observed. The harness now
uses `<projectRoot>/logs`; this failure is not evidence that non-blocking MCP
startup is broken.

Two later real startup-order attempts—captured in
`operon-35-live-evidence-0ebe3260-9175-4923-9437-77bc92a7123d.json` and
`operon-35-live-evidence-e5d7c95d-de81-441b-9830-43acd06d0b0f.json`—recorded
the intended sub-proof:

- `degradedObserved=true` while Pilot 2 was closed;
- `connectionAliveAfterDegraded=true` on the same MCP client;
- CLI exit `0`, then `sameClientBecameLive=true` after two live-status attempts;
- all canary Markdown artifacts restored on failure.

Those runs remain `ok=false`: one stopped at the Frontmatter Date Manager gate
and the next at adoption apply. They led to bounded upstream fixes for auth,
same-source graph ordering and modified-time settlement.

The final patched candidate (`#182` + `#183` + `#184`, combined code head
`4412a20`, local attested manifest version `3.5.240438`) passed the complete
startup-order canary on 2026-08-24. The printed
summary reported `ok=true`, `fixtureRestored=true` and
`periodicArtifactsRetained=0`. It also proved Daily/Weekly creation, periodic
scheduling set/clear with Frontmatter Date Manager active, concurrent Bridge
replay, zero validation violations and zero pending recoveries. This is
historical acceptance evidence for the patched candidate. Stock Operon `3.5.3`
with Bridge `0.8.1` passed this same complete recipe on 2026-08-25. Bridge
`0.8.2` then repeated it on the same disposable Pilot 2 with `ok=true`, exact
fixture and inventory restoration, P0/P1/P2 at zero, zero pending recoveries and
zero retained periodic artifacts. Working-tree runs for the unreleased Optimike
MCP `3.2.0` candidate then exercised Bridge `0.8.3`, stock Operon `3.6.0`,
Operon CLI `1.2.0` and Local REST API `5.1.0`: same-connection startup order,
mutation/replay/stale-conflict/recovery, adoption, Frontmatter Date Manager
settlement, validation and exact restoration. Periodic runs were historical/
diagnostic only; the exact-SHA canary negotiates and previews periodic workflow
but skips periodic apply under `public_task_source_projection_unavailable`.
The non-periodic gate results remain diagnostic until this recipe passes after a
clean rebuild on the final candidate SHA; the historical periodic apply remains
diagnostic even after that gate. The Operon Developer API V1 public contract
did not drift from `3.5.3`.
The
synthetic `3.5.240438` identity remains historical and
must never be published as an upstream Operon release.

### Operon 3.6 behavior checks

Run the offline safety contract first:

```powershell
npm run test:operon-36-behavior-contract
```

The live gate is `npm run smoke:operon-36-behaviors-live`. It is hard-bound to
the disposable Pilot 2 path and Local REST port, requires the explicit
`OPERON_36_BEHAVIOR_CANARY_CONFIRM` value printed by the script, and requires
the configured modified-time writer to be disabled before mutation and restored
afterward. It retains a private recovery directory only on failure and prints a
redacted evidence path.

The following working-tree diagnostic run (not accepted release evidence) exercised Scheduled Date on a blocked task through
`operon_update_periodic_scheduling`, preserved `blockedBy` plus inverse
`blocking`, removed the run-owned periodic parent artifact, restored the fixture
and complete Markdown inventory exactly, returned validation P0/P1/P2 and
pending recoveries to zero, and re-enabled Frontmatter Date Manager. It is historical
diagnostic evidence only; the exact-SHA canary skips periodic apply under the
public-source projection boundary above. Task Editor
deletion is explicitly `SKIP` because the MCP has no public delete surface.
Parent-date expansion is explicitly `SKIP` because Pilot 2's public
configuration does not announce the opt-in automation as active. Operators who
enable those features must exercise the two skipped checks before relying on
them. None of these checks permits unrelated relationship or parent-date drift
during MCP postflight. Its applicable non-periodic checks must be repeated from a
clean rebuild pinned to the exact release SHA before they can be cited as
accepted release evidence. The exact-SHA canary does not repeat Scheduled Date
apply; it skips periodic apply under `public_task_source_projection_unavailable`.

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

BOUNDARIES OF THAT 3.3.2 RUN:

- adoption was unavailable through that official Developer API generation
  (#140);
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
