# Guide de routage MCP

English version: [mcp-routing-guide.md](mcp-routing-guide.md)

Voir aussi : [Profils de surface d’outils](tool-surface-profiles.fr.md), [Matrice des capacités runtime](runtime-capability-matrix.fr.md), [Opérations](../OPERATIONS.fr.md), [External Roots](external-roots-setup.fr.md).

Optimike MCP expose son guide de routage adapté au profil via la ressource MCP :

```text
optimike://guides/tool-routing
```

La ressource est rendue pour le profil actif et ne mentionne que les outils visibles dans la session.

## Choisir d’abord la surface

Utiliser le profil le plus étroit couvrant la mission :

| Mission | Profil |
| --- | --- |
| Lecture, recherche et travail courant dans le coffre | `standard` |
| Écriture de notes, Frontmatter, Bases et Canvas | `authoring` |
| Operon et opérations de tâches | `tasks` |
| Compatibilité, administration et diagnostic large | `full` |

Le profil contrôle la découverte et l’appel. Le mode de runtime et la write policy continuent de contrôler les effets possibles.

## Décision par défaut

| Besoin | Utiliser | Pourquoi |
| --- | --- | --- |
| Lire, lister ou chercher du texte exact | Outils Obsidian de lecture/recherche | Surface stable en live, hybrid et headless. |
| Similarité sémantique | `smart_semantic_search` | Seul nom public de recherche sémantique en 3.0. |
| Tâches gérées par Operon | Outils Operon du profil `tasks` | Identités, révisions, workflows et récupération natifs. |
| Inspection de tâches Markdown Tasks-compatible | `list_all_tasks` / `query_tasks` | Lecture de cases Markdown sans revendiquer la propriété Operon. |
| Remplacer complètement une note existante | Cycle `obsidian_note_replace_plan` | Contenu scellé, CAS, reçu durable et récupération du plan exact. |
| Modifier des propriétés Frontmatter de premier niveau | Cycle `obsidian_frontmatter_patch_plan` | Projection préservant la source et récupération durable. |
| Modifier une formule nommée dans Bases | Cycle `bases_formula_patch_plan` | Intention typée appliquée par Base CAS. |
| Modifier un graphe Canvas existant | Cycle `obsidian_canvas_patch_plan` | Validation du graphe, préservation des valeurs inconnues et Canvas CAS. |
| Lire/transmettre un document externe configuré | Outils de lecture External Roots | Racines logiques default-deny et chemins physiques masqués. |
| Déplacer un fichier externe avec réparation exacte des liens ÉLYSIA | Transaction External Move en stdio local | Inventaire, plan scellé, réparations conditionnelles et rollback. |
| Sémantique complète de l’interface/plugins Obsidian | `live` ou `hybrid` avec Desktop ouvert | Les modes headless ne chargent ni plugins communautaires ni état UI. |
| Validation backend/CI | `headless-readonly` d’abord | Aucune écriture. |
| Travail filesystem borné sur une copie/coffre dédié | `headless-guarded` ou `headless-filesystem` | Opt-in explicite, sécurité des chemins et préconditions. |

## Recherche sémantique canonique

Utiliser :

```text
smart_semantic_search
```

Optimike MCP 3.0 a supprimé `smart_search` et `smart-search`. Ces alias appelaient la même implémentation et ne doivent plus apparaître dans les prompts, allowlists ou workflows.

## Outils directs et gouvernés

Les deux familles possèdent des garanties différentes.

| Intention | Préférer | Frontière directe/compatibilité |
| --- | --- | --- |
| Remplacement complet d’une note | `obsidian_note_replace_plan → apply/status/recover` | `obsidian_update_note` sert les append/prepend/create directs intentionnels. |
| Remplacement à haute assurance dérivé d’un search/replace | Contenu complet via le cycle de remplacement | `obsidian_search_replace` n’a pas de récupération durable. |
| Set/delete Frontmatter | `obsidian_frontmatter_patch_plan → ...` | `obsidian_manage_frontmatter` est un fallback borné lorsque la famille gouvernée est structurellement absente. |
| Mutation de formule Base | `bases_formula_patch_plan → ...` | `bases_upsert_config` reste une compatibilité whole-config du profil `full`, pas un fallback de formule. |
| Mutation d’un Canvas existant | `obsidian_canvas_patch_plan → ...` | `obsidian_manage_canvas` est un fallback headless-filesystem sans reçus durables. |

Ne pas choisir un outil direct seulement parce qu’il comporte moins d’étapes. Le choisir uniquement lorsque sa garantie plus étroite correspond à l’intention.

## Séquence gouvernée

1. Appeler le `*_plan` du domaine une seule fois avec une clé d’idempotence appartenant à l’appelant.
2. Inspecter le reçu et conserver la référence opaque.
3. Appeler le `*_apply` correspondant avec la même clé.
4. Après timeout ou perte de transport, appeler d’abord `*_status`.
5. Appeler `*_recover` uniquement lorsque le reçu autorise la récupération de ce plan exact.

Ne jamais recréer une mutation simplement parce que la réponse d’apply a été perdue.

Chaque famille gouvernée est exposée atomiquement. Si `plan` ou `apply` est visible, `status` et `recover` le sont aussi.

## Récupération entre sessions

Une session est liée à un profil. Un plan durable n’est pas lié à ce profil.

Après reconnexion, utiliser tout profil exposant la même famille complète, ou `full`, pour inspecter/récupérer le plan. Le journal d’origine, le binding backend, la clé d’idempotence et la write policy restent les autorités.

## Projection sur les runtimes

Les profils sont compilés sur les outils structurellement enregistrés par le runtime.

- `live` : outils Desktop/Local REST API et Bridges gouvernés disponibles ;
- `hybrid` : lectures résilientes et outils live lorsque l’API est configurée/joignable ;
- `headless-readonly` : lectures cache/filesystem et validation ;
- `headless-guarded` : écritures directes prudentes sur notes/Frontmatter ;
- `headless-filesystem` : administration filesystem et helpers directs Canvas/Bases.

La santé transitoire d’un backend ne modifie pas la surface. Un outil momentanément indisponible retourne un diagnostic explicite.

## Documents externes

Un chemin physique cité dans une note n’accorde aucune autorisation.

1. Inspecter `external_runtime_status` ou `external_roots_list`.
2. Utiliser `rootId` et des chemins relatifs à la racine.
3. Utiliser `external_read` seulement pour du texte UTF-8 borné.
4. Utiliser `external_handoff` pour les binaires ; l’extraction appartient au client.
5. Conserver la provenance logique et le SHA-256, jamais les chemins temporaires.

External Move reste limité au stdio local et exige son bundle complet de cinq outils. Arrêter dès que `manualReview` n’est pas vide.

## Limites headless

La validation headless ne rend pas Obsidian, ne charge pas les plugins, n’évalue pas fidèlement les formules/vues Bases de l’UI, n’utilise pas le fichier actif, n’exécute pas la palette de commandes et ne juge pas la qualité visuelle d’un Canvas.

Commencer par `headless-readonly`, puis n’activer les écritures filesystem que sur une copie ou un coffre dédié avec procédure de rollback explicite.
