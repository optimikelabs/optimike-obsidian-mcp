# Opérations ponctuelles

## Dépendances

- Ouvrir [runtime-et-mutations.md](runtime-et-mutations.md).
- Lire la politique locale du chemin source et du chemin cible.
- Utiliser les racines, pipelines, statuts et priorités remontés par la configuration live.

## Routes

### Créer

Utiliser `operon_create_task` pour une action qui n’existe pas encore. Résoudre la description, la destination autorisée, le pipeline, le statut initial, la priorité et les dates réellement justifiées.

### Adopter

Le verdict `ADOPT` ne garantit pas l’apply. Utiliser `operon_adopt_task` seulement si le runtime annonce `adopt: true`, puis verrouiller le chemin, le numéro de ligne et le contenu attendu. Sinon retourner une indisponibilité structurée sans modifier le Markdown.

### Modifier

Utiliser `operon_update_task` et envoyer seulement les champs intentionnellement modifiés. Préserver les propriétés inconnues.

### Changer d’état

Utiliser `operon_transition_task` pour terminer, annuler, rouvrir ou changer de statut. Utiliser un `statusId` live et vérifier les effets métier après application.

### Lier ou délier

Lire d’abord le graphe avec `operon_get_relationships`, puis utiliser `operon_set_relationships` pour remplacer explicitement parent, blocages ou bloqueurs. Refuser doublons, auto-références, sens contradictoires et cycles évidents. Relire la source et les relations inverses après apply.

### Gérer une récurrence

Utiliser `operon_update_recurrence` en mode `full`, avec une portée explicite `this-task` ou `this-and-following`. Employer `null` pour une suppression volontaire et vérifier la règle normalisée ainsi que la portée.

### Convertir

Utiliser `operon_convert_task` pour inline ↔ fichier lorsque la forme cible apporte un gain réel. Vérifier le mode d’écriture requis et résoudre la destination avant le dry-run.

### Déplacer

Utiliser exclusivement `operon_relocate_task`. Vérifier la politique locale du dossier cible et la conservation de l’identité `operonId`.

### Récupérer

Lister les plans incertains avec `operon_list_pending_recoveries`, puis appeler `operon_recover_mutation` uniquement avec le `recoveryRef` du même plan, une nouvelle clé d’idempotence et le mode `full`. Ne jamais reconstruire ou rejouer la mutation originale.

### Rester côté opérateur

Suppression, rappels, pin et contrôle/session de timer restent dans la CLI. Une modification de description d’une File Task reste refusée sans contrat explicite de renommage.

## Heuristiques portables

- Une tâche atomique reste inline ; une tâche riche peut devenir fichier.
- Un projet reste une note ou un objet de projet, pas une tâche géante.
- Une tâche longue peut rester une tâche maître avec une progression documentaire simple.
- Si la destination, le statut ou la propriété est ambigu, arrêter au diagnostic ou au dry-run.
