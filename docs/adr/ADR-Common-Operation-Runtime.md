# ADR: Common governed operation runtime

## Status

Accepted and implemented. The internal contract is shared by the existing
`external_move` transaction and atomic Markdown note replacement. The latter is
projected through four domain-specific MCP tools; no generic public
`operation_*` surface is introduced and no write permission is widened.

## Context

Operon already provides sealed mutation plans, durable receipts, idempotent
replay, postflight verification, and same-plan recovery. The MCP's
`external_move` path independently provides immutable inventory, CAS
preconditions, a SQLite WAL journal, and compensation. Other Obsidian writers
do not automatically share those guarantees.

A common internal control-plane vocabulary reduces blind retries after uncertain
outcomes without replacing domain validators or pretending that every backend
has the same atomicity.

## Decision

Governed non-Operon writes may implement four transitions:

1. `plan` admits one canonical request, assigns a server `operationId`, binds a
   caller-owned `idempotencyKey`, and returns an opaque `planRef` with a stable
   `planDigest`.
2. `apply` accepts only that sealed plan and matching idempotency key. Intent and
   applying state must be durable before the first effect.
3. `status` reads and reconciles durable authority without executing a new
   mutation.
4. `recover` reconciles, safely resumes, or performs domain-defined
   compensation for the exact same plan. It is not undo and accepts no
   replacement mutation specification.

The shared receipt separates progress (`planned | applying | terminal`) from
result (`committed`, `conflict`, `rejected`, `failed`, `outcome_unknown`,
`compensated`, or `expired`). It carries operation and idempotency identities,
backend and logical target, sealed plan identity, before/after proofs,
postflight state, timestamps, and a recovery reference only when allowed.

`planRef` is opaque and `planDigest` is evidence, not an authorization token.
Recovery never creates a new plan.

## Adapter requirements

An adapter must:

- validate backend results before projecting a common receipt;
- preserve stricter capability, write-mode, consent, and CAS gates;
- persist intent and intermediate state before effects;
- keep status read-only and replay-safe;
- return `outcome_unknown` rather than invite blind retry;
- expose only evidence the backend can prove.

Domain tools remain the public MCP surface. A future generic operation API
requires repeated live evidence across domains and a concrete cross-domain
client use case; internal similarity alone is insufficient.

## External move adapter

`ExternalMoveOperationAdapter` reuses the existing move coordinator and journal
as its sole durable authority. It binds source CAS, complete reference
inventory, backend/vault/root identity, target, and repair set. Its disposable
fixtures prove plan/status replay, source drift refusal, commit replay, lost
response reconciliation, interrupted recovery, and verified compensation.

## Atomic note adapter and public projection

`ObsidianNoteReplaceOperationAdapter` uses the bundled Atomic Write Bridge as
its only effect surface. The Bridge binds every request and response to one
backend fingerprint and executes SHA-256 compare-and-replace through Obsidian
`Vault.process`.

Its private SQLite WAL journal retains sealed next content only while exact-plan
recovery may need it. Stable terminal rows redact that content and expire under
the existing retention policy.

The public projection is deliberately domain-specific:

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

One application-lifecycle runtime owns the existing adapter, shared REST
backend, and single journal across stdio and every per-session HTTP MCP
server. It is constructed once at process startup, injected into each server
instance, and closed explicitly during shutdown. Planning and every possible
effect revalidate the current MCP write policy. The same Bridge read supplies
the current Markdown used for protected-frontmatter comparison and the SHA-256
sealed as the before proof.

Recovery is exact-plan reconciliation/resumption, never restoration of the
previous note. The guaranteed effect boundary is the one target-note transition
enforced by `Vault.process` CAS. Sync, watchers, plugins, indexers, and external
automations are outside that boundary and are not claimed reversible.

The public contract is owned by the
[Tool Surface](../obsidian_mcp_tools_spec.md#governed-atomic-note-replacement).

The public projection remains a release candidate until the live Obsidian
Desktop canary passes. CI and deterministic MCP fixtures do not substitute
for that operator-owned gate.

## Explicit exclusions

- Operon keeps its official Developer API plan and recovery contract.
- Frontmatter, Bases, and Canvas writers are not upgraded by declaration.
- A receipt proves adapter checks, not business correctness outside its domain.
- No generic public operation surface is part of the 2.6 candidate.

## Consequences

Each domain journal remains its sole durable authority. Future adapters may
reuse the internal vocabulary only when their backend can prove its own CAS,
durable status, postflight, and recovery semantics. The first public projection
therefore remains narrow, explicit, and independently governable.
