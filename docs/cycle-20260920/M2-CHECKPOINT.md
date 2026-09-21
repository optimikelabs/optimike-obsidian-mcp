# M2 checkpoint — native semantic note links

## Resume authority

- Branch: `feat/m2-note-links`
- PR: #92
- Reviewed starting candidate: `d38175cec3ce37f1e9e500030054c6a9579065dc`
- Starting tree: `0a0fe6ee267bd513bba27af59ede6908d8cc0aad`
- Main baseline: `5588ba658a966ec486f54a2598c090575e11e054`
- Security maintenance: #93 / `708d169d92ab1a5749ce7b8b6ac209157aef1963`, already included in the starting candidate ancestry.
- Candidate SHA is the actual branch HEAD, recorded in the PR checkpoint after each push, not a self-referential SHA inside this file.

## This checkpoint

Removed the temporary offline-workbench workflow. The audit-lock-probe was already removed in the starting candidate. The source/dependency export is only a local test aid, never release evidence.

## Contract

`obsidian_note_links` is live/hybrid-live and read-only. Public MetadataCache APIs provide outgoing references, embeds, frontmatter references, resolved targets, subpaths, unresolved aggregates and resolved backlinks. Missing source cache is unavailable with null total, never an asserted empty graph. Truncation and unknown cache freshness are explicit. No graph-preservation guarantee.

## Proof status

The starting candidate had green automated Windows/Linux workflows in Runtime run 35525404276. These are historical proofs for that candidate, not freshly rerun tests for this cleanup commit. Fresh CI and independent GitHub reviews must be inspected before CANDIDATE_READY. Pilot2 GQM26 remains NOT_RUN in this environment.

## Execution protocol for the remainder

The user authorizes preparing M2 through M6 as separate stacked branches/PRs, without merging M2–M5 before local Pilot2 qualification. Each coherent increment must be committed and its remote ref verified before the next substantial increment. WIP commits are allowed; blobs without refs and sandbox-only changes are not checkpoints. Keep a resumable checkpoint in every milestone branch and do not claim completion from generated code alone.

Next branch: `feat/m3-native-note-move`, based on the cleaned M2 candidate. M4: durable note create. M5: P7 Bases rows. M6: release preparation and one ordered Codex/Pilot2 handoff, not release promotion.

## Verdict

REWORK — cleanup recorded; fresh CI/reviews and the deeper contract review still required. Local qualification is intentionally deferred, not failed.
