# M4 — repository candidate checkpoint

Branch feat/m4-durable-note-create; PR #95, stacked on M3 #94 including 4bafce8162c420468c998980e21047ede1fb84ae. Branch HEAD and current PR checks are authoritative.

Implemented: absent-only exclusive Markdown creation, shared durable journal/ownership/idempotency, qualified date settlement, parsed protected-key authorization at plan/apply, three-tool lifecycle, cockpit/profiles/catalogue/capability/docs. No blind replay, overwrite, auto suffix, arbitrary YAML normalization or certified indexing/authorship.

Codex findings corrected: protected keys on an initially empty document; one-day-late restart reconciliation within the fixed original timestamp window; observed ordering/location for multiple inserted date fields; standalone Bridge dependency boundary; missing creation-contract npm allowlist entry. The last package correction was verified with actual npm pack --dry-run in run 35540896837. Temporary packaging preparation is absent from this tree.

Local Linux: 13 durable create cases, in-memory MCP surface, protected-key/restart negatives and 49 Bridge tests/typecheck/build, including a standalone check without root node_modules. These proofs are not Desktop canaries. Fresh exact-head Windows/Linux CI and independent rereview must be verified separately.

Pilot2, real automatic-field plugins, watcher indexing, installed state and production Secure: NOT_RUN. No merge before ordered local qualification. See M4-REVIEW.md and docs/durable-note-create-m4.md. Retain explicit ambiguity, no power-loss/hostile-mount guarantee and no replay after uncertain effects.
