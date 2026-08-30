# Obsidian Bases Bridge

Plugin compagnon pour **optimike-obsidian-mcp**. Il ajoute une vue headless « Bridge (Headless) » et étend **Obsidian Local REST API** avec des routes spécialisées pour les fichiers `.base`. Depuis 1.1.0, il fournit aussi un CAS typé lié au coffre pour la surface gouvernée de formules. La version 1.2.0 supervise durablement Local REST et la vue headless : un démarrage tardif ou un reload remonte une seule génération sans redémarrer le MCP et sans modifier les gates d’écriture.

## Installation rapide

1. Télécharger l’artefact CI `obsidian-bases-bridge`, ou construire le plugin avec `npm ci` puis `npm run check` dans ce dossier.
2. Créer `.obsidian/plugins/obsidian-bases-bridge/` et y copier `main.js` et `manifest.json` depuis l’artefact ou depuis `build/`.
3. Lancer Obsidian → *Settings → Community plugins* → activer **Bases Bridge (REST)**.
4. Vérifier que le plugin **Local REST API** est actif (v3.x) et que le coffre est autorisé.
5. Dans chaque base ciblée, activer la vue « Bridge (Headless) » pour profiter des valeurs évaluées par l’engine.

La CI exécute les tests, construit le plugin et publie ces deux fichiers installables. Le package MCP vérifie également qu’ils sont bien présents avant distribution.

## Endpoints exposés

Préfixe officiel (recommandé) :

- `GET /extensions/obsidian-bases-bridge/bases`
- `GET /extensions/obsidian-bases-bridge/bases/:id/schema`
- `POST /extensions/obsidian-bases-bridge/bases/:id/query`
- `POST /extensions/obsidian-bases-bridge/bases/:id/upsert`
- `POST /extensions/obsidian-bases-bridge/bases`
- `GET /extensions/obsidian-bases-bridge/bases/:id/config`
- `PUT /extensions/obsidian-bases-bridge/bases/:id/config`
- `GET /extensions/obsidian-bases-bridge/atomic/status`
- `POST /extensions/obsidian-bases-bridge/atomic/bases/read`
- `POST /extensions/obsidian-bases-bridge/atomic/bases/cas`

Alias legacy (compat MCP) :

- `GET /bases`
- `GET /bases/:id/schema`
- `POST /bases/:id/query`
- `POST /bases/:id/upsert`
- `POST /bases`
- `GET /bases/:id/config`
- `PUT /bases/:id/config`

Les routes héritent de l’authentification Bearer + TLS local du plugin REST.

## Écritures de configuration

Les écritures sont désactivées par défaut. Le réglage **Autoriser le CAS
atomique des Bases** active uniquement le contrat Atomic V1 : fichier `.base`
existant, empreinte exacte du backend, précondition SHA-256 et remplacement via
`Vault.process`. Le réglage de compatibilité legacy réactive explicitement les
remplacements complets via `PUT /config` et `POST /bases`; sans lui, ces routes
n’acceptent que la validation et refusent l’effet. La surface MCP recommandée
est `bases_formula_patch_*`, pas l’envoi de YAML arbitraire.

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
