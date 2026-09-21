# M5 / P7 — reviewed selection correction checkpoint

Branch feat/m5-p7-base-rows, PR #96, stacked on M4 #95 including 1d7546343ef272bc13d28ac0a2d20abe4981e102. Branch HEAD is authoritative.

Implemented: three-tool plan/apply/status for one exact existing Markdown row; raw top-level property set/delete; complete warning-free supported-filter selection <=500 rows; SHA/binding of the actual evaluated Base bytes; shared durable note journal, frontmatter compiler and CAS. No new profile/journal, implicit insert/delete-note, generic batch, synthetic recovery or multi-file transaction.

Codex A-B-A finding fixed through Bases Bridge 1.2.2 query snapshot provenance; see M5-REVIEW.md. Old Bridges without the required proof fail closed. Metadata-cache freshness and native-engine equivalence remain unproven. The Base read guard and note CAS remain distinct operations.

Tests: 23 hermetic selection fixtures, 15 durable CAS/concurrency/restart/loss and real in-memory MCP scenarios; Bases Bridge 34 tests/typecheck/build. Previous integrated registry/profiles/catalogue/capabilities/docs gates passed. Fresh exact-head CI and independent rereview must still be checked.

All temporary preparation workflows/recipes removed; package includes both M4 and M5 contracts. Counts: 91 cross-runtime, 87 live full; standard29, authoring43, tasks35. M5 is authoring/full-only. No file is deleted by a property delete.

Verdict REWORK pending fresh repository gates. Local Pilot2 and installed-state proof remain NOT_RUN. No merge before the final ordered local session; next work is candidate verification and M6 inheritance.
