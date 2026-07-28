# Runtime Capability Matrix

French version: [runtime-capability-matrix.fr.md](runtime-capability-matrix.fr.md)

Related docs: [README](../README.md), [Operations](../OPERATIONS.md), [Headless Server Profile](headless-server-profile.md), [MCP Routing Guide](mcp-routing-guide.md), [External Roots Setup](external-roots-setup.md)

Optimike Obsidian MCP has five runtime contracts. Headless modes run over a synchronized Markdown vault. They do not run Obsidian Desktop, load community plugins, expose the command palette, or provide live UI state.

## Recommended Use

| Runtime mode                | Best for                                                 | Obsidian Desktop                   | Local REST API                                  | Writes                                                                                                  | Bases                                   | Default posture         |
| --------------------------- | -------------------------------------------------------- | ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------- |
| `live`                      | Full local Obsidian automation                           | Required                           | Required                                        | Full REST write tools                                                                                   | Bases Bridge REST                       | Trusted desktop         |
| `hybrid` with API available | Desktop workflows with cache durability                  | Required while live tools are used | Optional at startup, available for full surface | Full REST write tools while API is available                                                            | Bases Bridge REST                       | Robust desktop          |
| `hybrid` without API        | Degraded read/search while Desktop is down               | Not required                       | Unavailable                                     | No write tools                                                                                          | Not registered                          | Resilient degraded mode |
| `headless-readonly`         | Server, CI, Codex, or copied Sync vault validation       | Not required                       | Not required                                    | None                                                                                                    | Local readonly fallback                 | Safest headless mode    |
| `headless-guarded`          | Very cautious note writes on a copied or dedicated vault | Not required                       | Not required                                    | Append/prepend, search_replace, frontmatter set                                                         | Local readonly fallback                 | Cautious write step     |
| `headless-filesystem`       | Explicit headless filesystem features                    | Not required                       | Not required                                    | Bounded filesystem writes, move/delete with preconditions, tag index, batch frontmatter, Canvas helpers | Local fallback + minimal `.base` writes | Sandbox/copy required   |

## Capability Table

| Capability                       | `live`                 | `hybrid` API available                  | `hybrid` API unavailable | `headless-readonly`     | `headless-guarded`               | `headless-filesystem`                                                    |
| -------------------------------- | ---------------------- | --------------------------------------- | ------------------------ | ----------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Start without `OBSIDIAN_API_KEY` | No                     | Yes                                     | Yes                      | Yes                     | Yes                              | Yes                                                                      |
| Start without Obsidian Desktop   | No                     | Yes                                     | Yes                      | Yes                     | Yes                              | Yes                                                                      |
| Filesystem cache                 | Optional               | Yes                                     | Yes                      | Required                | Required                         | Required                                                                 |
| Vault exclusion policy           | Yes for cache scans    | Yes                                     | Yes                      | Yes                     | Yes                              | Yes                                                                      |
| List/read/search                 | REST/cache             | REST/cache                              | Cache/filesystem         | Cache/filesystem        | Cache/filesystem                 | Cache/filesystem                                                         |
| Tasks list/query                 | Cache/filesystem       | Cache/filesystem                        | Cache/filesystem         | Cache/filesystem        | Cache/filesystem                 | Cache/filesystem                                                         |
| Smart semantic search            | If `.smart-env` exists | If `.smart-env` exists                  | If `.smart-env` exists   | If `.smart-env` exists  | If `.smart-env` exists           | If `.smart-env` exists                                                   |
| Runtime status/maintenance       | Yes                    | Yes                                     | Yes                      | Yes                     | Yes                              | Yes                                                                      |
| External document roots          | Optional local config  | Optional local config                   | Optional local config    | Optional local config   | Optional local config            | Optional local config                                                    |
| External reference scan/plan     | Local stdio            | Local stdio                             | Local stdio              | Local stdio             | Local stdio                      | Local stdio                                                              |
| External move apply/rollback     | Stdio + three opt-ins  | Stdio + API + three opt-ins             | No                       | No                      | Stdio + explicit `full` override | Stdio + explicit `full` override                                         |
| Format validation                | Markdown/Base/Canvas   | Markdown/Base/Canvas                    | Markdown/Base/Canvas     | Markdown/Base/Canvas    | Markdown/Base/Canvas             | Markdown/Base/Canvas                                                     |
| Update note                      | REST full tool         | REST full tool                          | No                       | No                      | Append/prepend only              | Append/prepend only                                                      |
| Search/replace                   | REST full tool         | REST full tool                          | No                       | No                      | Exact filePath replacements only | Exact filePath replacements only                                         |
| Frontmatter                      | REST full tool         | REST full tool                          | No                       | No                      | Single-key `set` only            | `set`, batch frontmatter dry-run/apply, and Bases rows                   |
| Tags                             | REST full tool         | REST full tool                          | No                       | No                      | No                               | Frontmatter tags, inline tags, local index/audit, dry-run rename         |
| Admin filesystem                 | No                     | No                                      | No                       | No                      | No                               | Archive, batch move, batch delete; dry-run by default                    |
| Delete note                      | REST delete            | REST delete                             | No                       | No                      | No                               | Filesystem delete requiring `expectedHash` or `expectedMtime`            |
| Move/rename                      | No                     | No                                      | No                       | No                      | No                               | Filesystem move requiring `expectedHash` or `expectedMtime`              |
| Active file / UI / commands      | Via Desktop/plugin     | Via Desktop/plugins while API available | No                       | No                      | No                               | No                                                                       |
| Bases list/schema/query          | Bases Bridge REST      | Bases Bridge REST                       | No                       | Local readonly fallback | Local readonly fallback          | Local fallback with simple filters (`eq`, `contains`, `in`, comparisons) |
| Bases create/upsert              | Bases Bridge REST      | Bases Bridge REST                       | No                       | No                      | No                               | `.base` YAML create/config + rows -> frontmatter `set`                   |
| JSON Canvas create/edit          | No                     | No                                      | No                       | No                      | No                               | Minimal `.canvas` create, text node, edge, validate                      |
| Obsidian plugin parity           | Desktop plugins        | Desktop plugins while API available     | No                       | No                      | No                               | No                                                                       |

## Tool Registry By Mode

Every mode also registers `external_runtime_status`, `external_roots_list`,
`external_list`, `external_stat`, `external_read`, `external_handoff`,
`external_references_scan`, `external_move_plan`, `external_move_status`,
`external_move_apply`, and `external_move_rollback`.
Without `MCP_EXTERNAL_ROOTS_FILE`, status remains disabled and operations fail
closed.

The direct HTTP server registers the five reference-integrity names only to
return an explicit stdio-only denial. The local stdio proxy implements them.
Scan, plan and status are read-only. Apply and rollback additionally require
`MCP_WRITE_MODE=full`, `MCP_EXTERNAL_MOVE_ENABLED=true`, the root `move`
capability, and a backend mode that exposes conditional
`obsidian_search_replace`.

Every mode also registers the 13 Operon contract tools:
`operon_status`, `operon_get_configuration`, `operon_list_tasks`,
`operon_get_task`, `operon_query_tasks`, `operon_query_saved_filter`,
`operon_validate`, `operon_adopt_task`, `operon_create_task`,
`operon_update_task`, `operon_transition_task`, `operon_convert_task`, and
`operon_relocate_task`. In non-live modes they remain limited to validated
read-only snapshots; mutation calls fail closed.

Handoff delivery is a transport contract, not a runtime-mode write capability:

- stdio exposes a verified `local_path` owned by the local handoff lifecycle;
- direct HTTP may expose an authenticated `http_ticket` only when
  `MCP_HTTP_HANDOFF_ENABLED=true` and the identity has `external:read`;
- every direct HTTP external-root status, list, stat, read, hash, and handoff
  operation requires `external:read`;
- HTTP ticket delivery remains read-only, path-redacted, bounded, single-use and
  disabled by default;
- no runtime mode gains external-root upload, create, replace, delete or sync
  from this delivery profile;
- the separate local-stdio move contract is one same-root regular file with an
  absent target, exact ÉLYSIA reference repair and rollback.

| Runtime mode                    | Tools registered                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless-readonly`             | `bases_get_schema`, `bases_list`, `bases_query`, `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `obsidian_validate_format`, `query_tasks`, `smart-search`, `smart_search`, `smart_semantic_search`                                                           |
| `headless-guarded`              | Everything in `headless-readonly`, plus `obsidian_manage_frontmatter`, `obsidian_search_replace`, `obsidian_update_note`                                                                                                                                                                                                                                          |
| `headless-filesystem`           | Everything in `headless-guarded`, plus `bases_create`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_admin_filesystem`, `obsidian_batch_frontmatter`, `obsidian_delete_note`, `obsidian_manage_canvas`, `obsidian_manage_tags`, `obsidian_move_note`                                                                                                      |
| `hybrid` API unavailable        | `list_all_tasks`, `obsidian_global_search`, `obsidian_list_notes`, `obsidian_read_note`, `obsidian_runtime_maintenance`, `obsidian_runtime_status`, `obsidian_validate_format`, `query_tasks`, `smart-search`, `smart_search`, `smart_semantic_search`                                                                                                            |
| `hybrid` API available / `live` | Read/search/tasks/runtime/semantic tools, `obsidian_validate_format`, plus REST write tools and Bases Bridge tools: `bases_create`, `bases_get_schema`, `bases_list`, `bases_query`, `bases_upsert_config`, `bases_upsert_rows`, `obsidian_delete_note`, `obsidian_manage_frontmatter`, `obsidian_manage_tags`, `obsidian_search_replace`, `obsidian_update_note` |

## Safety Notes

- `headless-readonly` is the first safe mode for a real Sync copy.
- `headless-guarded` keeps a cautious write surface and does not expose destructive operations.
- `headless-filesystem` should be validated on a copied or dedicated vault before any production vault write path.
- Guarded writes use vault-relative paths, reject absolute paths and traversal, write atomically, and support `expectedHash` or `expectedMtime` preconditions.
- Headless filesystem move/delete require `expectedHash` or `expectedMtime`.
- Headless tag management edits Markdown text (`tags` frontmatter or inline `#tags`) and can build a cache-backed local tag index.
- Global tag rename is a filesystem feature: dry-run first, apply only on a copied or dedicated server vault.
- `obsidian_admin_filesystem` is for explicit admin operations; it should not replace normal read/write tools.
- `obsidian_validate_format` is a local validator. It improves agent output safety but does not render Obsidian, load plugins, or evaluate exact Bases UI semantics.
- `obsidian_manage_canvas` is intentionally minimal and filesystem-only: create, add text node, connect nodes, validate.
- Headless batch frontmatter defaults to dry-run and only supports `set`; protected keys remain blocked by policy.
- Headless Bases writes edit `.base` files and note frontmatter; they do not evaluate Obsidian views, formulas, or calculated properties.
- The vault exclusion policy protects Optimike cache/search/tasks/Bases scans. It does not stop Obsidian Sync from downloading files.
- A local HTTP service should remain bound to loopback, validate supplied origins, ignore forwarding headers unless a trusted proxy is configured, and use a deterministic port by default.
- Public `/healthz` is liveness-only and path-free; detailed runtime and integrity state remains behind the authenticated MCP tool.
- A remote HTTP profile is pilot-only behind reviewed TLS, authentication, proxy and network controls. Direct public exposure is not supported.
- HTTP artifact tickets require a real authenticated identity with
  `external:read` and never authorize external-root mutation. Direct HTTP also
  refuses reference scan, move plan/status, apply and rollback.
- Automatic external-link repair requires an exact adjacent
  `external-ref:<rootId>::<percent-encoded-relative-path>` token. Any ambiguous,
  historical or unsupported occurrence blocks apply.
- External move uses a no-clobber same-volume hard-link/unlink sequence and
  exact-hash note writes in `headless-filesystem` on a copied or dedicated
  vault. Live apply fails closed until Local REST provides atomic conditional
  whole-note writes.
- Headless write validation should create a new draft file in a sandbox folder. It should not edit existing notes in a real vault.
