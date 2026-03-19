# Guide d’exploitation Optimike Obsidian MCP

Version anglaise : [OPERATIONS.md](OPERATIONS.md)

![Architecture runtime Optimike Obsidian MCP](docs/assets/runtime-architecture-optimike-obsidian-mcp.png)

Ce guide explique comment le serveur tourne réellement, de quoi il dépend, comment Tasks et la recherche sémantique fonctionnent, et ce qui permet de garder une faible empreinte mémoire.

## Modèle runtime

Le runtime final repose sur deux couches :

1. `dist/stdio-proxy.js`
   - wrapper stdio léger pour Codex et les autres clients MCP
   - démarre ou réutilise le backend local
   - garde la partie client MCP peu coûteuse
2. `dist/index.js` en mode HTTP
   - backend local long-lived
   - possède le store SQLite partagé
   - gère les refreshs, le mode dégradé et la santé runtime

C’est la raison principale pour laquelle le serveur consomme maintenant moins de mémoire dans Codex : l’état lourd du vault n’est plus reconstruit dans chaque process stdio enfant.

## Ce qui vit sur disque

Store partagé par défaut :

```text
<vault>/.obsidian/optimike-mcp/shared-cache.sqlite
```

Le store partagé contient :

- `file_cache` : contenu et métadonnées des notes
- `task_file_cache` : données Tasks parsées et réutilisées par `list_all_tasks` et `query_tasks`
- `semantic_manifest` : métadonnées sémantiques pour éviter des rescans `.smart-env` inutiles
- `semantic_vectors` : métadonnées côté vecteurs

Ce qui reste en RAM :

- uniquement le backend actif
- un hot cache de contenu borné
- un petit état runtime pour le mode dégradé, la disponibilité sémantique et les refreshs récents

## Comment la mémoire reste basse

Le design final réduit la mémoire de quatre façons :

1. le `stdio` est devenu léger
   - Codex parle à `stdio-proxy.js`
   - le backend lourd est réutilisé au lieu d’être relancé

2. le contenu des notes est persisté
   - le serveur ne garde plus tout le vault chaud en mémoire
   - le contenu est lu depuis SQLite d’abord, puis depuis le disque ou REST seulement si nécessaire

3. Tasks réutilise la même couche persistée
   - le parsing Tasks relit le contenu partagé des notes
   - le serveur évite un second chemin de scan brutal pour un autre MCP Tasks

4. les refreshs sémantiques sont incrémentaux
   - les métadonnées sémantiques sont persistées
   - les warm refreshs consultent SQLite avant de reparcourir tout `.smart-env`

Variables de tuning utiles :

- `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT`
- `OBSIDIAN_SHARED_CACHE_DB_PATH`
- `OBSIDIAN_STARTUP_BLOCKING=false` pour un démarrage non bloquant plus confortable sous WSL

## Dépendances requises

Le serveur final peut exposer des capacités différentes selon les plugins Obsidian et services locaux disponibles.

### Dépendance Obsidian de base

- accès au vault via `OBSIDIAN_VAULT`

### Plugins Obsidian

- Local REST API
  - utilisé pour la majorité des opérations live sur les notes
  - configuré via `OBSIDIAN_BASE_URL` et `OBSIDIAN_API_KEY`

- Bases Bridge (REST)
  - requis pour le support `.base`
  - expose les endpoints Bases consommés par ce MCP

- Smart Connections
  - requis pour la recherche sémantique
  - les artefacts attendus vivent sous :

```text
<vault>/.smart-env
```

- plugin Obsidian Tasks
  - requis pour un comportement Tasks canonique
  - fichier de config attendu :

```text
<vault>/.obsidian/plugins/obsidian-tasks-plugin/data.json
```

## Tasks : comment ça marche maintenant

Tasks n’est plus un MCP séparé requis pour Codex.

Le MCP principal expose maintenant :

- `list_all_tasks`
- `query_tasks`

Chemin d’exécution :

1. le contenu des notes est synchronisé dans `file_cache`
2. le parsing Tasks réutilise ce contenu
3. les tâches parsées sont écrites dans `task_file_cache`
4. les requêtes Tasks réutilisent cette couche persistée au lieu de rescanner tout le vault sur le chemin chaud

Résultat :

- une seule entrée MCP dans Codex
- un seul backend local
- un seul modèle de données persisté

Le repo legacy `optimike-obsidian-tasks-mcp` peut encore exister, mais Codex n’en a plus besoin quand ce serveur principal est utilisé.

## Recherche sémantique : ce qui est persisté et ce qui ne l’est pas

La recherche sémantique est plus rapide et plus stable qu’avant, mais une dépendance reste toujours vivante au moment de la requête.

Persisté :

- manifest sémantique
- métadonnées vecteurs
- dimension dominante et état de cache associé

Toujours vivant au moment de la requête :

- le provider d’embedding pour la requête

Exemples :

- si ton vault sémantique repose sur Ollama, Ollama doit toujours être joignable pour exécuter une requête sémantique
- si Ollama tombe, le MCP renvoie maintenant une erreur propre au lieu de sembler freezer

## Mode dégradé

Si Obsidian REST n’est plus joignable mais que le cache partagé est chaud, le backend peut encore servir des opérations de lecture seule pour :

- `obsidian_read_note`
- `obsidian_list_notes`

Le but est de garder le MCP utile quand Obsidian tombe temporairement, tout en rendant l’état explicite.

## Santé et maintenance

### Health HTTP

```bash
curl http://127.0.0.1:3010/healthz
curl http://127.0.0.1:3010/healthz?integrity=1
```

Ce que tu obtiens :

- mode runtime
- état du mode dégradé
- stats de cache
- stats sémantiques
- résultat d’intégrité SQLite si demandé

### Tools MCP runtime

- `obsidian_runtime_status`
- `obsidian_runtime_maintenance`

Actions de maintenance supportées :

- `integrity_check`
- `run_maintenance`
- `refresh_vault_cache`
- `refresh_semantic_cache`
- `refresh_tasks_cache`
- `refresh_all`

## Setup Codex minimal

Codex doit pointer vers :

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js"]
```

Variables importantes :

- `MCP_HTTP_HOST`
- `MCP_HTTP_PORT`
- `MCP_PROXY_START_TIMEOUT_MS`
- `OBSIDIAN_VAULT`
- `SMART_ENV_DIR`
- `OBSIDIAN_BASE_URL`
- `OBSIDIAN_API_KEY`

Comportement de démarrage recommandé :

```toml
OBSIDIAN_STARTUP_BLOCKING = "false"
```

Ça garde le démarrage de Codex réactif pendant que le health check du backend finit en arrière-plan.

## Dépannage

### La recherche sémantique échoue

Vérifie :

- `SMART_ENV_DIR`
- la disponibilité du provider d’embedding
- l’état runtime via `obsidian_runtime_status`

### Les résultats Tasks semblent stale

Lance :

- `obsidian_runtime_maintenance` avec `refresh_tasks_cache`

### Les notes se lisent mais les mises à jour live échouent

État probable :

- mode dégradé lecture actif
- Obsidian REST down ou injoignable

Vérifie :

- `OBSIDIAN_BASE_URL`
- le plugin Local REST API
- `obsidian_runtime_status`

### La mémoire grimpe trop

Vérifie :

- que les clients pointent vers `dist/stdio-proxy.js` et non `dist/index.js`
- la limite de hot cache via `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT`
- qu’un ancien backend MCP ne tourne pas encore

## Modèle mental recommandé

Pense au serveur comme :

- une seule surface MCP
- un seul backend réutilisable
- un seul état local persisté
- un provider sémantique live en option

C’est la forme finale visée du produit.
