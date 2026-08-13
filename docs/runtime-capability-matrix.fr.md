# Matrice des capacités runtime

Version anglaise : [runtime-capability-matrix.md](runtime-capability-matrix.md)

Docs liées : [Présentation](../README.fr.md), [Exploitation](../OPERATIONS.fr.md),
[Surface des outils](obsidian_mcp_tools_spec.md), [Sécurité](../SECURITY.fr.md).

![Aide au choix entre les profils live, hybrid et headless d’Optimike Obsidian MCP](assets/readme/runtime-profiles.fr.svg)

Les modes headless travaillent au-dessus d’un coffre Markdown. Ils ne lancent
pas Obsidian Desktop et ne chargent pas ses plugins communautaires.

## Profils

| Mode | Desktop / API | Surface d’écriture | Usage recommandé |
| --- | --- | --- | --- |
| `live` | Desktop + Local REST API requis | REST complet + CAS gouverné si Atomic Write Bridge disponible | Automatisation locale de confiance |
| `hybrid` avec API | Desktop pendant les opérations live | Surface live complète | Desktop robuste avec cache durable |
| `hybrid` sans API | Non | Aucune | Lecture/search dégradés |
| `headless-readonly` | Non | Aucune | Serveur, CI, copie Sync |
| `headless-guarded` | Non | Append/prepend, search-replace, frontmatter borné | Copie ou coffre dédié |
| `headless-filesystem` | Non | Écritures filesystem explicites et préconditionnées | Sandbox ou copie obligatoire |

## Capacités

| Capacité | `live` | `hybrid` API | `hybrid` sans API | `headless-readonly` | `headless-guarded` | `headless-filesystem` |
| --- | --- | --- | --- | --- | --- | --- |
| Lire, lister, rechercher | REST/cache | REST/cache | Cache/filesystem | Cache/filesystem | Cache/filesystem | Cache/filesystem |
| Tasks | Cache/filesystem | Cache/filesystem | Cache/filesystem | Cache/filesystem | Cache/filesystem | Cache/filesystem |
| Recherche sémantique | `.smart-env` + embedder | Idem | Idem | Idem | Idem | Idem |
| Status et maintenance | Oui | Oui | Oui | Oui | Oui | Oui |
| Validation Markdown/Base/Canvas | Oui | Oui | Oui | Oui | Oui | Oui |
| Update note | REST complet | REST complet | Non | Non | Append/prepend | Append/prepend |
| Remplacement atomique gouverné | Atomic Write Bridge | Idem tant que l’API répond | Non | Non | Non | Non |
| Frontmatter | REST complet | REST complet | Non | Non | `set` borné | `set`, batch et rows Bases |
| Bases list/schema/query | Bases Bridge | Bases Bridge | Non | Fallback local | Fallback local | Fallback local |
| Bases create/upsert | Bases Bridge | Bases Bridge | Non | Non | Non | YAML et rows bornés |
| Canvas create/edit | Non | Non | Non | Non | Non | Helpers JSON minimaux |
| Admin move/delete | Non | Non | Non | Non | Non | Préconditions obligatoires |
| Move externe avec réparation | Non | Non | Non | Non | Non | Stdio local + opt-ins exacts |

## Surface commune

Tous les modes enregistrent la famille de racines externes :

`external_runtime_status`, `external_roots_list`, `external_list`,
`external_stat`, `external_read`, `external_handoff`,
`external_references_scan`, `external_move_plan`, `external_move_status`,
`external_move_apply`, `external_move_rollback`.

Sans configuration locale des racines, ces opérations échouent fermées. Le HTTP
direct refuse les opérations d’intégrité et de move ; leur exécution appartient
au stdio local. Apply et rollback exigent les opt-ins d’écriture et les
préconditions documentées.

Tous les modes enregistrent aussi les 23 outils Operon :

`operon_status`, `operon_get_configuration`, `operon_list_tasks`,
`operon_get_task`, `operon_query_tasks`, `operon_query_saved_filter`,
`operon_validate`, `operon_get_diagnostics`, `operon_find_tasks`,
`operon_resolve_task`, `operon_get_relationships`, `operon_build_context`,
`operon_get_timer_state`, `operon_adopt_task`, `operon_create_task`,
`operon_update_task`, `operon_transition_task`, `operon_set_relationships`,
`operon_update_recurrence`, `operon_convert_task`,
`operon_relocate_task`, `operon_list_pending_recoveries`,
`operon_recover_mutation`.

Leur enregistrement ne garantit pas leur disponibilité. Hors live, Operon reste
limité aux snapshots validés en lecture seule et toute mutation échoue fermée.
Voir le [contrat Operon](operon-mcp-contract.fr.md).

## Remplacement atomique gouverné

Les outils suivants ne sont enregistrés qu’en `live`, ou en `hybrid` avec API :

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

Leur présence n’ouvre pas les écritures. Le plan et chaque effet revalident la
politique MCP courante, le frontmatter protégé, le write gate du Bridge,
l’identité backend et le CAS SHA-256. Recover réconcilie ou reprend le plan
exact ; il ne restaure pas automatiquement l’ancienne note et n’accepte pas un
nouveau payload.

## Registre synthétique par mode

| Mode | Outils spécifiques en plus de la surface commune |
| --- | --- |
| `headless-readonly` | `bases_get_schema`, `bases_list`, `bases_query`, `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `obsidian_validate_format`, `query_tasks`, `smart-search`, `smart_search`, `smart_semantic_search` |
| `headless-guarded` | Tout `headless-readonly`, plus `obsidian_manage_frontmatter`, `obsidian_search_replace`, `obsidian_update_note` |
| `headless-filesystem` | Tout `headless-guarded`, plus `bases_create`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_admin_filesystem`, `obsidian_batch_frontmatter`, `obsidian_delete_note`, `obsidian_manage_canvas`, `obsidian_manage_tags`, `obsidian_move_note` |
| `hybrid` sans API | Lecture/search/tasks/runtime/sémantique uniquement |
| `hybrid` avec API / `live` | Surface live, Bases Bridge et les quatre outils `obsidian_note_replace_*` |

## Garde-fous

- `headless-readonly` est le premier profil sûr sur une vraie copie Sync.
- `headless-filesystem` doit rester sur une copie ou un coffre dédié.
- Les écritures filesystem utilisent des chemins relatifs, refusent les
  traversals et exigent les préconditions prévues.
- Les outils Bases headless n’évaluent pas les formules ou vues Obsidian.
- Le remplacement gouverné d’une note complète est live-only ; sa garantie
  s’arrête à la note cible contrôlée par le CAS atomique.
- Sync, watchers, plugins, indexeurs et automatisations externes restent hors de
  la frontière de récupération.
