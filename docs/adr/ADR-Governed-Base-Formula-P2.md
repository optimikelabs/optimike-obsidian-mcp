# ADR: P2 governed Base formula operation

## Status

Accepted and implemented as the `2.8.0` release candidate. Compiler, typed
Bridge CAS, durable runtime, stdio MCP, documentation and pilot-vault canary
gates pass. Merge, exact-head external review, post-merge CI and publication
remain repository-authority decisions.

## Authority and fixture

P2 starts from released `v2.7.0`. The canonical product workflow is the
`PROJETS.base` project cockpit. Tests use its exact bytes only as a copied
fixture at `Canary/PROJETS-P2.base` in the dedicated Operon Bridge pilot vault.
The canonical ÉLYSIA file is never mutated by the canary.

## Decision

P2 is the first public mutation on a second typed backend:

```text
named formula intent
  -> Bases Bridge Atomic V1 read
  -> source-preserving formula compiler
  -> durable sealed atomic-resource plan
  -> Bases Bridge Vault.process CAS
  -> durable status / exact-plan recovery
```

The public surface remains domain-specific:

- `bases_formula_patch_plan`
- `bases_formula_patch_apply`
- `bases_formula_patch_status`
- `bases_formula_patch_recover`

The existing lease, per-attempt fence, SQLite contention policy, idempotent
admission, uncertain-outcome reconciliation, retention and recovery code is
reused through an internal resource profile. P2 does not copy the state
machine and does not expose generic public `operation_*` tools.

## V1 intent and proof

One request targets one existing `.base` and performs at most 32 unique named
operations:

- `set_formula(name, expression)`;
- `delete_formula(name)`.

The compiler accepts one block-style top-level formulas mapping. It preserves
line endings, including the absence of a final line ending, and every byte
outside authorized formula ranges. It preserves the exact spelling of
existing keys and orders new operations by code units.
It fails closed on ambiguous layout, mixed line endings, anchors, aliases,
tags, merge keys, duplicate/case-colliding names and deletion of the final
formula. Extension refusal is based on parsed YAML nodes, so indicator text in
quoted scalars, block scalars and comments is not mistaken for syntax.
Multiline non-block formula scalars fail closed because their physical entry
boundaries are not part of V1. The compiler never round-trips the complete YAML
through a serializer.

The receipt proves raw before/after hashes, backend binding, intent digest,
authorized ranges and the untouched-source digest. It does not certify Base UI
rendering, semantic formula correctness, index freshness or plugin side
effects.

## Backend and migration

Bases Bridge 1.1.0 exposes status, read and CAS routes for existing `.base`
files. The backend identity hashes device, plugin installation and vault root.
CAS requires that binding plus the exact before SHA-256 and executes through
Obsidian `Vault.process`.

Atomic Base writes and legacy whole-file config writes have separate default-
off settings. Governed P2 refuses to operate while the legacy compatibility
switch is enabled. `PUT /bases/:id/config` and `POST /bases` validation remains
available, but their effects fail closed unless an operator explicitly enables
the compatibility path. Note-property upsert remains a separate frontmatter
domain.

## Failure matrix

| Failure                                              | Required result                                     |
| ---------------------------------------------------- | --------------------------------------------------- |
| Base changes after plan                              | CAS conflict, no P2 write                           |
| Backend/vault binding changes                        | Conflict/rejection, no write                        |
| Response lost after CAS                              | Status reconciles sealed after hash                 |
| Executor lease expires                               | Only the new fenced attempt may terminalize         |
| Current hash matches neither sealed hash             | `outcome_unknown`, never invented conflict/commit   |
| Duplicate public idempotency key with another intent | Conflict                                            |
| Ambiguous YAML or unsupported source                 | Planning fails before journal/effect                |
| Sealed next YAML exceeds the guarded content limit   | Plan replay, apply and recover fail before effect   |
| Legacy compatibility enabled                         | Governed plan/apply fails closed                    |
| Canary interruption                                  | Private backup retained until exact SHA restoration |

## Live evidence

On 2026-08-14, Bases Bridge 1.1.0 and MCP 2.8.0 ran in the dedicated Operon
Bridge pilot vault. The canary proved no-write planning, atomic apply, durable
status, idempotent replay, add/delete exact source restoration, stale-plan
conflict and final equality with the original `PROJETS.base` SHA-256. The
private recovery directory was deleted only after restoration verification;
the redacted evidence record remains in the OS temporary directory.

## Exclusions

- no arbitrary YAML path or whole-file public mutation;
- no view, filter, property-order or column-size operation in V1;
- no Base creation under the governed formula contract;
- no Canvas or batch transaction;
- no public generic operation API.
