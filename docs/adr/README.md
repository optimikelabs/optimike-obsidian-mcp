# Architecture decision records

ADRs record decisions and their boundaries. Operational commands belong in
setup or operations guides, not in this index.

| ADR                                                                                                                | Current status                                                                      | Relationship                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [External document roots](ADR-External-Document-Roots.md)                                                          | Accepted and implemented; handoff and local move contracts later amended            | Base authorization, confinement and read/handoff contract                |
| [Governed HTTP delivery](ADR-HTTP-External-Artifact-Delivery.md)                                                   | Accepted and implemented on `main` for authenticated loopback; remote remains pilot | Adds `http_ticket`; HTTP mutation remains denied                         |
| [External reference integrity](ADR-External-Reference-Integrity.md) / [FR](ADR-External-Reference-Integrity.fr.md) | Accepted and implemented for a local stdio pilot                                    | Same-root file move, exact ÉLYSIA reference repair, journal and rollback |
| [Operon Bridge](ADR-Operon-Bridge.md)                                                                              | Accepted for bounded pilot                                                          | Versioned task-domain bridge and guarded mutation contract               |
| [Common governed operation runtime](ADR-Common-Operation-Runtime.md)                                               | Accepted and released in 2.6.0; public atomic-note projection and live canary complete     | Shared plan, apply, status, receipt and exact-plan recovery vocabulary   |

## Status vocabulary

- `proposed`: not yet accepted as the current product contract;
- `accepted`: decision makes authority;
- `implemented`: accepted decision has matching code and tests;
- `pilot`: real use is allowed only inside the stated evidence boundary;
- `amended`: a later ADR changes one part without replacing the whole decision;
- `superseded`: a later ADR replaces the decision.

The external-roots ADR remains authoritative for root authorization,
confinement, provenance, reads and handoff. The HTTP ADR amends its stdio-only
delivery restriction. The external-reference-integrity ADR adds one opt-in
local stdio mutation without opening upload, replace, delete, sync or HTTP
mutation.
