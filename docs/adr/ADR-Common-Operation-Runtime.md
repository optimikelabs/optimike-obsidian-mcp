# ADR: Common governed operation runtime

## Status

Accepted and implemented. The internal contract remains shared by the existing
`external_move` transaction and atomic Markdown note replacement. The latter is
now exposed through four domain-specific MCP tools; no generic public
`operation_*` surface is added and no write permission is widened.

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
4. `recover` reconciles, safely resumes, or performs the domain-defined
   compensation for the exact same plan. It is not undo and never accepts a
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

Domain tools remain the public MCP surface. A future generic operation surface
requires both repeated live evidence across domains and a concrete cross-domain
client use case; shared internal vocabulary alone is not sufficient.

## First adapter: external move

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

## Second adapter: atomic note replacement

`ObsidianNoteReplaceOperationAdapter` uses the bundled Atomic Write Bridge as
its only effect surface. The bridge binds every CAS request and response to a
hashed device/install/vault-root fingerprint and executes SHA-256
compare-and-replace through Obsidian `Vault.process`, so the precondition and
replacement occur in one atomic read-modify-write operation. Its write gate is
disabled by default and remains independent from Operon's Developer API grant.

The adapter stores the sealed next content in a private SQLite WAL journal so
the exact plan can be recovered after a lost response. Terminal rows expire
after 30 days and their sealed content is redacted as soon as a stable terminal
state is recorded; non-terminal and `outcome_unknown` rows are retained for
recovery. The disposable fixture covers conflict without write, committed
replay, backend-binding rejection, concurrent status reconciliation,
idempotency-key binding, lost-response reconciliation, active-daemon
retention, and exact-plan recovery after a request failure.

## Public atomic-note projection

The public projection is deliberately domain-specific:

- `obsidian_note_replace_plan`;
- `obsidian_note_replace_apply`;
- `obsidian_note_replace_status`;
- `obsidian_note_replace_recover`.

One process-shared runtime owns the existing adapter and its single private
journal across stdio and per-session HTTP MCP servers. Planning and every
possible effect revalidate the current MCP write policy. The planning read that
seals the before hash also supplies the current Markdown used for structured
protected-frontmatter comparison, avoiding a second authority for admission.

Recovery is exact-plan reconciliation/resumption, never a request to restore
the previous note. The guaranteed effect boundary is the one target-note
transition enforced by `Vault.process` CAS. Notifications or downstream work
performed by sync, watchers, plugins, indexers, or external automations are
outside that boundary and are not claimed reversible.

The complete domain contract and validation boundary are documented in
[Governed atomic note replacement](../governed-note-replacement.md).

## Explicit exclusions

- Operon keeps its official Developer API plan and recovery contract; this
  runtime does not wrap or replace it.
- Frontmatter, Bases, and Canvas writes are not upgraded by declaration. The
  public surface proves only complete Markdown note replacement through the
  dedicated atomic bridge.
- A receipt is evidence of the adapter's checks, not evidence of business
  correctness outside its domain validator.

## Consequences

The MCP has two tested non-Operon adapters using one shared operation
vocabulary. Each domain journal remains its sole durable authority; the common
runtime does not introduce a competing generic journal. Future adapters can
reuse the contract, but admission remains fail-closed whenever the backend
cannot prove CAS, durable status, or postflight. A generic public operation
surface remains deliberately deferred; even after the live Obsidian canary, it
requires a real cross-domain client need rather than only adapter similarity.
