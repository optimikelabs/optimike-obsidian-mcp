# Outils Operon dans Optimike Obsidian MCP

English version: [operon-mcp-contract.md](operon-mcp-contract.md)

## Surface

Le serveur MCP principal enregistre vingt-trois outils Operon :

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
- `operon_adopt_task`
- `operon_create_task`
- `operon_update_task`
- `operon_transition_task`
- `operon_set_relationships`
- `operon_update_recurrence`
- `operon_convert_task`
- `operon_relocate_task`
- `operon_list_pending_recoveries`
- `operon_recover_mutation`

Il n’existe pas de second serveur MCP. Tous ces outils partagent le même runtime,
la même politique d’écriture, le même cache SQLite et le même journal durable.

`operon_get_configuration` lit dans le runtime Operon les réglages qui changent
le sens, la création ou le workflow des tâches. Le MCP ne duplique pas le
parsing de `data.json`. La réponse porte une signature déterministe et indique
explicitement lorsqu’elle provient d’un fallback headless obsolète.

## Pourquoi le MCP ne relaie pas simplement la CLI

La CLI est une surface large destinée à l’opérateur : diagnostics natifs,
administration, investigation de récupération et actions ponctuelles. Le MCP
est la surface de contrôle destinée aux agents.

Une opération n’entre dans le MCP que si elle possède un contrat sémantique
borné et les garanties correspondantes :

- schéma d’entrée étroit et capacité officielle annoncée par le runtime ;
- moindre privilège et double opt-in pour les écritures ;
- `dryRun` par défaut et plan officiel scellé ;
- `expectedRevision` pour empêcher l’écriture sur un état périmé ;
- `idempotencyKey` durable pour empêcher une seconde application ;
- vérification postflight dans l’index live ;
- journal et récupération du plan exact après un résultat incertain ;
- refus structuré sans fallback Markdown, API privée ou commande UI.

Un passthrough CLI générique contournerait ces garanties, exposerait des
commandes trop larges et rendrait les changements de capacités invisibles pour
l’agent. La disponibilité d’une commande CLI ne suffit donc pas à en faire un
outil MCP.

## Lectures et fraîcheur

Chaque lecture déclare `source`, `stale`, l’heure et l’âge du snapshot, les
versions Operon/Bridge, la version du contrat, les capacités et les limites.

- `operon-live` : pagination complète et validation cohérentes avec une seule
  génération et une seule signature de réglages Operon.
- `operon-cache` : dernier snapshot SQLite validé, toujours obsolète et jamais
  utilisé comme preuve d’une mutation.

Un payload invalide, une pagination tronquée, une génération instable, des IDs
dupliqués, une version incompatible, un index non prêt ou une validation P0
n’écrasent jamais le dernier snapshot sain.

`operon_query_saved_filter` est live-only et dépend d’une capacité native. La
version officielle Operon `3.1.1` ne l’annonce pas actuellement : l’outil reste
enregistré pour compatibilité mais renvoie une indisponibilité structurée. Le
MCP ne tente pas de reproduire le moteur de filtres depuis le cache.

Les six lectures Developer API supplémentaires sont également live-only :
diagnostics, recherche classée, résolution d’entité, graphe de relations borné,
pack de contexte borné et état du timer. Les résultats, profondeurs et champs
hydratés sont plafonnés. Le Markdown source brut, l’historique des trackers ou
rappels et les packs non nécessaires restent exclus.

Les agents doivent préférer les `statusId`, `pipelineId` et noms canoniques
renvoyés par `operon_get_configuration`. Les libellés visibles en français ou en
anglais ne sont pas des identifiants d’automatisation durables.

## Mutations

Les mutations passent par les routes REST du Bridge et la surface officielle du
moteur chargé. Operon `3.1.1` utilise les plans typés preview/apply/recovery de
Developer API V1. Le chemin legacy Kairélys utilise Public API v1. Aucun chemin
ne modifie directement le Markdown, n’appelle `TaskWriter`, ne lance une
commande UI et ne réfléchit vers une méthode privée.

Contrôles communs :

- `dryRun` vaut `true` par défaut ;
- `idempotencyKey` est obligatoire ;
- une tâche Operon existante exige `expectedRevision` ;
- l’adoption legacy exige `line` et `expectedLine` exacts ;
- Operon `3.1.1` applique uniquement le plan prévisualisé et scellé par l’hôte ;
- `outcome-unknown` est exposé avec sa référence de récupération et n’est jamais
  rejoué à l’aveugle ;
- après apply, le Bridge relit l’index live vérifié et le MCP rafraîchit son
  snapshot SQLite ;
- aucune mutation ne s’appuie sur un snapshot headless ou obsolète.

Le journal `operon_mutation_journal` réserve la clé avant l’appel au Bridge.
Rejouer une requête terminée avec la même clé renvoie le même `operationId` sans
second appel. Réutiliser la clé pour une autre requête renvoie `CONFLICT`. Une
révision périmée renvoie `conflict` sans écriture. Une réservation restée
`in_progress` après timeout ou redémarrage bloque toute nouvelle mutation à
l’aveugle.

L’apply exige aussi `OPERON_MUTATIONS_ENABLED=true` et le réglage Bridge
**Allow task mutations**. Une mise à jour de package ne peut donc pas activer les
écritures implicitement.

### Politique d’écriture

- `MCP_WRITE_MODE=readonly` : dry-run uniquement.
- `MCP_WRITE_MODE=guarded` : apply d’adoption si la capacité existe, création,
  update, transition, remplacement de relations et relocation inline.
- `MCP_WRITE_MODE=full` : conversion et récurrence en plus.
- `operon_recover_mutation` exige aussi le mode `full` et ne récupère que le
  `recoveryRef` exact.

`OPERON_MUTATION_ALLOWED_PATH_PREFIXES` peut limiter toutes les mutations à des
dossiers relatifs au coffre. Les sources et destinations explicites doivent
rester dans cette allowlist. Operon officiel `3.1.1` refuse encore un
`targetFolder` arbitraire lorsqu’aucun contrat de destination exacte n’existe.

La conversion reste destructive : file-to-inline déplace le fichier source
dans la corbeille et inline-to-file remplace la ligne source par un lien durable.

### Règles propres aux outils

`operon_adopt_task` est un outil de compatibilité enregistré, pas une capacité
officielle d’Operon `3.1.1`. Un moteur legacy compatible peut adopter une
checkbox exacte avec verrouillage du chemin, de la ligne et du contenu source.
Operon officiel renvoie une indisponibilité structurée et le MCP ne simule pas
l’adoption en éditant le Markdown.

`operon_create_task` crée une tâche inline ou fichier par les services officiels
du moteur. Operon `3.1.1` accepte les champs typés, tags, `statusId`, relations,
`targetPath` inline et templates configurés. Les propriétés YAML non gérées et
les `targetFolder` arbitraires restent legacy-only.

`operon_update_task` accepte un seul groupe par appel : description, champs
gérés/tags ou propriété fichier non gérée lorsque le moteur l’autorise. Les
statuts passent par l’outil de transition. Une description différente sur une
File Task doit rester refusée tant qu’un contrat de renommage explicite n’existe
pas.

`operon_transition_task` préfère un `statusId` stable et accepte un libellé de
workflow exact uniquement pour compatibilité. Les dépendances, récurrences,
agrégats et gardes de workflow restent appliqués par Operon. Un résultat
incertain est renvoyé tel quel sans retry.

`operon_set_relationships` remplace ou supprime explicitement `parentTask`,
`blocking` et `blockedBy`. Il refuse doublon, auto-référence et cible placée dans
les deux directions. Operon valide le graphe/cycle et le Bridge vérifie la tâche
source ainsi que chaque relation inverse modifiée.

`operon_update_recurrence` modifie uniquement la surface officielle de
récurrence avec une portée `this-task` ou `this-and-following`. `null` supprime
explicitement un champ. La récurrence n’est jamais simulée par
`operon_update_task` et son apply exige le mode `full`.

`operon_convert_task` convertit inline et fichier par les chemins officiels de
transition. File-to-inline exige un `targetPath` explicite.

`operon_relocate_task` déplace une tâche inline vers un `targetPath` Markdown
explicite en conservant `operonId`. Le Bridge vérifie source et destination
après stabilisation de l’index.

`operon_list_pending_recoveries` liste les références officielles sans appliquer
quoi que ce soit. `operon_recover_mutation` récupère un seul plan exact et
préserve ses preuves `planDigest` et `recoveryRef`.

## Preuves du pilote

Le chemin legacy Operon `2.5.0`/Kairélys a historiquement prouvé création,
champs, relations, transitions, conversion, idempotence, conflits de révision,
redémarrage, fallback stale et refus P0 des IDs dupliqués.

Le pilote dédié Operon `3.1.1`, sur le build local corrigé, a ensuite prouvé :

- grant officiel, lecture live et plans typés preview/apply ;
- dry-run, postflight, replay idempotent et conflit de révision périmée ;
- relation source/inverse, blocage d’une transition terminale et restauration ;
- ajout, changement de portée et suppression exacte d’une récurrence ;
- redémarrage/récupération stable ;
- 25 tâches après nettoyage, aucune relation ou récurrence résiduelle ;
- validation finale `P0/P1/P2 = 0/0/0`.

La version officielle non corrigée conserve les limites upstream #99/#101,
#135, #137 et #139. Le Bridge échoue fermé lorsque le runtime ne peut pas
prouver le résultat.

## Capacités indisponibles ou exclues

Suppression, rappels, état épinglé, contrôle/session de timer, adoption et
gestion des filtres sauvegardés restent hors de la surface officielle de
mutation agentique. Les outils adoption et filtre sauvegardé restent enregistrés
pour compatibilité mais renvoient une indisponibilité sur Operon officiel
`3.1.1`.

La suppression reste une action opérateur dans la CLI. Un futur
`operon_trash_task` ne pourra être envisagé qu’avec restauration garantie sous
le même `operonId`, relations réconciliées, journal durable et confirmation
humaine explicite. Il n’est pas implémenté.
