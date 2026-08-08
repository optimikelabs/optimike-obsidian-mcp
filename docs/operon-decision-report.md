# Operon integration decision report

## Current status — 2026-08-07

The published MCP adapter now targets official Operon `3.1.1` and Bridge
`0.5.1`. The complete local acceptance run is green on the patched Operon
build, including transition, expected-revision conflicts, idempotent replay,
restart/recovery, and postflight. The upstream compatibility fixes remain
under review in [#135](https://github.com/hasanyilmaz/operon/pull/135),
[#137](https://github.com/hasanyilmaz/operon/pull/137), and
[#139](https://github.com/hasanyilmaz/operon/pull/139); the known transition
investigation is [#99](https://github.com/hasanyilmaz/operon/issues/99) /
[#101](https://github.com/hasanyilmaz/operon/pull/101). Stock Operon `3.1.1`
remains supported for reads and most governed mutations, but the Bridge stays
fail-closed when the stock runtime cannot prove a result. No Markdown/private
API fallback is used.

## Historical pilot record — 2026-08-01

**CUTOVER COMPLETE on 2026-08-01.** The production vault was backed up,
Operon `3.0.1` was installed and validated live, the current Bridge `0.5.0` was
installed, and Kairélys was disabled but retained for reversible rollback.
The cutover is read/operationally green; the official transition apply remains
explicitly gated because its Bridge path has not produced a terminal or
recoverable result.

## Implemented

- legacy Operon Public API v1 compatibility for bounded Kairélys/2.5 fixtures;
- Bridge read/write capability probe;
- REST status/configuration/list/get/query/saved-filter/validate, six bounded
  native Developer API reads, adopt/create/update/transition/convert/relocate,
  plus official recovery;
- twenty-one MCP tools in the canonical server;
- dry-run by default;
- live expected-revision conflicts;
- Bridge and durable MCP idempotency;
- before/requested/after evidence and post-write re-read;
- central write policy integration;
- SQLite live/stale snapshots and mutation journal;
- no Markdown/private-method fallback;
- official Operon 3.0.1 Developer API V1 read/write pilot, with Bridge transition capability withheld pending a terminal REST proof;
- exact read allowlist for Operon 2.4.0 and 2.5.0;
- official Operon `3.0.1` Developer API V1 integration with host-owned recovery;
- CLI/Developer API audit separating operator functions from the curated MCP
  surface.

## Verified in disposable Operon 2.5 vault

| Evidence                                             | Result                                            |
| ---------------------------------------------------- | ------------------------------------------------- |
| Native file and inline fixtures                      | PASS                                              |
| Direct MCP file and inline creation                  | PASS                                              |
| Managed fields and tags                              | PASS                                              |
| Unmanaged `north_star` / `rang` file properties      | PASS                                              |
| Parent and blocker links plus inverse reconciliation | PASS                                              |
| Completion blocked while dependency open             | PASS                                              |
| Completion after blocker finished                    | PASS                                              |
| Inline → file → inline with same `operonId`          | PASS                                              |
| Dry-run default                                      | PASS                                              |
| Durable idempotency replay                           | PASS                                              |
| Stale revision conflict                              | PASS                                              |
| Full V8 reindex parity                               | PASS — 13 tasks before/after, generation advanced |
| Operon/Bridge plugin restart                         | PASS — 13 tasks, read-write restored              |
| Live → cache fallback                                | PASS — same task/revision, `stale: true`          |
| Duplicate identity                                   | PASS — P0 detected, last good snapshot retained   |
| Final validation                                     | PASS — P0/P1/P2 = 0/0/0                           |
| Actual Sync topology                                 | UNVERIFIED                                        |
| 2.5 pilot production migration                      | NOT APPLICABLE — cutover is recorded below       |

## Production cutover result — 2026-08-01

| Check | Result |
| --- | --- |
| Backup | PASS — `E:\Mes Vibes Programmes\backups\elysia-operon-cutover-20260801-1620`, 268 files |
| Official Operon assets | PASS — `3.0.1` release `main.js`, `manifest.json`, and `styles.css` verified before install |
| Live plugin state | PASS — Operon `3.0.1`, Bridge `0.5.0`, 25 tasks, live generation and index ready |
| MCP live read/configuration | PASS — `source=operon-live`, `stale=false` |
| Native read expansion | PASS — diagnostics, finder, resolve, relationships, context and timers through Bridge/MCP service |
| Developer API grant | PASS — exact five new read capabilities approved through Operon's official integration controller; no pending capability |
| Live validation | PASS — P0/P1/P2 = 0/0/0, no violations |
| Kairélys | PASS — disabled and retained; configuration hash unchanged |
| Bridge transition | GATED — isolated transition apply exceeded 120 s and returned `outcome-unknown`; task unchanged and no pending recovery |

The transition reproduction was performed only in the disposable pilot, with
the capability gate temporarily removed from a test copy of the Bridge and then
the normal `0.4.7` build restored. The real vault was not mutated by this
probe.

Bridge `0.5.0` was then installed with a dedicated local backup. Its official
Developer API grant was expanded only for `tasks.finder`, `entities.resolve`,
`relationships.read`, `context.build`, and `timers.read`. The live postflight
returned 25 tasks, all six new capability flags, a resolved exact identity,
bounded finder/context results, relationship and timer state, and the same
results through the MCP service. No task mutation was performed.

## Defects discovered and corrected

1. Immediate post-write reads could hit Operon's transient reindex window and report unavailable after a successful write. The Bridge now waits boundedly for a verified idle index and records `outcome_unverified` without blind retry if proof never arrives.
2. A combined rename + managed fields + unmanaged properties request could partially apply because Obsidian metadata lagged after rename. The contract now permits exactly one mutation group per operation and one unmanaged property per call.
3. Creating a child legitimately changes parent aggregates and therefore its revision. The rich smoke recipe now rereads the parent before transition; stale parent revisions are rejected as designed.

## Remaining risks

- Official transition latency/settlement behavior still needs an upstream or
  Bridge-level fix and a fresh terminal proof.
- Real Sync behavior remains unverified.
- Cockpit equivalence and low-energy human workflow remain unproven.
- Dependency audit is clean at the audited SHAs; future upstream advisories remain a maintenance risk.
- Advanced CLI functions are intentionally not generic MCP passthroughs.

## Recommendation

Keep the current cutover active for supported read/create/update/convert/
relocate operations. Use the MCP for governed agent workflows, including
native diagnostics, finder/resolve, bounded relationships/context and timer
observation. Use the Operon CLI for broad administration, deep recovery
investigation, native acceptance and one-off operator actions. Keep Kairélys disabled but retained until a separate
non-dependency proof authorizes removal. Do not enable Bridge transition apply
or remove its capability gate without a fresh terminal/recovery proof.

## Next action

Prepare a focused upstream/Bridge transition report with the exact
`outcome-unknown` evidence, then rerun a disposable terminal/recovery proof
after a fix. Separately audit the real vault's Kairélys non-dependency before
considering removal.
