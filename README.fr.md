# Optimike Obsidian MCP

Version anglaise : [README.md](README.md)

Serveur MCP (Model Context Protocol) pour Obsidian avec recherche sémantique basée sur Smart Connections.

## TL;DR

```bash
npm install
npm run build
node dist/index.js --stdio
```

## Prérequis

- Node.js >= 16
- Obsidian Desktop
- Plugins :
  - Local REST API (obligatoire pour les outils REST) : https://github.com/coddingtonbear/obsidian-local-rest-api
  - Smart Connections (obligatoire pour la recherche sémantique) : https://github.com/brianpetro/obsidian-smart-connections
  - Bases Bridge (REST) (obligatoire pour les outils .base, inclus dans ce repo)
- Pour la recherche sémantique, assure-toi que ton vault contient un dossier `.smart-env` (créé par Smart Connections)

## Installation

Depuis le repo :

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
```

Lancer :

```bash
node dist/index.js --stdio
```

## Pourquoi

- Connecter Obsidian à des agents MCP (Codex, IDE, etc.)
- Exposer les outils REST Obsidian (lecture/écriture, frontmatter, tags, recherche)
- Offrir une recherche vectorielle locale via Smart Connections (`.smart-env`)

## Points forts

- Outils MCP complets (notes, frontmatter, tags, recherche globale, etc.)
- Recherche sémantique locale `smart_semantic_search`
- Embedder-agnostic : aligne automatiquement la requête sur le modèle du vault
- Support Ollama / Xenova / OpenAI (override par env vars)

## Architecture (vue d'ensemble)

1) **Obsidian** + plugins (Local REST API, Bases Bridge, Smart Connections)  
2) **Optimike Obsidian MCP** (ce serveur)  
3) **Agents MCP** (Codex, IDE, etc.)

Le serveur agit comme un **pont** entre tes agents et Obsidian, et ajoute une couche “Base” pour les fichiers `.base`.

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

## Configuration minimale (Codex)

Dans `~/.codex/config.toml` :

```toml
[mcp_servers.optimike-obsidian-mcp]
command = "node"
args = ["/ABSOLUTE/PATH/optimike-obsidian-mcp/dist/index.js", "--stdio"]

tool_timeout_sec = 900

[mcp_servers.optimike-obsidian-mcp.env]
# Smart Connections
SMART_ENV_DIR = "/ABSOLUTE/PATH/TO/YOUR/VAULT/.smart-env"
ENABLE_QUERY_EMBEDDING = "true" # optionnel (défaut : true)

# Recommandé : auto (ne rien setter)
# QUERY_EMBEDDER = "auto"

# Obsidian REST (si plugin Local REST API actif)
OBSIDIAN_BASE_URL = "http://localhost:27123"
OBSIDIAN_API_KEY  = "<token>"
```

## Réglage Local REST API (Obsidian)

Repo du plugin Local REST API :
https://github.com/coddingtonbear/obsidian-local-rest-api

Dans Obsidian, installe et active **Local REST API**.

1) Ouvre les réglages du plugin  
2) Active le serveur HTTP  
3) Copie la clé API  
4) Renseigne l’URL + clé dans tes variables d’env

Exemple :

```
OBSIDIAN_BASE_URL=http://127.0.0.1:27123
OBSIDIAN_API_KEY=<ta_cle_api>
```

Note : en WSL2, `127.0.0.1` pointe vers WSL, pas Windows.  
Si Obsidian tourne sur Windows, utilise l’IP host (voir section WSL).

## Sécurité

- Garde `OBSIDIAN_API_KEY` privée et locale.
- N'expose pas l'API REST d'Obsidian sur Internet.
- Si tu partages des configs, garde les secrets dans les variables d'env.

## WSL2 + Obsidian sous Windows (Local REST API)

Si Obsidian tourne sur Windows et Codex dans WSL2 :

- `127.0.0.1` côté WSL pointe vers WSL, pas vers Windows.
- Utilise l’IP du host Windows (gateway WSL) pour `OBSIDIAN_BASE_URL`.

Exemple (WSL) :

```bash
GW=$(ip route | awk '/default/ {print $3; exit}')
export OBSIDIAN_BASE_URL=http://$GW:27123
```

Si tu as un portproxy Windows (ex. `27124` → `27123`), alors :

```bash
export OBSIDIAN_BASE_URL=http://$GW:27124
```

## Compagnons Obsidian (recommandés)

Plugins à activer pour que tout fonctionne :
- **Local REST API** : API Obsidian requise par le MCP (https://github.com/coddingtonbear/obsidian-local-rest-api).
- **Bases Bridge (REST)** : support `.base` via REST.
- **Smart Connections** : index vectoriel et `.smart-env` pour la recherche sémantique (https://github.com/brianpetro/obsidian-smart-connections).

### Bases Bridge (REST) — inclus dans ce repo

Le plugin est inclus dans `plugins/obsidian-bases-bridge`.

Installation locale (Obsidian) :

1) Copier `plugins/obsidian-bases-bridge` dans ton vault :  
   `<vault>/.obsidian/plugins/obsidian-bases-bridge`
2) Dans Obsidian : Réglages → Community plugins → activer **Obsidian Bases Bridge**

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

## Providers (override optionnel)

Plus de détails : [README_EMBEDDERS.md](README_EMBEDDERS.md)

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
Ne commite pas de secrets : garde `OBSIDIAN_API_KEY` / `OPENAI_API_KEY` dans les variables d'env.

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

## Dépannage rapide

- WSL2 + Obsidian sur Windows : utilise l'IP du host Windows pour `OBSIDIAN_BASE_URL` (voir section WSL).
- Pas de `.smart-env` : lance Smart Connections pour générer les embeddings (recommandé). Si tu veux seulement les outils REST, tu peux mettre `ENABLE_QUERY_EMBEDDING=false`.
- Mauvais embedder : laisse le mode auto, ou fixe `QUERY_EMBEDDER` + `QUERY_EMBEDDER_MODEL` (voir README_EMBEDDERS.md).

## Credits

- Créé par **Optimike** (Mickaël Ahouansou)
- Base technique inspirée par `cyanheads/obsidian-mcp-server`
- Plugin Local REST API : `coddingtonbear/obsidian-local-rest-api`
- Recherche sémantique basée sur Smart Connections : `brianpetro/obsidian-smart-connections`

## License

Voir `LICENSE`.
