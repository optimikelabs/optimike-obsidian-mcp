# Tool surface profiles

Optimike Obsidian MCP 3.0 separates two independent contracts:

- the **runtime mode** determines what the installation can execute;
- the **tool surface profile** determines what a connected MCP client can discover and call.

A profile is selected before MCP initialization and before `tools/list`. It is immutable for the lifetime of the session. Visibility is not an authorization boundary: every handler still enforces the existing runtime mode, write policy, bridge grants, scopes, compare-and-swap preconditions, idempotency and recovery rules.

## Profiles

| Profile | Intended use | Contract |
| --- | --- | --- |
| `standard` | General vault work | Read/search, canonical semantic search, direct bounded note edits, governed note and Frontmatter lifecycles, tags, Tasks-compatible inspection and Bases reads. |
| `authoring` | Structured Obsidian authoring | Standard authoring primitives plus governed Base formulas, governed Canvas mutations, bounded Base writes and configured external-document reads. |
| `tasks` | Operon and task operations | Vault context, Tasks-compatible inspection and the complete 23-tool Operon surface, including durable recovery. |
| `full` | Administration, compatibility and diagnosis | Every tool structurally available in the active runtime. It is not the default in 3.0. |

The exact count is runtime-dependent. A live installation can expose more governed Desktop tools than a headless installation; `headless-filesystem` can expose direct filesystem helpers that do not exist in live mode.

## Selection

### Direct stdio

```bash
optimike-obsidian-mcp --tool-profile standard
```

or:

```bash
MCP_TOOL_PROFILE=standard optimike-obsidian-mcp
```

Command-line selection takes precedence over `MCP_TOOL_PROFILE`. Unknown, empty or repeated values fail closed. The 3.0 default is `standard`.

### Stdio proxy

```bash
optimike-obsidian-mcp-proxy --tool-profile authoring
```

The proxy filters both `tools/list` and `tools/call`. An absent tool cannot be invoked by bypassing discovery, including tools implemented locally by the proxy.

### Streamable HTTP

The HTTP endpoint owns the profile:

```text
/mcp/standard
/mcp/authoring
/mcp/tasks
/mcp/full
```

`/mcp` remains a compatibility alias of `/mcp/full` in 3.0. New integrations should use an explicit profile path.

The server binds each session to the canonical profile selected at initialization. Reusing a session ID on another profile path returns the same opaque not-found response as an invalid or expired session. `POST`, `GET` and `DELETE` requests all enforce the binding.

## Server-owned, client-assisted

The server profile is the portable contract and works with any conforming MCP client. A client may reduce or defer the surface further:

- Codex: `enabled_tools` / `disabled_tools`;
- Gemini CLI: `includeTools` / `excludeTools`;
- Claude Code: Tool Search and deferred schema loading;
- Hermes Agent: include/exclude filters, including globs;
- OpenClaw: `toolFilter.include` / `toolFilter.exclude`.

These client features are optional optimizations. They never become the authority for Optimike's tool contract or security policy.

## Canonical semantic search

Optimike MCP 3.0 exposes one public semantic-search name:

```text
smart_semantic_search
```

The former aliases `smart_search` and `smart-search` were removed in 3.0. They called the same implementation and increased ambiguity and schema cost. Update any client allowlist, prompt, script or stored workflow to use `smart_semantic_search`.

Semantic search remains annotated as read-only and open-world because a configured query embedder may call Ollama or an external OpenAI-compatible provider. The indexed vault data remains governed by the local Smart Connections index and runtime configuration.

## Atomic families

A governed family is exposed as one indivisible bundle:

```text
plan → apply → status → recover
```

This invariant covers governed note replacement, Frontmatter projection, Base formulas and Canvas graph mutations. The external-move transaction and Operon recovery pair are also bundled.

A session belongs to a profile; a durable plan does not. A plan created in one session can be inspected or recovered after reconnecting from any profile that exposes the same family, including `full`, subject to the original journal, backend binding, idempotency key, write policy and recovery authority.

Profiles never alter:

- sealed plan content;
- durable journal records;
- idempotency;
- compare-and-swap proofs;
- recovery eligibility;
- runtime authorization.

## Direct fallbacks

Direct and governed tools are not interchangeable. The compiler only enables an explicit direct fallback when the governed family is structurally absent from the runtime:

- `obsidian_manage_frontmatter` may back authoring/standard Frontmatter work when the governed live projection is unavailable;
- `obsidian_manage_canvas` may back authoring in `headless-filesystem` when governed live Canvas CAS is unavailable.

`bases_upsert_config` is a full-profile compatibility path, not a fallback for governed formula editing.

## Static and transient availability

Profile compilation may use static facts known before initialization, such as runtime mode and whether an External Roots configuration exists. It does not change the surface because Obsidian, Operon or a Bridge becomes temporarily unavailable.

Transient failures are returned by the stable tool with explicit diagnostics. The server does not silently change `tools/list` during a session.

## Runtime diagnostics

`obsidian_runtime_status` includes:

```json
{
  "toolSurface": {
    "profile": "standard",
    "profileVersion": "3.0",
    "toolCount": 22,
    "fingerprint": "sha256...",
    "legacyAliasesExposed": false
  }
}
```

The fingerprint is calculated from the profile contract version and sorted exposed names. It is an observability and conformance signal, not an authorization token.

## Migration from 2.x

1. Replace `smart_search` or `smart-search` with `smart_semantic_search`.
2. Choose the narrowest profile that contains the required domain.
3. For HTTP, replace `/mcp` with an explicit `/mcp/{profile}` path when possible.
4. Keep runtime and write-policy configuration unchanged; profiles do not grant writes.
5. Reconnect after changing a profile. Existing sessions cannot switch surfaces.
6. After a lost mutation response, reconnect to the same family and call `status` before `recover`; never create a blind replacement plan.

## Compatibility boundary

3.0 is a deliberate major release:

- the default public surface is `standard` rather than full;
- two semantic-search aliases are removed;
- public package entrypoints enforce profiles;
- HTTP sessions are profile-bound;
- uncatalogued tools fail registration.

The underlying runtime modes, operation journals, bridges, write gates and governed mutation semantics remain compatible with the released 2.9 contracts.
