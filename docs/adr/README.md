# Architecture decision records

ADRs record decisions and their boundaries. Operational commands belong in setup or operations guides, not in this index.

| ADR | Current status | Relationship |
| --- | --- | --- |
| [Portable tool-surface profiles V3](ADR-Tool-Surface-Profiles-V3.md) | Accepted and implemented for 3.0 | Server-owned profile compilation, public entrypoints, session binding and semantic-alias removal |
| [External document roots](ADR-External-Document-Roots.md) | Accepted and implemented; handoff and local move contracts later amended | Base authorization, confinement and read/handoff contract |
| [Governed HTTP delivery](ADR-HTTP-External-Artifact-Delivery.md) | Accepted and implemented on `main` for authenticated loopback; remote remains pilot | Adds `http_ticket`; HTTP mutation remains denied |
| [External reference integrity](ADR-External-Reference-Integrity.md) / [FR](ADR-External-Reference-Integrity.fr.md) | Accepted and implemented for a local stdio pilot | Same-root file move, exact ÉLYSIA reference repair, journal and rollback |
| [Operon Bridge](ADR-Operon-Bridge.md) | Accepted for bounded pilot | Versioned task-domain bridge and guarded mutation contract |
| [Common governed operation runtime](ADR-Common-Operation-Runtime.md) | Accepted and released in 2.6.0 | Shared plan, apply, status, receipt and exact-plan recovery vocabulary |
| [P1 governed Frontmatter projection](ADR-Governed-Frontmatter-P1.md) | Accepted, implemented and released in 2.7.0 | Source-preserving domain compiler projected over the released P0 runtime |
| [P2 governed Base formula operation](ADR-Governed-Base-Formula-P2.md) | Accepted, implemented and released in 2.8.0; live pilot passed | Second typed backend, source-preserving formula intent and legacy migration |
| [P3 governed Canvas graph operation](ADR-Governed-Canvas-P3.md) | Accepted, implemented and released in 2.9.0; live pilot passed | Typed Canvas CAS, graph intent and unknown-value preservation |

## Decision chain

```text
P0 common durable operation runtime (2.6)
→ P1 Frontmatter projection (2.7)
→ P2 Base formulas (2.8)
→ P3 Canvas graphs (2.9)
→ V3 portable tool-surface profiles (3.0)
```

The V3 ADR does not replace the operation-runtime decisions. It governs which complete families are visible and callable in one client session while preserving every journal, idempotency, compare-and-swap and recovery authority below that surface.

## Status vocabulary

- `proposed`: not yet accepted as the current product contract;
- `accepted`: decision makes authority;
- `implemented`: accepted decision has matching code and tests;
- `pilot`: real use is allowed only inside the stated evidence boundary;
- `amended`: a later ADR changes one part without replacing the whole decision;
- `superseded`: a later ADR replaces the decision.

## Current boundaries

The external-roots ADR remains authoritative for root authorization, confinement, provenance, reads and handoff. The HTTP ADR amends its stdio-only delivery restriction. The external-reference-integrity ADR adds one opt-in local stdio mutation without opening upload, generic replace/delete, sync or HTTP mutation.

The P1, P2 and P3 ADRs remain authoritative for their domain compilers and complete `plan/apply/status/recover` guarantees.

The V3 surface ADR adds:

- a 74-name cross-runtime public catalogue;
- `standard`, `authoring`, `tasks` and `full` profiles;
- profile selection before `tools/list`;
- call filtering as well as discovery filtering;
- HTTP session/profile binding;
- removal of `smart_search` and `smart-search`;
- atomic exposure of governed/recovery bundles;
- explicit preservation of profile-independent durable recovery.
