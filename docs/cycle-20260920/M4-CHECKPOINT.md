# M4 — durable Markdown note creation

Branch: `feat/m4-durable-note-create`. Base: M3 #94 at `2d3741022456a13c61482f5b6944860360ff31c2`. This branch was created before implementation; its HEAD and PR are the resume authority.

## Intended contract

Create one explicitly named Markdown note without overwriting, suffixing or duplicating an existing note. Reuse the process-owned durable SQLite journal, write policy, validation and existing Bridge. Seal the exact intended content, path, backend/vault identity and observed target absence. Revalidate before dispatch; distinguish resource observation from proof that this attempt authored it. Never replay an ambiguous create after a lost response or restart merely because a path appears absent. A recovery endpoint is optional, not mechanically required.

Audit the existing target-absence primitives and automatic date/frontmatter settlement before finalizing the implementation. Unknown plugin rewrites must not be claimed as exact-content success. No global batch/delete/move redesign.

## Required evidence

Hermetic nominal/existing-target/concurrency/same-key/conflicting-key/lost-response/restart/policy/binding/automatic-fields tests, real MCP surface tests, Windows/Linux CI, documentation/catalog/capability alignment, architecture/concurrency/minimality self-review and independent Codex review. Pilot2 actual creation and active date-plugin behavior remain NOT_RUN until final local qualification.

## State

REWORK: branch and contract checkpoint only. Next: audit current creation/settlement primitives, then checkpoint the smallest working implementation plus tests. M3 repository review/CI is still a separate gate; this branch is not authorization to merge either milestone.
