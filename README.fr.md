# Optimike Obsidian MCP

English version: [README.md](README.md) · [Documentation](docs/README.fr.md) · [Opérations](OPERATIONS.fr.md) · [Sécurité](SECURITY.fr.md)

Optimike Obsidian MCP fournit aux clients MCP une surface opérationnelle gouvernée sur un coffre Obsidian. Il combine opérations Desktop live, modes headless résilients, Tasks et Operon, Bases et Canvas, recherche sémantique, observabilité runtime et accès borné à des documents externes configurés.

## Ce qui change en 3.0

La version 3.0 introduit des **profils de surface d’outils** portables. Le serveur décide de l’ensemble cohérent découvert par une session avant `tools/list` ; les filtres propres aux clients restent des optimisations facultatives.

- `standard` — travail général dans le coffre ;
- `authoring` — Notes, Frontmatter, Bases et Canvas ;
- `tasks` — surface Operon complète de 23 outils et contexte de tâches ;
- `full` — tous les outils structurellement disponibles dans le runtime.

Le défaut devient `standard`. Le mode de runtime et la write policy restent les autorités sur les effets.

La recherche sémantique ne possède plus qu’un nom public :

```text
smart_semantic_search
```

Les anciens alias `smart_search` et `smart-search` ont été supprimés dans cette version majeure.

Voir [Profils de surface d’outils](docs/tool-surface-profiles.fr.md) et [Guide de routage](docs/mcp-routing-guide.fr.md).

## Carte des capacités

| Zone | Ce que fournit le MCP | Dépendance principale |
| --- | --- | --- |
| Notes | Lecture/recherche/éditions directes et remplacement atomique gouverné | Coffre ; Local REST API + Atomic Write Bridge pour le CAS gouverné |
| Frontmatter | Fallback direct et projection gouvernée préservant la source | Local REST API + Atomic Write Bridge |
| Bases et Canvas | Lectures, écritures bornées, formules et graphes Canvas gouvernés | Bases Bridge ; Atomic Write Bridge 0.4.0 |
| Tâches | Markdown Tasks-compatible et 23 outils Operon | Cache/filesystem ; Operon Developer API V1 via le Bridge |
| Recherche sémantique | Index Smart Connections avec cache de métadonnées durable | `.smart-env` + embedding Ollama ou compatible OpenAI |
| Runtime | Cache SQLite partagé, santé, maintenance, mode dégradé et exclusions | Filesystem local |
| Documents externes | Lectures/handoff default-deny et déplacement local opt-in avec réparation exacte | Allowlist de racines ; stdio local pour move |
| Administration headless | Opérations métadonnées/filesystem gouvernées | Copie ou coffre dédié |

Le registre canonique des noms se trouve dans [Tool Surface](docs/obsidian_mcp_tools_spec.md). La disponibilité dépend du runtime et du profil.

## Démarrage rapide

Prérequis :

- Node.js `>=22.7.5` ;
- Obsidian Desktop uniquement pour les fonctions live ;
- plugins correspondant aux capacités activées.

Depuis les sources :

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-surface-proxy.js --tool-profile standard
```

Binaires du paquet :

```text
optimike-obsidian-mcp         serveur direct stdio/HTTP
optimike-obsidian-mcp-proxy   proxy stdio local avec le même contrat de profil
```

Sélection directe en stdio :

```bash
optimike-obsidian-mcp --tool-profile authoring
# ou
MCP_TOOL_PROFILE=authoring optimike-obsidian-mcp
```

Une valeur inconnue, vide ou répétée échoue sans fallback. L’argument CLI prévaut sur l’environnement.

Configuration Codex minimale :

```toml
[mcp_servers.optimike-obsidian]
command = "node"
args = ["/chemin/optimike-obsidian-mcp/dist/stdio-surface-proxy.js", "--tool-profile", "standard"]

[mcp_servers.optimike-obsidian.env]
OBSIDIAN_VAULT = "/chemin/du/coffre"
OBSIDIAN_RUNTIME_MODE = "live"
OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"
OBSIDIAN_API_KEY = "<clé-local-rest-api>"
```

Conserver chemins réels, clés API, journaux et configuration External Roots hors du dépôt et des contenus distribuables.

## Streamable HTTP

Endpoints explicites :

```text
/mcp/standard
/mcp/authoring
/mcp/tasks
/mcp/full
```

`/mcp` reste un alias de compatibilité de `/mcp/full` en 3.0. Une session est liée au profil canonique utilisé à l’initialisation et ne peut pas être réutilisée sur un autre chemin.

Le serveur Node ne doit jamais être exposé directement à Internet. Le HTTP loopback est pris en charge avec authentification et limites bornées. Le HTTP distant reste pilote derrière reverse proxy TLS audité, réseau privé et identité vérifiée. Voir [Sécurité](SECURITY.fr.md).

## Modes de runtime

| Runtime | Usage | Écritures |
| --- | --- | --- |
| `live` | Automatisation Obsidian locale complète | REST et Bridges gouvernés |
| `hybrid` | Workflows Desktop avec lectures dégradées durables | Écritures live tant que l’API existe |
| `headless-readonly` | Serveur, CI ou validation d’une copie synchronisée | Aucune |
| `headless-guarded` | Écritures prudentes sur une copie/coffre dédié | Append/prepend, replace exact, set Frontmatter |
| `headless-filesystem` | Administration filesystem explicite | Écritures bornées avec préconditions |

Commencer une vraie copie synchronisée en `headless-readonly`. Valider les modes d’écriture sur une copie ou un coffre dédié.

## Intégrations Obsidian optionnelles

N’activer que les surfaces utilisées :

- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) pour les opérations live ;
- **Bases Bridge** inclus pour Bases live et le CAS de formules ;
- **Optimike Atomic Write Bridge** inclus pour les cycles Note, Frontmatter et Canvas `plan → apply → status → recover` ;
- **Smart Connections** pour l’index sémantique local ;
- **Operon Developer API V1** et **Optimike Operon Bridge** pour les tâches gouvernées ;
- **Obsidian Tasks** pour parser le Markdown Tasks-compatible.

L’apply Operon exige deux opt-ins :

```text
Optimike Operon Bridge : Allow task mutations
OPERON_MUTATIONS_ENABLED=true
```

Les snapshots Operon périmés restent read-only. Aucune route Operon ne retombe sur du Markdown brut ou des API privées.

## Opérations gouvernées

Les familles Note, Frontmatter, formule Base et Canvas sont exposées atomiquement :

```text
plan → apply → status → recover
```

Après timeout ou réponse perdue, appeler `status` avant `recover` ; ne jamais recréer aveuglément une mutation. Les plans durables ne sont pas liés au profil de session et restent récupérables après reconnexion via tout profil exposant la même famille complète.

## Racines de documents externes

External Roots est désactivé par défaut et utilise des identifiants logiques sans exposer les chemins physiques.

`external_handoff` choisit une livraison selon le transport :

- en stdio local : `local_path` vérifié et éphémère ;
- en HTTP direct authentifié : `http_ticket` opt-in, lié à l’identité et à usage unique ;
- aucun des deux n’accorde une autorité de mutation.

Une transaction séparée en stdio local peut déplacer un fichier régulier dans la même racine et réparer les références ÉLYSIA exactes. Elle exige inventaire, plan durable, préconditions hash/CAS, journal et rollback compensatoire. Elle n’ajoute pas de create, replace, delete, upload ou sync générique.

Le cœur MCP n’embarque pas de moteurs PDF, Office ou OCR. L’extraction binaire appartient au client, qui vérifie taille et SHA-256.

## Recherche sémantique

`smart_semantic_search` interroge l’index Smart Connections local. L’embedder de requête peut rester local via Ollama ou appeler un fournisseur compatible OpenAI. L’outil est donc annoté read-only/open-world même si les données indexées du coffre restent locales.

## Vérification

```bash
npm run build
npm run test:tool-surface-v3
npm run test:runtime
npm run test:external-roots
npm run test:http-multiclient
npm run test:docs
npm run test:package
npm run audit:production
```

Les suites utilisent des coffres jetables et s’exécutent sous Linux et Windows.

## Documentation

- [Profils de surface](docs/tool-surface-profiles.fr.md)
- [Référence Tool Surface](docs/obsidian_mcp_tools_spec.md)
- [Matrice des capacités runtime](docs/runtime-capability-matrix.fr.md)
- [Guide de routage](docs/mcp-routing-guide.fr.md)
- [Contrat Operon MCP](docs/operon-mcp-contract.fr.md)
- [Configuration External Roots](docs/external-roots-setup.fr.md)
- [Profil serveur headless](docs/headless-server-profile.fr.md)
- [Index des ADR](docs/adr/README.md)

## Crédits et licence

Créé par **Optimike — Mickaël Ahouansou**. Voir [LICENSE](LICENSE).
