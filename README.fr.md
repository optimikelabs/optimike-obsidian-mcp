# Optimike Obsidian MCP

[![Dernière version](https://img.shields.io/github/v/release/optimikelabs/optimike-obsidian-mcp?display_name=tag&sort=semver)](https://github.com/optimikelabs/optimike-obsidian-mcp/releases/latest)

English version: [README.md](README.md) · [Hub documentaire](docs/README.fr.md) · [Exploitation](OPERATIONS.fr.md) · [Sécurité](SECURITY.fr.md)

![Vue d’ensemble d’Optimike Obsidian MCP entre clients agentiques, Obsidian et documents externes gouvernés](docs/assets/readme/overview.fr.svg)

Optimike Obsidian MCP fournit aux clients MCP une surface opérationnelle gouvernée au-dessus d’un coffre Obsidian : opérations Desktop live, modes headless résilients, Tasks et Operon, Bases et Canvas, recherche sémantique, observabilité runtime et accès borné à des documents externes configurés.

## Carte des capacités

| Domaine                 | Ce que fournit le MCP                                                           | Dépendance principale                                |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Notes                   | Lecture/recherche/éditions directes + opérations gouvernées Note et Frontmatter | Coffre ; Local REST API + Atomic Write Bridge        |
| Bases et Canvas         | Requêtes, écritures bornées, formules et graphes Canvas gouvernés               | Bases Bridge ; Atomic Write Bridge                   |
| Tâches                  | Markdown Tasks-compatible + 25 outils Operon gouvernés                          | Operon Developer API V1 via le Bridge                |
| Recherche sémantique    | Recherche dans l’index Smart Connections                                        | `.smart-env` + embedding Ollama ou compatible OpenAI |
| Runtime                 | Cache SQLite partagé, santé, maintenance et modes dégradés                      | Filesystem local                                     |
| Documents externes      | Lectures/handoff default-deny + diagnostic de move local                        | Allowlist de racines                                 |
| Administration headless | Opérations métadonnées/filesystem bornées                                       | Copie ou coffre dédié                                |

Le registre canonique des outils est documenté dans [Surface des outils](docs/obsidian_mcp_tools_spec.md).

## Runtime et transport

| Besoin                                   | Runtime / transport recommandé                           |
| ---------------------------------------- | -------------------------------------------------------- |
| Agent local                              | proxy stdio                                              |
| Automatisation Obsidian Desktop          | `live` ou `hybrid`                                       |
| CI/serveur/copie synchronisée            | `headless-readonly`                                      |
| Écritures bornées sur copie/coffre dédié | `headless-guarded`, puis `headless-filesystem`           |
| HTTP sur la même machine                 | HTTP loopback authentifié                                |
| HTTP distant                             | reverse proxy TLS revu + réseau privé ; pilote seulement |

Le runtime répond à ce que le backend peut exécuter. Il ne décide pas combien d’outils le modèle doit voir.

## Profils de surface d’outils

| Besoin                                               | Profil      | Taille live/hybrid complète |
| ---------------------------------------------------- | ----------- | --------------------------: |
| Travail général sur le coffre                        | `standard`  |                          19 |
| Notes, tags, Bases et Canvas                         | `authoring` |                          30 |
| Workflows Tasks / Operon                             | `tasks`     |                          33 |
| Surface complète explicite, admin et spécialisations | `full`      |                          72 |

En 3.0, l’absence de profil sélectionne `standard`. `smart_semantic_search` est le seul nom de recherche sémantique enregistré ; les anciens alias `smart_search` et `smart-search` ont été supprimés. `full` reste disponible par opt-in explicite pour toute la surface du runtime actif. `bases_upsert_config` reste une voie de compatibilité whole-Base réservée à `full` ; l’authoring normal utilise la création/écriture de lignes bornée et la famille gouvernée des formules.

Sélectionner le profil avant `tools/list` :

```bash
node dist/stdio-proxy.js --tool-profile standard
```

Routes HTTP profilées :

```text
/mcp/standard
/mcp/authoring
/mcp/tasks
/mcp/full
```

Le chemin `/mcp` sans qualificatif utilise désormais `standard` ; `/mcp/full` reste la route complète explicite. Voir [Profils de surface d’outils](docs/tool-surface-profiles.fr.md).

## Démarrage rapide

Pré-requis :

- Node.js `>=22.7.5` ;
- Obsidian Desktop uniquement pour les fonctions live ;
- plugins correspondant aux capacités activées.

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-proxy.js --tool-profile standard
```

Binaires du package :

```text
optimike-obsidian-mcp
optimike-obsidian-mcp-proxy
```

Configuration Codex minimale :

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = [
  "/chemin/vers/optimike-obsidian-mcp/dist/stdio-proxy.js",
  "--tool-profile",
  "standard"
]

[mcp_servers.optimike-obsidian-mcp-stdio.env]
OBSIDIAN_VAULT = "/chemin/vers/coffre"
OBSIDIAN_RUNTIME_MODE = "live"
OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"
OBSIDIAN_API_KEY = "<cle-local-rest-api>"
```

Conserver chemins réels, clés API, journaux et configuration External Roots hors du dépôt et des contenus distribuables.

## Intégrations Obsidian optionnelles

N’activer que les surfaces utilisées :

- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) pour notes, métadonnées et tags en live ;
- **Bases Bridge** inclus pour Bases live et le CAS de formules gouvernées ;
- **Optimike Atomic Write Bridge** inclus pour les cycles Note, Frontmatter et Canvas `plan → apply → status → recover` ;
- **Smart Connections** pour l’index sémantique local ;
- **Operon Developer API V1** et **Optimike Operon Bridge 0.8.2** pour les tâches gouvernées. Operon 3.5.3 et CLI 1.2.0 forment la cible live courante. Une release Operon inconnue mais non refusée reste inscriptible uniquement si la négociation du contrat, les capacités exactes, les schémas, la santé, l’index et le recovery sont tous valides ;
- **Obsidian Tasks** pour le parsing Markdown Tasks-compatible.

Les mutations Operon exigent le réglage de mutation du Bridge plus :

```text
OPERON_MUTATIONS_ENABLED=true
```

Les snapshots Operon obsolètes restent read-only. Aucune route Operon ne retombe sur du Markdown brut ou des API privées. L’adoption officielle et le routage Daily/Weekly négocient leur grant additif exact au premier usage, y compris après un démarrage MCP à froid ; un grant en attente ou refusé échoue toujours fermé. Operon reste propriétaire de chaque plan opaque scellé et de sa récupération same-plan. Task Type et Task Image restent scalaires, Task Gallery reste un tableau ordonné et `__taskDataType` est read-only. Les versions certifiées/provisoires, la récupération et les gaps d’API sont détaillés dans le [Contrat MCP Operon](docs/operon-mcp-contract.fr.md) et l’[Audit CLI / Developer API](docs/operon-cli-audit.fr.md).

## Opérations gouvernées

Les familles Note, Frontmatter, formule Base et Canvas sont exposées atomiquement :

```text
plan → apply → status → recover
```

Après timeout ou perte de transport, appeler `status` avant `recover` ; ne jamais recréer aveuglément une mutation. Les plans durables ne sont pas liés au profil qui les a créés.

## Racines documentaires externes

Les racines externes sont désactivées par défaut. Elles forment un courtier d’autorisation, pas un index, un moteur de synchronisation ou une sauvegarde.

`external_handoff` adapte la livraison au transport :

- le stdio local retourne un `local_path` vérifié et temporaire ;
- le HTTP direct authentifié peut retourner un `http_ticket` opt-in, lié à l’identité et à usage unique ;
- aucun mode de livraison n’autorise une mutation ni ne révèle le chemin source physique.

Le stdio local expose `external_references_scan`, `external_move_plan` et
`external_move_status` pour le diagnostic d’un déplacement de fichier régulier
dans une même racine configurée. `external_move_apply`,
`external_move_rollback` et toute récupération mutante automatique sont
désactivés sur toutes les plateformes avec la raison
`native_handle_relative_mutation_unavailable`; les gates d’écriture historiques
ne peuvent pas les activer. Les reçus redacted, le journal privé et les preuves
hash/CAS restent conservés pour une future primitive auditée. Cette surface n’est
pas exposée en HTTP direct et n’ajoute pas de create, replace, delete, upload ou
sync générique.

Le cœur MCP n’embarque pas de moteur PDF, Office ou OCR. Le client appelant assure l’extraction binaire et vérifie taille et SHA-256.

Voir [Configuration External Roots](docs/external-roots-setup.fr.md).

## Recherche sémantique

`smart_semantic_search` est l’outil canonique. Il interroge l’index Smart Connections local. L’embedding de requête peut rester local via Ollama ou utiliser un fournisseur compatible OpenAI.

Voir [Exploitation](OPERATIONS.fr.md) pour les providers et le cache.

## Validation

```bash
npm run build
npm run test:runtime
npm run test:governed-note-replace-mcp
npm run check:operon
npm run test:external-roots
npm run test:docs
npm run test:package
npm run audit:production
```

Les suites runtime utilisent des coffres jetables et s’exécutent en CI Linux/Windows.

## Documentation

- [Hub documentaire](docs/README.fr.md)
- [Profils de surface d’outils](docs/tool-surface-profiles.fr.md)
- [Surface des outils](docs/obsidian_mcp_tools_spec.md)
- [Matrice des capacités runtime](docs/runtime-capability-matrix.fr.md)
- [Guide de routage](docs/mcp-routing-guide.fr.md)
- [Contrat MCP Operon](docs/operon-mcp-contract.fr.md)
- [Configuration External Roots](docs/external-roots-setup.fr.md)
- [Profil serveur headless](docs/headless-server-profile.fr.md)
- [Compatibilité gateways](docs/gateway-compatibility.fr.md)
- [Index des ADR](docs/adr/README.md)

## Crédits

Créé par **Optimike — Mickaël Ahouansou**.

## Licence

Voir [LICENSE](LICENSE).
