# Obsidian Bases Bridge

Plugin compagnon pour **optimike-obsidian-mcp**. Il ajoute une vue headless « Bridge (Headless) » et étend le plugin **Obsidian Local REST API** avec des routes spécialisées pour les fichiers `.base`. Les agents MCP peuvent ainsi interroger les Bases via REST, éditer les propriétés des notes (frontmatter) et créer/mettre à jour les fichiers `.base` (YAML).

## Installation rapide

1. Copier ce dossier dans `.obsidian/plugins/`.
2. Lancer Obsidian → *Settings → Community plugins* → activer **Bases Bridge (REST)**.
3. Vérifier que le plugin **Local REST API** est actif (v3.x) et que le coffre est autorisé.
4. Dans chaque base ciblée, activer la vue « Bridge (Headless) » pour profiter des valeurs évaluées par l’engine.

## Endpoints exposés

Préfixe officiel (recommandé) :

- `GET /extensions/obsidian-bases-bridge/bases`
- `GET /extensions/obsidian-bases-bridge/bases/:id/schema`
- `POST /extensions/obsidian-bases-bridge/bases/:id/query`
- `POST /extensions/obsidian-bases-bridge/bases/:id/upsert`
- `POST /extensions/obsidian-bases-bridge/bases`
- `GET /extensions/obsidian-bases-bridge/bases/:id/config`
- `PUT /extensions/obsidian-bases-bridge/bases/:id/config`

Alias legacy (compat MCP) :

- `GET /bases`
- `GET /bases/:id/schema`
- `POST /bases/:id/query`
- `POST /bases/:id/upsert`
- `POST /bases`
- `GET /bases/:id/config`
- `PUT /bases/:id/config`

Les routes héritent de l’authentification Bearer + TLS local du plugin REST.

## Upsert robuste

`POST /bases/:id/upsert` accepte :

- `operations` : tableau `{ file, set?, unset?, expected_mtime? }`
- `continueOnError` : poursuit le lot après une erreur individuelle
- `dryRun` : valide les fichiers, les `mtime` et les clés sans écrire

Garde-fous :

- `file.*` et `formula.*` sont refusés car ce sont des champs virtuels/calculés.
- `création`, `creation` et `modification` sont refusés car ils peuvent être auto-gérés par le coffre.
- Les timeouts `processFrontMatter` sont classés en `write_timeout`, ce qui permet au MCP de retry l’opération seule après backoff.

Usage recommandé pour les lots sensibles : commencer par `dryRun: true`, puis écrire en petits chunks côté MCP.
