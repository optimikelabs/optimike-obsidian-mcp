# Tool Surface Profiles

French version: [tool-surface-profiles.fr.md](tool-surface-profiles.fr.md)

Optimike Obsidian MCP separates two contracts that solve different problems:

- the **runtime mode** controls what the backend can safely provide (`live`, `hybrid`, `headless-readonly`, `headless-guarded`, `headless-filesystem`);
- the **tool profile** controls what a connected MCP client sees before `tools/list`.

Tool profiles reduce model-facing ambiguity and schema volume. They are not an
authorization boundary. Runtime, write-mode, bridge, scope, confirmation and CAS
checks remain authoritative even when a tool is visible.

## Public profiles

| Profile | Intended use | Full live/hybrid surface |
| --- | --- | ---: |
| `standard` | General vault reading/search plus common note/frontmatter authoring | 19 tools |
| `authoring` | `standard` plus tags, Bases authoring/formulas and Canvas authoring | 31 tools |
| `tasks` | Markdown Tasks compatibility plus the complete Operon MCP contract | 31 tools |
| `full` | 2.x compatibility/admin surface for the active runtime | 72 tools |

Counts are projections of the current registry and may be lower in a more
restricted runtime. For example, `standard` exposes 9 tools in
`headless-readonly`. `full` means "all tools registered by the active runtime",
not "always 72 tools".

The canonical registry covers 76 unique cross-runtime names because four tools
exist only in `headless-filesystem` and therefore are not part of the 72-tool
live/hybrid surface.

## Semantic search naming

Modern profiles expose one public semantic-search name:

```text
smart_semantic_search
```

The historical aliases `smart_search` and `smart-search` are hidden from
`standard`, `authoring` and `tasks`. They remain visible only in `full` during
the 2.x line for compatibility with existing public clients. Physical removal
of the aliases is reserved for 3.0 unless a breaking minor is explicitly chosen
later.

Agent routing and new integrations must use `smart_semantic_search` only.

## Governed families

A governed family is exposed atomically. If a profile exposes one of these
families, all four lifecycle tools remain present together:

```text
plan → apply → status → recover
```

This applies to governed note replacement, Frontmatter projection, Base formula
patching and Canvas graph patching.

A profile never changes the sealed plan content, journal, idempotency key,
backend binding or recovery authority. A durable plan created in one session may
be inspected/recovered from another session or profile that exposes the same
family, subject to the normal runtime and write/security policies.

## Canonical versus direct fallback

Modern profiles may hide a direct compatibility tool when the corresponding
governed family is actually registered. They keep the direct tool when the
runtime has no governed equivalent.

Current example:

- `live` / live-capable `hybrid`: expose the complete
  `obsidian_frontmatter_patch_*` family and hide `obsidian_manage_frontmatter`;
- `headless-guarded` / `headless-filesystem`: the governed Frontmatter family is
  unavailable, so `obsidian_manage_frontmatter` remains the bounded fallback.

`full` never applies this canonical-preference suppression.

## Stdio selection

The historical behavior stays `full` when no profile is specified.

Use either:

```bash
node dist/stdio-proxy.js --tool-profile standard
```

or:

```bash
MCP_TOOL_PROFILE=standard node dist/stdio-proxy.js
```

`--tool-profile` takes precedence over `MCP_TOOL_PROFILE`. Unknown or repeated
CLI profile values fail closed instead of falling back to `full`.

The stdio proxy applies the profile **per client**. If it needs to start the
shared HTTP backend, that backend is explicitly started as `full`; the proxy
then filters its own client surface. This allows, for example, a `standard`
agent and a `tasks` agent to share one backend without changing each other's
tool list.

Hidden proxy tools are also rejected when called directly; filtering is not
only cosmetic `tools/list` rewriting.

## HTTP selection

The HTTP server exposes explicit immutable profile routes:

```text
/mcp              → full (2.x compatibility alias)
/mcp/standard     → standard
/mcp/authoring    → authoring
/mcp/tasks        → tasks
/mcp/full         → full
```

A session is bound to both its verified identity and its tool profile. A
`sessionId` created on `/mcp/standard` cannot be reused on `/mcp/full`, including
for POST, GET or DELETE session traffic. Profile mismatch fails closed with the
same generic invalid/expired-session posture as an identity mismatch.

The profile is request-scoped while the per-session `McpServer` instance is
created. It is never written to process-global state, so several profiles can
coexist concurrently on one HTTP backend.

## Client-assisted filtering

Server profiles are the portable contract. A client may reduce that surface
again using its own feature, but the client never becomes the source of truth.

Examples of optional client-side mechanisms:

- Codex: `enabled_tools` / `disabled_tools`;
- Gemini CLI: `includeTools` / `excludeTools`;
- Claude Code: tool search / deferred MCP tool loading;
- Hermes Agent: include/exclude filters;
- OpenClaw: `toolFilter.include` / `toolFilter.exclude`.

These mechanisms differ between harnesses and can change independently. Prefer
selecting the appropriate Optimike server profile first, then use client-side
filtering only when it provides an additional local benefit.

## Client examples

### Codex — stdio

```toml
[mcp_servers.optimike]
command = "node"
args = [
  "/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js",
  "--tool-profile",
  "standard"
]

[mcp_servers.optimike.env]
OBSIDIAN_VAULT = "/path/to/vault"
OBSIDIAN_RUNTIME_MODE = "live"
OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"
OBSIDIAN_API_KEY = "<local-rest-api-key>"
```

Codex `enabled_tools` can optionally narrow the already-selected server profile
further.

### Gemini CLI — stdio

```json
{
  "mcpServers": {
    "optimike": {
      "command": "node",
      "args": [
        "/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js",
        "--tool-profile",
        "standard"
      ],
      "env": {
        "OBSIDIAN_VAULT": "/path/to/vault",
        "OBSIDIAN_RUNTIME_MODE": "live"
      }
    }
  }
}
```

Gemini `includeTools` / `excludeTools` remain optional client-side reductions.

### Claude Code — stdio

```bash
claude mcp add optimike -- node \
  /path/to/optimike-obsidian-mcp/dist/stdio-proxy.js \
  --tool-profile standard
```

Claude Code may additionally defer large MCP tool surfaces through its tool
search behavior. The server profile is still useful because it defines the
canonical public surface before any client-specific loading strategy.

### Generic HTTP client

Use the profile in the MCP URL itself:

```text
http://127.0.0.1:3010/mcp/standard
```

No proprietary request header is required.

## Compatibility rule for 2.x

During the 2.x line:

- no profile specified → `full`;
- legacy `/mcp` → `/mcp/full` behavior;
- semantic-search aliases remain available in `full` only;
- modern profiles are opt-in and may be recommended for new installations;
- visibility never weakens existing runtime/write/security checks.

A future major release may make `standard` the default and remove deprecated
alias names after an explicit migration window.
