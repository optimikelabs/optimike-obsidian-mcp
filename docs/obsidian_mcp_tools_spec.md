# Optimike Obsidian MCP 3.0 tool surface

This page is the canonical public tool-name reference for Optimike MCP 3.0.

Related:

- [Tool surface profiles](tool-surface-profiles.md)
- [Runtime Capability Matrix](runtime-capability-matrix.md)
- [MCP Routing Guide](mcp-routing-guide.md)
- [Operations](../OPERATIONS.md)
- [Operon contract](operon-mcp-contract.md)
- [External Roots](external-roots-setup.md)

## Contract model

The cross-runtime 3.0 catalogue contains **74 names**. A session exposes only the intersection of:

```text
structurally registered runtime tools
× selected tool profile
× static feature configuration
```

Effect authorization remains independent and is checked at invocation time.

Profiles:

- `standard` — general vault operations;
- `authoring` — note/Base/Canvas authoring;
- `tasks` — full Operon/task domain;
- `full` — every tool structurally registered by the runtime.

The active profile is chosen before `tools/list` and remains immutable for the session.

## MCP resource

- `optimike://guides/tool-routing` — profile-aware routing precedence for canonical, direct, compatibility and governed families.

## Core vault and search

| Tool | Purpose |
| --- | --- |
| `obsidian_read_note` | Read one vault note by path, with cache fallback. |
| `obsidian_list_notes` | List notes and folders through REST, cache or filesystem. |
| `obsidian_global_search` | Exact text/regex search across cached vault content. |
| `smart_semantic_search` | Semantic search over Smart Connections embeddings. This is the only public semantic-search name in 3.0. |
| `obsidian_validate_format` | Validate Obsidian Markdown, `.base` YAML or JSON Canvas before writing. |
| `obsidian_runtime_status` | Runtime/cache/bridge/degraded-mode status plus active tool-surface metadata. |
| `obsidian_runtime_maintenance` | Integrity checks, maintenance and cache refresh operations; full profile only. |

`smart_search` and `smart-search` were removed in 3.0.

## Direct note operations

| Tool | Purpose |
| --- | --- |
| `obsidian_update_note` | Live REST update or bounded headless append/prepend, depending on runtime. |
| `obsidian_search_replace` | Direct exact search/replace without durable recovery. |
| `obsidian_delete_note` | Live delete or conditional headless-filesystem delete. |

Direct operations do not emulate the durable governed replacement contract.

## Governed note replacement

This family is exposed atomically:

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

It seals exact next content, protected Frontmatter, backend binding and before/after proofs, then applies through Atomic Write Bridge compare-and-swap. Recovery reconciles/resumes the same plan; it is not undo.

## Frontmatter and tags

| Tool | Purpose |
| --- | --- |
| `obsidian_manage_frontmatter` | Direct live Frontmatter operations or bounded headless fallback. |
| `obsidian_batch_frontmatter` | Headless-filesystem batch Frontmatter operations with dry-run/default safety. |
| `obsidian_manage_tags` | Live or filesystem-backed tag management/index/audit. |

Governed Frontmatter family:

- `obsidian_frontmatter_patch_plan`
- `obsidian_frontmatter_patch_apply`
- `obsidian_frontmatter_patch_status`
- `obsidian_frontmatter_patch_recover`

The compiler preserves every non-target Markdown/YAML source range byte-for-byte and delegates one sealed child plan to the common durable operation runtime.

## Bases

Read tools:

- `bases_list`
- `bases_get_schema`
- `bases_query`

Direct/compatibility writes:

- `bases_create`
- `bases_upsert_rows`
- `bases_upsert_config` — full-profile whole-config compatibility only; not a formula fallback.

Governed formula family:

- `bases_formula_patch_plan`
- `bases_formula_patch_apply`
- `bases_formula_patch_status`
- `bases_formula_patch_recover`

The governed family compiles bounded named formula set/delete intent and applies through Bases Bridge Atomic V1.

## Canvas

| Tool | Purpose |
| --- | --- |
| `obsidian_manage_canvas` | Direct headless-filesystem validate/create/add-text/connect helper without durable recovery. |

Governed Canvas family:

- `obsidian_canvas_patch_plan`
- `obsidian_canvas_patch_apply`
- `obsidian_canvas_patch_status`
- `obsidian_canvas_patch_recover`

The compiler preserves unknown JSON values, validates node/edge identity and references, and applies one sealed graph through Atomic Write Bridge Canvas CAS.

## Tasks-compatible Markdown

- `list_all_tasks`
- `query_tasks`

These tools parse Obsidian Tasks-compatible Markdown. They do not claim Operon ownership, native task identity or workflow semantics.

## Operon

The `tasks` profile exposes the complete 23-tool Operon contract.

### Read and context

- `operon_status`
- `operon_get_configuration`
- `operon_list_tasks`
- `operon_query_tasks`
- `operon_query_saved_filter`
- `operon_get_task`
- `operon_validate`
- `operon_get_diagnostics`
- `operon_find_tasks`
- `operon_resolve_task`
- `operon_get_relationships`
- `operon_build_context`
- `operon_get_timer_state`

### Mutations

- `operon_adopt_task`
- `operon_create_task`
- `operon_update_task`
- `operon_transition_task`
- `operon_convert_task`
- `operon_relocate_task`
- `operon_set_relationships`
- `operon_update_recurrence`

### Durable recovery

- `operon_list_pending_recoveries`
- `operon_recover_mutation`

Mutations require the live Optimike Operon Bridge, official contract capabilities, write-policy admission and the documented mutation opt-ins. There is no Markdown/private-API fallback.

## External document roots

Read/handoff tools:

- `external_runtime_status`
- `external_roots_list`
- `external_list`
- `external_stat`
- `external_read`
- `external_handoff`

External Move transaction:

- `external_references_scan`
- `external_move_plan`
- `external_move_status`
- `external_move_apply`
- `external_move_rollback`

Modern profiles expose External Roots only when a static roots configuration exists. `full` retains explicit disabled diagnostics. Move remains local-stdio only and requires the complete transaction, write gates, root capability, exact source identity and conditional note repair.

## Headless administration

- `obsidian_admin_filesystem`
- `obsidian_move_note`

These tools exist only in `headless-filesystem` and are intended for copied or dedicated vaults. They require dry-run/default safety and/or hash/mtime preconditions according to the operation.

## Runtime modes

### `live`

Obsidian Desktop and Local REST API-backed operations, live Bases Bridge and governed Bridges when configured.

### `hybrid`

Cache/filesystem reads remain available when Desktop is unavailable. Live tools are structurally registered when API credentials create the live service; transient API health does not change a connected session surface.

### `headless-readonly`

Read/search/tasks/semantic/runtime/validation plus local readonly Bases fallback. Operon can serve only an explicitly stale validated snapshot.

### `headless-guarded`

Readonly surface plus bounded note append/prepend, exact search/replace and Frontmatter set.

### `headless-filesystem`

Guarded surface plus explicit local filesystem administration, tags, batch Frontmatter, direct Canvas helpers and minimal Base writes.

## Profile counts

Counts depend on runtime and static configuration. Against the complete 74-name catalogue:

| Profile | External Roots absent | External Roots configured |
| --- | ---: | ---: |
| `standard` | 22 | 22 |
| `authoring` | 30 | 36 |
| `tasks` | 31 | 31 |
| `full` | 74 | 74 |

A concrete runtime normally exposes fewer names because no single runtime structurally registers every cross-runtime tool.

## Safety annotations

Every public tool declares complete MCP hints:

- `readOnlyHint`;
- `destructiveHint`;
- `idempotentHint`;
- `openWorldHint`.

Semantic search is read-only/open-world. Governed planning is non-destructive/idempotent. Governed apply/recover is destructive/idempotent. Direct filesystem effects retain the stricter annotations defined by their existing runtime contract.

## Hidden means uncallable

Profiles are enforced at registration and at the public stdio proxy. A tool absent from `tools/list` is not accepted by `tools/call`. Profile filtering never substitutes for handler-level authorization.
