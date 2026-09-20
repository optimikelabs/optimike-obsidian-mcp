# M4 — durable creation checkpoint

Branch: feat/m4-durable-note-create; PR #95; base M3 #94 including 4bafce8162c420468c998980e21047ede1fb84ae. Branch HEAD is the candidate authority.

Integrated: absent-only exclusive creation, shared durable journal, request-bound receipts, qualified date fields, source-free terminal proof, three-tool MCP family, cockpit, profiles/catalogue/capabilities and documentation. No blind replay; no overwrite, suffix, delete or rollback of an uncertain created file.

Local Linux evidence: root build; 13 durable create scenarios; real in-memory MCP surface test; registry, profiles, catalogue, capability manifest and complete documentation contracts; Bridge typecheck, 47 tests, and bundle build. These local results do not substitute for fresh GitHub Windows/Linux CI or Pilot2.

A dedicated M4 Windows/Linux workflow now executes the create tests and Bridge check. The source-export workflow and all integration recipes/object-preparation instrumentation have been removed. No branch-writing workflow remains from this work.

Status: REWORK pending exact-head CI and independent Codex review/corrections. Pilot2, Obsidian watcher indexing, real plugin settlement and installed state: NOT_RUN. No merge before the final ordered local session.

Limitations: one Markdown file, existing trusted local parents; no directory-fsync/power-loss or adversarial-mount guarantee; observed-state commit does not prove authorship. See docs/durable-note-create-m4.md.
