# M5 / historical P7 — integrated candidate

Branch: feat/m5-p7-base-rows. PR #96. Stack base: M4 #95, including 587371452ad515c086d90aa110b4a36e254d1fa0. Branch HEAD is the candidate authority.

Implemented: one existing Markdown Base row, raw top-level property set/delete, exact Base/view/path selection, SHA/binding seal, complete warning-free supported-filter snapshot (<=500 rows, freshness unknown), shared durable note CAS/frontmatter compiler. No new journal, generic batch, note creation/deletion, synthetic recovery or cross-file atomicity. Base writes are not required.

Integrated: server registration, three-tool lifecycle, authoring/full-only routing, catalogue, capability diagnostics, cockpit and policy. Counts: 91 cross-runtime names; live/hybrid full 87; standard 29, authoring 43, tasks 35. Unknown outcomes route to status, not a nonexistent recover tool.

Evidence before branch integration: local Linux and GitHub preparation run 35539916670 both passed root build, 20 selection fixtures, 15 durable CAS/MCP scenarios, registry/profiles/catalogue/capability and full documentation contracts. The exact hash-verified objects are now referenced by this commit. All three integration recipes and the object-preparation workflow are removed.

Self-review: architecture reuses the governed note journal, source compiler and ownership. Security verifies protected/virtual keys, source CAS, Base guard, idempotency/domain fencing, lost responses/restart and one writer under concurrency. Product scope excludes implicit row/file deletion and insert; batch partials are NOT_APPLICABLE to one target. Remaining limitation: Base guard and note CAS are not transactional, and view freshness/native engine equivalence are not certified.

Verdict: REWORK until fresh exact-head Windows/Linux CI and independent Codex review/corrections are confirmed. Pilot2 remains NOT_RUN; no merge before the final ordered local gate. Contract: docs/base-row-patch-m5.md.
