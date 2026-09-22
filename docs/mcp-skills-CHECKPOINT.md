# Skills over MCP — durable closure checkpoint

## Authority

- Repository: `optimikelabs/optimike-obsidian-mcp`.
- Skills branch: `codex/mcp-skills-over-mcp-764a4174`, PR #104.
- Parent branch: `codex/mcp-2026-dual-stack-4e59b8ec`, PR #103.
- Qualified parent product SHA: `832bc9ed040389075d9367111d4087ae295baca9`.
- P0/main baseline: `4e59b8ec28d01b8ccde8c04e1b8f53ea1dd13c78`.
- Last implementation anchor at this checkpoint: `51fafbccc7c36e93ae4174115573306ef110f168`.
- The enclosing Git commit versions this document. Current candidate authority is the remote branch ref plus exact-head CI/review in PR #104, not the historical anchor above.

## Implemented

Read-only source snapshots, Agent Skills validation, complete raw-byte manifests, explicit publication registry, official modern Skills/resource methods, HTTP/direct stdio/proxy integration, legacy/profile isolation and permanent Windows/Linux tests are versioned. Source files are not copied or mutated; scripts inside skills are never executed.

The repository task governor has string metadata and seven reference modules. Its `elysia.tasks` JSON profile remains an external canonical dependency. `test-skills-repo.mjs` validates the actual eight-file directory through the production registry. The historical task-profile test now checks string metadata while preserving profile/governance assertions.

`scripts/smoke-mcp-skills-local.mjs` is the reusable readonly exact-SHA canary. `test-skills-smoke.mjs` exercises it hermetically over real HTTP/stdio/proxy; that test must report Desktop NOT_EXERCISED. Instructions and mutation/host gates are in `docs/mcp-skills-local.md`.

## Normative and security contract

`io.modelcontextprotocol/skills`, stable upstream SHA `0e85d4db8860a305c857f26fdede64f416675b92`, base MCP `2026-07-28`; Agent Skills specification re-read 2026-09-22. Full contract: `docs/mcp-skills.md`.

Explicit existing-root publications, full-profile default, no arbitrary scanning, no Skills tools/new profiles, no DirectoryRead, no script execution, no caller metadata as authorization. Complete snapshots reject excluded/linked/unreadable/over-limit members. Results use private zero-TTL point-in-time manifests. Hosts verify approved raw bytes and reapprove changes; no old digest is attached to changed content.

## Proof and readiness

Parent exact-head CI and rereview were re-read as green. The Skills predecessor `8baf49fb` passed all observed CI. The actual repo-skill test passed the dedicated Windows/Linux gate at `08521dbf`; historical profile tests then exposed numeric/boolean metadata expectations, corrected at `1a0977b9`. These historical results do not certify a later head.

Before marking CANDIDATE_READY_REPO, read the latest exact-head Skills, MCP 2026, P0, Runtime, P6, M4/M5, profile/privacy/package gates and independent review. P0 remains 50/50 in both eras. No guarantee or assertion may be dropped to close a failing gate. Record final results in the PR body/comment anchored to the actual candidate SHA; do not create a self-referential SHA claim in this file.

## Local gates

LOCAL_GATE: NOT_RUN — real ELYSIA roots, Desktop/Pilot2 and Secure were not accessible in this resumed ChatGPT surface. Do not reuse historical P0 Desktop 12/12. Original local skills remain unchanged. Only full development checkouts can run the canary's genuine v1 client.

## Recovery and rollback

Temporary import/qualification recipes and sealed patch transport are removed. Work lives in commits referenced by these two branches. After interruption: verify connectors, read main/refs/PRs/checkpoints/CI/reviews, compare ancestry, then continue at the first incomplete gate. Commit and read back each small coherent unit. Never regenerate an existing remote result from memory.

Unset Skills configuration and restart to disable Skills; legacy protocol mode also disables modern serving. Neither rollback deletes receipts or rewinds sources. Consult status before uncertain operations. No automatic merge, release or production deployment is authorized.
