# MCP 2026 / Skills recovery checkpoint

## Authority
- P0/main: `4e59b8ec28d01b8ccde8c04e1b8f53ea1dd13c78` (PR #102).
- Dual-stack branch: `codex/mcp-2026-dual-stack-4e59b8ec`.
- Draft PR: #103.
- Last code candidate inspected at checkpoint creation: `19f46100884aa5703f17e60a5d4bd3f4f73fe9d7`.
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

## Revalidation
The source archive from run 35706896942 reproduced Git tree `e20b2f75e8b77073e9a50ddd20a805f07686b4b8` exactly in the isolated Linux review environment. Build and all three Bridge builds passed. The aggregate run completed 110 scripts: 108 passed; packaging could not invoke PowerShell (not installed here), and the routing scorer could not run its isolated npm ci (network unavailable here). These two local failures are not waived; the Windows/Linux CI must exercise them.

Both unchanged P0 scenario sets returned 50/50, legacy and modern. The six targeted modern suites and both governed-note-replace suites passed, including an actual lost HTTP response after CAS, process restart and one mutation dispatch. This is hermetic repository evidence, not Desktop evidence.

The recovered workflow used runner.temp at job-env scope, where that context is unavailable. Commit 19f46100884aa5703f17e60a5d4bd3f4f73fe9d7 moved it to step scope and pins checkout/evidence to the exact candidate. The new MCP Windows/Linux run is 35707977129; relist its final state rather than inferring success.

## Temporary instrumentation
The read-only snapshot workflow has been removed after transfer. Both earlier import/qualification workflows are also absent. `test-mcp-2026-recovery-contract.mjs` rejects their reintroduction and missing protocol qualification gates. Exports remain transport/evidence, never the candidate authority.

## Resume
1. Read main, both milestone refs, PR bodies, CI and reviews.
2. Audit recovered protocolMode, mcpSchema, toolErrorBoundary, HTTP, dualStdio and proxy against the current official 2026 spec/SDK.
3. Run/read targeted plus global Windows/Linux results; fix on this branch, commit/read back after each coherent unit.
4. Once A is stable, branch Skills from its exact SHA and create its own Draft PR at the first substantive commit.
5. Keep the local-only canaries explicit, remove temporary instrumentation and produce a self-contained two-branch handoff.

Verdict: IN_PROGRESS, not CANDIDATE_READY_REPO.
