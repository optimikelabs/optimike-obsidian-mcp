# ADR: Common governed operation runtime

## Status

Accepted for internal adapter pilots. The first implementation binds the existing
`external_move` transaction to this contract; it does not add a generic public
write tool or widen any write permission.

## Context

Operon already provides sealed mutation plans, durable receipts, idempotent
replay, postflight verification, and same-plan recovery. The MCP's
`external_move` path independently provides immutable inventory, CAS
preconditions, a SQLite WAL journal, and compensation. Other Obsidian writes do
not all share those guarantees, especially when Local REST cannot atomically
enforce `If-Match`.

Keeping a separate transaction vocabulary for every writer makes uncertain
outcomes harder to reconcile and encourages callers to retry the original
mutation. A common control-plane contract is needed without replacing domain
validation or pretending that every backend has the same atomicity.

## Decision

Governed non-Operon writes may implement the internal `OperationAdapter`
contract with four transitions:

1. `plan` admits a canonical request, assigns a server `operationId`, binds the
   caller's `idempotencyKey`, and returns an opaque `planRef` plus a stable
   `planDigest`.
2. `apply` accepts only that sealed `planRef` and the matching idempotency key.
   The adapter must durably record the applying state before its first effect
   and revalidate all backend-specific preconditions.
3. `status` reads durable state and evidence without executing an effect.
4. `recover` reconciles or compensates the exact same plan. It never accepts a
   replacement mutation specification.

The common state model separates progress from result:

- `phase`: `planned | applying | terminal`;
- `outcome`: `committed | conflict | rejected | failed | outcome_unknown |
compensated | expired`, or `null` before a terminal result is known.

Every receipt carries the contract version, operation and idempotency
identities, operation kind, sealed plan identity, logical backend and target,
before proof, optional after proof, postflight state, timestamps, and an exact
recovery reference when recovery is allowed.

## Identifier rules

- `idempotencyKey` belongs to the caller and binds one canonical request.
- `operationId` belongs to the server and identifies the durable operation.
- `planRef` is an opaque adapter-bound handle; callers must not parse or rebuild
  it.
- `planDigest` is a stable digest of immutable admitted inputs and proofs. It is
  not an authorization token.
- `recoveryRef` points to the same plan. Recovery never creates a new plan.

## Adapter requirements

An adapter must:

- validate its backend result at runtime before projecting a common receipt;
- preserve the backend's stricter capability, write-mode, consent, and CAS
  gates;
- persist intent and intermediate state before effects;
- make `status` read-only and replay-safe;
- return `outcome_unknown` rather than invite blind retry when final state
  cannot be proven;
- expose only the evidence the backend can actually prove.

Domain tools remain the public MCP surface for now. A future generic operation
surface may be added only after at least two adapters demonstrate the same
semantics without weakening their domain contracts.

## First adapter

`ExternalMoveOperationAdapter` reuses the existing `external_move` coordinator
and journal as the sole durable authority. It maps the existing plan ID to an
opaque versioned plan reference, binds the plan digest to source CAS, complete
reference inventory, backend/vault/root identity, target, and repair set, and
maps rollback to exact-plan recovery/compensation.

The disposable fixture covers:

- planning and stable status replay;
- source drift rejected before any move;
- commit and idempotent apply replay;
- completed apply with a lost caller response reconciled through `status`;
- an interrupted move recovered from the persisted intermediate state;
- verified compensation back to the original file placement.

## Explicit exclusions

- Operon keeps its official Developer API plan and recovery contract; this
  runtime does not wrap or replace it.
- Local REST note, frontmatter, Bases, and Canvas writes are not upgraded by
  declaration. They need an atomic expected-hash write surface before claiming
  the same guarantee.
- A receipt is evidence of the adapter's checks, not evidence of business
  correctness outside its domain validator.

## Consequences

The MCP gains one shared operation vocabulary and a tested non-Operon adapter
without creating a second journal. Future adapters can reuse the contract, but
admission remains fail-closed whenever the backend cannot prove CAS, durable
status, or postflight. Public tool expansion is deliberately deferred.
