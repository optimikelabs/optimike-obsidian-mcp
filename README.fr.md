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

- Node.js >= 16
- Obsidian Desktop
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

## Points forts

- Outils MCP complets (notes, frontmatter, tags, recherche globale, etc.)
- Outils Tasks intégrés : `list_all_tasks` et `query_tasks`
- Recherche sémantique locale `smart_semantic_search`
- Outils d’exploitation : `obsidian_runtime_status` et `obsidian_runtime_maintenance`
- Mode dégradé lecture seule pour `obsidian_read_note` et `obsidian_list_notes` si Obsidian REST tombe
- Store SQLite partagé pour le contenu du vault, le cache Tasks et le manifest sémantique
- Embedder-agnostic : aligne automatiquement la requête sur le modèle du vault
- Support Ollama / Xenova / OpenAI (override par env vars)

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
- `bases_get_config` / `bases_upsert_config` : lire/écrire le YAML
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

- `OBSIDIAN_SHARED_CACHE_DB_PATH`
- `OBSIDIAN_CONTENT_HOT_CACHE_LIMIT`

Le MCP principal absorbe aussi la surface `Tasks`, donc Codex n’a plus besoin d’un deuxième `optimike-obsidian-tasks-mcp`.
Les refreshs sémantiques à chaud relisent SQLite d’abord, puis seulement `.smart-env` si nécessaire.

Scripts utiles :

```bash
npm run build
npm run start:proxy
npm run start:http
```

Health et maintenance :

```bash
curl http://127.0.0.1:3010/healthz
curl http://127.0.0.1:3010/healthz?integrity=1
```

Et via MCP :

- `obsidian_runtime_status`
- `obsidian_runtime_maintenance`

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
- outils runtime : `obsidian_runtime_status`, `obsidian_runtime_maintenance`

## Compagnons Obsidian (recommandés)

Plugins à activer pour que tout fonctionne :
- **Local REST API** : API Obsidian requise par le MCP.
- **MCP Tools** (Jack Steam) : expose les outils MCP dans Obsidian.
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

Important :
- l’exécution d’une requête sémantique exige toujours un provider de requête joignable
- si le vault repose sur Ollama et qu’Ollama est down, l’erreur remonte clairement au lieu de bloquer silencieusement

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

**Xenova (Transformers)**

```bash
export QUERY_EMBEDDER=xenova
export QUERY_EMBEDDER_MODEL_HINT=bge-384   # ou e5 / snowflake / etc.
```

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
