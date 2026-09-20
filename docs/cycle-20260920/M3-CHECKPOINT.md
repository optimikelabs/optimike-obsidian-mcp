# M3 — governed native note move

Branch: `feat/m3-native-note-move`. Base candidate: `4a795142b30e0c2c21dea138b088e4f533308386` (#92). The current branch HEAD and PR checkpoint are the resume authority.

## Contract to implement

One existing Markdown note is renamed through Obsidian FileManager.renameFile. Seal source/destination, backend binding, source proof, destination absence, native update-links preference, and bounded before-neighborhood evidence. Revalidate immediately before dispatch. Separate native move outcome from graph postflight (pending, verified, failed, indeterminate). Do not assert global graph preservation, global file transactionality, or replay safety for an uncertain effect without proof. Reuse the existing durable journal and process lifecycle, rather than a session-local writer. No general folder/Canvas/delete/external mutation.

A missing native preference capability is fail-closed, not an assumed setting. A truncated/unavailable graph cannot prove complete semantic preservation. Local Pilot2 and open-editor behavior remain NOT_RUN until independently exercised.

## Current checkpoint

Branch created and verified before new implementation. Investigating previously uploaded Git blobs from the interrupted run to salvage code, not accepting that code as tested or executable. The recovery-only workflow has read permission and must be removed before candidate readiness. Recovered material must be inspected before reuse.

## Remaining

Native contract + backend, journal adapter/runtime injection, MCP registration, hermetic concurrency/lost-response/postflight tests, Windows/Linux CI, docs/catalog, self-review and independent Codex review. Verdict: REWORK.
