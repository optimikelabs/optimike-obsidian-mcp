# M3 — governed native note move

Branch: `feat/m3-native-note-move`; PR #94; stacked on M2 #92. Resume authority: the branch HEAD, this checkpoint, and the PR, not chat history.

## Durable state at resumption

The starting checkpoint was `63d7b1f8ee10ed47c67a0e3b44d12cc815dec2a7`. Native move contract, Bridge, journal adapter, registration and initial tests are versioned. The surface integration remains staged in `m3-surface-part1.json`, `m3-surface-part2.json`, `m3-surface-part3.json`; it has NOT been applied. The attempted self-writing GitHub Action failed with HTTP 403 at tree creation. Its workflow is removed by this checkpoint. No new permissions or credentials are requested.

The temporary replacement `export-m3-checkpoint.yml` has contents:read only and exports tracked source at the exact PR head, excluding Git credentials. Delete it after local recovery and before candidate readiness. Do not repeat the self-writing workflow approach.

## Contract

One existing Markdown note is renamed through Obsidian FileManager.renameFile. Seal source/destination, backend binding, source proof, destination absence, native update-links preference, and bounded before-neighborhood evidence. Revalidate immediately before dispatch. Separate native move outcome from graph postflight (pending, verified, failed, indeterminate). No global graph preservation, global file transaction, or blind replay. Reuse the durable journal and process lifecycle. No folder/Canvas/delete/external mutation.

## Next work

Read and apply the saved surface changes with exact-input checks; publish ordinary source commits through the authorized GitHub connector. Run hermetic regression tests and Windows/Linux CI; review architecture, concurrency/privacy and minimality; request independent Codex review; fix material findings. Keep all useful changes on this branch before starting the next work unit.

Verdict: REWORK. Pilot2 and open-editor qualification: NOT_RUN, reserved for the final ordered Codex session. M4–M6 are still unimplemented; no completion claim is made for them.
