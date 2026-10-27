# Governed note deletion

## What the direct tool does

`obsidian_delete_note` issues `DELETE /vault/<path>` to the Local REST API with no plan, no content proof, no precondition and no receipt. What that call does depends on the Local REST API version, not on this server:

- Local REST API 5.5.2 (read from its shipped `main.js`): `DELETE` moves the file to the trash by default (`FileManager.trashFile`, which follows the vault's *Deleted files* preference); only `?permanent=true` calls `adapter.remove`. This server never sends `permanent`.
- Older Local REST API releases: not verified here. Do not assume the trash.

So the direct tool was neither provably permanent nor provably recoverable, and it could not tell a concurrent edit from the note it meant to delete.

## The governed family

`obsidian_note_delete_plan` → `obsidian_note_delete_apply` → `obsidian_note_delete_status`, on the model of the other governed operations. There is no recover or undo tool: restore from the trash in Obsidian.

| Step | What is sealed or checked |
| --- | --- |
| plan | exact SHA-256 and byte size of the note, the set of notes that link to it (at most 200), the vault trash preference, the Bridge binding. Refuses a note that is linked from other notes unless `acknowledgeBacklinks: true`. Refuses a missing note. |
| apply | one dispatch. The Bridge re-reads the note and re-derives the whole seal immediately before the trash call; any difference (content, size, incoming links, preference, binding, grant) is a `conflict` before any effect and requires a new plan. |
| status | reconciles the durable journal row with the Bridge receipt and observes the postflight. Never deletes. |

The effect is `app.fileManager.trashFile(file)` (Obsidian API ≥ 1.6.6: removes the file *"according to the user's preferred 'trash' options (either moving the file to .trash/ or the OS trash bin)"*). The Bridge reads the preference with `vault.getConfig("trashOption")`:

| Preference | Behaviour |
| --- | --- |
| `local` (Obsidian trash, `.trash/`) | admitted. Postflight `verified` needs the note absent from its path **and** a copy with the exact sealed bytes that was not in `.trash/` before the apply. An older identical copy never counts. |
| `system` (OS trash) | admitted. Postflight is `path_absent_only`: the OS trash cannot be observed. If Obsidian fell back to the vault trash, the copy is found and the postflight is `verified`. |
| `none` (permanent deletion) | **refused** (`delete_trash_preference_permanent`). This operation never deletes outright. |
| unreadable | refused (`delete_trash_preference_unavailable`). Never assumed. |

Postflight values: `verified`, `path_absent_only`, `pending` (still observing, up to 5 s), `failed` (the path is occupied again), `indeterminate` (no proof either way, for example after a Bridge restart).

## Backlinks

A note that other notes link to is refused at plan time (`delete_note_has_backlinks`). Inspect them with `obsidian_note_links`, then plan again with `acknowledgeBacklinks: true`. The acknowledged links are part of the seal: a new link added between plan and apply is a conflict. Links are **not** rewritten; they become unresolved, as with a manual deletion in Obsidian.

## Durability and uncertain effects

The adapter reuses the process-owned SQLite journal (`obsidian.note.delete` projection, plan reference `obsidian-note-delete:v1:<uuid>`). It stores hashes and paths, never note content. The same idempotency key returns the same plan; a replayed apply never dispatches again; a lost reply is `outcome_unknown` and is reconciled by `status` from the Bridge's in-memory receipt. The Bridge keeps at most 128 receipts for 10 minutes; after a Bridge restart an uncertain deletion stays `outcome_unknown` (an absent note is not proof that *this* attempt trashed it) and needs a manual look at the vault and its trash. The proxy returns the same honest `OUTCOME_UNKNOWN` receipt as for the other governed applies when the response is lost, including the SDK's 60 s request timeout.

The administrative-closure fence developed on branch `fix/audit-20261027-cloture` was not available when this was written; the operation stays consistent with the existing journal and can adopt that fence later.

## Enabling it and capability negotiation

1. The Atomic Write Bridge setting **Autoriser les suppressions gouvernées de notes** (`allowNoteDeletes`) defaults to off and is independent of the other grants. Existing `data.json` files are not changed by an upgrade.
2. The server needs `MCP_WRITE_MODE=full`.
3. The Bridge status advertises `noteDelete` (`supported`, `enabled`, `trashPreference`, `permanentDeletion: false`). A Bridge without it, or one that reports permanent deletion, is refused closed (`governed-note-delete` capability `unavailable`, `bridge_contract_incompatible`). A usable Bridge with the grant off or with a permanent/unreadable trash preference is `blocked`.

## Exposure by profile

The family is in the `notes.direct.admin` group: it is exposed by `operational` and `full`, never by `standard` or `authoring`. In `operational`, `obsidian_delete_note` is hidden while the governed family is registered (the profile's usual preference for governed alternatives); `full` keeps both, and a runtime without the Bridge-backed governed runtime (for example `headless-filesystem`) keeps the direct tool as its only route.

## What this does not claim

- No source-content compare-and-swap exists in Obsidian: the Bridge re-reads and compares just before the call, which narrows but does not close the window for an editor that saves in between.
- No global graph transaction and no check of other plugins' reactions to the deletion.
- Qualification on a real Obsidian vault (trash preference `local` and `system`, open editor, backlinks, Bridge restart between apply and status) is still to be done on a test vault. The hermetic tests use fakes for Obsidian.

## Résumé opérateur

Activer séparément la suppression dans le Bridge et passer le serveur en `MCP_WRITE_MODE=full`. Planifier une seule note, relire le résultat (hash, liens entrants, réglage de corbeille), puis appliquer ce plan exact. La note part à la corbeille d’Obsidian, jamais en suppression définitive : si le réglage « Fichiers supprimés » est « Supprimer définitivement », l’outil refuse. Une note liée par d’autres notes est refusée tant que `acknowledgeBacklinks` n’est pas fourni ; les liens deviennent non résolus, ils ne sont pas réécrits. Avec la corbeille système, la présence dans la corbeille n’est pas observable : le reçu dit `path_absent_only`. En cas de réponse perdue, appeler `status` ; ne jamais replanifier pour réessayer. Pour restaurer une note, utiliser la corbeille d’Obsidian ou du système.
