# M5 / historical P7 — Bases rows

Branch: feat/m5-p7-base-rows. Starting candidate: M4 ba12bebfb98392f199270953163d19a2281f62f9. Status: REWORK; contract checkpoint before implementation. No candidate/test/install claim.

## Audited model

`plugins/obsidian-bases-bridge/src/main.ts` constructs query rows from vault files (`file.path`, `file.name`, props/computed). Its upsert route edits existing note frontmatter via processFrontMatter; it does not insert independent records or create notes. expected_mtime is a precheck, not content CAS. Query selection combines Base filters, view filters and request filter using the Bridge supported filter subset; unsupported filters warn. Existing direct upsert can have partial results and is not a durable transaction.

## V1 decision

Implement one existing Markdown row per plan through `bases_rows_patch_plan/apply/status`, top-level property set/delete, exact Base/view/path selection, Base content/binding seal and existing note-content CAS via the shared governed note runtime and frontmatter compiler. Query at most 500 rows, require complete results and no warnings; no claim of native engine completeness. Revalidate Base and selected row before apply. Base guard and note CAS are separate; no cross-file transaction claim. Status never writes notes. No synthetic recover endpoint.

Insert/upsert-as-create and row deletion are deferred: rows are notes, so those actions imply note creation/deletion and must not silently widen this patch. M4 is the separate creation capability. Generic batch and multi-target atomicity are outside this V1. Partial multi-target tests are NOT_APPLICABLE, not passed.

## Required proof

Hermetic fixture first: membership, missing/ambiguous/truncated rows, warnings, stale Base/binding/note, duplicate key, protected/computed properties, domain fences, response loss, restart, single-writer replay and MCP registration. Then Windows/Linux CI, architecture/security/minimality self-review and independent Codex review/corrections. Pilot2 on a real Base remains NOT_RUN and is reserved for final ordered local qualification.
