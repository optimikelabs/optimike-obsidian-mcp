# Profils de surface d’outils

Version anglaise : [tool-surface-profiles.md](tool-surface-profiles.md)

Optimike Obsidian MCP sépare deux contrats indépendants :

- le **mode runtime** contrôle ce que le backend peut fournir en sécurité (`live`, `hybrid`, `headless-readonly`, `headless-guarded`, `headless-filesystem`) ;
- le **profil d’outils** contrôle ce qu’un client MCP peut découvrir et appeler avant `tools/list`.

Les profils réduisent le volume des schémas et l’ambiguïté de routage. Ils ne constituent pas une frontière d’autorisation : mode runtime, write policy, grants des Bridges, scopes, confirmations, CAS, idempotence et règles de récupération restent autoritaires.

## Profils publics

| Profil      | Usage visé                                                              | Surface complète live/hybrid |
| ----------- | ----------------------------------------------------------------------- | ---------------------------: |
| `standard`  | Lecture/recherche générale et travail courant gouverné Note/Frontmatter |                    29 outils |
| `authoring` | `standard` + tags, authoring Bases borné/formules et authoring Canvas   |                    43 outils |
| `tasks`     | Compatibilité Markdown Tasks + contrat MCP Operon live complet          |                    35 outils |
| `full`      | Surface complète/admin explicite du runtime actif                       |                    87 outils |

Ces nombres sont des projections du registre actuel et peuvent être plus faibles dans les runtimes restreints. `full` signifie tous les outils structurellement enregistrés par le runtime actif, pas toujours 87 outils. Le registre canonique couvre 91 noms uniques entre tous les runtimes, dont quatre n’existent qu’en `headless-filesystem`. Le cockpit des opérations est live-only car il lit les journaux gouvernés possédés par le processus ; sa visibilité ne remplace jamais un grant d’écriture.

`obsidian_note_links` est limité à `live` / `hybrid-live` : sa sémantique vient du `MetadataCache` public d’Obsidian Desktop. Les profils dégradés et headless l’omettent plutôt que de simuler le graphe depuis l’état filesystem.

L'[évaluation P6 du routage](tool-routing-evaluation-p6.fr.md) mesure ces
surfaces depuis les schémas `tools/list` réels et une baseline versionnée de 31
cas. Sa décision 3.8 conservait les quatre définitions de profils sur l’union
historique de 60 outils authoring/tasks. M3 la portait à 64 ; le candidat M2–M5
compte désormais 70 outils dans cette union. Ces nombres sont des projections
du registre, pas une nouvelle campagne LLM.

Le déplacement natif, la création durable et le patch d’une row Base exposent
seulement plan/apply/status. Aucun recover artificiel ni replay aveugle n’est
ajouté. Les familles remplacement, texte, Frontmatter, formules Base et Canvas
conservent leur cycle de quatre outils.

## Noms réservés à la compatibilité

Les profils modernes excluent volontairement les voies de compatibilité qui ajouteraient une décision au modèle sans apporter une capacité normale distincte.

La recherche sémantique utilise un seul nom canonique :

```text
smart_semantic_search
```

Les anciens alias `smart_search` et `smart-search` ont été physiquement supprimés en 3.0. Les clients existants doivent appeler `smart_semantic_search`.

`bases_upsert_config` reste réservé à `full`. Il remplace une configuration Base complète et n’est pas un fallback de l’édition gouvernée des formules. `authoring` conserve `bases_create`, `bases_upsert_rows` et les familles gouvernées complètes `bases_formula_patch_*` et `bases_rows_patch_*`. Cette dernière modifie une row existante et ne remplace pas le contrat batch direct.

## Familles gouvernées

Les profils filtrés exposent une famille gouvernée lorsque son cycle déclaré est complet. Les familles historiques à quatre outils suivent :

```text
plan → apply → status → recover
```

Cela vaut pour le remplacement de Note, le patch texte du corps Markdown, la
projection Frontmatter, les formules Bases et le patch de graphe Canvas.

L’enregistrement est incrémental dans la factory serveur. Dans les profils filtrés, une famille reste masquée jusqu’à l’arrivée de tous ses membres déclarés : trois pour move/create/rows, quatre pour les anciennes familles. Le fallback direct légitime reste visible jusqu’à la réconciliation. La compilation statique rejette un cycle déclaré incomplet. Le profil administratif explicite `full` conserve sa surface sans suppression ; ce n’est pas une autorisation d’appeler une famille partiellement enregistrée.

Un profil ne modifie jamais le contenu scellé du plan, les journaux, l’idempotence, le binding backend ni l’autorité de récupération. Un plan durable peut être inspecté depuis une autre session exposant sa famille, sous réserve des politiques runtime et d’écriture/sécurité habituelles. La récupération n’existe que pour les familles qui définissent réellement une opération recover.

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
