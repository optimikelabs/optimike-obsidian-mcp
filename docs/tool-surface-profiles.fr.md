# Profils de surface d’outils

Optimike Obsidian MCP 3.0 sépare deux contrats indépendants :

- le **mode de runtime** détermine ce que l’installation peut exécuter ;
- le **profil de surface d’outils** détermine ce qu’un client MCP connecté peut découvrir et appeler.

Le profil est choisi avant l’initialisation MCP et avant `tools/list`. Il reste immuable pendant toute la session. La visibilité n’est pas une frontière d’autorisation : chaque handler continue d’appliquer le mode de runtime, la politique d’écriture, les permissions des Bridges, les scopes, les préconditions compare-and-swap, l’idempotence et les règles de récupération existantes.

## Profils

| Profil | Usage visé | Contrat |
| --- | --- | --- |
| `standard` | Travail général dans le coffre | Lecture/recherche, recherche sémantique canonique, éditions directes bornées, cycles gouvernés Note et Frontmatter, tags, inspection Tasks-compatible et lecture de Bases. |
| `authoring` | Production structurée dans Obsidian | Primitives d’écriture, formules Bases gouvernées, mutations Canvas gouvernées, écritures Bases bornées et lecture des documents externes configurés. |
| `tasks` | Operon et opérations de tâches | Contexte du coffre, inspection Tasks-compatible et surface Operon complète de 23 outils, récupération durable comprise. |
| `full` | Administration, compatibilité et diagnostic | Tous les outils structurellement disponibles dans le runtime actif. Ce n’est plus le défaut en 3.0. |

Le nombre exact dépend du runtime. Une installation live peut exposer davantage d’outils gouvernés liés à Obsidian Desktop ; `headless-filesystem` peut exposer des helpers directs absents du mode live.

## Sélection

### Stdio direct

```bash
optimike-obsidian-mcp --tool-profile standard
```

ou :

```bash
MCP_TOOL_PROFILE=standard optimike-obsidian-mcp
```

L’argument de ligne de commande prévaut sur `MCP_TOOL_PROFILE`. Une valeur inconnue, vide ou répétée échoue sans fallback. Le défaut de la 3.0 est `standard`.

### Proxy stdio

```bash
optimike-obsidian-mcp-proxy --tool-profile authoring
```

Le proxy filtre `tools/list` et `tools/call`. Un outil absent ne peut pas être appelé en contournant la découverte, y compris lorsqu’il est implémenté localement par le proxy.

### Streamable HTTP

Le chemin HTTP porte le profil :

```text
/mcp/standard
/mcp/authoring
/mcp/tasks
/mcp/full
```

`/mcp` reste un alias de compatibilité de `/mcp/full` en 3.0. Les nouvelles intégrations doivent utiliser un chemin explicite.

Le serveur lie chaque session au profil canonique choisi à l’initialisation. Réutiliser un identifiant de session sur un autre profil retourne la même réponse opaque qu’une session invalide ou expirée. Les requêtes `POST`, `GET` et `DELETE` appliquent toutes cette liaison.

## Contrat serveur, optimisation client

Le profil serveur est le contrat portable et fonctionne avec tout client MCP conforme. Un client peut encore réduire ou différer la surface :

- Codex : `enabled_tools` / `disabled_tools` ;
- Gemini CLI : `includeTools` / `excludeTools` ;
- Claude Code : Tool Search et chargement différé des schémas ;
- Hermes Agent : filtres include/exclude, globs compris ;
- OpenClaw : `toolFilter.include` / `toolFilter.exclude`.

Ces mécanismes restent des optimisations facultatives. Ils ne deviennent jamais l’autorité du contrat Optimike ni de sa sécurité.

## Recherche sémantique canonique

Optimike MCP 3.0 expose un seul nom public :

```text
smart_semantic_search
```

Les anciens alias `smart_search` et `smart-search` ont été supprimés en 3.0. Ils appelaient la même implémentation et augmentaient l’ambiguïté ainsi que le coût des schémas. Toute allowlist, tout prompt, script ou workflow conservé doit utiliser `smart_semantic_search`.

La recherche sémantique reste annotée read-only et open-world : selon la configuration, l’embedder de requête peut appeler Ollama ou un fournisseur externe compatible OpenAI. Les données indexées du coffre restent gouvernées par l’index Smart Connections local et la configuration du runtime.

## Familles atomiques

Une famille gouvernée est exposée comme un bloc indivisible :

```text
plan → apply → status → recover
```

Cet invariant couvre le remplacement de note, la projection Frontmatter, les formules Bases et les mutations Canvas. La transaction de déplacement externe et la paire de récupération Operon sont également groupées.

Une session appartient à un profil ; un plan durable n’appartient pas à un profil. Un plan créé dans une session peut être inspecté ou récupéré après reconnexion depuis tout profil exposant la même famille, y compris `full`, sous réserve du journal d’origine, du binding backend, de la clé d’idempotence, de la politique d’écriture et de l’autorité de récupération.

Les profils ne modifient jamais :

- le contenu scellé du plan ;
- les enregistrements du journal durable ;
- l’idempotence ;
- les preuves compare-and-swap ;
- l’éligibilité à la récupération ;
- les autorisations du runtime.

## Fallbacks directs

Les outils directs et gouvernés ne sont pas interchangeables. Le compilateur n’active un fallback direct explicite que lorsque la famille gouvernée est structurellement absente du runtime :

- `obsidian_manage_frontmatter` peut servir le travail Frontmatter de `standard`/`authoring` si la projection live gouvernée n’existe pas ;
- `obsidian_manage_canvas` peut servir `authoring` en `headless-filesystem` si le Canvas CAS live gouverné n’existe pas.

`bases_upsert_config` reste une voie de compatibilité du profil `full`, pas un fallback des formules gouvernées.

## Disponibilité statique et transitoire

La compilation peut utiliser des faits statiques connus avant l’initialisation, comme le mode de runtime ou l’existence d’une configuration External Roots. Elle ne change pas la surface parce qu’Obsidian, Operon ou un Bridge devient temporairement indisponible.

Les pannes transitoires sont renvoyées par l’outil stable avec un diagnostic explicite. Le serveur ne modifie pas silencieusement `tools/list` pendant une session.

## Diagnostic runtime

`obsidian_runtime_status` ajoute :

```json
{
  "toolSurface": {
    "profile": "standard",
    "profileVersion": "3.0",
    "toolCount": 22,
    "fingerprint": "sha256...",
    "legacyAliasesExposed": false
  }
}
```

L’empreinte dépend de la version de contrat du profil et des noms exposés triés. C’est un signal d’observabilité et de conformité, pas un jeton d’autorisation.

## Migration depuis 2.x

1. Remplacer `smart_search` ou `smart-search` par `smart_semantic_search`.
2. Choisir le profil le plus étroit couvrant le domaine nécessaire.
3. En HTTP, remplacer `/mcp` par `/mcp/{profile}` dès que possible.
4. Conserver la configuration de runtime et de write policy : un profil n’accorde aucun droit d’écriture.
5. Se reconnecter après un changement de profil. Une session existante ne peut pas changer de surface.
6. Après une réponse de mutation perdue, se reconnecter à un profil exposant la même famille et appeler `status` avant `recover` ; ne jamais recréer aveuglément un plan.

## Frontière de compatibilité

La 3.0 est volontairement une version majeure :

- la surface publique par défaut devient `standard` ;
- deux alias de recherche sémantique disparaissent ;
- les entrypoints publics imposent les profils ;
- les sessions HTTP sont liées à un profil ;
- un outil absent du catalogue échoue à l’enregistrement.

Les modes de runtime, les journaux d’opérations, les Bridges, les write gates et les sémantiques des mutations gouvernées restent compatibles avec les contrats publiés en 2.9.
