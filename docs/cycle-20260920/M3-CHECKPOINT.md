# M3 — governed native note move

Branch: `feat/m3-native-note-move`; PR #94; stacked on M2 #92 (`8a852d6ecd1d7432f3eb54b14c000766f3f18342`). The branch HEAD and PR are the exact candidate authority.

## Implemented

Native FileManager.renameFile Bridge with a separate opt-in grant, sealed source/destination/preference/binding/neighborhood, bounded semantic projection using M2, explicit move outcome vs graph postflight, process-local backend acknowledgement boundary, durable shared SQLite journal ownership and idempotency, no blind replay, domain fences, three-tool MCP family, registry/profiles/catalog, capability diagnostics, operator docs and Windows/Linux CI entrypoints.

## Recovery completed

The previously staged 19-file surface checkpoint has been reconstructed with exact before/after Git blob hashes and integrated through a connector-side tree/commit/ref update. Failed self-writing workflow, temporary source export/object preparation, and staging recipes are removed from the candidate. Source at the recovery checkpoint `68dac220b9b5667d56e43c392b38e20e7084a34d` was verified against Git tree `3214544ed50d35663169c4644107a09763bf4f00` before applying changes.

## Executed locally on the recovered source plus integrated surface

Node 22.16.0 Linux workbench: root build; 12 durable move scenarios; real in-memory MCP surface tests; profile/registry/catalog tests; full documentation contracts; capability-manifest tests; Atomic Write Bridge typecheck, all 39 unit tests and build. All passed. These are local workbench proofs, NOT Obsidian Desktop proofs and NOT fresh GitHub Windows/Linux results.

## Pending

Fresh exact-candidate GitHub CI; explicit architecture/security/minimality review; independent Codex review and material corrections. Pilot2 and open-editor qualification remain NOT_RUN. No merge before the local gate. Backend acknowledgements are process-local; no global graph transaction or source-content atomic CAS is claimed.

Verdict: REWORK until the remaining repository gates are verified. M4–M6 still require implementation; no completion claim is made.
