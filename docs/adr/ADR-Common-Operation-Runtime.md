# ADR: Common governed operation runtime

## Status

Accepted and implemented for the atomic Markdown note-replacement adapter. The
external-move adapter remains diagnostic-only while external mutation is
fail-closed; it does not add a generic public write tool or widen any write
permission.

## Context

Operon already provides sealed mutation plans, durable receipts, idempotent
replay, postflight verification, and same-plan recovery. The MCP's
`external_move` path independently provides immutable inventory, CAS
preconditions and a SQLite WAL journal as diagnostic evidence. Its former
compensation path is disabled with external mutation. Other Obsidian writes do
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

Adapter-specific settlement equivalence may refine an after proof, but it must
never weaken the admission or pre-effect CAS. Such a policy must be sealed in
the durable plan, bounded to the real execution attempt, prove the observed
resource byte-identical after restoring only explicitly authorized drift, and
record the actual observed revision. Settlement evidence is valid only for the
same sealed backend identity and logical target. The common runtime never
ignores a field globally. Future adapters must provide their own discriminating
validator and negative concurrent-drift fixtures.

Domain tools remain the public MCP surface for now. A future generic operation
surface may be added only after at least two adapters demonstrate the same
semantics without weakening their domain contracts.

## First adapter: external move

`ExternalMoveOperationAdapter` reuses the existing `external_move` coordinator
and journal as the sole durable diagnostic authority. It maps the existing plan
ID to an opaque versioned plan reference and binds the plan digest to source CAS,
complete reference inventory, backend/vault/root identity, target, and repair
set. Apply and recovery report unavailable until an audited native
handle-relative primitive exists.

The disposable fixture covers:

- planning and stable status replay;
- source drift and ambiguous references rejected before any mutation;
- stable diagnostic receipt replay across status;
- apply and recovery unavailable without opening a backend session or mutating
  filesystem/note state;
- preserved journal/binding/session evidence for a future audited primitive.

## Second adapter: atomic note replacement

`ObsidianNoteReplaceOperationAdapter` uses the bundled Atomic Write Bridge as
its only effect surface. The bridge binds every CAS request and response to a
hashed device/install/vault-root fingerprint and executes SHA-256 compare-and-replace through Obsidian
`Vault.process`, so the precondition and replacement occur in one atomic
read-modify-write operation. Its write gate is disabled by default and remains
independent from Operon's Developer API grant.

The adapter stores the sealed next content in a private SQLite WAL journal so
the exact plan can be recovered after a lost response. Terminal rows expire
after 30 days and their sealed content is redacted as soon as a stable terminal
state is recorded; non-terminal and `outcome_unknown` rows are retained for
recovery. The disposable fixture covers conflict without write, committed
replay, backend-binding rejection, concurrent status reconciliation, idempotency-key binding,
lost-response reconciliation, active-daemon retention, and exact-plan recovery
after a request failure.

## Public 2.6 projection: governed note replacement

The existing `ObsidianNoteReplaceOperationAdapter`, Atomic Write backend, and
private journal are owned by one application-lifecycle runtime. The runtime is
constructed once with the shared REST service, injected into the stdio server
and every per-session HTTP MCP server, and closed explicitly during process
shutdown. No session creates a competing journal or REST client. Applying rows
carry a runtime-instance owner backed by a durable heartbeat lease, so another
MCP process sharing the journal cannot mistake PID reuse for the original live
executor; an expired or explicitly closed owner remains recoverable through the
exact plan.
Transitions leaving `applying` are fenced by both the observed runtime-instance
owner, a fresh per-attempt identifier, and the exact durable payload version. A
stale executor returning after lease expiry cannot terminalize a plan that
recovery reassigned, even when the same runtime instance performs both attempts.
The default journal path is also namespaced by a stable non-secret digest of
the configured runtime mode, REST base URL, and vault path, with an explicit
profile-ID override for deployment topologies that need one. Backend-specific
plans and idempotency keys do not share an implicit machine-global namespace.

SQLite contention is part of the reusable operation contract, not an adapter
detail. Every connection that negotiates WAL must install its busy policy
immediately after opening and before WAL, schema creation, migrations, leases,
or journal writes. The note journal retries idempotent startup initialization
through bounded transient contention, closes the connection if that bound is
exhausted, and never lets a later heartbeat timeout escape the runtime timer.
Fixtures prove simultaneous fresh opens, an existing journal locked longer than
one busy timeout, a clean failed-startup close, and reuse of an already-active
connection after contention. Future SQLite-backed adapters inherit this order
and must add the same discriminating proofs.

Idempotent admission is also a concurrent contract. If multiple runtimes act on
the same sealed plan, exactly one conditional state transition may win. A
caller that loses because it observed stale durable state must reload and
return the winning receipt; expected transition contention must never escape as
an internal tool error or authorize a second effect. Future adapters must prove
both the ordinary in-flight replay and the stale-read transition race.

Recovery also preserves epistemic state across attempts. Once an earlier
attempt is uncertain, a later CAS conflict can become terminal only when the
follow-up proof identifies a sealed state. If the same backend instead reports
a hash matching neither the sealed before nor after proof, the receipt remains
`outcome_unknown`: an expired executor may have committed before a third-party
edit. A conflict response from the recovery attempt proves only that attempt
did not write; it does not disprove an earlier commit of the same plan.

Modified-time frontmatter plugins exercise this distinction. The note adapter
seals the exact property reported by a supported enabled Obsidian integration,
but only when MCP policy already protects that property. CAS remains exact.
Any adapter-specific observation delay starts at the durable post-dispatch
effect boundary, never at the beginning of preflight. Until its longest sealed
delay expires, observers must accept neither the original after proof nor an
early partial settlement proof. If a response is lost before that boundary can
be stored, explicit recovery starts a fresh conservative observation window.
Postflight or reconciliation may accept one monotonic canonical timestamp in
the durable five-minute apply window only when replacing that single line makes
the observed note byte-identical to the sealed after content and the read still
comes from the sealed backend and target. The committed receipt then proves the
actual settled hash and retains the sealed target hash. Every other drift
remains `outcome_unknown`.

The public projection remains domain-specific:

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

Planning compares protected frontmatter and validates the future Markdown from
the same Bridge read that seals the before SHA-256. Apply and recover revalidate
the current MCP write policy before any possible effect. Recovery uses
exact-plan reconciliation/resumption and is never undo. The guaranteed effect boundary is
the one target-note transition enforced by `Vault.process` CAS. Sync, watchers,
plugins, indexers, and external automations remain outside that boundary.

No generic public `operation_*` surface is introduced. The real Obsidian
Desktop operator canary passed on 2026-08-14 with exact fixture restoration;
P0 and P1 shipped in v2.7.0.

## P2 decision: second backend through governed Base formulas

The next adapter is not another projection over Atomic Note Write. It uses
Bases Bridge Atomic V1 as a second typed backend and reuses the proven durable
lease, fencing, idempotency, reconciliation, retention, and exact-plan recovery
implementation through a bounded atomic-resource profile. The public intent is
limited to set/delete of named top-level formulas. The compiler preserves all
source bytes outside authorized formula ranges and refuses ambiguous YAML.

This second backend justifies the internal profile seam; it does not justify a
generic public operation API. Backend binding, target/proof vocabulary and
plan references remain domain-specific. Whole-file legacy Base configuration
writes are disabled by default at the Bridge and require an explicit temporary
compatibility toggle, preventing the old MCP route from becoming a silent
bypass.

## Explicit exclusions

- Operon keeps its official Developer API plan and recovery contract; this
  runtime does not wrap or replace it.
- Frontmatter, Base formulas and Canvas graph patches are upgraded only through
  their bounded public projections. Other Base sections remain outside the
  guarantee; Canvas nodes, edges and viewport changes are covered only when
  admitted by the governed Canvas validator and Atomic Write CAS.
- A receipt is evidence of the adapter's checks, not evidence of business
  correctness outside its domain validator.

## Consequences

The MCP now has two tested non-Operon adapters using one shared operation
vocabulary. Each domain journal remains its sole durable authority; the common
runtime does not introduce a competing generic journal. Future adapters can
reuse the contract, but admission remains fail-closed whenever the backend
cannot prove CAS, durable status, or postflight. A generic public operation
surface remains deliberately deferred until the live Obsidian pilot confirms
the second adapter outside the disposable fixture.
