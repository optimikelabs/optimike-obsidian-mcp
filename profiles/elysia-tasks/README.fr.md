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
