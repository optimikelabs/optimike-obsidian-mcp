# Tool Surface Profiles

French version: [tool-surface-profiles.fr.md](tool-surface-profiles.fr.md)

Optimike Obsidian MCP separates two independent contracts:

- the **runtime mode** controls what the backend can safely provide (`live`, `hybrid`, `headless-readonly`, `headless-guarded`, `headless-filesystem`);
- the **tool profile** controls what one MCP client can discover and call before `tools/list`.

Profiles reduce schema volume and routing ambiguity. They are not an authorization boundary: runtime mode, write policy, bridge grants, scopes, confirmations, CAS, idempotency and recovery rules remain authoritative.

## Public profiles

| Profile     | Intended use                                                                | Full live/hybrid surface |
| ----------- | --------------------------------------------------------------------------- | -----------------------: |
| `standard`  | General vault reading/search and common governed note/Frontmatter work      |                 22 tools |
| `authoring` | `standard` plus tags, bounded Bases authoring/formulas and Canvas authoring |                 33 tools |
| `tasks`     | Markdown Tasks compatibility plus the complete live Operon MCP contract     |                 34 tools |
| `full`      | Explicit complete/admin surface for the active runtime                      |                 77 tools |

Counts are projections of the current registry and may be lower in restricted runtimes. `full` means all tools structurally registered by the active runtime, not always 77 tools. The canonical registry covers 81 unique names across all runtimes because four names exist only in `headless-filesystem`. The operation cockpit is live-only because it reads the process-owned governed journals; visibility never substitutes for a write grant.

The [P6 routing evaluation](tool-routing-evaluation-p6.md) measures these
surfaces from actual `tools/list` schemas and a versioned 31-case baseline. Its
3.8 decision keeps all four profiles unchanged: the 60-tool live union of
authoring and tasks is not promoted without a measured cross-domain journey.

## Compatibility-only names

Modern profiles intentionally exclude compatibility choices that would add ambiguity without adding a distinct normal-use capability.

Semantic search uses one canonical name:

```text
smart_semantic_search
```

The historical `smart_search` and `smart-search` aliases were physically removed in 3.0. Existing clients must call `smart_semantic_search`.

`bases_upsert_config` remains `full`-only. It replaces a whole Base configuration and is not a fallback for governed formula editing. `authoring` keeps `bases_create`, `bases_upsert_rows` and the complete governed `bases_formula_patch_*` family.

## Governed families

A governed family is exposed atomically:

```text
plan → apply → status → recover
```

This applies to governed Note replacement, Markdown body text patching,
Frontmatter projection, Base formula patching and Canvas graph patching.

Registration is incremental inside the server factory. Until all four members of a governed family have registered, the whole governed family remains hidden and any legitimate direct fallback stays visible. When the fourth member arrives, the quartet becomes visible in one reconciliation and the superseded direct fallback is hidden. Static profile compilation remains strict and rejects an actually incomplete family.

A profile never changes sealed plan content, journals, idempotency, backend binding or recovery authority. A durable plan created in one session can be inspected or recovered from another session or profile exposing the same complete family, subject to the normal runtime and write/security policies.

## Canonical versus direct fallback

Modern profiles hide a direct tool only when the corresponding governed family is structurally complete in the current runtime.

- `live` / live-capable `hybrid`: expose `obsidian_frontmatter_patch_{plan,apply,status,recover}` and hide `obsidian_manage_frontmatter`;
- `live` / live-capable `hybrid`: expose `obsidian_text_patch_{plan,apply,status,recover}` and hide direct `obsidian_update_note` / `obsidian_search_replace` only after the quartet is complete;
- `headless-guarded` / `headless-filesystem`: the governed Frontmatter family is absent, so `obsidian_manage_frontmatter` remains the bounded fallback;
- `headless-filesystem` Canvas direct helpers remain available only where the governed live Canvas family is structurally absent;
- `bases_upsert_config` is never a formula fallback and remains `full`-only.

`full` never applies canonical-preference suppression.

## Stdio selection

The 3.0 default is `standard` when no profile is specified.

Profile selection is fixed for the lifetime of one stdio proxy. Starting
Obsidian after Codex does not add tools that the selected profile excludes.
Therefore, the absence of `operon_*` from a `standard` session means “not
exposed by this profile”, not “the Operon plugin is not loaded”. Use `tasks` for
task-focused sessions: its Operon tools remain discoverable while Desktop or
the Bridge is temporarily unavailable and return a structured unavailable or
stale status until `operon_status` can refresh the live contract.

```bash
node dist/stdio-proxy.js --tool-profile standard
```

or:

```bash
MCP_TOOL_PROFILE=standard node dist/stdio-proxy.js
```

`--tool-profile` takes precedence over `MCP_TOOL_PROFILE`. Unknown, empty or repeated CLI values fail closed rather than falling back to `standard`.

The stdio proxy applies the profile per client. When it starts the shared HTTP backend, it explicitly starts that backend as `full`, then filters both `tools/list` and `tools/call` for its client. A hidden local proxy tool is therefore also uncallable by name.

## HTTP selection

The server exposes immutable profile routes:

```text
/mcp              → standard (3.0 default)
/mcp/standard     → standard
/mcp/authoring    → authoring
/mcp/tasks        → tasks
/mcp/full         → full
```

A session is bound to both verified identity and tool profile. A `sessionId` created on `/mcp/standard` cannot be reused on `/mcp/full`, including POST, GET or DELETE session traffic. Profile mismatch uses the same generic invalid/expired-session posture as an identity mismatch.

The profile context is request-scoped only while that session's `McpServer` instance is created; several profiles can coexist on one shared backend without process-global profile mutation.

## Server-owned, client-assisted

The server profile is the portable contract. A client can reduce or defer that surface further, but never becomes Optimike's source of truth.

Optional client mechanisms include:

- Codex: `enabled_tools` / `disabled_tools`;
- Gemini CLI: `includeTools` / `excludeTools`;
- Claude Code: tool search / deferred MCP loading;
- Hermes Agent: include/exclude filters;
- OpenClaw: `toolFilter.include` / `toolFilter.exclude`.

These client features can evolve independently. Select an Optimike profile first; use client filtering only as an additional optimization.

## Migrating from 2.10

3.0 makes two intentional breaking changes:

- unspecified stdio profile and unqualified `/mcp` now select `standard`;
- `smart_search` and `smart-search` no longer exist; call `smart_semantic_search`.

Clients that genuinely need administration, external roots or specialized compatibility tools must opt in with `MCP_TOOL_PROFILE=full`, `--tool-profile full`, or `/mcp/full`. Profile selection still changes discovery, not authorization.
