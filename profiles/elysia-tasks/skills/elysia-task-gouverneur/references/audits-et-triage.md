# Audits et triage

## Profil requis

Pour un audit de conformité ÉLYSIA, ouvrir `profiles/elysia-tasks/v1/profile.json` et comparer la configuration live aux IDs, racines, filtres et contraintes du profil.

## Modes

- `audit_reel` : compter les tâches, doublons, états et chemins réellement observés.
- `audit_conformite` : comparer la configuration et les tâches au profil public et à la politique locale.
- `triage_operationnel` : classer les actions proposées par impact sans modifier le backlog.
- `hygiene_periodique` : détecter les tâches dormantes, hors zone, orphelines ou incohérentes.

## Filtres canoniques du profil V1

- `fs_elysia_now`
- `fs_elysia_inbox`
- `fs_elysia_week`
- `fs_elysia_backlog`
- `fs_elysia_north`
- `fs_elysia_audit`
- `fs_elysia_periodic_leakage`
- `fs_elysia_folder_open` avec un `scopePath` explicite

Appeler `operon_query_saved_filter` ; ne pas reconstruire la logique du filtre côté agent.

## Méthode

1. Exécuter le préflight live.
2. Déclarer le périmètre et la politique de référence.
3. Interroger le saved filter ou les tâches concernées.
4. Séparer faits, écarts au profil, politique locale et interprétation.
5. Proposer uniquement les mutations nécessaires.
6. Pour un audit complet, comparer toutes les tâches ouvertes à l’union des surfaces et exiger `open_without_surface = 0`, `now_not_in_week = 0` et `periodic_non_inbox = 0`.

`apply_propose: aucun` est une conclusion valide. Les comptages avant/après ne sont rapportés que s’ils ont été réellement mesurés.
