# Optimike Obsidian MCP Tool Surface

This page is the current tool-surface reference for the MCP. It replaces the
older exploratory `*_file` spec: current tools use Obsidian-facing `*_note`
names and runtime-aware registration.

Related docs:

- Runtime modes: [runtime-capability-matrix.md](runtime-capability-matrix.md)
- Operations: [../OPERATIONS.md](../OPERATIONS.md)
- Agent routing: [mcp-routing-guide.md](mcp-routing-guide.md)
- Operon contract: [operon-mcp-contract.md](operon-mcp-contract.md)

## Runtime Rules

- `live`: Obsidian Desktop + Local REST API. Full REST-backed note and Bases
  surface. Operon tools use the live Optimike Operon Bridge when installed.
- `hybrid`: cache/filesystem read surface first; live REST tools appear when
  `OBSIDIAN_API_KEY` is configured and the API is available. Operon tools validate
  their snapshot against the live Bridge when reachable.
- `headless-readonly`: read/search/tasks/semantic/runtime/format validation and
  local readonly Bases fallback. Operon tools can only serve a previously
  validated stale snapshot.
- `headless-guarded`: `headless-readonly` plus bounded filesystem writes for
  note append/prepend, exact search-replace, and frontmatter `set`. Operon remains
  read-only.
- `headless-filesystem`: `headless-guarded` plus explicit local filesystem
  features: tags, admin move/archive/delete, batch frontmatter, minimal Bases
  writes, and JSON Canvas helpers. Operon remains read-only.

## Core Notes

- `obsidian_read_note`: read a vault note by path, with cache fallback.
- `obsidian_list_notes`: list notes and folders, using REST or cache/filesystem.
- `obsidian_global_search`: text/regex search across cached vault content.
- `obsidian_update_note`: live REST note update, or guarded headless
  append/prepend in filesystem modes.
- `obsidian_search_replace`: live REST search/replace, or guarded exact
  filesystem search/replace in headless write modes.
- `obsidian_delete_note`: live REST delete; in `headless-filesystem`, explicit
  filesystem delete requires `expectedHash` or `expectedMtime`.

## Metadata And Tags

- `obsidian_manage_frontmatter`: live frontmatter operations; in headless guarded
  modes, supports bounded filesystem `set`.
- `obsidian_batch_frontmatter`: filesystem batch frontmatter operations with
  dry-run/default safety.
- `obsidian_manage_tags`: live tag tool, or filesystem tag add/remove/list,
  local index/audit, and dry-run rename in `headless-filesystem`.

## Tasks

- `list_all_tasks`: parse Obsidian Tasks-compatible Markdown tasks from the
  shared cache/filesystem.
- `query_tasks`: query cached Tasks data with status, date, tag, description, and
  path filters.

## Operon (contract v1)

- `operon_status`: inspect live Bridge compatibility and persisted snapshot state;
- `operon_get_configuration`: read the live task-semantic Operon settings and their signed stale fallback;
  optional `forceRefresh` requests a complete live rebuild.
- `operon_list_tasks`: list tasks from a live-generation-validated snapshot or an
  explicitly stale persisted fallback.
- `operon_get_task`: read one task by durable `operonId`.
- `operon_query_tasks`: filter by task IDs, stable pipeline/status IDs, visible workflow labels, text, source, checkbox, priority,
  tier, paths, tags, parents, dates, canonical/custom fields, or unmanaged file-task
  properties.
- `operon_query_saved_filter`: evaluate one saved filter through Operon's native live filter engine.
- `operon_validate`: live duplicate/source/workflow graph validation, or a limited
  snapshot-only validation with explicit caveats.
- `operon_adopt_task`: upgrade one exact legacy checkbox in place with line-level optimistic locking.
- `operon_create_task`: create inline/file tasks through Operon Public API v1.
- `operon_update_task`: update one mutation group with expected revision.
- `operon_transition_task`: apply a stable status-ID or exact workflow transition through Operon's guards.
- `operon_convert_task`: convert inline/file shape in `MCP_WRITE_MODE=full`.
- `operon_relocate_task`: move an inline task to another Markdown note while preserving `operonId`.

Operon responses always declare `source`, `stale`, `snapshotAt`, `snapshotAgeMs`,
Operon/Bridge versions, capabilities, and limitations.

Mutations require a live Bridge and Operon Public API v1. Official Operon remains
read-only; the minimal Optimike fork supplies the API. Dry-run is the default,
idempotency is mandatory, existing tasks require `expectedRevision`, and there
is no direct Markdown fallback.

## Semantic Search

- `smart_semantic_search`: semantic search over Smart Connections embeddings.
- `smart_search`: alias for `smart_semantic_search`.
- `smart-search`: alias for `smart_semantic_search`.

Semantic query execution still needs a reachable query embedder provider. The
semantic manifest/vector metadata are cached locally for faster warm refreshes.

## Bases

- `bases_list`: list `.base` definitions via Bases Bridge REST or local fallback.
- `bases_get_schema`: inspect a `.base` schema via REST or local fallback.
- `bases_query`: query Bases via REST, or simple local fallback filters in
  headless modes.
- `bases_create`: live REST `.base` create, or guarded YAML create in
  `headless-filesystem`.
- `bases_upsert_config`: live REST config upsert, or guarded YAML config update
  in `headless-filesystem`.
- `bases_upsert_rows`: live REST row upsert, or guarded Markdown frontmatter
  `set` operations in `headless-filesystem`.

Local/headless Bases support does not evaluate Obsidian formulas, calculated
properties, plugin-specific filters, or exact UI view semantics.

## Canvas And Format Validation

- `obsidian_validate_format`: readonly validation for Obsidian Markdown, `.base`
  YAML, and JSON Canvas shape.
- `obsidian_manage_canvas`: minimal JSON Canvas filesystem helper for validate,
  create, add text node, and connect nodes.

## Runtime

- `obsidian_runtime_status`: process, cache, semantic, degraded-mode, and write
  policy status.
- `obsidian_runtime_maintenance`: integrity checks and cache refresh actions.

## External Document Roots

External roots are disabled unless `MCP_EXTERNAL_ROOTS_FILE` points to a valid
machine-local JSON configuration.

- `external_runtime_status`: report enablement, stdio handoff policy, logical
  root IDs, capabilities, limits, and availability without physical paths.
- `external_roots_list`: list logical root IDs without physical paths.
- `external_list`: bounded root-relative directory listing; links and junctions
  are visible but never followed.
- `external_stat`: bounded metadata and optional SHA-256.
- `external_read`: bounded UTF-8 text read.
- `external_handoff`: explicit handoff of a verified temporary local copy to a
  local stdio client that has its own PDF or Office tooling.

The core MCP does not parse PDF or Office files. Handoff requires both
`readable` and `handoff`; it is denied on HTTP. See
[ADR-External-Document-Roots.md](adr/ADR-External-Document-Roots.md).

## Filesystem Admin

- `obsidian_admin_filesystem`: archive, batch move, and batch delete operations
  with dry-run-first behavior and write preconditions.
- `obsidian_move_note`: filesystem move/rename with path safety and
  `expectedHash` or `expectedMtime` preconditions.

## Not Exposed As Current Tools

The following older exploratory names are not the current MCP surface:

- `obsidian_read_file`
- `obsidian_update_file`
- `obsidian_delete_file`
- `obsidian_list_files`
- `obsidian_get_properties`
- `obsidian_update_properties`
- `obsidian_dataview_query`
- `obsidian_execute_command`
- `obsidian_open_file`
- `obsidian_get_active_file`

Desktop-only behavior such as active file, command palette, UI open actions, and
exact plugin engine semantics remains outside the current headless surface.
