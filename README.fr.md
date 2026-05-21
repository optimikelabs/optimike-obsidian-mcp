# Optimike Obsidian MCP

Version anglaise : [README.md](README.md)
Guide d’exploitation : [OPERATIONS.fr.md](OPERATIONS.fr.md)
Operations guide (EN) : [OPERATIONS.md](OPERATIONS.md)

![Hero Optimike Obsidian MCP](docs/assets/hero-optimike-obsidian-mcp.png)

Serveur MCP (Model Context Protocol) pour Obsidian avec cache local partagé, outils Tasks intégrés et recherche sémantique basée sur Smart Connections.

## TL;DR

```bash
npm install
npm run build
node dist/stdio-proxy.js
```

Recommandation Codex : pointer la config MCP vers `dist/stdio-proxy.js`, pas directement vers `dist/index.js`.

## Prérequis

- Node.js >= 22.7.5
- Obsidian Desktop pour le mode `live`. Les modes headless demandent seulement un chemin de vault local.
- Plugins :
  - Local REST API (obligatoire pour les outils REST) : https://github.com/coddingtonbear/obsidian-local-rest-api
  - Smart Connections (obligatoire pour la recherche sémantique) : https://github.com/brianpetro/obsidian-smart-connections
  - Bases Bridge (REST) (obligatoire pour les outils `.base`, inclus dans ce repo)
  - plugin Obsidian Tasks (obligatoire pour un comportement Tasks canonique)
- Pour la recherche sémantique, assure-toi que ton vault contient un dossier `.smart-env`

## Installation

Depuis le repo :

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
```

Lancer l’entrypoint MCP recommandé :

```bash
node dist/stdio-proxy.js
```

## Pourquoi

- Connecter Obsidian à des agents MCP (Codex, IDE, etc.)
- Exposer les outils REST Obsidian (lecture/écriture, frontmatter, tags, recherche)
- Offrir une recherche vectorielle locale via Smart Connections (`.smart-env`)
- Garder un backend local durable au lieu de respawner tout l’état lourd à chaque run stdio

## Ce qu'il sait faire

Optimike Obsidian MCP donne aux agents une façon structurée de travailler avec un coffre Obsidian :

- lire, lister, modifier et rechercher des notes
- gérer le frontmatter et les tags
- interroger et mettre à jour les Bases Obsidian via le Bases Bridge inclus
- inspecter et requêter les tâches Obsidian Tasks
- lancer une recherche sémantique sur un index Smart Connections
- vérifier la santé du serveur, l'état du cache, le mode dégradé et la politique d'écriture

En clair : il ne fait pas seulement de la lecture de notes. Il expose le coffre comme une vraie surface MCP opérationnelle, avec outils de lecture/écriture, opérations structurées sur les métadonnées, Tasks, Bases, recherche sémantique et observabilité de l'état du serveur.

## Usage backend partagé

Le backend durable est utile en local, mais il prend encore plus d'intérêt dans une configuration avec backend partagé ou déporté.

Au lieu de synchroniser et indexer le coffre séparément pour chaque client agentique, les clients peuvent parler à un seul backend MCP qui porte le cache, les métadonnées sémantiques, le cache Tasks et les opérations Obsidian. Le backend doit toujours avoir accès au coffre lui-même, à un chemin de coffre monté, ou à l'API REST Obsidian, mais les clients agents n'ont pas chacun besoin d'une synchronisation complète du vault ni de leur propre couche d'indexation.

Le MCP devient donc une frontière pratique entre les agents et Obsidian : les agents appellent des tools, le backend gère le coffre.

## Points forts

- Outils MCP complets (notes, frontmatter, tags, recherche globale, etc.)
- Outils Tasks intégrés : `list_all_tasks` et `query_tasks`
- Recherche sémantique locale `smart_semantic_search`
- Outils de santé/état du serveur : `obsidian_runtime_status` et `obsidian_runtime_maintenance`
- Mode dégradé lecture seule pour `obsidian_read_note` et `obsidian_list_notes` si Obsidian REST tombe
- Store SQLite partagé pour le contenu du vault, le cache Tasks et le manifest sémantique
- Embedder-agnostic : aligne automatiquement la requête sur le modèle du vault
- Support Ollama / OpenAI (override par env vars) ; Xenova / Transformers est désactivé tant que sa chaîne ONNX/protobuf vulnérable ne peut pas être réintroduite proprement

## Architecture (vue d'ensemble)

1) **Obsidian** + plugins (Local REST API, Bases Bridge, Smart Connections)  
2) **Optimike Obsidian MCP** (ce serveur)  
3) **Agents MCP** (Codex, IDE, etc.)

Le serveur agit comme un **pont** entre tes agents et Obsidian, ajoute une couche “Base” pour les fichiers `.base`, et persiste l’état runtime local pour garder Codex rapide et stable au fil des sessions.

## Bases Bridge (REST) — pourquoi et comment

Obsidian ne fournit pas d’API native pour interroger les Bases (`.base`).  
Le plugin **Bases Bridge (REST)** comble ce manque en ajoutant des endpoints REST dédiés.

### Endpoints exposés par Bases Bridge

Préfixe officiel (recommandé) :

- `GET /extensions/obsidian-bases-bridge/bases`  
  Liste toutes les bases disponibles.
- `GET /extensions/obsidian-bases-bridge/bases/:id/schema`  
  Retourne le schéma (propriétés, formules, vues).
- `POST /extensions/obsidian-bases-bridge/bases/:id/query`  
  Interroge une base (filtres, tri, pagination, evaluate).
- `POST /extensions/obsidian-bases-bridge/bases/:id/upsert`  
  Met à jour le frontmatter de notes en masse.
- `POST /extensions/obsidian-bases-bridge/bases`  
  Crée/valide une base `.base`.
- `GET /extensions/obsidian-bases-bridge/bases/:id/config`  
  Lit le YAML d’une base.
- `PUT /extensions/obsidian-bases-bridge/bases/:id/config`  
  Met à jour le YAML d’une base.

Alias legacy (compat MCP) :

- `GET /bases`
- `GET /bases/:id/schema`
- `POST /bases/:id/query`
- `POST /bases/:id/upsert`
- `POST /bases`
- `GET /bases/:id/config`
- `PUT /bases/:id/config`

### Engine / Evaluate

Quand `evaluate: true`, le bridge renvoie :
- `source: "engine"` : cache auto + évaluation des formules (sans vue Bridge)
- `source: "fallback"` : calcul partiel sur disque si l’engine est OFF

## Outils MCP liés aux Bases

Le serveur expose des tools MCP “Base” (via Obsidian MCP) :

- `bases_list` : liste toutes les bases
- `bases_get_schema` : récupère le schéma d’une base
- `bases_query` : requête paginée avec filtres/tri
- `bases_upsert_rows` : mise à jour de frontmatter en masse
- `bases_upsert_config` : valider ou mettre à jour la configuration YAML/JSON d’une base
- `bases_create` : créer/valider une base `.base`

## Modèle Runtime Final

Le repo supporte maintenant deux modes locaux :

- `stdio proxy` : recommandé pour Codex, un petit wrapper `stdio` qui démarre au besoin un backend HTTP local
- `http backend` : le vrai process long-lived qui porte le cache partagé et les warmups

Le backend persiste désormais :

- le contenu du vault dans un cache SQLite partagé
- un hot cache RAM borné
- un manifest sémantique (`semantic_manifest`, `semantic_vectors`) dans la même base

La même base stocke donc :

- `file_cache` pour le contenu des notes
- `task_file_cache` pour les données Tasks déjà parsées
- `semantic_manifest` et `semantic_vectors` pour le chemin sémantique

Chemin par défaut :

```text
<vault>/.obsidian/optimike-mcp/shared-cache.sqlite
```

Variables utiles :

- `OBSIDIAN_RUNTIME_MODE=live|hybrid|headless-readonly|headless-guarded|headless-filesystem` pour choisir le contrat runtime
- `OBSIDIAN_SHARED_CACHE_DB_PATH`
- `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT`
- `OBSIDIAN_CACHE_SOURCE=auto|filesystem|rest` pour choisir la source de refresh cache (`auto` privilégie le vault local quand il existe)
- `OBSIDIAN_CACHE_CONCURRENCY` pour borner le travail filesystem local
- `OBSIDIAN_VAULT_EXCLUDE_PATTERNS` pour ajouter des exclusions façon gitignore, séparées par virgules ou retours ligne, au-dessus de la politique de sécurité intégrée
- `MCP_WRITE_MODE=readonly|guarded|full` pour imposer la sécurité d’écriture côté serveur (`full` est le défaut ; définir explicitement `guarded` ou `readonly` pour durcir un hôte)
- `MCP_GUARDED_MAX_WRITE_CHARS` et `MCP_GUARDED_MAX_BATCH_OPERATIONS` pour régler les limites du mode guarded

Pour tester sur un vrai coffre, définir `OBSIDIAN_SHARED_CACHE_DB_PATH` hors du coffre afin que les bases SQLite de validation ne polluent pas l’arbre synchronisé.

Politique d’exclusion du vault :

- Les exclusions intégrées couvrent `.obsidian`, `.trash`, `.git`, `.tmp`, `tmp`, `node_modules`, les dossiers de screenshots, les dossiers build/cache, les fichiers SQLite/DB et les logs.
- `OBSIDIAN_VAULT_EXCLUDE_PATTERNS` permet d’ajouter les exclusions propres au coffre, par exemple `tmp/**,**/tmp/**,Efforts/Archives/**`.
- Les exclusions s’appliquent aux refreshs filesystem du cache et aux scans du fallback local Bases. Elles ne promettent pas la parité Desktop et n’empêchent pas Obsidian Sync de télécharger les fichiers ; pour cela, il faut un profil serveur/vault propre côté Sync.
- `npm run check:vault-exclusions -- --vault=/chemin/vers/vault` affiche l’effet de la politique avant une validation headless longue.

Le MCP principal absorbe aussi la surface `Tasks`, donc Codex n’a plus besoin d’un deuxième `optimike-obsidian-tasks-mcp`.
Les refreshs sémantiques à chaud relisent SQLite d’abord, puis seulement `.smart-env` si nécessaire.

Scripts utiles :

```bash
npm run build
npm run start:proxy
npm run start:http
npm run test:runtime
npm run smoke:headless-readonly
npm run smoke:hybrid-unavailable
npm run smoke:hybrid-api-available
npm run smoke:headless-guarded
npm run smoke:headless-filesystem
npm run smoke:headless-status
npm run check:vault-exclusions -- --vault=/chemin/vers/vault
```

## Modes runtime

- `live` (défaut) : Obsidian Desktop + Local REST API. Surface complète REST, writes et Bases Bridge.
- `hybrid` : démarre depuis le vault/cache local et utilise Local REST API quand `OBSIDIAN_API_KEY` est configurée. Le check API au démarrage n’est pas bloquant. Si aucune clé API n’est configurée, `OBSIDIAN_VAULT` est requis.
- `headless-readonly` : sans Obsidian Desktop, sans Local REST API, sans `OBSIDIAN_API_KEY`. Requiert `OBSIDIAN_VAULT` et `OBSIDIAN_CACHE_SOURCE=filesystem`; expose lecture, liste, recherche, Tasks, sémantique, runtime, plus `bases_list`, `bases_get_schema` et `bases_query` en fallback local readonly.
- `headless-guarded` : sans Obsidian Desktop ; expose la surface read headless + écritures filesystem bornées pour `obsidian_update_note`, `obsidian_search_replace` et `obsidian_manage_frontmatter`. Les updates de note sont limitées à append/prepend ; overwrite reste bloqué par la politique guarded. Le fallback local Bases readonly est aussi disponible.
- `headless-filesystem` : sans Obsidian Desktop ; expose `headless-guarded` plus les features filesystem bornées : tags YAML frontmatter, delete avec `expectedHash` ou `expectedMtime`, création/config YAML `.base`, et rows Bases comme opérations `set` de frontmatter Markdown.

Headless signifie : Optimike MCP tourne au-dessus d’un vault Markdown synchronisé. Cela ne signifie pas que Desktop, les plugins communautaires, la command palette, l’active file ou Bases Bridge sont disponibles sans Obsidian Desktop.

`npm run test:runtime` lance le build, les smokes runtime principaux et le smoke HTTP health/status. Il utilise des vaults temporaires et ne dépend ni d’un vrai coffre Obsidian, ni d’une clé API réelle. Les smokes headless vérifient aussi qu’un contenu exclu sous `tmp/**` n’est pas indexé.

Pour le comparatif mode par mode, voir [Matrice des capacités runtime](docs/runtime-capability-matrix.fr.md).
Pour le chemin serveur dédié, voir [Profil serveur headless](docs/headless-server-profile.fr.md).

Fallback local Bases :

- `bases_list`, `bases_get_schema` et `bases_query` sont disponibles en modes headless avec `source: "local-fallback"`.
- Le fallback lit les YAML `.base` depuis `OBSIDIAN_VAULT` et le frontmatter Markdown depuis le cache partagé.
- Il supporte les filtres par égalité directe, le tri simple, la pagination et l’inspection de schéma.
- Il n’évalue pas les formules Obsidian, les filtres spécifiques à des plugins, les propriétés calculées, ni la sémantique exacte des vues UI.

Health et maintenance :

```bash
curl http://127.0.0.1:3010/healthz
curl http://127.0.0.1:3010/healthz?integrity=1
```

Et via MCP :

- `obsidian_runtime_status`
- `obsidian_runtime_maintenance`

Sécurité d’écriture runtime :

- `readonly` bloque tous les outils d’écriture hors opérations de validation pure
- `guarded` autorise les écritures explicites et bornées, mais bloque suppression, overwrite, unset frontmatter, regex replace-all large et gros batchs
- `full` est le défaut et conserve le comportement d’écriture complet pour un environnement local de confiance

Les écritures filesystem guarded acceptent `expectedHash` et `expectedMtime`. Préférer `expectedHash` sur un coffre synchronisé ou multi-agent : une note modifiée entre lecture et écriture produit alors un conflit explicite au lieu d’un écrasement silencieux.

Contrôle du contexte agent :

- `obsidian_list_notes` supporte `responseMode="compact"`, `limit` et `cursor`
- `obsidian_global_search` supporte `responseMode="compact"` en gardant la pagination `page/pageSize`
- `list_all_tasks` et `query_tasks` supportent `responseMode="compact"|"detailed"`, `responseLimit` et `cursor`
- la lecture d’une note identifiée reste complète via `obsidian_read_note`

Checks typiques :

```bash
curl http://127.0.0.1:3010/healthz
curl http://127.0.0.1:3010/healthz?integrity=1
```

## Configuration Codex minimale

Dans `~/.codex/config.toml` :

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/chemin/vers/optimike-obsidian-mcp/dist/stdio-proxy.js"]

[mcp_servers.optimike-obsidian-mcp-stdio.env]
MCP_HTTP_HOST = "127.0.0.1"
MCP_HTTP_PORT = "3010"
MCP_PROXY_START_TIMEOUT_MS = "20000"
OBSIDIAN_VAULT = "/chemin/vers/<vault>"

# Smart Connections
SMART_ENV_DIR = "/chemin/vers/<vault>/.smart-env"
ENABLE_QUERY_EMBEDDING = "true"

# Recommandé : auto (ne rien setter)
# QUERY_EMBEDDER = "auto"

# Obsidian REST (si plugin Local REST API actif)
OBSIDIAN_BASE_URL = "http://localhost:27123"
OBSIDIAN_API_KEY  = "<token>"

# Comportement au démarrage (optionnel, recommandé pour un boot plus rapide sous WSL)
# OBSIDIAN_STARTUP_BLOCKING=false démarre le MCP immédiatement et lance le health check en arrière-plan.
OBSIDIAN_STARTUP_MAX_RETRIES = "2"
OBSIDIAN_STARTUP_RETRY_DELAY_MS = "1200"
OBSIDIAN_STARTUP_BLOCKING = "false"

# Cache partagé (optionnel)
# OBSIDIAN_SHARED_CACHE_DB_PATH = "/chemin/vers/<vault>/.obsidian/optimike-mcp/shared-cache.sqlite"
# OBSIDIAN_CONTENT_HOT_CACHE_LIMIT = "64"
```

Notes :
- Garde cette config en local dans `~/.codex/config.toml` (ne pas commit des chemins machine personnels).
- Dans la doc, utilise des chemins logiques (`/chemin/vers/...`) et garde les chemins réels uniquement en local.
- `dist/index.js` reste l’entrypoint backend, mais Codex doit pointer vers `dist/stdio-proxy.js`.

## Réglage Local REST API (Obsidian)

Repo du plugin Local REST API :
https://github.com/coddingtonbear/obsidian-local-rest-api

Dans Obsidian :

1. installe et active **Local REST API**
2. active le serveur HTTP
3. copie la clé API
4. renseigne `OBSIDIAN_BASE_URL` et `OBSIDIAN_API_KEY` dans les variables d’env du MCP

Exemple :

```bash
export OBSIDIAN_BASE_URL=http://127.0.0.1:27123
export OBSIDIAN_API_KEY=<ta_cle_api>
```

## Sécurité

- Garde `OBSIDIAN_API_KEY` privée et locale.
- N’expose pas l’API REST d’Obsidian sur Internet.
- Garde `OBSIDIAN_API_KEY` et `OPENAI_API_KEY` dans les variables d’env, pas dans des fichiers de config commités.

## WSL2 + Obsidian sous Windows (Local REST API)

Si Obsidian tourne sur Windows et Codex dans WSL2 :

- `127.0.0.1` côté WSL pointe vers WSL, pas vers Windows
- utilise l’IP du host Windows (gateway WSL) pour `OBSIDIAN_BASE_URL`

Exemple :

```bash
GW=$(ip route | awk '/default/ {print $3; exit}')
export OBSIDIAN_BASE_URL=http://$GW:27123
```

Si tu utilises un portproxy Windows, adapte simplement le port.

## Surface MCP principale

Le MCP principal inclut maintenant :

- outils notes : lecture, listing, update, search-replace, tags, frontmatter
- outils Bases : list, schema, query, create, upsert config, upsert rows
- outils Tasks : `list_all_tasks`, `query_tasks`
- outils sémantiques : `smart_semantic_search`, `smart_search`, `smart-search`
- outils santé/état du serveur : `obsidian_runtime_status`, `obsidian_runtime_maintenance`

## Plugins Obsidian requis ou utiles

Plugins requis selon les surfaces utilisées :
- **Local REST API** : API Obsidian requise par le MCP.
- **Bases Bridge (REST)** : support `.base` via REST.
- **Smart Connections** : index vectoriel et `.smart-env` pour la recherche sémantique.

## Recherche sémantique (Smart Connections)

Tool : `smart_semantic_search` (alias : `smart_search`, `smart-search`).

Exemple :

```json
{ "query": "publication X threads", "top_k": 10, "with_snippets": false }
```

Le serveur :
- lit `.smart-env/multi/*.ajson`
- choisit la dimension dominante
- encode la requête avec le même modèle que le vault
- persiste un manifest sémantique dans SQLite pour accélérer les refreshs à chaud
- préchauffe la recherche sémantique au démarrage en chargeant le snapshot et en réveillant l’embedder de requête
- renvoie `timings_ms`, `vector_count` et `filtered_count` pour diagnostiquer le coût réel

Important :
- l’exécution d’une requête sémantique exige toujours un provider de requête joignable
- si le vault repose sur Ollama et qu’Ollama est down, l’erreur remonte clairement au lieu de bloquer silencieusement
- `SEMANTIC_SEARCH_PREWARM=false` désactive le préchauffage au démarrage

Autrement dit :

- le chemin des métadonnées sémantiques est maintenant durable et observable
- la requête finale dépend toujours d’un provider d’embedding vivant au moment de l’appel

## Providers (override optionnel)

**Ollama (local)**

```bash
export QUERY_EMBEDDER=ollama
export QUERY_EMBEDDER_MODEL=snowflake-arctic-embed2
export OLLAMA_BASE_URL=http://127.0.0.1:11434
```

**Xenova / Transformers**

Le provider local Xenova est désactivé pour l’instant, car sa chaîne de dépendances ONNX/protobuf remontait des vulnérabilités `npm audit`. Utiliser Ollama en local, ou OpenAI en mode cloud.

**OpenAI (cloud)**

```bash
export QUERY_EMBEDDER=openai
export QUERY_EMBEDDER_MODEL=text-embedding-3-small
export OPENAI_API_KEY=...
# export OPENAI_EMBEDDING_DIMENSIONS=1024
```

## MCP partage : portabilité

Pour un MCP partagé, ne pas figer un `OLLAMA_BASE_URL` global dans le vault.
Laisser le mode auto et laisser chaque utilisateur overrider par env vars.

## Repo Tasks legacy

`optimike-obsidian-tasks-mcp` peut encore exister comme repo standalone legacy, mais Codex n’en a plus besoin quand ce serveur principal est utilisé. Le MCP canonique est maintenant celui-ci.

## WSL + Ollama Windows (recommandé)

Si Obsidian tourne sur Windows et Ollama aussi :

1) définir `OLLAMA_HOST=0.0.0.0:11434` sur Windows
2) redémarrer Ollama
3) tester depuis WSL :

```bash
GW=$(ip route | awk '/default/ {print $3; exit}')
curl http://$GW:11434/api/tags
```

Puis, si besoin :

```bash
export OLLAMA_BASE_URL=http://$GW:11434
```

## Credits

- Créé par **Optimike** (Mickaël Ahouansou)
- Base technique inspirée par `cyanheads/obsidian-mcp-server`

## License

Voir `LICENSE`.
