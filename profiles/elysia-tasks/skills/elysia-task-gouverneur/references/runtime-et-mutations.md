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

Mutation :

- `operon_adopt_task`
- `operon_create_task`
- `operon_update_task`
- `operon_transition_task`
- `operon_convert_task`
- `operon_relocate_task`

## Protocole

Pour une tâche existante :

1. Lire la tâche et sa `revision`.
2. Construire une `idempotencyKey` liée à l’intention.
3. Exécuter le même outil avec `dryRun: true` et `expectedRevision`.
4. Présenter l’avant, la demande et l’après attendu.
5. Attendre une validation humaine explicite.
6. Appliquer avec la révision encore valide.
7. Relire la tâche et appeler `operon_validate`.

Pour une création, aucune révision antérieure n’existe : destination, pipeline, statut initial et clé d’idempotence doivent être explicites. Pour une adoption, verrouiller le chemin, la ligne et le contenu attendu de la checkbox.

## Interdits

- Aucun fallback silencieux vers le Markdown brut.
- Aucun déplacement hors `operon_relocate_task`.
- Aucune écriture miroir vers un autre moteur de tâches.
- Aucune opération bulk avant un dry-run borné.
- Aucun succès annoncé si l’état final n’a pas été relu.
