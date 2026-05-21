# Runtime Capability Matrix

Optimike Obsidian MCP has five runtime contracts. Headless modes run over a synchronized Markdown vault. They do not run Obsidian Desktop, load community plugins, expose the command palette, or provide live UI state.

## Recommended Use

| Runtime mode                | Best for                                                 | Obsidian Desktop                   | Local REST API                                  | Writes                                                                                  | Bases                                   | Default posture         |
| --------------------------- | -------------------------------------------------------- | ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------- |
| `live`                      | Full local Obsidian automation                           | Required                           | Required                                        | Full REST write tools                                                                   | Bases Bridge REST                       | Trusted desktop         |
| `hybrid` with API available | Desktop workflows with cache durability                  | Required while live tools are used | Optional at startup, available for full surface | Full REST write tools while API is available                                            | Bases Bridge REST                       | Robust desktop          |
| `hybrid` without API        | Degraded read/search while Desktop is down               | Not required                       | Unavailable                                     | No write tools                                                                          | Not registered                          | Resilient degraded mode |
| `headless-readonly`         | Server, CI, Codex, or copied Sync vault validation       | Not required                       | Not required                                    | None                                                                                    | Local readonly fallback                 | Safest headless mode    |
| `headless-guarded`          | Very cautious note writes on a copied or dedicated vault | Not required                       | Not required                                    | Append/prepend, search_replace, frontmatter set                                         | Local readonly fallback                 | Cautious write step     |
| `headless-filesystem`       | Explicit headless filesystem features                    | Not required                       | Not required                                    | Bounded filesystem writes, move/delete with preconditions, tag index, batch frontmatter | Local fallback + minimal `.base` writes | Sandbox/copy required   |

## Capability Table

| Capability                       | `live`                 | `hybrid` API available              | `hybrid` API unavailable | `headless-readonly`     | `headless-guarded`               | `headless-filesystem`                                                  |
| -------------------------------- | ---------------------- | ----------------------------------- | ------------------------ | ----------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Start without `OBSIDIAN_API_KEY` | No                     | Yes                                 | Yes                      | Yes                     | Yes                              | Yes                                                                    |
| Start without Obsidian Desktop   | No                     | Yes                                 | Yes                      | Yes                     | Yes                              | Yes                                                                    |
| Filesystem cache                 | Optional               | Yes                                 | Yes                      | Required                | Required                         | Required                                                               |
| Vault exclusion policy           | Yes for cache scans    | Yes for cache scans                 | Yes                      | Yes                     | Yes                              | Yes                                                                    |
| List/read/search                 | REST/cache             | REST/cache                          | Cache/filesystem         | Cache/filesystem        | Cache/filesystem                 | Cache/filesystem                                                       |
| Tasks list/query                 | Cache/filesystem       | Cache/filesystem                    | Cache/filesystem         | Cache/filesystem        | Cache/filesystem                 | Cache/filesystem                                                       |
| Smart semantic search            | If `.smart-env` exists | If `.smart-env` exists              | If `.smart-env` exists   | If `.smart-env` exists  | If `.smart-env` exists           | If `.smart-env` exists                                                 |
| Runtime status/maintenance       | Yes                    | Yes                                 | Yes                      | Yes                     | Yes                              | Yes                                                                    |
| Update note                      | REST full tool         | REST full tool                      | No                       | No                      | Append/prepend only              | Append/prepend only                                                    |
| Search/replace                   | REST full tool         | REST full tool                      | No                       | No                      | Exact filePath replacements only | Exact filePath replacements only                                       |
| Frontmatter                      | REST full tool         | REST full tool                      | No                       | No                      | Single-key `set` only            | `set`, batch frontmatter dry-run/apply, and Bases rows                 |
| Tags                             | REST full tool         | REST full tool                      | No                       | No                      | No                               | Frontmatter tags, inline tags, local cache tag index                   |
| Move/delete                      | REST full tools        | REST full tools                     | No                       | No                      | No                               | Move/rename + delete, both requiring `expectedHash` or `expectedMtime` |
| Active file / UI / commands      | Via Desktop/plugin     | Via Desktop/plugin                  | No                       | No                      | No                               | No                                                                     |
| Bases list/schema/query          | Bases Bridge REST      | Bases Bridge REST                   | No                       | Local readonly fallback | Local readonly fallback          | Local readonly fallback                                                |
| Bases create/upsert              | Bases Bridge REST      | Bases Bridge REST                   | No                       | No                      | No                               | `.base` YAML create/config + rows -> frontmatter `set`                 |
| Obsidian plugin parity           | Desktop plugins        | Desktop plugins while API available | No                       | No                      | No                               | No                                                                     |

## Tool Registry By Mode

| Runtime mode                    | Tools registered                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless-readonly`             | `bases_get_schema`, `bases_list`, `bases_query`, `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `query_tasks`, `smart-search`, `smart_search`, `smart_semantic_search`                                                           |
| `headless-guarded`              | Everything in `headless-readonly`, plus `obsidian_manage_frontmatter`, `obsidian_search_replace`, `obsidian_update_note`                                                                                                                                                                                                              |
| `headless-filesystem`           | Everything in `headless-guarded`, plus `bases_create`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_batch_frontmatter`, `obsidian_delete_note`, `obsidian_manage_tags`, `obsidian_move_note`                                                                                                                                 |
| `hybrid` API unavailable        | `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `query_tasks`, `smart-search`, `smart_search`, `smart_semantic_search`                                                                                                            |
| `hybrid` API available / `live` | Read/search/tasks/runtime/semantic tools, plus REST write tools and Bases Bridge tools: `bases_create`, `bases_get_schema`, `bases_list`, `bases_query`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_delete_note`, `obsidian_manage_frontmatter`, `obsidian_manage_tags`, `obsidian_search_replace`, `obsidian_update_note` |

## Safety Notes

- `headless-readonly` is the first safe mode for a real Sync copy.
- `headless-guarded` keeps a cautious write surface and does not expose destructive operations.
- `headless-filesystem` should be validated on a copied or dedicated vault before any production vault write path.
- Guarded writes use vault-relative paths, reject absolute paths and traversal, write atomically, and support `expectedHash` or `expectedMtime` preconditions.
- Headless filesystem move/delete require `expectedHash` or `expectedMtime`.
- Headless tag management edits Markdown text (`tags` frontmatter or inline `#tags`) and can build a cache-backed local tag index.
- Headless batch frontmatter defaults to dry-run and only supports `set`; protected keys remain blocked by policy.
- Headless Bases writes edit `.base` files and note frontmatter; they do not evaluate Obsidian views, formulas, or calculated properties.
- The vault exclusion policy protects Optimike cache/search/tasks/Bases scans. It does not stop Obsidian Sync from downloading files.
- Headless write validation should create a new draft file in a sandbox folder. It should not edit existing notes in a real vault.
