# Matrice des capacités runtime

Version anglaise : [runtime-capability-matrix.md](runtime-capability-matrix.md)

![Profils runtime Optimike Obsidian MCP](assets/readme/runtime-profiles.fr.svg)

| Capacité | `live` | `hybrid` API | `hybrid` sans API | `headless-readonly` | `headless-guarded` | `headless-filesystem` |
| --- | --- | --- | --- | --- | --- | --- |
| Lecture/recherche | REST/cache | REST/cache | Cache/filesystem | Cache/filesystem | Cache/filesystem | Cache/filesystem |
| Update note | REST | REST | Non | Non | Append/prepend | Append/prepend |
| Remplacement atomique gouverné | Bridge CAS | Bridge CAS | Non | Non | Non | Non |
| Frontmatter | REST | REST | Non | Non | `set` borné | `set`, batch, rows Bases |
| Bases lecture | Bridge | Bridge | Non | Fallback local | Fallback local | Fallback local |
| Bases écriture | Bridge | Bridge | Non | Non | Non | YAML et rows bornés |
| Canvas | Non | Non | Non | Non | Non | Helpers JSON bornés |
| Admin move/delete | Non | Non | Non | Non | Non | Préconditions obligatoires |

Racines externes : `external_runtime_status`, `external_roots_list`, `external_list`, `external_stat`, `external_read`, `external_handoff`, `external_references_scan`, `external_move_plan`, `external_move_status`, `external_move_apply`, `external_move_rollback`.

Operon : `operon_status`, `operon_get_configuration`, `operon_list_tasks`, `operon_get_task`, `operon_query_tasks`, `operon_query_saved_filter`, `operon_validate`, `operon_get_diagnostics`, `operon_find_tasks`, `operon_resolve_task`, `operon_get_relationships`, `operon_build_context`, `operon_get_timer_state`, `operon_adopt_task`, `operon_create_task`, `operon_update_task`, `operon_transition_task`, `operon_set_relationships`, `operon_update_recurrence`, `operon_convert_task`, `operon_relocate_task`, `operon_list_pending_recoveries`, `operon_recover_mutation`.

Les quatre outils gouvernés suivants sont enregistrés seulement en `live`, ou en `hybrid` avec API : `obsidian_note_replace_plan`, `obsidian_note_replace_apply`, `obsidian_note_replace_status`, `obsidian_note_replace_recover`.

Leur présence n’ouvre pas l’écriture. La politique MCP, le frontmatter protégé, le write gate du Bridge, le binding backend et le CAS SHA-256 sont revalidés. Recover réconcilie ou reprend le plan exact ; ce n’est pas un undo.

| Mode | Surface spécifique |
| --- | --- |
| `headless-readonly` | `bases_get_schema`, `bases_list`, `bases_query`, `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `obsidian_validate_format`, `query_tasks`, `smart-search`, `smart_search`, `smart_semantic_search` |
| `headless-guarded` | Surface readonly + `obsidian_manage_frontmatter`, `obsidian_search_replace`, `obsidian_update_note` |
| `headless-filesystem` | Surface guarded + `bases_create`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_admin_filesystem`, `obsidian_batch_frontmatter`, `obsidian_delete_note`, `obsidian_manage_canvas`, `obsidian_manage_tags`, `obsidian_move_note` |
| `hybrid` sans API | Lecture/search/tasks/runtime/sémantique |
| `hybrid` avec API / `live` | Surface live, Bases Bridge et les quatre outils `obsidian_note_replace_*` |

La garantie atomique s’arrête à la note cible contrôlée. Sync, watchers, plugins, indexeurs et automatisations externes restent hors de la récupération.
