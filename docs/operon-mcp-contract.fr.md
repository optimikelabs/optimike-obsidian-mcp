# Outils Operon dans Optimike Obsidian MCP

English version: [operon-mcp-contract.md](operon-mcp-contract.md)

## Surface

Le serveur MCP principal enregistre vingt-cinq outils Operon :

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
- `operon_create_periodic_task`
- `operon_update_periodic_scheduling`
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

### Compatibilité « vacation-safe »

L’admission d’Operon 3.x dépend du contrat runtime, pas d’une allowlist exacte
de versions produit. Le Bridge exige l’accesseur officiel
`getDeveloperApiV1`, négocie `contractVersion: 1` avec `runtimeApi: 1`, puis
valide les capacités accordées, les schémas de réponse, la santé live, le
catalogue, la pagination complète des tâches et les diagnostics d’index.

Le statut distingue :

- `certified` : version produit appartenant à l’ensemble certifié explicite du
  Bridge et dont l’accesseur Developer API est présent ;
- `compatible-provisional` : release non refusée hors de cet ensemble et dont
  l’accesseur Developer API V1 est présent ;
- `incompatible` : frontière absente, explicitement refusée ou invalide.

Cet état de compatibilité est indépendant de la disponibilité live de l’index.
Avant d’utiliser une route, le client doit aussi exiger `ok` et `index.ready`.
Les capacités principales restent des gates strictes ; l’état froid d’une
capacité additive de premier usage est seulement diagnostique, car seule son
opération exacte peut la négocier.

Une régression comportementale connue peut rester bloquée par version et par
opération. Une capacité optionnelle absente désactive seulement les outils qui
en dépendent. Un futur contrat n’est jamais accepté silencieusement.

`operon_query_saved_filter` est live-only et dépend d’une capacité native. Sur
Operon officiel `3.5.3`, il utilise la Developer API task-workflow après un grant
exact `tasks.filter-query`. L’appelant doit fournir un `filterSetId` exact :
l’API officielle exécute les filtres mais n’en publie pas le catalogue. Une
capacité froide dans le dernier statut ne bloque pas l’appel : le Bridge négocie
uniquement `tasks.filter-query` au premier usage exact. Les rafraîchissements de
statut/index ne demandent aucun grant optionnel. Le MCP ne tente jamais de
reproduire leur sémantique depuis le cache.

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
moteur chargé. Toute release Operon non refusée qui négocie le contrat V1 utilise
les plans typés preview/apply/recovery uniquement après validation des capacités,
schémas, santé, index stabilisé et recovery. Le chemin legacy Kairélys utilise Public API v1. Aucun chemin
ne modifie directement le Markdown, n’appelle `TaskWriter`, ne lance une
commande UI et ne réfléchit vers une méthode privée.

Les plans task-workflow officiels sont des handles opaques liés à la session.
Le MCP ne les reconstruit jamais : la récupération continue uniquement le même
plan via son `recoveryRef`.

Contrôles communs :

- `dryRun` vaut `true` par défaut ;
- `idempotencyKey` est obligatoire ;
- une tâche Operon existante exige `expectedRevision` ;
- l’adoption exige `line` et `expectedLine` exacts ;
- toute release non refusée avec le contrat V1 applique uniquement le plan opaque prévisualisé et scellé par l’hôte après le passage de tous les gates live ;
- `outcome-unknown` est exposé avec sa référence de récupération et n’est jamais
  rejoué à l’aveugle ;
- les résultats Task Workflow sont validés strictement avant projection ; une
  preuve native malformée ou contradictoire reste `outcome-unknown`, et
  `nativeProof` ne contient que la projection de preuve bornée ;
- après apply, le Bridge relit l’index live vérifié et le MCP rafraîchit son
  snapshot SQLite ;
- aucune mutation ne s’appuie sur un snapshot headless ou obsolète.

Le journal MCP `operon_mutation_journal` réserve la clé avant l’appel au Bridge.
Rejouer une requête terminée avec la même clé renvoie le même `operationId` sans
second appel. Réutiliser la clé pour une autre requête renvoie `CONFLICT`. Une
révision périmée renvoie `conflict` sans écriture. Une réservation restée
`in_progress` après timeout ou redémarrage bloque toute nouvelle mutation à
l’aveugle.

Bridge 0.8 réserve aussi les clés d’idempotence atomiquement et persiste son
journal version 1 dans les données locales du plugin Obsidian avant tout dispatch
natif. Ce journal est borné à 500 entrées et 30 jours. Une entrée `in-progress`
restaurée devient `outcome-unknown`, non rejouable, avec
`recoveryRequired: true`. Cette garantie couvre seulement le replay/redémarrage
local borné : aucune promesse après expiration, éviction, perte/reset des données
plugin, échec de persistance ou transfert vers un autre coffre/appareil. Si la
réservation ne peut pas être persistée, aucune mutation native n’est envoyée.

L’apply exige aussi `OPERON_MUTATIONS_ENABLED=true` et le réglage Bridge
**Allow task mutations**. Une mise à jour de package ne peut donc pas activer les
écritures implicitement.

### Politique d’écriture

- `MCP_WRITE_MODE=readonly` : dry-run uniquement.
- `MCP_WRITE_MODE=guarded` : apply d’adoption si la capacité existe, création,
  création Daily/Weekly, mise à jour du scheduling périodique, update,
  transition, remplacement de relations et relocation inline.
- `MCP_WRITE_MODE=full` : conversion et récurrence en plus.
- `operon_recover_mutation` exige aussi le mode `full`, le `recoveryRef` exact
  et une union imbriquée `recovery` portant un `kind` explicite :
  `developer-api`, `adopt`, `periodic-create` ou `periodic-update`.

`OPERON_MUTATION_ALLOWED_PATH_PREFIXES` peut limiter toutes les mutations à des
dossiers relatifs au coffre. Les sources et destinations explicites doivent
rester dans cette allowlist. Operon officiel `3.2.0` refuse encore un
`targetFolder` arbitraire lorsqu’aucun contrat de destination exacte n’existe.
Comme les entrées de récupération ne publient aucune route canonique prouvable
contre cette politique, une allowlist de chemins non vide désactive à la fois
`operon_list_pending_recoveries` et l’apply de récupération. Les deux échouent
fermés avant divulgation de l’inventaire ou dispatch natif.

La conversion reste destructive : file-to-inline déplace le fichier source
dans la corbeille et inline-to-file remplace la ligne source par un lien durable.

### Règles propres aux outils

`operon_adopt_task` utilise l’API task-workflow additive officielle uniquement
après les grants exacts `tasks.adopt.preview` et `tasks.adopt.apply`. Le numéro de
version produit n’est pas un second gate de mutation. Operon applique son plan opaque scellé à une checkbox
exacte. Un moteur legacy compatible peut encore annoncer son contrat borné,
mais un grant officiel absent renvoie une indisponibilité structurée et le MCP
ne simule jamais l’adoption en éditant le Markdown.

`operon_create_task` crée une tâche inline ou fichier par les services officiels
du moteur. Operon `3.2.0` accepte les champs typés, tags, `statusId`, relations,
`targetPath` inline et templates configurés. Les propriétés YAML non gérées et
les `targetFolder` arbitraires restent legacy-only.

`operon_create_task` crée une tâche inline ou fichier par les services de
création d’Operon. `dateScheduled` n’est pas accepté à la création : il faut le
fixer ou l’effacer ensuite exclusivement via
`operon_update_periodic_scheduling`.

`operon_create_periodic_task` crée exactement une tâche inline dans la Daily ou
Weekly Note configurée après les grants périodiques preview/apply exacts. Operon
reste propriétaire du routage par date, des templates, de l’identité du
conteneur et du reçu ; le MCP ne peut pas imposer un chemin ni un parent.
`routeDate` sélectionne la Daily ou Weekly Note, tandis que
`fields.dateScheduled` peut définir la date planifiée initiale de la tâche dans
ce même workflow natif. Le
postflight vérifie `priorityId` contre la priorité stable projetée. Si l’apply a
pu réussir sans qu’une identité créée unique puisse être prouvée, le résultat
reste `outcome-unknown` et le MCP ne rejoue jamais cette création ambiguë.
`operon_update_periodic_scheduling` fixe ou efface `dateScheduled` sur une tâche
exacte déjà créée. C’est le seul outil MCP pour modifier ensuite ce champ :
Operon peut avoir besoin de son workflow périodique additif pour conserver,
détacher ou réaligner la tâche, sans déplacer le Markdown source.

Avec Operon officiel `3.6.0`, le plan public Task Workflow périodique est
uniquement composé de métadonnées : il n’expose aucun chemin de source des
tâches avant apply. La canary de release sur le SHA exact effectue donc la
prévisualisation périodique et la négociation du grant exact, mais saute les
applies périodiques avec la raison `public_task_source_projection_unavailable`.
C’est une limite de confinement et de certification de la canary destructive,
pas une désactivation de l’outil runtime ; la projection publique du chemin de
source reste un suivi amont non bloquant. Ne pas revendiquer une certification
périodique complète à partir de cette gate.

Les champs gérés conservent leur forme officielle : `taskType` et `taskImage`
sont des chaînes scalaires, `taskGallery` est un tableau ordonné sans perte et
les chaînes à séparateurs sont refusées. Le champ dérivé `__taskDataType` est
read-only et ne peut pas entrer dans une création ou une mise à jour.

`operon_update_task` accepte un seul groupe ordinaire par appel : description,
champs gérés/tags ou propriété fichier non gérée lorsque le moteur l’autorise.
Il refuse `dateScheduled`, les relations et la récurrence ; l’appelant doit
utiliser respectivement `operon_update_periodic_scheduling`,
`operon_set_relationships` ou `operon_update_recurrence`. Les statuts passent
par l’outil de transition. Une description différente sur une File Task doit
rester refusée tant qu’un contrat de renommage explicite n’existe pas.

`operon_update_recurrence` modifie uniquement la surface officielle de
récurrence avec un scope explicite `this-task` ou `this-and-following`.
`dateScheduled` n’y est pas accepté : seul
`operon_update_periodic_scheduling` peut le fixer ou l’effacer. `null` efface
un champ de récurrence pris en charge.

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
quoi que ce soit, uniquement lorsque l’allowlist de chemins est vide.
L’entrée publique de `operon_recover_mutation` est
`{ idempotencyKey, recoveryRef, recovery }`. `recovery` vaut soit
`{ kind: "developer-api" }`, soit
`{ kind: "adopt" | "periodic-create" | "periodic-update", planDigest?: sha256 }`.
La branche `developer-api` appelle la récupération Developer API V1 et
n’accepte pas `planDigest`. Seules les trois branches Task Workflow acceptent
un digest SHA-256 optionnel pour lier la récupération au reçu/replay scellé.
Sans ce digest, le Bridge ne peut prouver le lien Task Workflow qu’à partir de
l’entrée correspondante de `pendingRecoveries` ; sinon il échoue fermé avant
dispatch. Les champs `kind` et `planDigest` top-level ne font pas partie du
contrat public ; cette forme plate reste une migration interne candidate/legacy.
Toute allowlist de chemins non vide bloque aussi listing et apply, faute de route
canonique prouvable. La réponse préserve `planDigest` lorsqu’il existe et
`recoveryRef`.

## Preuves du pilote

Le chemin legacy Operon `2.5.0`/Kairélys a historiquement prouvé création,
champs, relations, transitions, conversion, idempotence, conflits de révision,
redémarrage, fallback stale et refus P0 des IDs dupliqués.

Le pilote dédié Operon `3.2.0`, sur le build local corrigé, a prouvé :

- grant officiel, lecture live et plans typés preview/apply ;
- exécution d’un filtre sauvegardé avec pagination opaque ;
- dry-run, postflight, replay idempotent et conflit de révision périmée ;
- relation source/inverse, blocage d’une transition terminale et restauration ;
- ajout, changement de portée et suppression exacte d’une récurrence ;
- redémarrage/récupération stable ;
- 25 tâches après nettoyage, aucune relation ou récurrence résiduelle ;
- validation finale `P0/P1/P2 = 0/0/0`.

Le build local ne diffère de la release que par le correctif du renderer de
réglages nécessaire pour afficher les contrôles de grant Developer API. Les
limites upstream restantes sont #99/#101 et #139. Le Bridge échoue fermé lorsque
le runtime ne peut pas prouver le résultat.

## Capacités indisponibles ou exclues

Suppression, rappels, état épinglé, contrôle/session de timer et
gestion des filtres sauvegardés restent hors de la surface officielle de
mutation agentique. L’**exécution** d’un filtre sauvegardé fonctionne sur
Operon `3.5.3` avec un ID exact et le grant requis ; la découverte du catalogue,
la création et l’édition des filtres ne sont pas exposées. L’adoption est
disponible après ses grants additifs exacts et les gates live communs.

La suppression reste une action opérateur dans la CLI. Un futur
`operon_trash_task` ne pourra être envisagé qu’avec restauration garantie sous
le même `operonId`, relations réconciliées, journal durable et confirmation
humaine explicite. Il n’est pas implémenté.

## Admission 3.2.0

Optimike MCP `3.2.0`, Bridge `0.8.3`, Operon `3.6.0`,
Operon CLI `1.2.0` et Local REST API `5.1.0` forment l’ensemble de validation
courant ; ils ne revendiquent aucun tag `3.2.0` publié. Operon `3.6.0` reste
`compatible-provisional` jusqu’à son entrée dans l’ensemble explicite de preuves
certifiées, mais ce libellé ne masque plus les mutations valides. La version
produit reste une métadonnée diagnostique pouvant sélectionner un refus ou une
exception bornée ; elle n’est pas une allowlist positive de mutation. Contrat,
grants exacts, schémas, santé live, index stabilisé, politique d’écriture et
recovery restent obligatoires.

Le statut task-workflow est un diagnostic, pas une liste de refus préalable. La
première adoption ou opération périodique atteint le Bridge, qui ne demande que
le grant additif exact de ce workflow, mais seulement si le statut prouve encore
que le réglage global de mutation du Bridge est activé. Ce réglage est exposé
séparément des capacités d’écriture déjà négociées, afin qu’une session entièrement
froide ne soit pas prise pour un Bridge globalement en lecture seule. Les Bridges
antérieurs à ce champ explicite conservent leur gate par capacité annoncée et ne
bénéficient pas du nouveau passage à froid. Un grant en attente, refusé ou malformé
échoue fermé sans révoquer les sessions principales déjà établies. La création
périodique ne persiste aucune réservation d’idempotence avant la réussite de
cette négociation : la même requête et la même clé peuvent être rejouées après
l’approbation manuelle. Le journal MCP ne libère lui aussi qu’une réservation
certifiée pré-dispatch par le Bridge (`mutationMayHaveApplied: false`) ; toute
erreur ambiguë de transport ou post-dispatch reste durable et échoue fermé. Un
statut ordinaire, sain ou dégradé, ne négocie jamais les grants additifs de
filtre, workflow ou recovery ; seules l’opération exacte ou la surface de
récupération dédiée peuvent le faire.

Le contrat public Developer API V1 n’a pas dérivé entre Operon `3.5.3` et
`3.6.0`. Cette dernière modifie néanmoins le nettoyage relationnel via Task
Editor, autorise une Scheduled Date sur une tâche bloquée et peut étendre, par
automatisation opt-in, la plage de dates d’un parent après la mutation d’un
enfant. Ces comportements doivent être testés dans la configuration active du
coffre ; ils n’autorisent jamais l’acceptation d’une dérive postflight non liée.
