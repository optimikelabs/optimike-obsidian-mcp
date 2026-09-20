# M4 durable checkpoint — integration

Branch: feat/m4-durable-note-create; PR #95; base: M3 #94.

The sealed integration objects from run 35537417111 are now attached to the branch, not merely stored as unreferenced blobs. Runtime, Bridge, policy, cockpit, registry, profiles, capability manifest, catalogue, documentation and tests are integrated. M3 changes after 2d374102 are carried forward, including request-bound stale-generation conflict receipts and their regression.

Status: REWORK pending fresh compilation, hermetic tests, Windows/Linux CI and independent review. No Pilot2 or installed-state claim. No merge before the ordered local gate. The candidate authority is the branch HEAD, not a SHA embedded in its own file.

Removed: prepare-m4-objects workflow and all five integration recipes. Temporary export-cycle-source workflow is read-only, exports only tracked source, and must be removed after recovery of the workbench source. Tests and documentation must be inspected before candidate admission.
