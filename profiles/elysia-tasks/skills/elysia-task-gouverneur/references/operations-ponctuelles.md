# Opérations ponctuelles

## Dépendances

- Ouvrir [runtime-et-mutations.md](runtime-et-mutations.md).
- Lire la politique locale du chemin source et du chemin cible.
- Utiliser les racines, pipelines, statuts et priorités remontés par la configuration live.

## Routes

### Créer

Utiliser `operon_create_task` pour une action qui n’existe pas encore. Résoudre la description, la destination autorisée, le pipeline, le statut initial, la priorité et les dates réellement justifiées.

### Adopter

Utiliser `operon_adopt_task` pour promouvoir une checkbox existante qui constitue une vraie action. Verrouiller le chemin, le numéro de ligne et le contenu attendu.

### Modifier

Utiliser `operon_update_task` et envoyer seulement les champs intentionnellement modifiés. Préserver les propriétés inconnues.

### Changer d’état

Utiliser `operon_transition_task` pour terminer, annuler, rouvrir ou changer de statut. Utiliser un `statusId` live et vérifier les effets métier après application.

### Convertir

Utiliser `operon_convert_task` pour inline ↔ fichier lorsque la forme cible apporte un gain réel. Vérifier le mode d’écriture requis et résoudre la destination avant le dry-run.

### Déplacer

Utiliser exclusivement `operon_relocate_task`. Vérifier la politique locale du dossier cible et la conservation de l’identité `operonId`.

## Heuristiques portables

- Une tâche atomique reste inline ; une tâche riche peut devenir fichier.
- Un projet reste une note ou un objet de projet, pas une tâche géante.
- Une tâche longue peut rester une tâche maître avec une progression documentaire simple.
- Si la destination, le statut ou la propriété est ambigu, arrêter au diagnostic ou au dry-run.
