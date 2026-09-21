# Cycle M2–M6 — scope and closure decisions

This is a preparation checkpoint, not a release announcement. M2–M5 are candidates awaiting ordered local qualification and promotion. Their intended final disposition is `delivered`, but that disposition must not be activated before the local gate. Branches, PRs and known source checkpoints are recorded in `cycle.json`; read their current heads before acting.

## In scope for final delivery

M1 reconnect: operator-reported deployed and validated outside this GitHub contribution. Preserve that installed fix and reconcile its exact source/artifact before changing any installation. Its local deployment is not proof that main or the candidate bundle contains it. Do not reopen its architecture; prevent regression.

M2: bounded read-only note neighborhood through native MetadataCache; no filesystem graph emulation or global-preservation promise.

M3: one native Markdown move, explicit update-links preference, sealed source/destination/neighborhood, durable ownership and separate graph postflight. No global transaction, blind replay or synthetic recovery.

M4: one absent-only exact Markdown creation, durable idempotency/status and qualified timestamp settlement. No overwrite, auto suffix, duplicate, caller-authored protected keys or claimed authorship after observational reconciliation.

M5 / historical P7: one existing Markdown Base row, top-level property set/delete, sealed Base/view/path selection and shared note CAS. Not independent records, insert, file deletion or distributed atomicity. This deliberately avoids treating a row removal as permission to delete its note.

M6: coherence, packaging, source checks, cleanup and a single final Codex session. No new product feature. Move to maintenance/maturation only after actual final gates.

## Deferred with an explicit trigger

- Asset workflow — `deferred-trigger`. First demonstrate repeated publication demand for local image → optimized WebP → vault → R2/publication → insertion, with measured manual steps. Prefer a separate asset pipeline; add an MCP capability only when the missing operation cannot safely live there.
- Generic multi-target batch — `deferred-trigger`. Measure a recurring multi-note workflow, its frequency and current operator cost. Require per-child durable receipts, sealed selection and honest partial outcomes; no global rollback promise.
- Semantic scalability — `deferred-trigger`. Collect vault/document counts, RAM peak, indexing duration and query p50/p95 on representative data. Reopen only against an explicit workload/SLO regression, not theoretical future scale.
- Base row insert/upsert-as-create — `deferred-trigger`. Show a concrete creation workflow that cannot use M4 plus an observed Base membership check. Row/file identity and post-create membership must remain explicit.
- General governed delete, folder/Canvas move and public external mutations — `deferred-trigger`. Require a new approved use case, a safe native/handle-relative capability, recovery semantics and destructive canaries. Existing disabled external-move diagnostics are not a new mutation promise.

## Abandoned for this cycle

New MCP profile, generic `operation_*` public facade and a second durable journal/runtime — `abandoned` for this cycle. Existing profiles and specialized lifecycles suffice; a future proposal needs a new measured constraint, not a cleanup preference.

The ChatGPT → Secure → Optimike Full → ÉLYSIA architecture, with CoS only as a conditional fallback, is not reopened by this cycle. Live ÉLYSIA notes and installed runtime state were not modified by these repository-only preparations.

## Promotion record

`cycle.json` is an immutable preparation snapshot: its localGate and finalGate fields record NOT_RUN here, not live production state. Do not edit them merely to make a gate green. Record actual local results, admitted SHAs, installed artifact hashes and final tag/release alignment in the PR/release evidence after execution. This avoids a self-referential final-SHA edit. Never turn a planned disposition or a mocked positive test into an executed local PASS.
