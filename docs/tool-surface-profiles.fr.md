# Profils de surface d’outils

Version anglaise : [tool-surface-profiles.md](tool-surface-profiles.md)

Optimike Obsidian MCP sépare deux contrats indépendants :

- le **mode runtime** contrôle ce que le backend peut fournir en sécurité (`live`, `hybrid`, `headless-readonly`, `headless-guarded`, `headless-filesystem`) ;
- le **profil d’outils** contrôle ce qu’un client MCP peut découvrir et appeler avant `tools/list`.

Les profils réduisent le volume des schémas et l’ambiguïté de routage. Ils ne constituent pas une frontière d’autorisation : mode runtime, write policy, grants des Bridges, scopes, confirmations, CAS, idempotence et règles de récupération restent autoritaires.

## Profils publics

| Profil      | Usage visé                                                              | Surface complète live/hybrid |
| ----------- | ----------------------------------------------------------------------- | ---------------------------: |
| `standard`  | Lecture/recherche générale et travail courant gouverné Note/Frontmatter |                    22 outils |
| `authoring` | `standard` + tags, authoring Bases borné/formules et authoring Canvas   |                    33 outils |
| `tasks`     | Compatibilité Markdown Tasks + contrat MCP Operon live complet          |                    34 outils |
| `full`      | Surface complète/admin explicite du runtime actif                       |                    77 outils |

Ces nombres sont des projections du registre actuel et peuvent être plus faibles dans les runtimes restreints. `full` signifie tous les outils structurellement enregistrés par le runtime actif, pas toujours 77 outils. Le registre canonique couvre 81 noms uniques entre tous les runtimes, dont quatre n’existent qu’en `headless-filesystem`. Le cockpit des opérations est live-only car il lit les journaux gouvernés possédés par le processus ; sa visibilité ne remplace jamais un grant d’écriture.

L'[évaluation P6 du routage](tool-routing-evaluation-p6.fr.md) mesure ces
surfaces depuis les schémas `tools/list` réels et une baseline versionnée de 31
cas. Sa décision 3.8 conserve les quatre profils : l'union live de 60 outils
authoring et tasks n'est pas promue sans parcours cross-domain mesuré.

## Noms réservés à la compatibilité

Les profils modernes excluent volontairement les voies de compatibilité qui ajouteraient une décision au modèle sans apporter une capacité normale distincte.

La recherche sémantique utilise un seul nom canonique :

```text
smart_semantic_search
```

Les anciens alias `smart_search` et `smart-search` ont été physiquement supprimés en 3.0. Les clients existants doivent appeler `smart_semantic_search`.

`bases_upsert_config` reste réservé à `full`. Il remplace une configuration Base complète et n’est pas un fallback de l’édition gouvernée des formules. `authoring` conserve `bases_create`, `bases_upsert_rows` et la famille gouvernée complète `bases_formula_patch_*`.

## Familles gouvernées

Une famille gouvernée est exposée atomiquement :

```text
plan → apply → status → recover
```

Cela vaut pour le remplacement de Note, le patch texte du corps Markdown, la
projection Frontmatter, les formules Bases et le patch de graphe Canvas.

L’enregistrement des outils est incrémental dans la factory serveur. Tant que les quatre membres d’une famille ne sont pas enregistrés, toute la famille gouvernée reste masquée et le fallback direct légitime reste visible. À l’arrivée du quatrième membre, le quartet devient visible en une seule réconciliation et le fallback devenu secondaire est masqué. La compilation statique reste stricte et rejette une famille réellement incomplète.

Un profil ne modifie jamais le contenu scellé du plan, les journaux, l’idempotence, le binding backend ni l’autorité de récupération. Un plan durable créé dans une session peut être inspecté ou récupéré depuis une autre session ou un autre profil exposant la même famille complète, sous réserve des politiques runtime et d’écriture/sécurité habituelles.

## Canonique et fallback direct

Les profils modernes ne masquent une voie directe que lorsque la famille gouvernée correspondante est structurellement complète dans le runtime courant.

- `live` / `hybrid` live : exposer `obsidian_frontmatter_patch_{plan,apply,status,recover}` et masquer `obsidian_manage_frontmatter` ;
- `live` / `hybrid` live : exposer `obsidian_text_patch_{plan,apply,status,recover}` et masquer `obsidian_update_note` / `obsidian_search_replace` seulement lorsque le quartet est complet ;
- `headless-guarded` / `headless-filesystem` : la famille Frontmatter gouvernée est absente, donc `obsidian_manage_frontmatter` reste le fallback borné ;
- les helpers Canvas directs de `headless-filesystem` restent disponibles uniquement lorsque la famille Canvas live gouvernée est structurellement absente ;
- `bases_upsert_config` n’est jamais un fallback de formule et reste réservé à `full`.

`full` n’applique jamais cette suppression au profit de la voie canonique.

## Sélection en stdio

Le défaut de la 3.0 est `standard` lorsqu’aucun profil n’est indiqué.

Le profil est fixé pour toute la durée de vie d’un proxy stdio. Démarrer
Obsidian après Codex n’ajoute pas les outils exclus par le profil choisi.
L’absence de `operon_*` dans une session `standard` signifie donc « non exposé
par ce profil », pas « le plugin Operon n’est pas chargé ». Utiliser `tasks`
pour une session centrée sur les tâches : ses outils Operon restent découvrables
si Desktop ou le Bridge est momentanément indisponible et renvoient un état
structuré indisponible ou stale jusqu’au rafraîchissement du contrat live par
`operon_status`.

```bash
node dist/stdio-proxy.js --tool-profile standard
```

ou :

```bash
MCP_TOOL_PROFILE=standard node dist/stdio-proxy.js
```

`--tool-profile` prévaut sur `MCP_TOOL_PROFILE`. Une valeur inconnue, vide ou répétée échoue fermé au lieu de retomber sur `standard`.

Le proxy stdio applique le profil par client. Lorsqu’il démarre le backend HTTP partagé, il le démarre explicitement en `full`, puis filtre `tools/list` et `tools/call` pour son client. Un outil local du proxy masqué n’est donc pas appelable en connaissant simplement son nom.

## Sélection en HTTP

Le serveur expose des routes de profil immuables :

```text
/mcp              → standard (défaut 3.0)
/mcp/standard     → standard
/mcp/authoring    → authoring
/mcp/tasks        → tasks
/mcp/full         → full
```

Une session est liée à son identité vérifiée et à son profil. Un `sessionId` créé sur `/mcp/standard` ne peut pas être réutilisé sur `/mcp/full`, y compris pour POST, GET ou DELETE. Un mismatch de profil utilise la même posture générique « session invalide/expirée » qu’un mismatch d’identité.

Le contexte de profil est limité à la requête pendant la création du `McpServer` de la session ; plusieurs profils peuvent coexister sur un même backend sans mutation d’un profil global de processus.

## Contrat serveur, optimisation client

Le profil serveur est le contrat portable. Un client peut encore réduire ou différer cette surface, mais ne devient jamais la source de vérité d’Optimike.

Mécanismes clients optionnels :

- Codex : `enabled_tools` / `disabled_tools` ;
- Gemini CLI : `includeTools` / `excludeTools` ;
- Claude Code : tool search / chargement MCP différé ;
- Hermes Agent : filtres include/exclude ;
- OpenClaw : `toolFilter.include` / `toolFilter.exclude`.

Ces mécanismes peuvent évoluer indépendamment. Choisir d’abord un profil Optimike, puis utiliser le filtrage client uniquement comme optimisation supplémentaire.

## Migration depuis la 2.10

La 3.0 introduit deux ruptures volontaires :

- un profil stdio non indiqué et `/mcp` sans qualificatif sélectionnent désormais `standard` ;
- `smart_search` et `smart-search` n’existent plus ; utiliser `smart_semantic_search`.

Les clients qui ont réellement besoin de l’administration, des racines externes ou d’outils spécialisés doivent demander explicitement `MCP_TOOL_PROFILE=full`, `--tool-profile full` ou `/mcp/full`. Le profil contrôle toujours la découverte, pas l’autorisation.
