# MCP 2026 / Skills recovery checkpoint

## Authority
- P0/main: `4e59b8ec28d01b8ccde8c04e1b8f53ea1dd13c78` (PR #102).
- Dual-stack branch: `codex/mcp-2026-dual-stack-4e59b8ec`.
- Draft PR: #103.
- Last code candidate inspected at checkpoint creation: `393edfaf4ab825547672888c95cf3ffd2471f937`.
- Always read the remote ref: this historical SHA is not a substitute for HEAD.

## Recovery provenance
The abandoned import job 106611176745 (run 35685450050) applied a hash-verified three-commit patch series, retired the import workflows, normalized the SDK v2 lockfile and passed its focused test command. The final push was rejected because the Actions token lacked workflows permission. The commit objects nevertheless remained readable on GitHub. The authorized connector fast-forwarded the existing branch to the recovered descendant; the ref was read back. No reconstruction of the patch was necessary. This is a recovered candidate, not an independently reviewed release.

## Contract
Preserve legacy clients, profiles, CAS, journals, idempotency, receipts, plan/apply/status/recovery, Bridge grants, verified authorization, redaction and no mutation replay after uncertain dispatch. Protocol modern must use official SDK primitives and remain opt-in. Skills is a second independent stacked milestone; never implement it as tools and never copy local ELYSIA skills into the product.

## Proof status
- Historical focused import run: 10/10 scripts reported success; inspect artifacts for actual assertions.
- Exact-candidate Windows/Linux PR CI: IN_PROGRESS / must be relisted.
- Independent source review: IN_PROGRESS.
- P0 current-candidate benchmark: must verify both result JSONs, not infer from the old 50/50.
- Desktop/Pilot2/Secure for migration: NOT_RUN.
- Local ELYSIA skills: NOT_EXERCISED. Optimike plugin not discovered in this resumed tool surface.
- Production: unchanged; no merge/release/deployment authorized by this checkpoint.

## Temporary instrumentation
`.github/workflows/mcp-online-snapshot.yml` only exports the already-versioned source and public installed dependencies for offline analysis. It cannot write repository contents. Remove it before CANDIDATE_READY_REPO; exported artifacts never become the sole code authority.

## Resume
1. Read main, both milestone refs, PR bodies, CI and reviews.
2. Audit recovered protocolMode, mcpSchema, toolErrorBoundary, HTTP, dualStdio and proxy against the current official 2026 spec/SDK.
3. Run/read targeted plus global Windows/Linux results; fix on this branch, commit/read back after each coherent unit.
4. Once A is stable, branch Skills from its exact SHA and create its own Draft PR at the first substantive commit.
5. Keep the local-only canaries explicit, remove temporary instrumentation and produce a self-contained two-branch handoff.

Verdict: IN_PROGRESS, not CANDIDATE_READY_REPO.
