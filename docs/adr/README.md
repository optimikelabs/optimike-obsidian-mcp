# Architecture decision records

ADRs record decisions and their boundaries. Operational commands belong in
setup or operations guides, not in this index.

| ADR                                                              | Current status                                                                      | Relationship                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [External document roots](ADR-External-Document-Roots.md)        | Accepted and implemented; handoff transport amended                                 | Base authorization, confinement and read-only contract            |
| [Governed HTTP delivery](ADR-HTTP-External-Artifact-Delivery.md) | Accepted and implemented on `main` for authenticated loopback; remote remains pilot | Adds `http_ticket` without changing external-root mutation policy |
| [Operon Bridge](ADR-Operon-Bridge.md)                            | Accepted for bounded pilot                                                          | Versioned task-domain bridge and guarded mutation contract        |

## Status vocabulary

- `proposed`: not yet accepted as the current product contract;
- `accepted`: decision makes authority;
- `implemented`: accepted decision has matching code and tests;
- `pilot`: real use is allowed only inside the stated evidence boundary;
- `amended`: a later ADR changes one part without replacing the whole decision;
- `superseded`: a later ADR replaces the decision.

The external-roots ADR remains authoritative for root authorization,
confinement, provenance and read-only policy. The HTTP ADR amends only its
stdio-only delivery restriction.
