# Guide de routage MCP

Version anglaise : [mcp-routing-guide.md](mcp-routing-guide.md)

Docs liées : [README](../README.fr.md), [Profils de surface d’outils](tool-surface-profiles.fr.md),
[Guide d’exploitation](../OPERATIONS.fr.md), [Matrice des capacités runtime](runtime-capability-matrix.fr.md),
[Profil serveur headless](headless-server-profile.fr.md) et
[Racines documentaires externes](external-roots-setup.fr.md)

![Parcours de décision pour router le travail agentique dans Optimike Obsidian MCP](assets/readme/routing-guide.fr.svg)

Ce guide aide les agents à choisir la bonne couche et l’outil canonique pour travailler avec Obsidian.

## Choisir d’abord la surface exposée

Runtime et profil d’outils sont deux décisions indépendantes :

- le runtime (`live`, `hybrid`, `headless-*`) définit ce que le backend peut fournir en sécurité ;
- le profil (`standard`, `authoring`, `tasks`, `full`) définit ce que le client voit avant `tools/list`.

Pour une nouvelle intégration, préférer `standard` pour le travail général sur le
coffre, `authoring` pour Bases/Canvas/tags et `tasks` pour Operon. `full` reste la
surface de compatibilité et d’administration 2.x. Voir
[Profils de surface d’outils](tool-surface-profiles.fr.md).

## Décision par défaut

| Besoin                                                                     | Utiliser                                                        | Pourquoi                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Lire, lister, rechercher, recherche sémantique                             | Profil `standard`                                               | Petite surface généraliste avec routage canonique lecture/écriture.               |
| Workflows Operon ou Markdown Tasks                                         | Profil `tasks`                                                  | Contrat Operon complet + outils Markdown compatibles Tasks.                       |
| Authoring Bases, tags ou Canvas                                            | Profil `authoring`                                              | Ajoute les surfaces d’authoring sans toute l’administration.                      |
| Lire un document explicitement configuré hors du coffre                    | `full` + outils external-roots                                  | Les racines externes sont spécialisées et default-deny.                           |
| Déplacer un fichier externe sans casser silencieusement ses liens ÉLYSIA   | `full` en stdio local sur copie ou coffre dédié                 | Inventaire, plan durable, réparations CAS exactes, reçu et rollback.              |
| Comportement Obsidian complet, commandes, active file, Bases via plugin    | `live` ou `hybrid` avec Obsidian Desktop ouvert                 | Seul runtime avec sémantique Desktop/plugin.                                      |
| Serveur backend sûr au-dessus d’un coffre synchronisé                      | `headless-readonly` d’abord                                     | Pas besoin de Desktop et aucun risque d’écriture.                                 |
| Écritures Markdown/frontmatter/tags/admin bornées sur copie ou coffre dédié| `headless-filesystem`                                           | Sécurité de chemins, dry-run par défaut et préconditions.                         |
| Édition fichier directe ponctuelle hors contrat MCP                        | Outils filesystem                                               | L’agent porte alors tous les garde-fous.                                           |
| Actions ou diagnostics app-native Obsidian                                 | Obsidian CLI                                                    | Plan de contrôle Desktop/app, pas headless strict.                                |
| Savoir écrire Markdown, Bases ou Canvas Obsidian                           | Skills ou docs de format Obsidian                               | Les skills enseignent les conventions sans exécuter les opérations MCP.           |

## Outils directs, de compatibilité et gouvernés

Quand plusieurs outils touchent le même domaine, ils ne sont pas
interchangeables. Appliquer cette priorité :

| Intention                                          | Outil préféré                                                                     | Limite de la voie directe ou de compatibilité                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Similarité sémantique                              | `smart_semantic_search`                                                           | C’est le seul nom enseigné aux nouveaux agents et exposé dans les profils modernes.                                            |
| Lecture de tâches gérées par Operon                | `operon_list_tasks`, `operon_query_tasks`                                         | `list_all_tasks` et `query_tasks` inspectent le Markdown compatible Obsidian Tasks.                                            |
| Remplacement complet d’une note Markdown existante | `obsidian_note_replace_plan`, puis apply/status/recover                            | L’overwrite de `obsidian_update_note` ne fournit ni reçu durable ni récupération du plan exact.                                |
| Set/delete du Frontmatter de premier niveau        | `obsidian_frontmatter_patch_plan`, puis son cycle associé                         | `obsidian_manage_frontmatter` reste utile pour la lecture, la compatibilité ou quand la projection gouvernée live est absente. |
| Set/delete d’une formule Base nommée               | `bases_formula_patch_plan`, puis son cycle associé                                | `bases_upsert_config` reste une voie whole-config de compatibilité.                                                            |
| Mutation d’un graphe JSON Canvas existant          | `obsidian_canvas_patch_plan`, puis son cycle associé                              | `obsidian_manage_canvas` est un helper filesystem headless direct sans recovery durable.                                       |

Les mutations directes append, prepend, search/replace et tags restent exposées
quand le runtime actif les autorise. Elles ne produisent pas de reçu durable
plan/status/recovery. Les mutations filesystem headless sont des fallbacks
bornés pour une copie ou un coffre dédié ; elles ne garantissent pas la
sémantique Desktop/plugins.

Le serveur expose la même priorité concise via la ressource MCP
`optimike://guides/tool-routing`. Un client peut la lister et la lire sans
ajouter un nouvel outil de mutation appelable.

## Séquence gouvernée

Pour chaque famille gouvernée :

1. Appeler une seule fois le `*_plan` du domaine avec une clé d’idempotence contrôlée par l’appelant.
2. Examiner le reçu et conserver son `planRef` opaque.
3. Appeler le `*_apply` correspondant avec la même clé.
4. Après timeout ou perte de transport, appeler `*_status` en premier.
5. Appeler `*_recover` uniquement lorsque le reçu autorise la récupération de ce plan exact.

Un profil expose toujours la famille complète `plan → apply → status → recover`
ou aucune de ses opérations. Le profil qui a créé le plan ne devient jamais son
autorité de récupération.

## Validation de format

Utiliser `obsidian_validate_format` avant une écriture risquée ou du contenu généré :

- `kind: markdown` vérifie frontmatter YAML, tags, wikilinks, embeds, callouts et code fences ;
- `kind: base` vérifie YAML `.base`, views, références de formules et formes courantes ;
- `kind: canvas` vérifie JSON Canvas, nodes, edges, IDs, géométrie et références d’edges ;
- `kind: auto` infère depuis l’extension de `filePath`.

Pour un Canvas existant en live/hybrid, préférer
`obsidian_canvas_patch_plan → apply → status/recover`. Le compilateur gouverné
borne les intentions, préserve les valeurs inconnues, valide le graphe final et
applique via le gate CAS Canvas séparé d’Atomic Write Bridge 0.4.0.

Utiliser `obsidian_manage_canvas` seulement comme helper direct en
`headless-filesystem` pour valider, créer, ajouter un nœud texte ou connecter des
nœuds. Le dry-run reste le défaut pour les opérations d’écriture.

## Routage documentaire externe

Un lien Obsidian vers un fichier local n’autorise pas l’accès à ce fichier.
Employer les outils external-roots uniquement lorsque l’opérateur a explicitement
configuré un identifiant logique et choisi la surface spécialisée `full`.

Workflow agent :

1. Appeler `external_runtime_status` ou `external_roots_list` ; ne jamais déduire une racine depuis un chemin physique trouvé dans une note.
2. Employer `external_list` et `external_stat` avec l’identifiant et un chemin relatif à la racine.
3. Employer `external_read` uniquement pour du texte UTF-8 borné.
4. Pour un PDF ou un document Office, demander explicitement `external_handoff` :
   - le stdio local retourne un `local_path` temporaire vérifié ;
   - le HTTP direct authentifié peut retourner un `http_ticket` opt-in, réclamé une seule fois avec la même identité bearer.
5. Conserver comme provenance l’identifiant logique, le chemin relatif, la taille et le SHA-256. Ne jamais persister le chemin temporaire ni le ticket.

Pour un move gouverné par ÉLYSIA :

1. vérifier que le lien `file:///` cliquable possède l’identité canonique adjacente `external-ref:<rootId>::<chemin-relatif-encode>` ;
2. employer `external_references_scan`, puis `external_move_plan` ;
3. s’arrêter si `manualReview` n’est pas vide ; ne jamais réparer automatiquement une occurrence historique ou ambiguë ;
4. examiner `external_move_status`, puis appeler `external_move_apply` uniquement avec les gates write locaux explicites et la même clé d’idempotence ;
5. vérifier le fichier cible et les notes réparées ; employer `external_move_rollback` seulement tant que ses préconditions persistées tiennent encore.

Cette transaction est réservée au stdio local. Elle accepte un fichier régulier,
une cible absente dans un dossier parent existant et un move sans écrasement dans
la même racine et sur le même volume. Les éditions concurrentes de notes sont
protégées par une précondition SHA-256 exacte en `headless-filesystem` sur une
copie ou un coffre dédié. L’apply live via Local REST échoue fermé tant que les
remplacements de note complète n’imposent pas `If-Match`.

Toute opération external-root en HTTP direct exige `external:read`. Le HTTP
distant reste pilote derrière un proxy TLS et des contrôles réseau revus. Le
HTTP direct refuse scan de références, plan/status de move, apply et rollback ;
un ticket d’artefact autorise uniquement le téléchargement.

## Ce que le headless valide mais ne garantit pas

La validation headless attrape les erreurs locales de format. Elle ne rend pas
Obsidian, ne charge pas les plugins communautaires, n’évalue pas le comportement
exact de l’UI Bases, n’exécute pas les formules, ne résout pas les backlinks via
l’index interne Obsidian et ne confirme pas le layout visuel Canvas.

## Règle pratique pour agents

1. Choisir le profil serveur le plus étroit qui contient le domaine nécessaire.
2. Valider le contenu généré avec `obsidian_validate_format`.
3. Si le comportement Desktop/plugin compte, utiliser `live` ou `hybrid` avec Obsidian ouvert.
4. Sur backend, commencer par `headless-readonly`.
5. Activer `headless-filesystem` seulement sur copie ou coffre dédié avec rollback.

Il n’existe volontairement aucune surface publique générique `operation_*`.
