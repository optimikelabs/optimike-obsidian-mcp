# Optimike Obsidian MCP Tool Surface

This page is the current tool-surface reference for the MCP. It replaces the
older exploratory `*_file` spec: current tools use Obsidian-facing `*_note`
names and runtime-aware registration.

Related docs:

- Tool exposure profiles: [tool-surface-profiles.md](tool-surface-profiles.md)
- Runtime modes: [runtime-capability-matrix.md](runtime-capability-matrix.md)
- Operations: [../OPERATIONS.md](../OPERATIONS.md)
- Governed atomic note replacement: [governed-note-replacement.md](governed-note-replacement.md)
- Governed Base formulas P2: [governed-base-formula-p2.md](governed-base-formula-p2.md)
- Agent routing: [mcp-routing-guide.md](mcp-routing-guide.md)
- External roots: [external-roots-setup.md](external-roots-setup.md)
- Operon contract: [operon-mcp-contract.md](operon-mcp-contract.md)

## Exposure profiles

The canonical registry is larger than any one normal agent surface. Runtime
registration and tool-profile exposure are separate filters:

- `standard`, `authoring` and `tasks` expose curated modern surfaces before
  `tools/list`;
- `full` explicitly exposes every tool registered by the active runtime for
  administration and specialized compatibility work;
- a hidden tool remains protected by the same runtime/write/security checks;
  visibility is not authorization.

The current cross-runtime registry contains 76 unique names. Full live/hybrid
registration currently contains 72 names. See
[Tool Surface Profiles](tool-surface-profiles.md) for exact profile semantics.

## MCP Resources

- `optimike://guides/tool-routing`: concise Markdown precedence for canonical,
  governed, direct and compatibility tool families. Clients can read it when
  choosing between overlapping domains; it adds no callable mutation capability.

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

### Local REST API 5.x contract

The live adapter requires Local REST API 5.0.2 or later within the supported 5.x
line. Targeted PATCH requests use the native JSON instruction format:
`Content-Type: application/json`, with `targetType`, `target`, `operation`, and
the typed `content` or `value` payload in the request body. It does not use the
deprecated 1.x `Operation`, `Target-*`, or `Markdown-Patch-Version: 1` headers.
The vendored YAML and JSON snapshots under `docs/obsidian-api/` are generated
from the
[official 5.0.2 OpenAPI document](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/5.0.2/docs/openapi.yaml).

The Local REST API core no longer provides `/periodic/...` routes. Consequently,
`obsidian_update_note` and `obsidian_search_replace` accept only explicit
`filePath` and live `activeFile` targets. Resolve a daily, weekly, monthly,
quarterly, or yearly note to its vault-relative path before calling these
tools. The optional upstream Periodic Notes API extension is not a hidden
dependency of this MCP.

## Core Notes

- `obsidian_read_note`: read a vault note by path, with cache fallback.
- `obsidian_list_notes`: list notes and folders, using REST or cache/filesystem.
- `obsidian_global_search`: text/regex search across cached vault content.
- `obsidian_update_note`: live REST note update for an explicit `filePath` or
  the live `activeFile`, or guarded headless append/prepend for an explicit
  `filePath` in filesystem modes.
- `obsidian_search_replace`: live REST search/replace for an explicit
  `filePath` or the live `activeFile`, or guarded exact `filePath`
  search/replace in headless write modes.
- `obsidian_delete_note`: live REST delete; in `headless-filesystem`, explicit
  filesystem delete requires `expectedHash` or `expectedMtime`.

## Governed Atomic Note Replacement

Available only in `live` or `hybrid` with the Local REST API and bundled Atomic
Write Bridge available. The Bridge write gate is disabled by default, and the
current MCP write policy is revalidated before planning and before each effect.

- `obsidian_note_replace_plan`: read one existing `.md` note, validate the
  complete next Markdown and protected frontmatter, then persist an opaque
  sealed plan with before/after proofs. It does not write the note.
- `obsidian_note_replace_apply`: apply only that `planRef` with its matching
  `idempotencyKey`; target, content, and hashes cannot be replaced by the
  caller.
- `obsidian_note_replace_status`: read and reconcile durable plan authority
  without executing a new mutation. Use it first after a timeout or lost
  response.
- `obsidian_note_replace_recover`: reconcile or safely resume the exact same
  uncertain plan. Recovery is not undo and accepts no new mutation payload.

Receipts never expose sealed next content or the physical journal path. Stable
terminal plans cannot be reactivated. The atomic guarantee covers the target
note transition enforced by Obsidian `Vault.process` CAS; it does not reverse
emissions to sync, watchers, third-party plugins, indexers, or external
automations. No generic public `operation_*` surface is introduced.

## Governed Frontmatter Projection (P1)

Available only in `live`, or `hybrid` with a reachable Local REST API and
Atomic Write Bridge. P1 compiles bounded top-level Frontmatter intentions into
complete Markdown and delegates one sealed child plan to the existing P0
operation runtime.

- `obsidian_frontmatter_patch_plan`: compile source-preserving `set` and
  `delete` operations, prove the authorized ranges, revalidate source
  SHA-256/backend binding, and persist no effect.
- `obsidian_frontmatter_patch_apply`: apply only the exact sealed child plan
  with the matching public idempotency key.
- `obsidian_frontmatter_patch_status`: read/reconcile the projected P0 receipt
  without obtaining executor authority.
- `obsidian_frontmatter_patch_recover`: recover the exact child plan; recovery
  is not undo and accepts no new patch.

Unsupported or ambiguous YAML fails closed. The Markdown body, line endings,
comments, ordering, quoting, indentation, and all non-target source ranges
remain byte-identical. See [the P1 contract](governed-frontmatter-p1.md).

### Governed Base formula P2

- `bases_formula_patch_plan`: compile bounded named formula set/delete intent
  while sealing exact Base bytes, backend binding and source proof;
- `bases_formula_patch_apply`: execute only that sealed plan through Bases
  Bridge Atomic V1;
- `bases_formula_patch_status`: reconcile the durable receipt without a new
  mutation;
- `bases_formula_patch_recover`: resume only the same sealed uncertain plan.

The legacy `bases_upsert_config` and `bases_create` effects are blocked by
default at Bases Bridge. Their explicit compatibility toggle must remain off
while using P2. See [the P2 contract](governed-base-formula-p2.md).

### Governed Canvas P3

- `obsidian_canvas_patch_plan`: compile bounded node/edge intentions, preserve
  unknown values, validate the final graph, and seal the exact next JSON;
- `obsidian_canvas_patch_apply`: execute only the sealed plan through Atomic
  Write Bridge 0.4.0 Canvas CAS;
- `obsidian_canvas_patch_status`: reconcile the durable receipt without a new
  graph mutation;
- `obsidian_canvas_patch_recover`: resume only the same sealed uncertain plan.

The Canvas write gate is independent and disabled by default. The direct
`obsidian_manage_canvas` helper remains headless-filesystem only and has no
durable recovery. See [the P3 contract](governed-canvas-p3.md).

## Metadata And Tags

- `obsidian_manage_frontmatter`: live frontmatter operations using Local REST
  API 5.x typed JSON values; in headless guarded modes, supports bounded
  filesystem `set`.
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

French reference: [Operon MCP contract (French)](operon-mcp-contract.fr.md).
The authoritative English guarantees and compatibility matrix are in the
[Operon MCP contract](operon-mcp-contract.md).

- `operon_status`: inspect live Bridge compatibility and persisted snapshot state;
- `operon_get_configuration`: read the live task-semantic Operon settings and their signed stale fallback;
  optional `forceRefresh` requests a complete live rebuild.
- `operon_list_tasks`: list tasks from a live-generation-validated snapshot or an
  explicitly stale persisted fallback.
- `operon_get_task`: read one task by durable `operonId`.
- `operon_query_tasks`: filter by task IDs, stable pipeline/status IDs, visible workflow labels, text, source, checkbox, priority,
  tier, paths, tags, parents, dates, canonical/custom fields, or unmanaged file-task
  properties.
- `operon_query_saved_filter`: evaluate one saved filter through the live engine; a cold status snapshot is advisory and the first exact call negotiates only `tasks.filter-query`. Callers must supply the exact ID because the official API does not expose the saved-filter catalog.
- `operon_validate`: live duplicate/source/workflow graph validation, or a limited
  snapshot-only validation with explicit caveats.
- `operon_get_diagnostics`: native Developer API lifecycle, persistence, grant, catalog, capability, and transport diagnostics.
- `operon_find_tasks`: bounded ranked task/project finder with native recent/today/overdue and project-tree semantics.
- `operon_resolve_task`: native resolution of stable IDs, locators, paths, note names, or search selectors without guessing identity.
- `operon_get_relationships`: bounded explicit, derived, and inferred relationship graph for one stable task.
- `operon_build_context`: bounded exact-task, neighborhood, project, planning, or creation context with a strict hydration allowlist.
- `operon_get_timer_state`: read active and transitioning timer state without exposing timer control.
- `operon_adopt_task`: adopt one exact checkbox only when the loaded engine grants the official task-workflow preview/apply pair. Operon 3.5.3 owns the opaque sealed plan and same-plan recovery; no Markdown fallback exists.
- `operon_create_task`: create inline/file tasks through the loaded engine's official Developer API V1 or bounded legacy Public API v1 surface.
- `operon_create_periodic_task`: create one inline task in the configured Daily or Weekly Note through Operon's additive periodic workflow; Operon owns routing, template, container identity and receipt.
- `operon_update_periodic_scheduling`: set or clear one task's scheduled date through Operon's periodic workflow; Operon decides retain, detach or realign without moving source Markdown.
- `operon_update_task`: update one mutation group with expected revision.
- `operon_transition_task`: apply a stable status-ID or exact workflow transition through Operon's guards when the live Developer API advertises the capability; the Bridge bounds uncertain stock-runtime applies and never retries blindly.
- `operon_set_relationships`: replace or clear parent/blocker edges with revision locking, graph validation, and inverse-edge postflight; apply is allowed in `guarded`.
- `operon_update_recurrence`: set or clear official recurrence fields with explicit series scope; apply requires `full`.
- `operon_convert_task`: convert inline/file shape in `MCP_WRITE_MODE=full`.
- `operon_relocate_task`: move an inline task to another Markdown note while preserving `operonId`.
- `operon_list_pending_recoveries`: list durable official recovery references without applying them; fails closed when a path allowlist is configured because no canonical recovery route can be proved.
- `operon_recover_mutation`: recover one exact official mutation plan with public input `{ idempotencyKey, recoveryRef, recovery }`. The nested union is `{ kind: "developer-api" }` or `{ kind: "adopt" | "periodic-create" | "periodic-update", planDigest?: sha256 }`; the flat top-level kind/digest representation is internal migration state, not public input. It requires both mutation opt-ins, full MCP write mode, and an empty path allowlist.

Operon responses always declare `source`, `stale`, `snapshotAt`, `snapshotAgeMs`,
Operon/Bridge versions, capabilities, and limitations.

Mutations require a live Bridge and the loaded engine's official contract.
Operon 3.5.3 plus CLI 1.2.0 is the 3.1.2 released target through Bridge 0.8.2
and remains `compatible-provisional` as certification metadata. Valid mutations
are admitted by the negotiated contract and exact live gates rather than a
product-version allowlist. Additive task-workflow operations may reach the
Bridge when their cached capability is cold so the exact grant can be negotiated
on first use; the Bridge still fails closed if negotiation fails.
The same operation-scoped negotiation applies to saved-filter execution, while
status/index refreshes request no optional grants. Periodic creation creates no
durable idempotency reservation until its exact grant is available.
Task Type and Task Image are scalar, Task Gallery is a lossless ordered array, and
`__taskDataType` is read-only. Optional adoption and Daily/Weekly grants are
negotiated independently from core reads. Operon 3.2.0 uses Developer API V1
typed preview/apply/recovery for the earlier surface; legacy
Kairélys uses Public API v1. Dry-run is the default, idempotency is mandatory,
existing tasks require `expectedRevision`, and there is no direct Markdown
fallback.

The complete 3.2.0 acceptance evidence uses a local build carrying only the
Developer API settings-renderer fix. Frontmatter settlement and multi-window
consent from #135/#137 are already merged; File Task rename safety remains in
[#139](https://github.com/hasanyilmaz/operon/pull/139). Unsupported paths remain
fail-closed; no private or Markdown fallback is introduced.

## Semantic Search

- `smart_semantic_search`: **canonical** semantic search over Smart Connections
  embeddings and the only semantic-search tool registered in 3.0.

The former `smart_search` and `smart-search` aliases were physically removed in
3.0. Existing clients must migrate to `smart_semantic_search`.

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
- `obsidian_canvas_patch_*`: governed live/hybrid lifecycle for one existing
  Canvas graph; not available as a headless writer fallback.

## Runtime

- `obsidian_runtime_status`: redacted process, cache, semantic, degraded-mode,
  and write-policy status. It returns modes, booleans, versions, hashes, and
  counts only; never physical paths, URLs, secrets, raw configuration, or
  local content.
- `obsidian_runtime_maintenance`: integrity checks and cache refresh actions;
  its public result uses the same redacted runtime diagnostics.

## External Document Roots

External roots are disabled unless `MCP_EXTERNAL_ROOTS_FILE` points to a valid
machine-local JSON configuration.

- `external_runtime_status`: report enablement, available handoff modes, logical
  root IDs, capabilities, limits, and availability without physical paths.
- `external_roots_list`: list logical root IDs without physical paths.
- `external_list`: bounded root-relative directory listing; links and junctions
  are visible but never followed.
- `external_stat`: bounded metadata and optional SHA-256.
- `external_read`: bounded UTF-8 text read.
- `external_handoff`: prepare one verified snapshot through a delivery mode
  supported by the active transport:
  - `local_path` for a local stdio client sharing the server filesystem;
  - optional `http_ticket` for an authenticated direct HTTP client.
- `external_references_scan`: stdio-only inventory of exact, ambiguous and
  historical ÉLYSIA references to one external file.
- `external_move_plan`: persist a verified diagnostic same-root regular-file
  move plan and future-repair evidence.
- `external_move_status`: return the durable, redacted plan receipt.
- `external_move_apply`: diagnostic-only registration; mutation is disabled on
  every platform until an audited native handle-relative primitive exists.
- `external_move_rollback`: diagnostic-only registration; mutating recovery is
  disabled on every platform under the same boundary.

The reference record assembled by scan and plan contains the logical `rootId`,
root-relative path, source SHA-256, occurrence classification and source note
path. Only `rootId` plus relative path are serialized in the stable
`external-ref:` token. Exact repairs are intentionally embedded in
`external_move_plan`; the disabled `external_move_apply` remains only the
future same-plan continuation boundary, and no standalone link-repair apply
surface exists.

A future automatic repair requires one exact Markdown `file:///` link paired
with one adjacent inline `external-ref:` token. YAML frontmatter, fenced code,
historical or example sections, free-form paths and unsupported declarations are
never auto-repaired. Relevant unsupported or ambiguous physical-path occurrences
are returned for manual review and block any future mutation.

The core MCP does not parse PDF or Office files. Handoff requires both
`readable` and `handoff`. HTTP ticket delivery is disabled by default and must be
explicitly enabled with `MCP_HTTP_HANDOFF_ENABLED=true` on a non-development
authenticated profile. The ticket is short-lived, identity-bound, single-use,
bounded across pending and in-flight delivery, absent from URLs, and never
discloses the physical source or temporary path. Issuance requires the
`external:read` scope.

Every external-root tool invoked through direct HTTP requires
`external:read`. Local stdio keeps its process-local trust model. Direct HTTP
explicitly refuses the five reference-integrity operations.

Neither handoff mode authorizes mutation. Scan, plan and status remain
diagnostic; apply, rollback and automatic mutating recovery are disabled on
every platform until an audited native handle-relative primitive exists. The
runtime reason is `native_handle_relative_mutation_unavailable`. Redacted
receipts, private SQLite snapshots, legacy/stale session-binding checks and
exact-CAS evidence remain in the contract. There is no upload, create, replace,
directory/cross-root move, overwrite, delete or sync.
See [External document roots — setup and operations](external-roots-setup.md),
[ADR — External document roots](adr/ADR-External-Document-Roots.md), and
[ADR — Governed HTTP delivery](adr/ADR-HTTP-External-Artifact-Delivery.md). The
move contract is defined in
[ADR — External reference integrity](adr/ADR-External-Reference-Integrity.md).

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
