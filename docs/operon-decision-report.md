# Operon integration decision report

## Decision

**PILOT Operon with direct MCP mutations.** The technical integration is now strong enough for a bounded real-project pilot. Keep Tasks and TaskNotes in production until Sync, cockpit parity, maintenance cost, and human usability pass.

## Implemented

- Operon Public API v1 in a minimal GPL 2.5.0 fork;
- Bridge read/write capability probe;
- REST list/get/query/validate/create/update/transition/convert;
- nine MCP tools in the canonical server;
- dry-run by default;
- live expected-revision conflicts;
- Bridge and durable MCP idempotency;
- before/requested/after evidence and post-write re-read;
- central write policy integration;
- SQLite live/stale snapshots and mutation journal;
- no Markdown/private-method fallback;
- exact read allowlist for Operon 2.4.0 and 2.5.0.

## Verified in disposable Operon 2.5 vault

| Evidence | Result |
|---|---|
| Native file and inline fixtures | PASS |
| Direct MCP file and inline creation | PASS |
| Managed fields and tags | PASS |
| Unmanaged `north_star` / `rang` file properties | PASS |
| Parent and blocker links plus inverse reconciliation | PASS |
| Completion blocked while dependency open | PASS |
| Completion after blocker finished | PASS |
| Inline → file → inline with same `operonId` | PASS |
| Dry-run default | PASS |
| Durable idempotency replay | PASS |
| Stale revision conflict | PASS |
| Full V8 reindex parity | PASS — 13 tasks before/after, generation advanced |
| Operon/Bridge plugin restart | PASS — 13 tasks, read-write restored |
| Live → cache fallback | PASS — same task/revision, `stale: true` |
| Duplicate identity | PASS — P0 detected, last good snapshot retained |
| Final validation | PASS — P0/P1/P2 = 0/0/0 |
| Actual Sync topology | UNVERIFIED |
| Production migration | NOT RUN by design |

## Defects discovered and corrected

1. Immediate post-write reads could hit Operon's transient reindex window and report unavailable after a successful write. The Bridge now waits boundedly for a verified idle index and records `outcome_unverified` without blind retry if proof never arrives.
2. A combined rename + managed fields + unmanaged properties request could partially apply because Obsidian metadata lagged after rename. The contract now permits exactly one mutation group per operation and one unmanaged property per call.
3. Creating a child legitimately changes parent aggregates and therefore its revision. The rich smoke recipe now rereads the parent before transition; stale parent revisions are rejected as designed.

## Remaining risks

- The public API lives in a fork until accepted upstream.
- Real Sync behavior remains unverified.
- Cockpit equivalence and low-energy human workflow remain unproven.
- Root npm advisories predate this branch and require a separate dependency-security change.
- Production activation would expose write tools and therefore remains a manual gate.

## Recommendation

Proceed to a bounded non-critical project pilot, not a global switch. Production status remains `maturation` until the four cockpits, actual Sync, and seven-to-fourteen-day human/agent use pass. If they pass and the fork delta remains thin, recommend `SWITCH Operon`; otherwise `KEEP Tasks + TaskNotes`.

## Next action

Install the signed pilot builds in a copied-vault environment matching Mike's Sync topology, reproduce Now/Inbox/Étoile du Nord/Audit, and run one real non-critical project with Operon as exclusive task owner.
