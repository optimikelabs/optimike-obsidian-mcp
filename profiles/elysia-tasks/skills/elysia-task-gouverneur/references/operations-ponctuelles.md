# Opérations ponctuelles

## Dépendances

- Ouvrir [runtime-et-mutations.md](runtime-et-mutations.md).
- Lire la politique locale du chemin source et du chemin cible.
- Utiliser les racines, pipelines, statuts et priorités remontés par la configuration live.

## Routes

### Créer

Utiliser `operon_create_task` pour une action qui n’existe pas encore. Résoudre la description, la destination autorisée, le pipeline, le statut initial, la priorité et les dates réellement justifiées.

### Adopter

Le verdict `ADOPT` ne garantit pas l’apply. Utiliser `operon_adopt_task` seulement si le runtime annonce `adopt: true`, puis verrouiller le chemin, le numéro de ligne et le contenu attendu. Operon doit produire et appliquer son plan opaque scellé ; sinon retourner une indisponibilité structurée sans modifier le Markdown.

### Créer dans une Daily ou Weekly Note

Utiliser `operon_create_periodic_task` seulement si `periodicCreate: true`. Fournir le kind Daily/Weekly et, au besoin, une date de routage ; ne jamais imposer `targetPath` ou `parentTask`. Relire la tâche créée et sa note périodique après apply.

### Réaligner le scheduling périodique

Utiliser `operon_update_periodic_scheduling` pour tout changement de `dateScheduled`, seulement si `periodicUpdate: true`, avec `expectedRevision`. Ne jamais envoyer ce champ à `operon_update_task` : Operon peut avoir besoin du workflow périodique pour décider retain, detach ou realign. Aucun déplacement du Markdown source n’est implicite ; un changement de note exige une autre opération explicite.

### Modifier

Utiliser `operon_update_task` et envoyer seulement les champs ordinaires intentionnellement modifiés. Pour `dateScheduled`, les relations ou la récurrence, utiliser l’outil dédié. Préserver les propriétés inconnues. Envoyer `taskGallery` comme tableau ordonné, jamais comme chaîne ; ne jamais écrire `__taskDataType`.

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
