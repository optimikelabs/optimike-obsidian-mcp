# M5 / historical P7 — governed single-row Base property patch

## Row model and scope

A row returned by this repository's Bases Bridge identifies a vault file (`file.path`, `file.name`, property values). The existing `bases_upsert_rows` edits frontmatter of existing notes; it does not insert independent records. Its expected-mtime check and partial batch responses are not durable content CAS.

The new V1 selects **one existing Markdown note** from an explicit Base/view and patches raw top-level frontmatter keys with `set` or `delete`. A delete operation deletes a property, never a row or file. Insert, upsert-as-create, note deletion and multi-target batches are outside this V1. Use the distinct durable note creation surface for new notes; do not infer Base membership from successful creation.

## Surface and permissions

`bases_rows_patch_plan`, `bases_rows_patch_apply`, `bases_rows_patch_status` form one complete lifecycle in live/hybrid-live `authoring` and `full`. No new profile or generic operation API is introduced. The shared note write policy and Atomic Write Bridge write grant govern mutation. Base read capability is required, but the Base configuration write toggle is not: no Base file is edited.

The existing direct batch tool remains distinct; single-row governance does not pretend to replace all of its batch functionality. Do not use a direct write to bypass a conflicting governed plan.

## Sealed selection

The caller supplies `baseId`, a unique explicit `view`, the exact `path`, operations and an idempotency key. Names, aliases and display labels do not select notes. Property keys are raw frontmatter keys, not Base display names; computed/file/formula properties are rejected.

Planning reads a bounded Base snapshot, checks its SHA and binding, queries with `evaluate:false`, then rereads the Base. Bases Bridge 1.2.2 or later supplies a `baseSnapshot` tied to the exact YAML bytes parsed for the query. The reader checks its path, hash and binding against the sealed snapshot; an old Bridge without this proof fails closed. This also rejects a Base A→B→A change during the query, even when surrounding reads both see A. Selection requires a complete fallback response with at most 500 rows, no warnings, unique file paths and exactly one target match. Truncation, unsupported filters, unknown view, ambiguous view names, or a changed Base/binding fail closed. The Bridge supported-filter snapshot is **not a native engine completeness guarantee**. Its metadata cache freshness is explicitly unknown.

The compiler preserves every note byte outside the authorized frontmatter source ranges. The resulting full note, before/after hashes, intent and Base selection proof are sealed through the existing durable note journal. No new journal or transaction manager is created. Protected keys and unsupported YAML are refused.

## Apply and status

Apply rechecks the Base hash/binding and row membership before the shared note-content CAS. A stale note cannot be overwritten. The Base guard and note CAS are separate operations: the Base or unrelated metadata can change in the interval. This is **not a cross-file transaction**, and the receipt states this limitation.

After a partial/lost response, an already attempted plan is observed through status, never blindly reapplied. The underlying note runtime provides ownership, durable idempotency and exact/qualified-settlement postflight. No synthetic recovery tool or internal child recovery reference is exposed. Unknown outcomes that cannot be established remain unknown. Repeating a completed patch must not edit the file again.

If an active Obsidian plugin normalizes unrelated YAML bytes while adding a qualified timestamp, byte-preserving postflight can remain `outcome_unknown` even when the intended property values are visible. This is deliberately fail-closed: status does not certify semantic equivalence, and the Base-row surface exposes no replay or synthetic recovery path.

A successful property update may intentionally make a row leave its view. Postflight certifies the note effect, not continuing Base membership. `status` can update private journal/cache bookkeeping but must never edit a vault note.

## Evidence and local gate

Hermetic tests cover selection limits/warnings/homonyms/duplicate paths/Base drift; property set/delete; readonly and protected keys; stale note CAS; restart and response loss; durable replay/concurrency; MCP annotations/domain fences. Multi-target partial-success tests are NOT_APPLICABLE to this one-note V1, not silently passed.

Run `npm run test:base-rows`, profile/catalogue/capability/docs gates and packaging. The dedicated M5 workflow runs Ubuntu and Windows. Pilot2 on a real Base and Obsidian Desktop remains required before promotion, with disposable fixtures and before/after hashes. Do not mark the feature delivered or merge on mocked tests alone.
