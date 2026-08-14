# ADR: P1 governed frontmatter projection

## Status

Candidate implemented — the pure model, compiler, multi-process identity,
stdio/HTTP MCP, runtime, Operon, documentation, package, and production-audit
gates pass. Live admission remains blocked until the disposable Obsidian canary
passes and the exact reviewed head is green.

## Authority

P1 starts from `main` at the released `v2.6.0` authority. The public P0 note
replacement runtime, its single SQLite journal, Atomic Write Bridge CAS,
leases, attempt fencing, receipts, status, and exact-plan recovery remain the
only mutation engine.

The older `feat/2.6-p1-governed-frontmatter` branch is non-authoritative. It may
supply test ideas or source-preserving parsing techniques only after they are
revalidated against released P0.

## Decision

P1 is a domain compiler and public projection over P0:

```text
frontmatter intent
  -> read one live Markdown note through P0's backend authority
  -> compile a source-preserving top-level YAML patch
  -> prove the authorized change set
  -> admit the complete next Markdown through the existing P0 plan
  -> apply/status/recover through the existing P0 state machine and journal
```

P1 adds no second journal, state machine, executor lease, fencing protocol, or
recovery engine.

The public surface is domain-specific:

- `obsidian_frontmatter_patch_plan`
- `obsidian_frontmatter_patch_apply`
- `obsidian_frontmatter_patch_status`
- `obsidian_frontmatter_patch_recover`

These tools project the same child operation UUID under an opaque P1 plan
reference. They do not call MCP tools recursively. Their implementation invokes
internal P0 runtime primitives and projects P0 receipts as
`obsidian.frontmatter.patch`.

Four tools are preferred over mixing a frontmatter planner with note-replacement
apply/status/recover because the domain contract, idempotency identity,
projection proof, least-privilege capability, and operational guidance must
remain coherent for callers. The lifecycle remains one P0 lifecycle internally.

## V1 intent

One request targets one existing Markdown note with an existing standard
frontmatter block and one or more unique top-level operations:

- `set`: add or replace one top-level bare key with a JSON-compatible value;
- `delete`: remove one unambiguous existing top-level bare key.

The P1 intent and patch-proof digests use a total code-unit ordering
recursively. They are independent of host locale/ICU collation and do not alter
the legacy P0 digest helper or any direct P0 digest.

Public idempotency keys admit only well-formed Unicode, preventing distinct JSON
strings from collapsing through UTF-8 replacement. A valid but unknown or
retention-expired plan reference is terminally absent and returns `NOT_FOUND`.

The compiler fails closed on unsupported or ambiguous source, including:

- duplicate or case-colliding keys;
- anchors, aliases, merge keys, explicit YAML tags, or multi-document syntax;
- quoted/complex keys or unsupported top-level continuations;
- targeted entries containing direct or nested YAML block scalars or multiline
  quoted scalars;
- ambiguous neighboring-comment ownership for deletion or trailing-comment
  ownership for insertion;
- an absent or unclosed frontmatter block;
- non-finite numbers, excessive operation count, or oversized values.

## Authorized mutation invariant

For every successful compilation:

```text
actualDiff(before, after) is a subset of authorizedChangeSet(intent)
```

The following remain byte-identical when not targeted:

- Markdown body;
- line-ending convention;
- comments;
- order, spelling, quoting, indentation, and representation of other keys;
- every source segment outside the compiled edit ranges.

A semantic YAML parser may validate before and after documents. It is never used
to regenerate the complete frontmatter.

The compiler returns a non-secret proof containing at least:

- contract version and compiler version;
- intent digest;
- changed keys and operations;
- authorized before ranges and before/after entry digests;
- body SHA-256;
- before/after frontmatter SHA-256;
- digest of untouched source segments;
- preserved line-ending convention.

A grouped insertion is represented by one fixed, bounded range marker. Its key
names remain in `changedKeys`; they are never concatenated into an unbounded
range label.

The proof and public idempotency binding are stored as optional projection
metadata in the existing P0 plan row. Status and recovery therefore reproduce
the same P1 receipt after restart without another durable authority.

## Actors and authority

### Caller

Supplies one public idempotency key and one canonical frontmatter intent. The
caller owns neither executor authority nor a right to rebuild a plan reference.

### Compiler

Reads one live P0 backend snapshot and creates a deterministic candidate plus
proof. It has no effect authority and creates no durable plan by itself.

### P0 planner

Is the only actor allowed to admit durable intent. It re-reads the target and
requires the exact source SHA-256 and backend binding used by the compiler. A
mismatch creates no plan.

### Executor

Is the existing P0 executor holding the current durable attempt fence. P1 adds
no executor identity.

### Reconciler

Is the existing P0 reconciliation protocol. It may conclude `committed` only
from the sealed after proof. It does not borrow the caller's or an old
executor's authority.

### Observer

A caller of P1 status. It can trigger P0 reconciliation but never becomes an
executor.

## Durable identities

P1 has two distinct identities:

- public idempotency key: caller-facing and returned in projected receipts;
- internal P0 idempotency key: domain-prefixed digest of the public key.

A separate `idempotencyIdentity` binds the canonical P1 intent digest, not the
source snapshot or compiled after bytes.

Consequences:

- same public key + same canonical intent returns the first durable winner even
  if a later replay observes a changed source;
- same public key + different intent is rejected;
- two concurrent planners compiling the same intent from different source
  snapshots cannot create two operations;
- the losing planner projects the durable winner and its stored proof;
- direct P0 note-replacement idempotency remains unchanged.

The sealed P0 request digest still includes target, backend binding, before and
after SHA-256. `idempotencyIdentity` does not weaken the effect precondition.

## Linearization points

| Operation             | Linearization point                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P1 plan               | Atomic insertion or durable same-key winner read in the P0 journal after exact source SHA and binding revalidation |
| P1 apply              | Existing P0 `planned -> applying` conditional transition with a fresh attempt fence                                |
| Physical effect       | Existing Atomic Write Bridge `Vault.process` SHA-256 CAS                                                           |
| Terminal commit       | Existing fenced P0 terminal transition after sealed-after postflight                                               |
| Status reconciliation | Existing P0 conditional transition based on live backend proof                                                     |
| Recovery              | Existing P0 `outcome_unknown -> applying` claim with a new attempt fence                                           |

## State projection

P1 exposes the P0 phase/outcome unchanged:

- `planned`;
- `applying`;
- terminal `committed`, `conflict`, `rejected`, `failed`, or
  `outcome_unknown` according to P0 semantics.

P1 does not introduce `partial` or `compensated`.

Pre-admission compiler failures are MCP errors with no durable operation. A
network exception after an effect is never classified as `failed` without
proof. P0 remains conservative and uses `outcome_unknown` when the effect cannot
be determined.

## Failure matrix

| ID     | Interleaving or failure                                                              | Durable proof                                              | Expected authority/result                                                                         |
| ------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| P1-M01 | Source A read and compiled; source becomes B before admission                        | Re-read SHA differs from compiler SHA                      | Planner rejects; no row and no effect                                                             |
| P1-M02 | Backend binding changes between compiler read and admission                          | Re-read binding differs                                    | Planner rejects; no row and no effect                                                             |
| P1-M03 | Two plans, same public key and same intent, same source                              | Unique internal key + same intent identity                 | One durable operation; both return winner                                                         |
| P1-M04 | Two plans, same public key and same intent, different sources                        | Unique internal key + same intent identity                 | One durable winner; loser returns winner proof, never a second plan                               |
| P1-M05 | Same public key, different canonical intent                                          | Different intent identity                                  | Conflict; original plan unchanged                                                                 |
| P1-M06 | Compiler changes a non-target byte                                                   | Source-range proof fails                                   | Compilation rejected before P0 plan                                                               |
| P1-M07 | Target contains protected key                                                        | Current write policy + P0 protected-frontmatter comparison | Rejected before effect                                                                            |
| P1-M08 | Policy becomes readonly after planning                                               | Current policy at P0 apply/recover                         | Effect refused; plan remains safely replayable                                                    |
| P1-M09 | Two applies or two recoveries                                                        | P0 fenced claim and CAS                                    | Exactly one backend effect; projected receipts converge                                           |
| P1-M10 | Status during apply                                                                  | P0 durable phase and live proof                            | Observer cannot steal authority; may only reconcile sealed after                                  |
| P1-M11 | Lease expires during backend call; recovery claims new attempt; old response returns | P0 attempt fence and current row payload                   | Old executor cannot terminalize; reconciliation decides from physical proof                       |
| P1-M12 | Response lost after effect                                                           | Sealed after SHA on live target                            | P1 status/recover projects `committed`; no second effect                                          |
| P1-M13 | Effect may have occurred; target is neither sealed before nor after                  | Insufficient proof                                         | `outcome_unknown`, never false conflict/failed                                                    |
| P1-M14 | SQLite contention exceeds busy timeout                                               | No durable admission/transition proof                      | Structured retryable error or conservative existing receipt; no INTERNAL_ERROR that invents state |
| P1-M15 | Cache available while live backend is unavailable                                    | Cache is non-authoritative                                 | Fail closed; cache cannot admit, commit, or recover                                               |
| P1-M16 | Canary interrupted after first mutation                                              | Durable backup + P0 journal/receipt                        | Recovery path remains explicit; no success claim without verified restoration                     |

P1-M09 through P1-M15 inherit the released P0 concurrency suite and must also
be exercised through the projected P1 MCP surface where the projection can
change behavior.

## Executable model gate

Before production code, a pure model must demonstrate:

- executor, reconciler, and observer separation;
- terminal monotonicity;
- stale-attempt fencing after reassignment;
- delayed old response cannot terminalize a new attempt;
- sealed-after proof may reconcile `committed`;
- absence of proof remains `outcome_unknown`;
- P1 same-key/same-intent winner semantics;
- source and backend drift prevent admission;
- same-key/different-intent conflict.

The model uses explicit event schedules and barriers, not timing assumptions.
Real time is used only for lease-expiry tests inherited from P0.

## Public receipt

A P1 receipt preserves P0 operation ID, phase, outcome, backend, before/after
proofs, postflight, timestamps, and recovery/apply permissions. It replaces:

- operation kind with `obsidian.frontmatter.patch`;
- target kind with `vault-markdown-frontmatter`;
- plan and recovery references with the P1 opaque prefix;
- internal idempotency key with the public key;
- plan digest with a stable digest over the child P0 plan digest, intent digest,
  and stored projection proof.

It adds a bounded `projection` object and never exposes next content, physical
journal path, raw untouched bytes, or secret values.

## Canary

The live canary must target one explicit disposable Markdown note, persist an
initial backup before mutation, exercise add/set/delete through the public P1
surface, prove body and non-target bytes unchanged, prove stale-source conflict,
replay/status, and restore the exact initial SHA-256.

No live PASS is claimed without a real Obsidian Desktop and Atomic Write Bridge.

## Stop rule

If any supported P1 operation can change a byte outside its authorized source
ranges, or if the projection cannot inherit P0 authority without a second
journal/state machine, P1 does not ship.
