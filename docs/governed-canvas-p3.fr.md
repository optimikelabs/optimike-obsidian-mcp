# Canvas gouverné P3

Version anglaise : [governed-canvas-p3.md](governed-canvas-p3.md)

P3 ajoute un cycle public et métier pour les mutations bornées d'un seul
fichier Obsidian JSON Canvas existant :

1. `obsidian_canvas_patch_plan`
2. `obsidian_canvas_patch_apply`
3. `obsidian_canvas_patch_status`
4. `obsidian_canvas_patch_recover`

Il n'expose pas d'API générique `operation_*` et ne transforme pas
`obsidian_manage_canvas`. Ce helper direct reste une voie de compatibilité
headless-filesystem sans reçu durable.

## Intentions supportées

- ajouter un nœud texte avec ID et géométrie explicites ;
- modifier le texte d'un nœud texte existant ;
- déplacer ou redimensionner un nœud existant ;
- supprimer un nœud et l'ensemble scellé de ses edges incidentes ;
- connecter deux nœuds existants ou ajoutés avec un ID d'edge explicite ;
- supprimer une edge.

Un ID de nœud ou d'edge ne peut être ciblé qu'une fois par plan. Le compilateur
préserve les champs racine inconnus et les valeurs inconnues des entités
ciblées ou non ciblées. Il refuse un graphe initial invalide et valide le
graphe final : IDs uniques, forme des nœuds, géométrie, côtés et références des
edges. Il ne rend pas le Canvas et ne juge pas la qualité visuelle du layout.

## Frontière durable et atomique

Le plan lit le `.canvas`, compile le JSON strict suivant, enregistre une preuve
de projection et le scelle dans le journal SQLite local machine avant tout
effet. L'apply transmet uniquement ce contenu scellé à Atomic Write Bridge
0.4.0. Le Bridge vérifie l'identité du coffre et le SHA-256 exact dans
`Vault.process`.

Les écritures Canvas ont un gate séparé **Autoriser les écritures Canvas
atomiques**, désactivé par défaut. Les notes peuvent rester désactivées pendant
que Canvas est autorisé, et inversement. Le journal reste par défaut hors du
coffre et du dépôt ; `MCP_OBSIDIAN_CANVAS_JOURNAL_PATH` accepte un chemin local
machine absolu.

Après timeout ou perte de réponse, appeler status d'abord. Recover reprend
uniquement le même plan scellé lorsque le reçu durable l'autorise. Il n'accepte
aucune nouvelle intention et n'est pas un undo.

## Contrat d'échec

| Condition                                        | Résultat                                             |
| ------------------------------------------------ | ---------------------------------------------------- |
| JSON malformé ou graphe initial invalide         | plan refusé, aucune écriture                         |
| intention non supportée ou cible dupliquée       | plan refusé, aucune écriture                         |
| Canvas ou identité du coffre modifié après plan  | conflit/refus, aucune écriture P3                    |
| gate Canvas désactivé                            | plan/apply refusé avant CAS                          |
| réponse perdue après CAS                         | réconciliation par status/recover avant tout retry   |
| hash observé différent des deux preuves scellées | `outcome_unknown`, recovery du plan exact uniquement |

Les lignes terminales suivent le contrat commun de rétention 30 jours et
d'expurgation du contenu. Logs et reçus publics n'exposent jamais le Canvas
complet scellé.

## Frontière du pilote

L'admission en release exige les tests stdio/HTTP et un canary live dans le
coffre pilote Operon Bridge. Le canary utilise un Canvas jetable et prouve :
plan sans écriture, commit, replay, conflit de plan périmé, réconciliation de
réponse perdue, validation du graphe et restauration exacte du SHA-256 initial.
