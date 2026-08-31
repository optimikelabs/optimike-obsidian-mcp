# Audit CLI Operon / Developer API

English version: [operon-cli-audit.md](operon-cli-audit.md)

Mise à jour : 2026-08-31

Cible candidate : Optimike MCP `3.8.1` utilise le Bridge `0.9.2` avec Operon
officiel `3.6.1`, Operon CLI `1.2.0`, Local REST API `5.1.0`, Developer API V1
et API task-workflow additive. L’admission Pilot 2 reste liée au SHA final
propre. Le contrat public Developer API V1 n’a pas dérivé depuis la frontière
validée en `3.6.0`. Operon `3.6.1` restaure aussi la réapprobation explicite,
dans les réglages, d’un grant suspendu cohérent ; une tentative périmée,
révoquée ou dont le binding a dérivé reste bloquée. `compatible-provisional` décrit le niveau de certification,
pas une allowlist de mutation : l’admission dépend du contrat et des capacités
live exactes. Les workflows additifs négocient leur grant exact au premier usage
après un démarrage à froid ; un grant absent, refusé ou malformé échoue toujours
fermé.

Operon CLI `1.2.0` ajoute la surface opérateur pour le routage Daily/Weekly et
les champs typés Task Type, Task Image et Task Gallery ordonnée. Le MCP ne
relaie pas la CLI génériquement : il expose uniquement les deux opérations
périodiques bornées et l’adoption officielle après leurs grants exacts. Operon
reste propriétaire de chaque plan opaque scellé et de sa récupération same-plan.
`taskType` et `taskImage` restent scalaires, `taskGallery` reste un tableau
ordonné et `__taskDataType` est read-only.

Le plan public Task Workflow périodique d’Operon officiel `3.6.0` est
uniquement composé de métadonnées et n’expose aucun chemin de source des tâches
avant apply. La canary de release sur le SHA exact effectue toujours la
prévisualisation périodique et la négociation du grant exact, mais saute les
applies périodiques avec la raison `public_task_source_projection_unavailable`.
C’est une limite de confinement et de certification de la canary destructive ;
les outils runtime restent disponibles et la projection publique du chemin de
source est un suivi amont non bloquant. Ne pas revendiquer une certification
périodique complète. Les gates startup, adoption, médias, Frontmatter Date
Manager, idempotence et restauration restent obligatoires.

Operon `3.6.0` modifie trois comportements produit qui restent hors du contrat
d’écriture générique du MCP : la suppression via Task Editor nettoie les
relations enfant directes et de blocage ; une tâche bloquée peut recevoir une
Scheduled Date ; et l’automatisation opt-in des dates parent peut étendre la
plage de dates d’un parent après la mutation d’un enfant. La gate comportementale
Pilot 2 sur le worktree a exercé la Scheduled Date via `operon_update_periodic_scheduling` : la
relation de blocage et son arête inverse sont préservées, puis le parent
périodique créé par ce run est supprimé pendant la restauration exacte. La
suppression Task Editor reste `SKIP` faute de surface publique MCP ; l’expansion
des dates parent reste `SKIP` car la configuration publique de Pilot 2 n’annonce
pas cette automatisation opt-in active. Les opérateurs qui activent ces fonctions
doivent tester ces deux comportements avant de s’y appuyer. Un postflight
n’accepte jamais une dérive non liée du parent ou des relations comme une
écriture validée.
L’apply Scheduled Date décrit ci-dessus reste une preuve historique/diagnostique
du worktree uniquement. La canary sur le SHA exact ne la répète pas : elle
effectue la prévisualisation périodique et la négociation du grant exact, puis
retourne `SKIP` avec la raison `public_task_source_projection_unavailable`.

## Acceptation historique 3.3.2

Les observations CLI initiales du 1er août 2026 utilisaient Operon `3.0.1` et
restent des preuves historiques. L’adaptateur MCP certifie `3.2.1` et admet
`3.3.2` provisoirement après négociation du contrat. Le pilote live complet
`3.3.2` avec CLI `1.1.2` est vert : les contrôles de grant dans les réglages,
le refus des renommages implicites de File Tasks et le règlement des
transitions sans portée Project Serial sont corrigés upstream. L’adoption était
indisponible dans cette génération d’API et suivie dans
[#140](https://github.com/hasanyilmaz/operon/issues/140). Operon `3.5.3`
l’expose désormais après des grants additifs exacts. Le MCP échoue fermé et
ne bascule jamais vers Markdown ou une API privée.

## Décision

Conserver le Bridge comme plan de contrôle destiné aux agents ÉLYSIA. Il donne
au MCP un contrat de tâche stable et normalisé, la vérification de génération
live, `expectedRevision`, l’idempotence, les deux opt-ins de mutation, le
postflight et une récupération bornée au même plan.

Conserver la CLI comme surface opérateur/admin pour l’acceptation native, les
diagnostics approfondis, l’investigation de récupération, l’administration
large et les actions ponctuelles.

Ne pas exposer de passthrough CLI générique dans le MCP. Une commande disponible
dans la CLI n’est pas automatiquement sûre, utile ou suffisamment bornée pour
un agent.

## Comparaison des surfaces

Le MCP enregistre vingt-cinq outils gouvernés, dont six lectures de raisonnement
Developer API bornées. L’exécution des filtres sauvegardés fonctionne lorsque
le contrat négocié annonce `tasks.filter-query`, après un grant exact, mais l’API officielle ne
publie pas leur catalogue. L’adoption et les workflows de notes périodiques
restent bornés par capacité :

- lectures : statut, configuration, liste/get/query, filtre sauvegardé borné par
  capacité et validation ;
- lectures de raisonnement : diagnostics, finder, résolution, relations,
  contexte et état du timer ;
- mutations : adoption bornée par capacité, création, création Daily/Weekly,
  mise à jour du scheduling périodique, update, transition,
  relations, récurrence, conversion et relocation ;
- récupération : liste des plans incertains et récupération d’un plan exact.

La CLI et Developer API exposent une surface plus large : santé, capacités,
catalogue, diagnostics, recherche/résolution, contexte, relations, timer, mais
aussi rappels, état épinglé, contrôle/session du timer et suppression.

La différence est volontaire. Le MCP expose seulement une opération sémantique
avec un cas d’usage ÉLYSIA clair, une capacité officielle et des gardes prouvées.

## Classement des extensions

| Candidate                 | Utilité ÉLYSIA   | Risque        | Décision                                                                   |
| ------------------------- | ---------------- | ------------- | -------------------------------------------------------------------------- |
| diagnostics               | Élevée           | Faible        | Implémenté en lecture seule                                                |
| finder / résolution       | Élevée           | Faible        | Implémenté avec résultats bornés                                           |
| lecture des relations     | Élevée           | Moyen         | Implémenté avec racine exacte, profondeur et plafond                       |
| pack de contexte          | Élevée           | Moyen         | Implémenté avec projections et hydratation allowlistée                     |
| état du timer             | Moyenne          | Faible        | Lecture seulement, aucun contrôle                                          |
| écriture de relations     | Élevée           | Moyen à élevé | Implémentée avec révision, plan scellé, postflight inverse et récupération |
| écriture de récurrence    | Moyenne à élevée | Élevé         | Implémentée avec portée explicite, mode full, postflight et récupération   |
| rappels                   | Moyenne          | Élevé         | Différé, reste dans la CLI                                                 |
| contrôle/session du timer | Moyenne          | Élevé         | Différé, change l’exécution active                                         |
| état épinglé              | Faible à moyenne | Moyen         | Différé, préférence de présentation                                        |
| suppression               | Moyenne          | Destructif    | Refusée sans contrat de corbeille réversible                               |
| commande CLI générique    | Non bornée       | Élevé         | Rejetée, contournerait le contrat Bridge                                   |

## Frontière de preuve actuelle

Le build local Operon `3.2.0` a passé le grant et l’identité hôte, les
lectures live, preview/apply typés, receipt/postflight, replay idempotent,
redémarrage et récupération du même plan. Le pilote Bridge a aussi passé
création, update, transition, conflit de révision et replay.

Les relations et la récurrence ont passé les suites adaptateur, contrat Bridge,
service, policy, idempotence/redémarrage et documentation, puis leur pilote live
dédié : dry-run/apply, relation inverse, replay, conflit périmé, blocage de
transition terminale, restauration exacte, ajout/changement de portée/retrait de
récurrence, redémarrage stable, exécution d’un filtre avec pagination opaque,
source live, 25 tâches après nettoyage, aucun résidu et `P0/P1/P2 = 0/0/0`.

L’acceptation live `3.3.2` a aussi prouvé une transition non terminale de
Planifié vers En cours, puis sa restauration exacte vers Planifié via l’API
officielle. Les deux applies ont rendu un résultat terminal ; la fixture a été
supprimée par la CLI opérateur après sauvegarde. Le coffre est revenu à 30
tâches, sans recovery, avec `P0/P1/P2 = 0/0/0`.

Les autres écritures avancées restent hors MCP jusqu’à disposer chacune d’un
contrat preview/apply, révision, postflight, récupération et confirmation
humaine adapté.

## Preuves historiques du pilote CLI Windows

Le 1er août 2026, la CLI officielle `1.0.0` a passé version, manifeste, schéma,
setup, profil, doctor offline, `health`, `task.get`, `tasks.query` et
`context.build` avec un profil temporaire isolé sur le coffre ÉLYSIA.

Sur cette version, plusieurs handlers pourtant annoncés par `health` échouaient
avant leur exécution avec `obsidian-cli-exit-failed` ou
`persistent-write-failed`. Cette preuve reste historique et ne doit pas être
présentée comme l’état de la CLI `1.1.2`. Son bootstrap/health Windows et la
suppression opérateur exacte ont été validés pendant l’acceptation `3.3.2`, sans
requalifier pour autant chaque observation historique de la `1.0.0`.

La conclusion d’architecture ne change pas : la CLI est la surface opérateur
large. Le MCP/Bridge reste le contrat agentique indépendant, borné et vérifiable.
