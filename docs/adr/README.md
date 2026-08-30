# Architecture decision records

ADRs record decisions and their boundaries. Operational commands belong in
setup or operations guides, not in this index.

| ADR                                                                                                                | Current status                                                                         | Relationship                                                                |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [External document roots](ADR-External-Document-Roots.md)                                                          | Accepted and implemented; handoff plus diagnostic local-move planning later amended    | Base authorization, confinement and read/handoff contract                   |
| [Governed HTTP delivery](ADR-HTTP-External-Artifact-Delivery.md)                                                   | Accepted and implemented on `main` for authenticated loopback; remote remains pilot    | Adds `http_ticket`; HTTP mutation remains denied                            |
| [External reference integrity](ADR-External-Reference-Integrity.md) / [FR](ADR-External-Reference-Integrity.fr.md) | Accepted; diagnostic local-stdio surfaces implemented, mutation deferred               | Same-root diagnostic plan/status, redacted evidence and deferred mutation   |
| [Operon Bridge](ADR-Operon-Bridge.md)                                                                              | Accepted for bounded pilot                                                             | Versioned task-domain bridge and guarded mutation contract                  |
| [Common governed operation runtime](ADR-Common-Operation-Runtime.md)                                               | Accepted and released in 2.6.0; public atomic-note projection and live canary complete | Shared plan, apply, status, receipt and exact-plan recovery vocabulary      |
| [P1 governed frontmatter projection](ADR-Governed-Frontmatter-P1.md)                                               | Accepted, implemented and released in 2.7.0                                            | Source-preserving domain compiler projected over the released P0 runtime    |
| [P2 governed Base formula operation](ADR-Governed-Base-Formula-P2.md)                                              | Accepted, implemented and released in 2.8.0; live pilot passed                         | Second typed backend, source-preserving formula intent and legacy migration |
| [P3 governed Canvas graph operation](ADR-Governed-Canvas-P3.md)                                                    | Accepted, implemented and released in 2.9.0; live pilot passed                         | Typed Canvas CAS, graph intent, unknown-value preservation                  |

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
mutation. The P1 ADR is accepted and implemented after its
source-preservation proof, projected concurrency tests, Linux/Windows CI,
exact-head Codex Review, live Obsidian canary, merge, and post-merge `main`
workflow all passed.
The P2 ADR is accepted and implemented after its parsed-node
source-preservation proof, second typed Bridge CAS, HTTP mutation backpressure,
Linux/Windows CI, exact-head Codex Review, live Base canary, merge, and
post-merge `main` workflow all passed. It is released in `2.8.0`.
The P3 ADR is accepted and implemented after its bounded graph compiler,
typed Canvas CAS, durable recovery tests, Linux/Windows CI, live Obsidian
canary, independent hostile audit, merge, and post-merge `main` workflow all
passed. It is released in `2.9.0`.
