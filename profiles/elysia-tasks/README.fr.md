# Profil de gestion des tâches ÉLYSIA

Ce dossier publie les conventions portables de gestion des tâches ÉLYSIA sans publier le `data.json` d’un coffre.

Le profil décrit :

- les identifiants stables du pipeline, des statuts et des priorités ;
- les libellés français et anglais ;
- les racines autorisées pour les tâches actives et les captures ;
- la politique de création et de template ;
- les cinq filtres canoniques ;
- le contrat de mutation pour les agents.

Il ne contient ni tâche, ni `operonId` réel, ni chemin absolu, ni layout personnel, ni cache, ni réglage privé.

## Choix de langue

Le profil est français par défaut. Les automatisations doivent utiliser les IDs (`pl_project`, `st_project_planned`, etc.), jamais les libellés visibles. Les traductions anglaises sont fournies pour construire un profil anglais compatible sans casser les clients MCP.

Changer les libellés d’un pipeline déjà utilisé modifie les valeurs visibles stockées dans les tâches. Une migration FR ↔ EN doit donc être faite comme une migration de données : inventaire, dry-run, transitions par `statusId`, validation puis application. Changer seulement la langue de l’interface Kairélys ne nécessite pas de réécrire les tâches.

## Templates

ÉLYSIA utilise le template minimal natif du pipeline. Il doit ajouter uniquement les champs canoniques nécessaires : `operonId`, création, modification, statut et priorité. Les conventions de projet, de création ou de note quotidienne restent la responsabilité des templates ÉLYSIA/Obsidian ; elles ne doivent pas être recopiées dans un template de tâche Kairélys.

Cette séparation évite qu’une modification de template Obsidian change silencieusement la sémantique MCP des tâches.

## Application

La V1 est un contrat documenté et validable, pas un importeur aveugle. Avant application dans un coffre :

1. lire la configuration live avec `operon_get_configuration` ;
2. comparer les IDs, chemins et sémantiques ;
3. produire un dry-run des changements ;
4. appliquer par petits lots via l’API publique du moteur ;
5. valider avec `operon_validate` et les cinq filtres canoniques.

Le fichier de référence est [`v1/profile.json`](v1/profile.json).

## Skill agentique publique

La skill portable [`elysia-task-gouverneur`](skills/elysia-task-gouverneur/SKILL.md) permet à un agent de piloter ce profil via les 13 outils `operon_*` du MCP Optimike.

Elle couvre :

- création, adoption, mise à jour, transition, conversion et relocalisation ;
- audit et triage par saved filters ;
- cycle de vie des backlogs de projet ;
- diagnostic du runtime et du cache ;
- dry-run, révisions optimistes, idempotence et preuve après application.

La skill ne contient aucun chemin absolu, aucune tâche réelle, aucun identifiant privé et aucune copie de configuration `data.json`. Les règles propres à un coffre doivent être fournies comme politique locale au moment de l’exécution.

La version publique suit son propre versionnement et n’est pas un miroir automatique d’une configuration privée. Toute évolution doit être promue après contrôle de portabilité et de non-régression.

Pour l’installer dans un runtime Agent Skills, copier le dossier complet :

```text
profiles/elysia-tasks/skills/elysia-task-gouverneur/
```

Conserver aussi `profiles/elysia-tasks/v1/profile.json` accessible à l’agent lorsqu’il doit vérifier ou installer la conformité complète au profil.
