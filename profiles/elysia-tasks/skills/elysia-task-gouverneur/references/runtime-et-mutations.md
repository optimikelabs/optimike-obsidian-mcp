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
- la capacité exacte est confirmée avant apply ; un dry-run peut négocier une capacité optionnelle à froid selon les conditions ci-dessous ;
- la tâche et sa révision courante ont été relues lorsqu’elles existent déjà.

Un snapshot stale peut servir à un diagnostic explicitement limité, jamais à une mutation.

## Capacités optionnelles à froid

`filterQuery`, `adopt`, `periodicCreate` et `periodicUpdate` peuvent être `false` avant leur première négociation. Le statut seul ne distingue pas cet état d’un refus effectif. Pour un filtre dont l’ID exact est connu, une lecture `operon_query_saved_filter` peut négocier son grant. Pour une adoption ou un workflow périodique autorisé, un dry-run exact peut négocier son grant si le runtime est live/non-stale et si le Bridge annonce explicitement `mutationsEnabled: true`. Un ancien Bridge sans ce champ garde la gate par capacité annoncée.

Une réponse de grant absent, en attente ou refusé, une incompatibilité ou un refus de politique arrête l’opération. Ne pas enchaîner les tentatives ni passer en apply pour tester la capacité. Après négociation, relire l’état ; un dry-run réussi ne prouve pas un apply.

## Récupération sous allowlist

Si `OPERON_MUTATION_ALLOWED_PATH_PREFIXES` est non vide, la liste des recoveries et leur apply sont refusés : les enregistrements ne prouvent pas leur route canonique. Ce refus ne signifie pas qu’aucune récupération n’est en attente. Conserver le `recoveryRef` connu, relire la tâche concernée dans le périmètre autorisé et transmettre le diagnostic à l’opérateur. Ne pas retirer l’allowlist ni utiliser la CLI comme contournement. Une récupération éventuelle requiert un contexte opérateur explicitement autorisé et les contrôles natifs ; ne jamais rejouer la mutation initiale.

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

Le serveur enregistre vingt-cinq outils. Leur présence ne remplace jamais le contrôle de capacité live. Operon officiel `3.5.3` a introduit les filtres sauvegardés, l’adoption et les workflows Daily/Weekly après leurs grants exacts ; la cible courante `3.9.3` conserve ce contrat public et est certifiée Developer API V1 après la gate exacte Pilot 2. La certification destructive périodique complète reste exclue. Une future version non refusée n’est pas bloquée par son seul numéro : chaque mutation exige la négociation du contrat Developer API V1, sa capacité exacte, un schéma valide, la santé live, un index stabilisé, la politique d’écriture et le recovery. Operon ne publie toujours pas le catalogue des IDs de filtres. Un grant absent renvoie une indisponibilité structurée sans fallback Markdown. `operon_query_tasks` est la requête structurée Operon ; l’ancien outil non préfixé `query_tasks` relève du legacy Markdown.

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
9. Relire la tâche, vérifier la surface attendue et appeler `operon_validate`. Utiliser un saved filter si son ID exact vient de l’UI/configuration d’Operon ou d’un workflow opérateur, avec la négociation à froid décrite ci-dessus ; en cas d’ID absent ou de refus effectif, traduire les critères du profil dans une requête bornée pour cette exécution.
10. Si la tâche apparaît dans `fs_elysia_now`, prouver sa présence dans `fs_elysia_week` et rapporter `invisible: false`.

Ne jamais réutiliser la clé du dry-run pour l’apply : `dryRun` fait partie de la requête canonique.

Pour une création, aucune révision antérieure n’existe : destination, pipeline, statut initial et clé d’idempotence doivent être explicites. Pour une création Daily/Weekly, laisser Operon résoudre la note, le template et le conteneur ; ne fournir ni chemin arbitraire ni parent. Pour une adoption, verrouiller le chemin, la ligne et le contenu attendu, puis confirmer `adopt` via le préflight et, si nécessaire, le dry-run de négociation à froid. Après une mutation de relations, relire la source et les relations inverses. Après une mutation de récurrence, vérifier règle et portée. Après `outcome-unknown`, appliquer d’abord la règle de récupération sous allowlist ci-dessus ; lorsque la politique le permet, récupérer uniquement le même `recoveryRef`. Ne jamais rejouer la mutation initiale.

## Interdits

- Aucun fallback silencieux vers le Markdown brut.
- Aucun déplacement hors `operon_relocate_task`.
- Aucune écriture miroir vers un autre moteur de tâches.
- Aucune opération bulk avant un dry-run borné.
- Aucun succès annoncé si l’état final n’a pas été relu.
- Aucun retry aveugle après un résultat incertain.
- Aucune suppression, gestion de rappel, pin ou commande de timer via le MCP.
