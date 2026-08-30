# Runtime et mutations

## Sources de vérité

1. La configuration réellement chargée, via `operon_get_configuration`.
2. L’état live, via `operon_status`.
3. Le profil public `elysia.tasks` fourni dans `profiles/elysia-tasks/v1/profile.json` pour les conventions portables.
4. La politique locale du coffre pour les règles qui ne font pas partie du profil public.

La configuration live décide des capacités et des IDs utilisables. Le profil permet de mesurer la compatibilité ; il ne remplace pas l’état du runtime.

## Préflight

Autoriser une mutation seulement si :

- `source = operon-live` ;
- `stale = false` ;
- le moteur et le Bridge sont compatibles ;
- la capacité demandée est annoncée ;
- la tâche et sa révision courante ont été relues lorsqu’elles existent déjà.

Un snapshot stale peut servir à un diagnostic explicitement limité, jamais à une mutation.

## Surface MCP

Lecture :

- `operon_status`
- `operon_get_configuration`
- `operon_list_tasks`
- `operon_get_task`
- `operon_query_tasks`
- `operon_query_saved_filter`
- `operon_validate`
- `operon_get_diagnostics`
- `operon_find_tasks`
- `operon_resolve_task`
- `operon_get_relationships`
- `operon_build_context`
- `operon_get_timer_state`

Mutation :

- `operon_adopt_task`
- `operon_create_task`
- `operon_create_periodic_task`
- `operon_update_periodic_scheduling`
- `operon_update_task`
- `operon_transition_task`
- `operon_set_relationships`
- `operon_update_recurrence`
- `operon_convert_task`
- `operon_relocate_task`

Récupération :

- `operon_list_pending_recoveries`
- `operon_recover_mutation`

Le serveur enregistre vingt-cinq outils. Leur présence ne remplace jamais le contrôle de capacité live. Operon officiel `3.5.3` a introduit les filtres sauvegardés, l’adoption et les workflows Daily/Weekly après leurs grants exacts ; la cible courante `3.6.0` conserve ce contrat public et reste admise comme `compatible-provisional`. Une future version non refusée n’est pas bloquée par son seul numéro : chaque mutation exige la négociation du contrat Developer API V1, sa capacité exacte, un schéma valide, la santé live, un index stabilisé, la politique d’écriture et le recovery. Operon ne publie toujours pas le catalogue des IDs de filtres. Un grant absent renvoie une indisponibilité structurée sans fallback Markdown. `operon_query_tasks` est la requête structurée Operon ; l’ancien outil non préfixé `query_tasks` relève du legacy Markdown.

`taskType` et `taskImage` sont des valeurs scalaires. `taskGallery` est un tableau ordonné : ne jamais le convertir en chaîne à séparateurs. `__taskDataType` est dérivé et read-only. Les plans task-workflow sont opaques ; après `outcome-unknown`, récupérer uniquement le même `recoveryRef` avec le kind annoncé.

Les relations sont admises en mode `guarded`. La récurrence et la récupération exigent le mode `full`. La CLI reste la surface opérateur/admin et n’est pas relayée génériquement par le MCP.

## Protocole

Pour une tâche existante :

1. Lire la tâche et sa `revision`.
2. Construire une clé de plan : `<intention>-plan-<nonce>`.
3. Exécuter l’outil avec `dryRun: true` et `expectedRevision`.
4. Présenter l’avant, la demande, l’après attendu, le WIP et les avertissements.
5. Attendre une validation humaine explicite.
6. Relire la tâche et sa révision ; arrêter ou recalculer si elle a changé.
7. Construire une clé d’application distincte : `<intention>-apply-<nonce>`.
8. Appliquer avec `dryRun: false` et la révision actuelle.
9. Relire la tâche, vérifier la surface attendue et appeler `operon_validate`. Utiliser un saved filter seulement si `filterQuery` est disponible et si son ID exact vient de l’UI/configuration d’Operon ou d’un workflow opérateur ; sinon traduire les critères du profil dans une requête bornée pour cette exécution.
10. Si la tâche apparaît dans `fs_elysia_now`, prouver sa présence dans `fs_elysia_week` et rapporter `invisible: false`.

Ne jamais réutiliser la clé du dry-run pour l’apply : `dryRun` fait partie de la requête canonique.

Pour une création, aucune révision antérieure n’existe : destination, pipeline, statut initial et clé d’idempotence doivent être explicites. Pour une création Daily/Weekly, laisser Operon résoudre la note, le template et le conteneur ; ne fournir ni chemin arbitraire ni parent. Pour une adoption, exiger d’abord `adopt: true`, puis verrouiller le chemin, la ligne et le contenu attendu. Après une mutation de relations, relire la source et les relations inverses. Après une mutation de récurrence, vérifier règle et portée. Après `outcome-unknown`, récupérer uniquement le même `recoveryRef` ; ne jamais rejouer la mutation initiale.

## Interdits

- Aucun fallback silencieux vers le Markdown brut.
- Aucun déplacement hors `operon_relocate_task`.
- Aucune écriture miroir vers un autre moteur de tâches.
- Aucune opération bulk avant un dry-run borné.
- Aucun succès annoncé si l’état final n’a pas été relu.
- Aucun retry aveugle après un résultat incertain.
- Aucune suppression, gestion de rappel, pin ou commande de timer via le MCP.
