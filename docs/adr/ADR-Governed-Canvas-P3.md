# ADR: P3 governed Canvas graph operation

- Status: accepted for implementation; release admission requires the live pilot
- Date: 2026-08-17
- Parent: [Common Operation Runtime](ADR-Common-Operation-Runtime.md)
- Contract: [Governed Canvas P3](../governed-canvas-p3.md)

## Decision

Expose a domain-specific operation for one existing JSON Canvas, implemented
as a projection over the common single-resource runtime and a new Canvas CAS
capability in Atomic Write Bridge 0.4.0.

The public intent is entity-based, not whole-file replacement. Supported node
and edge operations compile to localized JSON edits. Unknown root/entity values
must remain semantically identical outside the authorized entities, and the
final graph must validate before the plan becomes durable.

The Bridge owns only the typed backend boundary: strict `.canvas` path,
independent default-off write gate, binding fingerprint, graph validation, and
SHA-256 CAS inside `Vault.process`. It does not choose or broaden the intent.

## Invariants

1. `actualSemanticDiff(before, after)` is exactly the sealed entity intent.
2. Untargeted entities and unknown root values retain the same canonical digest.
3. Apply accepts sealed content only; no graph operation is recompiled at apply.
4. A stale file or backend binding fails closed before the P3 effect.
5. Status never re-executes, and recover never accepts a new intent.
6. Canvas and Markdown write gates remain independent.
7. The legacy direct Canvas helper remains explicitly non-governed.

## Rejected alternatives

- whole-file JSON stringify as the public mutation contract;
- a generic file CAS tool exposed to MCP clients;
- reusing the Markdown write gate for Canvas;
- treating headless structural validation as proof of visual layout;
- publishing batch or generic `operation_*` tools with this palier.

## Stop rule

Do not release if a supported operation changes an unknown value, if malformed
or dangling graph state can reach CAS, if Canvas requires the Markdown write
gate, or if the live pilot cannot restore the disposable fixture to its exact
initial SHA-256.
