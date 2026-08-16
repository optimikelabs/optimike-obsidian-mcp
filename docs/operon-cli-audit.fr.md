# Audit CLI Operon / Developer API

English version: [operon-cli-audit.md](operon-cli-audit.md)

Date : 2026-08-17

Référence : Operon officiel `3.3.2` admis provisoirement par contrat, Operon
`3.2.1` certifié, Operon CLI `1.1.2`, Developer API V1 et
`cli-manifest-v1.json`.

Les observations CLI initiales du 1er août 2026 utilisaient Operon `3.0.1` et
restent des preuves historiques. L’adaptateur MCP certifie `3.2.1` et admet
`3.3.2` provisoirement après négociation du contrat. Le pilote live complet
`3.3.2` avec CLI `1.1.2` est vert : les contrôles de grant dans les réglages,
le refus des renommages implicites de File Tasks et le règlement des
transitions sans portée Project Serial sont corrigés upstream. L’adoption reste
indisponible dans l’API développeur officielle et est suivie dans
[#140](https://github.com/hasanyilmaz/operon/issues/140). Le MCP échoue fermé et
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

Le MCP enregistre vingt-trois outils gouvernés, dont six lectures de raisonnement
Developer API bornées. L’exécution des filtres sauvegardés fonctionne lorsque
le contrat négocié annonce `tasks.filter-query`, après un grant exact, mais l’API officielle ne
publie pas leur catalogue. L’adoption reste un outil de compatibilité
indisponible :

- lectures : statut, configuration, liste/get/query, filtre sauvegardé borné par
  capacité et validation ;
- lectures de raisonnement : diagnostics, finder, résolution, relations,
  contexte et état du timer ;
- mutations : adoption bornée par capacité, création, update, transition,
  relations, récurrence, conversion et relocation ;
- récupération : liste des plans incertains et récupération d’un plan exact.

La CLI et Developer API exposent une surface plus large : santé, capacités,
catalogue, diagnostics, recherche/résolution, contexte, relations, timer, mais
aussi rappels, état épinglé, contrôle/session du timer et suppression.

La différence est volontaire. Le MCP expose seulement une opération sémantique
avec un cas d’usage ÉLYSIA clair, une capacité officielle et des gardes prouvées.

## Classement des extensions

| Candidate | Utilité ÉLYSIA | Risque | Décision |
| --- | --- | --- | --- |
| diagnostics | Élevée | Faible | Implémenté en lecture seule |
| finder / résolution | Élevée | Faible | Implémenté avec résultats bornés |
| lecture des relations | Élevée | Moyen | Implémenté avec racine exacte, profondeur et plafond |
| pack de contexte | Élevée | Moyen | Implémenté avec projections et hydratation allowlistée |
| état du timer | Moyenne | Faible | Lecture seulement, aucun contrôle |
| écriture de relations | Élevée | Moyen à élevé | Implémentée avec révision, plan scellé, postflight inverse et récupération |
| écriture de récurrence | Moyenne à élevée | Élevé | Implémentée avec portée explicite, mode full, postflight et récupération |
| rappels | Moyenne | Élevé | Différé, reste dans la CLI |
| contrôle/session du timer | Moyenne | Élevé | Différé, change l’exécution active |
| état épinglé | Faible à moyenne | Moyen | Différé, préférence de présentation |
| suppression | Moyenne | Destructif | Refusée sans contrat de corbeille réversible |
| commande CLI générique | Non bornée | Élevé | Rejetée, contournerait le contrat Bridge |

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
