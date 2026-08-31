# Matrice des capacités runtime

Version anglaise : [runtime-capability-matrix.md](runtime-capability-matrix.md)

Docs liées : [README](../README.fr.md), [Guide d’exploitation](../OPERATIONS.fr.md), [Remplacement gouverné](governed-note-replacement.fr.md), [Formules Base gouvernées P2](governed-base-formula-p2.fr.md), [Profil serveur headless](headless-server-profile.fr.md), [Guide de routage MCP](mcp-routing-guide.fr.md), [Configuration des racines externes](external-roots-setup.fr.md)

![Aide au choix entre les profils live, hybrid et headless d’Optimike Obsidian MCP](assets/readme/runtime-profiles.fr.svg)

Optimike Obsidian MCP possède cinq contrats runtime. Les modes headless tournent au-dessus d’un vault Markdown synchronisé. Ils ne lancent pas Obsidian Desktop, ne chargent pas les plugins communautaires, n’exposent pas la palette de commandes et ne donnent pas l’état live de l’interface.

En 3.1, `OBSIDIAN_STARTUP_BLOCKING` vaut `false` par défaut. Un processus MCP
live ou hybrid reste donc actif lorsque Codex démarre avant Obsidian Desktop ;
les outils live restent temporairement indisponibles et échouent fermés jusqu’à
ce que Local REST réponde. Régler la variable à `true` uniquement si un
déploiement live doit faire échouer son propre démarrage après les tentatives
bornées du contrôle initial.

## Usage recommandé

| Mode runtime                 | Idéal pour                                             | Obsidian Desktop                       | Local REST API                                                | Écritures                                                                                                | Bases                                        | Posture par défaut        |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| `live`                       | Automatisation Obsidian locale complète                | Requis                                 | Requis                                                        | Outils REST complets                                                                                     | Bases Bridge REST                            | Desktop de confiance      |
| `hybrid` avec API disponible | Workflows Desktop avec cache durable                   | Requis pendant l’usage des outils live | Optionnelle au démarrage, disponible pour la surface complète | Outils REST complets tant que l’API répond                                                               | Bases Bridge REST                            | Desktop robuste           |
| `hybrid` sans API            | Lecture/search dégradés quand Desktop est indisponible | Non requis                             | Indisponible                                                  | Aucun outil d’écriture                                                                                   | Non enregistré                               | Mode dégradé résilient    |
| `headless-readonly`          | Serveur, CI, Codex ou validation d’un vault Sync copié | Non requis                             | Non requis                                                    | Aucune                                                                                                   | Fallback local en lecture seule              | Mode headless le plus sûr |
| `headless-guarded`           | Écritures note très prudentes sur copie ou vault dédié | Non requis                             | Non requis                                                    | Append/prepend, search_replace, frontmatter set                                                          | Fallback local en lecture seule              | Palier write prudent      |
| `headless-filesystem`        | Fonctions filesystem headless explicites               | Non requis                             | Non requis                                                    | Écritures filesystem bornées, move/delete préconditionnés, index tags, batch frontmatter, helpers Canvas | Fallback local + écritures `.base` minimales | Sandbox/copie obligatoire |

## Tableau des capacités

| Capacité                                     | `live`                       | `hybrid` API disponible                    | `hybrid` API indisponible | `headless-readonly`             | `headless-guarded`                  | `headless-filesystem`                                                      |
| -------------------------------------------- | ---------------------------- | ------------------------------------------ | ------------------------- | ------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Démarrer sans `OBSIDIAN_API_KEY`             | Non                          | Oui                                        | Oui                       | Oui                             | Oui                                 | Oui                                                                        |
| Démarrer sans Obsidian Desktop               | Oui ; outils live en attente | Oui                                        | Oui                       | Oui                             | Oui                                 | Oui                                                                        |
| Cache filesystem                             | Optionnel                    | Oui                                        | Oui                       | Requis                          | Requis                              | Requis                                                                     |
| Politique d’exclusion du vault               | Oui pour les scans cache     | Oui pour les scans cache                   | Oui                       | Oui                             | Oui                                 | Oui                                                                        |
| Lire/lister/rechercher                       | REST/cache                   | REST/cache                                 | Cache/filesystem          | Cache/filesystem                | Cache/filesystem                    | Cache/filesystem                                                           |
| Tasks list/query                             | Cache/filesystem             | Cache/filesystem                           | Cache/filesystem          | Cache/filesystem                | Cache/filesystem                    | Cache/filesystem                                                           |
| Recherche sémantique Smart Connections       | `.smart-env` + embedder      | `.smart-env` + embedder compatible         | `.smart-env` + embedder   | `.smart-env` + embedder         | `.smart-env` + embedder             | `.smart-env` + embedder                                                    |
| Status/maintenance runtime                   | Oui                          | Oui                                        | Oui                       | Oui                             | Oui                                 | Oui                                                                        |
| Cockpit des opérations gouvernées en attente | Oui                          | Oui                                        | Non                       | Non                             | Non                                 | Non                                                                        |
| Racines documentaires externes               | Config locale optionnelle    | Config locale optionnelle                  | Config locale optionnelle | Config locale optionnelle       | Config locale optionnelle           | Config locale optionnelle                                                  |
| Scan/plan des références externes            | Stdio local                  | Stdio local                                | Stdio local               | Stdio local                     | Stdio local                         | Stdio local                                                                |
| Apply/rollback de move externe               | Non                          | Non                                        | Non                       | Non                             | Non                                 | Désactivé partout : `native_handle_relative_mutation_unavailable`          |
| Validation de format                         | Markdown/Base/Canvas         | Markdown/Base/Canvas                       | Markdown/Base/Canvas      | Markdown/Base/Canvas            | Markdown/Base/Canvas                | Markdown/Base/Canvas                                                       |
| Update note                                  | Outil REST complet           | Outil REST complet                         | Non                       | Non                             | Append/prepend seulement            | Append/prepend seulement                                                   |
| Remplacement atomique gouverné               | CAS Atomic Write Bridge      | Idem tant que l’API et le Bridge répondent | Non                       | Non                             | Non                                 | Non                                                                        |
| Patch texte gouverné du corps Markdown       | Même CAS Atomic Write        | Idem tant que l’API et le Bridge répondent | Non                       | Non                             | Non                                 | Non                                                                        |
| Search/replace                               | Outil REST complet           | Outil REST complet                         | Non                       | Non                             | Remplacements exacts par `filePath` | Remplacements exacts par `filePath`                                        |
| Frontmatter                                  | Outil REST complet           | Outil REST complet                         | Non                       | Non                             | `set` d’une clé unique              | `set`, batch frontmatter dry-run/apply, et rows Bases                      |
| Tags                                         | Outil REST complet           | Outil REST complet                         | Non                       | Non                             | Non                                 | Tags frontmatter, tags inline, index/audit local, rename avec dry-run      |
| Admin filesystem                             | Non                          | Non                                        | Non                       | Non                             | Non                                 | Archive, batch move, batch delete en dry-run par défaut                    |
| Suppression de note                          | Suppression REST             | Suppression REST                           | Non                       | Non                             | Non                                 | Suppression filesystem avec `expectedHash` ou `expectedMtime`              |
| Déplacement/renommage                        | Non                          | Non                                        | Non                       | Non                             | Non                                 | Déplacement filesystem avec `expectedHash` ou `expectedMtime`              |
| Active file / UI / commandes                 | Via Desktop/plugin           | Via Desktop/plugin tant que l’API répond   | Non                       | Non                             | Non                                 | Non                                                                        |
| Bases list/schema/query                      | Bases Bridge REST            | Bases Bridge REST                          | Non                       | Fallback local en lecture seule | Fallback local en lecture seule     | Fallback local avec filtres simples (`eq`, `contains`, `in`, comparaisons) |
| Bases create/upsert                          | Bases Bridge REST            | Bases Bridge REST                          | Non                       | Non                             | Non                                 | `.base` YAML create/config + rows -> frontmatter `set`                     |
| JSON Canvas create/edit                      | CAS graphe gouverné          | Idem tant que l’API/Bridge répondent       | Non                       | Non                             | Non                                 | `.canvas` direct minimal : create, text node, edge, validate               |
| Parité plugins Obsidian                      | Plugins Desktop              | Plugins Desktop tant que l’API répond      | Non                       | Non                             | Non                                 | Non                                                                        |

## Registre des tools par mode

Tous les modes enregistrent aussi `external_runtime_status`,
`external_roots_list`, `external_list`, `external_stat`, `external_read`,
`external_handoff`, `external_references_scan`, `external_move_plan`,
`external_move_status`, `external_move_apply` et `external_move_rollback`. Sans
`MCP_EXTERNAL_ROOTS_FILE`, le statut reste désactivé et les opérations échouent
fermées.

Le serveur HTTP direct enregistre les cinq noms d’intégrité uniquement pour
retourner un refus stdio-only explicite. Le proxy stdio local les implémente.
Scan, plan et status sont diagnostiques/read-only. Apply, rollback et toute
récupération mutante automatique sont désactivés sur toutes les plateformes
jusqu’à l’existence d’une primitive native handle-relative auditée. Le runtime
retourne `native_handle_relative_mutation_unavailable` ; les gates de mode
write, de feature et de capacité racine ne peuvent pas le contourner. Les
reçus redacted, snapshots SQLite privés, contrôles de binding/session stale et
preuves CAS exactes restent contractuels.

`external_runtime_status.externalMove` sépare les deux plans de capacité
fermés. Le HTTP direct retourne toujours `planningAvailable: false` avec
`planningUnavailableReason: "stdio_only"` ; le stdio local vérifié peut
retourner `planningAvailable: true`. Dans les deux transports,
`mutationAvailable: false` et
`mutationUnavailableReason: "native_handle_relative_mutation_unavailable"`
restent autoritaires. Si stdio ne peut pas vérifier son binding local, il
retourne une raison de planification expurgée (`profile_required`,
`target_unverified` ou `backend_attestation_unavailable`) sans publier de
chemin ni de digest.

Tous les modes enregistrent aussi les 25 outils du contrat Operon :
`operon_status`, `operon_get_configuration`, `operon_list_tasks`,
`operon_get_task`, `operon_query_tasks`, `operon_query_saved_filter`,
`operon_validate`, `operon_get_diagnostics`, `operon_find_tasks`,
`operon_resolve_task`, `operon_get_relationships`, `operon_build_context`,
`operon_get_timer_state`, `operon_adopt_task`, `operon_create_task`,
`operon_create_periodic_task`, `operon_update_periodic_scheduling`,
`operon_update_task`, `operon_transition_task`, `operon_set_relationships`,
`operon_update_recurrence`, `operon_convert_task`,
`operon_relocate_task`, `operon_list_pending_recoveries` et
`operon_recover_mutation`. Hors mode live, ils restent limités aux snapshots
validés en lecture seule ; toute mutation échoue fermée. L’enregistrement ne
garantit pas la disponibilité runtime : Operon officiel `3.6.1` conserve
l’exécution des filtres, l’adoption et les workflows Daily/Weekly après leurs
grants exacts. Une future version non refusée ne bascule pas en lecture seule
uniquement parce que son numéro est inconnu : le Bridge n’admet chaque mutation
qu’après négociation de la Developer API V1, validation exacte de la capacité et
du schéma, santé live, index stabilisé, politique d’écriture et recovery. Un grant optionnel absent désactive uniquement sa
route, sans fallback Markdown. Operon reste propriétaire du plan opaque scellé
et de sa récupération same-plan. Operon officiel `3.2.x` exécute les
filtres sauvegardés après un grant exact `tasks.filter-query`, mais ne publie pas
leur catalogue ; l’adoption reste indisponible. Les relations et la récurrence
ont passé le pilote live dédié 3.2.0. Les limites bornées #99/#101 et #139
restent ouvertes. Le renderer Settings manquant en 3.2.1 est suivi dans #145/#146.
Operon `3.5.3` reste une preuve historique du déploiement de l’adoption et des
workflows périodiques ; il n’est pas la cible candidate actuelle. Des runs
La gate Pilot 2 actuelle cible Optimike MCP `3.8.1` avec Operon `3.6.1`,
CLI `1.2.0`, Local REST API `5.1.0` et Bridge `0.9.2` ; l’admission de
la release exige le SHA final propre. Un grant suspendu récupérable peut être
réapprouvé explicitement dans les réglages Operon ; un binding périmé, révoqué
ou ayant dérivé reste bloqué.
Les applies périodiques de ces runs sur le worktree sont uniquement des preuves
historiques/diagnostiques. La canary sur le SHA exact effectue la prévisualisation
périodique et la négociation du grant exact, puis saute les applies périodiques
avec la raison `public_task_source_projection_unavailable`, car le plan public
Task Workflow est limité aux métadonnées et n’expose aucun chemin de source des
tâches avant apply. Les outils runtime restent disponibles ; la projection
publique du chemin de source est un suivi amont non bloquant et aucune
certification périodique complète n’est revendiquée.
Voir le [contrat MCP Operon](operon-mcp-contract.fr.md) et
l’[audit CLI/API](operon-cli-audit.fr.md).

Les quartets de remplacement gouverné et de patch texte du corps sont
enregistrés uniquement en `live`, ou en `hybrid` avec API disponible. Leur
présence n’ouvre aucune écriture. `obsidian_note_replace_plan`,
`obsidian_note_replace_apply`, `obsidian_note_replace_status` et
`obsidian_note_replace_recover` restent soumis à la politique
MCP courante, frontmatter protégé, write gate du Bridge, identité backend et CAS
SHA-256. `obsidian_text_patch_plan/apply/status/recover` projette les append,
prepend et remplacements littéraux bornés sur cette même autorité durable, sans
nouveau journal, et refuse frontmatter, lignes de tâches, regex et chemins
ambigus.
`obsidian_list_pending_operations` est enregistré sur la même frontière live,
mais reste read-only dans chaque profil et write mode. Il inventorie uniquement
les journaux possédés par ce processus, sans appel backend ni transition.

La livraison du handoff est un contrat de transport, pas une capacité d’écriture
du mode runtime :

- le stdio expose un `local_path` vérifié, géré par le cycle de vie local du
  handoff ;
- le HTTP direct peut exposer un `http_ticket` authentifié uniquement si
  `MCP_HTTP_HANDOFF_ENABLED=true` et si l’identité porte `external:read` ;
- toute opération HTTP directe de status, list, stat, read, hash ou handoff sur
  les racines externes exige `external:read` ;
- le ticket HTTP reste en lecture seule, expurgé de tout chemin physique, borné,
  à usage unique et désactivé par défaut ;
- aucun mode runtime ne gagne d’upload, create, replace, delete ou sync sur une
  racine externe grâce à ce profil de livraison ;
- le contrat de move stdio local séparé porte une planification diagnostique
  d’un fichier régulier dans la même racine ; mutation, rollback et récupération
  automatique sont désactivés sur toutes les plateformes.

| Mode runtime                     | Tools enregistrées                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless-readonly`              | `bases_get_schema`, `bases_list`, `bases_query`, `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `obsidian_validate_format`, `query_tasks`, `smart_semantic_search`                                                                                                                                                          |
| `headless-guarded`               | Tout `headless-readonly`, plus `obsidian_manage_frontmatter`, `obsidian_search_replace`, `obsidian_update_note`                                                                                                                                                                                                                                                                                                                  |
| `headless-filesystem`            | Tout `headless-guarded`, plus `bases_create`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_admin_filesystem`, `obsidian_batch_frontmatter`, `obsidian_delete_note`, `obsidian_manage_canvas`, `obsidian_manage_tags`, `obsidian_move_note`                                                                                                                                                                              |
| `hybrid` API indisponible        | `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `obsidian_validate_format`, `query_tasks`, `smart_semantic_search`                                                                                                                                                                                                           |
| `hybrid` API disponible / `live` | Tools read/search/tasks/runtime/sémantique, plans gouvernés remplacement de note, patch texte, Frontmatter, formules Base et Canvas, plus outils REST d’écriture et Bases Bridge : `bases_create`, `bases_get_schema`, `bases_list`, `bases_query`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_delete_note`, `obsidian_manage_frontmatter`, `obsidian_manage_tags`, `obsidian_search_replace`, `obsidian_update_note` |

## Patch texte gouverné du corps Markdown P4

`obsidian_text_patch_plan`, `obsidian_text_patch_apply`,
`obsidian_text_patch_status` et `obsidian_text_patch_recover` partagent la même
frontière live/hybrid et le même journal Atomic Write que le remplacement de
note gouverné. Ils compilent l’intention explicite append, prepend ou
remplacement littéral avant la création du plan enfant. Les profils live
curatés exposent ce quartet et masquent les fallbacks directs update/search-
replace uniquement lorsque les quatre outils sont présents.

## Frontmatter gouvernée P1

`obsidian_frontmatter_patch_plan`, `obsidian_frontmatter_patch_apply`,
`obsidian_frontmatter_patch_status` et
`obsidian_frontmatter_patch_recover` ne sont enregistrés qu’en `live`, ou en
`hybrid` avec identifiants API. Ils réutilisent l’Atomic Write Bridge désactivé
par défaut et l’autorité durable P0. Ils sont absents des modes headless et du
mode hybrid dégradé.

## Formules Base gouvernées P2

`bases_formula_patch_plan`, `bases_formula_patch_apply`,
`bases_formula_patch_status` et `bases_formula_patch_recover` suivent la même
frontière live/hybrid. Ils exigent en plus Bases Bridge 1.1.0 Atomic V1, avec le
CAS atomique Base activé et les remplacements complets historiques désactivés.

## Canvas gouverné P3

`obsidian_canvas_patch_plan`, `obsidian_canvas_patch_apply`,
`obsidian_canvas_patch_status` et `obsidian_canvas_patch_recover` suivent la
même frontière live/hybrid. Ils exigent Atomic Write Bridge 0.4.0, son gate CAS
Canvas indépendant, un graphe existant valide et l’identité/SHA-256 exacts du
backend. Ils sont absents de tous les modes headless.

## Notes de sécurité

- `headless-readonly` est le premier mode sûr pour une vraie copie Sync.
- `headless-guarded` garde une surface write prudente et ne porte pas les opérations destructives.
- `headless-filesystem` doit être validé sur une copie ou un vault dédié avant tout chemin d’écriture production.
- Les écritures guarded utilisent des chemins relatifs au vault, rejettent les chemins absolus et les traversals, écrivent atomiquement et acceptent des préconditions `expectedHash` ou `expectedMtime`.
- Le move/delete filesystem headless requiert une précondition `expectedHash` ou `expectedMtime`.
- Les tags headless modifient le texte Markdown (`tags` frontmatter ou `#tags` inline) et peuvent produire un index local depuis le cache.
- Le rename global de tags reste une fonction filesystem : dry-run d’abord, puis apply seulement sur copie ou vault serveur dédié.
- `obsidian_admin_filesystem` sert aux opérations admin explicites ; il ne doit pas remplacer les outils de lecture/écriture courants.
- `obsidian_validate_format` est un validateur local. Il améliore la sûreté des sorties agent, mais ne rend pas Obsidian, ne charge pas les plugins et n’évalue pas la sémantique exacte de l’interface Bases.
- `obsidian_manage_canvas` reste volontairement minimal et filesystem-only : create, ajout de nœud texte, connexion de nœuds, validation.
- Le batch frontmatter headless démarre en dry-run et ne supporte que `set` ; les clés protégées restent bloquées par policy.
- Les écritures Bases headless écrivent des fichiers `.base` et des propriétés frontmatter ; elles n’évaluent pas les vues, formules ou propriétés calculées d’Obsidian.
- La politique d’exclusion protège les scans Optimike cache/search/tasks/Bases. Elle n’empêche pas Obsidian Sync de télécharger les fichiers.
- Un service HTTP local doit rester lié au loopback, valider les origines fournies, ignorer les headers de forwarding sans proxy de confiance et employer un port déterministe par défaut.
- Le `/healthz` public est limité à la vie du service et ne divulgue aucun chemin ; l’état détaillé du runtime et de l’intégrité reste derrière l’outil MCP authentifié.
- Un profil HTTP distant reste un pilote derrière des contrôles TLS, auth, proxy et réseau revus. L’exposition publique directe n’est pas supportée.
- Les tickets HTTP d’artefacts exigent une vraie identité authentifiée avec
  `external:read` et n’autorisent jamais une mutation de racine externe. Le HTTP
  direct refuse aussi scan de références, plan/status de move, apply et rollback.
- Une future réparation automatique exige le token adjacent exact
  `external-ref:<rootId>::<chemin-relatif-encode-en-pourcentage>`. Toute
  occurrence ambiguë, historique ou non supportée bloque cette future mutation.
- Le move externe n’a aucun mécanisme de mutation actuel. Le design
  hard-link/unlink retiré est uniquement historique ; une future primitive native
  handle-relative auditée devra définir indépendamment les garanties de
  non-écrasement et de réparation par hash exact.
- Le remplacement gouverné de note complète est live-only ; `recover` est une réconciliation ou reprise du plan exact, jamais un undo.
- Une validation d’écriture headless doit créer un nouveau brouillon dans un dossier sandbox. Elle ne doit pas modifier des notes existantes d’un vrai vault.
