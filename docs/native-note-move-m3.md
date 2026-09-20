# M3 — governed native Markdown move

## Contract and scope

This candidate moves one existing Markdown note through Obsidian `FileManager.renameFile`, never by rewriting wikilinks or renaming a folder at the filesystem layer. A durable MCP plan seals exact source/destination paths, the backend/vault binding, the source content hash, the native update-links preference and a bounded observed neighborhood. It revalidates before dispatch. The destination parent must already exist; case-only renames are refused.

The public family is `obsidian_note_move_plan`, `obsidian_note_move_apply`, `obsidian_note_move_status`. There is deliberately no recover or undo endpoint. Other governed families retain their existing lifecycle. Standard/authoring/full expose the complete three-tool family in live/hybrid-live; tasks and headless/degraded modes do not expose it.

The independent `allowNativeMoves` Bridge setting defaults to false. MCP plan/apply also require `MCP_WRITE_MODE=full`. Enabling the existing Note or Canvas CAS grants does not enable moves. The Atomic Write Bridge candidate version is 0.7.0.

## Proof boundary

The source plus at most 16 incoming notes are sealed. Each observed note has at most 200 outgoing references, unresolved aggregates and backlink entries, and the whole plan is limited to 256 KiB. Missing or truncated source metadata cannot prove a complete neighborhood and is refused. Link semantics use the same public MetadataCache projection as M2. The public API provides no per-note cache timestamp; this is an observed neighborhood, not a claim of globally fresh graph state.

Update-links ON projects the same resolved targets and anchor validity under the source-to-destination path substitution. OFF is admitted only for a source with an empty observed neighborhood; a linked note is refused. Changed preference, content, observed neighbors, occupied destination, backend identity or revoked grant requires a new plan. The preference accessor is an explicitly feature-detected Obsidian compatibility seam (`vault.getConfig("alwaysUpdateLinks")`), not a public typed API. A missing or non-boolean result fails closed rather than assuming ON.

Native completion and `graph_postflight` are different facts. A returned rename acknowledgement can establish `outcome: committed` while the graph remains pending. Status waits for a MetadataCache resolution event beyond the dispatch barrier, then requires two equal neighborhood observations separated by at least 100 ms without another resolution event. A mismatch becomes failed after the observation grace period; missing proof becomes indeterminate. These results certify only `sealed_neighborhood_only`, never the whole vault graph.

## Durability, concurrency and uncertain effects

The adapter reuses the existing process-owned SQLite journal, execution leases and attempt fencing. It does not call the note-replacement CAS adapter and does not expose the private projection as a direct replacement plan. The legacy journal envelope stores the source hash in both before/after slots; the after slot is not a post-rename content claim. Native and graph proofs live in the typed move projection/observation.

The Bridge serializes its own native moves and keeps at most 128 acknowledgements within an 8 MiB budget. Those acknowledgements are process-local. A lost MCP reply can reconcile through status while the Bridge acknowledgement survives. A Bridge restart without a durable MCP acknowledgement remains outcome_unknown; matching file contents alone are not proof that this attempt moved them. A durable committed outcome survives MCP restart, but current graph verification can become indeterminate. Neither status nor duplicate apply dispatches another rename.

There is no OS-wide directory lock, source-content atomic CAS, multi-file transaction or distributed rollback. Physical guards reject observed symlinks/junctions, hardlinked source files and root changes, but do not claim to exclude arbitrary concurrent external filesystem actors. A native error after dispatch can therefore remain uncertain. Do not create a new operation merely to force a retry. Inspect the exact source/destination and journal in the isolated pilot.

## Tests and remaining qualification

Hermetic tests cover native completion vs graph postflight, collisions, stale source/neighbors, preference/grant/binding changes, OFF behavior, missing preference, same-key and competing execution, lost responses before/after dispatch, process restart, homonyms, unresolved-to-resolved drift, stable semantic digests and strict paths. Separate real in-memory MCP tests exercise the SDK transport, annotations, full-family profile exposure, readonly policy, domain fences and a status-only cockpit action for uncertain moves.

Run `npm run test:native-note-move`, the Atomic Write Bridge check/build, registry/profile/catalog/docs contracts, and the existing cross-platform runtime regressions. CI/independent review must be checked on the exact candidate. Passing mocks do not qualify Obsidian Desktop.

Pilot2 GQM26 remains required before merge: real ON/OFF and preference-change cases, relative Markdown/aliases/embeds/frontmatter links, homonyms, collisions/concurrent editor changes, lost replies, delayed graph updates and open-editor behavior. The last item remains NOT_QUALIFIED until a real test demonstrates it. Never test destructive moves on real ÉLYSIA notes.

## Résumé opérateur

Autoriser séparément les déplacements dans le Bridge et sélectionner le mode d’écriture full. Planifier une seule note, relire le résultat et les chemins affectés, puis appliquer ce plan exact. Un déplacement terminé ne signifie pas que le graphe est vérifié. En cas de réponse perdue, appeler status ; ne pas relancer un rename avec une nouvelle clé. La validation locale Pilot2 et la promotion séquentielle restent obligatoires.
