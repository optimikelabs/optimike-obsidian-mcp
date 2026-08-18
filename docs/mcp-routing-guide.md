# MCP routing guide

French version: [mcp-routing-guide.fr.md](mcp-routing-guide.fr.md)

Related: [Tool surface profiles](tool-surface-profiles.md), [Runtime Capability Matrix](runtime-capability-matrix.md), [Operations](../OPERATIONS.md), [External Roots](external-roots-setup.md).

Optimike MCP exposes the profile-aware routing guide as the MCP resource:

```text
optimike://guides/tool-routing
```

The resource is rendered for the active profile and only refers to tools visible in that session.

## Select the surface first

Choose the narrowest profile that covers the mission:

| Mission | Profile |
| --- | --- |
| General vault reading, search and routine note work | `standard` |
| Note, Frontmatter, Base and Canvas authoring | `authoring` |
| Operon and task operations | `tasks` |
| Compatibility, administration and broad diagnosis | `full` |

A profile controls discovery and invocation. Runtime mode and write policy still control what effects are possible.

## Default decision

| Need | Use | Why |
| --- | --- | --- |
| Read, list or exact-text search | Core Obsidian read/search tools | Stable across live, hybrid and headless modes. |
| Semantic similarity | `smart_semantic_search` | The only public semantic-search name in 3.0. |
| Operon-managed task work | Operon tools in the `tasks` profile | Native task identities, revisions, workflows and recovery. |
| Tasks-compatible Markdown inspection | `list_all_tasks` / `query_tasks` | Legacy/plain Markdown task parsing without claiming Operon ownership. |
| Complete replacement of an existing note | `obsidian_note_replace_plan` lifecycle | Sealed content, CAS, durable receipt and exact-plan recovery. |
| Top-level Frontmatter set/delete | `obsidian_frontmatter_patch_plan` lifecycle | Source-preserving projection and durable recovery. |
| Named Base formula set/delete | `bases_formula_patch_plan` lifecycle | Typed formula intent over Base CAS. |
| Existing Canvas graph mutation | `obsidian_canvas_patch_plan` lifecycle | Graph validation, unknown-value preservation and Canvas CAS. |
| Configured external document read/handoff | External Roots read tools | Default-deny logical roots and path redaction. |
| Move one configured external file with exact ÉLYSIA link repair | Local stdio External Move transaction | Inventory, sealed plan, conditional repairs and rollback. |
| Full Obsidian UI/plugin semantics | `live` or `hybrid` with Desktop open | Headless modes do not load community plugins or UI state. |
| Backend/CI validation | `headless-readonly` first | No write surface. |
| Bounded filesystem work on a copied/dedicated vault | `headless-guarded` or `headless-filesystem` | Explicit opt-in, path checks and preconditions. |

## Canonical semantic search

Use:

```text
smart_semantic_search
```

Optimike MCP 3.0 removed `smart_search` and `smart-search`. They were aliases of the same implementation and must not appear in new prompts, allowlists or workflows.

## Direct versus governed tools

Direct and governed tools own different guarantees.

| Intent | Preferred | Direct/compatibility boundary |
| --- | --- | --- |
| Complete note replacement | `obsidian_note_replace_plan → apply/status/recover` | `obsidian_update_note` is for intentional direct append/prepend/create contracts. |
| High-assurance replacement derived from search/replace | Complete content through note replacement lifecycle | `obsidian_search_replace` has no durable recovery. |
| Frontmatter set/delete | `obsidian_frontmatter_patch_plan → ...` | `obsidian_manage_frontmatter` is a bounded fallback when the governed family is structurally absent. |
| Base formula mutation | `bases_formula_patch_plan → ...` | `bases_upsert_config` is full-profile whole-config compatibility, not a formula fallback. |
| Existing Canvas graph mutation | `obsidian_canvas_patch_plan → ...` | `obsidian_manage_canvas` is a headless-filesystem fallback without durable receipts. |

Do not choose a direct tool merely because it has fewer steps. Choose it only when its narrower guarantee matches the intent.

## Governed sequence

1. Call the domain `*_plan` once with a caller-owned idempotency key.
2. Inspect the receipt and retain the opaque plan reference.
3. Call the matching `*_apply` with the same key.
4. After timeout or transport loss, call `*_status` first.
5. Call `*_recover` only when the receipt authorizes recovery of that exact plan.

Never issue a new mutation merely because the apply response was lost.

Every governed family is exposed atomically. If `plan` or `apply` is visible, `status` and `recover` are visible too.

## Recovery across sessions

A session is bound to one tool profile. A durable plan is not bound to that profile.

After reconnecting, use any profile exposing the same complete family, or `full`, to inspect/recover the plan. The original journal, backend binding, idempotency key and write policy remain authoritative.

## Runtime projection

Profiles are compiled over the tools structurally registered by the runtime.

- `live`: Desktop and Local REST API-backed tools; governed bridges when available.
- `hybrid`: resilient reads and live tools while the API is configured/reachable.
- `headless-readonly`: cache/filesystem reads and validation only.
- `headless-guarded`: cautious direct note/frontmatter writes.
- `headless-filesystem`: explicit filesystem administration and direct Canvas/Base helpers.

Transient backend health does not change the session surface. A temporarily unavailable tool returns an explicit diagnostic.

## External documents

A physical path mentioned in a note is not an authorization grant.

1. Inspect `external_runtime_status` or `external_roots_list`.
2. Use logical `rootId` plus root-relative paths.
3. Use `external_read` only for bounded UTF-8 text.
4. Use `external_handoff` for binary documents; the caller owns extraction.
5. Preserve logical provenance and SHA-256, never temporary delivery paths.

External Move remains local-stdio only and requires its complete five-tool bundle. Stop whenever `manualReview` is non-empty.

## Headless limitations

Headless validation does not render Obsidian, load plugins, evaluate exact Bases UI formulas/views, use the active file, execute command-palette actions or judge Canvas layout quality.

Start with `headless-readonly`; enable filesystem writes only on a copied or dedicated vault with explicit rollback procedures.
